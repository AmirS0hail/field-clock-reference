import { useCallback, useEffect, useRef, useState } from 'react'
import { liveQuery } from 'dexie'
import {
  effectiveStatus,
  kindLabel,
  mergeEvents,
  sendAgainTarget,
  statusLabel,
} from '../lib/clock'
import type { ClockEvent } from '../lib/clock'
import { db } from '../lib/db'
import type { ClockKind, OutboxRow } from '../lib/db'
import { dismissRejected, enqueue, kick, sendAgain } from '../lib/queue'
import { fetchClockEvents, recordClockEvent, signOut } from '../lib/supabase'

function formatTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date)
}

function eventRowClass(event: { pending: boolean; rejected: boolean }): string {
  if (event.rejected) return 'rejected'
  if (event.pending) return 'pending'
  return 'saved'
}

export function ClockScreen({ userId, email }: { userId: string; email: string }) {
  const [rows, setRows] = useState<OutboxRow[]>([])
  const [serverRows, setServerRows] = useState<ClockEvent[]>([])
  const [online, setOnline] = useState(() => navigator.onLine)
  const [serverError, setServerError] = useState<string | null>(null)
  const [serverLoaded, setServerLoaded] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [pendingClick, setPendingClick] = useState(false)
  const busy = useRef(false)

  const loadServer = useCallback(async () => {
    if (navigator.onLine === false) {
      setServerLoaded(true)
      return
    }
    try {
      setServerRows(await fetchClockEvents())
      setServerError(null)
    } catch (error) {
      setServerError(error instanceof Error ? error.message : 'Could not load clock events.')
    } finally {
      setServerLoaded(true)
    }
  }, [])

  useEffect(() => {
    const subscription = liveQuery(() =>
      db.outbox.where('userId').equals(userId).sortBy('seq'),
    ).subscribe({
      next: (nextRows) => setRows(nextRows),
      error: () => setRows([]),
    })
    return () => subscription.unsubscribe()
  }, [userId])

  useEffect(() => {
    const flush = () => kick(userId, recordClockEvent).then(() => loadServer())
    const onOnline = () => {
      setOnline(true)
      void flush()
    }
    const onOffline = () => setOnline(false)
    const onVisibility = () => {
      if (document.visibilityState === 'visible') void flush()
    }

    window.addEventListener('online', onOnline)
    window.addEventListener('offline', onOffline)
    document.addEventListener('visibilitychange', onVisibility)
    void flush()

    return () => {
      window.removeEventListener('online', onOnline)
      window.removeEventListener('offline', onOffline)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [loadServer, userId])

  const waiting = rows.filter((row) => row.status === 'pending' || row.status === 'flushing').length
  const state = effectiveStatus(serverRows, rows)
  const events = mergeEvents(serverRows, rows)
  const target = sendAgainTarget(serverRows, rows)
  const statusTone = waiting > 0 ? 'waiting' : online ? 'calm' : 'offline'
  const statusSolid = waiting > 0 || online

  async function runExclusive(work: () => Promise<void>) {
    if (busy.current) return
    busy.current = true
    setPendingClick(true)
    setNotice(null)
    try {
      await work()
    } finally {
      busy.current = false
      setPendingClick(false)
    }
  }

  function clock(kind: ClockKind) {
    void runExclusive(async () => {
      await enqueue({
        eventId: crypto.randomUUID(),
        userId,
        kind,
        deviceTime: new Date().toISOString(),
      })
      await kick(userId, recordClockEvent)
      await loadServer()
    })
  }

  function sync() {
    void runExclusive(async () => {
      await kick(userId, recordClockEvent)
      await loadServer()
    })
  }

  function onSendAgain() {
    if (!target) return
    const again = target
    void runExclusive(async () => {
      const outcome = await sendAgain(
        {
          eventId: again.eventId,
          userId,
          kind: again.kind,
          deviceTime: again.deviceTime,
        },
        recordClockEvent,
      )
      await loadServer()
      if (outcome === 'duplicate') setNotice('Already recorded — same row.')
    })
  }

  function onSignOut() {
    void (async () => {
      if (waiting > 0) {
        const ok = window.confirm(
          `${waiting} waiting. Sign out anyway? Queued events stay on this device until this user signs in again.`,
        )
        if (!ok) return
      }
      await signOut()
    })()
  }

  return (
    <section className="clock panel">
      <p className="who">{email}</p>
      <p className={`status ${statusTone}`} data-testid="queue-status" role="status">
        <svg className="status-dot" viewBox="0 0 8 8" width="8" height="8" aria-hidden="true">
          <circle
            cx="4"
            cy="4"
            r={statusSolid ? 3 : 2.2}
            fill={statusSolid ? 'currentColor' : 'none'}
            stroke={statusSolid ? 'none' : 'currentColor'}
            strokeWidth={statusSolid ? undefined : 1.5}
          />
        </svg>
        {statusLabel(online, waiting)}
      </p>
      <p className={state === 'clocked_in' ? 'state clocked-in' : 'state'}>
        {state === 'clocked_in' ? 'Clocked in' : 'Clocked out'}
      </p>
      <div className="actions">
        {state === 'clocked_out' ? (
          <button type="button" className="primary" onClick={() => clock('clock_in')} disabled={pendingClick}>
            Clock in
          </button>
        ) : (
          <button type="button" className="primary" onClick={() => clock('clock_out')} disabled={pendingClick}>
            Clock out
          </button>
        )}
        <button type="button" className="secondary" onClick={sync} disabled={pendingClick}>
          Sync Now
        </button>
      </div>
      {serverError ? <p className="reason">{serverError}</p> : null}
      <ul className="events" data-testid="event-list">
        {events.length === 0 ? (
          serverLoaded ? <li className="empty">No clock events yet.</li> : null
        ) : (
          events.map((event) => (
            <li
              key={event.eventId}
              className={eventRowClass(event)}
              data-testid="event-row"
              data-event-id={event.eventId}
              data-pending={event.pending ? 'true' : 'false'}
            >
              <div className="event-title">
                <span>{kindLabel(event.kind)}</span>
                <code>{event.eventId.slice(0, 8)}</code>
              </div>
              <div className="event-times">
                <p>
                  <span className="time-label">Claimed</span>
                  <time dateTime={event.deviceTime}>{formatTime(event.deviceTime)}</time>
                </p>
                <p>
                  <span className="time-label">Received</span>
                  <span data-testid="received-at">{event.receivedAt ? formatTime(event.receivedAt) : '—'}</span>
                </p>
              </div>
              {event.rejected && event.lastError ? <p className="reason">{event.lastError}</p> : null}
              {event.rejected ? (
                <button type="button" onClick={() => void dismissRejected(event.eventId)}>
                  Dismiss
                </button>
              ) : null}
            </li>
          ))
        )}
      </ul>
      <button type="button" className="proof" onClick={onSendAgain} disabled={pendingClick || !target}>
        Send again
      </button>
      {notice ? (
        <p className="notice" data-testid="sync-notice">
          {notice}
        </p>
      ) : null}
      <div className="sign-out">
        <button type="button" onClick={onSignOut}>
          Sign out
        </button>
      </div>
    </section>
  )
}
