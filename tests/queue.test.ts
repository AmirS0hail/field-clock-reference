import 'fake-indexeddb/auto'
import { beforeEach, expect, it } from 'vitest'
import { db } from '../src/lib/db'
import type { ClockKind } from '../src/lib/db'
import { enqueue, kick, waitingCount } from '../src/lib/queue'
import type { RecordResult, RecordRpc } from '../src/lib/queue'

const userId = 'user-a'

beforeEach(async () => {
  await db.outbox.clear()
})

it('flushes queued events in enqueue order', async () => {
  const first = await enqueue(row('evt-1', 'clock_in', '2026-10-17T08:00:00.000Z'))
  const second = await enqueue(row('evt-2', 'clock_out', '2026-10-17T09:00:00.000Z'))
  const seen: string[] = []

  await kick(userId, async (input) => {
    seen.push(input.event_id)
    return accepted(input)
  })

  expect(seen).toEqual([first.eventId, second.eventId])
  expect(await db.outbox.count()).toBe(0)
})

it('does not send later events when a flush fails', async () => {
  const first = await enqueue(row('evt-1', 'clock_in', '2026-10-17T08:00:00.000Z'))
  await enqueue(row('evt-2', 'clock_out', '2026-10-17T09:00:00.000Z'))
  const seen: string[] = []

  await kick(userId, async (input) => {
    seen.push(input.event_id)
    const stored = await db.outbox.get(input.event_id)
    expect(stored?.eventId).toBe(input.event_id)
    throw new Error('offline')
  })

  expect(seen).toEqual([first.eventId])
  const pending = await db.outbox.get(first.eventId)
  expect(pending?.status).toBe('pending')
  expect(pending?.lastError).toBe('offline')
  expect(await waitingCount(userId)).toBe(2)
})

it('removes a row after a successful flush', async () => {
  const queued = await enqueue(row('evt-1', 'clock_in', '2026-10-17T08:00:00.000Z'))

  await kick(userId, async (input) => {
    expect(await db.outbox.get(input.event_id)).toMatchObject({ status: 'flushing' })
    return accepted(input)
  })

  expect(await db.outbox.get(queued.eventId)).toBeUndefined()
  expect(await waitingCount(userId)).toBe(0)
})

it('keeps one queued intent when the same event is enqueued twice', async () => {
  const first = await enqueue(row('evt-1', 'clock_in', '2026-10-17T08:00:00.000Z'))
  const second = await enqueue({
    eventId: first.eventId,
    userId,
    kind: 'clock_out',
    deviceTime: '2026-10-17T09:00:00.000Z',
  })

  expect(await db.outbox.count()).toBe(1)
  expect(second).toEqual(first)
  expect(second.kind).toBe('clock_in')
  expect(second.deviceTime).toBe('2026-10-17T08:00:00.000Z')
  expect(second.status).toBe('pending')
})

it('removes the row when the server says the event was already recorded', async () => {
  const queued = await enqueue(row('evt-1', 'clock_in', '2026-10-17T08:00:00.000Z'))

  await kick(userId, async (input) => ({
    ok: true,
    duplicate: true,
    row: accepted(input).row,
  }))

  expect(await db.outbox.get(queued.eventId)).toBeUndefined()
})

it('rejects one event and still flushes the next', async () => {
  const rejected = await enqueue(row('evt-1', 'clock_in', '2026-10-17T08:00:00.000Z'))
  const next = await enqueue(row('evt-2', 'clock_out', '2026-10-17T09:00:00.000Z'))
  const seen: string[] = []

  await kick(userId, async (input) => {
    seen.push(input.event_id)
    if (input.event_id === rejected.eventId) {
      return { ok: false, reason: 'already_clocked_in' }
    }
    return accepted(input)
  })

  expect(seen).toEqual([rejected.eventId, next.eventId])
  expect(await db.outbox.get(rejected.eventId)).toMatchObject({
    status: 'rejected',
    lastError: 'Already clocked in.',
  })
  expect(await db.outbox.get(next.eventId)).toBeUndefined()
  expect(await waitingCount(userId)).toBe(0)
})

it('does not call the server while the browser is offline', async () => {
  const queued = await enqueue(row('evt-off', 'clock_in', '2026-10-17T08:00:00.000Z'))
  const previous = globalThis.navigator
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { onLine: false },
  })
  let calls = 0
  try {
    await kick(userId, async (input) => {
      calls += 1
      return accepted(input)
    })
  } finally {
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: previous })
  }

  expect(calls).toBe(0)
  expect(await db.outbox.get(queued.eventId)).toMatchObject({ status: 'pending' })
  expect(await waitingCount(userId)).toBe(1)
})

it('sends a row left in flushing once on the next flush', async () => {
  await db.outbox.add({
    eventId: 'evt-lost',
    userId,
    kind: 'clock_in',
    deviceTime: '2026-10-17T08:00:00.000Z',
    seq: 1,
    status: 'flushing',
    lastError: null,
  })
  let calls = 0

  await kick(userId, async (input) => {
    calls += 1
    return accepted(input)
  })

  expect(calls).toBe(1)
  expect(await db.outbox.get('evt-lost')).toBeUndefined()
})

function row(eventId: string, kind: ClockKind, deviceTime: string) {
  return { eventId, userId, kind, deviceTime }
}

function accepted(input: Parameters<RecordRpc>[0]): Extract<RecordResult, { ok: true }> {
  return {
    ok: true,
    duplicate: false,
    row: {
      id: 1,
      user_id: userId,
      event_id: input.event_id,
      kind: input.kind,
      device_time: input.device_time,
      received_at: '2026-10-17T08:00:05.000Z',
    },
  }
}
