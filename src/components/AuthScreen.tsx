import { useState } from 'react'
import { APP_VERSION } from '../lib/version'
import './AuthScreen.css'

export type AuthUser = {
  id: string
  name: string
  email: string
}

type Mode = 'signIn' | 'signUp'

type Props = {
  onAuthed: (user: AuthUser) => void
}

/**
 * First screen of the app: make an account or sign back in. Projects only show
 * once someone is signed in, so two people on the same computer each keep their
 * own work.
 */
export function AuthScreen({ onAuthed }: Props) {
  const [mode, setMode] = useState<Mode>('signIn')
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit() {
    const auth = window.aicut?.auth
    if (!auth) {
      setError('Accounts need the desktop app.')
      return
    }

    setBusy(true)
    setError(null)

    const reply =
      mode === 'signUp'
        ? await auth.signUp(name, email, password)
        : await auth.signIn(email, password)

    setBusy(false)

    if ('error' in reply) {
      setError(reply.error)
      return
    }

    onAuthed(reply.user)
  }

  function switchMode(next: Mode) {
    setMode(next)
    setError(null)
    setPassword('')
  }

  return (
    <div className="auth-screen">
      <div className="auth-glow" aria-hidden="true" />
      <div className="auth-panel">
        <header className="auth-brand">
          <h1 className="auth-logo">AiCut</h1>
          <p className="auth-tagline">Your AI video editor. Sign in to keep your projects yours.</p>
          <span className="auth-version">{APP_VERSION}</span>
        </header>

        <div className="auth-tabs" role="tablist">
          <button
            className={`auth-tab${mode === 'signIn' ? ' is-active' : ''}`}
            type="button"
            role="tab"
            aria-selected={mode === 'signIn'}
            onClick={() => switchMode('signIn')}
          >
            Sign in
          </button>
          <button
            className={`auth-tab${mode === 'signUp' ? ' is-active' : ''}`}
            type="button"
            role="tab"
            aria-selected={mode === 'signUp'}
            onClick={() => switchMode('signUp')}
          >
            Create account
          </button>
        </div>

        <form
          className="auth-form"
          onSubmit={(event) => {
            event.preventDefault()
            void submit()
          }}
        >
          {mode === 'signUp' && (
            <label className="auth-field">
              <span>Name</span>
              <input
                value={name}
                autoComplete="name"
                maxLength={60}
                placeholder="What should we call you?"
                onChange={(event) => setName(event.target.value)}
              />
            </label>
          )}

          <label className="auth-field">
            <span>Email</span>
            <input
              type="email"
              value={email}
              autoComplete="email"
              maxLength={120}
              placeholder="you@example.com"
              onChange={(event) => setEmail(event.target.value)}
            />
          </label>

          <label className="auth-field">
            <span>Password</span>
            <input
              type="password"
              value={password}
              autoComplete={mode === 'signUp' ? 'new-password' : 'current-password'}
              minLength={8}
              placeholder={mode === 'signUp' ? 'At least 8 characters' : 'Your password'}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>

          {error && <p className="auth-error">{error}</p>}

          <button className="btn btn-primary auth-submit" type="submit" disabled={busy}>
            {busy ? 'Working…' : mode === 'signUp' ? 'Create account' : 'Sign in'}
          </button>
        </form>

        <p className="auth-note">
          Accounts stay on this computer. Your password is hashed and never leaves the machine.
        </p>
      </div>
    </div>
  )
}
