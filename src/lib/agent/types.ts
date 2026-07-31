import type { MediaItem, TextOverlay, TimelineClip, Track } from '../types'
import type { MemoryNote } from './memory'

export type ToolName =
  | 'describe_project'
  | 'import_media'
  | 'add_clip'
  | 'move_clip'
  | 'trim_clip'
  | 'use_range'
  | 'split_clip'
  | 'delete_clip'
  | 'crop_clip'
  | 'add_track'
  | 'rename_track'
  | 'remove_track'
  | 'set_zoom'
  | 'seek'
  | 'add_text'
  | 'remove_text'
  | 'place_clip'
  | 'remember'
  | 'forget'
  | 'list_memory'
  | 'list_folder'
  | 'find_media'
  | 'import_file'
  | 'analyze_clip'
  | 'find_highlight'
  | 'make_short'
  | 'remove_silence'
  | 'insert_cutaway'
  | 'punch_in'
  | 'make_montage'
  | 'generate_clip'
  | 'search_web'
  | 'find_online_media'
  | 'add_online_media'
  | 'find_reference_video'
  | 'download_video'
  | 'export_project'
  | 'publish_youtube'
  | 'youtube_status'
  | 'check_copyright'

export type ToolCall = {
  /** Present when the call came from a model, used to pair up the reply. */
  id?: string
  name: ToolName
  args: Record<string, unknown>
}

/** Everything a tool may read or change. */
export type ProjectState = {
  media: MediaItem[]
  clips: TimelineClip[]
  tracks: Track[]
  /** Words burnt into the picture: hooks, titles, meme lines. */
  overlays: TextOverlay[]
  playhead: number
  zoom: number
  selectedClipId: string | null
  /** Standing instructions the user has taught the assistant. */
  memory: MemoryNote[]
}

/**
 * Side effects a tool cannot perform on its own because they need the host app
 * (a native file dialog, for instance).
 */
export type ToolEffect = 'import'

export type ToolOutcome = {
  state: ProjectState
  /** One line for the transcript, also fed back to the model as the result. */
  summary: string
  effect?: ToolEffect
  error?: string
}

export type ChatRole = 'user' | 'assistant' | 'system'

export type ChatAction = {
  name: ToolName
  summary: string
  failed: boolean
}

/**
 * Tools the project state cannot carry out on its own: anything that touches
 * the disk, the network, or a native dialog. The renderer supplies them, which
 * keeps the runtime pure and testable.
 */
export type HostReply = {
  summary: string
  error?: string
}

export type ExportOptions = {
  output?: string
  format?: string
  resolution?: string
}

export type PublishOptions = {
  title?: string
  description?: string
  visibility?: string
  tags?: string
  /** Tagged as a Short, which YouTube keys off the shape and length. */
  short?: boolean
}

export type ShortOptions = {
  clip?: unknown
  /** Target length in seconds; capped at a minute for a Short. */
  duration?: number
  /** Width over height, defaulting to 9:16. */
  aspect?: number
  /** Skips the vertical reframe when the footage is already the right shape. */
  reframe?: boolean
}

export type SilenceOptions = {
  clip?: unknown
  /** Extra time kept either side of speech, so cuts do not clip words. */
  padding?: number
}

export type HighlightOptions = {
  clip?: unknown
  duration?: number
  count?: number
}

/** A meme, reaction or sound effect dropped in over what is already there. */
export type CutawayOptions = {
  /** A path, a file name, or the name of something already imported. */
  file?: unknown
  at?: unknown
  duration?: number
  /** Where it sits in the frame: full, a corner, or the middle. */
  placement?: unknown
  /** Scales the inset, where 1 is the standard corner size. */
  size?: number
}

export type PunchInOptions = {
  clip?: unknown
  at?: unknown
  duration?: number
  /** How much closer the picture gets, where 1.5 is half again. */
  amount?: number
}

export type MontageOptions = {
  /** Seconds taken from each clip. */
  each?: number
  /** How many clips to use, newest library items first. */
  count?: number
  /** Total length to aim for, which sets the per-clip length. */
  duration?: number
}

/**
 * A clip made from nothing: a title card, an end card, or a plain background for
 * words to sit on. Real footage cannot be invented, and this is what can.
 */
export type GenerateOptions = {
  /** Words to draw on it. Omit for a plain background. */
  text?: unknown
  seconds?: number
  /** Width over height, or a word like "vertical". Follows the timeline by default. */
  aspect?: unknown
  /** dark, accent or light. */
  look?: unknown
  at?: unknown
}

/** Reading up on a subject before talking about it or editing around it. */
export type SearchOptions = {
  query?: unknown
}

/**
 * Hunting through the free media libraries. The kind is a word rather than a
 * file type, because "meme" is a thing to look for and not a format.
 */
export type OnlineMediaOptions = {
  query?: unknown
  kind?: unknown
  count?: number
}

/**
 * Bringing something down from the internet into the library. Either the
 * address is already known, or one is found by searching first.
 */
export type AddOnlineOptions = {
  url?: unknown
  query?: unknown
  kind?: unknown
  /** Which of the results just listed to take, counting from one. */
  choice?: number
}

export type ReferenceOptions = {
  query?: unknown
  count?: number
}

/**
 * Pulling a whole YouTube video down as a file. Either the address is known
 * already, or the search runs first and the top hit is taken.
 */
export type DownloadVideoOptions = {
  url?: unknown
  query?: unknown
  /** Which of the videos just listed to take, counting from one. */
  choice?: number
}

export type HostBridge = {
  /**
   * The project as it stands after a host tool ran, since importing changes it
   * outside the runtime's control.
   */
  latestState?: () => ProjectState
  importDialog: () => Promise<HostReply>
  importPaths: (paths: string[]) => Promise<HostReply>
  listFolder: (folder: string | null) => Promise<HostReply>
  findMedia: (query: string, folder: string | null) => Promise<HostReply>
  analyzeClip: (options: HighlightOptions) => Promise<HostReply>
  findHighlight: (options: HighlightOptions) => Promise<HostReply>
  makeShort: (options: ShortOptions) => Promise<HostReply>
  removeSilence: (options: SilenceOptions) => Promise<HostReply>
  insertCutaway: (options: CutawayOptions) => Promise<HostReply>
  punchIn: (options: PunchInOptions) => Promise<HostReply>
  makeMontage: (options: MontageOptions) => Promise<HostReply>
  generateClip: (options: GenerateOptions) => Promise<HostReply>
  searchWeb: (options: SearchOptions) => Promise<HostReply>
  findOnlineMedia: (options: OnlineMediaOptions) => Promise<HostReply>
  addOnlineMedia: (options: AddOnlineOptions) => Promise<HostReply>
  findReferenceVideo: (options: ReferenceOptions) => Promise<HostReply>
  downloadVideo: (options: DownloadVideoOptions) => Promise<HostReply>
  exportProject: (options: ExportOptions) => Promise<HostReply>
  publish: (options: PublishOptions) => Promise<HostReply>
  youtubeStatus: () => Promise<HostReply>
  checkCopyright: () => Promise<HostReply>
}

export type ChatMessage = {
  id: string
  role: ChatRole
  text: string
  actions?: ChatAction[]
  /** An aside about how the work was done, rather than what was done. */
  note?: string
  pending?: boolean
  error?: string
}

/** Wire format for an OpenAI-compatible chat turn. */
export type ApiMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[]
  tool_call_id?: string
}

export type AiSettings = {
  baseUrl: string
  apiKey: string
  model: string
}

export type ChatReply = {
  content: string
  toolCalls: ToolCall[]
  error?: string
}
