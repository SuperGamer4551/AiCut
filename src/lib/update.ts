/**
 * What the updater is doing, as the renderer sees it. The main process owns the
 * real state machine; this is the shape it sends over.
 */

export type UpdateStatus =
  | 'idle'
  /** Running from source, where there is nothing to update. */
  | 'unsupported'
  /** A build that cannot replace itself, so the new one is downloaded by hand. */
  | 'manual'
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

/** Nothing useful can be asked of the updater while it is already working. */
export function updateBusy(update: UpdateState): boolean {
  return update.status === 'checking' || update.status === 'available' || update.status === 'downloading'
}

/**
 * The word on the button that asks for a check. Staying quiet is right until
 * somebody actually asks: an answer of "nothing new" is worth saying only to
 * the person who just pressed the button, which is otherwise indistinguishable
 * from the button having done nothing at all.
 */
export function updateAction(update: UpdateState, asked: boolean): string {
  const working = updateLabel(update)
  if (working) return working

  // A build that cannot update itself should say so before it is asked, since
  // pressing the button opens a page rather than checking anything.
  if (update.status === 'manual') return 'Get the newest version'

  if (!asked) return 'Check for updates'

  switch (update.status) {
    case 'checking':
      return 'Checking…'
    case 'current':
      return 'Up to date'
    case 'unsupported':
      return 'Only the installed app updates itself'
    case 'error':
      return 'Could not check for updates'
    default:
      return 'Check for updates'
  }
}
