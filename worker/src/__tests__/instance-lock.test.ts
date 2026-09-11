import { describe, expect, it, afterEach } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  acquireInstanceLock,
  isProcessAlive,
  lockFileName,
  WorkerAlreadyRunningError,
} from '../coordination/instance-lock.js'

const roots: string[] = []

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'instance-lock-test-'))
  roots.push(root)
  return root
}

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop()
    if (root) rmSync(root, { recursive: true, force: true })
  }
})

describe('lockFileName', () => {
  it('净化不适合做文件名的字符', () => {
    const name = lockFileName('worker/local:1 slot')
    expect(name.startsWith('worker-worker_local_1_slot-')).toBe(true)
    expect(name.endsWith('.lock')).toBe(true)
    expect(name).not.toContain('/')
    expect(name).not.toContain(':')
  })

  it('净化后同名的不同 worker_id 仍然得到不同文件名', () => {
    // 这是净化方案的必要条件：否则 "a/b" 与 "a:b" 会互相当成同一个副本。
    expect(lockFileName('a/b')).not.toBe(lockFileName('a:b'))
  })

  it('同一个 worker_id 始终得到同一个文件名', () => {
    expect(lockFileName('local-worker-1')).toBe(lockFileName('local-worker-1'))
  })

  it('超长 worker_id 不会产生超长文件名', () => {
    const name = lockFileName('x'.repeat(500))
    expect(name.length).toBeLessThan(100)
  })
})

describe('isProcessAlive', () => {
  it('当前进程存活', () => {
    expect(isProcessAlive(process.pid)).toBe(true)
  })

  it('非法 pid 视为不存活', () => {
    expect(isProcessAlive(0)).toBe(false)
    expect(isProcessAlive(-1)).toBe(false)
    expect(isProcessAlive(1.5)).toBe(false)
  })
})

describe('acquireInstanceLock', () => {
  it('首次获取写入持有者信息', () => {
    const root = makeRoot()
    const lock = acquireInstanceLock({ workerId: 'w1', lockDir: root, pid: 4242 })

    expect(existsSync(lock.path)).toBe(true)
    const payload = JSON.parse(readFileSync(lock.path, 'utf8')) as Record<string, unknown>
    expect(payload.workerId).toBe('w1')
    expect(payload.pid).toBe(4242)
    expect(typeof payload.startedAt).toBe('string')
  })

  it('锁目录不存在时自动创建', () => {
    const root = join(makeRoot(), 'nested', 'jobs')
    const lock = acquireInstanceLock({ workerId: 'w1', lockDir: root, pid: 1 })
    expect(existsSync(lock.path)).toBe(true)
  })

  it('持有者仍存活时拒绝第二个同名实例', () => {
    const root = makeRoot()
    acquireInstanceLock({ workerId: 'w1', lockDir: root, pid: 111, isAlive: () => true })

    let raised: unknown
    try {
      acquireInstanceLock({ workerId: 'w1', lockDir: root, pid: 222, isAlive: () => true })
    } catch (err) {
      raised = err
    }

    expect(raised).toBeInstanceOf(WorkerAlreadyRunningError)
    const error = raised as WorkerAlreadyRunningError
    expect(error.code).toBe('WORKER_ALREADY_RUNNING')
    expect(error.holderPid).toBe(111)
    expect(error.workerId).toBe('w1')
    // 报错必须给出可执行的处置办法，否则运维只能猜。
    expect(error.message).toContain('WORKER_ID')
    expect(error.message).toContain(error.lockPath)
  })

  it('不同 worker_id 可以同时持锁', () => {
    const root = makeRoot()
    const a = acquireInstanceLock({ workerId: 'w1', lockDir: root, pid: 1, isAlive: () => true })
    const b = acquireInstanceLock({ workerId: 'w2', lockDir: root, pid: 2, isAlive: () => true })
    expect(a.path).not.toBe(b.path)
    expect(existsSync(a.path)).toBe(true)
    expect(existsSync(b.path)).toBe(true)
  })

  it('持有者已退出时接管陈旧锁', () => {
    const root = makeRoot()
    acquireInstanceLock({ workerId: 'w1', lockDir: root, pid: 111, isAlive: () => true })

    // 崩溃后重启：旧 pid 已不存在，必须能起来，不能永久卡死。
    const lock = acquireInstanceLock({
      workerId: 'w1',
      lockDir: root,
      pid: 222,
      isAlive: () => false,
    })
    const payload = JSON.parse(readFileSync(lock.path, 'utf8')) as { pid: number }
    expect(payload.pid).toBe(222)
  })

  it('锁文件损坏时视为陈旧并接管', () => {
    const root = makeRoot()
    const lockPath = join(root, lockFileName('w1'))
    writeFileSync(lockPath, 'not json at all')

    const lock = acquireInstanceLock({
      workerId: 'w1',
      lockDir: root,
      pid: 333,
      isAlive: () => true,
    })
    const payload = JSON.parse(readFileSync(lock.path, 'utf8')) as { pid: number }
    expect(payload.pid).toBe(333)
  })

  it('同一 pid 的残留锁可以被自己接管', () => {
    const root = makeRoot()
    acquireInstanceLock({ workerId: 'w1', lockDir: root, pid: 999, isAlive: () => true })
    const again = acquireInstanceLock({
      workerId: 'w1',
      lockDir: root,
      pid: 999,
      isAlive: () => true,
    })
    expect(existsSync(again.path)).toBe(true)
  })

  it('release 删除锁文件并可重复调用', () => {
    const root = makeRoot()
    const lock = acquireInstanceLock({ workerId: 'w1', lockDir: root, pid: 1 })
    lock.release()
    expect(existsSync(lock.path)).toBe(false)
    expect(() => lock.release()).not.toThrow()
  })

  it('release 后可以重新获取', () => {
    const root = makeRoot()
    const first = acquireInstanceLock({ workerId: 'w1', lockDir: root, pid: 1, isAlive: () => true })
    first.release()
    const second = acquireInstanceLock({ workerId: 'w1', lockDir: root, pid: 2, isAlive: () => true })
    expect(existsSync(second.path)).toBe(true)
  })

  it('release 不会删除已被他人接管的锁', () => {
    const root = makeRoot()
    const first = acquireInstanceLock({ workerId: 'w1', lockDir: root, pid: 1, isAlive: () => true })
    // 模拟第一个进程被判定为已退出、锁被第二个进程接管
    const second = acquireInstanceLock({
      workerId: 'w1',
      lockDir: root,
      pid: 2,
      isAlive: () => false,
    })

    first.release()

    expect(existsSync(second.path)).toBe(true)
    const payload = JSON.parse(readFileSync(second.path, 'utf8')) as { pid: number }
    expect(payload.pid).toBe(2)
  })

  it('拒绝空 workerId', () => {
    const root = makeRoot()
    expect(() => acquireInstanceLock({ workerId: '   ', lockDir: root })).toThrow(/workerId/)
  })
})
