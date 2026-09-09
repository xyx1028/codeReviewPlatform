import { describe, it, expect } from 'vitest'
import {
  computeLeaseExpiry,
  isClaimable,
  holdsValidLease,
  shouldAcceptWrite,
  renewLease,
  TaskLeaseLostError,
} from '../coordination/lease.js'
import { effectiveConcurrency, SlotPool } from '../coordination/concurrency.js'

const NOW = 1_000_000

describe('lease semantics', () => {
  it('computes future expiry', () => {
    expect(computeLeaseExpiry(NOW, 900)).toBe(NOW + 900_000)
    expect(() => computeLeaseExpiry(NOW, 0)).toThrow()
  })

  it('claimable when unheld or expired', () => {
    expect(isClaimable({ workerId: null, leaseExpiresAt: null }, NOW)).toBe(true)
    expect(isClaimable({ workerId: 'w1', leaseExpiresAt: NOW - 1 }, NOW)).toBe(true)
    expect(isClaimable({ workerId: 'w1', leaseExpiresAt: NOW + 1000 }, NOW)).toBe(false)
  })

  it('only the holder with an unexpired lease is valid', () => {
    expect(holdsValidLease({ workerId: 'w1', leaseExpiresAt: NOW + 1000 }, 'w1', NOW)).toBe(true)
    expect(holdsValidLease({ workerId: 'w1', leaseExpiresAt: NOW - 1 }, 'w1', NOW)).toBe(false)
    expect(holdsValidLease({ workerId: 'w1', leaseExpiresAt: NOW + 1000 }, 'w2', NOW)).toBe(false)
  })

  it('rejects late writes from a worker that lost the lease', () => {
    // Another worker (w2) now holds the lease.
    const takenOver = { workerId: 'w2', leaseExpiresAt: NOW + 1000 }
    expect(shouldAcceptWrite(takenOver, 'w1', NOW)).toBe(false)
    expect(shouldAcceptWrite(takenOver, 'w2', NOW)).toBe(true)
    // Expired self lease is also rejected.
    expect(shouldAcceptWrite({ workerId: 'w1', leaseExpiresAt: NOW - 1 }, 'w1', NOW)).toBe(false)
  })

  it('renews only for the current holder', () => {
    const renewed = renewLease({ workerId: 'w1', leaseExpiresAt: NOW + 10 }, 'w1', NOW, 900)
    expect(renewed.leaseExpiresAt).toBe(NOW + 900_000)
    expect(() => renewLease({ workerId: 'w2', leaseExpiresAt: NOW + 10 }, 'w1', NOW, 900)).toThrow(
      TaskLeaseLostError,
    )
  })
})

describe('effectiveConcurrency', () => {
  it('is the min of model, worker capacity, and pending', () => {
    expect(effectiveConcurrency({ modelMaxParallel: 8, workerCapacity: 8, pendingTasks: 20 })).toBe(8)
    expect(effectiveConcurrency({ modelMaxParallel: 4, workerCapacity: 40, pendingTasks: 20 })).toBe(4)
    expect(effectiveConcurrency({ modelMaxParallel: 8, workerCapacity: 8, pendingTasks: 3 })).toBe(3)
    expect(effectiveConcurrency({ modelMaxParallel: 0, workerCapacity: 8, pendingTasks: 20 })).toBe(0)
  })
})

describe('SlotPool', () => {
  it('limits concurrency to its size', async () => {
    const pool = new SlotPool(2)
    let active = 0
    let maxActive = 0
    const task = async () => {
      active++
      maxActive = Math.max(maxActive, active)
      await new Promise((r) => setTimeout(r, 10))
      active--
    }
    await Promise.all(Array.from({ length: 6 }, () => pool.run(task)))
    expect(maxActive).toBeLessThanOrEqual(2)
    expect(pool.activeCount).toBe(0)
  })

  it('rejects invalid sizes', () => {
    expect(() => new SlotPool(0)).toThrow()
    expect(() => new SlotPool(1.5)).toThrow()
  })
})
