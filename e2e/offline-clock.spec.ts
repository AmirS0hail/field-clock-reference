import { expect, test, type Page } from '@playwright/test'
import { createClient } from '@supabase/supabase-js'

test.beforeAll(() => {
  const missing = ['VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY', 'E2E_EMAIL', 'E2E_PASSWORD'].filter(
    (name) => !process.env[name],
  )
  if (missing.length > 0) {
    throw new Error(`Set ${missing.join(', ')} in .env.local before running Playwright.`)
  }
})

test('offline clock-in survives reload and a second submit stays one row', async ({ page, context }) => {
  const rpcCalls: string[] = []
  page.on('request', (request) => {
    if (request.url().includes('/rest/v1/rpc/record_clock_event')) rpcCalls.push(request.url())
  })

  await page.goto('/')
  if (!(await page.evaluate(() => navigator.serviceWorker.controller))) {
    await page.reload()
  }
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null)

  await page.getByLabel('Email').fill(process.env.E2E_EMAIL ?? '')
  await page.getByLabel('Password').fill(process.env.E2E_PASSWORD ?? '')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByTestId('queue-status')).toBeVisible()

  await page.getByRole('button', { name: 'Sync Now' }).click()
  await expect(page.getByTestId('queue-status')).toHaveText('Online')
  if (await page.getByRole('button', { name: 'Clock out' }).isVisible()) {
    await page.getByRole('button', { name: 'Clock out' }).click()
    await expect(page.getByRole('button', { name: 'Clock in' })).toBeVisible()
    await expect(page.getByTestId('queue-status')).toHaveText('Online')
  }

  rpcCalls.length = 0
  await context.setOffline(true)
  await page.getByRole('button', { name: 'Clock in' }).click()
  await expect(page.getByTestId('queue-status')).toHaveText('Offline · 1 waiting')
  expect(rpcCalls).toHaveLength(0)

  const eventId = await page
    .locator('[data-testid="event-row"][data-pending="true"]')
    .getAttribute('data-event-id')
  expect(eventId).toBeTruthy()

  await page.reload()
  await expect(page.getByTestId('queue-status')).toHaveText('Offline · 1 waiting')
  await expect(page.locator(`[data-event-id="${eventId}"]`)).toHaveCount(1)

  await context.setOffline(false)
  await page.getByRole('button', { name: 'Sync Now' }).click()
  const synced = page.locator(`[data-testid="event-row"][data-event-id="${eventId}"]`)
  await expect(synced).toHaveCount(1)
  await expect(synced.locator('[data-testid="received-at"]')).not.toHaveText('—')
  await expect(page.getByTestId('queue-status')).toHaveText('Online')

  await page.getByRole('button', { name: 'Send again' }).click()
  await expect(page.getByTestId('sync-notice')).toHaveText('Already recorded — same row.')
  await expect(page.locator(`[data-testid="event-row"][data-event-id="${eventId}"]`)).toHaveCount(1)
  expect(await countOwnRows(page, eventId ?? '')).toBe(1)
})

async function countOwnRows(page: Page, eventId: string): Promise<number> {
  const raw = await page.evaluate(() => {
    const key = Object.keys(localStorage).find((entry) => entry.startsWith('sb-') && entry.endsWith('-auth-token'))
    return key ? localStorage.getItem(key) : null
  })
  if (!raw) throw new Error('Missing signed-in session')

  const parsed = JSON.parse(raw) as {
    access_token?: string
    refresh_token?: string
    currentSession?: { access_token?: string; refresh_token?: string }
  }
  const accessToken = parsed.access_token ?? parsed.currentSession?.access_token
  const refreshToken = parsed.refresh_token ?? parsed.currentSession?.refresh_token
  if (!accessToken || !refreshToken) throw new Error('Stored session has no tokens')

  const client = createClient(process.env.VITE_SUPABASE_URL ?? '', process.env.VITE_SUPABASE_ANON_KEY ?? '', {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const { error: sessionError } = await client.auth.setSession({
    access_token: accessToken,
    refresh_token: refreshToken,
  })
  if (sessionError) throw sessionError

  const { count, error } = await client
    .from('clock_events')
    .select('event_id', { count: 'exact', head: true })
    .eq('event_id', eventId)
  if (error) throw error
  return count ?? 0
}
