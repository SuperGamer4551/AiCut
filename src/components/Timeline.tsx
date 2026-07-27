import type { DragEvent, PointerEvent as ReactPointerEvent } from 'react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { DragMedia, TextOverlay, TimelineClip, Track, TrackKind } from '../lib/types'
import { formatTime } from '../lib/types'
import {
  LANE_HEIGHT,
  MAX_ZOOM,
  MEDIA_DRAG_TYPE,
  MIN_ZOOM,
  RULER_HEIGHT,
  TEXT_LANE_HEIGHT,
  clampZoom,
  placeClip,
  rulerSteps,
  trackAccepts,
} from '../lib/timeline'
import { isCropped } from '../lib/crop'
import { describeFrame } from '../lib/overlay'
import { TrackHead } from './TrackHead'
import { TextLane } from './TextLane'
import { Splitter } from './Splitter'
import './Timeline.css'

type Props = {
  clips: TimelineClip[]
  tracks: Track[]
  overlays: TextOverlay[]
  playhead: number
  duration: number
  zoom: number
  dragMedia: DragMedia | null
  selectedClipId: string | null
  cropping: boolean
  canCrop: boolean
  gutterWidth: number
  onGutterWidthChange: (width: number) => void
  onZoomChange: (zoom: number) => void
  onSeek: (time: number) => void
  onSelectClip: (id: string | null) => void
  onMoveClip: (id: string, track: string, start: number) => void
  onDropMedia: (mediaId: string, track: string, start: number) => void
  onDeleteClip: (id: string) => void
  onAddTrack: (kind: TrackKind) => void
  onRenameTrack: (id: string, name: string) => void
  onRemoveTrack: (id: string) => void
  onToggleCrop: () => void
  onAddText: () => void
  onEditText: (id: string, text: string) => void
  onRemoveText: (id: string) => void
}

type ClipDrag = {
  clipId: string
  track: string
  start: number
  snappedTo: number | null
  moved: boolean
}

type DropPreview = {
  track: string
  start: number
  duration: number
  snappedTo: number | null
}

type Pan = {
  /** Last seen pointer position; panning works off per-move deltas so hitting
   * an edge cannot build up an offset that has to be dragged back. */
  pointerX: number
  pointerY: number
  startX: number
  startY: number
  moved: boolean
}

const TAIL_SECONDS = 6
const PAN_THRESHOLD_PX = 3
const WHEEL_ZOOM_SENSITIVITY = 0.0016
const MAX_TICKS = 2000

export function Timeline({
  clips,
  tracks,
  overlays,
  playhead,
  duration,
  zoom,
  dragMedia,
  selectedClipId,
  cropping,
  canCrop,
  gutterWidth,
  onGutterWidthChange,
  onZoomChange,
  onSeek,
  onSelectClip,
  onMoveClip,
  onDropMedia,
  onDeleteClip,
  onAddTrack,
  onRenameTrack,
  onRemoveTrack,
  onToggleCrop,
  onAddText,
  onEditText,
  onRemoveText,
}: Props) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLDivElement>(null)
  const lanesRef = useRef<HTMLDivElement>(null)
  const grabOffsetRef = useRef(0)
  const dragRef = useRef<ClipDrag | null>(null)
  const panRef = useRef<Pan | null>(null)
  const scrubRef = useRef(false)
  const zoomRef = useRef(zoom)
  const gutterStartRef = useRef(gutterWidth)
  const anchorRef = useRef<{ time: number; offsetX: number } | null>(null)

  const [drag, setDrag] = useState<ClipDrag | null>(null)
  const [dropPreview, setDropPreview] = useState<DropPreview | null>(null)
  const [panning, setPanning] = useState(false)
  const [viewportWidth, setViewportWidth] = useState(0)

  zoomRef.current = zoom

  const contentEnd = useMemo(
    () =>
      overlays.reduce(
        (end, overlay) => Math.max(end, overlay.start + overlay.duration),
        clips.reduce((end, clip) => Math.max(end, clip.start + clip.duration), duration),
      ),
    [clips, overlays, duration],
  )

  // Keep at least half a screen of empty room past the last clip, so panning
  // toward the end never runs out of travel right away.
  const tail = Math.max(TAIL_SECONDS * zoom, viewportWidth / 2)

  // The canvas never stops short of the panel, so lanes and the ruler stay
  // continuous even when zoomed all the way out.
  const width = Math.max(contentEnd * zoom + tail, viewportWidth)
  const visibleEnd = width / zoom

  const ticks = useMemo(() => {
    const { labelStep, minorStep } = rulerSteps(zoom)
    const step = minorStep || labelStep
    const count = Math.min(Math.ceil(visibleEnd / step), MAX_TICKS)

    return Array.from({ length: count + 1 }, (_, index) => {
      const time = index * step
      const isLabelled = Math.abs(time / labelStep - Math.round(time / labelStep)) < 1e-6
      return { time, isLabelled }
    })
  }, [zoom, visibleEnd])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return

    setViewportWidth(el.clientWidth)
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (entry) setViewportWidth(entry.contentRect.width)
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  // Wheel and pinch zoom, anchored so the time under the cursor stays put.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return

    function onWheel(event: WheelEvent) {
      if (!el) return

      if (event.shiftKey) {
        event.preventDefault()
        el.scrollLeft += event.deltaY + event.deltaX
        return
      }

      event.preventDefault()
      const currentZoom = zoomRef.current
      const next = clampZoom(currentZoom * Math.exp(-event.deltaY * WHEEL_ZOOM_SENSITIVITY))
      if (Math.abs(next - currentZoom) < 1e-6) return

      const offsetX = event.clientX - el.getBoundingClientRect().left
      const pending = anchorRef.current

      // Several wheel events can arrive before a render. Keep the anchor from
      // the first one, since the scroll position it referred to is still
      // waiting to be applied.
      const time =
        pending && Math.abs(pending.offsetX - offsetX) < 24
          ? pending.time
          : (el.scrollLeft + offsetX) / currentZoom

      anchorRef.current = { time, offsetX }
      // Advance immediately so bursts of events compound instead of restarting
      // from the last rendered zoom.
      zoomRef.current = next
      onZoomChange(next)
    }

    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [onZoomChange])

  useLayoutEffect(() => {
    const el = scrollRef.current
    const anchor = anchorRef.current
    if (!el || !anchor) return

    anchorRef.current = null
    el.scrollLeft = anchor.time * zoom - anchor.offsetX
  }, [zoom])

  function timeAtClientX(clientX: number): number {
    const rect = canvasRef.current?.getBoundingClientRect()
    if (!rect) return 0
    return Math.max(0, (clientX - rect.left) / zoom)
  }

  function trackAtClientY(clientY: number, kind: DragMedia['kind'], fallback: string): string {
    const rect = lanesRef.current?.getBoundingClientRect()
    if (!rect) return fallback

    const index = Math.floor((clientY - rect.top) / LANE_HEIGHT)
    const candidate = tracks[Math.max(0, Math.min(tracks.length - 1, index))]

    return candidate && trackAccepts(tracks, candidate.id, kind) ? candidate.id : fallback
  }

  function setClipDrag(next: ClipDrag | null) {
    dragRef.current = next
    setDrag(next)
  }

  function beginClipDrag(event: ReactPointerEvent<HTMLDivElement>, clip: TimelineClip) {
    if (event.button !== 0) return
    event.stopPropagation()
    event.preventDefault()

    grabOffsetRef.current = timeAtClientX(event.clientX) - clip.start
    onSelectClip(clip.id)
    setClipDrag({
      clipId: clip.id,
      track: clip.track,
      start: clip.start,
      snappedTo: null,
      moved: false,
    })
  }

  useEffect(() => {
    const active = dragRef.current
    if (!active) return

    const clip = clips.find((entry) => entry.id === active.clipId)
    if (!clip) return

    function handleMove(event: PointerEvent) {
      const current = dragRef.current
      if (!current || !clip) return

      if (event.buttons === 0) {
        handleUp()
        return
      }

      const track = trackAtClientY(event.clientY, clip.kind, current.track)
      const placement = placeClip({
        clips,
        track,
        excludeId: clip.id,
        desiredStart: timeAtClientX(event.clientX) - grabOffsetRef.current,
        duration: clip.duration,
        zoom,
        playhead,
      })

      setClipDrag({
        clipId: current.clipId,
        track,
        start: placement.start,
        snappedTo: placement.snappedTo,
        moved: true,
      })
    }

    function handleUp() {
      const current = dragRef.current
      setClipDrag(null)
      if (!current?.moved) return
      onMoveClip(current.clipId, current.track, current.start)
    }

    window.addEventListener('pointermove', handleMove)
    window.addEventListener('pointerup', handleUp)
    window.addEventListener('pointercancel', handleUp)

    return () => {
      window.removeEventListener('pointermove', handleMove)
      window.removeEventListener('pointerup', handleUp)
      window.removeEventListener('pointercancel', handleUp)
    }
  }, [drag?.clipId, clips, tracks, zoom, playhead, onMoveClip])

  // Dragging empty timeline space pans the view; a click without movement
  // still seeks and clears the selection.
  function beginPan(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return
    if (!scrollRef.current) return

    // Stops the press from starting a text selection that follows the drag.
    event.preventDefault()

    panRef.current = {
      pointerX: event.clientX,
      pointerY: event.clientY,
      startX: event.clientX,
      startY: event.clientY,
      moved: false,
    }
    setPanning(true)
  }

  function beginScrub(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return
    event.stopPropagation()
    event.preventDefault()
    scrubRef.current = true
    onSeek(Math.min(timeAtClientX(event.clientX), visibleEnd))
  }

  useEffect(() => {
    function endGesture(event: PointerEvent) {
      if (scrubRef.current) {
        scrubRef.current = false
        return
      }

      const pan = panRef.current
      if (!pan) return

      panRef.current = null
      setPanning(false)

      if (!pan.moved) {
        onSelectClip(null)
        onSeek(Math.min(timeAtClientX(event.clientX), visibleEnd))
      }
    }

    function handleMove(event: PointerEvent) {
      // The button can be released outside the window, where no pointerup
      // arrives; a move with nothing held means the gesture is over.
      if (event.buttons === 0) {
        endGesture(event)
        return
      }

      if (scrubRef.current) {
        onSeek(Math.min(timeAtClientX(event.clientX), visibleEnd))
        return
      }

      const pan = panRef.current
      const el = scrollRef.current
      if (!pan || !el) return

      const dx = event.clientX - pan.pointerX
      const dy = event.clientY - pan.pointerY
      pan.pointerX = event.clientX
      pan.pointerY = event.clientY

      if (!pan.moved) {
        const travel = Math.hypot(event.clientX - pan.startX, event.clientY - pan.startY)
        if (travel < PAN_THRESHOLD_PX) return
        pan.moved = true
      }

      el.scrollLeft -= dx
      el.scrollTop -= dy
    }

    window.addEventListener('pointermove', handleMove)
    window.addEventListener('pointerup', endGesture)
    window.addEventListener('pointercancel', endGesture)

    return () => {
      window.removeEventListener('pointermove', handleMove)
      window.removeEventListener('pointerup', endGesture)
      window.removeEventListener('pointercancel', endGesture)
    }
  }, [onSeek, onSelectClip, visibleEnd, zoom])

  function handleLaneDragOver(event: DragEvent<HTMLDivElement>, track: string) {
    if (!dragMedia || !event.dataTransfer.types.includes(MEDIA_DRAG_TYPE)) return
    if (!trackAccepts(tracks, track, dragMedia.kind)) return

    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'

    const clipDuration = Math.max(dragMedia.duration, 1)
    const placement = placeClip({
      clips,
      track,
      excludeId: null,
      desiredStart: timeAtClientX(event.clientX) - clipDuration / 2,
      duration: clipDuration,
      zoom,
      playhead,
    })

    setDropPreview({
      track,
      start: placement.start,
      duration: clipDuration,
      snappedTo: placement.snappedTo,
    })
  }

  function handleLaneDrop(event: DragEvent<HTMLDivElement>, track: string) {
    if (!dragMedia || !trackAccepts(tracks, track, dragMedia.kind)) return

    event.preventDefault()
    const start = dropPreview?.track === track ? dropPreview.start : timeAtClientX(event.clientX)
    setDropPreview(null)
    onDropMedia(dragMedia.id, track, start)
  }

  const snapGuide = drag?.snappedTo ?? dropPreview?.snappedTo ?? null
  const videoTrackCount = tracks.filter((track) => track.kind === 'video').length
  const audioTrackCount = tracks.filter((track) => track.kind === 'audio').length

  return (
    <section className="panel timeline-panel">
      <div className="panel-header">
        <h2 className="panel-title">Timeline</h2>
        <span className="timeline-summary">
          {clips.length} clip{clips.length === 1 ? '' : 's'} · {tracks.length} tracks
        </span>
      </div>

      <div className="timeline-toolbar">
        <div className="toolbar-group">
          <button className="btn btn-small" type="button" onClick={() => onAddTrack('video')}>
            + Video track
          </button>
          <button className="btn btn-small" type="button" onClick={() => onAddTrack('audio')}>
            + Audio track
          </button>
        </div>

        <span className="toolbar-divider" aria-hidden />

        <div className="toolbar-group">
          <button
            className={`btn btn-small${cropping ? ' is-active' : ''}`}
            type="button"
            onClick={onToggleCrop}
            disabled={!canCrop}
            title={canCrop ? 'Crop the selected clip' : 'Select a video or image clip to crop'}
          >
            Crop
          </button>
          <button className="btn btn-small" type="button" onClick={onAddText} title="Put a line of text on screen at the playhead">
            + Text
          </button>
          <button
            className="btn btn-small"
            type="button"
            onClick={() => selectedClipId && onDeleteClip(selectedClipId)}
            disabled={!selectedClipId}
          >
            Delete clip
          </button>
        </div>

        <label className="zoom-control" title="Scroll over the timeline to zoom">
          Zoom
          <input
            type="range"
            min={MIN_ZOOM}
            max={MAX_ZOOM}
            step={1}
            value={Math.round(zoom)}
            onChange={(e) => onZoomChange(clampZoom(Number(e.target.value)))}
          />
          <span className="zoom-readout">{Math.round(zoom)} px/s</span>
        </label>
      </div>

      <div
        className="timeline-body"
        style={{ gridTemplateColumns: `${gutterWidth}px 8px minmax(0, 1fr)` }}
      >
        <div className="track-gutter">
          <div className="gutter-spacer" style={{ height: RULER_HEIGHT }} />
          <div className="gutter-text-label" style={{ height: TEXT_LANE_HEIGHT }}>
            Text
          </div>
          {tracks.map((track) => (
            <TrackHead
              key={track.id}
              track={track}
              height={LANE_HEIGHT}
              canRemove={track.kind === 'video' ? videoTrackCount > 1 : audioTrackCount > 1}
              onRename={(name) => onRenameTrack(track.id, name)}
              onRemove={() => onRemoveTrack(track.id)}
            />
          ))}
        </div>

        <Splitter
          orientation="vertical"
          label="Resize track names"
          onStart={() => {
            gutterStartRef.current = gutterWidth
          }}
          onMove={(delta) => onGutterWidthChange(gutterStartRef.current + delta)}
          onNudge={(delta) => onGutterWidthChange(gutterWidth + delta)}
        />

        <div
          className={`timeline-scroll${panning ? ' is-panning' : ''}`}
          ref={scrollRef}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node)) setDropPreview(null)
          }}
        >
          <div
            className="timeline-canvas"
            ref={canvasRef}
            style={{ width }}
            onPointerDown={beginPan}
          >
            <div className="ruler" style={{ height: RULER_HEIGHT }} onPointerDown={beginScrub}>
              {ticks.map((tick) => (
                <div
                  key={tick.time}
                  className={`ruler-tick${tick.isLabelled ? '' : ' is-minor'}`}
                  style={{ left: tick.time * zoom }}
                >
                  {tick.isLabelled && <span>{formatTime(tick.time).slice(0, 5)}</span>}
                </div>
              ))}
            </div>

            <TextLane
              overlays={overlays}
              zoom={zoom}
              height={TEXT_LANE_HEIGHT}
              onSeek={onSeek}
              onEdit={onEditText}
              onRemove={onRemoveText}
            />

            <div className="lanes" ref={lanesRef}>
              {tracks.map((track) => {
                const droppable = dragMedia !== null && trackAccepts(tracks, track.id, dragMedia.kind)

                return (
                  <div
                    key={track.id}
                    className={`track-lane${droppable ? ' is-droppable' : ''}${
                      dropPreview?.track === track.id ? ' is-dropping' : ''
                    }`}
                    style={{ height: LANE_HEIGHT }}
                    onDragOver={(event) => handleLaneDragOver(event, track.id)}
                    onDrop={(event) => handleLaneDrop(event, track.id)}
                  >
                    {clips
                      .filter((clip) =>
                        drag?.clipId === clip.id ? drag.track === track.id : clip.track === track.id,
                      )
                      .map((clip) => {
                        const isDragging = drag?.clipId === clip.id
                        const start = isDragging ? drag.start : clip.start

                        return (
                          <div
                            key={clip.id}
                            className={`clip${isDragging ? ' is-dragging' : ''}${
                              selectedClipId === clip.id ? ' is-selected' : ''
                            }`}
                            style={{
                              left: start * zoom,
                              width: Math.max(clip.duration * zoom, 26),
                              // Only the colour, so the sheen in the stylesheet survives.
                              backgroundColor: clip.color,
                            }}
                            title={`${clip.name} · ${formatTime(clip.duration)}`}
                            onPointerDown={(event) => beginClipDrag(event, clip)}
                          >
                            <span className="clip-name">{clip.name}</span>
                            <span className="clip-footer">
                              <span className="clip-duration">{formatTime(clip.duration)}</span>
                              {isCropped(clip.crop) && <span className="clip-badge">crop</span>}
                              {clip.frame && (
                                <span className="clip-badge" title={describeFrame(clip.frame)}>
                                  inset
                                </span>
                              )}
                            </span>
                          </div>
                        )
                      })}

                    {dropPreview?.track === track.id && (
                      <div
                        className="clip-ghost"
                        style={{
                          left: dropPreview.start * zoom,
                          width: Math.max(dropPreview.duration * zoom, 26),
                        }}
                      >
                        <span>{dragMedia?.name}</span>
                      </div>
                    )}
                  </div>
                )
              })}

              {snapGuide !== null && (
                <div className="snap-guide" style={{ left: snapGuide * zoom }} />
              )}
            </div>

            <div className="playhead" style={{ left: playhead * zoom }}>
              <div className="playhead-head" />
              <div className="playhead-line" />
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
