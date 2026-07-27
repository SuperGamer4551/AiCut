// Assertions for the free "AI": reading ffmpeg's measurements, picking the
// moment worth keeping, mapping timeline time onto a source file, and the model
// endpoints that cost nothing.
// Run with: npm run check:highlights
import type { LoudnessPoint } from '../src/lib/analyze/highlights'
import {
  describeLoudness,
  findHighlights,
  keepRangesFrom,
  parseLevel,
  parseLoudness,
  parseSilences,
} from '../src/lib/analyze/highlights'
import type { TimelineClip } from '../src/lib/types'
import { sourceRangeOf, sourceTimeFor, timelineTimeFor, withinClip } from '../src/lib/playback'
import { MODEL_PRESETS, canReachModel, isLocalEndpoint, presetFor } from '../src/lib/agent/endpoints'

let failures = 0

function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected)
  if (!pass) failures += 1
  console.log(`${pass ? 'pass' : 'FAIL'}  ${label}`)
  if (!pass) console.log(`      expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

// --- Reading what ffmpeg printed -----------------------------------------

const AMETADATA = `
frame:0    pts:0       pts_time:0
lavfi.astats.Overall.RMS_level=-48.2
frame:1    pts:48000   pts_time:1
lavfi.astats.Overall.RMS_level=-45.9
frame:2    pts:96000   pts_time:2
lavfi.astats.Overall.RMS_level=-inf
`

check('loudness pairs are read off the metadata stream', parseLoudness(AMETADATA), [
  { time: 0, level: -48.2 },
  { time: 1, level: -45.9 },
  { time: 2, level: -91 },
])
check('a silent window reads as the floor, not NaN', parseLevel('-inf'), -91)
check('a number reads as itself', parseLevel(' -23.5 '), -23.5)
check('nonsense reads as nothing', parseLevel('quiet'), null)
check('output with no readings gives no points', parseLoudness('nothing to see'), [])
check(
  'a reading with no frame line before it is skipped',
  parseLoudness('lavfi.astats.Overall.RMS_level=-20'),
  [],
)

const SILENCE_LOG = `
[silencedetect @ 0x1] silence_start: 4.5
[silencedetect @ 0x1] silence_end: 7.25 | silence_duration: 2.75
[silencedetect @ 0x1] silence_start: 12
[silencedetect @ 0x1] silence_end: 13.5 | silence_duration: 1.5
`

check('silence intervals are paired up', parseSilences(SILENCE_LOG), [
  { start: 4.5, end: 7.25 },
  { start: 12, end: 13.5 },
])
check(
  'a file that fades out at the end has an open silence',
  parseSilences('silence_start: 9')[0].end,
  Number.POSITIVE_INFINITY,
)
check('a negative start clamps to zero', parseSilences('silence_start: -0.1\nsilence_end: 2')[0].start, 0)

// --- Turning silence into the parts worth keeping -------------------------

check('the gaps between silences are kept', keepRangesFrom([{ start: 4, end: 7 }], 10, 0), [
  { start: 0, end: 4 },
  { start: 7, end: 10 },
])
check(
  'padding widens each kept range without leaving the file',
  keepRangesFrom([{ start: 4, end: 7 }], 10, 0.5),
  [
    { start: 0, end: 4.5 },
    { start: 6.5, end: 10 },
  ],
)
check('a file with no silence is kept whole', keepRangesFrom([], 10, 0.15), [{ start: 0, end: 10 }])
check(
  'silence at the head is dropped',
  keepRangesFrom([{ start: 0, end: 3 }], 10, 0),
  [{ start: 3, end: 10 }],
)
check(
  'silence running to the end is dropped',
  keepRangesFrom([{ start: 6, end: 10 }], 10, 0),
  [{ start: 0, end: 6 }],
)
check(
  'padding that closes a gap merges the pieces',
  keepRangesFrom(
    [
      { start: 4, end: 4.2 },
      { start: 4.3, end: 4.5 },
    ],
    10,
    0.5,
  ).length,
  1,
)
check(
  'silences are read in order even when reported out of order',
  keepRangesFrom(
    [
      { start: 8, end: 9 },
      { start: 2, end: 3 },
    ],
    10,
    0,
  ),
  [
    { start: 0, end: 2 },
    { start: 3, end: 8 },
    { start: 9, end: 10 },
  ],
)

// --- Picking the highlight ------------------------------------------------

/** A quiet recording with a burst of noise, the shape of a gameplay clip. */
function gameplay(): LoudnessPoint[] {
  const points: LoudnessPoint[] = []
  for (let time = 0; time < 120; time += 1) {
    const loud = time >= 70 && time < 90
    points.push({ time, level: loud ? -14 : -40 })
  }
  return points
}

const best = findHighlights(gameplay(), { duration: 20, sourceDuration: 120 })
check('one window is chosen by default', best.length, 1)
check('the chosen window is the loud stretch', [best[0].start, best[0].end], [70, 90])
check('the peak inside it is reported', best[0].peakAt >= 70 && best[0].peakAt < 90, true)
check('the best window scores 1', best[0].score, 1)

const three = findHighlights(gameplay(), { duration: 10, sourceDuration: 120, count: 3 })
check('several windows can be asked for', three.length, 3)
check(
  'chosen windows never overlap',
  three.every((window, index) => index === 0 || window.start >= three[index - 1].end - 0.001),
  true,
)
check(
  'windows are returned in timeline order',
  three.map((window) => window.start),
  [...three.map((window) => window.start)].sort((a, b) => a - b),
)

const shortFile = findHighlights([{ time: 0, level: -20 }], { duration: 30, sourceDuration: 12 })
check('a file shorter than the target is the highlight', [shortFile[0].start, shortFile[0].end], [0, 12])
check('nothing measured means no highlight', findHighlights([], { duration: 10, sourceDuration: 60 }), [])
check(
  'a window never runs past the end of the file',
  findHighlights(gameplay(), { duration: 20, sourceDuration: 120, count: 5 }).every(
    (window) => window.end <= 120.001,
  ),
  true,
)

// Steady noise should not beat a real burst: a wall of music sits at -20
// throughout, while the action peaks above it.
const musical: LoudnessPoint[] = []
for (let time = 0; time < 60; time += 1) {
  musical.push({ time, level: time >= 40 && time < 50 ? -8 : -20 })
}
check(
  'a burst above steady music wins',
  findHighlights(musical, { duration: 10, sourceDuration: 60 })[0].start,
  40,
)

check(
  'the summary reports the average, the peak and the silence',
  describeLoudness(
    [
      { time: 0, level: -30 },
      { time: 1, level: -10 },
    ],
    [{ start: 5, end: 7 }],
  ),
  'Average level -20.0 dB, loudest at 1.0s (-10.0 dB). 1 silent stretch totalling 2.0s.',
)
check('a clip with no audio is described as such', describeLoudness([], []), 'The clip has no audio to measure.')

// --- Timeline time against source time ------------------------------------

const trimmed: TimelineClip = {
  id: 'c1',
  mediaId: 'm1',
  name: 'gameplay',
  kind: 'video',
  track: 'video-1',
  start: 5,
  duration: 20,
  offset: 70,
  color: '#3d7cff',
}

check('the head of a trimmed clip points at its in-point', sourceTimeFor(trimmed, 5), 70)
check('ten seconds in reads ten seconds past the in-point', sourceTimeFor(trimmed, 15), 80)
check('before the clip clamps to the in-point', sourceTimeFor(trimmed, 0), 70)
check('past the clip clamps to the out-point', sourceTimeFor(trimmed, 999), 90)
check('the mapping reverses', timelineTimeFor(trimmed, 80), 15)
check('a source time before the in-point clamps to zero', timelineTimeFor(trimmed, 0), 0)
check('with no clip the playhead is the source time', sourceTimeFor(null, 12), 12)
check('an untrimmed clip maps straight through', sourceTimeFor({ ...trimmed, start: 0, offset: 0 }, 8), 8)
check('the playhead inside the clip is inside', withinClip(trimmed, 10), true)
check('the playhead past the clip is outside', withinClip(trimmed, 26), false)
check('the scrubber spans the visible part of the file', sourceRangeOf(trimmed, 200), { from: 70, to: 90 })
check('with no clip the scrubber spans the whole file', sourceRangeOf(null, 200), { from: 0, to: 200 })

// --- Free places to get a model from -------------------------------------

check('a local runtime is recognised', isLocalEndpoint('http://localhost:11434/v1'), true)
check('a loopback address is recognised', isLocalEndpoint('http://127.0.0.1:1234/v1'), true)
check('a hosted endpoint is not local', isLocalEndpoint('https://api.openai.com/v1'), false)
check('a host merely containing localhost is not local', isLocalEndpoint('https://localhost.example.com/v1'), false)
check('nonsense is not local', isLocalEndpoint('not a url'), false)
check('a local model needs no key', canReachModel('http://localhost:11434/v1', false), true)
check('a hosted model needs a key', canReachModel('https://api.groq.com/openai/v1', false), false)
check('a hosted model with a key is reachable', canReachModel('https://api.groq.com/openai/v1', true), true)
check('every preset carries a model and a hint', MODEL_PRESETS.every((preset) => Boolean(preset.model && preset.hint)), true)
check('most presets are free', MODEL_PRESETS.filter((preset) => preset.free).length >= 4, true)
check('local presets need no key', MODEL_PRESETS.filter((preset) => !preset.needsKey).every((preset) => isLocalEndpoint(preset.baseUrl)), true)
check('a base url maps back to its preset', presetFor('http://localhost:11434/v1/')?.id, 'ollama')
check('an unknown base url maps to no preset', presetFor('https://example.com/v1'), null)

console.log(`\nRESULT: ${failures === 0 ? 'pass' : `fail (${failures})`}`)
process.exit(failures === 0 ? 0 : 1)
