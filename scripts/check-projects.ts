// Assertions for saved projects: the document that survives a restart, the
// presets behind the four project kinds, and the naming and reading rules the
// dashboard leans on.
// Run with: npm run check:projects
import {
  KIND_PRESETS,
  PROJECT_KINDS,
  byRecent,
  cleanProjectName,
  copyName,
  createProject,
  isProjectId,
  newProjectId,
  presetFor,
  projectEnd,
  readProject,
  readProjectKind,
  summarize,
  whenText,
} from '../src/lib/project'
import { idFromFile } from '../electron/projects'

let failures = 0

function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected)
  if (!pass) failures += 1
  console.log(`${pass ? 'pass' : 'FAIL'}  ${label}`)
  if (!pass) console.log(`      expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

// --- Project kinds ---------------------------------------------------------

check('every kind has a preset', PROJECT_KINDS.every((kind) => Boolean(KIND_PRESETS[kind])), true)
check('a short is vertical', KIND_PRESETS.short.vertical, true)
check('a short renders vertical', KIND_PRESETS.short.resolution, 'vertical')
check('a full video is landscape', KIND_PRESETS.video.vertical, false)

check('a short opens with a lane to layer memes on', KIND_PRESETS.short.tracks.filter((t) => t.kind === 'video').length, 2)
check('a full video opens with music and sound', KIND_PRESETS.video.tracks.filter((t) => t.kind === 'audio').length, 2)
check('a mini-movie opens with room', KIND_PRESETS.movie.tracks.length, 5)

// Three kinds that differ in shape and length, with nothing redundant between
// them: an aura edit is a Short, not a kind of its own.
check('there are three kinds', PROJECT_KINDS.length, 3)
check('only one kind is vertical', PROJECT_KINDS.filter((kind) => KIND_PRESETS[kind].vertical), ['short'])

// Video lanes count down so the topmost lane is first, matching the timeline.
check('video lanes are listed top down', KIND_PRESETS.movie.tracks.map((t) => t.id).slice(0, 3), [
  'video-3',
  'video-2',
  'video-1',
])

check('a lone lane is named plainly', KIND_PRESETS.short.tracks[2].name, 'Audio track')
check('numbered lanes are numbered', KIND_PRESETS.short.tracks[0].name, 'Video 2')

check('an unknown kind falls back to a full video', presetFor('nonsense' as never), KIND_PRESETS.video)

check('reads an exact kind', readProjectKind('movie'), 'movie')
check('reads a kind case-insensitively', readProjectKind('  Short '), 'short')
check('reads vertical as a short', readProjectKind('vertical'), 'short')
check('reads tiktok as a short', readProjectKind('tiktok'), 'short')
check('reads an aura edit as a short', readProjectKind('aura edit'), 'short')
check('reads film as a mini-movie', readProjectKind('a film'), 'movie')
check('reads nothing from junk', readProjectKind('banana'), null)
check('reads nothing from a number', readProjectKind(7), null)

// Nothing was ever released under the old kind, but a file naming it should
// still open, and should stay the shape it was rather than turning vertical.
check('the retired edit kind stays landscape', readProjectKind('edit'), 'video')
check('a project saved as an edit still opens', readProject({ id: 'plegacy1', kind: 'edit' })?.kind, 'video')

// --- Ids and names ---------------------------------------------------------

const id = newProjectId(1700000000000, () => 0.5)
check('an id is a safe file name', isProjectId(id), true)
check('an id has no separators', /[/\\.]/.test(id), false)
check('two ids in the same millisecond differ', newProjectId(1, () => 0.1) === newProjectId(1, () => 0.9), false)

check('rejects a traversing id', isProjectId('../secrets'), false)
check('rejects an empty id', isProjectId(''), false)
check('rejects an id without the prefix', isProjectId('abc123'), false)

check('trims a name', cleanProjectName('  Fortnite montage  '), 'Fortnite montage')
check('collapses whitespace', cleanProjectName('a\n\nb'), 'a b')
check('strips control characters', cleanProjectName('bad\u0000name'), 'bad name')
check('falls back when empty', cleanProjectName('   ', 'Short'), 'Short')
check('caps a very long name', cleanProjectName('x'.repeat(200)).length, 60)

check('a copy is named copy', copyName('Montage', ['Montage']), 'Montage copy')
check('a second copy is numbered', copyName('Montage', ['Montage', 'Montage copy']), 'Montage copy 2')
check('copying a copy does not stack', copyName('Montage copy', ['Montage copy']), 'Montage copy 2')
check('a free name is taken as is', copyName('Montage', []), 'Montage copy')
check('names collide case-insensitively', copyName('Montage', ['montage copy']), 'Montage copy 2')

// --- Files -----------------------------------------------------------------

check('reads an id out of a file name', idFromFile('pabc123.aicut.json'), 'pabc123')
check('ignores a stray file', idFromFile('notes.txt'), null)
check('ignores a half-written file', idFromFile('pabc123.aicut.json.tmp'), null)
check('ignores a traversing file name', idFromFile('../evil.aicut.json'), null)

// --- Making and summarising ------------------------------------------------

const made = createProject('My short', 'short', 1700000000000, 'ptest01')
check('a new project takes its preset tracks', made.tracks, KIND_PRESETS.short.tracks)
check('a new project takes its preset zoom', made.zoom, KIND_PRESETS.short.zoom)
check('a new project is empty', [made.clips.length, made.media.length, made.overlays.length], [0, 0, 0])
check('a nameless project is named after its kind', createProject('', 'movie', 1, 'ptest02').name, 'Mini-movie')

const withClips = {
  ...made,
  clips: [
    { id: 'c1', mediaId: 'm1', name: 'a', kind: 'video' as const, track: 'video-1', start: 0, duration: 4, color: '#000' },
    { id: 'c2', mediaId: 'm2', name: 'b', kind: 'video' as const, track: 'video-1', start: 10, duration: 5, color: '#000' },
  ],
}

check('the end of a project is its last clip', projectEnd(withClips.clips), 15)
check('an empty project ends at zero', projectEnd([]), 0)
check('a summary counts clips', summarize(withClips).clips, 2)
check('a summary carries the duration', summarize(withClips).duration, 15)

// --- Reading files back ----------------------------------------------------

check('a round trip survives', readProject(JSON.parse(JSON.stringify(withClips))), withClips)

check('rejects nothing at all', readProject(null), null)
check('rejects a string', readProject('project'), null)
check('rejects a project with no id', readProject({ name: 'x', kind: 'short' }), null)
check('rejects a project whose id is a path', readProject({ id: '../../etc/passwd', name: 'x' }), null)

// A file from a future build, or one somebody edited, should cost that project
// nothing worse than falling back to something openable.
const repaired = readProject({ id: 'ptest03', name: 'Odd', kind: 'unknown', clips: 'not an array' })
check('an unknown kind is repaired', repaired?.kind, 'video')
check('a broken clip list is repaired', repaired?.clips, [])
check('missing tracks fall back to the preset', repaired?.tracks, KIND_PRESETS.video.tracks)
check('a missing zoom falls back to the preset', repaired?.zoom, KIND_PRESETS.video.zoom)

check('a project with no lanes gets some', readProject({ id: 'ptest04', tracks: [] })?.tracks.length, 4)
check(
  'lanes that are not lanes are dropped',
  readProject({ id: 'ptest05', tracks: [{ id: 'a', kind: 'sideways' }] })?.tracks,
  KIND_PRESETS.video.tracks,
)
check('a negative playhead is clamped', readProject({ id: 'ptest06', playhead: -5 })?.playhead, 0)
check('clips without ids are dropped', readProject({ id: 'ptest07', clips: [{ start: 0 }] })?.clips, [])

// --- Ordering and dates ----------------------------------------------------

const summaries = [
  { id: 'a', name: 'a', kind: 'video' as const, created: 1, modified: 100, clips: 0, duration: 0 },
  { id: 'b', name: 'b', kind: 'video' as const, created: 1, modified: 300, clips: 0, duration: 0 },
  { id: 'c', name: 'c', kind: 'video' as const, created: 1, modified: 200, clips: 0, duration: 0 },
]

check('newest work comes first', byRecent(summaries).map((entry) => entry.id), ['b', 'c', 'a'])
check('ordering does not mutate', summaries.map((entry) => entry.id), ['a', 'b', 'c'])

const now = 1700000000000
check('a moment ago reads as just now', whenText(now - 5000, now), 'just now')
check('minutes read as minutes', whenText(now - 20 * 60 * 1000, now), '20 minutes ago')
check('one hour is singular', whenText(now - 60 * 60 * 1000, now), '1 hour ago')
check('hours read as hours', whenText(now - 5 * 60 * 60 * 1000, now), '5 hours ago')
check('one day is singular', whenText(now - 24 * 60 * 60 * 1000, now), '1 day ago')
check('a fortnight gets a date', /\d/.test(whenText(now - 20 * 24 * 60 * 60 * 1000, now)), true)

console.log(failures === 0 ? '\nAll project checks passed.' : `\n${failures} project check(s) failed.`)
process.exit(failures === 0 ? 0 : 1)
