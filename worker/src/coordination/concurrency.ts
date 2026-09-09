/**
 * Concurrency helpers. (Plan §13.1, §9.4)
 *
 * Effective concurrency = min(model max_parallel_tasks, worker capacity,
 * pending tasks). Slots bound how many story tasks a single worker processes
 * simultaneously (WORKER_STORY_CONCURRENCY).
 */

/**
 * Compute the effective number of tasks that may run concurrently right now.
 */
export function effectiveConcurrency(input: {
  modelMaxParallel: number
  workerCapacity: number
  pendingTasks: number
}): number {
  const values = [input.modelMaxParallel, input.workerCapacity, input.pendingTasks]
  const min = Math.min(...values)
  return Math.max(0, min)
}

/**
 * A bounded slot pool that runs async tasks with at most `size` in flight.
 * Used by the worker to process up to WORKER_STORY_CONCURRENCY story tasks.
 */
export class SlotPool {
  private size: number
  private active = 0
  private waiters: Array<() => void> = []

  constructor(size: number) {
    if (!Number.isInteger(size) || size < 1) {
      throw new Error('SlotPool size must be a positive integer')
    }
    this.size = size
  }

  get activeCount(): number {
    return this.active
  }

  get availableSlots(): number {
    return this.size - this.active
  }

  /** Acquire a slot, waiting if the pool is full. Returns a release function. */
  async acquire(): Promise<() => void> {
    if (this.active < this.size) {
      this.active++
      return () => this.release()
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve))
    this.active++
    return () => this.release()
  }

  private release(): void {
    this.active--
    const next = this.waiters.shift()
    if (next) next()
  }

  /** Run a task within an acquired slot, releasing it afterward. */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire()
    try {
      return await fn()
    } finally {
      release()
    }
  }
}
