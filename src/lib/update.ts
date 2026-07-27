/**
 * What the updater is doing, as the renderer sees it. The main process owns the
 * real state machine; this is the shape it sends over.
 */

export type UpdateStatus =
  | 'idle'
  /** Running from source, where there is nothing to update. */
  | 'unsupported'
  | 'checking'
  | 'current'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'error'

export type UpdateState = {
  status: UpdateStatus
  version?: string
  /** 0–100 while the download runs. */
  percent?: number
  message?: string
}

/**
 * What to show on the status bar. Most states are not worth a word: an idle
 * updater, or one that has just confirmed the app is current, should say
 * nothing rather than take up room reporting that nothing happened.
 */
export function updateLabel(update: UpdateState): string | null {
  switch (update.status) {
    case 'available':
      return `Downloading ${update.version ?? 'update'}…`
    case 'downloading':
      return `Downloading ${update.version ?? 'update'} ${update.percent ?? 0}%`
    case 'ready':
      return `Version ${update.version} is ready`
    default:
      return null
  }
}
