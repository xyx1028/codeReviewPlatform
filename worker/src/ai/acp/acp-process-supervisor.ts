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

import { execFileSync, spawn, type ChildProcessByStdio } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Readable, Writable } from 'node:stream'
import {
  BROKER_TOKEN_ENV,
  ROOT_CAPABILITY_ENV,
} from '../../harness-plugins/shared/credential-env.js'

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
  /**
   * Broker 凭据。
   *
   * 走环境变量而不是 attempt patch 文件：patch 文件与 Sandbox Shell 同属一个 OS 用户，
   * 而 `workspace-write` 沙箱只限制写不限制读，所以任何写进 patch 的令牌都等于交给了
   * 拿到 Shell 的子 Agent。变量名必须命中 Harness 的 `SENSITIVE_ENV_PATTERN`
   * （`/KEY|PASSWORD|SECRET|TOKEN/i`），Harness 才会在 spawn Shell 前把它们剥掉。
   */
  brokerToken: string
  rootCapability: string
  /** Extra non-secret environment entries. */
  extraEnv?: Record<string, string>
  /**
   * 施加在 dsh 进程上的 `ulimit` 语句。
   *
   * rlimit 会被后代继承，所以设在 dsh 上就等于设在它经 Sandbox Shell / Jobs 启动的每一个
   * 构建、测试、静态检查进程上 —— 这是在不接管 Harness spawn 路径的前提下唯一能真正
   * 施加 PID / FD / 文件大小上限的位置。
   */
  ulimits?: readonly string[]
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
  /**
   * 回收全部后代进程，返回仍然存活的 pid。
   *
   * V3 只保证终止直接子进程。V4 的 Agent 会通过 Sandbox Shell 和 Jobs 启动构建、测试、
   * 静态检查，这些进程是孙辈甚至更深，直接子进程退出并不会带走它们 —— 它们会变成孤儿，
   * 继续占 CPU 和磁盘，并且仍然持有 Workspace 的文件句柄导致清理失败。
   *
   * 所以子进程用 `detached: true` 单独成组，回收时对整个进程组发信号。
   */
  reapProcessTree(): Promise<number[]>
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
    ...(options.extraEnv ?? {}),
    // 凭据放在 extraEnv 之后，任何调用方都无法用 extraEnv 覆盖或抢占它们。
    [options.apiKeyEnvVar]: options.apiKey,
    [BROKER_TOKEN_ENV]: options.brokerToken,
    [ROOT_CAPABILITY_ENV]: options.rootCapability,
  }
  if (process.env.TZ) env.TZ = process.env.TZ
  if (process.env.NODE_OPTIONS === undefined) delete env.NODE_OPTIONS
  return env
}

/**
 * 断言每个凭据变量名都会被 Harness 在 spawn 模型可见的 Shell 之前剥掉。
 *
 * `@deepseek-ai/dsh-subprocess` 的 `scrubbedParentEnv()` 按变量名过滤
 * `/KEY|PASSWORD|SECRET|TOKEN/i` 与 `DSH_*`。这是"Shell 读不到凭据"的**唯一**依据，
 * 所以一次重命名就可能静默地把它作废 —— 在启动路径上机械检查，而不是靠记性。
 */
const HARNESS_SENSITIVE_ENV_PATTERN = /KEY|PASSWORD|SECRET|TOKEN/i

export function assertCredentialEnvIsScrubbed(names: readonly string[]): void {
  for (const name of names) {
    if (!HARNESS_SENSITIVE_ENV_PATTERN.test(name) && !name.toUpperCase().startsWith('DSH_')) {
      throw new Error(
        `credential environment variable "${name}" would survive into sandboxed shell children; ` +
          'its name must match the Harness scrub pattern /KEY|PASSWORD|SECRET|TOKEN/i',
      )
    }
  }
}

export function startAcpProcess(options: AcpProcessOptions): AcpProcessHandle {
  assertCredentialEnvIsScrubbed([
    options.apiKeyEnvVar,
    BROKER_TOKEN_ENV,
    ROOT_CAPABILITY_ENV,
  ])
  const launcher = resolveDshLauncher()
  const args = [
    ...launcher.args,
    '--profile',
    options.profileName,
    '--patch',
    options.patchPath,
    ...(options.additionalPatchPaths ?? []).flatMap((path) => ['--patch', path]),
  ]

  // rlimit 靠继承生效，所以只能在**祖先**上设：`sh -c 'ulimit …; exec dsh …'`。用 `exec`
  // 是必须的 —— 它让 dsh 顶替 sh 而不是成为 sh 的子进程，于是 pid 仍然是进程组组长，
  // `reapProcessTree` 的 `kill(-pgid)` 语义不变。
  //
  // 这里只设对长驻父进程安全的四项。`ulimit -t`（CPU 时间）**不能**设在 dsh 上：它会在
  // 累计 CPU 时间到点后直接杀掉整个 Harness，而不是杀掉某一条超时命令；单条命令的时限
  // 由 bash-sandbox 的 commandTimeoutMs 负责。RSS 由容器内存上限负责（见 compose）。
  const ulimits = options.ulimits ?? []
  const spawnFile = ulimits.length > 0 && process.platform !== 'win32' ? '/bin/sh' : launcher.command
  const spawnArgs =
    ulimits.length > 0 && process.platform !== 'win32'
      ? ['-c', `${ulimits.join('; ')}; exec "$0" "$@"`, launcher.command, ...args]
      : args

  const child: ChildProcessByStdio<Writable, Readable, Readable> = spawn(spawnFile, spawnArgs, {
    cwd: options.cwd,
    env: buildChildEnv(options),
    stdio: ['pipe', 'pipe', 'pipe'],
    // 单独一个进程组。这一位是"能否回收整棵进程树"的全部区别所在：detached: false 时
    // kill(pid) 只能命中 dsh 本身，Shell 和 Jobs 起的构建/测试进程会活下来。
    detached: true,
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

  /**
   * 对整个进程组发信号。
   *
   * `kill(-pgid)` 是 POSIX 上唯一能一次命中全部后代的原语。pid 为负数时 Node 会把它
   * 转成进程组信号；组已经空了会抛 ESRCH，那正是我们想要的结果。
   */
  const signalGroup = (signal: NodeJS.Signals): void => {
    if (child.pid === undefined) return
    try {
      process.kill(-child.pid, signal)
    } catch {
      // ESRCH：组里已经没有进程了。
    }
  }

  const reapProcessTree = async (): Promise<number[]> => {
    await terminate().catch(() => undefined)
    // terminate() 只保证 dsh 本身退出。组里可能还留着它的后代。
    signalGroup('SIGTERM')
    let survivors = listProcessGroup(child.pid)
    if (survivors.length > 0) {
      await sleep(options.killGraceMs ?? 5000)
      survivors = listProcessGroup(child.pid)
    }
    if (survivors.length > 0) {
      signalGroup('SIGKILL')
      await sleep(500)
      survivors = listProcessGroup(child.pid)
    }
    return survivors
  }

  return {
    pid: child.pid,
    stdin: child.stdin,
    stdout: child.stdout,
    stderr: () => stderrBuffer,
    exited,
    terminate,
    reapProcessTree,
  }
}

/**
 * 列出一个进程组里仍然**活着**的 pid。
 *
 * 两个细节是在真实 Linux 容器里实测出来的，都不是理论推导：
 *
 * 1. **必须排除僵尸进程。** 组内后代被 SIGKILL 之后会先变成僵尸（state `Z`），要等它们的
 *    父进程 wait 掉才从进程表消失。而它们的父进程恰好已经被同一次组信号杀掉了，于是它们
 *    被重新挂到 PID 1 上；如果 PID 1 是 Worker 自己（容器里的默认情况），libuv 只 wait 自己
 *    spawn 的子进程，这些继承来的孤儿会一直挂着。把僵尸算成"存活"的后果是：每一次用过
 *    Shell 或 Jobs 的 attempt 都会误报 PROCESS_TREE_CLEANUP_FAILED，真正的回收失败反而被
 *    这些噪音盖住。运维上的配套是给容器一个 init 进程来收僵尸（见 docker-compose 的
 *    `init: true`）。
 *
 * 2. **不能用 `ps -g <pgid>` 选进程组。** procps 的 `-g` 选的是 **session**，而这个构建
 *    （procps-ng 4.0.2）根本不支持 `--pgid` 长选项。这里改成读全表的 `pgid` 列自己过滤，
 *    这样"按进程组筛选"这件事是精确的，而不是碰巧因为 setsid 让 sid == pgid 才对。
 *
 * 查询失败时返回空数组而不是抛错 —— 回收路径不能因为一次诊断查询失败而中断，真正的兜底
 * 是上面的 SIGKILL。
 */
export function listProcessGroup(pgid: number | undefined): number[] {
  if (pgid === undefined) return []
  try {
    const out = execFileSync('ps', ['-eo', 'pid=,pgid=,stat='], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const alive: number[] = []
    for (const line of out.split('\n')) {
      const parts = line.trim().split(/\s+/)
      if (parts.length < 3) continue
      const pid = Number(parts[0])
      const group = Number(parts[1])
      const state = parts[2]!
      if (!Number.isInteger(pid) || pid <= 0 || group !== pgid) continue
      if (pid === process.pid) continue
      // `Z` 开头即僵尸：已经死了，只是还没被 wait 掉。
      if (state.startsWith('Z')) continue
      alive.push(pid)
    }
    return alive
  } catch {
    return []
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
