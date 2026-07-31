// Assertions for projects actually reaching the disk: saving, listing, reading
// back, deleting, and surviving the sort of half-written file a crash leaves.
// Run with: npm run check:project-files
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { deleteProject, listProjects, loadProject, projectsFolder, saveProject } from '../electron/projects'
import { createProject } from '../src/lib/project'

let failures = 0

function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected)
  if (!pass) failures += 1
  console.log(`${pass ? 'pass' : 'FAIL'}  ${label}`)
  if (!pass) console.log(`      expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

async function main() {
  const home = await mkdtemp(path.join(tmpdir(), 'aicut-projects-'))

  try {
    // Nothing saved yet, and no folder either.
    const empty = await listProjects(home)
    check('an untouched app has no projects', 'projects' in empty && empty.projects, [])

    const short = createProject('Fortnite montage', 'short', 1700000000000, 'pfirst01')
    check('saving works', await saveProject(home, short), { ok: true })

    const listed = await listProjects(home)
    check('a saved project is listed', 'projects' in listed && listed.projects.map((p) => p.name), [
      'Fortnite montage',
    ])
    check('the listing knows its kind', 'projects' in listed && listed.projects[0].kind, 'short')

    const loaded = await loadProject(home, 'pfirst01')
    check('a project reads back as it was saved', 'project' in loaded && loaded.project, short)

    // Saving again replaces rather than duplicates.
    await saveProject(home, { ...short, name: 'Renamed' })
    const again = await listProjects(home)
    check('saving twice leaves one project', 'projects' in again && again.projects.length, 1)
    check('the newer name wins', 'projects' in again && again.projects[0].name, 'Renamed')

    // A second project, to prove listing is not accidentally singular.
    await saveProject(home, createProject('The movie', 'movie', 1700000001000, 'psecond1'))
    const both = await listProjects(home)
    check('both projects are listed', 'projects' in both && both.projects.length, 2)

    // Rubbish in the folder is somebody else's file, not a project.
    const folder = projectsFolder(home)
    await writeFile(path.join(folder, 'notes.txt'), 'hello', 'utf8')
    await writeFile(path.join(folder, 'pbroken1.aicut.json'), '{ this is not json', 'utf8')
    await writeFile(path.join(folder, 'pempty01.aicut.json'), '{}', 'utf8')

    const survived = await listProjects(home)
    check('a broken file costs only itself', 'projects' in survived && survived.projects.length, 2)

    // Deleting.
    check('deleting works', await deleteProject(home, 'pfirst01'), { ok: true })
    const afterDelete = await listProjects(home)
    check('a deleted project is gone', 'projects' in afterDelete && afterDelete.projects.map((p) => p.id), ['psecond1'])
    check('deleting twice is not an error', await deleteProject(home, 'pfirst01'), { ok: true })

    // Reading something that is not there.
    const missing = await loadProject(home, 'pnothere')
    check('a missing project explains itself', 'error' in missing, true)

    // Names that would escape the folder are refused before they touch it.
    check('a traversing id is refused on load', 'error' in (await loadProject(home, '../../etc/passwd')), true)
    check('a traversing id is refused on delete', 'error' in (await deleteProject(home, '../../etc/passwd')), true)
    check('rubbish is refused on save', 'error' in (await saveProject(home, { id: '../evil' })), true)

    // Nothing temporary is left lying about after a normal save.
    const leftovers = (await readdir(folder)).filter((name) => name.endsWith('.tmp'))
    check('no half-written files are left behind', leftovers, [])
  } finally {
    await rm(home, { recursive: true, force: true })
  }

  console.log(failures === 0 ? '\nAll project file checks passed.' : `\n${failures} project file check(s) failed.`)
  process.exit(failures === 0 ? 0 : 1)
}

void main()
