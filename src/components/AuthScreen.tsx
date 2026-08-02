import { useState } from 'react'
import { APP_VERSION } from '../lib/version'
import './AuthScreen.css'

export type AuthUser = {
  id: string
  name: string
  email: string
}

type Mode = 'signIn' | 'signUp' | 'forgot'

/** Forgetting a password is two screens: ask for a code, then type it back. */
type Stage = 'ask' | 'code'

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
  const [stage, setStage] = useState<Stage>('ask')
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  async function submit() {
    const auth = window.aicut?.auth
    if (!auth) {
      setError('Accounts need the desktop app.')
      return
    }

    setBusy(true)
    setError(null)

    // Asking for a code is the one path that does not end in being signed in.
    if (mode === 'forgot' && stage === 'ask') {
      const reply = await auth.requestReset(email)
      setBusy(false)

      if ('error' in reply) {
        setError(reply.error)
        return
      }

      setStage('code')
      setPassword('')
      setNotice(`Code sent to ${reply.email}. It expires in 10 minutes.`)
      return
    }

    const reply =
      mode === 'signUp'
        ? await auth.signUp(name, email, password)
        : mode === 'forgot'
          ? await auth.resetPassword(email, code, password)
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
    setStage('ask')
    setError(null)
    setNotice(null)
    setPassword('')
    setCode('')
  }

  const asking = mode === 'forgot' && stage === 'ask'
  const resetting = mode === 'forgot' && stage === 'code'

  const heading = resetting ? 'Set a new password' : asking ? 'Forgot your password?' : null

  const action = busy
    ? 'Working…'
    : asking
      ? 'Email me a code'
      : resetting
        ? 'Save new password'
        : mode === 'signUp'
          ? 'Create account'
          : 'Sign in'

  return (
    <div className="auth-screen">
      <div className="auth-glow" aria-hidden="true" />
      <div className="auth-panel">
        <header className="auth-brand">
          <h1 className="auth-logo">AiCut</h1>
          <p className="auth-tagline">Your AI video editor. Sign in to keep your projects yours.</p>
          <span className="auth-version">{APP_VERSION}</span>
        </header>

        {mode === 'forgot' ? (
          <div className="auth-step">
            <h2 className="auth-step-title">{heading}</h2>
            <p className="auth-step-blurb">
              {resetting
                ? 'Type the six digits from the email, and what you want the password to be now.'
                : 'Tell us the email on your account and a six-digit code will be sent to it.'}
            </p>
          </div>
        ) : (
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
        )}

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
              readOnly={resetting}
              onChange={(event) => setEmail(event.target.value)}
            />
          </label>

          {resetting && (
            <label className="auth-field">
              <span>Code from your email</span>
              <input
                className="auth-code"
                value={code}
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                placeholder="000000"
                onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
              />
            </label>
          )}

          {!asking && (
            <label className="auth-field">
              <span>{resetting ? 'New password' : 'Password'}</span>
              <input
                type="password"
                value={password}
                autoComplete={mode === 'signIn' ? 'current-password' : 'new-password'}
                minLength={8}
                placeholder={mode === 'signIn' ? 'Your password' : 'At least 8 characters'}
                onChange={(event) => setPassword(event.target.value)}
              />
            </label>
          )}

          {notice && <p className="auth-notice">{notice}</p>}
          {error && <p className="auth-error">{error}</p>}

          <button className="btn btn-primary auth-submit" type="submit" disabled={busy}>
            {action}
          </button>
        </form>

        <div className="auth-links">
          {mode === 'signIn' && (
            <button className="auth-link" type="button" onClick={() => switchMode('forgot')}>
              Forgot your password?
            </button>
          )}

          {resetting && (
            <button
              className="auth-link"
              type="button"
              disabled={busy}
              onClick={() => {
                setStage('ask')
                setCode('')
                setError(null)
                setNotice(null)
              }}
            >
              Send another code
            </button>
          )}

          {mode === 'forgot' && (
            <button className="auth-link" type="button" onClick={() => switchMode('signIn')}>
              Back to sign in
            </button>
          )}
        </div>

        <p className="auth-note">
          Accounts stay on this computer. Your password is hashed and never leaves the machine.
        </p>
      </div>
    </div>
  )
}
