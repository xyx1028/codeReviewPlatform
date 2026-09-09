/**
 * Lease semantics helpers. (Plan §7.6, §13.4)
 *
 * A story task is claimed with a lease (worker_id + lease_expires_at). Workers
 * renew via heartbeat. If a lease expires, another worker may take over and the
 * original worker's late writes must be rejected.
 *
 * These are pure helpers so the rules can be unit-tested without a database.
 */

export interface LeaseState {
  workerId: string | null
  leaseExpiresAt: number | null // epoch ms
}

/** Compute a new lease expiry from now + leaseSeconds. */
export function computeLeaseExpiry(nowMs: number, leaseSeconds: number): number {
  if (!Number.isFinite(leaseSeconds) || leaseSeconds <= 0) {
    throw new Error('leaseSeconds must be positive')
  }
  return nowMs + leaseSeconds * 1000
}

/** True when a task is claimable: no holder, or the lease has expired. */
export function isClaimable(state: LeaseState, nowMs: number): boolean {
  if (!state.workerId) return true
  if (state.leaseExpiresAt === null) return true
  return state.leaseExpiresAt <= nowMs
}

/** True when `workerId` still holds a valid, unexpired lease. */
export function holdsValidLease(
  state: LeaseState,
  workerId: string,
  nowMs: number,
): boolean {
  return (
    state.workerId === workerId &&
    state.leaseExpiresAt !== null &&
    state.leaseExpiresAt > nowMs
  )
}

/**
 * Decide whether a write from `workerId` should be accepted. A write is rejected
 * (TASK_LEASE_LOST) when the worker no longer holds a valid lease — e.g. the
 * lease expired and another worker took over. (Plan §13.4)
 */
export function shouldAcceptWrite(
  state: LeaseState,
  workerId: string,
  nowMs: number,
): boolean {
  return holdsValidLease(state, workerId, nowMs)
}

/**
 * Renew a lease if the worker still holds it. Returns the new state or throws
 * TaskLeaseLostError if the worker lost the lease.
 */
export class TaskLeaseLostError extends Error {
  code = 'TASK_LEASE_LOST'
  constructor(message = 'worker lost story task lease') {
    super(message)
    this.name = 'TaskLeaseLostError'
  }
}

export function renewLease(
  state: LeaseState,
  workerId: string,
  nowMs: number,
  leaseSeconds: number,
): LeaseState {
  if (state.workerId !== workerId) {
    throw new TaskLeaseLostError()
  }
  // Renewal is allowed even slightly past expiry only if not taken by another
  // worker; here the DB row still shows this worker as holder.
  return {
    workerId,
    leaseExpiresAt: computeLeaseExpiry(nowMs, leaseSeconds),
  }
}
