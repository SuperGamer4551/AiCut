import { useEffect, useRef, useState } from 'react'
import { cleanProjectName } from '../lib/project'
import { formatTime } from '../lib/types'
import './TopBar.css'

type Props = {
  playing: boolean
  playhead: number
  duration: number
  canAdd: boolean
  canPlay: boolean
  canExport: boolean
  /** Render or upload progress, shown in place of the export label. */
  progress: { phase: string; fraction: number } | null
  /** The open project, shown where the brand used to sit. */
  project: { name: string; kind: string }
  /** Whether the last edit has reached disk yet. */
  saved: boolean
  onLeave: () => void
  onRename: (name: string) => void
  onTogglePlay: () => void
  onImport: () => void
  onAddToTimeline: () => void
  onResetLayout: () => void
  onCheckCopyright: () => void
  onExport: () => void
}

/**
 * The project's name, renamed in place. The mark beside it goes back to the
 * dashboard, so the two are separate targets rather than one that has to guess
 * which you meant.
 */
function ProjectName({ name, onRename }: { name: string; onRename: (name: string) => void }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(name)
  const field = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editing) field.current?.select()
  }, [editing])

  function commit() {
    setEditing(false)
    const cleaned = cleanProjectName(draft, name)
    setDraft(cleaned)
    if (cleaned !== name) onRename(cleaned)
  }

  if (editing) {
    return (
      <input
        ref={field}
        className="brand-name brand-name-field"
        value={draft}
        maxLength={60}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') commit()
          if (event.key === 'Escape') {
            setDraft(name)
            setEditing(false)
          }
        }}
      />
    )
  }

  return (
    <button
      className="brand-name"
      type="button"
      title="Rename this project"
      onClick={() => {
        setDraft(name)
        setEditing(true)
      }}
    >
      {name}
    </button>
  )
}

export function TopBar({
  playing,
  playhead,
  duration,
  canAdd,
  canPlay,
  canExport,
  progress,
  project,
  saved,
  onLeave,
  onRename,
  onTogglePlay,
  onImport,
  onAddToTimeline,
  onResetLayout,
  onCheckCopyright,
  onExport,
}: Props) {
  const busy = progress !== null
  const percent = busy ? Math.round(progress.fraction * 100) : 0

  return (
    <header className="topbar">
      <div className="brand-block">
        <button
          className="brand-back"
          type="button"
          onClick={onLeave}
          title="Back to your projects"
          aria-label="Back to your projects"
        >
          <span className="brand-mark" aria-hidden />
        </button>
        <div className="brand-text">
          <ProjectName name={project.name} onRename={onRename} />
          <div className="brand-sub">{saved ? project.kind : 'Saving…'}</div>
        </div>
      </div>

      <div className="transport">
        <button
          className="btn icon-btn"
          type="button"
          onClick={onTogglePlay}
          disabled={!canPlay}
          aria-label={playing ? 'Pause' : 'Play'}
        >
          <span className={playing ? 'glyph-pause' : 'glyph-play'} aria-hidden />
        </button>
        <div className="timecode" aria-live="polite">
          <span>{formatTime(playhead)}</span>
          <span className="timecode-sep">/</span>
          <span className="timecode-total">{formatTime(duration)}</span>
        </div>
      </div>

      <div className="topbar-actions">
        <button
          className="btn btn-ghost btn-small"
          type="button"
          onClick={onResetLayout}
          title="Restore the default panel arrangement and sizes"
        >
          Reset layout
        </button>
        <button className="btn" type="button" onClick={onImport}>
          Import
        </button>
        <button
          className="btn"
          type="button"
          onClick={onCheckCopyright}
          disabled={!canExport}
          title="Check what on the timeline might get claimed"
        >
          Copyright
        </button>
        <button
          className={`btn${busy ? ' is-busy' : ''}`}
          type="button"
          onClick={onExport}
          disabled={!canExport || busy}
          title="Render the timeline to a video file"
        >
          {busy ? `${progress.phase === 'upload' ? 'Uploading' : 'Rendering'} ${percent}%` : 'Export'}
          {busy && <span className="btn-progress" style={{ width: `${percent}%` }} aria-hidden />}
        </button>
        <button className="btn btn-primary" type="button" onClick={onAddToTimeline} disabled={!canAdd}>
          Add to timeline
        </button>
      </div>
    </header>
  )
}
