import { useEffect, useRef, useState } from 'react'
import type { ProjectKind, ProjectSummary } from '../lib/project'
import { KIND_PRESETS, PROJECT_KINDS, byRecent, cleanProjectName, whenText } from '../lib/project'
import { APP_VERSION } from '../lib/version'
import { formatTime } from '../lib/types'
import './Dashboard.css'

type Props = {
  projects: ProjectSummary[]
  loading: boolean
  error: string | null
  onOpen: (id: string) => void
  onCreate: (name: string, kind: ProjectKind) => void
  onRename: (id: string, name: string) => void
  onDuplicate: (id: string) => void
  onDelete: (id: string) => void
}

/** The card that starts something, one per kind of thing worth making. */
function NewProject({ onCreate }: { onCreate: (name: string, kind: ProjectKind) => void }) {
  const [kind, setKind] = useState<ProjectKind>('short')
  const [name, setName] = useState('')
  const preset = KIND_PRESETS[kind]

  function start() {
    onCreate(cleanProjectName(name, preset.label), kind)
    setName('')
  }

  return (
    <section className="new-project">
      <h2>Start something</h2>

      <div className="kind-grid">
        {PROJECT_KINDS.map((option) => (
          <button
            key={option}
            className={`kind-card${option === kind ? ' is-picked' : ''}`}
            type="button"
            onClick={() => setKind(option)}
          >
            <span className={`kind-shape is-${option}`} aria-hidden="true" />
            <span className="kind-label">{KIND_PRESETS[option].label}</span>
            <span className="kind-blurb">{KIND_PRESETS[option].blurb}</span>
          </button>
        ))}
      </div>

      <div className="new-row">
        <input
          className="new-name"
          value={name}
          placeholder={`${preset.label} name`}
          maxLength={60}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') start()
          }}
        />
        <button className="btn btn-primary" type="button" onClick={start}>
          Create
        </button>
      </div>
    </section>
  )
}

function ProjectCard({
  project,
  onOpen,
  onRename,
  onDuplicate,
  onDelete,
}: {
  project: ProjectSummary
  onOpen: (id: string) => void
  onRename: (id: string, name: string) => void
  onDuplicate: (id: string) => void
  onDelete: (id: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(project.name)
  const [confirming, setConfirming] = useState(false)
  const field = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editing) field.current?.select()
  }, [editing])

  // A delete offered a minute ago is not one you still mean.
  useEffect(() => {
    if (!confirming) return
    const id = window.setTimeout(() => setConfirming(false), 5000)
    return () => window.clearTimeout(id)
  }, [confirming])

  function commit() {
    setEditing(false)
    const cleaned = cleanProjectName(draft, project.name)
    if (cleaned !== project.name) onRename(project.id, cleaned)
    setDraft(cleaned)
  }

  return (
    <article className={`project-card is-${project.kind}`}>
      <button className="project-open" type="button" onClick={() => onOpen(project.id)}>
        <span className={`kind-shape is-${project.kind}`} aria-hidden="true" />
        <span className="project-facts">
          <span className="project-kind">{KIND_PRESETS[project.kind].label}</span>
          <span className="project-meta">
            {project.clips} clip{project.clips === 1 ? '' : 's'}
            {project.duration > 0 && ` · ${formatTime(project.duration).slice(0, 5)}`}
          </span>
        </span>
      </button>

      <div className="project-foot">
        {editing ? (
          <input
            ref={field}
            className="project-name-field"
            value={draft}
            maxLength={60}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.key === 'Enter') commit()
              if (event.key === 'Escape') {
                setDraft(project.name)
                setEditing(false)
              }
            }}
          />
        ) : (
          <button
            className="project-name"
            type="button"
            title="Rename"
            onClick={() => {
              setDraft(project.name)
              setEditing(true)
            }}
          >
            {project.name}
          </button>
        )}

        {/* The actions sit over the date, which is only worth reading when you
            are not reaching for them anyway. */}
        <div className="project-row">
          <span className="project-when">{whenText(project.modified)}</span>

          <span className="project-actions">
            <button
              className="card-action"
              type="button"
              title="Rename"
              onClick={() => {
                setDraft(project.name)
                setEditing(true)
              }}
            >
              Rename
            </button>
            <button className="card-action" type="button" title="Duplicate" onClick={() => onDuplicate(project.id)}>
              Duplicate
            </button>
            <button
              className={`card-action${confirming ? ' is-danger' : ''}`}
              type="button"
              title={confirming ? 'Deleting cannot be undone' : 'Delete'}
              onClick={() => {
                if (confirming) onDelete(project.id)
                else setConfirming(true)
              }}
            >
              {confirming ? 'Sure?' : 'Delete'}
            </button>
          </span>
        </div>
      </div>
    </article>
  )
}

/**
 * What you see before any project is open: what you were working on, and the
 * four kinds of thing worth starting.
 */
export function Dashboard({
  projects,
  loading,
  error,
  onOpen,
  onCreate,
  onRename,
  onDuplicate,
  onDelete,
}: Props) {
  const recent = byRecent(projects)

  return (
    <div className="dashboard">
      <header className="dashboard-head">
        <div className="dashboard-mark">
          <span className="dashboard-logo">AiCut</span>
          <span className="dashboard-version">{APP_VERSION}</span>
        </div>
        <p className="dashboard-tagline">Pick up where you left off, or start something new.</p>
      </header>

      <div className="dashboard-body">
        <NewProject onCreate={onCreate} />

        <section className="recent">
          <h2>
            Your projects
            {recent.length > 0 && <span className="recent-count">{recent.length}</span>}
          </h2>

          {error && <p className="dashboard-error">{error}</p>}

          {loading ? (
            <p className="dashboard-empty">Looking for your projects…</p>
          ) : recent.length === 0 ? (
            <p className="dashboard-empty">
              Nothing saved yet. Make a short above and it will be waiting here next time.
            </p>
          ) : (
            <div className="project-grid">
              {recent.map((project) => (
                <ProjectCard
                  key={project.id}
                  project={project}
                  onOpen={onOpen}
                  onRename={onRename}
                  onDuplicate={onDuplicate}
                  onDelete={onDelete}
                />
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  )
}
