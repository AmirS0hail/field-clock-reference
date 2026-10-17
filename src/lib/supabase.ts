import { createClient } from '@supabase/supabase-js'
import type { ClockEvent } from './clock'
import type { ClockKind } from './db'
import type { RecordResult } from './queue'

const url = import.meta.env.VITE_SUPABASE_URL
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

export const supabase = url && anonKey ? createClient(url, anonKey) : null

export async function recordClockEvent(input: {
  event_id: string
  kind: ClockKind
  device_time: string
}): Promise<RecordResult> {
  if (!supabase) throw new Error('Supabase is not configured')

  const { data, error } = await supabase.rpc('record_clock_event', input)
  if (error) throw new Error(error.message)
  if (!isRecordResult(data)) throw new Error('Unexpected response from record_clock_event')
  return data
}

export async function fetchClockEvents(): Promise<ClockEvent[]> {
  if (!supabase) throw new Error('Supabase is not configured')

  const { data, error } = await supabase
    .from('clock_events')
    .select('id, user_id, event_id, kind, device_time, received_at')
    .order('received_at', { ascending: false })

  if (error) throw new Error(error.message)
  return (data ?? []) as ClockEvent[]
}

export async function signOut(): Promise<void> {
  if (!supabase) return
  const { error } = await supabase.auth.signOut()
  if (error) throw new Error(error.message)
}

function isRecordResult(value: unknown): value is RecordResult {
  if (!value || typeof value !== 'object') return false
  const record = value as { ok?: unknown; duplicate?: unknown; reason?: unknown }
  if (record.ok === true) return typeof record.duplicate === 'boolean'
  if (record.ok === false) return typeof record.reason === 'string'
  return false
}
