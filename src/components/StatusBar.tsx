import { useEffect, useRef, useState } from 'react'
import type { Release } from '../lib/version'
import { APP_VERSION, RELEASES, SEEN_VERSION_KEY } from '../lib/version'
import { UpdateButton } from './UpdateButton'
import './StatusBar.css'

type Props = {
  clips: number
  tracks: number
  overlays: number
  /** Shown next to the version, for whatever the app is busy with. */
  status?: string | null
}

function formatDate(date: string): string {
  const parsed = new Date(`${date}T00:00:00`)
  return Number.isNaN(parsed.getTime())
    ? date
    : parsed.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

function ReleaseNotes({ releases, onClose }: { releases: Release[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function onDown(event: PointerEvent) {
      if (!ref.current?.contains(event.target as Node)) onClose()
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose()
    }

    window.addEventListener('pointerdown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  return (
    <div className="release-notes" ref={ref}>
      <div className="release-notes-head">
        <span>What's new</span>
        <button className="btn btn-small" type="button" onClick={onClose}>
          Close
        </button>
      </div>

      <div className="release-list">
        {releases.map((release) => (
          <section className="release" key={release.version}>
            <header className="release-head">
              <span className="release-version">{release.version}</span>
              <span className="release-title">{release.title}</span>
              <span className="release-date">{formatDate(release.date)}</span>
            </header>
            <ul className="release-changes">
              {release.changes.map((change) => (
                <li key={change}>{change}</li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  )
}

/**
 * The bar along the bottom: what version this is, what changed in it, and a
 * count of what is on the timeline.
 */
export function StatusBar({ clips, tracks, overlays, status }: Props) {
  const [open, setOpen] = useState(false)
  const [fresh, setFresh] = useState(false)

  // A version the user has not seen yet is worth pointing at once.
  useEffect(() => {
    try {
      const seen = window.localStorage.getItem(SEEN_VERSION_KEY)
      if (seen !== APP_VERSION) setFresh(true)
    } catch {
      // Private browsing modes can refuse storage; the badge is not important
      // enough to make noise about.
    }
  }, [])

  function toggle() {
    setOpen((current) => !current)
    if (fresh) {
      setFresh(false)
      try {
        window.localStorage.setItem(SEEN_VERSION_KEY, APP_VERSION)
      } catch {
        // As above.
      }
    }
  }

  return (
    <footer className="status-bar">
      <button
        className={`version-badge${fresh ? ' is-fresh' : ''}`}
        type="button"
        onClick={toggle}
        title="Version history"
      >
        AiCut {APP_VERSION}
        {fresh && <span className="version-dot" aria-label="New in this version" />}
      </button>

      <span className="status-counts">
        {clips} clip{clips === 1 ? '' : 's'} · {tracks} track{tracks === 1 ? '' : 's'}
        {overlays > 0 && ` · ${overlays} text`}
      </span>

      {status && <span className="status-message">{status}</span>}

      <UpdateButton />

      {open && <ReleaseNotes releases={RELEASES} onClose={() => setOpen(false)} />}
    </footer>
  )
}
