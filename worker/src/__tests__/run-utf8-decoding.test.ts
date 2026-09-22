/**
 * runCommand 的 UTF-8 解码回归。
 *
 * 之前每个 stdout chunk 各自 `Buffer.toString('utf8')`。Pipe 的 chunk 边界落在
 * 任意字节上，跨 chunk 被切断的多字节序列会被解成 U+FFFD —— 中文文件名和中文
 * 提交信息会静默损坏（2026-09-22 排查 COMMIT_MANIFEST_INVALID 时发现）。
 */
import { describe, expect, it } from 'vitest'
import { runCommand } from '../git/run.js'

describe('runCommand UTF-8 decoding', () => {
  it('keeps multi-byte characters intact across stdout chunk boundaries', async () => {
    // 3 字节字符 × 大量重复：必然有字符跨越 64KiB 的 pipe chunk 边界。
    const script = 'process.stdout.write("租".repeat(200000))'
    const result = await runCommand(process.execPath, ['-e', script], { timeoutMs: 30_000 })
    expect(result.stdout).not.toContain('\uFFFD')
    expect(result.stdout.length).toBe(200_000)
    expect(result.stdoutBytes).toBe(600_000)
    expect(result.stdoutTruncated).toBe(false)
    expect(new Set(result.stdout)).toEqual(new Set(['租']))
  })

  it('reports real byte counts when the body is truncated by maxBuffer', async () => {
    const script = 'process.stdout.write("租".repeat(200000))'
    const result = await runCommand(process.execPath, ['-e', script], { timeoutMs: 30_000, maxBuffer: 1024 })
    expect(result.stdoutBytes).toBe(600_000)
    expect(result.stdoutTruncated).toBe(true)
  })
})
