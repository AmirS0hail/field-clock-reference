import type { ClockKind, OutboxRow, OutboxStatus } from './db'

export type ClockEvent = {
  id: number
  user_id: string
  event_id: string
  kind: ClockKind
  device_time: string
  received_at: string
}

export type ClockState = 'clocked_in' | 'clocked_out'

const REASONS: Record<string, string> = {
  already_clocked_in: 'Already clocked in.',
  already_clocked_out: 'Already clocked out.',
  device_time_in_future: 'Device time is too far in the future.',
  invalid_kind: 'This clock event is not valid.',
  not_authenticated: 'Sign in again.',
}

export function reasonText(reason: string): string {
  return REASONS[reason] ?? 'The server rejected this event.'
}

export function kindLabel(kind: ClockKind): string {
  return kind === 'clock_in' ? 'Clock in' : 'Clock out'
}

export function statusLabel(online: boolean, waiting: number): string {
  if (!online) return `Offline · ${waiting} waiting`
  if (waiting > 0) return `Online · ${waiting} waiting`
  return 'Online'
}

export function effectiveStatus(
  serverRows: { kind: ClockKind; received_at: string }[],
  queued: { kind: ClockKind; status: OutboxStatus; seq: number }[],
): ClockState {
  const latest = [...serverRows].sort((a, b) =>
    a.received_at < b.received_at ? 1 : a.received_at > b.received_at ? -1 : 0,
  )[0]
  let state: ClockState = latest?.kind === 'clock_in' ? 'clocked_in' : 'clocked_out'
  const upcoming = queued
    .filter((row) => row.status === 'pending' || row.status === 'flushing')
    .sort((a, b) => a.seq - b.seq)

  for (const row of upcoming) {
    state = row.kind === 'clock_in' ? 'clocked_in' : 'clocked_out'
  }

  return state
}

export type VisibleEvent = {
  eventId: string
  kind: ClockKind
  deviceTime: string
  receivedAt: string | null
  pending: boolean
  rejected: boolean
  lastError: string | null
}

export function mergeEvents(serverRows: ClockEvent[], outbox: OutboxRow[]): VisibleEvent[] {
  const queuedIds = new Set(outbox.map((row) => row.eventId))
  const queued: VisibleEvent[] = [...outbox]
    .sort((a, b) => b.seq - a.seq)
    .map((row) => ({
      eventId: row.eventId,
      kind: row.kind,
      deviceTime: row.deviceTime,
      receivedAt: null,
      pending: row.status === 'pending' || row.status === 'flushing',
      rejected: row.status === 'rejected',
      lastError: row.lastError,
    }))
  const synced: VisibleEvent[] = [...serverRows]
    .filter((row) => !queuedIds.has(row.event_id))
    .sort((a, b) =>
      a.received_at < b.received_at ? 1 : a.received_at > b.received_at ? -1 : 0,
    )
    .map((row) => ({
      eventId: row.event_id,
      kind: row.kind,
      deviceTime: row.device_time,
      receivedAt: row.received_at,
      pending: false,
      rejected: false,
      lastError: null,
    }))

  return [...queued, ...synced]
}

export function sendAgainTarget(
  serverRows: ClockEvent[],
  outbox: OutboxRow[],
): { eventId: string; kind: ClockKind; deviceTime: string } | null {
  const waiting = outbox
    .filter((row) => row.status === 'pending' || row.status === 'flushing')
    .sort((a, b) => b.seq - a.seq)[0]

  if (waiting) {
    return { eventId: waiting.eventId, kind: waiting.kind, deviceTime: waiting.deviceTime }
  }

  const newest = [...serverRows].sort((a, b) =>
    a.received_at < b.received_at ? 1 : a.received_at > b.received_at ? -1 : 0,
  )[0]

  if (!newest) return null

  return {
    eventId: newest.event_id,
    kind: newest.kind,
    deviceTime: newest.device_time,
  }
}
