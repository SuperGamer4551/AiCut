import { contextBridge, ipcRenderer, webUtils } from 'electron'

const MEDIA_SCHEME = 'aicut'

export type ImportedFile = {
  path: string
  name: string
  size: number
}

export type PublicAiSettings = {
  baseUrl: string
  model: string
  hasKey: boolean
}

export type ChatResponse = {
  content: string
  toolCalls: { id: string; name: string; arguments: string }[]
  error?: string
}

export type GeneratedClip = {
  path: string
  name: string
  size: number
  duration: number
  width: number
  height: number
  lines: string[]
}

export type UpdateState = {
  status: 'idle' | 'unsupported' | 'checking' | 'current' | 'available' | 'downloading' | 'ready' | 'error'
  version?: string
  percent?: number
  message?: string
}

export type WebMediaKind = 'image' | 'video' | 'gif' | 'audio' | 'meme'

export type WebMediaResult = {
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

export type WebArticle = {
  title: string
  summary: string
  url: string
  source: string
}

export type ReferenceVideo = {
  title: string
  url: string
  channel: string
  length?: string
}

export type FetchedVideo =
  | { path: string; name: string; size: number; title: string; channel: string; duration: number }
  | { error: string }

export type FetchProgress = { phase: 'tool' | 'download' | 'done' | 'failed'; fraction: number; what: string }

export type ProjectsReply = { projects: unknown[] } | { error: string }
export type ProjectReply = { project: unknown } | { error: string }
export type SavedReply = { ok: true } | { error: string }

export type MediaRoot = { name: string; path: string }

export type FolderEntry = {
  name: string
  path: string
  kind: 'folder' | 'media'
  size: number
}

export type Listing = {
  folder: string
  entries: FolderEntry[]
  truncated: boolean
}

export type FindReply =
  | { matches: FolderEntry[]; truncated: boolean; roots: string[] }
  | { error: string }

export type ClipAnalysis = {
  path: string
  hasAudio: boolean
  duration: number
  loudness: { time: number; level: number }[]
  silences: { start: number; end: number }[]
  error?: string
}

export type ExportReply = {
  ok: boolean
  output?: string
  error?: string
  canceled?: boolean
  duration?: number
  width?: number
  height?: number
  warnings?: string[]
}

export type ExportProgress = {
  phase: 'render' | 'upload' | 'done' | 'failed'
  fraction: number
  output: string
}

export type PublicYoutubeAccount = {
  connected: boolean
  hasCredentials: boolean
  channelTitle: string
  channelId: string
}

export type PublishReply = {
  ok: boolean
  videoId?: string
  url?: string
  visibility?: string
  channelTitle?: string
  error?: string
}

const api = {
  isDesktop: true,

  openMedia: (): Promise<ImportedFile[]> => ipcRenderer.invoke('media:open'),

  statFile: (filePath: string): Promise<ImportedFile | null> =>
    ipcRenderer.invoke('media:stat', filePath),

  /** Absolute path of a File dropped onto the window, or null in a browser context. */
  getPathForFile: (file: File): string | null => {
    try {
      return webUtils.getPathForFile(file) || null
    } catch {
      return null
    }
  },

  /** Playable URL served by the app's streaming media protocol. */
  toMediaUrl: (filePath: string): string =>
    `${MEDIA_SCHEME}://local/${encodeURIComponent(filePath)}`,

  ai: {
    /** Never includes the API key, only whether one is stored. */
    getSettings: (): Promise<PublicAiSettings> => ipcRenderer.invoke('ai:getSettings'),

    setSettings: (patch: {
      baseUrl?: string
      model?: string
      apiKey?: string
    }): Promise<PublicAiSettings> => ipcRenderer.invoke('ai:setSettings', patch),

    chat: (request: { messages: unknown[]; tools: unknown[] }): Promise<ChatResponse> =>
      ipcRenderer.invoke('ai:chat', request),

    /** Abandons the call in flight; the chat reports it as stopped. */
    stop: (): Promise<boolean> => ipcRenderer.invoke('ai:stop'),
  },

  generate: {
    /** Renders a title card, end card or plain background with ffmpeg. */
    clip: (request: {
      text?: string
      seconds?: number
      aspect?: number | string
      look?: string
    }): Promise<GeneratedClip | { error: string }> => ipcRenderer.invoke('generate:clip', request),
  },

  web: {
    /** Reads around a subject: an answer where there is one, and articles to follow. */
    search: (
      query: string,
    ): Promise<{ query: string; answer: string; articles: WebArticle[] } | { error: string }> =>
      ipcRenderer.invoke('web:search', query),

    /** Openly licensed pictures, footage, gifs, memes or sound. */
    media: (
      query: string,
      kind: WebMediaKind,
      limit?: number,
    ): Promise<{ query: string; kind: WebMediaKind; results: WebMediaResult[] } | { error: string }> =>
      ipcRenderer.invoke('web:media', query, kind, limit),

    /** Videos to watch for reference, as links. */
    videos: (
      query: string,
      limit?: number,
    ): Promise<{ query: string; videos: ReferenceVideo[]; searchUrl: string } | { error: string }> =>
      ipcRenderer.invoke('web:videos', query, limit),

    /** Saves a file to the app's download folder and reports where it landed. */
    download: (
      url: string,
      name?: string,
    ): Promise<{ path: string; name: string; size: number } | { error: string }> =>
      ipcRenderer.invoke('web:download', url, name),

    /** Pulls a whole YouTube video down as a file, picture and sound merged. */
    youtube: (url: string): Promise<FetchedVideo> => ipcRenderer.invoke('web:youtube', url),

    /** How far along a download is; returns an unsubscribe function. */
    onProgress: (listener: (progress: FetchProgress) => void): (() => void) => {
      const handler = (_event: unknown, progress: FetchProgress) => listener(progress)
      ipcRenderer.on('web:progress', handler)
      return () => ipcRenderer.removeListener('web:progress', handler)
    },

    /** Hands a link to the system browser. */
    open: (url: string): Promise<boolean> => ipcRenderer.invoke('web:open', url),
  },

  auth: {
    /** Who is signed in, or nobody. Survives closing the app. */
    session: (): Promise<{ user: { id: string; name: string; email: string } | null }> =>
      ipcRenderer.invoke('auth:session'),

    signUp: (
      name: string,
      email: string,
      password: string,
    ): Promise<{ user: { id: string; name: string; email: string } } | { error: string }> =>
      ipcRenderer.invoke('auth:signUp', name, email, password),

    signIn: (
      email: string,
      password: string,
    ): Promise<{ user: { id: string; name: string; email: string } } | { error: string }> =>
      ipcRenderer.invoke('auth:signIn', email, password),

    signOut: (): Promise<{ ok: true }> => ipcRenderer.invoke('auth:signOut'),
  },

  projects: {
    /** Enough about each saved project to draw the dashboard. */
    list: (): Promise<ProjectsReply> => ipcRenderer.invoke('projects:list'),

    load: (id: string): Promise<ProjectReply> => ipcRenderer.invoke('projects:load', id),

    save: (project: unknown): Promise<SavedReply> => ipcRenderer.invoke('projects:save', project),

    remove: (id: string): Promise<SavedReply> => ipcRenderer.invoke('projects:delete', id),
  },

  updates: {
    state: (): Promise<UpdateState> => ipcRenderer.invoke('update:state'),

    check: (): Promise<UpdateState> => ipcRenderer.invoke('update:check'),

    /** Quits and swaps in the downloaded version; only works once it is ready. */
    install: (): Promise<boolean> => ipcRenderer.invoke('update:install'),

    /** Progress of a check or download; returns an unsubscribe function. */
    onState: (listener: (state: UpdateState) => void): (() => void) => {
      const handler = (_event: unknown, state: UpdateState) => listener(state)
      ipcRenderer.on('update:state', handler)
      return () => ipcRenderer.removeListener('update:state', handler)
    },
  },

  files: {
    roots: (): Promise<MediaRoot[]> => ipcRenderer.invoke('fs:roots'),

    list: (folder: string | null): Promise<Listing | { error: string }> =>
      ipcRenderer.invoke('fs:list', folder),

    find: (query: string, folder: string | null): Promise<FindReply> =>
      ipcRenderer.invoke('fs:find', query, folder),
  },

  analysis: {
    /** Loudness and silence for a file on disk, used to find highlights. */
    clip: (filePath: string): Promise<ClipAnalysis> => ipcRenderer.invoke('analysis:clip', filePath),
  },

  exporter: {
    status: (): Promise<{ available: boolean; path: string; version?: string }> =>
      ipcRenderer.invoke('export:status'),

    choosePath: (suggestion: string, format: string): Promise<string | null> =>
      ipcRenderer.invoke('export:choosePath', suggestion, format),

    run: (payload: unknown): Promise<ExportReply> => ipcRenderer.invoke('export:run', payload),

    cancel: (): Promise<boolean> => ipcRenderer.invoke('export:cancel'),

    /** Render and upload progress; returns an unsubscribe function. */
    onProgress: (listener: (progress: ExportProgress) => void): (() => void) => {
      const handler = (_event: unknown, progress: ExportProgress) => listener(progress)
      ipcRenderer.on('export:progress', handler)
      return () => ipcRenderer.removeListener('export:progress', handler)
    },
  },

  youtube: {
    status: (): Promise<PublicYoutubeAccount> => ipcRenderer.invoke('youtube:status'),

    setCredentials: (credentials: {
      clientId?: string
      clientSecret?: string
    }): Promise<PublicYoutubeAccount> => ipcRenderer.invoke('youtube:setCredentials', credentials),

    connect: (): Promise<PublicYoutubeAccount | { error: string }> =>
      ipcRenderer.invoke('youtube:connect'),

    disconnect: (): Promise<PublicYoutubeAccount> => ipcRenderer.invoke('youtube:disconnect'),

    publish: (payload: unknown): Promise<PublishReply> =>
      ipcRenderer.invoke('youtube:publish', payload),
  },
}

contextBridge.exposeInMainWorld('aicut', api)

export type AicutApi = typeof api
