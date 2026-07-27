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
  onTogglePlay: () => void
  onImport: () => void
  onAddToTimeline: () => void
  onResetLayout: () => void
  onExport: () => void
}

export function TopBar({
  playing,
  playhead,
  duration,
  canAdd,
  canPlay,
  canExport,
  progress,
  onTogglePlay,
  onImport,
  onAddToTimeline,
  onResetLayout,
  onExport,
}: Props) {
  const busy = progress !== null
  const percent = busy ? Math.round(progress.fraction * 100) : 0

  return (
    <header className="topbar">
      <div className="brand-block">
        <div className="brand-mark" aria-hidden />
        <div>
          <div className="brand-name">AiCut</div>
          <div className="brand-sub">AI video editor</div>
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
