/**
 * Supervise one `dsh` ACP child process for one review attempt.
 *
 * Isolation rules enforced here:
 *  - the child gets a minimal environment, never the worker's own (no Supabase
 *    service role, no GitLab token, no snapshot root),
 *  - the model API key is passed only through this child's environment, so it
 *    exists in no file and no command line,
 *  - stdout is the ACP stream and is never logged; stderr is captured with a
 *    bounded buffer for diagnostics,
 *  - termination escalates EOF -> SIGTERM -> SIGKILL so a hung attempt cannot
 *    outlive its lease.
 */

import { spawn, type ChildProcessByStdio } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Readable, Writable } from 'node:stream'

export interface AcpProcessOptions {
  dshHome: string
  profileName: string
  patchPath: string
  /** Further overlays applied after `patchPath`, in order. */
  additionalPatchPaths?: string[]
  /** Working directory presented to the agent. */
  cwd: string
  /** Environment variable name/value pair holding the model key. */
  apiKeyEnvVar: string
  apiKey: string
  /** Extra non-secret environment entries. */
  extraEnv?: Record<string, string>
  /** Milliseconds to wait after SIGTERM before SIGKILL. */
  killGraceMs?: number
  /** Maximum captured stderr bytes. */
  stderrLimitBytes?: number
}

export interface AcpProcessHandle {
  readonly pid: number | undefined
  readonly stdin: Writable
  readonly stdout: Readable
  /** Captured stderr, truncated to the configured limit. */
  stderr(): string
  /** Resolves with the exit status once the process is gone. */
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
  /** EOF -> SIGTERM -> SIGKILL. Safe to call more than once. */
  terminate(): Promise<{ code: number | null; signal: NodeJS.Signals | null }>
}

export interface DshLauncher {
  command: string
  args: string[]
}

/**
 * Locate the installed `dsh` launcher.
 *
 * The published bin is a Node script whose shebang resolves `node` through
 * PATH. The child deliberately gets a minimal PATH, so the launcher is invoked
 * with this process's own Node binary instead of relying on the shebang.
 */
export function resolveDshLauncher(): DshLauncher {
  const override = process.env.DSH_BINARY_PATH
  if (override) {
    if (!existsSync(override)) {
      throw new Error(`DSH_BINARY_PATH does not exist: ${override}`)
    }
    return override.endsWith('.js') || override.endsWith('.mjs')
      ? { command: process.execPath, args: [override] }
      : { command: override, args: [] }
  }
  let current = dirname(fileURLToPath(import.meta.url))
  for (let depth = 0; depth < 8; depth++) {
    const script = join(current, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
    if (existsSync(script)) {
      return { command: process.execPath, args: [script] }
    }
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  throw new Error('unable to locate the dsh launcher; set DSH_BINARY_PATH')
}

/**
 * Build the child environment from scratch. Only what the Harness genuinely
 * needs is forwarded; everything else in the worker's environment stays out.
 */
export function buildChildEnv(options: AcpProcessOptions): Record<string, string> {
  const env: Record<string, string> = {
    // The Node binary's own directory is required because the Harness may
    // re-spawn Node for its own helpers.
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
    HOME: options.dshHome,
    DSH_HOME: options.dshHome,
    // Keep the Harness from discovering an ambient DeepSeek credential.
    DSH_DISABLE_TELEMETRY: '1',
    NODE_ENV: 'production',
    [options.apiKeyEnvVar]: options.apiKey,
    ...(options.extraEnv ?? {}),
  }
  if (process.env.TZ) env.TZ = process.env.TZ
  if (process.env.NODE_OPTIONS === undefined) delete env.NODE_OPTIONS
  return env
}

export function startAcpProcess(options: AcpProcessOptions): AcpProcessHandle {
  const launcher = resolveDshLauncher()
  const args = [
    ...launcher.args,
    '--profile',
    options.profileName,
    '--patch',
    options.patchPath,
    ...(options.additionalPatchPaths ?? []).flatMap((path) => ['--patch', path]),
  ]

  const child: ChildProcessByStdio<Writable, Readable, Readable> = spawn(launcher.command, args, {
    cwd: options.cwd,
    env: buildChildEnv(options),
    stdio: ['pipe', 'pipe', 'pipe'],
    // Own process group so termination reaches the whole tree.
    detached: false,
  }) as ChildProcessByStdio<Writable, Readable, Readable>

  const limit = options.stderrLimitBytes ?? 64 * 1024
  let stderrBuffer = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => {
    if (stderrBuffer.length >= limit) return
    stderrBuffer += chunk
    if (stderrBuffer.length > limit) {
      stderrBuffer = `${stderrBuffer.slice(0, limit)}…[truncated]`
    }
  })

  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolveExit) => {
      child.once('exit', (code, signal) => resolveExit({ code, signal }))
    },
  )

  let terminating: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | null = null

  const terminate = (): Promise<{ code: number | null; signal: NodeJS.Signals | null }> => {
    if (terminating) return terminating
    terminating = (async () => {
      if (child.exitCode !== null || child.signalCode !== null) {
        return exited
      }
      // 1. Closing stdin is the protocol-level shutdown.
      try {
        child.stdin.end()
      } catch {
        // Already closed.
      }
      const grace = options.killGraceMs ?? 5000
      const settled = await Promise.race([
        exited,
        sleep(grace).then(() => null),
      ])
      if (settled) return settled

      // 2. Ask politely.
      try {
        child.kill('SIGTERM')
      } catch {
        // Already gone.
      }
      const afterTerm = await Promise.race([exited, sleep(grace).then(() => null)])
      if (afterTerm) return afterTerm

      // 3. Non-negotiable.
      try {
        child.kill('SIGKILL')
      } catch {
        // Already gone.
      }
      return exited
    })()
    return terminating
  }

  return {
    pid: child.pid,
    stdin: child.stdin,
    stdout: child.stdout,
    stderr: () => stderrBuffer,
    exited,
    terminate,
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
