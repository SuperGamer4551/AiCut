import { app, BrowserWindow, dialog, ipcMain, protocol, shell } from 'electron'
import { createReadStream, existsSync } from 'node:fs'
import { mkdtemp, stat, unlink } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import type { AiSettings, ChatRequest, ChatResponse, PublicAiSettings } from './aiClient'
import {
  mergeSettings,
  publicSettings,
  readSettingsFile,
  requestChat,
  writeSettingsFile,
} from './aiClient'
import type { FolderEntry, Listing } from './fileBrowser'
import { findMedia as findMediaFiles, listFolder } from './fileBrowser'
import type { MediaRoot } from './folders'
import { KNOWN_FOLDERS, collectRoots, resolveFolderName, searchRoots } from './folders'
import { cancelExport, ffmpegAvailable, probeSources, runExport } from './exporter'
import type { ClipAnalysis } from './analyze'
import { analyzeClip } from './analyze'
import type { ExportSettings } from '../src/lib/export/plan'
import { buildExportPlan, extensionFor } from '../src/lib/export/plan'
import type { GenerateReply, GenerateRequest } from './generate'
import { generateClip } from './generate'
import type { MediaItem, TextOverlay, TimelineClip, Track } from '../src/lib/types'
import type { UpdateState } from './updater'
import { checkForUpdates, currentUpdateState, installUpdate, startUpdates, stopUpdates } from './updater'
import { systemFont } from './fonts'
import type { PublicYoutubeAccount, YoutubeAccount } from './youtube'
import {
  EMPTY_ACCOUNT,
  GOOGLE_ENDPOINTS,
  authUrl,
  ensureAccessToken,
  exchangeCode,
  fetchChannel,
  normalizeVisibility,
  parseTags,
  publicAccount,
  readAccountFile,
  uploadVideo,
  writeAccountFile,
} from './youtube'

const MEDIA_SCHEME = 'aicut'

/**
 * Windows groups taskbar buttons, shortcuts and notifications by this id. Without
 * one it falls back to the running executable, which is how a pinned AiCut came
 * back as "Electron" — the id has to be set before any window exists.
 */
const APP_ID = 'com.aicut.editor'

/** The app's own icon, alongside the built main process and in the source tree. */
function appIcon(): string | undefined {
  const candidates = [
    path.join(__dirname, '../build/icon.ico'),
    path.join(process.resourcesPath ?? '', 'icon.ico'),
  ]
  return candidates.find((candidate) => existsSync(candidate))
}

const MEDIA_EXTENSIONS = [
  'mp4',
  'm4v',
  'mov',
  'webm',
  'mkv',
  'avi',
  'mp3',
  'wav',
  'aac',
  'm4a',
  'flac',
  'ogg',
  'png',
  'jpg',
  'jpeg',
  'webp',
  'gif',
]

const MIME_TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.aac': 'audio/aac',
  '.m4a': 'audio/mp4',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

// Registered as a privileged scheme so the renderer can stream local media
// through it under the app's CSP instead of loading file:// URLs directly.
protocol.registerSchemesAsPrivileged([
  {
    scheme: MEDIA_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
    },
  },
])

process.env.DIST = path.join(__dirname, '../dist')
process.env.VITE_PUBLIC = app.isPackaged
  ? process.env.DIST
  : path.join(process.env.DIST, '../public')

let win: BrowserWindow | null = null

function createWindow() {
  const icon = appIcon()

  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    title: 'AiCut',
    ...(icon ? { icon } : {}),
    backgroundColor: '#12141a',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  win.once('ready-to-show', () => win?.show())
  startUpdates(win)

  if (process.env.VITE_DEV_SERVER_URL) {
    win.loadURL(process.env.VITE_DEV_SERVER_URL)
  } else {
    win.loadFile(path.join(process.env.DIST!, 'index.html'))
  }
}

function filePathFromRequest(rawUrl: string): string {
  const { pathname } = new URL(rawUrl)
  return path.normalize(decodeURIComponent(pathname.replace(/^\//, '')))
}

function mimeTypeFor(filePath: string): string {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream'
}

function bodyFor(filePath: string, start?: number, end?: number): ReadableStream {
  const stream =
    start === undefined ? createReadStream(filePath) : createReadStream(filePath, { start, end })
  return Readable.toWeb(stream) as ReadableStream
}

async function handleMediaRequest(request: Request): Promise<Response> {
  let filePath: string
  try {
    filePath = filePathFromRequest(request.url)
  } catch {
    return new Response('Malformed media URL', { status: 400 })
  }

  let size: number
  try {
    const info = await stat(filePath)
    if (!info.isFile()) return new Response('Not a file', { status: 404 })
    size = info.size
  } catch {
    return new Response('File not found', { status: 404 })
  }

  const mime = mimeTypeFor(filePath)
  const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get('Range') ?? '')

  // Range support lets Chromium seek within video without buffering the whole file.
  if (range) {
    const start = range[1] ? Number(range[1]) : 0
    const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1

    if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= size) {
      return new Response(null, {
        status: 416,
        headers: { 'Content-Range': `bytes */${size}` },
      })
    }

    return new Response(bodyFor(filePath, start, end), {
      status: 206,
      headers: {
        'Content-Type': mime,
        'Content-Length': String(end - start + 1),
        'Content-Range': `bytes ${start}-${end}/${size}`,
        'Accept-Ranges': 'bytes',
      },
    })
  }

  return new Response(bodyFor(filePath), {
    status: 200,
    headers: {
      'Content-Type': mime,
      'Content-Length': String(size),
      'Accept-Ranges': 'bytes',
    },
  })
}

app.setAppUserModelId(APP_ID)

app.whenReady().then(() => {
  protocol.handle(MEDIA_SCHEME, handleMediaRequest)
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  stopUpdates()
  if (process.platform !== 'darwin') app.quit()
})

// --- Updates --------------------------------------------------------------

ipcMain.handle('update:state', (): UpdateState => currentUpdateState())

ipcMain.handle('update:check', (): Promise<UpdateState> => checkForUpdates())

ipcMain.handle('update:install', (): boolean => installUpdate())

export type ImportedFile = {
  path: string
  name: string
  size: number
}

ipcMain.handle('media:open', async (): Promise<ImportedFile[]> => {
  const parent = win ?? BrowserWindow.getFocusedWindow()
  const options: Electron.OpenDialogOptions = {
    title: 'Import media',
    buttonLabel: 'Import',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Media', extensions: MEDIA_EXTENSIONS },
      { name: 'Video', extensions: ['mp4', 'm4v', 'mov', 'webm', 'mkv', 'avi'] },
      { name: 'Audio', extensions: ['mp3', 'wav', 'aac', 'm4a', 'flac', 'ogg'] },
      { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  }

  const result = parent
    ? await dialog.showOpenDialog(parent, options)
    : await dialog.showOpenDialog(options)

  if (result.canceled) return []

  const files = await Promise.all(
    result.filePaths.map(async (filePath) => {
      let size = 0
      try {
        size = (await stat(filePath)).size
      } catch {
        // Unreadable files are still listed so the UI can surface the failure.
      }
      return { path: filePath, name: path.basename(filePath), size }
    }),
  )

  return files
})

ipcMain.handle('media:stat', async (_event, filePath: string): Promise<ImportedFile | null> => {
  try {
    const info = await stat(filePath)
    if (!info.isFile()) return null
    return { path: filePath, name: path.basename(filePath), size: info.size }
  } catch {
    return null
  }
})

// --- Assistant -------------------------------------------------------------
// The model is called from the main process so the API key never reaches the
// renderer and the request is not subject to the page's CSP.

function settingsPath(): string {
  return path.join(app.getPath('userData'), 'ai-settings.json')
}

ipcMain.handle('ai:getSettings', async (): Promise<PublicAiSettings> =>
  publicSettings(await readSettingsFile(settingsPath())),
)

ipcMain.handle(
  'ai:setSettings',
  async (_event, patch: Partial<AiSettings>): Promise<PublicAiSettings> => {
    const next = mergeSettings(await readSettingsFile(settingsPath()), patch)
    await writeSettingsFile(settingsPath(), next)
    return publicSettings(next)
  },
)

// One call at a time, so the Stop button has something to stop.
let chatInFlight: AbortController | null = null

ipcMain.handle('ai:chat', async (_event, request: ChatRequest): Promise<ChatResponse> => {
  chatInFlight?.abort()
  const controller = new AbortController()
  chatInFlight = controller

  try {
    return await requestChat(await readSettingsFile(settingsPath()), request, undefined, controller.signal)
  } finally {
    if (chatInFlight === controller) chatInFlight = null
  }
})

ipcMain.handle('ai:stop', (): boolean => {
  if (!chatInFlight) return false
  chatInFlight.abort()
  return true
})

// --- Generated clips ------------------------------------------------------

ipcMain.handle(
  'generate:clip',
  async (_event, request: GenerateRequest): Promise<GenerateReply> =>
    generateClip(app.getPath('userData'), request),
)

// --- Files on this computer ------------------------------------------------
// Reads are limited to folder listings and media file names, which is all the
// assistant needs to find footage to import.

function knownPaths(): Record<string, string> {
  const paths: Record<string, string> = {}
  for (const folder of KNOWN_FOLDERS) {
    try {
      const target = app.getPath(folder.key as Parameters<typeof app.getPath>[0])
      if (target) paths[folder.key] = target
    } catch {
      // Not every folder exists on every machine.
    }
  }
  return paths
}

function mediaRoots(): MediaRoot[] {
  return collectRoots(knownPaths(), existsSync, path.join)
}

/** A folder word like "documents" becomes the real path before anything reads it. */
function folderPath(wanted: string | null): string | null {
  if (!wanted || !wanted.trim()) return null
  return resolveFolderName(wanted, knownPaths()) ?? wanted
}

ipcMain.handle('fs:roots', (): MediaRoot[] => mediaRoots())

ipcMain.handle(
  'fs:list',
  async (_event, folder: string | null): Promise<Listing | { error: string }> => {
    const target = folderPath(folder) ?? app.getPath('home')
    try {
      return await listFolder(target)
    } catch (error) {
      const reason = (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'that folder does not exist' : (error as Error).message
      return { error: `I could not open ${target}: ${reason}.` }
    }
  },
)

ipcMain.handle(
  'fs:find',
  async (
    _event,
    query: string,
    folder: string | null,
  ): Promise<{ matches: FolderEntry[]; truncated: boolean; roots: string[] } | { error: string }> => {
    const named = folderPath(folder)
    const roots = named ? [named] : searchRoots(mediaRoots())

    try {
      const found = await findMediaFiles(query, roots)
      return { matches: found.matches, truncated: found.truncated, roots }
    } catch (error) {
      return { error: `The search failed: ${(error as Error).message}` }
    }
  },
)

// --- Measuring a clip ------------------------------------------------------
// Loudness and silence are enough to find the moment worth keeping, and cost
// nothing but a few seconds of audio decoding.

ipcMain.handle('analysis:clip', async (_event, filePath: string): Promise<ClipAnalysis> => {
  try {
    return await analyzeClip(filePath)
  } catch (error) {
    return {
      path: filePath,
      hasAudio: false,
      duration: 0,
      loudness: [],
      silences: [],
      error: `That file could not be measured: ${(error as Error).message}`,
    }
  }
})

// --- Export ---------------------------------------------------------------

export type ExportPayload = {
  clips: TimelineClip[]
  tracks: Track[]
  media: MediaItem[]
  overlays?: TextOverlay[]
  settings: ExportSettings
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

function sendProgress(channel: string, payload: unknown) {
  const target = win ?? BrowserWindow.getAllWindows()[0]
  target?.webContents.send(channel, payload)
}

ipcMain.handle('export:status', () => ffmpegAvailable())

ipcMain.handle(
  'export:choosePath',
  async (_event, suggestion: string, format: string): Promise<string | null> => {
    const extension = extensionFor(format)
    const parent = win ?? BrowserWindow.getFocusedWindow()
    const options: Electron.SaveDialogOptions = {
      title: 'Export project',
      buttonLabel: 'Export',
      defaultPath: `${suggestion || 'aicut-export'}.${extension}`,
      filters: [{ name: extension.toUpperCase(), extensions: [extension] }],
    }

    const result = parent
      ? await dialog.showSaveDialog(parent, options)
      : await dialog.showSaveDialog(options)

    return result.canceled || !result.filePath ? null : result.filePath
  },
)

async function render(payload: ExportPayload): Promise<ExportReply> {
  const paths = payload.media.map((item) => item.path).filter((entry): entry is string => Boolean(entry))
  const probes = await probeSources(paths)

  const built = buildExportPlan({
    clips: payload.clips,
    tracks: payload.tracks,
    media: payload.media,
    overlays: payload.overlays,
    probes,
    // The font is found here rather than in the renderer, which cannot see the
    // file system.
    settings: { ...payload.settings, font: payload.settings.font ?? systemFont() ?? undefined },
  })

  if ('error' in built) return { ok: false, error: built.error }

  const { plan } = built
  sendProgress('export:progress', { phase: 'render', fraction: 0, output: plan.output })

  const run = await runExport(plan, (fraction) => {
    sendProgress('export:progress', { phase: 'render', fraction, output: plan.output })
  })

  sendProgress('export:progress', { phase: run.ok ? 'done' : 'failed', fraction: 1, output: plan.output })

  return {
    ...run,
    duration: plan.duration,
    width: plan.width,
    height: plan.height,
    warnings: plan.warnings,
  }
}

ipcMain.handle('export:run', (_event, payload: ExportPayload) => render(payload))

ipcMain.handle('export:cancel', () => cancelExport())

// --- YouTube --------------------------------------------------------------

function youtubePath(): string {
  return path.join(app.getPath('userData'), 'youtube.json')
}

async function saveAccount(account: YoutubeAccount): Promise<PublicYoutubeAccount> {
  await writeAccountFile(youtubePath(), account)
  return publicAccount(account)
}

ipcMain.handle('youtube:status', async (): Promise<PublicYoutubeAccount> =>
  publicAccount(await readAccountFile(youtubePath())),
)

ipcMain.handle(
  'youtube:setCredentials',
  async (_event, credentials: { clientId?: string; clientSecret?: string }): Promise<PublicYoutubeAccount> => {
    const current = await readAccountFile(youtubePath())
    return saveAccount({
      ...current,
      clientId: (credentials.clientId ?? current.clientId).trim(),
      clientSecret: (credentials.clientSecret ?? current.clientSecret).trim(),
    })
  },
)

ipcMain.handle('youtube:disconnect', async (): Promise<PublicYoutubeAccount> => {
  const current = await readAccountFile(youtubePath())
  // Credentials are kept so reconnecting does not need them re-entered.
  return saveAccount({ ...EMPTY_ACCOUNT, clientId: current.clientId, clientSecret: current.clientSecret })
})

const CONNECT_TIMEOUT_MS = 5 * 60 * 1000

/**
 * The desktop OAuth flow: consent happens in the user's own browser and Google
 * redirects back to a one-shot loopback server.
 */
ipcMain.handle('youtube:connect', async (): Promise<PublicYoutubeAccount | { error: string }> => {
  const account = await readAccountFile(youtubePath())
  if (!account.clientId || !account.clientSecret) {
    return { error: 'Add a Google OAuth client id and secret first.' }
  }

  const state = randomUUID()

  const server = createServer()
  const code = new Promise<string | { error: string }>((resolve) => {
    server.on('request', (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const finish = (message: string) => {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(`<html><body style="font-family:system-ui;background:#12141a;color:#e8eaf0;display:grid;place-items:center;height:100vh"><p>${message}</p></body></html>`)
      }

      if (url.searchParams.get('error')) {
        finish('Permission was declined. You can close this tab.')
        resolve({ error: 'You declined the YouTube permission request.' })
        return
      }

      const returned = url.searchParams.get('code')
      if (!returned) {
        finish('Waiting for Google…')
        return
      }

      if (url.searchParams.get('state') !== state) {
        finish('That response did not match this request. You can close this tab.')
        resolve({ error: 'The sign-in response did not match the request.' })
        return
      }

      finish('YouTube is connected. You can close this tab and return to AiCut.')
      resolve(returned)
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  const redirectUri = `http://127.0.0.1:${port}`

  const timeout = new Promise<{ error: string }>((resolve) => {
    setTimeout(() => resolve({ error: 'The sign-in timed out.' }), CONNECT_TIMEOUT_MS)
  })

  try {
    await shell.openExternal(authUrl(GOOGLE_ENDPOINTS, { clientId: account.clientId, redirectUri, state }))
    const returned = await Promise.race([code, timeout])
    if (typeof returned !== 'string') return returned

    const tokens = await exchangeCode(GOOGLE_ENDPOINTS, {
      clientId: account.clientId,
      clientSecret: account.clientSecret,
      code: returned,
      redirectUri,
    })
    if ('error' in tokens) return tokens

    const channel = await fetchChannel(GOOGLE_ENDPOINTS, tokens.accessToken)
    if ('error' in channel) return channel

    return saveAccount({
      ...account,
      ...tokens,
      channelId: channel.id,
      channelTitle: channel.title,
    })
  } catch (error) {
    return { error: `Sign-in failed: ${(error as Error).message}` }
  } finally {
    server.close()
  }
})

export type PublishPayload = ExportPayload & {
  title: string
  description?: string
  visibility?: string
  tags?: string
}

export type PublishReply = {
  ok: boolean
  videoId?: string
  url?: string
  visibility?: string
  channelTitle?: string
  error?: string
}

ipcMain.handle('youtube:publish', async (_event, payload: PublishPayload): Promise<PublishReply> => {
  const stored = await readAccountFile(youtubePath())
  const ready = await ensureAccessToken(GOOGLE_ENDPOINTS, stored)

  if ('error' in ready) {
    return {
      ok: false,
      error:
        ready.error === 'not-connected'
          ? 'No YouTube channel is connected yet.'
          : `YouTube sign-in needs renewing: ${ready.error}`,
    }
  }

  if (ready.refreshed) await writeAccountFile(youtubePath(), ready.account)

  // Publishing renders to a scratch file, uploads it, then cleans up.
  const folder = await mkdtemp(path.join(os.tmpdir(), 'aicut-publish-'))
  const output = path.join(folder, `${payload.title.replace(/[^\w -]+/g, '').trim() || 'aicut-export'}.mp4`)

  const rendered = await render({
    clips: payload.clips,
    tracks: payload.tracks,
    media: payload.media,
    settings: { ...payload.settings, output, format: 'mp4' },
  })

  if (!rendered.ok) return { ok: false, error: rendered.error ?? 'The render failed.' }

  const visibility = normalizeVisibility(payload.visibility)
  sendProgress('export:progress', { phase: 'upload', fraction: 0, output })

  const uploaded = await uploadVideo(GOOGLE_ENDPOINTS, {
    accessToken: ready.account.accessToken,
    filePath: output,
    metadata: {
      title: payload.title,
      description: payload.description ?? '',
      visibility,
      tags: parseTags(payload.tags),
    },
    onProgress: (fraction) => sendProgress('export:progress', { phase: 'upload', fraction, output }),
  })

  await unlink(output).catch(() => undefined)
  sendProgress('export:progress', { phase: 'error' in uploaded ? 'failed' : 'done', fraction: 1, output })

  if ('error' in uploaded) return { ok: false, error: uploaded.error }

  return {
    ok: true,
    videoId: uploaded.videoId,
    url: uploaded.url,
    visibility,
    channelTitle: ready.account.channelTitle,
  }
})
