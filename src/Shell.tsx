import { useCallback, useEffect, useRef, useState } from 'react'
import App from './App'
import { Dashboard } from './components/Dashboard'
import type { ProjectDocument, ProjectKind, ProjectSummary } from './lib/project'
import { copyName, createProject, newProjectId, readProject, summarize } from './lib/project'
import { transcriptKeyFor } from './lib/agent/transcript'

/** Milliseconds of quiet before an edit is written. Long enough that dragging a
 *  clip is one save rather than fifty, short enough that nothing is ever lost. */
const SAVE_DELAY = 700

type Store = NonNullable<Window['aicut']>['projects']

function store(): Store | null {
  return window.aicut?.projects ?? null
}

/**
 * Decides which screen you are on. The editor only exists while a project is
 * open, so all of its listeners, timers and assistant state come and go with
 * the project rather than living for the whole run of the app.
 */
export default function Shell() {
  const [projects, setProjects] = useState<ProjectSummary[]>([])
  const [open, setOpen] = useState<ProjectDocument | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(true)

  // The save in flight, and the newest version of the project waiting for it.
  const pending = useRef<ProjectDocument | null>(null)
  const timer = useRef<number | null>(null)
  // Lets duplicate pick a free name without depending on the list it reads.
  const known = useRef<ProjectSummary[]>([])
  known.current = projects

  const refresh = useCallback(async () => {
    const projects = store()
    if (!projects) {
      // The browser build has nowhere to put a project, so it stays a scratchpad.
      setLoading(false)
      setError('Saved projects need the desktop app. Nothing here will be kept.')
      return
    }

    setLoading(true)
    const reply = await projects.list()
    setLoading(false)

    if ('error' in reply) {
      setError(reply.error)
      return
    }

    setError(null)
    setProjects(
      reply.projects
        .map(readProject)
        .filter((project): project is ProjectDocument => project !== null)
        .map(summarize),
    )
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const write = useCallback(async (project: ProjectDocument) => {
    const projects = store()
    if (!projects) return

    const reply = await projects.save(project)
    if ('error' in reply) {
      setError(reply.error)
      setSaved(true)
      return
    }

    setSaved(true)
    setProjects((current) => {
      const summary = summarize(project)
      const known = current.some((entry) => entry.id === project.id)
      return known
        ? current.map((entry) => (entry.id === project.id ? summary : entry))
        : [...current, summary]
    })
  }, [])

  /** Called by the editor on every meaningful change; coalesced into one write. */
  const change = useCallback(
    (next: ProjectDocument) => {
      pending.current = next
      setSaved(false)

      if (timer.current !== null) window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => {
        timer.current = null
        const project = pending.current
        pending.current = null
        if (project) void write(project)
      }, SAVE_DELAY)
    },
    [write],
  )

  /** Leaving must not drop the last few hundred milliseconds of work. */
  const flush = useCallback(async () => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current)
      timer.current = null
    }

    const project = pending.current
    pending.current = null
    if (project) await write(project)
  }, [write])

  // Closing the window is the other way to leave.
  useEffect(() => {
    function leaving() {
      if (pending.current) void write(pending.current)
    }
    window.addEventListener('beforeunload', leaving)
    return () => window.removeEventListener('beforeunload', leaving)
  }, [write])

  async function openProject(id: string) {
    const projects = store()
    if (!projects) return

    await flush()

    const reply = await projects.load(id)
    if ('error' in reply) {
      setError(reply.error)
      void refresh()
      return
    }

    const project = readProject(reply.project)
    if (!project) {
      setError('That project file could not be read.')
      return
    }

    setError(null)
    setSaved(true)
    setOpen(project)
  }

  async function create(name: string, kind: ProjectKind) {
    const project = createProject(name, kind)
    await flush()
    await write(project)
    setOpen(project)
  }

  async function leave() {
    await flush()
    setOpen(null)
    void refresh()
  }

  async function rename(id: string, name: string) {
    const projects = store()
    if (!projects) return

    const reply = await projects.load(id)
    if ('error' in reply) return setError(reply.error)

    const project = readProject(reply.project)
    if (project) await write({ ...project, name, modified: Date.now() })
  }

  async function duplicate(id: string) {
    const projects = store()
    if (!projects) return

    const reply = await projects.load(id)
    if ('error' in reply) return setError(reply.error)

    const project = readProject(reply.project)
    if (!project) return

    const now = Date.now()
    await write({
      ...project,
      id: newProjectId(now),
      name: copyName(project.name, known.current.map((entry) => entry.name)),
      created: now,
      modified: now,
    })
  }

  async function remove(id: string) {
    const projects = store()
    if (!projects) return

    const reply = await projects.remove(id)
    if ('error' in reply) return setError(reply.error)

    // The conversation about a project goes with it.
    try {
      window.localStorage.removeItem(transcriptKeyFor(id))
    } catch {
      // A browser with storage turned off has nothing to clean up.
    }

    setProjects((current) => current.filter((entry) => entry.id !== id))
  }

  if (!open) {
    return (
      <Dashboard
        projects={projects}
        loading={loading}
        error={error}
        onOpen={(id) => void openProject(id)}
        onCreate={(name, kind) => void create(name, kind)}
        onRename={(id, name) => void rename(id, name)}
        onDuplicate={(id) => void duplicate(id)}
        onDelete={(id) => void remove(id)}
      />
    )
  }

  return (
    <App
      key={open.id}
      project={open}
      saved={saved}
      onChange={change}
      onLeave={() => void leave()}
    />
  )
}
