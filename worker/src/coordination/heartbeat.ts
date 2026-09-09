/**
 * Heartbeat runner. (Plan §7.6, §13.4)
 *
 * While a story task is being processed, the worker renews the lease on an
 * interval. If a heartbeat is rejected (lease lost), onLeaseLost is invoked so
 * the pipeline can abort before writing stale results.
 */

import { rootLogger, type Logger } from '../logger.js'

export interface HeartbeatOptions {
  taskId: string
  workerId: string
  intervalMs: number
  /** Sends a single heartbeat; resolves true if lease renewed, false if lost. */
  send: (taskId: string, workerId: string) => Promise<boolean>
  onLeaseLost: () => void
  logger?: Logger
  /** Injected for testing. */
  setIntervalImpl?: typeof setInterval
  clearIntervalImpl?: typeof clearInterval
}

export class Heartbeat {
  private handle: ReturnType<typeof setInterval> | null = null
  private opts: HeartbeatOptions
  private logger: Logger
  private setIntervalImpl: typeof setInterval
  private clearIntervalImpl: typeof clearInterval
  private stopped = false

  constructor(opts: HeartbeatOptions) {
    this.opts = opts
    this.logger = opts.logger ?? rootLogger
    this.setIntervalImpl = opts.setIntervalImpl ?? setInterval
    this.clearIntervalImpl = opts.clearIntervalImpl ?? clearInterval
  }

  start(): void {
    if (this.handle) return
    this.stopped = false
    this.handle = this.setIntervalImpl(() => {
      void this.tick()
    }, this.opts.intervalMs)
    // Do not keep the process alive solely for heartbeats.
    if (typeof (this.handle as { unref?: () => void }).unref === 'function') {
      ;(this.handle as { unref: () => void }).unref()
    }
  }

  private async tick(): Promise<void> {
    if (this.stopped) return
    try {
      const ok = await this.opts.send(this.opts.taskId, this.opts.workerId)
      if (!ok) {
        this.logger.warn('heartbeat_lease_lost', {
          event: 'heartbeat_lease_lost',
          job_id: undefined,
        })
        this.stop()
        this.opts.onLeaseLost()
      }
    } catch (err) {
      this.logger.warn('heartbeat_error', { event: 'heartbeat_error', error: String((err as Error)?.message) })
    }
  }

  stop(): void {
    this.stopped = true
    if (this.handle) {
      this.clearIntervalImpl(this.handle)
      this.handle = null
    }
  }
}
