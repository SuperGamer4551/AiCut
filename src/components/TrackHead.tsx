import { useEffect, useRef, useState } from 'react'
import type { Track } from '../lib/types'

type Props = {
  track: Track
  height: number
  canRemove: boolean
  onRename: (name: string) => void
  onRemove: () => void
}

export function TrackHead({ track, height, canRemove, onRename, onRemove }: Props) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(track.name)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!editing) return
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [editing])

  function startEditing() {
    setDraft(track.name)
    setEditing(true)
  }

  function commit() {
    const name = draft.trim()
    setEditing(false)
    if (name && name !== track.name) onRename(name)
  }

  return (
    <div className="track-head" style={{ height }}>
      {editing ? (
        <input
          ref={inputRef}
          className="track-name-input"
          value={draft}
          maxLength={40}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') commit()
            if (event.key === 'Escape') setEditing(false)
          }}
        />
      ) : (
        <button
          className="track-name"
          type="button"
          onDoubleClick={startEditing}
          title={`${track.name} — double-click to rename`}
        >
          {track.name}
        </button>
      )}

      <div className="track-actions">
        <button
          className="track-action"
          type="button"
          onClick={startEditing}
          title="Rename track"
          aria-label={`Rename ${track.name}`}
        >
          ✎
        </button>
        <button
          className="track-action track-action-danger"
          type="button"
          onClick={onRemove}
          disabled={!canRemove}
          title={canRemove ? 'Remove track' : 'Keep at least one track of each type'}
          aria-label={`Remove ${track.name}`}
        >
          ×
        </button>
      </div>
    </div>
  )
}
