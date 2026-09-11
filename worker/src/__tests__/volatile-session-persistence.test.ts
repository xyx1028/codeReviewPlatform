/**
 * The in-memory SessionPersistence backend's storage contract.
 *
 * The integration test proves the Harness boots with this backend and writes no
 * JSONL. What it cannot show is that the backend honours the storage contract
 * it replaces — contiguous appends, single-writer ownership, monotonic reads,
 * closed-handle refusal. A backend that quietly accepted a gap would corrupt a
 * session's reconstruction, so those rules are pinned here.
 */

import { describe, it, expect } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SESSION_FORMAT_VERSION, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import { MemorySessionPersistence } from '../harness-plugins/volatile-session-persistence/index.js'

function header(id: string, overrides: Partial<SessionHeader> = {}): SessionHeader {
  return {
    version: SESSION_FORMAT_VERSION,
    id: SessionId(id),
    createdAt: 1_760_000_000_000,
    isSeeded: false,
    ...overrides,
  } as SessionHeader
}

/**
 * A minimal turn-start event. The backend validates events through the shared
 * storage contract, so this must be a real event shape rather than a stub.
 */
function event(seq: number): SessionEvent {
  return { seq, type: 'turn/start', data: { turn: seq + 1 } } as unknown as SessionEvent
}

function backend(): MemorySessionPersistence {
  // A bare Context is enough: the backend only uses it for event routing and
  // disposal effects.
  return new MemorySessionPersistence(new Context() as never)
}

describe('MemorySessionPersistence lifecycle', () => {
  it('creates a session and hands back a write handle', async () => {
    const store = backend()
    const handle = await store.create(header('11111111-1111-4111-8111-111111111111'))
    expect(handle.access).toBe('write')
    expect(handle.header.id).toBe('11111111-1111-4111-8111-111111111111')
    expect(handle.inheritedEventCount).toBe(0)

    const stat = await store.stat(handle.id)
    expect(stat?.eventCount).toBe(0)
    await handle.close()
  })

  it('refuses to create the same session twice', async () => {
    const store = backend()
    const id = '22222222-2222-4222-8222-222222222222'
    const handle = await store.create(header(id))
    await expect(store.create(header(id))).rejects.toThrow()
    await handle.close()
  })

  it('reports an absent session as undefined rather than throwing', async () => {
    const store = backend()
    expect(await store.stat(SessionId('33333333-3333-4333-8333-333333333333'))).toBeUndefined()
    await expect(
      store.open(SessionId('33333333-3333-4333-8333-333333333333'), 'read'),
    ).rejects.toThrow()
  })

  it('lists every stored session', async () => {
    const store = backend()
    const a = await store.create(header('44444444-4444-4444-8444-444444444444'))
    const b = await store.create(header('55555555-5555-4555-8555-555555555555'))
    const listed = await store.list()
    expect(listed.map((item) => item.header.id).sort()).toEqual(
      ['44444444-4444-4444-8444-444444444444', '55555555-5555-4555-8555-555555555555'],
    )
    await a.close()
    await b.close()
  })
})

describe('MemorySessionPersistence append and read', () => {
  const id = '66666666-6666-4666-8666-666666666666'

  it('accepts a contiguous batch and reads it back', async () => {
    const store = backend()
    const handle = await store.create(header(id))
    await handle.append([event(0), event(1)])

    const read = await handle.read()
    expect(read.events).toHaveLength(2)
    expect(read.events[0]?.seq).toBe(0)
    expect((await store.stat(handle.id))?.eventCount).toBe(2)
    await handle.close()
  })

  it('refuses a batch that leaves a gap', async () => {
    const store = backend()
    const handle = await store.create(header(id))
    await handle.append([event(0)])
    // seq 2 would skip seq 1: accepting it would corrupt reconstruction.
    await expect(handle.append([event(2)])).rejects.toThrow()
    expect((await handle.read()).events).toHaveLength(1)
    await handle.close()
  })

  it('refuses to rewrite a committed event', async () => {
    const store = backend()
    const handle = await store.create(header(id))
    await handle.append([event(0)])
    await expect(handle.append([event(0)])).rejects.toThrow()
    await handle.close()
  })

  it('ignores an empty batch', async () => {
    const store = backend()
    const handle = await store.create(header(id))
    await handle.append([])
    expect((await handle.read()).events).toHaveLength(0)
    await handle.close()
  })

  it('slices by offset and length, and returns empty past the end', async () => {
    const store = backend()
    const handle = await store.create(header(id))
    await handle.append([event(0), event(1), event(2)])

    expect((await handle.read(1)).events.map((e) => e.seq)).toEqual([1, 2])
    expect((await handle.read(0, 2)).events.map((e) => e.seq)).toEqual([0, 1])
    expect((await handle.read(9)).events).toHaveLength(0)
    await handle.close()
  })

  it('translates offsets for a forked session whose prefix is inherited', async () => {
    const store = backend()
    const handle = await store.create(
      header('77777777-7777-4777-8777-777777777777', { isSeeded: true, parentSession: SessionId(id) }),
      { inheritedEventCount: SessionLogOffset(5) },
    )
    expect(handle.inheritedEventCount).toBe(5)

    // The first live event continues the inherited prefix, not seq 0.
    await handle.append([event(5)])
    const read = await handle.read(5)
    expect(read.events.map((e) => e.seq)).toEqual([5])
    expect((await store.stat(handle.id))?.eventCount).toBe(6)
    await handle.close()
  })
})

describe('MemorySessionPersistence ownership and durability', () => {
  const id = '88888888-8888-4888-8888-888888888888'

  it('allows one writer at a time and releases ownership on close', async () => {
    const store = backend()
    const writer = await store.create(header(id))
    await expect(store.open(writer.id, 'write')).rejects.toThrow()

    await writer.close()
    const second = await store.open(writer.id, 'write')
    expect(second.access).toBe('write')
    await second.close()
  })

  it('allows readers alongside the writer but refuses writes on them', async () => {
    const store = backend()
    const writer = await store.create(header(id))
    await writer.append([event(0)])

    const reader = await store.open(writer.id, 'read')
    expect((await reader.read()).events).toHaveLength(1)
    await expect(reader.append([event(1)])).rejects.toThrow()
    await expect(reader.flush()).rejects.toThrow()

    await reader.close()
    await writer.close()
  })

  it('refuses every operation once the handle is closed', async () => {
    const store = backend()
    const handle = await store.create(header(id))
    await handle.close()
    // close() is idempotent; everything else must reject.
    await handle.close()
    await expect(handle.read()).rejects.toThrow()
    await expect(handle.append([event(0)])).rejects.toThrow()
    await expect(handle.flush()).rejects.toThrow()
  })

  it('treats flush as a no-op because nothing is ever materialized', async () => {
    const store = backend()
    const handle = await store.create(header(id))
    await handle.append([event(0)])
    await expect(handle.flush()).resolves.toBeUndefined()
    await expect(store.flush()).resolves.toBeUndefined()
    // The log is still only in memory: flush promises nothing about a crash.
    expect((await handle.read()).events).toHaveLength(1)
    await handle.close()
  })

  it('supports explicit disposal', async () => {
    const store = backend()
    const handle = await store.create(header(id))
    await handle[Symbol.asyncDispose]()
    await expect(handle.read()).rejects.toThrow()
  })

  it('changes the revision when the log grows', async () => {
    const store = backend()
    const handle = await store.create(header(id))
    const before = (await store.stat(handle.id))?.revision
    await handle.append([event(0)])
    const after = (await store.stat(handle.id))?.revision
    expect(after).not.toBe(before)
    await handle.close()
  })
})
