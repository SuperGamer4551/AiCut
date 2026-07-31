// Projects on disk: one JSON file each, in the app's own folder.
//
// A file per project rather than one index means a project that will not parse
// costs you that project and nothing else, and it keeps saving cheap — the
// editor writes often, and rewriting every project on every keystroke would be
// silly. Writes go to a temporary file and are renamed into place, so a crash
// halfway through leaves the last good copy rather than half of a new one.
import { readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import type { ProjectDocument, ProjectSummary } from '../src/lib/project'
import { isProjectId, readProject, summarize } from '../src/lib/project'

export type ProjectsReply = { projects: ProjectSummary[] } | { error: string }
export type ProjectReply = { project: ProjectDocument } | { error: string }
export type SavedReply = { ok: true } | { error: string }

const SUFFIX = '.aicut.json'

export function projectsFolder(userData: string): string {
  return path.join(userData, 'projects')
}

function fileFor(userData: string, id: string): string {
  return path.join(projectsFolder(userData), `${id}${SUFFIX}`)
}

/** The id out of a file name, or nothing when the name is not one of ours. */
export function idFromFile(name: string): string | null {
  if (!name.endsWith(SUFFIX)) return null
  const id = name.slice(0, -SUFFIX.length)
  return isProjectId(id) ? id : null
}

async function ensureFolder(userData: string): Promise<string> {
  const folder = projectsFolder(userData)
  await mkdir(folder, { recursive: true })
  return folder
}

async function readOne(folder: string, name: string): Promise<ProjectDocument | null> {
  try {
    return readProject(JSON.parse(await readFile(path.join(folder, name), 'utf8')))
  } catch {
    return null
  }
}

export async function listProjects(userData: string): Promise<ProjectsReply> {
  try {
    const folder = await ensureFolder(userData)
    const names = (await readdir(folder)).filter((name) => idFromFile(name) !== null)

    const loaded = await Promise.all(names.map((name) => readOne(folder, name)))
    const projects = loaded
      .filter((project): project is ProjectDocument => project !== null)
      .map(summarize)

    return { projects }
  } catch (error) {
    return { error: `I could not read your projects: ${(error as Error).message}` }
  }
}

export async function loadProject(userData: string, id: string): Promise<ProjectReply> {
  if (!isProjectId(id)) return { error: `${id} is not a project I recognise.` }

  try {
    const project = readProject(JSON.parse(await readFile(fileFor(userData, id), 'utf8')))
    if (!project) return { error: 'That project file could not be read.' }
    return { project }
  } catch (error) {
    const message = (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'That project no longer exists.' : (error as Error).message
    return { error: message }
  }
}

export async function saveProject(userData: string, value: unknown): Promise<SavedReply> {
  const project = readProject(value)
  if (!project) return { error: 'That is not a project I can save.' }

  try {
    await ensureFolder(userData)

    const target = fileFor(userData, project.id)
    const scratch = `${target}.tmp`

    await writeFile(scratch, JSON.stringify(project, null, 2), 'utf8')
    await rename(scratch, target)

    return { ok: true }
  } catch (error) {
    return { error: `I could not save that project: ${(error as Error).message}` }
  }
}

export async function deleteProject(userData: string, id: string): Promise<SavedReply> {
  if (!isProjectId(id)) return { error: `${id} is not a project I recognise.` }

  try {
    await rm(fileFor(userData, id), { force: true })
    return { ok: true }
  } catch (error) {
    return { error: `I could not delete that project: ${(error as Error).message}` }
  }
}
