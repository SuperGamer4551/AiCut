import { useEffect, useRef, useState } from 'react'
import type { TextOverlay } from '../lib/types'
import { displayText } from '../lib/overlay'

type Props = {
  overlays: TextOverlay[]
  zoom: number
  height: number
  onSeek: (time: number) => void
  onEdit: (id: string, text: string) => void
  onRemove: (id: string) => void
}

/**
 * The strip of on-screen text above the tracks. Each block can be renamed in
 * place and removed, which covers the fiddly part of writing a hook; moving one
 * is left to the assistant.
 */
export function TextLane({ overlays, zoom, height, onSeek, onEdit, onRemove }: Props) {
  const [editing, setEditing] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editing) inputRef.current?.select()
  }, [editing])

  return (
    <div className="text-lane" style={{ height }}>
      {overlays.length === 0 && <span className="text-lane-empty">Text you add appears here</span>}

      {overlays.map((overlay) => (
        <div
          key={overlay.id}
          className={`text-block is-${overlay.style}`}
          style={{ left: overlay.start * zoom, width: Math.max(overlay.duration * zoom, 44) }}
          title={`${displayText(overlay)} · ${overlay.style} · double-click to edit`}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => onSeek(overlay.start)}
          onDoubleClick={() => setEditing(overlay.id)}
        >
          {editing === overlay.id ? (
            <input
              ref={inputRef}
              className="text-block-input"
              defaultValue={overlay.text}
              onClick={(event) => event.stopPropagation()}
              onBlur={(event) => {
                setEditing(null)
                onEdit(overlay.id, event.target.value)
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') event.currentTarget.blur()
                if (event.key === 'Escape') setEditing(null)
              }}
            />
          ) : (
            <span className="text-block-label">{displayText(overlay)}</span>
          )}

          <button
            className="text-block-remove"
            type="button"
            title="Remove this text"
            onClick={(event) => {
              event.stopPropagation()
              onRemove(overlay.id)
            }}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  )
}
