/**
 * A saved piece of work. Until now the editor held one unnamed project that
 * existed only while the app was open; this is the document that survives a
 * restart and gives the dashboard something to list.
 *
 * What a project is *for* is part of it. A short and a mini-movie want
 * different shapes, lengths and tracks, and asking once at the start beats
 * making someone reframe everything at the end.
 */
import type { MediaItem, TextOverlay, TimelineClip, Track } from './types'

export type ProjectKind = 'short' | 'video' | 'movie'

export const PROJECT_KINDS: ProjectKind[] = ['short', 'video', 'movie']

export type KindPreset = {
  label: string
  /** One line on the card, describing what it is for rather than its settings. */
  blurb: string
  /** Passed to the export planner, which knows these as words. */
  resolution: string
  aspect: string
  vertical: boolean
  /** What the assistant aims for when nobody says otherwise. Null means no view. */
  targetSeconds: number | null
  tracks: Track[]
  /** Pixels per second, so a short opens tight and a movie opens wide. */
  zoom: number
}

function lanes(video: number, audio: number): Track[] {
  const tracks: Track[] = []

  for (let at = video; at >= 1; at -= 1) {
    tracks.push({ id: `video-${at}`, name: video === 1 ? 'Video track' : `Video ${at}`, kind: 'video' })
  }
  for (let at = 1; at <= audio; at += 1) {
    tracks.push({ id: `audio-${at}`, name: audio === 1 ? 'Audio track' : `Audio ${at}`, kind: 'audio' })
  }

  return tracks
}

export const KIND_PRESETS: Record<ProjectKind, KindPreset> = {
  short: {
    label: 'Short',
    blurb: 'Vertical and under a minute. Shorts, TikToks, Reels and edits.',
    resolution: 'vertical',
    aspect: '9:16',
    vertical: true,
    targetSeconds: 30,
    // A second video lane, because a short is usually footage with a meme or a
    // reaction sitting over it.
    tracks: lanes(2, 1),
    zoom: 48,
  },
  video: {
    label: 'Full video',
    blurb: 'A normal upload: several clips, music under it, text on top.',
    resolution: '1080p',
    aspect: '16:9',
    vertical: false,
    targetSeconds: null,
    tracks: lanes(2, 2),
    zoom: 12,
  },
  movie: {
    label: 'Mini-movie',
    blurb: 'Something longer with scenes, score and room to layer.',
    resolution: '1080p',
    aspect: '16:9',
    vertical: false,
    targetSeconds: null,
    tracks: lanes(3, 2),
    zoom: 6,
  },
}

export function presetFor(kind: ProjectKind): KindPreset {
  return KIND_PRESETS[kind] ?? KIND_PRESETS.video
}

export function readProjectKind(value: unknown): ProjectKind | null {
  if (typeof value !== 'string') return null
  const word = value.trim().toLowerCase()

  if (PROJECT_KINDS.includes(word as ProjectKind)) return word as ProjectKind
  if (/short|vertical|tiktok|reel|aura/.test(word)) return 'short'
  if (/movie|film|cinematic/.test(word)) return 'movie'
  // "Edit" was once a landscape kind of its own. Anything saved under it stays
  // landscape rather than being flipped upright by a rename.
  if (/full|long|upload|edit|clip/.test(word)) return 'video'

  return null
}

/**
 * What lives in the file. Media keeps its path but not its url: a blob or a
 * custom-protocol address means nothing on the next run, and is rebuilt from
 * the path when the project opens.
 */
export type ProjectDocument = {
  version: 1
  id: string
  name: string
  kind: ProjectKind
  created: number
  modified: number
  media: MediaItem[]
  clips: TimelineClip[]
  tracks: Track[]
  overlays: TextOverlay[]
  zoom: number
  playhead: number
}

/** Enough to draw a card without opening the whole thing. */
export type ProjectSummary = {
  id: string
  name: string
  kind: ProjectKind
  created: number
  modified: number
  clips: number
  duration: number
}

const NAME_LIMIT = 60

export function cleanProjectName(name: string, fallback = 'Untitled'): string {
  const cleaned = name
    .replace(/[\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, NAME_LIMIT)
    .trim()

  return cleaned || fallback
}

/** Ids end up as file names, so they hold nothing a file system would object to. */
export function newProjectId(now = Date.now(), random = Math.random): string {
  const stamp = now.toString(36)
  const tail = Math.floor(random() * 0xffffff)
    .toString(36)
    .padStart(4, '0')
  return `p${stamp}${tail}`
}

export function isProjectId(value: string): boolean {
  return /^p[a-z0-9]{4,32}$/.test(value)
}

export function createProject(
  name: string,
  kind: ProjectKind,
  now = Date.now(),
  id = newProjectId(now),
): ProjectDocument {
  const preset = presetFor(kind)

  return {
    version: 1,
    id,
    name: cleanProjectName(name, preset.label),
    kind,
    created: now,
    modified: now,
    media: [],
    clips: [],
    tracks: preset.tracks,
    overlays: [],
    zoom: preset.zoom,
    playhead: 0,
  }
}

export function projectEnd(clips: TimelineClip[]): number {
  return clips.reduce((last, clip) => Math.max(last, clip.start + clip.duration), 0)
}

export function summarize(project: ProjectDocument): ProjectSummary {
  return {
    id: project.id,
    name: project.name,
    kind: project.kind,
    created: project.created,
    modified: project.modified,
    clips: project.clips.length,
    duration: projectEnd(project.clips),
  }
}

/**
 * Reads a project back off disk. A file written by a newer build, hand-edited,
 * or half-written by a crash should cost one project rather than the dashboard,
 * so anything unreadable yields null and everything else is repaired towards
 * something openable.
 */
export function readProject(value: unknown): ProjectDocument | null {
  if (!value || typeof value !== 'object') return null

  const raw = value as Record<string, unknown>
  const id = typeof raw.id === 'string' ? raw.id : ''
  if (!isProjectId(id)) return null

  const kind = readProjectKind(raw.kind) ?? 'video'
  const preset = presetFor(kind)
  const created = time(raw.created)
  const tracks = list<Track>(raw.tracks).filter(
    (track) => typeof track?.id === 'string' && (track.kind === 'video' || track.kind === 'audio'),
  )

  return {
    version: 1,
    id,
    name: cleanProjectName(typeof raw.name === 'string' ? raw.name : '', preset.label),
    kind,
    created,
    modified: time(raw.modified, created),
    media: list<MediaItem>(raw.media).filter((item) => typeof item?.id === 'string'),
    clips: list<TimelineClip>(raw.clips).filter((clip) => typeof clip?.id === 'string'),
    // A project with no lanes cannot be edited, so the preset stands in.
    tracks: tracks.length > 0 ? tracks : preset.tracks,
    overlays: list<TextOverlay>(raw.overlays).filter((text) => typeof text?.id === 'string'),
    zoom: positive(raw.zoom, preset.zoom),
    playhead: Math.max(0, positive(raw.playhead, 0)),
  }
}

function list<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : []
}

function time(value: unknown, fallback = Date.now()): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

function positive(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback
}

/** Newest work first, which is nearly always what you came back for. */
export function byRecent(projects: ProjectSummary[]): ProjectSummary[] {
  return [...projects].sort((a, b) => b.modified - a.modified)
}

/** "Copy", then "Copy 2", rather than two projects with one name. */
export function copyName(name: string, taken: string[]): string {
  const used = new Set(taken.map((entry) => entry.toLowerCase()))
  const base = cleanProjectName(name).replace(/ copy( \d+)?$/i, '')

  for (let at = 1; at < 100; at += 1) {
    const candidate = cleanProjectName(at === 1 ? `${base} copy` : `${base} copy ${at}`)
    if (!used.has(candidate.toLowerCase())) return candidate
  }

  return cleanProjectName(`${base} copy ${Date.now().toString(36)}`)
}

/** How long ago, in the words someone would actually use. */
export function whenText(at: number, now = Date.now()): string {
  const seconds = Math.max(0, (now - at) / 1000)

  if (seconds < 90) return 'just now'
  const minutes = seconds / 60
  if (minutes < 60) return `${Math.round(minutes)} minutes ago`

  const hours = minutes / 60
  if (hours < 24) return `${Math.round(hours)} hour${Math.round(hours) === 1 ? '' : 's'} ago`

  const days = hours / 24
  if (days < 7) return `${Math.round(days)} day${Math.round(days) === 1 ? '' : 's'} ago`

  return new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}
