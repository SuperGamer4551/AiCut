import { useMemo, useState } from 'react'
import type { Change, Finding, RemedyKind, RiskLevel } from '../lib/copyright'
import { checkCopyright, planRemedy } from '../lib/copyright'
import type { MediaItem, TimelineClip } from '../lib/types'
import './CopyrightCheck.css'

type Props = {
  clips: TimelineClip[]
  media: MediaItem[]
  onApply: (clips: TimelineClip[]) => void
  onClose: () => void
}

const LEVEL_WORD: Record<RiskLevel, string> = {
  clear: 'Looks clear',
  low: 'Minor',
  medium: 'Worth sorting',
  high: 'Risky',
}

/** A remedy the user has picked but not yet confirmed. */
type Pending = { finding: string; remedy: RemedyKind; change: Change }

function FindingCard({
  finding,
  pending,
  onPick,
  onConfirm,
  onCancel,
}: {
  finding: Finding
  pending: Pending | null
  onPick: (finding: Finding, remedy: RemedyKind) => void
  onConfirm: () => void
  onCancel: () => void
}) {
  const showing = pending?.finding === finding.id ? pending : null

  return (
    <article className={`finding is-${finding.level}`}>
      <header className="finding-head">
        <span className={`finding-tag is-${finding.level}`}>{LEVEL_WORD[finding.level]}</span>
        <h3>{finding.title}</h3>
      </header>

      <p className="finding-reason">{finding.reason}</p>

      {showing ? (
        <div className="preview">
          <p className="preview-title">This will change:</p>
          <ul className="preview-list">
            {showing.change.lines.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <div className="preview-actions">
            <button className="btn btn-small btn-primary" type="button" onClick={onConfirm}>
              Apply
            </button>
            <button className="btn btn-small btn-ghost" type="button" onClick={onCancel}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="remedies">
          {finding.remedies.map((remedy) => (
            <button
              key={remedy.kind + remedy.label}
              className={`remedy${remedy.kind === 'manual' ? ' is-advice' : ''}`}
              type="button"
              onClick={() => onPick(finding, remedy.kind)}
              disabled={remedy.kind === 'manual'}
            >
              <span className="remedy-label">{remedy.label}</span>
              <span className="remedy-detail">{remedy.detail}</span>
            </button>
          ))}
        </div>
      )}
    </article>
  )
}

/**
 * What might get this video claimed, and the things that would genuinely help.
 * Every change is shown in full before it is made.
 */
export function CopyrightCheck({ clips, media, onApply, onClose }: Props) {
  const [pending, setPending] = useState<Pending | null>(null)
  const report = useMemo(() => checkCopyright(clips, media), [clips, media])

  function pick(finding: Finding, remedy: RemedyKind) {
    const change = planRemedy(finding, remedy, clips, media)
    if (!change) return
    setPending({ finding: finding.id, remedy, change })
  }

  function confirm() {
    if (!pending) return
    onApply(pending.change.clips)
    setPending(null)
  }

  const borrowed = report.totalSeconds > 0 ? Math.round((report.borrowedSeconds / report.totalSeconds) * 100) : 0

  return (
    <div className="copyright-backdrop" role="dialog" aria-modal="true" aria-label="Copyright check">
      <div className="copyright-panel">
        <header className="copyright-head">
          <div>
            <h2>Copyright check</h2>
            <p className={`copyright-headline is-${report.level}`}>{report.headline}</p>
          </div>
          <button className="btn btn-ghost btn-small" type="button" onClick={onClose}>
            Close
          </button>
        </header>

        {report.totalSeconds > 0 && (
          <p className="copyright-stat">
            Someone else's work appears somewhere in {borrowed}% of the {Math.round(report.totalSeconds)}s this
            video runs for.
          </p>
        )}

        <div className="findings">
          {report.findings.length === 0 ? (
            <p className="findings-empty">
              Everything on the timeline is either yours, drawn by AiCut, or openly licensed with nothing to
              do about it. That is no guarantee — a check here cannot see what is inside a file you recorded
              yourself, like music playing in the background.
            </p>
          ) : (
            report.findings.map((finding) => (
              <FindingCard
                key={finding.id}
                finding={finding}
                pending={pending}
                onPick={pick}
                onConfirm={confirm}
                onCancel={() => setPending(null)}
              />
            ))
          )}
        </div>

        <footer className="copyright-foot">
          <p>
            <strong>The only way to know for certain</strong> is to upload unlisted, wait ten minutes, and read
            the Copyright tab in YouTube Studio. It tells you exactly what was matched, and you can fix it and
            re-upload before anyone sees the video.
          </p>
          <p className="copyright-myth">
            Mirroring, cropping, nudging the speed and keeping cuts short do not defeat Content ID — it
            normalises all of that before it compares, and YouTube says outright that no length of someone
            else's work is automatically safe. Worse, a trick that slips past the scan and is later seen by a
            person turns a claim into a strike.
          </p>
        </footer>
      </div>
    </div>
  )
}
