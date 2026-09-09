/**
 * Structured JSON logger. (Plan §18)
 *
 * Every line includes at least: timestamp, level, worker_id, and any provided
 * context (job_id, batch_id, story_code, stage, event, duration_ms).
 * All values are passed through redaction before serialization.
 */

import { redact, redactString } from './security/redaction.js'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface LogContext {
  worker_id?: string
  job_id?: string
  batch_id?: string
  story_code?: string
  stage?: string
  event?: string
  duration_ms?: number
  [key: string]: unknown
}

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
}

export interface LoggerOptions {
  workerId?: string
  minLevel?: LogLevel
  /** Sink for testing; defaults to process.stdout. */
  sink?: (line: string) => void
}

export class Logger {
  private base: LogContext
  private minLevel: LogLevel
  private sink: (line: string) => void

  constructor(opts: LoggerOptions = {}) {
    this.base = opts.workerId ? { worker_id: opts.workerId } : {}
    this.minLevel = opts.minLevel ?? 'info'
    this.sink = opts.sink ?? ((line) => process.stdout.write(line + '\n'))
  }

  /** Return a new logger with additional bound context. */
  child(context: LogContext): Logger {
    const c = new Logger({ minLevel: this.minLevel, sink: this.sink })
    c.base = { ...this.base, ...context }
    return c
  }

  private emit(level: LogLevel, event: string, context?: LogContext): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.minLevel]) return
    const record = {
      timestamp: new Date().toISOString(),
      level,
      ...this.base,
      ...(context ?? {}),
      event: redactString(event),
    }
    const safe = redact(record)
    try {
      this.sink(JSON.stringify(safe))
    } catch {
      this.sink(JSON.stringify({ timestamp: new Date().toISOString(), level, event: '[unserializable log record]' }))
    }
  }

  debug(event: string, context?: LogContext): void {
    this.emit('debug', event, context)
  }
  info(event: string, context?: LogContext): void {
    this.emit('info', event, context)
  }
  warn(event: string, context?: LogContext): void {
    this.emit('warn', event, context)
  }
  error(event: string, context?: LogContext): void {
    this.emit('error', event, context)
  }
}

export const rootLogger = new Logger({
  workerId: process.env.WORKER_ID,
  minLevel: (process.env.LOG_LEVEL as LogLevel) || 'info',
})
