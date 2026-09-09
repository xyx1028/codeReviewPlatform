/**
 * Thin wrapper around child_process.spawn that ALWAYS uses an argument array,
 * never a shell string. (Plan §6.3, §11.4)
 *
 * This is the only place the worker executes external binaries (git, rg, find).
 * shell:false is enforced. Git tokens must never be concatenated into a URL
 * that could be logged.
 */

import { spawn, type SpawnOptions } from 'node:child_process'

export interface RunResult {
  stdout: string
  stderr: string
  code: number
}

export class SpawnError extends Error {
  code: number
  stderr: string
  constructor(message: string, code: number, stderr: string) {
    super(message)
    this.name = 'SpawnError'
    this.code = code
    this.stderr = stderr
  }
}

export interface RunOptions {
  cwd?: string
  timeoutMs?: number
  maxBuffer?: number
  env?: NodeJS.ProcessEnv
}

/**
 * Run a command with an explicit argument array. shell is always disabled.
 * Rejects with SpawnError on non-zero exit or timeout.
 */
export function runCommand(
  command: string,
  args: string[],
  options: RunOptions = {},
): Promise<RunResult> {
  const { cwd, timeoutMs = 120000, maxBuffer = 32 * 1024 * 1024, env } = options

  if (typeof command !== 'string' || command.length === 0) {
    return Promise.reject(new SpawnError('empty command', -1, ''))
  }
  if (!Array.isArray(args) || args.some((a) => typeof a !== 'string')) {
    return Promise.reject(new SpawnError('args must be an array of strings', -1, ''))
  }

  const spawnOpts: SpawnOptions = {
    cwd,
    shell: false,
    env: env ?? process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  }

  return new Promise<RunResult>((resolve, reject) => {
    const child = spawn(command, args, spawnOpts)
    let stdout = ''
    let stderr = ''
    let killed = false
    let outLen = 0
    let errLen = 0

    const timer = setTimeout(() => {
      killed = true
      child.kill('SIGKILL')
    }, timeoutMs)

    child.stdout?.on('data', (d: Buffer) => {
      outLen += d.length
      if (outLen <= maxBuffer) stdout += d.toString('utf8')
    })
    child.stderr?.on('data', (d: Buffer) => {
      errLen += d.length
      if (errLen <= maxBuffer) stderr += d.toString('utf8')
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(new SpawnError(err.message, -1, stderr))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (killed) {
        reject(new SpawnError(`command timed out after ${timeoutMs}ms`, -1, stderr))
        return
      }
      if (code !== 0) {
        reject(
          new SpawnError(
            `command exited with code ${code}: ${command}`,
            code ?? -1,
            stderr,
          ),
        )
        return
      }
      resolve({ stdout, stderr, code: code ?? 0 })
    })
  })
}
