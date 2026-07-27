import type { MediaItem, TimelineClip, Track } from '../types'
import { baseName, clipOffset, formatSize, stripExtension } from '../types'
import { extensionFor, formatFor } from '../export/plan'
import type { ClipMeasurement } from '../analyze/highlights'
import { describeLoudness, findHighlights, keepRangesFrom } from '../analyze/highlights'
import { describeFrame, frameForPlacement, readPlacement } from '../overlay'
import type { ReferenceVideo, WebMediaResult } from '../web/sources'
import { readMediaKind } from '../web/sources'
import { addTrackAtTop, defaultTrackId } from '../timeline'
import { learnedDefaults } from './memory'
import {
  addClipFor,
  cropToAspect,
  keepSourceRanges,
  moveClipTo,
  punchIn as punchInClip,
  useSourceRange,
} from './recipes'
import { findClip, findMedia, parseSeconds } from './runtime'
import type {
  DownloadVideoOptions,
  ExportOptions,
  HostBridge,
  HostReply,
  ProjectState,
  PublishOptions,
} from './types'

/**
 * The half of the tool surface that needs the desktop app: reading the disk,
 * rendering with ffmpeg, and talking to YouTube. Everything is funnelled
 * through injected callbacks so it can be driven by a stand-in in tests.
 */

type DesktopApi = NonNullable<Window['aicut']>

export type BridgeDeps = {
  getState: () => ProjectState
  /** Applies an edit made by a recipe, which the runtime then reads back. */
  applyState: (next: ProjectState) => void
  /** Opens the native picker; resolves with whatever was imported. */
  importDialog: () => Promise<MediaItem[]>
  importPaths: (paths: string[]) => Promise<{ items: MediaItem[]; failed: string[] }>
  desktop?: DesktopApi
  /** Shown as a toast in the app, for progress the chat does not cover. */
  notify?: (text: string) => void
}

/** A Short has to be vertical and short; YouTube's own limit is a minute. */
export const SHORT_MAX_SECONDS = 60
export const SHORT_DEFAULT_SECONDS = 30
export const SHORT_ASPECT = 9 / 16

/** A meme lands and gets out of the way, so inserts are short by default. */
export const CUTAWAY_IMAGE_SECONDS = 2.5
export const CUTAWAY_MAX_SECONDS = 5

export const PUNCH_SECONDS = 2.5
export const PUNCH_AMOUNT = 1.6

export const MONTAGE_EACH_SECONDS = 5
export const MONTAGE_MAX_CLIPS = 12

/** Where the overlay lane is named after what usually goes on it. */
const OVERLAY_TRACK_NAME = 'Memes & overlays'

const NEEDS_DESKTOP = 'That needs the desktop app; the browser build cannot reach your files.'

const NEEDS_INTERNET = 'That needs the desktop app, which is what does the searching and downloading.'

const MAX_LISTED = 24

function fail(summary: string): HostReply {
  return { summary, error: summary }
}

function word(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** One line about a search result: what it is, where it came from, and the terms. */
function describeFound(result: WebMediaResult): string {
  const shape = result.width && result.height ? `${result.width}×${result.height}` : ''
  const length = result.duration ? seconds(result.duration) : ''
  const weight = result.size ? formatSize(result.size) : ''
  const facts = [shape, length, weight].filter(Boolean).join(', ')

  return `${result.title} — ${result.source}${facts ? ` (${facts})` : ''}, licensed ${result.license}`
}

function names(items: MediaItem[]): string {
  return items.map((item) => item.name).join(', ')
}

export function describeListing(listing: {
  folder: string
  entries: { name: string; path: string; kind: 'folder' | 'media'; size: number }[]
  truncated: boolean
}): string {
  const folders = listing.entries.filter((entry) => entry.kind === 'folder')
  const files = listing.entries.filter((entry) => entry.kind === 'media')

  if (folders.length === 0 && files.length === 0) {
    return `${listing.folder} has no sub-folders and no media files.`
  }

  const lines = [`${listing.folder}:`]

  if (folders.length > 0) {
    lines.push(
      `Folders (${folders.length}): ${folders
        .slice(0, MAX_LISTED)
        .map((entry) => entry.name)
        .join('; ')}${folders.length > MAX_LISTED ? '; …' : ''}`,
    )
  }

  if (files.length > 0) {
    lines.push(
      `Media (${files.length}): ${files
        .slice(0, MAX_LISTED)
        .map((entry) => `${entry.name} [${formatSize(entry.size)}] ${entry.path}`)
        .join('; ')}${files.length > MAX_LISTED ? '; …' : ''}`,
    )
  }

  if (listing.truncated) lines.push('The folder holds more than this; ask for a sub-folder to narrow it down.')

  return lines.join('\n')
}

export function describeMatches(
  query: string,
  matches: { name: string; path: string; size: number }[],
  truncated: boolean,
  /** Where the search actually ran, so an empty result says so plainly. */
  roots: string[] = [],
): string {
  const term = query.trim()
  const where = roots.length > 0 ? roots.join(', ') : 'your Videos, Downloads, Documents, Desktop, Music, or Pictures folders'

  if (matches.length === 0) {
    return term
      ? `Nothing matching "${term}" turned up in ${where}.`
      : `I found no media files in ${where}.`
  }

  const heading = term
    ? `${matches.length}${truncated ? '+' : ''} file${matches.length === 1 ? '' : 's'} matching "${term}":`
    : `${matches.length}${truncated ? '+' : ''} media file${matches.length === 1 ? '' : 's'} in ${where}:`

  return [
    heading,
    ...matches.slice(0, MAX_LISTED).map((match) => `- ${match.name} [${formatSize(match.size)}] ${match.path}`),
  ].join('\n')
}

function exportPayload(state: ProjectState) {
  return {
    clips: state.clips,
    tracks: state.tracks,
    overlays: state.overlays,
    // Only what the renderer needs to find files on disk.
    media: state.media.map((item) => ({ ...item, url: '' })),
  }
}

function suggestedName(state: ProjectState): string {
  const first = state.clips[0]
  return (first?.name ?? 'aicut-export').replace(/[^\w -]+/g, '').trim() || 'aicut-export'
}

/** Vertical and under a minute, which is all YouTube asks of a Short. */
export function looksLikeShort(state: ProjectState): boolean {
  const video = state.clips.filter((clip) => clip.kind !== 'audio')
  if (video.length === 0) return false

  const end = state.clips.reduce((last, clip) => Math.max(last, clip.start + clip.duration), 0)
  if (end > SHORT_MAX_SECONDS + 0.5) return false

  return video.every((clip) => {
    const item = state.media.find((entry) => entry.id === clip.mediaId)
    if (!item?.width || !item.height) return false
    const width = item.width * (clip.crop?.width ?? 1)
    const height = item.height * (clip.crop?.height ?? 1)
    return width / height < 0.85
  })
}

/** Whether what is already on the timeline is taller than it is wide. */
export function looksVertical(state: ProjectState): boolean {
  const video = state.clips.filter((clip) => clip.kind !== 'audio')
  if (video.length === 0) return false

  return video.every((clip) => {
    const item = state.media.find((entry) => entry.id === clip.mediaId)
    if (!item?.width || !item.height) return false
    const width = item.width * (clip.crop?.width ?? 1)
    const height = item.height * (clip.crop?.height ?? 1)
    return width / height < 0.85
  })
}

function seconds(value: number): string {
  return `${Number(value.toFixed(1))}s`
}

function trackName(state: ProjectState, trackId: string): string {
  return state.tracks.find((track) => track.id === trackId)?.name ?? trackId
}

function freeAt(state: ProjectState, track: Track, at: number, duration: number): boolean {
  return !state.clips.some(
    (clip) =>
      clip.track === track.id && at < clip.start + clip.duration - 0.001 && at + duration > clip.start + 0.001,
  )
}

/**
 * The lane an insert should go on: the highest video track with room at that
 * moment, or a new one above everything, since the top lane is what draws over
 * the footage.
 */
export function overlayTrack(
  state: ProjectState,
  at: number,
  duration: number,
): { state: ProjectState; trackId: string } {
  // Only the top lane is guaranteed to draw over everything else, so it is used
  // when it has room and a fresh lane is added above when it does not.
  const top = state.tracks.find((track) => track.kind === 'video')
  if (top && freeAt(state, top, at, duration)) return { state, trackId: top.id }

  const added = addTrackAtTop(state.tracks, OVERLAY_TRACK_NAME)
  return { state: { ...state, tracks: added.tracks }, trackId: added.track.id }
}

function clock(value: number): string {
  const minutes = Math.floor(value / 60)
  const rest = Math.floor(value % 60)
  return `${minutes}:${String(rest).padStart(2, '0')}`
}

export function createHostBridge(deps: BridgeDeps): HostBridge {
  const desktop = deps.desktop

  // What the last internet search turned up, so "add the second one" means
  // something on the next turn.
  let lastFound: WebMediaResult[] = []
  let lastVideos: ReferenceVideo[] = []

  async function resolveOutput(options: ExportOptions, format: string): Promise<string | null> {
    if (options.output) return options.output
    if (!desktop) return null
    return desktop.exporter.choosePath(suggestedName(deps.getState()), format)
  }

  /**
   * The clip a recipe should work on, placing one from the library if the
   * timeline is still empty. Being forgiving here is what lets "make this a
   * short" work straight after an import.
   */
  function targetClip(
    state: ProjectState,
    wanted: unknown,
  ): { state: ProjectState; clip: TimelineClip } | { error: string } {
    const existing = findClip(state, wanted)
    if (existing) return { state, clip: existing }

    const item = findMedia(state, wanted) ?? state.media.find((entry) => entry.kind === 'video')
    if (!item) {
      return {
        error:
          state.media.length === 0
            ? 'Import the clip first, then I can work on it.'
            : `I could not tell which clip you meant by "${String(wanted ?? '')}".`,
      }
    }
    if (item.loading) return { error: `${item.name} is still being read from disk.` }

    const trackId = defaultTrackId(state.tracks, item.kind)
    if (!trackId) return { error: `There is no ${item.kind} track to put ${item.name} on.` }

    const placed = addClipFor(state, item.id, trackId, 0)
    if ('error' in placed) return placed
    return { state: placed.state, clip: placed.clip }
  }

  /**
   * The media an insert refers to. Already imported is checked first, then a
   * path, then the disk, preferring a folder the user has told us about. This is
   * what lets "drop the bruh meme in here" work without an import step.
   */
  async function resolveMedia(
    state: ProjectState,
    wanted: string,
  ): Promise<{ state: ProjectState; item: MediaItem } | { error: string }> {
    const inLibrary = wanted ? findMedia(state, wanted) : null
    if (inLibrary && !inLibrary.loading) return { state, item: inLibrary }

    if (!wanted) {
      return {
        error:
          'Tell me which meme, image or sound to drop in, and I will find it. You can also teach me where they live: "my memes are in D:\\memes".',
      }
    }

    const looksLikePath = /^([a-z]:[\\/]|\/|~)/i.test(wanted)
    let path = looksLikePath ? wanted : null

    if (!path) {
      if (!desktop) return { error: NEEDS_DESKTOP }

      const folders = learnedDefaults(state.memory).folders
      const hint = folders.memes ?? folders.sounds ?? null
      const term = stripExtension(baseName(wanted))

      const found = await desktop.files.find(term, hint)
      const matches = 'error' in found ? [] : found.matches
      const wider =
        matches.length === 0 && hint ? await desktop.files.find(term, null) : { matches: [] as typeof matches }
      const best = matches[0] ?? ('error' in wider ? undefined : wider.matches[0])

      if (!best) {
        return {
          error: `I could not find anything called "${term}"${hint ? ` in ${hint} or anywhere else` : ''}. Import it, or tell me the folder it is in.`,
        }
      }
      path = best.path
    }

    const imported = await deps.importPaths([path])
    const item = imported.items[0]
    if (!item) return { error: `I could not read ${path}.` }

    // The import lands in the project through its own state update, so the
    // freshest snapshot is the one to build on.
    return { state: deps.getState(), item }
  }

  /**
   * A whole video off YouTube, as a file in the library. The search runs here
   * rather than in the caller so that picking the top hit and saying which one
   * was picked stay together.
   */
  async function pullFromYoutube(options: DownloadVideoOptions): Promise<HostReply> {
    if (!desktop?.web?.youtube) return fail(NEEDS_INTERNET)

    const query = word(options.query)
    let link = word(options.url)
    let picked: ReferenceVideo | null = null

    if (!link && options.choice !== undefined) {
      const choice = lastVideos[Math.round(options.choice) - 1]
      if (!choice) {
        return fail(
          lastVideos.length === 0
            ? 'I have not listed any videos to pick from yet.'
            : `There is no number ${options.choice} in that list; there ${
                lastVideos.length === 1 ? 'is 1 video' : `are ${lastVideos.length} videos`
              }.`,
        )
      }
      picked = choice
      link = choice.url
    }

    if (!link) {
      if (!query) return fail('Tell me which video to download, or what to search YouTube for.')

      deps.notify?.(`Searching YouTube for ${query}…`)
      const found = await desktop.web.videos(query, 5)
      if ('error' in found) return fail(found.error)

      lastVideos = found.videos
      picked = found.videos[0] ?? null
      if (!picked) {
        return fail(`I could not find anything on YouTube for "${query}". Try wording it differently.`)
      }
      link = picked.url
    }

    deps.notify?.(`Downloading ${picked?.title ?? 'the video'}…`)
    const saved = await desktop.web.youtube(link)
    if ('error' in saved) return fail(saved.error)

    const imported = await deps.importPaths([saved.path])
    const item = imported.items[0]
    if (!item) return fail(`I downloaded ${saved.name} but could not read it back in.`)

    const from = saved.channel || picked?.channel || 'another channel'
    const length = saved.duration > 0 ? `, ${clock(saved.duration)} long` : ''
    const chose = picked && query ? ` It was the top hit for "${query}".` : ''

    return {
      summary:
        `Downloaded "${saved.title || item.name}" from ${from} (${formatSize(saved.size)}${length}) into the media panel.${chose}` +
        ` It is ${from}'s video rather than yours, so it is safe to study and cut from, but anything of it still there in something you upload can draw a Content ID claim, usually on the music. No clip is short enough to be exempt from that.`,
    }
  }

  /** Measures the file behind a clip, reporting trouble the same way ffmpeg does. */
  async function measure(clip: TimelineClip, state: ProjectState): Promise<ClipMeasurement> {
    const blank: ClipMeasurement = {
      path: '',
      hasAudio: false,
      duration: 0,
      loudness: [],
      silences: [],
    }

    if (!desktop) return { ...blank, error: NEEDS_DESKTOP }

    const item = state.media.find((entry) => entry.id === clip.mediaId)
    if (!item?.path) {
      return { ...blank, error: `${clip.name} has no file on disk, so I cannot measure it.` }
    }

    deps.notify?.(`Listening to ${item.name}…`)
    return desktop.analysis.clip(item.path)
  }

  return {
    latestState: deps.getState,

    async importDialog(): Promise<HostReply> {
      const items = await deps.importDialog()
      if (items.length === 0) return { summary: 'The file picker was closed without importing anything.' }

      return {
        summary: `Imported ${items.length} file${items.length === 1 ? '' : 's'}: ${names(items)}.`,
      }
    },

    async importPaths(paths): Promise<HostReply> {
      const { items, failed } = await deps.importPaths(paths)

      if (items.length === 0) {
        return fail(
          failed.length > 0
            ? `I could not read ${failed.join(', ')}. Check the path, or use find_media to locate the file.`
            : 'Nothing was imported.',
        )
      }

      const skipped = failed.length > 0 ? ` I could not read ${failed.join(', ')}.` : ''
      return {
        summary: `Imported ${items.length} file${items.length === 1 ? '' : 's'}: ${items
          .map((item) => `${item.name} (${item.kind}, ${Number(item.duration.toFixed(2))}s)`)
          .join(', ')}.${skipped}`,
      }
    },

    async listFolder(folder): Promise<HostReply> {
      if (!desktop) return fail(NEEDS_DESKTOP)

      if (!folder) {
        const roots = await desktop.files.roots()
        return {
          summary: `The usual places to look:\n${roots
            .map((root) => `- ${root.name}: ${root.path}`)
            .join('\n')}`,
        }
      }

      const listing = await desktop.files.list(folder)
      if ('error' in listing) return fail(listing.error)
      return { summary: describeListing(listing) }
    },

    async findMedia(query, folder): Promise<HostReply> {
      if (!desktop) return fail(NEEDS_DESKTOP)

      const found = await desktop.files.find(query, folder)
      if ('error' in found) return fail(found.error)

      // A named folder that comes up empty is usually the wrong guess at where
      // the file lives, so the rest of the usual places are tried before
      // reporting nothing.
      if (found.matches.length === 0 && folder) {
        const wider = await desktop.files.find(query, null)
        if (!('error' in wider) && wider.matches.length > 0) {
          return {
            summary: [
              describeMatches(query, [], false, found.roots),
              describeMatches(query, wider.matches, wider.truncated, wider.roots),
            ].join('\n'),
          }
        }
      }

      return { summary: describeMatches(query, found.matches, found.truncated, found.roots) }
    },

    async analyzeClip(options): Promise<HostReply> {
      const target = targetClip(deps.getState(), options.clip)
      if ('error' in target) return fail(target.error)

      const analysis = await measure(target.clip, target.state)
      if (analysis.error) return fail(analysis.error)

      return {
        summary: `${target.clip.name} is ${seconds(analysis.duration)} long. ${describeLoudness(
          analysis.loudness,
          analysis.silences,
        )}`,
      }
    },

    async findHighlight(options): Promise<HostReply> {
      const target = targetClip(deps.getState(), options.clip)
      if ('error' in target) return fail(target.error)

      const analysis = await measure(target.clip, target.state)
      if (analysis.error) return fail(analysis.error)

      const want = options.duration && options.duration > 0 ? options.duration : SHORT_DEFAULT_SECONDS
      const highlights = findHighlights(analysis.loudness, {
        duration: want,
        sourceDuration: analysis.duration,
        count: Math.min(Math.max(options.count ?? 3, 1), 5),
      })

      if (highlights.length === 0) return fail(`I could not find a standout moment in ${target.clip.name}.`)

      // Best first, since this is a report rather than an edit.
      const listed = [...highlights]
        .sort((a, b) => b.score - a.score)
        .map(
          (highlight, index) =>
            `${index + 1}. ${clock(highlight.start)}–${clock(highlight.end)} (loudest at ${clock(
              highlight.peakAt,
            )}, score ${Math.round(highlight.score * 100)})`,
        )
        .join(' ')

      return {
        summary: `Best ${seconds(want)} windows in ${target.clip.name}: ${listed}`,
      }
    },

    /**
     * The whole job in one call: find the moment, cut to it, reframe vertical and
     * put it at the head of the timeline. Weak models manage this where a dozen
     * separate calls would defeat them.
     */
    async makeShort(options): Promise<HostReply> {
      const target = targetClip(deps.getState(), options.clip)
      if ('error' in target) return fail(target.error)

      const clip = target.clip
      const item = target.state.media.find((entry) => entry.id === clip.mediaId)
      const sourceDuration = item && item.duration > 0 ? item.duration : clip.duration
      const want = Math.min(
        options.duration && options.duration > 0 ? options.duration : SHORT_DEFAULT_SECONDS,
        SHORT_MAX_SECONDS,
        sourceDuration,
      )

      // Missing audio is not fatal here: the clip can still be cut and reframed.
      const analysis = await measure(clip, target.state)
      const usable = !analysis.error && analysis.loudness.length > 0 ? analysis : null

      const picked = usable
        ? findHighlights(usable.loudness, {
            duration: want,
            sourceDuration: usable.duration || sourceDuration,
          })[0]
        : undefined

      // With no audio to go on, the opening seconds are as good a guess as any.
      const from = picked ? picked.start : clipOffset(clip)
      const to = picked ? picked.end : from + want

      let next = target.state
      const ranged = useSourceRange(next, clip, from, to)
      if ('error' in ranged) return fail(ranged.error)
      next = ranged.state

      if (options.reframe !== false && clip.kind !== 'audio') {
        next = cropToAspect(next, clip, options.aspect && options.aspect > 0 ? options.aspect : SHORT_ASPECT).state
      }

      next = moveClipTo(next, { ...clip, duration: ranged.to - ranged.from }, 0).state
      deps.applyState({ ...next, playhead: 0 })

      const how = picked
        ? `around the loudest moment at ${clock(picked.peakAt)}`
        : usable
          ? 'from the start of the clip'
          : 'from the start of the clip, since there was no audio to judge by'

      return {
        summary: `${clip.name} is now a ${seconds(ranged.to - ranged.from)} vertical short, cut ${how} (source ${clock(
          ranged.from,
        )}–${clock(ranged.to)}). Exporting will render it 1080×1920.`,
      }
    },

    async removeSilence(options): Promise<HostReply> {
      const target = targetClip(deps.getState(), options.clip)
      if ('error' in target) return fail(target.error)

      const analysis = await measure(target.clip, target.state)
      if (analysis.error) return fail(analysis.error)

      const padding = options.padding !== undefined && options.padding >= 0 ? options.padding : 0.15
      const ranges = keepRangesFrom(analysis.silences, analysis.duration, padding)

      const trimmed = keepSourceRanges(target.state, target.clip, ranges)
      if ('error' in trimmed) return fail(trimmed.error)

      deps.applyState(trimmed.state)

      return {
        summary: `Cut ${seconds(trimmed.removed)} of dead air from ${target.clip.name}, leaving ${
          trimmed.kept.length
        } piece${trimmed.kept.length === 1 ? '' : 's'}.`,
      }
    },

    /**
     * A meme, a reaction or a sound effect dropped in at a moment. The file can
     * be one already imported, a path, or just a name to hunt for on disk, since
     * that is how people ask for it.
     */
    async insertCutaway(options): Promise<HostReply> {
      const state = deps.getState()
      const wanted = typeof options.file === 'string' ? options.file.trim() : ''

      const found = await resolveMedia(state, wanted)
      if ('error' in found) return fail(found.error)

      const { item } = found
      let next = found.state

      const at = parseSeconds(options.at) ?? next.playhead
      const asked = options.duration && options.duration > 0 ? options.duration : null
      const duration =
        asked ?? (item.kind === 'image' ? CUTAWAY_IMAGE_SECONDS : Math.min(item.duration || CUTAWAY_MAX_SECONDS, CUTAWAY_MAX_SECONDS))

      if (item.kind === 'audio') {
        const trackId = defaultTrackId(next.tracks, 'audio')
        if (!trackId) return fail('There is no audio track to drop that on.')

        const placed = addClipFor(next, item.id, trackId, at, { duration })
        if ('error' in placed) return fail(placed.error)

        deps.applyState(placed.state)
        return {
          summary: `Dropped ${item.name} onto ${trackName(placed.state, trackId)} at ${clock(placed.clip.start)} for ${seconds(
            placed.clip.duration,
          )}.`,
        }
      }

      // Something is already on screen there, so the insert goes in a corner
      // rather than hiding it; on its own it can take the whole frame.
      const covering = next.clips.some(
        (clip) =>
          clip.kind !== 'audio' &&
          !clip.frame &&
          at >= clip.start - 0.001 &&
          at < clip.start + clip.duration,
      )
      const placement = readPlacement(options.placement) ?? (covering ? 'top-right' : 'full')
      const frame = frameForPlacement(placement, options.size ?? 1)

      const lane = overlayTrack(next, at, duration)
      next = lane.state

      const placed = addClipFor(next, item.id, lane.trackId, at, { duration, frame })
      if ('error' in placed) return fail(placed.error)

      deps.applyState(placed.state)

      return {
        summary: `Dropped ${item.name} in at ${clock(placed.clip.start)} for ${seconds(placed.clip.duration)}, ${describeFrame(
          frame,
        )}, on ${trackName(placed.state, lane.trackId)}.`,
      }
    },

    async punchIn(options): Promise<HostReply> {
      const target = targetClip(deps.getState(), options.clip)
      if ('error' in target) return fail(target.error)

      const clip = target.clip
      let at = parseSeconds(options.at)

      // With no time given, the loudest moment is the one worth pushing in on.
      let how = 'at the playhead'
      if (at === null) {
        const analysis = await measure(clip, target.state)
        const peak =
          !analysis.error && analysis.loudness.length > 0
            ? findHighlights(analysis.loudness, {
                duration: Math.min(options.duration ?? PUNCH_SECONDS, clip.duration),
                sourceDuration: analysis.duration || clip.duration,
              })[0]
            : undefined

        if (peak) {
          at = clip.start + Math.max(0, peak.peakAt - clipOffset(clip)) - (options.duration ?? PUNCH_SECONDS) / 2
          how = `on the loudest moment at ${clock(peak.peakAt)}`
        } else {
          at = target.state.playhead
        }
      }

      const punched = punchInClip(
        target.state,
        clip,
        Math.max(clip.start, at),
        options.duration && options.duration > 0 ? options.duration : PUNCH_SECONDS,
        options.amount && options.amount > 1 ? options.amount : PUNCH_AMOUNT,
      )
      if ('error' in punched) return fail(punched.error)

      deps.applyState(punched.state)

      return {
        summary: `Punched in ${punched.amount.toFixed(1)}× on ${clip.name} from ${clock(punched.from)} to ${clock(
          punched.to,
        )}, ${how}.`,
      }
    },

    /**
     * The best few seconds of every clip, laid end to end. Each file is measured
     * once, so a folder of gameplay becomes a montage without a model involved.
     */
    async makeMontage(options): Promise<HostReply> {
      const state = deps.getState()
      const videos = state.media.filter((item) => item.kind === 'video' && !item.loading)

      if (videos.length === 0) {
        return fail('Import a few clips first, then I can cut them together.')
      }
      if (videos.length === 1) {
        return fail(`${videos[0].name} is the only clip imported, so there is nothing to cut together yet.`)
      }

      const count = Math.min(Math.max(options.count ?? videos.length, 2), MONTAGE_MAX_CLIPS, videos.length)
      const chosen = videos.slice(0, count)
      const each =
        options.each && options.each > 0
          ? options.each
          : options.duration && options.duration > 0
            ? Math.max(1.5, options.duration / count)
            : MONTAGE_EACH_SECONDS

      const trackId = defaultTrackId(state.tracks, 'video')
      if (!trackId) return fail('There is no video track to build the montage on.')

      // The montage replaces whatever was on that track, which is what "make me
      // a montage" means in practice.
      let next: ProjectState = {
        ...state,
        clips: state.clips.filter((clip) => clip.track !== trackId),
        selectedClipId: null,
      }

      const used: string[] = []
      const skipped: string[] = []
      let cursor = 0

      for (const item of chosen) {
        const placed = addClipFor(next, item.id, trackId, cursor, { duration: each })
        if ('error' in placed) {
          skipped.push(item.name)
          continue
        }

        next = placed.state
        const analysis = await measure(placed.clip, next)
        const peak =
          !analysis.error && analysis.loudness.length > 0
            ? findHighlights(analysis.loudness, {
                duration: Math.min(each, analysis.duration || item.duration),
                sourceDuration: analysis.duration || item.duration,
              })[0]
            : undefined

        if (peak) {
          const ranged = useSourceRange(next, placed.clip, peak.start, peak.end)
          if (!('error' in ranged)) next = ranged.state
        }

        const settled = next.clips.find((clip) => clip.id === placed.clip.id)
        cursor = settled ? settled.start + settled.duration : cursor + each
        used.push(`${item.name}${peak ? ` (${clock(peak.start)})` : ''}`)
      }

      if (used.length === 0) return fail('None of those clips could be measured, so there is no montage.')

      deps.applyState({ ...next, playhead: 0 })

      return {
        summary: `Built a ${seconds(cursor)} montage from ${used.length} clips, ${seconds(
          each,
        )} each, cut to the liveliest moment in each: ${used.join(', ')}.${
          skipped.length > 0 ? ` Skipped ${skipped.join(', ')}.` : ''
        }`,
      }
    },

    async generateClip(options): Promise<HostReply> {
      if (!desktop?.generate) return fail(NEEDS_DESKTOP)

      const state = deps.getState()
      const words = typeof options.text === 'string' ? options.text.trim() : ''
      const at = parseSeconds(options.at)

      // A vertical timeline wants a vertical card, without being told twice.
      const aspect = options.aspect ?? (looksVertical(state) ? '9:16' : '16:9')

      const made = await desktop.generate.clip({
        text: words,
        seconds: options.seconds,
        aspect: aspect as number | string,
        look: typeof options.look === 'string' ? options.look : undefined,
      })

      if ('error' in made) return fail(`I could not render that: ${made.error}`)

      const imported = await deps.importPaths([made.path])
      const item = imported.items[0]
      if (!item) return fail(`I rendered ${made.name} but could not read it back in.`)

      const fresh = deps.getState()
      const trackId = defaultTrackId(fresh.tracks, 'video')
      if (!trackId) return fail('There is no video track to put it on.')

      const placed = addClipFor(fresh, item.id, trackId, at ?? fresh.playhead, { duration: made.duration })
      if ('error' in placed) return fail(placed.error)

      deps.applyState(placed.state)

      const drawn = made.lines.length > 0 ? `reading "${made.lines.join(' ')}"` : 'with no words on it'

      return {
        summary: `Made a ${seconds(made.duration)} ${made.width}x${made.height} clip ${drawn}, and put it on ${trackName(
          placed.state,
          trackId,
        )} at ${clock(placed.clip.start)}. This is a card I drew, not footage — I cannot invent a recording of something that never happened.`,
      }
    },

    async searchWeb(options): Promise<HostReply> {
      if (!desktop?.web) return fail(NEEDS_INTERNET)

      const query = word(options.query)
      if (!query) return fail('Tell me what to look up.')

      deps.notify?.(`Reading up on ${query}…`)
      const found = await desktop.web.search(query)
      if ('error' in found) return fail(found.error)

      if (!found.answer && found.articles.length === 0) {
        return { summary: `I searched for "${query}" and nothing useful came back.` }
      }

      const lines = found.answer ? [found.answer] : [`What I found on "${query}":`]
      for (const article of found.articles.slice(0, 4)) {
        lines.push(`${article.title} — ${article.source}: ${article.url}`)
      }

      return { summary: lines.join('\n') }
    },

    async findOnlineMedia(options): Promise<HostReply> {
      if (!desktop?.web) return fail(NEEDS_INTERNET)

      const query = word(options.query)
      if (!query) return fail('Tell me what to search the internet for.')

      const kind = readMediaKind(options.kind) ?? 'image'
      deps.notify?.(`Searching for ${kind === 'meme' ? 'memes' : `${kind}s`}…`)

      const found = await desktop.web.media(query, kind, options.count ?? 5)
      if ('error' in found) return fail(found.error)

      lastFound = found.results
      if (lastFound.length === 0) {
        return { summary: `I could not find a free ${kind} for "${query}". A different wording may turn something up.` }
      }

      const lines = [`Free ${kind === 'meme' ? 'memes' : `${kind}s`} for "${query}":`]
      lastFound.forEach((result, index) => {
        lines.push(`${index + 1}. ${describeFound(result)}`)
      })
      lines.push('Say which one to add, or I can take the first.')

      return { summary: lines.join('\n') }
    },

    async addOnlineMedia(options): Promise<HostReply> {
      if (!desktop?.web) return fail(NEEDS_INTERNET)

      const query = word(options.query)
      const link = word(options.url)
      const kind = readMediaKind(options.kind) ?? 'image'

      let chosen: WebMediaResult | null = null

      if (options.choice !== undefined && !link) {
        const picked = lastFound[Math.round(options.choice) - 1]
        if (!picked) {
          return fail(
            lastFound.length === 0
              ? 'I have not listed anything to pick from yet.'
              : `There is no number ${options.choice} in that list; there ${lastFound.length === 1 ? 'is 1 result' : `are ${lastFound.length} results`}.`,
          )
        }
        chosen = picked
      } else if (!link) {
        if (!query) return fail('Tell me what to find online.')

        deps.notify?.(`Searching for ${query}…`)
        const found = await desktop.web.media(query, kind, 5)
        if ('error' in found) return fail(found.error)

        lastFound = found.results
        chosen = lastFound[0] ?? null
        if (!chosen) {
          // The openly licensed libraries hold documentary and archive footage,
          // not gameplay or anything else from a channel. When they come up
          // empty for video, YouTube is where the thing actually is.
          if (kind === 'video') return pullFromYoutube({ query })

          return fail(`I could not find a free ${kind} for "${query}". Try wording it differently.`)
        }
      }

      const address = link || chosen?.url
      if (!address) return fail('I have no link to download.')

      deps.notify?.(`Downloading ${chosen?.title ?? 'the file'}…`)
      const saved = await desktop.web.download(address, chosen?.title ?? '')
      if ('error' in saved) return fail(saved.error)

      const imported = await deps.importPaths([saved.path])
      const item = imported.items[0]
      if (!item) return fail(`I downloaded ${saved.name} but could not read it back in.`)

      const credit = chosen ? ` from ${chosen.source}, licensed ${chosen.license}` : ''
      return {
        summary: `Added ${item.name} (${formatSize(saved.size)}) to the media panel${credit}. Drag it onto the timeline, or tell me where to put it.`,
      }
    },

    async findReferenceVideo(options): Promise<HostReply> {
      if (!desktop?.web) return fail(NEEDS_INTERNET)

      const query = word(options.query)
      if (!query) return fail('Tell me what the reference video should show.')

      deps.notify?.(`Looking for videos about ${query}…`)
      const found = await desktop.web.videos(query, options.count ?? 4)
      if ('error' in found) return fail(found.error)

      if (found.videos.length === 0) {
        return {
          summary: `I could not read the results for "${query}", but this search will show them: ${found.searchUrl}`,
        }
      }

      lastVideos = found.videos

      const lines = [`Worth watching for "${query}":`]
      for (const video of found.videos) {
        lines.push(`${video.title} — ${video.channel}${video.length ? ` (${video.length})` : ''}: ${video.url}`)
      }
      lines.push('Say which one to download if you want the file rather than the link.')

      return { summary: lines.join('\n') }
    },

    downloadVideo: pullFromYoutube,

    async exportProject(options): Promise<HostReply> {
      if (!desktop) return fail(NEEDS_DESKTOP)

      const state = deps.getState()
      if (state.clips.length === 0) return fail('The timeline is empty, so there is nothing to export.')

      const format = formatFor(options.format ?? learnedDefaults(state.memory).format ?? undefined)
      const output = await resolveOutput(options, format)
      if (!output) return { summary: 'The export was called off before a file was chosen.' }

      deps.notify?.('Rendering…')

      const reply = await desktop.exporter.run({
        ...exportPayload(state),
        settings: { output, format, resolution: options.resolution },
      })

      if (reply.canceled) return { summary: 'The export was canceled.' }
      if (!reply.ok || !reply.output) return fail(reply.error ?? 'The export failed.')

      const size = reply.width && reply.height ? `, ${reply.width}×${reply.height}` : ''
      const warnings = reply.warnings?.length ? ` ${reply.warnings.join(' ')}` : ''

      return {
        summary: `Exported ${Number((reply.duration ?? 0).toFixed(2))}s${size} to ${reply.output}.${warnings}`,
      }
    },

    async publish(options: PublishOptions): Promise<HostReply> {
      if (!desktop) return fail(NEEDS_DESKTOP)

      const state = deps.getState()
      if (state.clips.length === 0) return fail('The timeline is empty, so there is nothing to publish.')

      const account = await desktop.youtube.status()
      if (!account.connected) {
        return fail(
          account.hasCredentials
            ? 'No YouTube channel is connected. Open the assistant settings and connect one.'
            : 'YouTube is not set up yet. Add a Google OAuth client id and secret in the assistant settings, then connect your channel.',
        )
      }

      const visibility = options.visibility ?? learnedDefaults(state.memory).visibility ?? 'private'
      const short = options.short ?? looksLikeShort(state)

      // YouTube decides what a Short is from the shape and length, but the tag
      // is what gets it filed as one straight away.
      const base = options.title?.trim() || suggestedName(state)
      const title = short && !/#shorts/i.test(base) ? `${base} #Shorts` : base
      const tags = short ? [options.tags, 'shorts'].filter(Boolean).join(', ') : options.tags

      deps.notify?.('Rendering for YouTube…')

      const reply = await desktop.youtube.publish({
        ...exportPayload(state),
        settings: { output: '', format: 'mp4' },
        title,
        description: options.description,
        visibility,
        tags,
      })

      if (!reply.ok) return fail(reply.error ?? 'The upload failed.')

      return {
        summary: `Published "${title}" to ${reply.channelTitle ?? 'your channel'} as ${reply.visibility}: ${reply.url}`,
      }
    },

    async youtubeStatus(): Promise<HostReply> {
      if (!desktop) return fail(NEEDS_DESKTOP)

      const account = await desktop.youtube.status()
      if (account.connected) return { summary: `Connected to the YouTube channel "${account.channelTitle}".` }

      return {
        summary: account.hasCredentials
          ? 'No channel is connected yet, but Google credentials are saved. Use Connect in the assistant settings.'
          : 'YouTube is not connected. Add a Google OAuth client id and secret in the assistant settings first.',
      }
    },
  }
}

/** Default file name offered when exporting straight from the toolbar. */
export function exportFileName(state: ProjectState, format: string): string {
  return `${suggestedName(state)}.${extensionFor(format)}`
}
