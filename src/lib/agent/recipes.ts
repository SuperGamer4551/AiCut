import type { Crop, Frame, TextOverlay, TextPosition, TextStyle, TimelineClip } from '../types'
import { CLIP_COLORS, clipOffset, stripExtension } from '../types'
import { cropForAspect } from '../crop'
import {
  DEFAULT_TEXT_SECONDS,
  MIN_TEXT_SECONDS,
  TEXT_STYLES,
  cleanText,
  tightenCrop,
} from '../overlay'
import { placeClip } from '../timeline'
import type { ProjectState } from './types'

/**
 * Editing operations that go beyond a single field: taking part of a source,
 * splitting, dropping dead air, and reframing. Pure, so the recipes the
 * assistant runs can be asserted directly.
 */

export const MIN_CLIP_DURATION = 0.2

/** Longest a clip could run from its in-point, given its source. */
export function sourceLimit(state: ProjectState, clip: TimelineClip): number {
  const source = state.media.find((item) => item.id === clip.mediaId)
  // A still has no length of its own, so only the timeline constrains it.
  if (!source || source.kind === 'image' || source.duration <= 0) return Number.POSITIVE_INFINITY
  return Math.max(0, source.duration - clipOffset(clip))
}

export type Range = { start: number; end: number }

function newId(): string {
  const source = globalThis.crypto
  if (source && typeof source.randomUUID === 'function') return source.randomUUID()
  return `id-${Math.random().toString(36).slice(2, 10)}`
}

function clipsWithout(state: ProjectState, clipId: string): TimelineClip[] {
  return state.clips.filter((clip) => clip.id !== clipId)
}

function replace(state: ProjectState, clip: TimelineClip, patch: Partial<TimelineClip>): ProjectState {
  return {
    ...state,
    clips: state.clips.map((entry) => (entry.id === clip.id ? { ...entry, ...patch } : entry)),
    selectedClipId: clip.id,
  }
}

/**
 * Use only part of the source file. Times are seconds into the file, not
 * positions on the timeline.
 */
export function useSourceRange(
  state: ProjectState,
  clip: TimelineClip,
  from: number,
  to: number,
): { state: ProjectState; from: number; to: number } | { error: string } {
  const source = state.media.find((item) => item.id === clip.mediaId)
  const available = source && source.kind !== 'image' && source.duration > 0 ? source.duration : Number.POSITIVE_INFINITY

  const start = Math.max(0, Math.min(from, to))
  const end = Math.min(Math.max(from, to), available)

  if (end - start < MIN_CLIP_DURATION) {
    return { error: `That leaves less than ${MIN_CLIP_DURATION}s of ${clip.name}.` }
  }

  return {
    state: replace(state, clip, { offset: start, duration: end - start }),
    from: start,
    to: end,
  }
}

/** Cut a clip in two at a position on the timeline. */
export function splitAt(
  state: ProjectState,
  clip: TimelineClip,
  timelineTime: number,
): { state: ProjectState; at: number } | { error: string } {
  const into = timelineTime - clip.start

  if (into < MIN_CLIP_DURATION || clip.duration - into < MIN_CLIP_DURATION) {
    return { error: `${clip.name} is too short to split there; both halves need ${MIN_CLIP_DURATION}s.` }
  }

  const offset = clipOffset(clip)
  const tail: TimelineClip = {
    ...clip,
    id: newId(),
    start: clip.start + into,
    duration: clip.duration - into,
    offset: offset + into,
  }

  return {
    state: {
      ...state,
      clips: [
        ...state.clips.map((entry) => (entry.id === clip.id ? { ...entry, duration: into } : entry)),
        tail,
      ],
      selectedClipId: tail.id,
    },
    at: timelineTime,
  }
}

/**
 * Replace a clip with one clip per kept range, laid end to end so the gaps
 * close up. Ranges are seconds into the source file.
 */
export function keepSourceRanges(
  state: ProjectState,
  clip: TimelineClip,
  ranges: Range[],
): { state: ProjectState; kept: Range[]; removed: number } | { error: string } {
  const offset = clipOffset(clip)
  const visible: Range = { start: offset, end: offset + clip.duration }

  const kept = ranges
    .map((range) => ({
      start: Math.max(range.start, visible.start),
      end: Math.min(range.end, visible.end),
    }))
    .filter((range) => range.end - range.start >= MIN_CLIP_DURATION)
    .sort((a, b) => a.start - b.start)

  if (kept.length === 0) return { error: `Nothing worth keeping was found in ${clip.name}.` }

  const total = kept.reduce((sum, range) => sum + (range.end - range.start), 0)
  if (Math.abs(total - clip.duration) < 0.05) {
    return { error: `${clip.name} has no dead air to cut.` }
  }

  const pieces: TimelineClip[] = []
  let cursor = clip.start

  for (const range of kept) {
    pieces.push({
      ...clip,
      id: pieces.length === 0 ? clip.id : newId(),
      start: cursor,
      duration: range.end - range.start,
      offset: range.start,
    })
    cursor += range.end - range.start
  }

  // Anything that used to sit after the clip shifts back by what was removed.
  const shift = clip.duration - total
  const after = clipsWithout(state, clip.id).map((entry) =>
    entry.track === clip.track && entry.start >= clip.start + clip.duration - 0.001
      ? { ...entry, start: Math.max(0, entry.start - shift) }
      : entry,
  )

  return {
    state: { ...state, clips: [...after, ...pieces], selectedClipId: pieces[0].id },
    kept,
    removed: shift,
  }
}

/** Reframe a clip to an aspect ratio, keeping the middle of the picture. */
export function cropToAspect(
  state: ProjectState,
  clip: TimelineClip,
  ratio: number,
): { state: ProjectState; crop: Crop } {
  const source = state.media.find((item) => item.id === clip.mediaId)
  const crop = cropForAspect(ratio, source?.width ?? 16, source?.height ?? 9)
  return { state: replace(state, clip, { crop }), crop }
}

/** Put a clip at a position, sliding it to the nearest free slot as usual. */
export function moveClipTo(
  state: ProjectState,
  clip: TimelineClip,
  desiredStart: number,
): { state: ProjectState; start: number } {
  const { start } = placeClip({
    clips: state.clips,
    track: clip.track,
    excludeId: clip.id,
    desiredStart,
    duration: clip.duration,
    zoom: state.zoom,
    playhead: state.playhead,
  })

  return { state: replace(state, clip, { start }), start }
}

/** Put a clip in a corner of the frame, or back to filling it. */
export function frameClip(
  state: ProjectState,
  clip: TimelineClip,
  frame: Frame | undefined,
): { state: ProjectState } {
  return { state: replace(state, clip, { frame }) }
}

/**
 * Cut a window out of a clip and push the picture in on it, which is how a
 * moment gets emphasis without a zoom animation.
 */
export function punchIn(
  state: ProjectState,
  clip: TimelineClip,
  at: number,
  duration: number,
  amount: number,
): { state: ProjectState; from: number; to: number; amount: number } | { error: string } {
  // A moment near the end still gets a full punch-in; the window slides back
  // rather than being squeezed against the tail.
  const end = clip.start + clip.duration
  const length = Math.min(Math.max(MIN_CLIP_DURATION, duration), clip.duration)
  const from = Math.max(clip.start, Math.min(at, end - length))
  const to = Math.min(from + length, end)

  if (to - from < MIN_CLIP_DURATION) {
    return { error: `${clip.name} is too short to punch in on there.` }
  }

  let current = state
  let target = clip

  // A punch-in on the head or tail of a clip only needs the one cut.
  if (from - clip.start >= MIN_CLIP_DURATION) {
    const head = splitAt(current, target, from)
    if ('error' in head) return head
    current = head.state
    target = current.clips.find((entry) => entry.id === current.selectedClipId) ?? target
  }

  if (target.start + target.duration - to >= MIN_CLIP_DURATION) {
    const tail = splitAt(current, target, to)
    if ('error' in tail) return tail
    // The middle piece keeps the original id; the tail is the new one.
    current = tail.state
    target = current.clips.find((entry) => entry.id === target.id) ?? target
  }

  const tightened = tightenCrop(target.crop, amount)
  return {
    state: replace(current, target, { crop: tightened }),
    from,
    to,
    amount: target.crop ? target.crop.width / tightened.width : 1 / tightened.width,
  }
}

function newOverlayId(): string {
  return `t-${newId()}`
}

/** Add a line of text over the picture. */
export function addOverlay(
  state: ProjectState,
  input: { text: string; start: number; duration?: number; position?: TextPosition; style?: TextStyle },
): { state: ProjectState; overlay: TextOverlay } | { error: string } {
  const text = cleanText(input.text)
  if (!text) return { error: 'Tell me what the text should say.' }

  const style = input.style ?? 'title'
  const overlay: TextOverlay = {
    id: newOverlayId(),
    text,
    start: Math.max(0, input.start),
    duration: Math.max(MIN_TEXT_SECONDS, input.duration ?? DEFAULT_TEXT_SECONDS),
    position: input.position ?? TEXT_STYLES[style].position,
    style,
  }

  return { state: { ...state, overlays: [...state.overlays, overlay] }, overlay }
}

/** Drop text by id, by what it says, or all of it. */
export function removeOverlays(
  state: ProjectState,
  query: string,
): { state: ProjectState; removed: TextOverlay[] } {
  const raw = query.trim().toLowerCase()
  const all = raw === '' || raw === 'all' || raw === 'every' || raw === 'everything'

  const removed = all
    ? state.overlays
    : state.overlays.filter(
        (overlay) =>
          overlay.id.toLowerCase() === raw ||
          overlay.text.toLowerCase() === raw ||
          overlay.text.toLowerCase().includes(raw) ||
          (raw === 'last' && overlay.id === state.overlays[state.overlays.length - 1]?.id),
      )

  return {
    state: { ...state, overlays: state.overlays.filter((overlay) => !removed.includes(overlay)) },
    removed,
  }
}

/** Place a media item on a track as a new clip, used when a recipe needs one. */
export function addClipFor(
  state: ProjectState,
  mediaId: string,
  trackId: string,
  desiredStart: number,
  options: { duration?: number; frame?: Frame } = {},
): { state: ProjectState; clip: TimelineClip } | { error: string } {
  const item = state.media.find((entry) => entry.id === mediaId)
  if (!item) return { error: 'That media is not in the library.' }

  const natural = Math.max(item.duration, 1)
  const duration = options.duration
    ? // A still can run as long as asked; anything else is capped by its own length.
      item.kind === 'image'
      ? Math.max(MIN_CLIP_DURATION, options.duration)
      : Math.min(natural, Math.max(MIN_CLIP_DURATION, options.duration))
    : natural

  const { start } = placeClip({
    clips: state.clips,
    track: trackId,
    excludeId: null,
    desiredStart,
    duration,
    zoom: state.zoom,
    playhead: state.playhead,
  })

  const clip: TimelineClip = {
    id: newId(),
    mediaId: item.id,
    name: stripExtension(item.name),
    kind: item.kind,
    track: trackId,
    start,
    duration,
    color: CLIP_COLORS[item.kind],
    ...(options.frame ? { frame: options.frame } : {}),
  }

  return { state: { ...state, clips: [...state.clips, clip], selectedClipId: clip.id }, clip }
}
