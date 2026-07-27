// Assertions for timeline placement (snapping, magnetic clicking, no overlaps),
// track management, crop math, and workspace docking.
// Run with: npm run check:timeline
import type { TimelineClip } from '../src/lib/types'
import {
  INITIAL_TRACKS,
  MAX_ZOOM,
  MIN_ZOOM,
  RULER_LABEL_MIN_PX,
  addTrack,
  clampZoom,
  defaultTrackId,
  endOfTrack,
  placeClip,
  rulerSteps,
} from '../src/lib/timeline'
import { clampCrop, cropForAspect, isCropped } from '../src/lib/crop'
import { updateLabel } from '../src/lib/update'
import {
  DEFAULT_LAYOUT,
  DEFAULT_SIZES,
  MIN_CENTER_PX,
  SIZE_LIMITS,
  clampSize,
  fitSizes,
  maxSize,
  movePanel,
  normalizeLayout,
  normalizeSizes,
  sizesEqual,
  swapZones,
  zoneOfPanel,
} from '../src/lib/layout'

const ZOOM = 20 // pixels per second, so the 9px snap threshold is 0.45s

let failures = 0

// Key order is irrelevant when comparing plain objects.
function normalize(value: unknown): string {
  return JSON.stringify(value, (_key, inner) => {
    if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
      return Object.fromEntries(Object.entries(inner).sort(([a], [b]) => a.localeCompare(b)))
    }
    return inner
  })
}

function check(label: string, actual: unknown, expected: unknown) {
  const pass = normalize(actual) === normalize(expected)
  if (!pass) failures += 1
  console.log(`${pass ? 'pass' : 'FAIL'}  ${label}`)
  if (!pass) console.log(`      expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

function clip(id: string, start: number, duration: number, track: TimelineClip['track'] = 'V1'): TimelineClip {
  return {
    id,
    mediaId: `m-${id}`,
    name: id,
    kind: track === 'A1' ? 'audio' : 'video',
    track,
    start,
    duration,
    color: '#3d7cff',
  }
}

const place = (args: {
  clips: TimelineClip[]
  track?: TimelineClip['track']
  excludeId?: string | null
  desiredStart: number
  duration: number
  playhead?: number
}) =>
  placeClip({
    clips: args.clips,
    track: args.track ?? 'V1',
    excludeId: args.excludeId ?? null,
    desiredStart: args.desiredStart,
    duration: args.duration,
    zoom: ZOOM,
    playhead: args.playhead ?? 0,
  })

const existing = [clip('a', 0, 10), clip('b', 20, 5)]

check(
  'drop near a clip end clicks flush against it',
  place({ clips: existing, desiredStart: 10.3, duration: 4 }),
  { start: 10, snappedTo: 10 },
)

check(
  'drop whose end lands near a clip start clicks flush before it',
  place({ clips: existing, desiredStart: 15.8, duration: 4 }),
  { start: 16, snappedTo: 20 },
)

check(
  'overlapping drop slides to the nearest free slot',
  place({ clips: existing, desiredStart: 8, duration: 4 }),
  { start: 10, snappedTo: 10 },
)

check(
  'drop inside a gap that is too small moves past the blocking clip',
  place({ clips: [clip('a', 0, 10), clip('b', 12, 5)], desiredStart: 11, duration: 6 }),
  { start: 17, snappedTo: 17 },
)

check(
  'far-from-anything drop keeps its exact position',
  place({ clips: existing, desiredStart: 40, duration: 3 }),
  { start: 40, snappedTo: null },
)

check(
  'negative drop clamps to the start of the sequence',
  place({ clips: [], desiredStart: -5, duration: 3 }),
  { start: 0, snappedTo: 0 },
)

check(
  'clips snap to the playhead',
  place({ clips: [], desiredStart: 7.2, duration: 3, playhead: 7 }),
  { start: 7, snappedTo: 7 },
)

check(
  'clip edges on other tracks are snap targets',
  place({ clips: [clip('v', 0, 8, 'V1')], track: 'A1', desiredStart: 8.2, duration: 4 }),
  { start: 8, snappedTo: 8 },
)

check(
  'moving a clip ignores its own footprint',
  place({ clips: existing, excludeId: 'a', desiredStart: 0.2, duration: 10 }),
  { start: 0, snappedTo: 0 },
)

check(
  'a full track appends at the end instead of overlapping',
  place({ clips: [clip('a', 0, 10)], excludeId: null, desiredStart: 2, duration: 30 }),
  { start: 10, snappedTo: 10 },
)

// No arrangement of drops may ever produce an overlap.
let stress: TimelineClip[] = []
for (let i = 0; i < 60; i += 1) {
  const desiredStart = Math.round(Math.random() * 60 * 100) / 100
  const duration = 1 + Math.round(Math.random() * 6 * 100) / 100
  const { start } = place({ clips: stress, desiredStart, duration })
  stress = [...stress, clip(`s${i}`, start, duration)]
}

const sorted = [...stress].sort((a, b) => a.start - b.start)
const overlap = sorted.find((entry, index) => {
  const next = sorted[index + 1]
  return next !== undefined && entry.start + entry.duration > next.start + 1e-6
})
check('60 random drops never overlap', overlap === undefined, true)

check('audio defaults to the audio track', defaultTrackId(INITIAL_TRACKS, 'audio'), 'audio-1')
check('video defaults to the first video track', defaultTrackId(INITIAL_TRACKS, 'video'), 'video-1')
check('images go on a video track', defaultTrackId(INITIAL_TRACKS, 'image'), 'video-1')
check('end of track reports the last clip end', endOfTrack(existing, 'V1'), 25)

// Track management
const withVideo = addTrack(INITIAL_TRACKS, 'video')
check('new video track is named and numbered', withVideo.track, {
  id: 'video-2',
  name: 'Video track 2',
  kind: 'video',
})
check(
  'video tracks stack above audio tracks',
  withVideo.tracks.map((track) => track.id),
  ['video-1', 'video-2', 'audio-1'],
)
check(
  'new audio track is appended below',
  addTrack(withVideo.tracks, 'audio').tracks.map((track) => track.id),
  ['video-1', 'video-2', 'audio-1', 'audio-2'],
)
check(
  'renamed tracks do not block the default name',
  addTrack([{ id: 'video-1', name: 'B-roll', kind: 'video' }], 'video').track.name,
  'Video track',
)

// Crop math
check('a full-frame crop is not considered cropped', isCropped({ x: 0, y: 0, width: 1, height: 1 }), false)
check('a partial crop is considered cropped', isCropped({ x: 0.1, y: 0, width: 0.8, height: 1 }), true)
check('undefined crop is not considered cropped', isCropped(undefined), false)
check('16:9 crop of a 16:9 source is the full frame', cropForAspect(16 / 9, 1920, 1080), {
  x: 0,
  y: 0,
  width: 1,
  height: 1,
})
check('square crop of a 16:9 source is centered', cropForAspect(1, 1920, 1080), {
  x: 0.21875,
  y: 0,
  width: 0.5625,
  height: 1,
})
check('9:16 crop of a 16:9 source keeps full height', cropForAspect(9 / 16, 1920, 1080), {
  x: 0.341796875,
  y: 0,
  width: 0.31640625,
  height: 1,
})
check('crops are clamped inside the frame', clampCrop({ x: 0.9, y: -0.4, width: 0.5, height: 0.5 }), {
  x: 0.5,
  y: 0,
  width: 0.5,
  height: 0.5,
})
check('crops cannot shrink below the minimum', clampCrop({ x: 0, y: 0, width: 0.01, height: 0.5 }).width, 0.08)

// A 9:16 crop must actually produce 9:16 pixels.
const vertical = cropForAspect(9 / 16, 1920, 1080)
check(
  '9:16 crop yields 9:16 pixel dimensions',
  ((vertical.width * 1920) / (vertical.height * 1080)).toFixed(4),
  (9 / 16).toFixed(4),
)

// Zoom clamping
check('zoom clamps to the minimum', clampZoom(0.5), MIN_ZOOM)
check('zoom clamps to the maximum', clampZoom(5000), MAX_ZOOM)
check('zoom passes through in range', clampZoom(37.5), 37.5)
check('non-numeric zoom falls back to the minimum', clampZoom(Number.NaN), MIN_ZOOM)

// Ruler spacing: labels must never crowd, at any zoom level.
const crowded: number[] = []
const tooCoarse: number[] = []
for (let zoomLevel = MIN_ZOOM; zoomLevel <= MAX_ZOOM; zoomLevel += 0.5) {
  const { labelStep, minorStep } = rulerSteps(zoomLevel)
  if (labelStep * zoomLevel < RULER_LABEL_MIN_PX) crowded.push(zoomLevel)
  // Labels should also not be needlessly sparse (more than ~4x the minimum).
  if (labelStep * zoomLevel > RULER_LABEL_MIN_PX * 4) tooCoarse.push(zoomLevel)
  if (minorStep > 0 && Math.abs(labelStep / minorStep - Math.round(labelStep / minorStep)) > 1e-9) {
    tooCoarse.push(zoomLevel)
  }
}
check('ruler labels never overlap at any zoom', crowded, [])
check('ruler labels stay reasonably dense and aligned to minor ticks', tooCoarse, [])
check('zoomed out far, labels fall on round intervals', rulerSteps(MIN_ZOOM), {
  labelStep: 30,
  minorStep: 6,
})
check('at default zoom, labels are every 5 seconds', rulerSteps(24), { labelStep: 5, minorStep: 1 })
check('zoomed in far, labels are every second', rulerSteps(MAX_ZOOM), {
  labelStep: 1,
  minorStep: 0.2,
})

// Panel docking
check('panels report their zone', zoneOfPanel(DEFAULT_LAYOUT, 'timeline'), 'bottom')
check('an absent panel has no zone', zoneOfPanel({ ...DEFAULT_LAYOUT, bottom: 'media' }, 'timeline'), null)
check('swapping two zones trades their panels', swapZones(DEFAULT_LAYOUT, 'left', 'bottom'), {
  left: 'timeline',
  center: 'preview',
  bottom: 'media',
  right: 'ai',
})
check('swapping a zone with itself changes nothing', swapZones(DEFAULT_LAYOUT, 'left', 'left'), DEFAULT_LAYOUT)
check('moving a panel onto another swaps them', movePanel(DEFAULT_LAYOUT, 'timeline', 'left'), {
  left: 'timeline',
  center: 'preview',
  bottom: 'media',
  right: 'ai',
})
check('moving a panel to its own zone changes nothing', movePanel(DEFAULT_LAYOUT, 'media', 'left'), DEFAULT_LAYOUT)

// Every panel stays present after any sequence of moves.
const shuffled = movePanel(
  movePanel(movePanel(DEFAULT_LAYOUT, 'ai', 'center'), 'media', 'bottom'),
  'timeline',
  'right',
)
check('shuffling keeps all four panels docked', [...new Set(Object.values(shuffled))].sort(), [
  'ai',
  'media',
  'preview',
  'timeline',
])

// Stored layouts can be stale or corrupt, so restoring must be defensive.
check('a valid stored layout is kept', normalizeLayout({ ...DEFAULT_LAYOUT, left: 'timeline', bottom: 'media' }), {
  left: 'timeline',
  center: 'preview',
  bottom: 'media',
  right: 'ai',
})
check('a duplicated panel falls back to the default', normalizeLayout({ left: 'media', center: 'media', bottom: 'timeline', right: 'ai' }), DEFAULT_LAYOUT)
check('an unknown panel falls back to the default', normalizeLayout({ left: 'nope', center: 'preview', bottom: 'timeline', right: 'ai' }), DEFAULT_LAYOUT)
check('a missing zone falls back to the default', normalizeLayout({ left: 'media', center: 'preview' }), DEFAULT_LAYOUT)
check('nothing stored falls back to the default', normalizeLayout(null), DEFAULT_LAYOUT)

// Panel sizing
check('a size below the minimum clamps up', clampSize('left', 20), SIZE_LIMITS.left.min)
check('a size above the maximum clamps down', clampSize('left', 5000), SIZE_LIMITS.left.max)
check('a size in range is kept and rounded', clampSize('left', 301.4), 301)
check('a non-numeric size falls back to the default', clampSize('gutter', Number.NaN), DEFAULT_SIZES.gutter)
check('an explicit ceiling wins over the limit', clampSize('left', 500, 300), 300)
check('a ceiling below the minimum still respects the minimum', clampSize('left', 40, 10), SIZE_LIMITS.left.min)
check('the track name column can shrink smaller than the panels', SIZE_LIMITS.gutter.min < SIZE_LIMITS.left.min, true)
check('garbage stored sizes fall back to defaults', normalizeSizes({ left: 'wide' }), DEFAULT_SIZES)
check('identical sizes compare equal', sizesEqual(DEFAULT_SIZES, { ...DEFAULT_SIZES }), true)
check('differing sizes compare unequal', sizesEqual(DEFAULT_SIZES, { ...DEFAULT_SIZES, bottom: 200 }), false)

// The middle column keeps room no matter how far the sides are dragged.
check('the left column cannot squeeze out the centre', maxSize('left', DEFAULT_SIZES, 1200, 800), 1200 - DEFAULT_SIZES.right - MIN_CENTER_PX)
const wide = fitSizes({ left: 560, right: 600, bottom: 340, gutter: 168 }, 1000, 700)
check('a narrow window shrinks both side columns', wide.left + wide.right + MIN_CENTER_PX <= 1000, true)
check('shrunken columns stay at or above their minimum', wide.left >= SIZE_LIMITS.left.min && wide.right >= SIZE_LIMITS.right.min, true)
const short = fitSizes({ ...DEFAULT_SIZES, bottom: 900 }, 1600, 500)
check('a short window shrinks the bottom row', short.bottom, 500 - 140)
check('a comfortable window leaves sizes untouched', fitSizes(DEFAULT_SIZES, 1600, 900), DEFAULT_SIZES)

// --- What the updater says out loud ---------------------------------------
// Silence is the right answer for most of it: the status bar should not narrate
// a check that found nothing, or an updater that has not been asked anything.
check('an idle updater says nothing', updateLabel({ status: 'idle' }), null)
check('being up to date says nothing', updateLabel({ status: 'current' }), null)
check('a check in progress says nothing', updateLabel({ status: 'checking' }), null)
check('running from source says nothing', updateLabel({ status: 'unsupported' }), null)
check('a failed check does not nag', updateLabel({ status: 'error', message: 'no host' }), null)
check(
  'a download in progress reports how far along it is',
  updateLabel({ status: 'downloading', version: '0.9.0', percent: 42 }),
  'Downloading 0.9.0 42%',
)
check(
  'a download with no percent yet still reads sensibly',
  updateLabel({ status: 'downloading', version: '0.9.0' }),
  'Downloading 0.9.0 0%',
)
check('one waiting to be installed names the version', updateLabel({ status: 'ready', version: '0.9.0' }), 'Version 0.9.0 is ready')

console.log(failures === 0 ? '\nRESULT: pass' : `\nRESULT: fail (${failures})`)
process.exit(failures === 0 ? 0 : 1)
