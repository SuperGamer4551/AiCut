import type { RefObject } from 'react'
import { useEffect, useMemo, useRef } from 'react'
import type { Crop, MediaItem, TextOverlay, TimelineClip } from '../lib/types'
import { formatTime } from '../lib/types'
import { FULL_CROP, croppedMediaStyle, isCropped } from '../lib/crop'
import { TEXT_STYLES, displayText, overlaysAt } from '../lib/overlay'
import { sourceRangeOf, sourceTimeFor, timelineTimeFor } from '../lib/playback'
import { CropBar, CropOverlay } from './CropEditor'
import './Preview.css'

type Props = {
  media: MediaItem | null
  clip: TimelineClip | null
  overlays: TextOverlay[]
  cropping: boolean
  playhead: number
  playing: boolean
  onTime: (time: number) => void
  onEnded: () => void
  onPlayingChange: (playing: boolean) => void
  onImport: () => void
  onCropChange: (crop: Crop) => void
  onCropDone: () => void
}

const SEEK_EPSILON = 0.3

export function Preview({
  media,
  clip,
  overlays,
  cropping,
  playhead,
  playing,
  onTime,
  onEnded,
  onPlayingChange,
  onImport,
  onCropChange,
  onCropDone,
}: Props) {
  const mediaRef = useRef<HTMLVideoElement | HTMLAudioElement | null>(null)
  const lastReportedTime = useRef(0)
  const isAv = media !== null && media.kind !== 'image'

  useEffect(() => {
    const el = mediaRef.current
    if (!el || !isAv) return

    if (playing) {
      void el.play().catch(() => onPlayingChange(false))
    } else {
      el.pause()
    }
  }, [playing, isAv, media?.url, onPlayingChange])

  // Only push external seeks (timeline clicks, clip switches) into the element,
  // converted into the clip's own source time.
  useEffect(() => {
    const el = mediaRef.current
    if (!el || !isAv) return
    if (Math.abs(playhead - lastReportedTime.current) < SEEK_EPSILON) return

    const wanted = sourceTimeFor(clip, playhead)
    if (Math.abs(el.currentTime - wanted) < SEEK_EPSILON) return

    el.currentTime = wanted
    lastReportedTime.current = playhead
  }, [playhead, isAv, clip])

  function handleTimeUpdate() {
    const el = mediaRef.current
    if (!el) return

    const timeline = timelineTimeFor(clip, el.currentTime)
    lastReportedTime.current = timeline
    onTime(timeline)

    // Playback stops at the clip's out point rather than running into the rest
    // of the file.
    if (clip && el.currentTime >= sourceRangeOf(clip, media?.duration ?? 0).to - 0.05) {
      el.pause()
      onEnded()
    }
  }

  const crop = clip?.crop
  // While cropping, the media stays unscaled so the handles line up with it.
  const mediaStyle = cropping ? undefined : croppedMediaStyle(crop)
  const aspectRatio =
    media?.width && media.height ? `${media.width} / ${media.height}` : '16 / 9'

  // Only the text covering this moment is drawn, exactly as the render will.
  const visibleText = useMemo(() => overlaysAt(overlays, playhead), [overlays, playhead])
  const inset = clip?.frame

  const status = media
    ? [
        media.width && media.height ? `${media.width}×${media.height}` : null,
        isCropped(crop) ? 'cropped' : null,
        clip?.muted ? 'muted' : null,
        playing ? 'Playing' : 'Paused',
      ]
        .filter(Boolean)
        .join(' · ')
    : 'No media'

  return (
    <section className="panel preview-panel">
      <div className="panel-header">
        <h2 className="panel-title">Preview</h2>
        <span className="preview-status">
          {clip ? `${clip.name} · ${status}` : status}
        </span>
      </div>

      <div className="preview-stage">
        <div className="preview-frame">
          <div className="preview-glow" aria-hidden />

          {media === null && (
            <div className="preview-content">
              <div className="preview-label">Empty project</div>
              <div className="preview-title">Import media to get started</div>
              <button className="btn btn-primary" type="button" onClick={onImport}>
                Import from this device
              </button>
            </div>
          )}

          {media !== null && media.kind !== 'audio' && (
            <div
              className={`preview-media-wrap${inset ? ' is-inset' : ''}`}
              style={
                inset
                  ? {
                      aspectRatio,
                      left: `${inset.x * 100}%`,
                      top: `${inset.y * 100}%`,
                      width: `${inset.width * 100}%`,
                      maxHeight: `${inset.height * 100}%`,
                    }
                  : { aspectRatio }
              }
            >
              {media.kind === 'image' ? (
                <img className="preview-media" src={media.url} alt={media.name} style={mediaStyle} />
              ) : (
                <video
                  key={media.url}
                  ref={mediaRef as RefObject<HTMLVideoElement>}
                  className="preview-media"
                  src={media.url}
                  style={mediaStyle}
                  muted={clip?.muted ?? false}
                  onTimeUpdate={handleTimeUpdate}
                  onEnded={onEnded}
                  onPlay={() => onPlayingChange(true)}
                  onPause={() => onPlayingChange(false)}
                />
              )}

              {cropping && clip && <CropOverlay crop={crop ?? FULL_CROP} onChange={onCropChange} />}
            </div>
          )}

          {cropping && clip && media !== null && media.kind !== 'audio' && (
            <CropBar
              crop={crop ?? FULL_CROP}
              mediaWidth={media.width}
              mediaHeight={media.height}
              onChange={onCropChange}
              onDone={onCropDone}
            />
          )}

          {media?.kind === 'audio' && (
            <div className="preview-content">
              <div className="preview-label">Audio</div>
              <div className="preview-title">{media.name}</div>
              <div className="preview-time">{formatTime(playhead)}</div>
              <audio
                key={media.url}
                ref={mediaRef as RefObject<HTMLAudioElement>}
                src={media.url}
                muted={clip?.muted ?? false}
                onTimeUpdate={handleTimeUpdate}
                onEnded={onEnded}
                onPlay={() => onPlayingChange(true)}
                onPause={() => onPlayingChange(false)}
              />
            </div>
          )}

          {visibleText.length > 0 && !cropping && (
            <div className="preview-text-layer" aria-hidden>
              {visibleText.map((overlay) => (
                <div
                  key={overlay.id}
                  className={`preview-text is-${overlay.position} is-${overlay.style}`}
                  style={{ fontSize: `${TEXT_STYLES[overlay.style].size * 100}cqh` }}
                >
                  <span>{displayText(overlay)}</span>
                </div>
              ))}
            </div>
          )}

          {media?.error && <div className="preview-error">{media.error}</div>}
        </div>
      </div>

      <div className="preview-scrub">
        <input
          type="range"
          min={clip ? clip.start : 0}
          max={clip ? clip.start + clip.duration : Math.max(media?.duration ?? 30, 0.1)}
          step={0.05}
          value={Math.min(playhead, clip ? clip.start + clip.duration : (media?.duration ?? 30))}
          disabled={!media || media.loading}
          onChange={(e) => onTime(Number(e.target.value))}
          aria-label="Scrub preview"
        />
      </div>
    </section>
  )
}
