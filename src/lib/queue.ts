import { reasonText } from './clock'
import type { ClockEvent } from './clock'
import { db } from './db'
import type { ClockKind, OutboxRow } from './db'

export type RecordResult =
  | { ok: true; duplicate: boolean; row: ClockEvent }
  | { ok: false; reason: string }

export type RecordRpc = (input: {
  event_id: string
  kind: ClockKind
  device_time: string
}) => Promise<RecordResult>

export type SendAgainResult = 'duplicate' | 'ok' | 'rejected' | 'pending'

let tail: Promise<void> = Promise.resolve()
let activeUserId = ''
let activeRpc: RecordRpc | null = null

export async function enqueue(input: {
  eventId: string
  userId: string
  kind: ClockKind
  deviceTime: string
}): Promise<OutboxRow> {
  return db.transaction('rw', db.outbox, async () => {
    const existing = await db.outbox.get(input.eventId)
    if (existing) return existing

    const last = await db.outbox.orderBy('seq').last()
    const row: OutboxRow = {
      eventId: input.eventId,
      userId: input.userId,
      kind: input.kind,
      deviceTime: input.deviceTime,
      seq: (last?.seq ?? 0) + 1,
      status: 'pending',
      lastError: null,
    }
    await db.outbox.add(row)
    return row
  })
}

export async function waitingCount(userId: string): Promise<number> {
  const [pending, flushing] = await Promise.all([
    db.outbox.where('[userId+status]').equals([userId, 'pending']).count(),
    db.outbox.where('[userId+status]').equals([userId, 'flushing']).count(),
  ])
  return pending + flushing
}

export async function dismissRejected(eventId: string): Promise<void> {
  const row = await db.outbox.get(eventId)
  if (row?.status === 'rejected') await db.outbox.delete(eventId)
}

export function kick(userId: string, rpc: RecordRpc): Promise<void> {
  if (!userId) return Promise.resolve()
  activeUserId = userId
  activeRpc = rpc
  const run = tail.then(() => withFlushLock(() => flushOnce()))
  tail = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

export async function sendAgain(
  input: { eventId: string; userId: string; kind: ClockKind; deviceTime: string },
  rpc: RecordRpc,
): Promise<SendAgainResult> {
  await enqueue({
    eventId: input.eventId,
    userId: input.userId,
    kind: input.kind,
    deviceTime: input.deviceTime,
  })

  let outcome: SendAgainResult = 'pending'
  await kick(input.userId, async (payload) => {
    const result = await rpc(payload)
    if (payload.event_id === input.eventId) {
      if (result.ok) outcome = result.duplicate ? 'duplicate' : 'ok'
      else outcome = 'rejected'
    }
    return result
  })
  return outcome
}

async function resetFlushing(userId: string): Promise<void> {
  const stuck = await db.outbox.where('[userId+status]').equals([userId, 'flushing']).toArray()
  await Promise.all(
    stuck.map((row) => db.outbox.update(row.eventId, { status: 'pending' as const })),
  )
}

async function flushOnce(): Promise<void> {
  const userId = activeUserId
  const rpc = activeRpc
  if (!userId || !rpc) return

  // A reload during an in-flight call leaves the row flushing. Retry the same event id.
  await resetFlushing(userId)
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return

  for (;;) {
    const pending = await db.outbox
      .where('[userId+status]')
      .equals([userId, 'pending'])
      .sortBy('seq')
    const next = pending[0]
    if (!next) return

    await db.outbox.update(next.eventId, { status: 'flushing', lastError: null })

    let result: RecordResult
    try {
      result = await rpc({
        event_id: next.eventId,
        kind: next.kind,
        device_time: next.deviceTime,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Network error'
      await db.outbox.update(next.eventId, { status: 'pending', lastError: message })
      return
    }

    if (result.ok) {
      await db.outbox.delete(next.eventId)
      continue
    }

    await db.outbox.update(next.eventId, {
      status: 'rejected',
      lastError: reasonText(result.reason),
    })
  }
}

async function withFlushLock(work: () => Promise<void>): Promise<void> {
  const locks = globalThis.navigator?.locks
  if (!locks?.request) {
    await work()
    return
  }
  await locks.request('field-clock-flush', async () => {
    await work()
  })
}
