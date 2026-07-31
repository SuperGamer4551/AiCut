// Assertions for the copyright check: what counts as a risk, what the offered
// fixes actually do, and the promise that nothing changes until it is applied.
// Run with: npm run check:copyright
import {
  checkCopyright,
  coveredSeconds,
  describeOrigin,
  forbidsCommercial,
  isBorrowed,
  needsAttribution,
  planRemedy,
  timelineLength,
  worstOf,
} from '../src/lib/copyright'
import { converse } from '../src/lib/agent/converse'
import { interpretCommand } from '../src/lib/agent/interpret'
import type { ProjectState } from '../src/lib/agent/types'
import type { MediaItem, Origin, TimelineClip } from '../src/lib/types'

let failures = 0

function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected)
  if (!pass) failures += 1
  console.log(`${pass ? 'pass' : 'FAIL'}  ${label}`)
  if (!pass) console.log(`      expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

function media(id: string, origin?: Origin, kind: MediaItem['kind'] = 'video'): MediaItem {
  return { id, name: `${id}.mp4`, path: `C:/${id}.mp4`, url: '', kind, duration: 60, size: 1, loading: false, origin }
}

function clip(id: string, mediaId: string, start: number, duration: number, kind: MediaItem['kind'] = 'video'): TimelineClip {
  return { id, mediaId, name: `${mediaId} clip`, kind, track: 'video-1', start, duration, color: '#000' }
}

const MINE: Origin = { from: 'local' }
const DRAWN: Origin = { from: 'generated' }
const THEIRS: Origin = { from: 'youtube', channel: 'ClipMaster', title: 'Best plays', url: 'https://youtu.be/x' }

// --- Licence reading -------------------------------------------------------

check('cc-by needs a credit', needsAttribution('CC BY 4.0'), true)
check('cc-by-sa needs a credit', needsAttribution('cc-by-sa'), true)
check('cc0 needs nothing', needsAttribution('CC0'), false)
check('public domain needs nothing', needsAttribution('Public Domain'), false)
check('the public domain mark needs nothing', needsAttribution('pdm'), false)

check('nc forbids commercial use', forbidsCommercial('CC BY-NC 4.0'), true)
check('spelled out, it still forbids it', forbidsCommercial('noncommercial'), true)
check('plain cc-by allows it', forbidsCommercial('CC BY 4.0'), false)

check('the worst of nothing is clear', worstOf([]), 'clear')
check('high beats medium', worstOf(['medium', 'high', 'low']), 'high')
check('medium beats low', worstOf(['low', 'medium']), 'medium')

check('a youtube clip is borrowed', isBorrowed(media('a', THEIRS)), true)
check('a library clip is borrowed', isBorrowed(media('a', { from: 'library', source: 'X', license: 'CC0' })), true)
check('your own recording is not', isBorrowed(media('a', MINE)), false)
check('a card the app drew is not', isBorrowed(media('a', DRAWN)), false)

check('an origin is described by whose it is', describeOrigin(THEIRS), 'ClipMaster on YouTube')
check('an unknown origin says so', describeOrigin(undefined), 'an unknown source')

// --- Measuring the timeline ------------------------------------------------

// Music laid under footage must not make a 50 second video read as 100.
const stacked = [clip('c1', 'm1', 0, 50), clip('c2', 'm2', 0, 50, 'audio')]
check('overlapping clips cover the time once', coveredSeconds(stacked), 50)
check('the video is as long as its last clip', timelineLength(stacked), 50)

check('a gap is not counted as covered', coveredSeconds([clip('a', 'm', 0, 10), clip('b', 'm', 30, 10)]), 20)
check('a gap still counts towards the length', timelineLength([clip('a', 'm', 0, 10), clip('b', 'm', 30, 10)]), 40)
check('touching clips are counted once', coveredSeconds([clip('a', 'm', 0, 10), clip('b', 'm', 10, 10)]), 20)
check('a clip inside another adds nothing', coveredSeconds([clip('a', 'm', 0, 30), clip('b', 'm', 5, 5)]), 30)
check('nothing covers nothing', coveredSeconds([]), 0)

// A backing track under the whole thing means borrowed work really is present
// throughout, and the number should say so rather than exceeding 100%.
const scored = checkCopyright(
  [clip('c1', 'm1', 0, 50), clip('c2', 'm2', 0, 50, 'audio')],
  [media('m1', MINE), media('m2', { from: 'library', source: 'Openverse', license: 'CC BY 4.0', author: 'Ada' }, 'audio')],
)
check('a scored video is measured by its length', scored.totalSeconds, 50)
check('borrowed time cannot exceed the video', scored.borrowedSeconds <= scored.totalSeconds, true)
check('music throughout counts as throughout', scored.borrowedSeconds, 50)

// --- Nothing to report -----------------------------------------------------

const ownOnly = checkCopyright([clip('c1', 'm1', 0, 30)], [media('m1', MINE)])
check('your own footage raises nothing', ownOnly.findings.length, 0)
check('your own footage reads as clear', ownOnly.level, 'clear')
check('nothing borrowed is counted', ownOnly.borrowedSeconds, 0)

const emptyTimeline = checkCopyright([], [])
check('an empty timeline says so', emptyTimeline.headline, 'There is nothing on the timeline to check yet.')

// --- Somebody else's video -------------------------------------------------

const borrowed = checkCopyright(
  [clip('c1', 'm1', 0, 20), clip('c2', 'm1', 40, 10), clip('c3', 'm2', 20, 20)],
  [media('m1', THEIRS), media('m2', MINE)],
)

check('borrowed footage is a high risk', borrowed.level, 'high')
check('the channel is named', borrowed.findings[0].title, 'm1.mp4 is ClipMaster\'s video')
check('every clip from it is gathered', borrowed.findings[0].clipIds, ['c1', 'c2'])
check('borrowed seconds are counted', borrowed.borrowedSeconds, 30)
check('the whole timeline is measured', borrowed.totalSeconds, 50)

// The advice offered must never be an evasion trick.
const offered = borrowed.findings.flatMap((finding) => finding.remedies.map((remedy) => remedy.kind))
check('muting is offered', offered.includes('mute'), true)
check('removing is offered', offered.includes('remove'), true)

const words = JSON.stringify(borrowed).toLowerCase()
check('mirroring is never suggested', /mirror|flip horizont/.test(words), false)
check('no safe duration is implied', /under \d+ seconds is|safe if|3 seconds/.test(words), false)
check('the absence of a safe length is stated', words.includes('no length that is automatically safe'), true)

// --- Licence obligations ---------------------------------------------------

const credited = checkCopyright(
  [clip('c1', 'm1', 0, 10)],
  [media('m1', { from: 'library', source: 'Openverse', license: 'CC BY 4.0', author: 'Ada' })],
)
check('a credit is a low risk', credited.level, 'low')
check('the author is named', credited.findings[0].title, 'm1.mp4 needs Ada credited')
check('nothing needs changing for a credit', credited.findings[0].remedies[0].kind, 'manual')

const nonCommercial = checkCopyright(
  [clip('c1', 'm1', 0, 10)],
  [media('m1', { from: 'library', source: 'Openverse', license: 'CC BY-NC 4.0' })],
)
check('a non-commercial licence is a medium risk', nonCommercial.level, 'medium')

const free = checkCopyright(
  [clip('c1', 'm1', 0, 10)],
  [media('m1', { from: 'library', source: 'Wikimedia', license: 'CC0' })],
)
check('a cc0 file raises nothing', free.findings.length, 0)

// --- Files of unknown provenance -------------------------------------------

const unknown = checkCopyright([clip('c1', 'm1', 0, 10)], [media('m1', undefined)])
check('an unknown source is worth asking about', unknown.level, 'medium')
check('it is not counted as borrowed', unknown.borrowedSeconds, 0)

// --- Mostly somebody else's ------------------------------------------------

const reupload = checkCopyright(
  [clip('c1', 'm1', 0, 80), clip('c2', 'm2', 80, 20)],
  [media('m1', THEIRS), media('m2', MINE)],
)
const proportion = reupload.findings.find((finding) => finding.id === 'mostly-borrowed')
check('a near-reupload is called out', Boolean(proportion), true)
check('the proportion is stated', proportion?.reason.includes('80%'), true)

const quoted = checkCopyright(
  [clip('c1', 'm1', 0, 10), clip('c2', 'm2', 10, 90)],
  [media('m1', THEIRS), media('m2', MINE)],
)
check('a short quote is not called a reupload', quoted.findings.some((f) => f.id === 'mostly-borrowed'), false)

// --- Planning a change, without making it ----------------------------------

const clips = [clip('c1', 'm1', 0, 20), clip('c2', 'm1', 40, 10), clip('c3', 'm2', 20, 20)]
const items = [media('m1', THEIRS), media('m2', MINE)]
const finding = checkCopyright(clips, items).findings[0]

const muting = planRemedy(finding, 'mute', clips, items)
check('muting lists every clip it touches', muting?.lines.length, 2)
check('muting names the clip and when', muting?.lines[0], 'Mute "m1 clip" at 0s')
check('muting keeps every clip', muting?.clips.length, 3)
check('muting marks the borrowed ones', muting?.clips.filter((entry) => entry.muted).map((entry) => entry.id), ['c1', 'c2'])
check('muting leaves your own alone', muting?.clips.find((entry) => entry.id === 'c3')?.muted, undefined)

const removing = planRemedy(finding, 'remove', clips, items)
check('removing lists what goes', removing?.lines.length, 2)
check('removing leaves the rest', removing?.clips.map((entry) => entry.id), ['c3'])

check('advice plans no change at all', planRemedy(finding, 'manual', clips, items), null)

// Planning must not touch what it was given: the timeline only changes when the
// change is applied.
check('the original clips are untouched', clips.map((entry) => entry.muted), [undefined, undefined, undefined])
check('no clip was dropped while planning', clips.length, 3)

// Once the sound is off, muting must not be offered again as a change that
// would do nothing.
const already = [
  { ...clip('c1', 'm1', 0, 20), muted: true },
  { ...clip('c2', 'm1', 40, 10), muted: true },
]
const alreadyFinding = checkCopyright(already, [media('m1', THEIRS)]).findings[0]
check('muting silent clips is not offered', alreadyFinding.remedies.some((r) => r.kind === 'mute'), false)
check('muting them plans nothing', planRemedy(alreadyFinding, 'mute', already, [media('m1', THEIRS)]), null)
check('the picture is still flagged', alreadyFinding.level, 'high')
check('the sound being off is acknowledged', alreadyFinding.reason.includes('sound is already off'), true)
check('taking it out is still offered', alreadyFinding.remedies.some((r) => r.kind === 'remove'), true)

// A half-muted pair offers to finish the job, and only on what is left.
const half = [clip('c1', 'm1', 0, 20), { ...clip('c2', 'm1', 40, 10), muted: true }]
const halfPlan = planRemedy(checkCopyright(half, [media('m1', THEIRS)]).findings[0], 'mute', half, [media('m1', THEIRS)])
check('only the loud clip is muted', halfPlan?.lines.length, 1)
check('and it is the right one', halfPlan?.lines[0], 'Mute "m1 clip" at 0s')

// An image has no sound to remove, so muting it is not offered as a fix.
const stills = [clip('c1', 'm1', 0, 5, 'image')]
const stillItems = [media('m1', THEIRS, 'image')]
const stillFinding = checkCopyright(stills, stillItems).findings[0]
check('a still is still somebody\'s', stillFinding.level, 'high')
check('muting a still is not offered', stillFinding.remedies.some((r) => r.kind === 'mute'), false)
check('muting a still plans nothing', planRemedy(stillFinding, 'mute', stills, stillItems), null)

// --- Reaching it by asking -------------------------------------------------

// Worry about this gets phrased a dozen ways, and all of them should land on
// the check rather than on a shrug.
const spoken: ProjectState = {
  media: [media('m1', THEIRS)],
  clips: [clip('c1', 'm1', 0, 20)],
  tracks: [{ id: 'video-1', name: 'Video track', kind: 'video' }],
  overlays: [],
  playhead: 0,
  zoom: 12,
  selectedClipId: 'c1',
  memory: [],
}

const routed = (input: string) => interpretCommand(input, spoken).calls.map((entry) => entry.name)

for (const asked of [
  'is this going to get copyright flagged',
  'will i get a copyright strike',
  'could this get claimed',
  'will this get demonetised',
  'check the copyright on this',
  'am i going to get content id claims',
  'is any of this dmca',
]) {
  check(`"${asked}" reaches the check`, routed(asked).includes('check_copyright'), true)
}

// It must not fire on ordinary editing talk.
for (const asked of ['make this into a youtube short', 'cut the dead air', 'export this as mp4']) {
  check(`"${asked}" is left alone`, routed(asked).includes('check_copyright'), false)
}

// With nothing to look at there is nothing to check, so the question gets a
// general answer rather than a shrug.
const bare: ProjectState = { ...spoken, clips: [], media: [], selectedClipId: null }
check('an empty timeline runs no check', interpretCommand('will this get copyright claimed', bare).calls, [])

const general = converse('will this get copyright claimed', { connected: false, clips: 0, media: 0 })
check('and the question is still answered', general?.topic, 'copyright')
check('the answer names the real risk', general?.text.includes('music is what gets claimed most'), true)
check('the answer debunks the tricks', general?.text.includes('do not work'), true)
check('the answer points at YouTube Studio', general?.text.includes('YouTube Studio'), true)

// Someone asking how to publish should not get a lecture on copyright.
check('publishing is still its own topic', converse('how do i upload to youtube', { connected: false, clips: 0, media: 0 })?.topic, 'publish')

console.log(failures === 0 ? '\nAll copyright checks passed.' : `\n${failures} copyright check(s) failed.`)
process.exit(failures === 0 ? 0 : 1)
