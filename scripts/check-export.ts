// Assertions for rendering: the ffmpeg command built from a timeline, and how
// the binary is located and its progress read.
// Run with: npm run check:export
import type { MediaItem, TextOverlay, TimelineClip, Track } from '../src/lib/types'
import {
  buildExportPlan,
  drawTextFilter,
  extensionFor,
  formatFor,
  frameFor,
  parseResolution,
  progressFromLine,
  quoteFilterValue,
} from '../src/lib/export/plan'
import {
  buildCardPlan,
  cardFileName,
  cardFontSize,
  cardFrame,
  cardSeconds,
  charsPerLine,
  layoutText,
  readLook,
  wrapText,
} from '../src/lib/generate/card'
import { frameForPlacement } from '../src/lib/overlay'
import { ffmpegCandidates, resolveFfmpeg } from '../electron/exporter'
import { fontCandidates, pickFont } from '../electron/fonts'

let failures = 0

function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected)
  if (!pass) failures += 1
  console.log(`${pass ? 'pass' : 'FAIL'}  ${label}`)
  if (!pass) console.log(`      expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

function media(name: string, kind: MediaItem['kind'], duration: number, width = 1920, height = 1080): MediaItem {
  return {
    id: `m-${name}`,
    name,
    path: `C:/clips/${name}`,
    url: '',
    kind,
    duration,
    size: 1024,
    width: kind === 'audio' ? undefined : width,
    height: kind === 'audio' ? undefined : height,
    loading: false,
  }
}

function clip(
  name: string,
  track: string,
  start: number,
  duration: number,
  extra: Partial<TimelineClip> = {},
): TimelineClip {
  return {
    id: `c-${name}`,
    mediaId: `m-${name}`,
    name,
    kind: track.startsWith('audio') ? 'audio' : 'video',
    track,
    start,
    duration,
    color: '#3d7cff',
    ...extra,
  }
}

const TRACKS: Track[] = [
  { id: 'video-2', name: 'Video track 2', kind: 'video' },
  { id: 'video-1', name: 'Video track', kind: 'video' },
  { id: 'audio-1', name: 'Audio track', kind: 'audio' },
]

const VIDEO = media('shot.mp4', 'video', 12)
const SONG = media('song.mp3', 'audio', 30)
const STILL = media('logo.png', 'image', 5)

function plan(args: {
  clips: TimelineClip[]
  media?: MediaItem[]
  overlays?: TextOverlay[]
  probes?: Record<string, { hasAudio: boolean }>
  settings?: Partial<{ output: string; format: string; resolution: string; fps: number; font: string }>
}) {
  const built = buildExportPlan({
    clips: args.clips,
    tracks: TRACKS,
    media: args.media ?? [VIDEO, SONG, STILL],
    overlays: args.overlays,
    probes: args.probes ?? { 'C:/clips/shot.mp4': { hasAudio: true }, 'C:/clips/song.mp3': { hasAudio: true } },
    settings: { output: 'C:/out/final.mp4', ...args.settings },
  })

  if ('error' in built) throw new Error(built.error)
  return built.plan
}

const FONT = 'C:\\Windows\\Fonts\\arial.ttf'

function overlay(text: string, extra: Partial<TextOverlay> = {}): TextOverlay {
  return {
    id: `t-${text.slice(0, 6)}`,
    text,
    start: 0,
    duration: 3,
    position: 'middle',
    style: 'title',
    ...extra,
  }
}

const graphOf = (args: string[]): string => args[args.indexOf('-filter_complex') + 1]

// --- Formats and sizes ----------------------------------------------------
check('mp4 is the default container', formatFor(undefined), 'mp4')
check('an unknown container falls back to mp4', formatFor('gif'), 'mp4')
check('webm is honoured', formatFor('WEBM'), 'webm')
check('a leading dot is tolerated', formatFor('.mov'), 'mov')
check('the extension follows the container', extensionFor('webm'), 'webm')

check('an explicit size is parsed', parseResolution('1280x720'), [1280, 720])
check('a shorthand size is parsed', parseResolution('1080p'), [1920, 1080])
check('"vertical" means portrait HD', parseResolution('vertical'), [1080, 1920])
check('"square" is square', parseResolution('square'), [1080, 1080])
check('an unknown size falls back to the source', parseResolution('enormous', [1440, 1080]), [1440, 1080])
check('odd sizes are made even for the encoder', parseResolution(undefined, [1921, 1081]), [1920, 1080])

// --- Refusals -------------------------------------------------------------
const empty = buildExportPlan({ clips: [], tracks: TRACKS, media: [VIDEO], settings: { output: 'C:/a.mp4' } })
check('an empty timeline cannot be rendered', 'error' in empty, true)

const noOutput = buildExportPlan({
  clips: [clip('shot.mp4', 'video-1', 0, 5)],
  tracks: TRACKS,
  media: [VIDEO],
  settings: { output: '  ' },
})
check('a render needs an output path', 'error' in noOutput, true)

const orphan = buildExportPlan({
  clips: [clip('gone.mp4', 'video-1', 0, 5)],
  tracks: TRACKS,
  media: [],
  settings: { output: 'C:/a.mp4' },
})
check('a clip with no media left is refused', 'error' in orphan, true)

const partial = plan({
  clips: [clip('shot.mp4', 'video-1', 0, 5), clip('gone.mp4', 'video-1', 6, 4)],
})
check('a missing file is skipped, not fatal', partial.clipCount, 1)
check('the skip is reported as a warning', partial.warnings[0].includes('gone.mp4'), true)

// --- A single clip --------------------------------------------------------
const single = plan({ clips: [clip('shot.mp4', 'video-1', 0, 5)] })
check('the source is passed as an input', single.args.includes('C:/clips/shot.mp4'), true)
check('overwriting is allowed', single.args[0], '-y')
check('the output path comes last', single.args[single.args.length - 1], 'C:/out/final.mp4')
check('the render length matches the timeline', single.duration, 5)
check('the size comes from the source', [single.width, single.height], [1920, 1080])
check('x264 encodes mp4', single.args.includes('libx264'), true)
check('the clip is trimmed to its length', graphOf(single.args).includes('trim=start=0:end=5'), true)
check('a black canvas spans the render', graphOf(single.args).includes('color=c=black:s=1920x1080:r=30:d=5'), true)
check('the clip is only visible during its window', graphOf(single.args).includes("enable='between(t,0,5)'"), true)
check('the picture is mapped out', single.args.includes('[vout]'), true)
check('the length is capped exactly', single.args[single.args.length - 3], '-t')

// --- Audio ----------------------------------------------------------------
check('a clip with sound is mixed in', single.hasAudio, true)
check('the sound is mapped out', single.args.includes('[aout]'), true)
check('a silent bed keeps the track full length', graphOf(single.args).includes('anullsrc'), true)
check('aac encodes mp4 audio', single.args.includes('aac'), true)

const silent = plan({ clips: [clip('shot.mp4', 'video-1', 0, 5)], probes: { 'C:/clips/shot.mp4': { hasAudio: false } } })
check('a source with no audio stream is not mapped', silent.hasAudio, false)
check('a silent render disables audio', silent.args.includes('-an'), true)
check('a silent render has no mixer', graphOf(silent.args).includes('amix'), false)

const offsetAudio = plan({ clips: [clip('shot.mp4', 'video-1', 0, 5), clip('song.mp3', 'audio-1', 3, 10)] })
check('a delayed audio clip is delayed in the mix', graphOf(offsetAudio.args).includes('adelay=3000:all=1'), true)
check('every audio source plus the bed is mixed', graphOf(offsetAudio.args).includes('amix=inputs=3'), true)
check('the render runs to the last clip', offsetAudio.duration, 13)

const musicOnly = plan({ clips: [clip('song.mp3', 'audio-1', 0, 8)] })
check('an audio-only timeline still renders', musicOnly.duration, 8)
check('an audio-only render warns about the picture', musicOnly.warnings[0].includes('black'), true)

// --- Position, crop, and stills ------------------------------------------
const shifted = plan({ clips: [clip('shot.mp4', 'video-1', 4, 6)] })
check('a clip that starts late is shifted', graphOf(shifted.args).includes('setpts=PTS+4/TB'), true)
check('a shifted clip shows only in its window', graphOf(shifted.args).includes("enable='between(t,4,10)'"), true)

const cropped = plan({
  clips: [clip('shot.mp4', 'video-1', 0, 5, { crop: { x: 0.25, y: 0, width: 0.5, height: 1 } })],
})
check('a crop becomes a crop filter', graphOf(cropped.args).includes('crop=w=iw*0.5:h=ih*1:x=iw*0.25:y=ih*0'), true)

const uncropped = plan({
  clips: [clip('shot.mp4', 'video-1', 0, 5, { crop: { x: 0, y: 0, width: 1, height: 1 } })],
})
check('a full-frame crop is left out', graphOf(uncropped.args).includes('crop='), false)

// --- Clips that start part way into their file ----------------------------
const fromMiddle = plan({ clips: [clip('shot.mp4', 'video-1', 0, 4, { offset: 6 })] })
check('an in-point becomes the trim start', graphOf(fromMiddle.args).includes('trim=start=6:end=10'), true)
check('the trimmed piece still starts at zero on the timeline', graphOf(fromMiddle.args).includes('setpts=PTS-STARTPTS'), true)
check('the render is as long as the piece, not the file', fromMiddle.duration, 4)

const shiftedMiddle = plan({ clips: [clip('shot.mp4', 'video-1', 5, 4, { offset: 6 })] })
check('a shifted clip with an in-point trims and shifts', graphOf(shiftedMiddle.args).includes('trim=start=6:end=10'), true)
check('and still lands at its timeline position', graphOf(shiftedMiddle.args).includes('setpts=PTS+5/TB'), true)

const audioFromMiddle = plan({ clips: [clip('song.mp3', 'audio-1', 0, 5, { offset: 12 })] })
check('an audio in-point becomes the atrim start', graphOf(audioFromMiddle.args).includes('atrim=start=12:end=17'), true)

const pieces = plan({
  clips: [
    clip('shot.mp4', 'video-1', 0, 3, { offset: 0 }),
    { ...clip('shot.mp4', 'video-1', 3, 3, { offset: 8 }), id: 'c-second' },
  ],
})
check('two pieces of one file are trimmed separately', graphOf(pieces.args).includes('trim=start=8:end=11'), true)
check('both pieces are laid out on the timeline', pieces.duration, 6)

// --- The output frame follows the crop ------------------------------------
check('an uncropped clip renders at its source size', frameFor(clip('shot.mp4', 'video-1', 0, 5), VIDEO), [1920, 1080])
check(
  'a 9:16 crop renders as a vertical short',
  frameFor(clip('shot.mp4', 'video-1', 0, 5, { crop: { x: 0.34, y: 0, width: 0.3164, height: 1 } }), VIDEO),
  [1080, 1920],
)
check(
  'a square crop renders square',
  frameFor(clip('shot.mp4', 'video-1', 0, 5, { crop: { x: 0.22, y: 0, width: 0.5625, height: 1 } }), VIDEO),
  [1080, 1080],
)
check('a source with no dimensions falls back to 1080p', frameFor(clip('song.mp3', 'audio-1', 0, 5), SONG), [1920, 1080])
check('nothing at all falls back to 1080p', frameFor(undefined, undefined), [1920, 1080])

const verticalRender = plan({
  clips: [clip('shot.mp4', 'video-1', 0, 5, { crop: { x: 0.34, y: 0, width: 0.3164, height: 1 } })],
})
check('a vertical timeline renders 1080x1920 without being asked', [verticalRender.width, verticalRender.height], [1080, 1920])
check('the canvas matches the vertical frame', graphOf(verticalRender.args).includes('s=1080x1920'), true)

const overridden = plan({
  clips: [clip('shot.mp4', 'video-1', 0, 5, { crop: { x: 0.34, y: 0, width: 0.3164, height: 1 } })],
  settings: { resolution: '1280x720' },
})
check('an explicit size still wins', [overridden.width, overridden.height], [1280, 720])

const still = plan({ clips: [clip('logo.png', 'video-1', 0, 4)] })
check('a still is looped', still.args.includes('-loop'), true)
check('a still is cut to length on the input', still.args[still.args.indexOf('-t')], '-t')
check('a still is not trimmed in the graph', graphOf(still.args).includes('trim='), false)

// --- Layering -------------------------------------------------------------
const layered = plan({
  clips: [clip('shot.mp4', 'video-1', 0, 5), clip('logo.png', 'video-2', 0, 5)],
})
const graph = graphOf(layered.args)
check('the upper track is composited last', graph.indexOf('[c0][v1]') > graph.indexOf('[base][v0]'), true)
check('each clip gets its own input', layered.args.filter((arg) => arg === '-i').length, 2)

// --- Overrides ------------------------------------------------------------
const vertical = plan({ clips: [clip('shot.mp4', 'video-1', 0, 5)], settings: { resolution: 'vertical' } })
check('a requested size is used', [vertical.width, vertical.height], [1080, 1920])
check('the canvas follows the requested size', graphOf(vertical.args).includes('s=1080x1920'), true)
check('clips are letterboxed into the canvas', graphOf(vertical.args).includes('pad=1080:1920'), true)

const webm = plan({ clips: [clip('shot.mp4', 'video-1', 0, 5)], settings: { format: 'webm', output: 'C:/out/final.webm' } })
check('webm uses vp9', webm.args.includes('libvpx-vp9'), true)
check('webm uses opus', webm.args.includes('libopus'), true)
check('mp4 gets faststart', single.args.includes('+faststart'), true)
check('webm does not get faststart', webm.args.includes('+faststart'), false)

const slow = plan({ clips: [clip('shot.mp4', 'video-1', 0, 5)], settings: { fps: 24 } })
check('a frame rate can be set', slow.fps, 24)
check('the frame rate reaches the encoder', slow.args[slow.args.indexOf('-r') + 1], '24')

// --- Text drawn into the picture ------------------------------------------
check('a value is wrapped so a colon cannot split the filter', quoteFilterValue('C:/a.ttf'), "'C:/a.ttf'")
check('a backslash is doubled', quoteFilterValue('C:\\Fonts\\a.ttf'), "'C:\\\\Fonts\\\\a.ttf'")
check("an apostrophe closes and reopens the quote", quoteFilterValue("it's"), "'it'\\''s'")

const memeText = drawTextFilter(overlay('gg go next', { style: 'meme', position: 'top' }), { width: 1080, height: 1920 }, FONT)
check('the words reach drawtext', memeText.includes("text='GG GO NEXT'"), true)
check('a meme line is shouted', memeText.includes('GG GO NEXT'), true)
check('the font size scales with the frame', memeText.includes('fontsize=157'), true)
check('a meme line gets a heavy outline', memeText.includes('borderw=12'), true)
check('a meme line has no box', memeText.includes('box=1'), false)
check('text is centred across the frame', memeText.includes('x=(w-text_w)/2'), true)
check('top text sits near the top edge', memeText.includes('y=115'), true)
check('expansion is off so a percent sign is literal', memeText.includes('expansion=none'), true)

const titleText = drawTextFilter(overlay('wait for it', { start: 1.5, duration: 2 }), { width: 1920, height: 1080 }, FONT)
check('a title is boxed for readability', titleText.includes('box=1'), true)
check('a title sits in the middle', titleText.includes('y=(h-text_h)/2'), true)
check('text only shows in its own window', titleText.includes("enable='between(t,1.5,3.5)'"), true)

const caption = drawTextFilter(overlay('shot by me', { style: 'caption', position: 'bottom' }), { width: 1920, height: 1080 }, FONT)
check('a caption sits above the bottom edge', caption.includes('y=h-text_h-86'), true)

const titled = plan({
  clips: [clip('shot.mp4', 'video-1', 0, 5)],
  overlays: [overlay('subscribe', { start: 0, duration: 2 })],
  settings: { font: FONT },
})
check('text is drawn into the render', graphOf(titled.args).includes('drawtext'), true)
check('the text count is reported', titled.textCount, 1)
check('text is drawn after the last clip is composited', graphOf(titled.args).indexOf('drawtext') > graphOf(titled.args).indexOf('[base][v0]'), true)
check('the drawn picture is what gets mapped out', graphOf(titled.args).includes('[text]format=yuv420p[vout]'), true)

const fontless = plan({ clips: [clip('shot.mp4', 'video-1', 0, 5)], overlays: [overlay('subscribe')] })
check('without a font, text is skipped rather than failing', fontless.textCount, 0)
check('a missing font is explained', fontless.warnings[0].includes('font'), true)
check('a missing font leaves the graph alone', graphOf(fontless.args).includes('drawtext'), false)

const blankText = plan({
  clips: [clip('shot.mp4', 'video-1', 0, 5)],
  overlays: [overlay('   ')],
  settings: { font: FONT },
})
check('empty text is not drawn', blankText.textCount, 0)

// --- Clips parked in a corner of the frame --------------------------------
check('a corner placement is a small rectangle', frameForPlacement('top-right'), { x: 0.62, y: 0.05, width: 0.34, height: 0.34 })
check('full frame means no rectangle at all', frameForPlacement('full'), undefined)
check('a smaller inset stays where it was, about its centre', frameForPlacement('top-right', 0.5), {
  x: 0.705,
  y: 0.135,
  width: 0.17,
  height: 0.17,
})

const inset = plan({
  clips: [
    clip('shot.mp4', 'video-1', 0, 5),
    { ...clip('logo.png', 'video-2', 1, 2), frame: { x: 0.62, y: 0.05, width: 0.34, height: 0.34 } },
  ],
})
const insetGraph = graphOf(inset.args)
check('an inset is scaled into its own box', insetGraph.includes('scale=652:366:force_original_aspect_ratio=decrease'), true)
check('an inset is not letterboxed to the full frame', insetGraph.includes('pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=30[v1]'), false)
check('an inset is placed at its own corner', insetGraph.includes('overlay=x=1190:y=54'), true)
check('the full-frame clip still starts at the origin', insetGraph.includes('overlay=x=0:y=0'), true)

const insetOnly = plan({
  clips: [{ ...clip('shot.mp4', 'video-1', 0, 5), frame: { x: 0.62, y: 0.05, width: 0.34, height: 0.34 } }],
})
check('an inset clip does not decide the output shape on its own', [insetOnly.width, insetOnly.height], [1920, 1080])

const verticalWithInset = plan({
  clips: [
    clip('shot.mp4', 'video-1', 0, 5, { crop: { x: 0.34, y: 0, width: 0.3164, height: 1 } }),
    { ...clip('logo.png', 'video-2', 0, 2), frame: { x: 0.04, y: 0.61, width: 0.34, height: 0.34 } },
  ],
})
check('the full-frame clip sets the shape, not the inset', [verticalWithInset.width, verticalWithInset.height], [1080, 1920])

// --- Finding a font -------------------------------------------------------
const windowsFonts = fontCandidates('win32', { windir: 'C:\\Windows' })
check('windows fonts are looked for in the fonts folder', windowsFonts[0].includes('Fonts'), true)
check('an override is tried first', fontCandidates('win32', { override: 'D:/my.ttf' })[0], 'D:/my.ttf')
check('mac has its own list', fontCandidates('darwin')[0].startsWith('/System/'), true)
check('anything else is treated as linux', fontCandidates('freebsd')[0].includes('/usr/share/fonts'), true)
check('the first font present wins', pickFont(['a.ttf', 'b.ttf'], (file) => file === 'b.ttf'), 'b.ttf')
check('no fonts at all is reported as none', pickFont(['a.ttf'], () => false), null)

// --- Drawing a clip from nothing -----------------------------------------
const card = buildCardPlan({
  text: 'Fortnite Highlights',
  seconds: 5,
  width: 1920,
  height: 1080,
  look: 'dark',
  output: 'C:/generated/card.mp4',
  font: 'C:\\Windows\\Fonts\\seguivar.ttf',
})
const cardGraph = card.args[card.args.indexOf('-i') + 1]
check('a card starts from a colour source', cardGraph.startsWith('color=c=0x0a0d15:s=1920x1080'), true)
check('the card lasts as long as asked', cardGraph.includes(':d=5'), true)
check('the words are drawn', cardGraph.includes("text='Fortnite Highlights'"), true)
check('long text is broken into lines', card.lines, ['Fortnite Highlights'])
check('a rule is drawn under the words', cardGraph.includes('drawbox='), true)
check('the font path is escaped for the filter', cardGraph.includes("fontfile='C:\\\\Windows\\\\Fonts\\\\seguivar.ttf'"), true)
check('the card is encoded for playback anywhere', card.args.includes('yuv420p') || cardGraph.includes('yuv420p'), true)
check('the card carries silent audio', card.args.some((arg) => arg.startsWith('anullsrc')), true)
check('the output path is last', card.args[card.args.length - 1], 'C:/generated/card.mp4')

const blank = buildCardPlan({
  text: '',
  seconds: 3,
  width: 1080,
  height: 1920,
  look: 'accent',
  output: 'C:/generated/blank.mp4',
  font: 'C:/f.ttf',
})
check('a card with no words draws none', blank.args[blank.args.indexOf('-i') + 1].includes('drawtext'), false)
check('a card with no words has no rule either', blank.args[blank.args.indexOf('-i') + 1].includes('drawbox'), false)
check('an accent card has its own colour', blank.args[blank.args.indexOf('-i') + 1].includes('color=c=0x123b32'), true)

const cardWithoutFont = buildCardPlan({
  text: 'Nothing to draw with',
  seconds: 4,
  width: 1920,
  height: 1080,
  look: 'dark',
  output: 'C:/generated/x.mp4',
})
check('without a font the words are skipped rather than mangled', cardWithoutFont.lines.length, 0)

check('a long line wraps', wrapText('subscribe for more fortnite highlights every single day'), [
  'subscribe for more',
  'fortnite highlights',
  'every single day',
])
check('no words wrap to no lines', wrapText('   '), [])
check('a tall frame takes fewer characters per line', charsPerLine(1080, 1920) < charsPerLine(1920, 1080), true)
check('a vertical card breaks two words onto two lines', layoutText('Fortnite Highlights', 1080, 1920), ['Fortnite', 'Highlights'])
check('a wide card keeps them on one', layoutText('Fortnite Highlights', 1920, 1080), ['Fortnite Highlights'])
check(
  'too many words are set narrower rather than thrown away',
  layoutText('subscribe for more fortnite highlights every single day', 1080, 1920),
  ['subscribe for more', 'fortnite highlights', 'every single day'],
)
const paragraph = layoutText(
  'one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen',
  1080,
  1920,
)
check('a paragraph is still cut off somewhere', paragraph.length, 4)
check('the cut-off line says there was more', paragraph[3].endsWith('…'), true)

// The bug this caught: a vertical frame is narrow, and sizing from its height
// alone ran the words off both edges.
const tall = layoutText('Fortnite Highlights', 1080, 1920)
check('a vertical card sizes its text to the width', cardFontSize(tall, 1080, 1920) < 1920 * 0.1, true)
check(
  'the longest line stays inside the frame',
  cardFontSize(tall, 1080, 1920) * 0.54 * Math.max(...tall.map((line) => line.length)) < 1080,
  true,
)
check('a single short word is still set large', cardFontSize(['GG'], 1080, 1920), 192)
check('no words need no size', cardFontSize([], 1080, 1920), 0)

check('a default card is five seconds', cardSeconds(undefined), 5)
check('an absurd length is capped', cardSeconds(600), 30)
check('a length of nothing still has a frame or two', cardSeconds(0), 0.5)
check('a written length is rounded to a tenth', cardSeconds(4.44), 4.4)
check('the default shape is landscape', cardFrame(undefined), { width: 1920, height: 1080 })
check('"9:16" is vertical', cardFrame('9:16'), { width: 1080, height: 1920 })
check('"vertical" is vertical too', cardFrame('vertical'), { width: 1080, height: 1920 })
check('a square is square', cardFrame('square'), { width: 1920, height: 1920 })
check('a ratio as a number is understood', cardFrame(9 / 16), { width: 1080, height: 1920 })
check('a look it does not have falls back', readLook('neon'), null)
check('a file name says what the card is', cardFileName('Fortnite Highlights!', 5), 'fortnite-highlights-5s.mp4')
check('a card with no words still has a name', cardFileName('', 3), 'card-3s.mp4')

// --- Progress -------------------------------------------------------------
check('progress is read from ffmpeg output', progressFromLine('frame=  120 fps=30 time=00:00:05.00 bitrate=1000', 10), 0.5)
check('progress at the end is complete', progressFromLine('time=00:00:10.00', 10), 1)
check('progress cannot exceed one', progressFromLine('time=00:00:99.00', 10), 1)
check('a line without a time gives nothing', progressFromLine('frame=1 fps=30', 10), null)
check('a zero-length render gives nothing', progressFromLine('time=00:00:01.00', 0), null)
check('hours are read', progressFromLine('time=01:00:00.00', 7200), 0.5)

// --- Finding ffmpeg -------------------------------------------------------
const candidates = ffmpegCandidates({ resourcesPath: 'C:/app/resources', appPath: 'C:/app' })
check('the packaged copy is tried first', candidates[0].includes('resources'), true)
check('the development copy is tried next', candidates[1].includes('ffmpeg-static'), true)
check('PATH is the last resort', candidates[candidates.length - 1].startsWith('ffmpeg'), true)
check('an override is tried before anything else', ffmpegCandidates({ override: 'D:/ffmpeg.exe' })[0], 'D:/ffmpeg.exe')

check(
  'the first existing binary wins',
  resolveFfmpeg({ resourcesPath: 'C:/app/resources', appPath: 'C:/app', exists: (c) => c.includes('ffmpeg-static') }).includes(
    'ffmpeg-static',
  ),
  true,
)
check(
  'a packaged copy is preferred over the development one',
  resolveFfmpeg({ resourcesPath: 'C:/app/resources', appPath: 'C:/app', exists: () => true }).includes('resources'),
  true,
)
check(
  'with nothing on disk it falls back to PATH',
  resolveFfmpeg({ resourcesPath: 'C:/app/resources', appPath: 'C:/app', exists: () => false }).startsWith('ffmpeg'),
  true,
)

console.log(failures === 0 ? '\nRESULT: pass' : `\nRESULT: fail (${failures})`)
if (failures > 0) process.exitCode = 1
