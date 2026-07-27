import type { TimelineClip } from './types'
import { clipOffset } from './types'

/**
 * Mapping between timeline time and time inside a clip's source file. A clip may
 * start part way into its file, so the two are not the same once anything has
 * been trimmed from the head.
 */

export function clipEnd(clip: TimelineClip): number {
  return clip.start + clip.duration
}

/** Where in the file the playhead points, for the clip being previewed. */
export function sourceTimeFor(clip: TimelineClip | null, playhead: number): number {
  if (!clip) return Math.max(0, playhead)

  const offset = clipOffset(clip)
  const into = playhead - clip.start
  return Math.min(offset + clip.duration, Math.max(offset, offset + into))
}

/** The reverse: where a position in the file lands on the timeline. */
export function timelineTimeFor(clip: TimelineClip | null, sourceTime: number): number {
  if (!clip) return Math.max(0, sourceTime)
  return Math.max(0, clip.start + (sourceTime - clipOffset(clip)))
}

export function withinClip(clip: TimelineClip | null, playhead: number): boolean {
  if (!clip) return true
  return playhead >= clip.start - 0.001 && playhead <= clipEnd(clip) + 0.001
}

/** Region of the file a clip shows, which is what a scrubber should span. */
export function sourceRangeOf(clip: TimelineClip | null, fallbackDuration: number): {
  from: number
  to: number
} {
  if (!clip) return { from: 0, to: Math.max(fallbackDuration, 0.1) }
  const offset = clipOffset(clip)
  return { from: offset, to: offset + clip.duration }
}
