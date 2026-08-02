/**
 * Updates from a static file host. electron-builder writes latest.yml next to
 * the installer; this asks whether the version listed there is newer than the
 * one running, fetches it quietly in the background, and then waits. Nothing
 * restarts under the user mid-edit — the app says it is ready and leaves it.
 *
 * Only the installed app can update itself. Running from source, this reports
 * as much rather than pretending to check.
 */
import { app } from 'electron'
import type { BrowserWindow } from 'electron'
import { autoUpdater } from 'electron-updater'

export type UpdateStatus =
  | 'idle'
  | 'unsupported'
  /** Updates exist, but this build has to be replaced by hand. */
  | 'manual'
  | 'checking'
  | 'current'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'error'

export type UpdateState = {
  status: UpdateStatus
  /** The version on the host, once something newer has been found. */
  version?: string
  /** 0–100 while the download runs. */
  percent?: number
  message?: string
}

/** Long enough after launch that it never competes with the first render. */
const FIRST_CHECK_MS = 10_000

const EVERY_MS = 6 * 60 * 60 * 1000

/**
 * The mac build cannot swap itself out. macOS only accepts an update signed by
 * the same Apple developer certificate as the copy running, and this project
 * has no certificate — the disk image is signed ad-hoc. Checking anyway fails
 * with a sentence about code signatures, which tells the user nothing they can
 * act on, so the mac build points at the download page instead.
 */
const NO_SELF_UPDATE = process.platform === 'darwin'

const MANUAL: UpdateState = {
  status: 'manual',
  message: 'New versions for Mac are downloaded from the AiCut releases page.',
}

let state: UpdateState = { status: 'idle' }
let target: BrowserWindow | null = null
let timer: NodeJS.Timeout | null = null

function announce(next: UpdateState): void {
  state = next
  if (target && !target.isDestroyed()) target.webContents.send('update:state', next)
}

export function currentUpdateState(): UpdateState {
  return state
}

function wire(): void {
  autoUpdater.autoDownload = true
  // If they never click, the update still lands the next time they quit.
  autoUpdater.autoInstallOnAppQuit = true

  // A host that has not been set up yet should read as "nothing new", not as a
  // fault the user has to think about.
  autoUpdater.on('checking-for-update', () => announce({ status: 'checking' }))
  autoUpdater.on('update-not-available', () => announce({ status: 'current' }))
  autoUpdater.on('update-available', (info) => announce({ status: 'available', version: info.version }))
  autoUpdater.on('download-progress', (progress) =>
    announce({ status: 'downloading', percent: Math.round(progress.percent), version: state.version }),
  )
  autoUpdater.on('update-downloaded', (info) => announce({ status: 'ready', version: info.version }))
  autoUpdater.on('error', (error) =>
    announce({ status: 'error', message: error instanceof Error ? error.message : String(error) }),
  )

  const feed = process.env.AICUT_UPDATE_URL?.trim()
  if (feed) autoUpdater.setFeedURL({ provider: 'generic', url: feed })
}

export async function checkForUpdates(): Promise<UpdateState> {
  if (!app.isPackaged) {
    announce({
      status: 'unsupported',
      message: 'Running from source. Only the installed app updates itself.',
    })
    return state
  }

  if (NO_SELF_UPDATE) {
    announce(MANUAL)
    return state
  }

  try {
    await autoUpdater.checkForUpdates()
  } catch (error) {
    announce({ status: 'error', message: error instanceof Error ? error.message : String(error) })
  }

  return state
}

export function startUpdates(win: BrowserWindow): void {
  target = win

  if (!app.isPackaged) {
    state = { status: 'unsupported', message: 'Running from source. Only the installed app updates itself.' }
    return
  }

  if (NO_SELF_UPDATE) {
    state = MANUAL
    return
  }

  wire()

  setTimeout(() => void checkForUpdates(), FIRST_CHECK_MS)
  timer = setInterval(() => void checkForUpdates(), EVERY_MS)
}

export function stopUpdates(): void {
  if (timer) clearInterval(timer)
  timer = null
  target = null
}

/** Quits and swaps in what was downloaded. Only meaningful once it is ready. */
export function installUpdate(): boolean {
  if (state.status !== 'ready') return false
  setImmediate(() => autoUpdater.quitAndInstall())
  return true
}
