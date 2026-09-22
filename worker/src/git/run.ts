/**
 * Thin wrapper around child_process.spawn that ALWAYS uses an argument array,
 * never a shell string. (Plan §6.3, §11.4)
 *
 * This is the only place the worker executes external binaries (git, rg, find).
 * shell:false is enforced. Git tokens must never be concatenated into a URL
 * that could be logged.
 */

import { spawn, type SpawnOptions } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'

export interface RunResult {
  stdout: string
  stderr: string
  code: number
  /** 实际观察到的字节数；即使正文因 maxBuffer 截断也保持真实计数。 */
  stdoutBytes: number
  stderrBytes: number
  stdoutTruncated: boolean
  stderrTruncated: boolean
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
    // Chunk boundaries fall on arbitrary bytes. Decoding each Buffer on its own
    // would turn a multi-byte UTF-8 sequence split across two chunks into U+FFFD,
    // which silently corrupts non-ASCII file paths and commit messages.
    const outDecoder = new StringDecoder('utf8')
    const errDecoder = new StringDecoder('utf8')

    const timer = setTimeout(() => {
      killed = true
      child.kill('SIGKILL')
    }, timeoutMs)

    child.stdout?.on('data', (d: Buffer) => {
      outLen += d.length
      const text = outDecoder.write(d)
      if (outLen <= maxBuffer) stdout += text
    })
    child.stderr?.on('data', (d: Buffer) => {
      errLen += d.length
      const text = errDecoder.write(d)
      if (errLen <= maxBuffer) stderr += text
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(new SpawnError(err.message, -1, stderr))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (outLen <= maxBuffer) stdout += outDecoder.end()
      if (errLen <= maxBuffer) stderr += errDecoder.end()
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
      resolve({
        stdout,
        stderr,
        code: code ?? 0,
        stdoutBytes: outLen,
        stderrBytes: errLen,
        stdoutTruncated: outLen > Buffer.byteLength(stdout),
        stderrTruncated: errLen > Buffer.byteLength(stderr),
      })
    })
  })
}
