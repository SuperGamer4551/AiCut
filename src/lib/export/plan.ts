import type { MediaItem, TextOverlay, TimelineClip, Track } from '../types'
import { clipOffset } from '../types'
import { TEXT_STYLES, displayText } from '../overlay'

/**
 * Turns a timeline into an ffmpeg invocation. Kept free of Node and Electron so
 * the command can be asserted directly in tests.
 */

export type SourceProbe = {
  /** Whether the file carries an audio stream worth mapping. */
  hasAudio: boolean
}

export type ExportSettings = {
  output: string
  format?: string
  resolution?: string
  fps?: number
  /** A font file on disk, needed before any text can be drawn. */
  font?: string
}

export type ExportPlan = {
  args: string[]
  output: string
  format: string
  width: number
  height: number
  fps: number
  duration: number
  clipCount: number
  /** Pieces of text actually drawn into the picture. */
  textCount: number
  hasAudio: boolean
  warnings: string[]
}

export const DEFAULT_FPS = 30

const DEFAULT_WIDTH = 1920
const DEFAULT_HEIGHT = 1080

const AUDIO_RATE = 48_000

const FORMATS: Record<string, { extension: string; video: string[]; audio: string[]; extra: string[] }> = {
  mp4: {
    extension: 'mp4',
    video: ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p'],
    audio: ['-c:a', 'aac', '-b:a', '192k'],
    extra: ['-movflags', '+faststart'],
  },
  mov: {
    extension: 'mov',
    video: ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p'],
    audio: ['-c:a', 'aac', '-b:a', '192k'],
    extra: [],
  },
  webm: {
    extension: 'webm',
    video: ['-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '32', '-pix_fmt', 'yuv420p'],
    audio: ['-c:a', 'libopus', '-b:a', '160k'],
    extra: [],
  },
}

const RESOLUTION_WORDS: Record<string, [number, number]> = {
  '2160p': [3840, 2160],
  '4k': [3840, 2160],
  '1440p': [2560, 1440],
  '1080p': [1920, 1080],
  fhd: [1920, 1080],
  '720p': [1280, 720],
  hd: [1280, 720],
  '480p': [854, 480],
  vertical: [1080, 1920],
  portrait: [1080, 1920],
  shorts: [1080, 1920],
  tiktok: [1080, 1920],
  reels: [1080, 1920],
  '9:16': [1080, 1920],
  square: [1080, 1080],
  '1:1': [1080, 1080],
  '4:5': [1080, 1350],
  landscape: [1920, 1080],
  '16:9': [1920, 1080],
}

export function formatFor(value: string | undefined): string {
  const asked = (value ?? '').trim().toLowerCase().replace(/^\./, '')
  return asked in FORMATS ? asked : 'mp4'
}

export function extensionFor(format: string): string {
  return FORMATS[formatFor(format)].extension
}

/** Encoders need even dimensions, so sizes are rounded down to an even number. */
function even(value: number): number {
  const rounded = Math.floor(value)
  return rounded % 2 === 0 ? rounded : rounded - 1
}

export function parseResolution(
  value: string | undefined,
  fallback: [number, number] = [DEFAULT_WIDTH, DEFAULT_HEIGHT],
): [number, number] {
  const raw = (value ?? '').trim().toLowerCase()
  if (!raw) return [even(fallback[0]), even(fallback[1])]

  const explicit = /^(\d{2,5})\s*[x×:]\s*(\d{2,5})$/.exec(raw)
  if (explicit) {
    return [even(Number(explicit[1])), even(Number(explicit[2]))]
  }

  const word = RESOLUTION_WORDS[raw]
  if (word) return word

  const named = Object.keys(RESOLUTION_WORDS).find((key) => raw.includes(key))
  return named ? RESOLUTION_WORDS[named] : [even(fallback[0]), even(fallback[1])]
}

function trimNumber(value: number): string {
  return String(Number(value.toFixed(3)))
}

/**
 * ffmpeg parses the filter graph itself, so any value that could contain a
 * colon, a comma or a quote is wrapped and its own quotes closed and reopened,
 * which is the escape ffmpeg documents.
 */
export function quoteFilterValue(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').split("'").join("'\\''")}'`
}

/** Where the baseline of a line of text sits, for each position. */
function textY(position: TextOverlay['position'], height: number): string {
  if (position === 'top') return String(Math.round(height * 0.06))
  if (position === 'middle') return '(h-text_h)/2'
  return `h-text_h-${Math.round(height * 0.08)}`
}

export function drawTextFilter(
  overlay: TextOverlay,
  frame: { width: number; height: number },
  font: string,
): string {
  const look = TEXT_STYLES[overlay.style]
  const fontSize = Math.max(12, Math.round(frame.height * look.size))
  const border = Math.max(1, Math.round(frame.height * look.border))

  const parts = [
    'drawtext=expansion=none',
    `fontfile=${quoteFilterValue(font)}`,
    `text=${quoteFilterValue(displayText(overlay))}`,
    `fontcolor=${look.color}`,
    `fontsize=${fontSize}`,
    `borderw=${border}`,
    'bordercolor=black@0.9',
    'x=(w-text_w)/2',
    `y=${textY(overlay.position, frame.height)}`,
  ]

  if (look.box) {
    parts.push('box=1', 'boxcolor=black@0.55', `boxborderw=${Math.round(fontSize * 0.35)}`)
  }

  parts.push(
    `enable='between(t,${trimNumber(overlay.start)},${trimNumber(overlay.start + overlay.duration)})'`,
  )

  return parts.join(':')
}

/** Fractional crop rectangle expressed against the source's own dimensions. */
function cropFilter(clip: TimelineClip): string | null {
  const crop = clip.crop
  if (!crop) return null
  if (crop.x <= 0.001 && crop.y <= 0.001 && crop.width >= 0.999 && crop.height >= 0.999) return null

  return `crop=w=iw*${trimNumber(crop.width)}:h=ih*${trimNumber(crop.height)}:x=iw*${trimNumber(
    crop.x,
  )}:y=ih*${trimNumber(crop.y)}`
}

/**
 * Output frame for a timeline, when none was asked for. A cropped clip decides
 * the shape, so reframing something to 9:16 exports as a vertical video without
 * having to say so twice.
 */
export function frameFor(
  clip: TimelineClip | undefined,
  item: MediaItem | undefined,
): [number, number] {
  const sourceWidth = item?.width
  const sourceHeight = item?.height
  if (!sourceWidth || !sourceHeight) return [DEFAULT_WIDTH, DEFAULT_HEIGHT]

  const crop = clip?.crop
  const width = sourceWidth * (crop?.width ?? 1)
  const height = sourceHeight * (crop?.height ?? 1)
  const aspect = width / height

  if (aspect < 0.85) return [1080, 1920]
  if (aspect < 1.15) return [1080, 1080]
  if (aspect < 1.5) return [1440, 1080]
  return [DEFAULT_WIDTH, DEFAULT_HEIGHT]
}

type PlannedClip = {
  clip: TimelineClip
  item: MediaItem
  index: number
  hasAudio: boolean
}

/**
 * Composite order: lower video tracks first so upper tracks draw on top, the
 * way the timeline reads.
 */
function videoOrder(clips: TimelineClip[], tracks: Track[]): TimelineClip[] {
  const depth = new Map(tracks.map((track, index) => [track.id, index]))
  return [...clips]
    .filter((clip) => clip.kind !== 'audio')
    .sort((a, b) => (depth.get(b.track) ?? 0) - (depth.get(a.track) ?? 0) || a.start - b.start)
}

export function buildExportPlan(input: {
  clips: TimelineClip[]
  tracks: Track[]
  media: MediaItem[]
  overlays?: TextOverlay[]
  probes?: Record<string, SourceProbe>
  settings: ExportSettings
}): { plan: ExportPlan } | { error: string } {
  const { clips, tracks, media, settings } = input
  const probes = input.probes ?? {}
  const warnings: string[] = []

  if (clips.length === 0) return { error: 'The timeline is empty, so there is nothing to export.' }
  if (!settings.output.trim()) return { error: 'No output file was chosen.' }

  const usable: PlannedClip[] = []
  let index = 0

  const ordered = [
    ...videoOrder(clips, tracks),
    ...clips.filter((clip) => clip.kind === 'audio').sort((a, b) => a.start - b.start),
  ]

  for (const clip of ordered) {
    const item = media.find((entry) => entry.id === clip.mediaId)
    if (!item) {
      warnings.push(`${clip.name} was skipped because its media is no longer in the library.`)
      continue
    }
    if (!item.path) {
      warnings.push(`${clip.name} was skipped because it has no file on disk.`)
      continue
    }

    const probe = probes[item.path]
    usable.push({
      clip,
      item,
      index: index++,
      // A muted clip still draws its picture; it just contributes no sound,
      // which is how third-party footage is kept without its soundtrack.
      hasAudio: clip.muted
        ? false
        : clip.kind === 'audio'
          ? (probe?.hasAudio ?? true)
          : (probe?.hasAudio ?? false),
    })
  }

  if (usable.length === 0) {
    return { error: 'None of the clips on the timeline point at a file that can be read.' }
  }

  const videoClips = usable.filter((entry) => entry.clip.kind !== 'audio')
  const audioClips = usable.filter((entry) => entry.hasAudio)

  const duration = usable.reduce(
    (end, entry) => Math.max(end, entry.clip.start + entry.clip.duration),
    0,
  )

  // A clip parked in a corner is decoration, so the full-frame footage decides
  // the shape of the output.
  const first = videoClips.find((entry) => !entry.clip.frame) ?? videoClips[0]
  const [width, height] = parseResolution(settings.resolution, frameFor(first?.clip, first?.item))

  const fps = settings.fps && settings.fps > 0 ? settings.fps : DEFAULT_FPS
  const format = formatFor(settings.format)
  const codecs = FORMATS[format]

  const args: string[] = ['-y']

  for (const entry of usable) {
    // A still needs to be looped to fill its slot on the timeline.
    if (entry.item.kind === 'image') {
      args.push('-loop', '1', '-t', trimNumber(entry.clip.duration))
    }
    args.push('-i', entry.item.path as string)
  }

  const sourceIn = (clip: TimelineClip): number => clipOffset(clip)

  const graph: string[] = []

  graph.push(`color=c=black:s=${width}x${height}:r=${fps}:d=${trimNumber(duration)}[base]`)

  let canvas = 'base'
  for (const entry of videoClips) {
    const { clip, index: input } = entry
    const label = `v${input}`
    const steps: string[] = []

    // Stills are already cut to length by -t on the input.
    if (entry.item.kind !== 'image') {
      const from = sourceIn(clip)
      steps.push(`trim=start=${trimNumber(from)}:end=${trimNumber(from + clip.duration)}`)
    }
    steps.push('setpts=PTS-STARTPTS')

    const crop = cropFilter(clip)
    if (crop) steps.push(crop)

    // An inset keeps its own shape inside the box it was given; a full-frame
    // clip is letterboxed to fill the output exactly.
    const box = clip.frame
      ? { width: even(width * clip.frame.width), height: even(height * clip.frame.height) }
      : null

    if (box) {
      steps.push(
        `scale=${box.width}:${box.height}:force_original_aspect_ratio=decrease`,
        'setsar=1',
        `fps=${fps}`,
      )
    } else {
      steps.push(
        `scale=${width}:${height}:force_original_aspect_ratio=decrease`,
        `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`,
        'setsar=1',
        `fps=${fps}`,
      )
    }

    if (clip.start > 0) steps.push(`setpts=PTS+${trimNumber(clip.start)}/TB`)

    graph.push(`[${input}:v]${steps.join(',')}[${label}]`)

    const next = `c${input}`
    const end = clip.start + clip.duration
    const x = clip.frame ? even(width * clip.frame.x) : 0
    const y = clip.frame ? even(height * clip.frame.y) : 0
    graph.push(
      `[${canvas}][${label}]overlay=x=${x}:y=${y}:eof_action=pass:repeatlast=0:enable='between(t,${trimNumber(
        clip.start,
      )},${trimNumber(end)})'[${next}]`,
    )
    canvas = next
  }

  // Words go on last so nothing can be laid over them.
  const overlays = (input.overlays ?? []).filter((overlay) => overlay.text.trim().length > 0)
  let textCount = 0
  if (overlays.length > 0) {
    if (settings.font) {
      textCount = overlays.length
      const drawn = overlays.map((overlay) => drawTextFilter(overlay, { width, height }, settings.font as string))
      graph.push(`[${canvas}]${drawn.join(',')}[text]`)
      canvas = 'text'
    } else {
      warnings.push(
        `No font was found on this computer, so ${overlays.length} piece${
          overlays.length === 1 ? '' : 's'
        } of text could not be drawn.`,
      )
    }
  }

  graph.push(`[${canvas}]format=yuv420p[vout]`)

  const hasAudio = audioClips.length > 0
  if (hasAudio) {
    // A silent bed guarantees the track spans the whole render, even where no
    // clip covers it.
    graph.push(
      `anullsrc=r=${AUDIO_RATE}:cl=stereo,atrim=start=0:end=${trimNumber(duration)},asetpts=PTS-STARTPTS[abase]`,
    )

    const labels: string[] = ['abase']
    for (const entry of audioClips) {
      const label = `a${entry.index}`
      const from = sourceIn(entry.clip)
      const steps = [
        `atrim=start=${trimNumber(from)}:end=${trimNumber(from + entry.clip.duration)}`,
        'asetpts=PTS-STARTPTS',
        `aresample=${AUDIO_RATE}`,
      ]
      if (entry.clip.start > 0) {
        steps.push(`adelay=${Math.round(entry.clip.start * 1000)}:all=1`)
      }
      graph.push(`[${entry.index}:a]${steps.join(',')}[${label}]`)
      labels.push(label)
    }

    graph.push(
      `${labels.map((label) => `[${label}]`).join('')}amix=inputs=${labels.length}:normalize=0:dropout_transition=0[aout]`,
    )
  }

  args.push('-filter_complex', graph.join(';'))
  args.push('-map', '[vout]')
  if (hasAudio) {
    args.push('-map', '[aout]')
  } else {
    args.push('-an')
  }

  args.push(...codecs.video, '-r', String(fps))
  if (hasAudio) args.push(...codecs.audio)
  args.push(...codecs.extra)
  args.push('-t', trimNumber(duration))
  args.push(settings.output)

  if (videoClips.length === 0) {
    warnings.push('There is no video on the timeline, so the picture stays black.')
  }

  return {
    plan: {
      args,
      output: settings.output,
      format,
      width,
      height,
      fps,
      duration,
      clipCount: usable.length,
      textCount,
      hasAudio,
      warnings,
    },
  }
}

/** Progress percentage from ffmpeg's `-progress` style stderr output. */
export function progressFromLine(line: string, duration: number): number | null {
  const match = /time=(\d+):(\d{2}):(\d{2})(?:\.(\d+))?/.exec(line)
  if (!match || duration <= 0) return null

  const seconds =
    Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(`0.${match[4] ?? 0}`)

  return Math.max(0, Math.min(1, seconds / duration))
}
