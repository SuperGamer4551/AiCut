import type { MediaKind, TimelineClip, Track, TrackKind } from './types'

export const MEDIA_DRAG_TYPE = 'application/x-aicut-media'

/** How close (in pixels, so it stays consistent at any zoom) an edge must be to snap. */
export const SNAP_THRESHOLD_PX = 12

export const LANE_HEIGHT = 76

export const RULER_HEIGHT = 32

/** The strip above the tracks that holds on-screen text. */
export const TEXT_LANE_HEIGHT = 30

/** Pixels per second, so zoom is meaningful independent of sequence length. */
export const MIN_ZOOM = 4
export const MAX_ZOOM = 120

/** Smallest gap allowed between ruler labels, which is what stops them colliding. */
export const RULER_LABEL_MIN_PX = 64

const MINOR_TICK_MIN_PX = 8

const NICE_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600]

const EPSILON = 1e-4

export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return MIN_ZOOM
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom))
}

/**
 * Ruler spacing for a zoom level: labels land on round intervals far enough
 * apart to stay legible, with optional unlabelled ticks in between.
 */
export function rulerSteps(zoom: number): { labelStep: number; minorStep: number } {
  const safeZoom = clampZoom(zoom)
  const labelStep =
    NICE_STEPS.find((step) => step * safeZoom >= RULER_LABEL_MIN_PX) ??
    NICE_STEPS[NICE_STEPS.length - 1]

  const minorStep =
    [labelStep / 5, labelStep / 2].find((step) => step * safeZoom >= MINOR_TICK_MIN_PX) ?? 0

  return { labelStep, minorStep }
}

export const INITIAL_TRACKS: Track[] = [
  { id: 'video-1', name: 'Video track', kind: 'video' },
  { id: 'audio-1', name: 'Audio track', kind: 'audio' },
]

export type Placement = {
  start: number
  /** Time the clip locked onto, used to draw the snap guide. */
  snappedTo: number | null
}

type Interval = { start: number; end: number }

export function trackKindFor(kind: MediaKind): TrackKind {
  return kind === 'audio' ? 'audio' : 'video'
}

export function trackAcceptsKind(track: Track, kind: MediaKind): boolean {
  return track.kind === trackKindFor(kind)
}

export function trackAccepts(tracks: Track[], trackId: string, kind: MediaKind): boolean {
  const track = tracks.find((entry) => entry.id === trackId)
  return track ? trackAcceptsKind(track, kind) : false
}

export function defaultTrackId(tracks: Track[], kind: MediaKind): string | null {
  return tracks.find((track) => trackAcceptsKind(track, kind))?.id ?? null
}

function nextTrackName(tracks: Track[], kind: TrackKind): string {
  const base = kind === 'video' ? 'Video track' : 'Audio track'
  const taken = new Set(tracks.map((track) => track.name))
  if (!taken.has(base)) return base

  let suffix = 2
  while (taken.has(`${base} ${suffix}`)) suffix += 1
  return `${base} ${suffix}`
}

function nextTrackId(tracks: Track[], kind: TrackKind): string {
  let index = tracks.filter((track) => track.kind === kind).length + 1
  const taken = new Set(tracks.map((track) => track.id))
  while (taken.has(`${kind}-${index}`)) index += 1
  return `${kind}-${index}`
}

/** Video tracks stack above audio tracks, the way a sequence is usually laid out. */
export function addTrack(
  tracks: Track[],
  kind: TrackKind,
): { tracks: Track[]; track: Track } {
  const track: Track = {
    id: nextTrackId(tracks, kind),
    name: nextTrackName(tracks, kind),
    kind,
  }

  if (kind === 'audio') return { tracks: [...tracks, track], track }

  const lastVideoIndex = tracks.reduce(
    (index, entry, i) => (entry.kind === 'video' ? i : index),
    -1,
  )
  const next = [...tracks]
  next.splice(lastVideoIndex + 1, 0, track)
  return { tracks: next, track }
}

/**
 * A video track above every other, which is where a meme or a reaction has to
 * live: the top lane is the one that draws over the footage.
 */
export function addTrackAtTop(
  tracks: Track[],
  name?: string,
): { tracks: Track[]; track: Track } {
  const track: Track = {
    id: nextTrackId(tracks, 'video'),
    name: name && !tracks.some((entry) => entry.name === name) ? name : nextTrackName(tracks, 'video'),
    kind: 'video',
  }

  return { tracks: [track, ...tracks], track }
}

function nearly(a: number, b: number): boolean {
  return Math.abs(a - b) < EPSILON
}

/**
 * Edges worth snapping to: the sequence start, the playhead, and every clip
 * boundary. Boundaries from other tracks are included so clips line up
 * vertically the way they do in WeVideo.
 */
export function collectSnapTargets(
  clips: TimelineClip[],
  excludeId: string | null,
  playhead: number,
): number[] {
  const targets = [0, playhead]

  for (const clip of clips) {
    if (clip.id === excludeId) continue
    targets.push(clip.start, clip.start + clip.duration)
  }

  return targets
}

function snapStart(
  desiredStart: number,
  duration: number,
  targets: number[],
  thresholdSec: number,
): Placement {
  let start = desiredStart
  let closest = thresholdSec
  let snappedTo: number | null = null

  for (const target of targets) {
    const startDistance = Math.abs(desiredStart - target)
    if (startDistance <= closest) {
      closest = startDistance
      start = target
      snappedTo = target
    }

    const endDistance = Math.abs(desiredStart + duration - target)
    if (endDistance <= closest) {
      closest = endDistance
      start = target - duration
      snappedTo = target
    }
  }

  if (start < 0) return { start: 0, snappedTo: 0 }
  return { start, snappedTo }
}

function occupiedOn(clips: TimelineClip[], track: string, excludeId: string | null): Interval[] {
  return clips
    .filter((clip) => clip.track === track && clip.id !== excludeId)
    .map((clip) => ({ start: clip.start, end: clip.start + clip.duration }))
    .sort((a, b) => a.start - b.start)
}

/**
 * Clips never overlap: a dropped clip slides to the nearest free slot, which
 * makes it click flush against its neighbours instead of layering on top.
 */
function resolveCollisions(occupied: Interval[], start: number, duration: number): number {
  const overlaps = (candidate: number) =>
    occupied.some(
      (interval) =>
        candidate < interval.end - EPSILON && candidate + duration > interval.start + EPSILON,
    )

  if (!overlaps(start)) return start

  const candidates = [0]
  for (const interval of occupied) {
    candidates.push(interval.end)
    candidates.push(interval.start - duration)
  }

  const free = candidates.filter((candidate) => candidate >= 0 && !overlaps(candidate))
  if (free.length === 0) {
    return occupied.reduce((end, interval) => Math.max(end, interval.end), 0)
  }

  return free.reduce(
    (best, candidate) => (Math.abs(candidate - start) < Math.abs(best - start) ? candidate : best),
    free[0],
  )
}

export function placeClip(args: {
  clips: TimelineClip[]
  track: string
  excludeId: string | null
  desiredStart: number
  duration: number
  zoom: number
  playhead: number
}): Placement {
  const { clips, track, excludeId, desiredStart, duration, zoom, playhead } = args

  const targets = collectSnapTargets(clips, excludeId, playhead)
  const snapped = snapStart(Math.max(0, desiredStart), duration, targets, SNAP_THRESHOLD_PX / zoom)
  const start = resolveCollisions(occupiedOn(clips, track, excludeId), snapped.start, duration)

  // Landing flush against a neighbour counts as a snap even if collision
  // handling, not the threshold, is what put the clip there.
  const snappedTo =
    targets.find((target) => nearly(target, start) || nearly(target, start + duration)) ?? null

  return { start, snappedTo }
}

export function endOfTrack(clips: TimelineClip[], track: string): number {
  return clips
    .filter((clip) => clip.track === track)
    .reduce((end, clip) => Math.max(end, clip.start + clip.duration), 0)
}
