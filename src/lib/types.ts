export type MediaKind = 'video' | 'audio' | 'image'

/**
 * Where a file came from. Worth keeping rather than discarding at import,
 * because whether something is yours is the whole question when you are asking
 * what in a video might get claimed.
 */
export type Origin =
  /** Picked off this computer. Whose it is originally, only you know. */
  | { from: 'local' }
  /** Drawn by the app itself, so nobody else has a claim on it. */
  | { from: 'generated' }
  /** Pulled off someone's YouTube channel. */
  | { from: 'youtube'; channel: string; title: string; url: string }
  /** From one of the openly licensed libraries, which carry terms. */
  | { from: 'library'; source: string; license: string; author?: string; pageUrl?: string }

export type MediaItem = {
  id: string
  name: string
  /** Absolute path on disk when imported from the desktop app, null for browser imports. */
  path: string | null
  /** Playable source URL (custom protocol on desktop, blob URL in the browser). */
  url: string
  kind: MediaKind
  duration: number
  size: number
  width?: number
  height?: number
  /** True until metadata has been read off the file. */
  loading: boolean
  error?: string
  /** Absent on anything imported before the app started recording this. */
  origin?: Origin
}

export type TrackKind = 'video' | 'audio'

export type Track = {
  id: string
  name: string
  kind: TrackKind
}

/** Visible region of a clip's source, as fractions of the full frame. */
export type Crop = {
  x: number
  y: number
  width: number
  height: number
}

/**
 * Where a clip is drawn inside the output frame, as fractions of it. Absent
 * means the clip fills the frame; a small frame is how a reaction or a meme
 * sits in a corner of the picture.
 */
export type Frame = {
  x: number
  y: number
  width: number
  height: number
}

export type TimelineClip = {
  id: string
  mediaId: string
  name: string
  kind: MediaKind
  track: string
  /** Where the clip sits on the timeline. */
  start: number
  duration: number
  /** Seconds into the source file where the clip begins. */
  offset?: number
  color: string
  crop?: Crop
  frame?: Frame
  /** Silenced, so the picture is kept without whatever was playing over it. */
  muted?: boolean
}

export function clipOffset(clip: TimelineClip): number {
  return clip.offset && clip.offset > 0 ? clip.offset : 0
}

export type TextPosition = 'top' | 'middle' | 'bottom'

/** Preset looks, so a request is one word rather than five numbers. */
export type TextStyle = 'meme' | 'title' | 'caption'

/** Words burnt into the picture: a hook, a title card, or a meme line. */
export type TextOverlay = {
  id: string
  text: string
  start: number
  duration: number
  position: TextPosition
  style: TextStyle
}

/** Media being dragged out of the library, used to preview the drop. */
export type DragMedia = {
  id: string
  name: string
  kind: MediaKind
  duration: number
}

// Ogg video earns its place here because the free libraries are full of it;
// ffmpeg and the preview both read it happily.
export const VIDEO_EXTENSIONS = ['mp4', 'm4v', 'mov', 'webm', 'mkv', 'avi', 'ogv']
export const AUDIO_EXTENSIONS = ['mp3', 'wav', 'aac', 'm4a', 'flac', 'ogg']
export const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'gif']

export const SUPPORTED_EXTENSIONS = [
  ...VIDEO_EXTENSIONS,
  ...AUDIO_EXTENSIONS,
  ...IMAGE_EXTENSIONS,
]

export const CLIP_COLORS: Record<MediaKind, string> = {
  video: '#3d7cff',
  audio: '#c47bff',
  image: '#f0c14a',
}

export function formatTime(seconds: number): string {
  const clamped = Math.max(0, Number.isFinite(seconds) ? seconds : 0)
  const m = Math.floor(clamped / 60)
  const s = Math.floor(clamped % 60)
  const f = Math.floor((clamped % 1) * 30)
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}:${String(f).padStart(2, '0')}`
}

export function formatSize(bytes: number): string {
  if (!bytes) return '—'
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}

export function extensionOf(nameOrPath: string): string {
  const match = /\.([a-z0-9]+)$/i.exec(nameOrPath.trim())
  return match ? match[1].toLowerCase() : ''
}

export function detectKind(nameOrPath: string, mimeType = ''): MediaKind {
  if (mimeType.startsWith('audio/')) return 'audio'
  if (mimeType.startsWith('image/')) return 'image'
  if (mimeType.startsWith('video/')) return 'video'

  const ext = extensionOf(nameOrPath)
  if (AUDIO_EXTENSIONS.includes(ext)) return 'audio'
  if (IMAGE_EXTENSIONS.includes(ext)) return 'image'
  return 'video'
}

export function isSupported(nameOrPath: string, mimeType = ''): boolean {
  if (/^(video|audio|image)\//.test(mimeType)) return true
  return SUPPORTED_EXTENSIONS.includes(extensionOf(nameOrPath))
}

export function baseName(filePath: string): string {
  return filePath.split(/[/\\]/).pop() ?? filePath
}

export function stripExtension(name: string): string {
  return name.replace(/\.[^.]+$/, '')
}
