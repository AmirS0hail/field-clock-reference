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
  return date.toLocaleString()
}

export function ClockScreen({ userId, email }: { userId: string; email: string }) {
  const [rows, setRows] = useState<OutboxRow[]>([])
  const [serverRows, setServerRows] = useState<ClockEvent[]>([])
  const [online, setOnline] = useState(() => navigator.onLine)
  const [serverError, setServerError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [pendingClick, setPendingClick] = useState(false)
  const busy = useRef(false)

  const loadServer = useCallback(async () => {
    if (navigator.onLine === false) return
    try {
      setServerRows(await fetchClockEvents())
      setServerError(null)
    } catch (error) {
      setServerError(error instanceof Error ? error.message : 'Could not load clock events.')
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
    <section className="clock">
      <p className="who">{email}</p>
      <p className="status" data-testid="queue-status" role="status">
        {statusLabel(online, waiting)}
      </p>
      <p className="state">{state === 'clocked_in' ? 'Clocked in' : 'Clocked out'}</p>
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
        <button type="button" onClick={sync} disabled={pendingClick}>
          Sync Now
        </button>
        <button type="button" onClick={onSendAgain} disabled={pendingClick || !target}>
          Send again
        </button>
      </div>
      {notice ? (
        <p className="notice" data-testid="sync-notice">
          {notice}
        </p>
      ) : null}
      {serverError ? <p className="reason">{serverError}</p> : null}
      <ul className="events" data-testid="event-list">
        {events.map((event) => (
          <li
            key={event.eventId}
            data-testid="event-row"
            data-event-id={event.eventId}
            data-pending={event.pending ? 'true' : 'false'}
          >
            <div className="event-title">
              <span>{kindLabel(event.kind)}</span>
              <code>{event.eventId.slice(0, 8)}</code>
            </div>
            <p>
              Claimed <time dateTime={event.deviceTime}>{formatTime(event.deviceTime)}</time>
            </p>
            <p>
              Received{' '}
              <span data-testid="received-at">{event.receivedAt ? formatTime(event.receivedAt) : '—'}</span>
            </p>
            {event.rejected && event.lastError ? <p className="reason">{event.lastError}</p> : null}
            {event.rejected ? (
              <button type="button" onClick={() => void dismissRejected(event.eventId)}>
                Dismiss
              </button>
            ) : null}
          </li>
        ))}
      </ul>
      <button type="button" className="text" onClick={onSignOut}>
        Sign out
      </button>
    </section>
  )
}
