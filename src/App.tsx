import { useEffect, useState, type FormEvent } from 'react'
import type { Session } from '@supabase/supabase-js'
import { ClockScreen } from './components/ClockScreen'
import { supabase } from './lib/supabase'

const persistedUsers = new Set<string>()

export default function App() {
  const [session, setSession] = useState<Session | null>(null)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    if (!supabase) return
    let active = true
    void supabase.auth.getSession().then(({ data }) => {
      if (!active) return
      setSession(data.session)
      setReady(true)
    })
    const { data } = supabase.auth.onAuthStateChange((_event, next) => {
      setSession(next)
      setReady(true)
    })
    return () => {
      active = false
      data.subscription.unsubscribe()
    }
  }, [])

  useEffect(() => {
    if (!session) return
    if (persistedUsers.has(session.user.id)) return
    persistedUsers.add(session.user.id)
    void navigator.storage?.persist?.()
  }, [session])

  return (
    <main className="page">
      <h1>Field clock reference</h1>
      {!supabase ? (
        <p className="reason">
          Add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to .env.local. Use the anon key from
          the Supabase dashboard, not the service role key.
        </p>
      ) : !ready ? (
        <p>Checking session…</p>
      ) : session ? (
        <ClockScreen userId={session.user.id} email={session.user.email ?? ''} />
      ) : (
        <SignIn />
      )}
    </main>
  )
}

function SignIn() {
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!supabase) return
    const form = new FormData(event.currentTarget)
    const email = String(form.get('email') ?? '')
    const password = String(form.get('password') ?? '')
    setPending(true)
    setError(null)
    const { error: signInError } = await supabase.auth.signInWithPassword({ email, password })
    setPending(false)
    if (signInError) setError(signInError.message)
  }

  return (
    <form className="sign-in panel" onSubmit={(event) => void onSubmit(event)}>
      <label>
        Email
        <input name="email" type="email" autoComplete="username" required />
      </label>
      <label>
        Password
        <input name="password" type="password" autoComplete="current-password" required />
      </label>
      {error ? <p className="reason">{error}</p> : null}
      <button type="submit" className="primary" disabled={pending}>
        Sign in
      </button>
    </form>
  )
}
