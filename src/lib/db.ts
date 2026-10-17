import Dexie, { type Table } from 'dexie'

export type ClockKind = 'clock_in' | 'clock_out'
export type OutboxStatus = 'pending' | 'flushing' | 'rejected'

export type OutboxRow = {
  eventId: string
  userId: string
  kind: ClockKind
  deviceTime: string
  seq: number
  status: OutboxStatus
  lastError: string | null
}

export class FieldClockDB extends Dexie {
  outbox!: Table<OutboxRow, string>

  constructor() {
    super('field-clock')
    this.version(1).stores({
      outbox: 'eventId, userId, [userId+status], seq',
    })
  }
}

export const db = new FieldClockDB()
