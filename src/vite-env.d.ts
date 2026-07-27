/// <reference types="vite/client" />

export {}

type ImportedFile = {
  path: string
  name: string
  size: number
}

type PublicAiSettings = {
  baseUrl: string
  model: string
  hasKey: boolean
}

type ChatResponse = {
  content: string
  toolCalls: { id: string; name: string; arguments: string }[]
  error?: string
}

type MediaRoot = { name: string; path: string }

type FolderEntry = {
  name: string
  path: string
  kind: 'folder' | 'media'
  size: number
}

type Listing = {
  folder: string
  entries: FolderEntry[]
  truncated: boolean
}

type FindReply =
  | { matches: FolderEntry[]; truncated: boolean; roots: string[] }
  | { error: string }

type ClipAnalysis = {
  path: string
  hasAudio: boolean
  duration: number
  loudness: { time: number; level: number }[]
  silences: { start: number; end: number }[]
  error?: string
}

type ExportReply = {
  ok: boolean
  output?: string
  error?: string
  canceled?: boolean
  duration?: number
  width?: number
  height?: number
  warnings?: string[]
}

type ExportProgress = {
  phase: 'render' | 'upload' | 'done' | 'failed'
  fraction: number
  output: string
}

type PublicYoutubeAccount = {
  connected: boolean
  hasCredentials: boolean
  channelTitle: string
  channelId: string
}

type PublishReply = {
  ok: boolean
  videoId?: string
  url?: string
  visibility?: string
  channelTitle?: string
  error?: string
}

type GeneratedClip = {
  path: string
  name: string
  size: number
  duration: number
  width: number
  height: number
  /** The words as they were laid out, so a reply can say what was drawn. */
  lines: string[]
}

type UpdateState = {
  status: 'idle' | 'unsupported' | 'checking' | 'current' | 'available' | 'downloading' | 'ready' | 'error'
  version?: string
  percent?: number
  message?: string
}

type BrowseKind = 'image' | 'video' | 'gif' | 'audio' | 'meme'

type BrowseResult = {
  title: string
  url: string
  pageUrl: string
  source: string
  license: string
  author?: string
  extension: string
  kind: 'video' | 'audio' | 'image'
  width?: number
  height?: number
  duration?: number
  size?: number
}

type BrowseArticle = {
  title: string
  summary: string
  url: string
  source: string
}

type BrowseVideo = {
  title: string
  url: string
  channel: string
  length?: string
}

declare global {
  interface Window {
    aicut?: {
      isDesktop: boolean
      openMedia: () => Promise<ImportedFile[]>
      statFile: (filePath: string) => Promise<ImportedFile | null>
      getPathForFile: (file: File) => string | null
      toMediaUrl: (filePath: string) => string
      ai: {
        getSettings: () => Promise<PublicAiSettings>
        setSettings: (patch: {
          baseUrl?: string
          model?: string
          apiKey?: string
        }) => Promise<PublicAiSettings>
        chat: (request: { messages: unknown[]; tools: unknown[] }) => Promise<ChatResponse>
        stop: () => Promise<boolean>
      }
      generate: {
        clip: (request: {
          text?: string
          seconds?: number
          aspect?: number | string
          look?: string
        }) => Promise<GeneratedClip | { error: string }>
      }
      web: {
        search: (
          query: string,
        ) => Promise<{ query: string; answer: string; articles: BrowseArticle[] } | { error: string }>
        media: (
          query: string,
          kind: BrowseKind,
          limit?: number,
        ) => Promise<{ query: string; kind: BrowseKind; results: BrowseResult[] } | { error: string }>
        videos: (
          query: string,
          limit?: number,
        ) => Promise<{ query: string; videos: BrowseVideo[]; searchUrl: string } | { error: string }>
        download: (
          url: string,
          name?: string,
        ) => Promise<{ path: string; name: string; size: number } | { error: string }>
        open: (url: string) => Promise<boolean>
      }
      updates: {
        state: () => Promise<UpdateState>
        check: () => Promise<UpdateState>
        install: () => Promise<boolean>
        onState: (listener: (state: UpdateState) => void) => () => void
      }
      files: {
        roots: () => Promise<MediaRoot[]>
        list: (folder: string | null) => Promise<Listing | { error: string }>
        find: (query: string, folder: string | null) => Promise<FindReply>
      }
      analysis: {
        clip: (filePath: string) => Promise<ClipAnalysis>
      }
      exporter: {
        status: () => Promise<{ available: boolean; path: string; version?: string }>
        choosePath: (suggestion: string, format: string) => Promise<string | null>
        run: (payload: unknown) => Promise<ExportReply>
        cancel: () => Promise<boolean>
        onProgress: (listener: (progress: ExportProgress) => void) => () => void
      }
      youtube: {
        status: () => Promise<PublicYoutubeAccount>
        setCredentials: (credentials: {
          clientId?: string
          clientSecret?: string
        }) => Promise<PublicYoutubeAccount>
        connect: () => Promise<PublicYoutubeAccount | { error: string }>
        disconnect: () => Promise<PublicYoutubeAccount>
        publish: (payload: unknown) => Promise<PublishReply>
      }
    }
  }
}
