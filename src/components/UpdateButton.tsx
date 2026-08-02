import { useEffect, useState } from 'react'
import type { UpdateState } from '../lib/update'
import { updateAction, updateBusy } from '../lib/update'
import './UpdateButton.css'

/**
 * Asks the updater for a new version, and offers the restart once one is
 * downloaded. It lives in the status bar while a project is open and on the
 * dashboard before one is, because waiting for an update is not a reason to
 * have to open something first.
 */
export function UpdateButton() {
  const [update, setUpdate] = useState<UpdateState>({ status: 'idle' })
  const [asked, setAsked] = useState(false)

  // The browser build has no updater behind it, and an offer it cannot honour
  // is worse than no offer.
  const [updatable, setUpdatable] = useState(false)

  useEffect(() => {
    const updates = window.aicut?.updates
    if (!updates) return

    setUpdatable(true)
    void updates.state().then(setUpdate)
    return updates.onState(setUpdate)
  }, [])

  // An answer to a question nobody asked any more is just clutter, so the
  // outcome of a check goes back to offering another one after a moment.
  useEffect(() => {
    if (!asked || updateBusy(update) || update.status === 'ready') return

    const id = window.setTimeout(() => setAsked(false), 6000)
    return () => window.clearTimeout(id)
  }, [asked, update])

  function check() {
    setAsked(true)
    void window.aicut?.updates.check().then(setUpdate)
  }

  if (update.status === 'ready') {
    return (
      <button
        className="update-ready"
        type="button"
        onClick={() => void window.aicut?.updates.install()}
        title={`Restart AiCut to finish updating to ${update.version}`}
      >
        Restart to update
      </button>
    )
  }

  if (!updatable) return null

  return (
    <button
      className="update-note"
      type="button"
      onClick={check}
      disabled={updateBusy(update)}
      title={update.status === 'error' && update.message ? update.message : 'Check for a new version'}
    >
      {updateAction(update, asked)}
    </button>
  )
}
