/**
 * In-memory SessionPersistence backend for code-review attempts.
 *
 * Real source code reaches the model through tool results, which the session
 * log records verbatim. Writing that log to disk would leave repository
 * content in JSONL files outside the snapshot store, so the ACP profile
 * disables the JSONL backend and mounts this volatile one instead: nothing is
 * ever materialized, and the whole log dies with the attempt process.
 *
 * flush() is deliberately a no-op. This backend makes no crash-durability
 * promise, which is exactly why it must never be used by a surface that
 * resumes sessions.
 */

import z from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import {
  SessionPersistence,
  SessionPersistenceRevision,
  SessionAlreadyExistsError,
  SessionAlreadyOwnedError,
  SessionHandleClosedError,
  SessionPersistenceNotFoundError,
  SessionReadOnlyError,
  assertContiguous,
  assertStoredId,
  materializeAppendBatch,
  materializeCreateHeader,
  validateStoredEvents,
  type SessionAccess,
  type SessionHandle,
  type SessionHandleAppendOptions,
  type SessionHandleFlushOptions,
  type SessionHandleReadOptions,
  type SessionHandleReadResult,
  type SessionPersistenceCreateOptions,
  type SessionPersistenceListOptions,
  type SessionPersistenceOpenOptions,
  type SessionPersistenceSnapshot,
  type SessionPersistenceStatOptions,
} from '@deepseek-ai/dsh-session-persistence'
import {
  SessionLogOffset,
  type SessionEvent,
  type SessionHeader,
  type SessionId,
} from '@deepseek-ai/dsh-session'

export const name = 'session-persistence-memory'

export const Config = z.object({})

interface StoredSession {
  header: SessionHeader
  /** Number of leading events inherited from a fork parent. */
  baseOffset: SessionLogOffset
  events: SessionEvent[]
  revision: number
  owner: MemorySessionHandle | null
  /** Serializes routed live-event appends for this session. */
  tail: Promise<void>
}

/**
 * Diagnostics go to stderr only: stdout belongs to the ACP stream. Messages
 * carry event types and counts, never event content.
 */
function diagnostic(message: string): void {
  if (process.env.HARNESS_PLUGIN_DIAGNOSTICS !== '1') return
  try {
    process.stderr.write(`[session-persistence-memory] ${message}\n`)
  } catch {
    // Diagnostics must never break the attempt.
  }
}

class MemorySessionHandle implements SessionHandle {
  private isClosed = false

  constructor(
    readonly id: SessionId,
    readonly access: SessionAccess,
    private readonly stored: StoredSession,
    private readonly onClose: (handle: MemorySessionHandle) => void,
  ) {
    if (access === 'write') {
      stored.owner = this
    }
  }

  get header(): SessionHeader {
    return this.stored.header
  }

  get inheritedEventCount(): SessionLogOffset {
    return this.stored.baseOffset
  }

  /** Logical next sequence number this handle's log expects. */
  get cursor(): number {
    return this.stored.baseOffset + this.stored.events.length
  }

  async read(
    offset = 0,
    length?: number,
    options?: SessionHandleReadOptions,
  ): Promise<SessionHandleReadResult> {
    this.assertOpen('read')
    options?.signal?.throwIfAborted()
    // Inherited events are counted but not stored, so translate the logical
    // offset into this backend's physical slice.
    const start = Math.max(0, offset - this.stored.baseOffset)
    const end = length === undefined ? this.stored.events.length : start + length
    return {
      eventState: 'shared-frozen',
      events: this.stored.events.slice(start, Math.max(start, end)),
    }
  }

  async append(
    events: readonly SessionEvent[],
    options?: SessionHandleAppendOptions,
  ): Promise<void> {
    this.assertOpen('append')
    this.assertWritable('append')
    options?.signal?.throwIfAborted()
    if (events.length === 0) return
    assertContiguous(this.id, events, this.cursor)
    const batch = materializeAppendBatch(events)
    const validated = validateStoredEvents(this.stored.header, [...batch])
    this.stored.events.push(...validated)
    this.stored.revision++
  }

  /** No-op barrier: this backend never materializes anything. */
  async flush(options?: SessionHandleFlushOptions): Promise<void> {
    this.assertOpen('flush')
    this.assertWritable('flush')
    options?.signal?.throwIfAborted()
  }

  async close(): Promise<void> {
    if (this.isClosed) return
    this.isClosed = true
    if (this.stored.owner === this) {
      this.stored.owner = null
    }
    this.onClose(this)
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close()
  }

  private assertOpen(operation: string): void {
    if (this.isClosed) {
      throw new SessionHandleClosedError(this.id, operation)
    }
  }

  private assertWritable(operation: string): void {
    if (this.access === 'read') {
      throw new SessionReadOnlyError(this.id, operation)
    }
  }
}

export class MemorySessionPersistence extends SessionPersistence {
  private readonly sessions = new Map<string, StoredSession>()
  private readonly handles = new Set<MemorySessionHandle>()

  constructor(ctx: Context) {
    super(ctx)

    // The abstract seam does not route live session events; every backend
    // installs this itself. Without it the agent loop's events are silently
    // dropped instead of reaching storage.
    diagnostic('mounted')

    ctx.on('session/event', (session, event) => {
      const handle = this.sessions.get(session.id)?.owner
      if (!handle) {
        diagnostic(
          `dropped event: no write handle for session (known=${this.sessions.size}, type=${event.type})`,
        )
        return
      }
      // Serialize appends per session: session/event is a synchronous
      // fire-and-forget feed, so overlapping appends would break contiguity.
      const stored = this.sessions.get(session.id)
      if (!stored) return
      stored.tail = stored.tail
        .then(() => handle.append([event]))
        .catch((err: unknown) => {
          diagnostic(`append failed (type=${event.type}): ${(err as Error)?.message ?? err}`)
        })
    })
    ctx.on('session/flush', () => {
      // Nothing is buffered: append() is already the terminal state here.
    })
    ctx.on('session/disposed', (session) => {
      const handle = this.sessions.get(session.id)?.owner
      if (!handle) return
      void handle.close().catch(() => undefined)
    })
    ctx.effect(() => async () => {
      for (const handle of [...this.handles]) {
        await handle.close().catch(() => undefined)
      }
      this.sessions.clear()
    })
  }

  async create(
    header: SessionHeader,
    options?: SessionPersistenceCreateOptions,
  ): Promise<SessionHandle> {
    options?.signal?.throwIfAborted()
    if (this.sessions.has(header.id)) {
      throw new SessionAlreadyExistsError(header.id)
    }
    const meta = materializeCreateHeader(header)
    this.sessions.set(meta.id, {
      header: meta,
      baseOffset: options?.inheritedEventCount ?? SessionLogOffset(0),
      events: [],
      revision: 0,
      owner: null,
      tail: Promise.resolve(),
    })
    diagnostic(`created session (seeded=${meta.isSeeded})`)
    return this.openHandle(meta.id, 'write')
  }

  async open(
    id: SessionId,
    access: SessionAccess,
    options?: SessionPersistenceOpenOptions,
  ): Promise<SessionHandle> {
    options?.signal?.throwIfAborted()
    const stored = this.sessions.get(id)
    if (!stored) {
      throw new SessionPersistenceNotFoundError(id)
    }
    assertStoredId(id, stored.header)
    if (access === 'write' && stored.owner) {
      throw new SessionAlreadyOwnedError(id)
    }
    return this.openHandle(id, access)
  }

  /** Nothing is buffered and nothing is durable, so the barrier is empty. */
  async flush(): Promise<void> {}

  async stat(
    id: SessionId,
    options?: SessionPersistenceStatOptions,
  ): Promise<SessionPersistenceSnapshot | undefined> {
    options?.signal?.throwIfAborted()
    const stored = this.sessions.get(id)
    return stored ? this.snapshot(stored) : undefined
  }

  async list(
    options?: SessionPersistenceListOptions,
  ): Promise<readonly SessionPersistenceSnapshot[]> {
    options?.signal?.throwIfAborted()
    return [...this.sessions.values()].map((stored) => this.snapshot(stored))
  }

  private snapshot(stored: StoredSession): SessionPersistenceSnapshot {
    return {
      header: stored.header,
      revision: SessionPersistenceRevision(`${stored.header.id}:${stored.revision}`),
      eventCount: stored.baseOffset + stored.events.length,
    }
  }

  private openHandle(id: SessionId, access: SessionAccess): SessionHandle {
    const stored = this.sessions.get(id)
    if (!stored) {
      throw new SessionPersistenceNotFoundError(id)
    }
    const handle = new MemorySessionHandle(id, access, stored, (closed) => {
      this.handles.delete(closed)
    })
    this.handles.add(handle)
    return handle
  }
}

export function apply(ctx: Context): void {
  ctx.plugin(MemorySessionPersistence)
}
