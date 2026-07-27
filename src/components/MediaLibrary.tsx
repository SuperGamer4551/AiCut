import type { DragEvent } from 'react'
import { useState } from 'react'
import type { DragMedia, MediaItem } from '../lib/types'
import { formatSize, formatTime } from '../lib/types'
import { MEDIA_DRAG_TYPE } from '../lib/timeline'
import './MediaLibrary.css'

type Props = {
  items: MediaItem[]
  selectedId: string | null
  onSelect: (id: string) => void
  onImport: () => void
  onRemove: (id: string) => void
  onDropFiles: (files: FileList | File[]) => void
  onDragMediaStart: (media: DragMedia) => void
  onDragMediaEnd: () => void
}

export function MediaLibrary({
  items,
  selectedId,
  onSelect,
  onImport,
  onRemove,
  onDropFiles,
  onDragMediaStart,
  onDragMediaEnd,
}: Props) {
  const [hovered, setHovered] = useState(false)

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault()
    setHovered(false)
    if (event.dataTransfer.files.length > 0) onDropFiles(event.dataTransfer.files)
  }

  return (
    <aside className="panel media-library">
      <div className="panel-header">
        <h2 className="panel-title">Media</h2>
        <button className="btn btn-ghost" type="button" onClick={onImport} title="Import files">
          +
        </button>
      </div>

      <div
        className={`media-drop${hovered ? ' is-hovered' : ''}`}
        onDragOver={(event) => {
          event.preventDefault()
          setHovered(true)
        }}
        onDragLeave={() => setHovered(false)}
        onDrop={handleDrop}
      >
        {items.length === 0 ? (
          <div className="media-empty">
            <div className="media-empty-title">No media yet</div>
            <p className="media-empty-text">
              Drop files here from your computer, or browse to import.
            </p>
            <button className="btn btn-primary" type="button" onClick={onImport}>
              Import files
            </button>
          </div>
        ) : (
          <ul className="media-list">
            {items.map((item) => (
              <li key={item.id} className="media-row">
                <button
                  type="button"
                  className={`media-item${selectedId === item.id ? ' is-selected' : ''}${
                    item.loading ? ' is-loading' : ''
                  }`}
                  onClick={() => onSelect(item.id)}
                  draggable={!item.loading}
                  onDragStart={(event) => {
                    if (item.loading) {
                      event.preventDefault()
                      return
                    }
                    event.dataTransfer.setData(MEDIA_DRAG_TYPE, item.id)
                    event.dataTransfer.effectAllowed = 'copy'
                    onDragMediaStart({
                      id: item.id,
                      name: item.name,
                      kind: item.kind,
                      duration: item.duration,
                    })
                  }}
                  onDragEnd={onDragMediaEnd}
                >
                  <span className={`media-kind kind-${item.kind}`}>{item.kind}</span>
                  <span className="media-meta">
                    <span className="media-name" title={item.path ?? item.name}>
                      {item.name}
                    </span>
                    <span className="media-sub">
                      {item.error ? (
                        <span className="media-error">{item.error}</span>
                      ) : item.loading ? (
                        'Reading…'
                      ) : (
                        <>
                          {formatTime(item.duration)}
                          <span className="media-dot">·</span>
                          {formatSize(item.size)}
                        </>
                      )}
                    </span>
                  </span>
                </button>
                <button
                  className="media-remove"
                  type="button"
                  onClick={() => onRemove(item.id)}
                  title={`Remove ${item.name}`}
                  aria-label={`Remove ${item.name}`}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </aside>
  )
}
