import type { Crop, MediaItem, TimelineClip, Track, TrackKind } from '../types'
import { CLIP_COLORS, formatTime, stripExtension } from '../types'
import { cropForAspect } from '../crop'
import {
  MAX_ZOOM,
  MIN_ZOOM,
  addTrack as addTrackTo,
  clampZoom,
  defaultTrackId,
  endOfTrack,
  placeClip,
  trackAcceptsKind,
  trackKindFor,
} from '../timeline'
import type { ProjectState, ToolCall, ToolOutcome } from './types'
import { addNote, learnedDefaults, removeNotes } from './memory'
import { addOverlay, frameClip, removeOverlays, splitAt, useSourceRange } from './recipes'
import { clipOffset } from '../types'
import {
  PLACEMENT_NAMES,
  TEXT_STYLE_NAMES,
  describeFrame,
  frameForPlacement,
  isTextPosition,
  isTextStyle,
  readPlacement,
} from '../overlay'

const MIN_CLIP_DURATION = 0.2

const ASPECT_RATIOS: Record<string, number> = {
  '16:9': 16 / 9,
  '9:16': 9 / 16,
  '4:3': 4 / 3,
  '3:4': 3 / 4,
  '1:1': 1,
  '4:5': 4 / 5,
  '21:9': 21 / 9,
  square: 1,
  portrait: 9 / 16,
  vertical: 9 / 16,
  landscape: 16 / 9,
  widescreen: 16 / 9,
}

const RESET_WORDS = new Set(['reset', 'none', 'off', 'full', 'clear', 'remove', 'original'])

function newId(): string {
  const source = globalThis.crypto
  if (source && typeof source.randomUUID === 'function') return source.randomUUID()
  return `id-${Math.random().toString(36).slice(2, 10)}`
}

/** Position on the timeline, as minutes and seconds. */
export function clock(seconds: number): string {
  return formatTime(seconds).slice(0, 5)
}

function secs(seconds: number): string {
  return `${Number(seconds.toFixed(2))}s`
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

/** Accepts seconds, "1:30", "01:02:03", "90s", and "1m30s". */
export function parseSeconds(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? Math.max(0, value) : null

  const raw = text(value)
  if (!raw) return null

  if (/^\d+(:\d{1,2}){1,2}(\.\d+)?$/.test(raw)) {
    return raw.split(':').reduce((total, part) => total * 60 + Number(part), 0)
  }

  const compound = /^(?:(\d+(?:\.\d+)?)\s*m(?:in(?:ute)?s?)?)?\s*(?:(\d+(?:\.\d+)?)\s*s(?:ec(?:ond)?s?)?)?$/.exec(raw)
  if (compound && (compound[1] || compound[2])) {
    return Number(compound[1] ?? 0) * 60 + Number(compound[2] ?? 0)
  }

  const plain = Number(raw)
  return Number.isFinite(plain) ? Math.max(0, plain) : null
}

export function findMedia(state: ProjectState, query: unknown): MediaItem | null {
  const items = state.media
  if (items.length === 0) return null

  const asked = text(query)
  if (!asked) return items.length === 1 ? items[0] : null
  if (asked === 'last' || asked === 'latest' || asked === 'newest') return items[items.length - 1]
  if (asked === 'first' || asked === 'oldest') return items[0]

  // A nickname the user taught us takes precedence over fuzzy name matching.
  const alias = learnedDefaults(state.memory).aliases[asked]
  const raw = alias ? alias.toLowerCase() : asked

  const byId = items.find((item) => item.id.toLowerCase() === raw)
  if (byId) return byId

  const byName = items.find(
    (item) => item.name.toLowerCase() === raw || stripExtension(item.name).toLowerCase() === raw,
  )
  if (byName) return byName

  const partial = items.filter((item) => item.name.toLowerCase().includes(raw))
  if (partial.length > 0) return partial[0]

  const kindWords: Record<string, MediaItem['kind']> = {
    video: 'video',
    clip: 'video',
    footage: 'video',
    audio: 'audio',
    music: 'audio',
    song: 'audio',
    sound: 'audio',
    image: 'image',
    picture: 'image',
    photo: 'image',
  }
  const kind = kindWords[raw]
  return kind ? (items.find((item) => item.kind === kind) ?? null) : null
}

export function findClip(state: ProjectState, query: unknown): TimelineClip | null {
  const clips = state.clips
  if (clips.length === 0) return null

  const raw = text(query)
  const selected = clips.find((clip) => clip.id === state.selectedClipId) ?? null

  if (!raw) return selected ?? (clips.length === 1 ? clips[0] : null)
  if (raw === 'selected' || raw === 'current' || raw === 'this' || raw === 'it') {
    return selected ?? (clips.length === 1 ? clips[0] : null)
  }
  if (raw === 'last' || raw === 'latest' || raw === 'newest') return clips[clips.length - 1]
  if (raw === 'first') return clips.reduce((best, clip) => (clip.start < best.start ? clip : best))

  const byId = clips.find((clip) => clip.id.toLowerCase() === raw)
  if (byId) return byId

  const byName = clips.find(
    (clip) => clip.name.toLowerCase() === raw || stripExtension(clip.name).toLowerCase() === raw,
  )
  if (byName) return byName

  const partial = clips.filter((clip) => clip.name.toLowerCase().includes(raw))
  return partial.length > 0 ? partial[0] : null
}

export function findTrack(state: ProjectState, query: unknown, kind?: TrackKind): Track | null {
  const raw = text(query)
  if (!raw) return kind ? (state.tracks.find((track) => track.kind === kind) ?? null) : null

  const byId = state.tracks.find((track) => track.id.toLowerCase() === raw)
  if (byId) return byId

  const byName = state.tracks.find((track) => track.name.toLowerCase() === raw)
  if (byName) return byName

  // "video", "audio 2", "v2", "a1"
  const numbered = /^(video|audio|v|a)\s*(?:track\s*)?(\d+)?$/.exec(raw)
  if (numbered) {
    const wanted: TrackKind = numbered[1].startsWith('a') ? 'audio' : 'video'
    const ofKind = state.tracks.filter((track) => track.kind === wanted)
    const index = numbered[2] ? Number(numbered[2]) - 1 : 0
    return ofKind[index] ?? null
  }

  const partial = state.tracks.filter((track) => track.name.toLowerCase().includes(raw))
  return partial.length > 0 ? partial[0] : null
}

function trackKindWord(value: unknown): TrackKind | null {
  const raw = text(value)
  if (/^(a|audio|sound|music)$/.test(raw)) return 'audio'
  if (/^(v|video|visual)$/.test(raw)) return 'video'
  return null
}

/** Resolves a start time, including the keywords tools accept. */
function resolveStart(
  value: unknown,
  state: ProjectState,
  trackId: string,
  fallback: number,
): number {
  const raw = text(value)
  if (!raw) return fallback
  if (raw === 'end' || raw === 'after' || raw === 'append') return endOfTrack(state.clips, trackId)
  if (raw === 'playhead' || raw === 'now' || raw === 'here' || raw === 'current') return state.playhead
  if (raw === 'start' || raw === 'beginning' || raw === 'zero') return 0

  return parseSeconds(value) ?? fallback
}

function fail(state: ProjectState, message: string): ToolOutcome {
  return { state, summary: message, error: message }
}

function trackNameOf(state: ProjectState, trackId: string): string {
  return state.tracks.find((track) => track.id === trackId)?.name ?? trackId
}

function describe(state: ProjectState): string {
  const lines: string[] = []

  lines.push(
    state.media.length === 0
      ? 'Media library: empty.'
      : `Media library (${state.media.length}): ${state.media
          .map((item) => `${item.name} [${item.kind}, ${secs(item.duration)}${item.loading ? ', loading' : ''}]`)
          .join('; ')}.`,
  )

  lines.push(
    `Tracks (${state.tracks.length}): ${state.tracks
      .map((track) => `${track.name} [${track.kind}]`)
      .join('; ')}.`,
  )

  lines.push(
    state.clips.length === 0
      ? 'Timeline: no clips yet.'
      : `Clips (${state.clips.length}): ${state.clips
          .map((clip) => {
            const offset = clipOffset(clip)
            return `${clip.name} on ${trackNameOf(state, clip.track)} from ${clock(clip.start)} to ${clock(
              clip.start + clip.duration,
            )            }${offset > 0 ? ` (source ${clock(offset)}–${clock(offset + clip.duration)})` : ''}${
              clip.crop ? ', cropped' : ''
            }${clip.frame ? `, inset ${describeFrame(clip.frame)}` : ''}`
          })
          .join('; ')}.`,
  )

  if (state.overlays.length > 0) {
    lines.push(
      `Text (${state.overlays.length}): ${state.overlays
        .map(
          (overlay) =>
            `"${overlay.text}" [${overlay.style}, ${overlay.position}] ${clock(overlay.start)}–${clock(
              overlay.start + overlay.duration,
            )}`,
        )
        .join('; ')}.`,
    )
  }

  const selected = state.clips.find((clip) => clip.id === state.selectedClipId)
  lines.push(
    `Playhead at ${clock(state.playhead)}. Zoom ${Math.round(state.zoom)} px/s. ${
      selected ? `Selected clip: ${selected.name}.` : 'No clip selected.'
    }`,
  )

  if (state.memory.length > 0) {
    lines.push(`Remembered (${state.memory.length}): ${state.memory.map((note) => note.text).join('; ')}.`)
  }

  return lines.join('\n')
}

/** Longest a clip can be without overlapping its neighbour or outrunning its source. */
function maxDurationFor(state: ProjectState, clip: TimelineClip): number {
  const source = state.media.find((item) => item.id === clip.mediaId)
  const nextStart = state.clips
    .filter((other) => other.track === clip.track && other.id !== clip.id && other.start > clip.start)
    .reduce((closest, other) => Math.min(closest, other.start), Number.POSITIVE_INFINITY)

  const roomOnTrack = nextStart - clip.start
  // Images have no intrinsic length, so only the track limits them. Anything
  // trimmed off the head is no longer available either.
  const sourceLimit =
    source && source.kind !== 'image' && source.duration > 0
      ? source.duration - clipOffset(clip)
      : Number.POSITIVE_INFINITY

  return Math.min(roomOnTrack, sourceLimit)
}

export function runTool(state: ProjectState, call: ToolCall): ToolOutcome {
  const { args } = call

  switch (call.name) {
    case 'describe_project':
      return { state, summary: describe(state) }

    case 'import_media':
      return { state, summary: 'Opened the file picker.', effect: 'import' }

    case 'add_clip': {
      const item = findMedia(state, args.media)
      if (!item) {
        return fail(
          state,
          state.media.length === 0
            ? 'Nothing is imported yet, so there is no media to place.'
            : `No imported media matches "${String(args.media ?? '')}".`,
        )
      }
      if (item.loading) return fail(state, `${item.name} is still being read from disk.`)

      const requested = args.track ? findTrack(state, args.track) : null
      if (args.track && !requested) return fail(state, `There is no track called "${String(args.track)}".`)

      const trackId = requested?.id ?? defaultTrackId(state.tracks, item.kind)
      if (!trackId) {
        return fail(state, `Add a ${trackKindFor(item.kind)} track first; there is none to place ${item.name} on.`)
      }

      const track = state.tracks.find((entry) => entry.id === trackId)
      if (track && !trackAcceptsKind(track, item.kind)) {
        return fail(state, `${track.name} is a ${track.kind} track, so ${item.name} cannot go there.`)
      }

      const duration = Math.max(item.duration, 1)
      const desiredStart = resolveStart(args.start, state, trackId, endOfTrack(state.clips, trackId))
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
      }

      const moved = Math.abs(start - desiredStart) > 0.01
      return {
        state: { ...state, clips: [...state.clips, clip], selectedClipId: clip.id },
        summary: `Added ${clip.name} to ${trackNameOf(state, trackId)} at ${clock(start)}${
          moved ? ` (nearest free slot to ${clock(desiredStart)})` : ''
        }.`,
      }
    }

    case 'move_clip': {
      const clip = findClip(state, args.clip)
      if (!clip) return fail(state, `No clip matches "${String(args.clip ?? '')}".`)

      const requested = args.track ? findTrack(state, args.track) : null
      if (args.track && !requested) return fail(state, `There is no track called "${String(args.track)}".`)

      const trackId = requested?.id ?? clip.track
      const track = state.tracks.find((entry) => entry.id === trackId)
      if (track && !trackAcceptsKind(track, clip.kind)) {
        return fail(state, `${track.name} is a ${track.kind} track, so ${clip.name} cannot go there.`)
      }

      const desiredStart = resolveStart(args.start, state, trackId, clip.start)
      const { start } = placeClip({
        clips: state.clips,
        track: trackId,
        excludeId: clip.id,
        desiredStart,
        duration: clip.duration,
        zoom: state.zoom,
        playhead: state.playhead,
      })

      return {
        state: {
          ...state,
          selectedClipId: clip.id,
          clips: state.clips.map((entry) =>
            entry.id === clip.id ? { ...entry, track: trackId, start } : entry,
          ),
        },
        summary: `Moved ${clip.name} to ${clock(start)} on ${trackNameOf(state, trackId)}.`,
      }
    }

    case 'trim_clip': {
      const clip = findClip(state, args.clip)
      if (!clip) return fail(state, `No clip matches "${String(args.clip ?? '')}".`)

      const end = parseSeconds(args.end)
      const asked = parseSeconds(args.duration) ?? (end === null ? null : end - clip.start)
      if (asked === null) return fail(state, 'Give a duration or an end time to trim to.')
      if (asked < MIN_CLIP_DURATION) return fail(state, `A clip has to stay at least ${MIN_CLIP_DURATION}s long.`)

      const limit = maxDurationFor(state, clip)
      const duration = Math.min(asked, limit)
      const clamped = duration < asked - 0.01

      return {
        state: {
          ...state,
          selectedClipId: clip.id,
          clips: state.clips.map((entry) => (entry.id === clip.id ? { ...entry, duration } : entry)),
        },
        summary: `Trimmed ${clip.name} to ${secs(duration)}${
          clamped ? ` (asked for ${secs(asked)}, limited by its source or the next clip)` : ''
        }.`,
      }
    }

    case 'delete_clip': {
      const clip = findClip(state, args.clip)
      if (!clip) return fail(state, `No clip matches "${String(args.clip ?? '')}".`)

      return {
        state: {
          ...state,
          clips: state.clips.filter((entry) => entry.id !== clip.id),
          selectedClipId: state.selectedClipId === clip.id ? null : state.selectedClipId,
        },
        summary: `Deleted ${clip.name} from ${trackNameOf(state, clip.track)}.`,
      }
    }

    case 'crop_clip': {
      const clip = findClip(state, args.clip)
      if (!clip) return fail(state, `No clip matches "${String(args.clip ?? '')}".`)
      if (clip.kind === 'audio') return fail(state, `${clip.name} is audio, so there is nothing to crop.`)

      // A remembered preference stands in when no ratio is given.
      const aspect = text(args.aspect) || (learnedDefaults(state.memory).aspect ?? '')
      const reset = RESET_WORDS.has(aspect)
      const ratio = ASPECT_RATIOS[aspect]

      if (!reset && !ratio) {
        return fail(state, `I can crop to 16:9, 9:16, 1:1, 4:5, 4:3, or reset it, not "${String(args.aspect ?? '')}".`)
      }

      const source = state.media.find((item) => item.id === clip.mediaId)
      const crop: Crop | undefined = reset
        ? undefined
        : cropForAspect(ratio, source?.width ?? 16, source?.height ?? 9)

      return {
        state: {
          ...state,
          selectedClipId: clip.id,
          clips: state.clips.map((entry) => (entry.id === clip.id ? { ...entry, crop } : entry)),
        },
        summary: reset ? `Cleared the crop on ${clip.name}.` : `Cropped ${clip.name} to ${aspect}.`,
      }
    }

    case 'add_track': {
      const kind = trackKindWord(args.kind)
      if (!kind) return fail(state, 'Say whether the new track is for video or audio.')

      const { tracks, track } = addTrackTo(state.tracks, kind)
      const name = typeof args.name === 'string' && args.name.trim() ? args.name.trim() : null

      return {
        state: {
          ...state,
          tracks: name ? tracks.map((entry) => (entry.id === track.id ? { ...entry, name } : entry)) : tracks,
        },
        summary: `Added ${kind} track "${name ?? track.name}".`,
      }
    }

    case 'rename_track': {
      const track = findTrack(state, args.track)
      if (!track) return fail(state, `There is no track called "${String(args.track ?? '')}".`)

      const name = typeof args.name === 'string' ? args.name.trim() : ''
      if (!name) return fail(state, 'Give the track a new name.')

      return {
        state: {
          ...state,
          tracks: state.tracks.map((entry) => (entry.id === track.id ? { ...entry, name } : entry)),
        },
        summary: `Renamed "${track.name}" to "${name}".`,
      }
    }

    case 'remove_track': {
      const track = findTrack(state, args.track)
      if (!track) return fail(state, `There is no track called "${String(args.track ?? '')}".`)

      const sameKind = state.tracks.filter((entry) => entry.kind === track.kind)
      if (sameKind.length < 2) {
        return fail(state, `${track.name} is the only ${track.kind} track, so it has to stay.`)
      }

      const removedClips = state.clips.filter((clip) => clip.track === track.id)
      return {
        state: {
          ...state,
          tracks: state.tracks.filter((entry) => entry.id !== track.id),
          clips: state.clips.filter((clip) => clip.track !== track.id),
          selectedClipId: removedClips.some((clip) => clip.id === state.selectedClipId)
            ? null
            : state.selectedClipId,
        },
        summary: `Removed ${track.name}${
          removedClips.length > 0 ? ` and ${removedClips.length} clip${removedClips.length === 1 ? '' : 's'} on it` : ''
        }.`,
      }
    }

    case 'set_zoom': {
      const raw = text(args.zoom)
      const asked =
        raw === 'in' ? state.zoom * 1.5 : raw === 'out' ? state.zoom / 1.5 : parseSeconds(args.zoom)
      if (asked === null) return fail(state, `I need a zoom level between ${MIN_ZOOM} and ${MAX_ZOOM}, or "in" or "out".`)

      const zoom = clampZoom(asked)
      return { state: { ...state, zoom }, summary: `Set the timeline zoom to ${Math.round(zoom)} px/s.` }
    }

    case 'seek': {
      const raw = text(args.time)
      const time =
        raw === 'end'
          ? state.clips.reduce((end, clip) => Math.max(end, clip.start + clip.duration), 0)
          : raw === 'start' || raw === 'beginning'
            ? 0
            : parseSeconds(args.time)

      if (time === null) return fail(state, `I could not read "${String(args.time ?? '')}" as a time.`)

      return { state: { ...state, playhead: time }, summary: `Moved the playhead to ${clock(time)}.` }
    }

    case 'use_range': {
      const clip = findClip(state, args.clip)
      if (!clip) return fail(state, `No clip matches "${String(args.clip ?? '')}".`)

      const from = parseSeconds(args.from)
      const to = parseSeconds(args.to)
      if (from === null || to === null) {
        return fail(state, 'Give the start and end of the part of the file to use.')
      }

      const result = useSourceRange(state, clip, from, to)
      if ('error' in result) return fail(state, result.error)

      return {
        state: result.state,
        summary: `${clip.name} now plays ${clock(result.from)} to ${clock(result.to)} of its file (${secs(
          result.to - result.from,
        )}).`,
      }
    }

    case 'split_clip': {
      const clip = findClip(state, args.clip)
      if (!clip) return fail(state, `No clip matches "${String(args.clip ?? '')}".`)

      const raw = text(args.at)
      const at =
        !raw || raw === 'playhead' || raw === 'here' || raw === 'now'
          ? state.playhead
          : parseSeconds(args.at)
      if (at === null) return fail(state, `I could not read "${String(args.at ?? '')}" as a time.`)

      const result = splitAt(state, clip, at)
      if ('error' in result) return fail(state, result.error)

      return { state: result.state, summary: `Split ${clip.name} at ${clock(result.at)}.` }
    }

    case 'add_text': {
      const wanted = typeof args.text === 'string' ? args.text : ''

      const styleWord = text(args.style)
      if (styleWord && !isTextStyle(styleWord)) {
        return fail(state, `The looks I have are ${TEXT_STYLE_NAMES.join(', ')}, not "${styleWord}".`)
      }

      const style = isTextStyle(styleWord) ? styleWord : undefined
      const position = isTextPosition(text(args.position)) ? (text(args.position) as 'top' | 'middle' | 'bottom') : undefined

      const rawAt = text(args.at ?? args.start)
      const at =
        !rawAt || rawAt === 'playhead' || rawAt === 'here' || rawAt === 'now'
          ? state.playhead
          : rawAt === 'start' || rawAt === 'beginning'
            ? 0
            : (parseSeconds(args.at ?? args.start) ?? state.playhead)

      const result = addOverlay(state, {
        text: wanted,
        start: at,
        duration: parseSeconds(args.duration) ?? undefined,
        position,
        style,
      })
      if ('error' in result) return fail(state, result.error)

      const { overlay } = result
      return {
        state: result.state,
        summary: `Added ${overlay.style} text "${overlay.text}" at the ${overlay.position} from ${clock(
          overlay.start,
        )} for ${secs(overlay.duration)}.`,
      }
    }

    case 'remove_text': {
      const query = typeof args.text === 'string' ? args.text : typeof args.which === 'string' ? args.which : ''
      if (state.overlays.length === 0) return fail(state, 'There is no text on the video yet.')

      const result = removeOverlays(state, query)
      if (result.removed.length === 0) return fail(state, `No text matches "${query}".`)

      return {
        state: result.state,
        summary:
          result.removed.length === 1
            ? `Removed the text "${result.removed[0].text}".`
            : `Removed ${result.removed.length} pieces of text.`,
      }
    }

    case 'place_clip': {
      const clip = findClip(state, args.clip)
      if (!clip) return fail(state, `No clip matches "${String(args.clip ?? '')}".`)
      if (clip.kind === 'audio') return fail(state, `${clip.name} is audio, so it is not in the picture.`)

      const placement = readPlacement(args.placement ?? args.position ?? args.where)
      if (!placement) {
        return fail(state, `Say where it should sit: ${PLACEMENT_NAMES.join(', ')}.`)
      }

      const size = parseSeconds(args.size)
      const frame = frameForPlacement(placement, size ?? 1)

      return {
        state: frameClip(state, clip, frame).state,
        summary: frame
          ? `${clip.name} now sits ${describeFrame(frame)}.`
          : `${clip.name} fills the frame again.`,
      }
    }

    case 'remember': {
      const note = typeof args.text === 'string' ? args.text : ''
      const result = addNote(state.memory, note)
      if (!result.note) return fail(state, 'Tell me what to remember.')
      if (result.duplicate) return { state, summary: `Already noted: ${result.note.text}.` }

      return { state: { ...state, memory: result.notes }, summary: `Noted: ${result.note.text}.` }
    }

    case 'forget': {
      const query = typeof args.text === 'string' ? args.text : ''
      const result = removeNotes(state.memory, query)
      if (result.removed.length === 0) return fail(state, `I have nothing remembered about "${query}".`)

      return {
        state: { ...state, memory: result.notes },
        summary:
          result.removed.length === 1
            ? `Forgot: ${result.removed[0].text}.`
            : `Forgot ${result.removed.length} notes.`,
      }
    }

    case 'list_memory':
      return {
        state,
        summary:
          state.memory.length === 0
            ? 'You have not taught me anything yet.'
            : `You have taught me:\n${state.memory.map((note) => `- ${note.text}`).join('\n')}`,
      }

    default:
      return fail(state, `I do not have a tool called "${String(call.name)}".`)
  }
}

/** Applies a batch, stopping nothing on failure so partial work still lands. */
export function runTools(
  state: ProjectState,
  calls: ToolCall[],
): { state: ProjectState; outcomes: ToolOutcome[] } {
  let current = state
  const outcomes: ToolOutcome[] = []

  for (const call of calls) {
    const outcome = runTool(current, call)
    current = outcome.state
    outcomes.push(outcome)
  }

  return { state: current, outcomes }
}
