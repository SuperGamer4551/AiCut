import type { PointerEvent as ReactPointerEvent } from 'react'
import { useEffect, useRef } from 'react'
import type { Crop } from '../lib/types'
import { ASPECT_PRESETS, FULL_CROP, clampCrop, cropForAspect, cropRectStyle, cropSummary } from '../lib/crop'

type Handle = 'tl' | 'tr' | 'bl' | 'br' | 'move'

type OverlayProps = {
  crop: Crop
  onChange: (crop: Crop) => void
}

/** Draggable crop window, sized to the media content it sits on top of. */
export function CropOverlay({ crop, onChange }: OverlayProps) {
  const layerRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ handle: Handle; startCrop: Crop; startX: number; startY: number } | null>(
    null,
  )

  useEffect(() => {
    function handleMove(event: PointerEvent) {
      const drag = dragRef.current
      const rect = layerRef.current?.getBoundingClientRect()
      if (!drag || !rect || rect.width === 0 || rect.height === 0) return

      const { handle, startCrop } = drag

      if (handle === 'move') {
        const dx = (event.clientX - drag.startX) / rect.width
        const dy = (event.clientY - drag.startY) / rect.height
        onChange(clampCrop({ ...startCrop, x: startCrop.x + dx, y: startCrop.y + dy }))
        return
      }

      const nx = (event.clientX - rect.left) / rect.width
      const ny = (event.clientY - rect.top) / rect.height
      const right = startCrop.x + startCrop.width
      const bottom = startCrop.y + startCrop.height
      const next = { ...startCrop }

      if (handle === 'tl' || handle === 'bl') {
        next.x = Math.min(nx, right)
        next.width = right - next.x
      } else {
        next.width = Math.max(0, nx - startCrop.x)
      }

      if (handle === 'tl' || handle === 'tr') {
        next.y = Math.min(ny, bottom)
        next.height = bottom - next.y
      } else {
        next.height = Math.max(0, ny - startCrop.y)
      }

      onChange(clampCrop(next))
    }

    function handleUp() {
      dragRef.current = null
    }

    window.addEventListener('pointermove', handleMove)
    window.addEventListener('pointerup', handleUp)
    window.addEventListener('pointercancel', handleUp)

    return () => {
      window.removeEventListener('pointermove', handleMove)
      window.removeEventListener('pointerup', handleUp)
      window.removeEventListener('pointercancel', handleUp)
    }
  }, [onChange])

  function begin(event: ReactPointerEvent<HTMLElement>, handle: Handle) {
    if (event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    dragRef.current = { handle, startCrop: crop, startX: event.clientX, startY: event.clientY }
  }

  return (
    <div className="crop-layer" ref={layerRef}>
      <div
        className="crop-window"
        style={cropRectStyle(crop)}
        onPointerDown={(event) => begin(event, 'move')}
      >
        <span className="crop-grid" aria-hidden />
        {(['tl', 'tr', 'bl', 'br'] as const).map((handle) => (
          <span
            key={handle}
            className={`crop-handle crop-handle-${handle}`}
            onPointerDown={(event) => begin(event, handle)}
          />
        ))}
      </div>
    </div>
  )
}

type BarProps = {
  crop: Crop
  mediaWidth?: number
  mediaHeight?: number
  onChange: (crop: Crop) => void
  onDone: () => void
}

export function CropBar({ crop, mediaWidth, mediaHeight, onChange, onDone }: BarProps) {
  const width = mediaWidth ?? 1920
  const height = mediaHeight ?? 1080

  return (
    <div className="crop-bar">
      <span className="crop-readout">{cropSummary(crop, mediaWidth, mediaHeight)}</span>

      <div className="crop-presets">
        {ASPECT_PRESETS.map((preset) => (
          <button
            key={preset.id}
            className="btn btn-small"
            type="button"
            onClick={() =>
              onChange(preset.ratio === null ? FULL_CROP : cropForAspect(preset.ratio, width, height))
            }
          >
            {preset.label}
          </button>
        ))}
      </div>

      <div className="crop-actions">
        <button className="btn btn-small" type="button" onClick={() => onChange(FULL_CROP)}>
          Reset
        </button>
        <button className="btn btn-small btn-primary" type="button" onClick={onDone}>
          Done
        </button>
      </div>
    </div>
  )
}
