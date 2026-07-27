// An end-to-end check against a real file: ffmpeg measures it, the assistant
// picks the moment worth keeping, and the render comes out vertical and loud.
// Needs ffmpeg and takes about a minute.
// Run with: npm run check:live
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { analyzeClip } from '../electron/analyze'
import { ffmpegBinary } from '../electron/exporter'
import { systemFont } from '../electron/fonts'
import { findHighlights } from '../src/lib/analyze/highlights'
import { buildExportPlan } from '../src/lib/export/plan'
import { generateClip } from '../electron/generate'
import { frameForPlacement } from '../src/lib/overlay'
import type { MediaItem, TextOverlay, TimelineClip, Track } from '../src/lib/types'
import type { ProjectState } from '../src/lib/agent/types'
import { createHostBridge } from '../src/lib/agent/bridge'

// Outside Electron there is no app path to find the bundled binary from, so the
// same one the app ships with is pointed at directly.
if (!process.env.AICUT_FFMPEG) {
  const bundled = require('ffmpeg-static') as string | null
  if (bundled) process.env.AICUT_FFMPEG = bundled
}

let failures = 0

function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected)
  if (!pass) failures += 1
  console.log(`${pass ? 'pass' : 'FAIL'}  ${label}`)
  if (!pass) console.log(`      expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

function run(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegBinary(), args)
    let output = ''
    child.stdout.on('data', (chunk) => {
      output += String(chunk)
    })
    child.stderr.on('data', (chunk) => {
      output += String(chunk)
    })
    child.on('error', reject)
    child.on('close', (code) => (code === 0 ? resolve(output) : reject(new Error(output.slice(-800)))))
  })
}

/** Sixty quiet seconds with ten loud ones in the middle, like a kill in a match. */
async function makeGameplayClip(path: string): Promise<void> {
  await run([
    '-y',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=1920x1080:rate=30:duration=60',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:duration=60',
    '-af',
    "volume=0.001,volume=enable='between(t,30,40)':volume=100",
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-t',
    '60',
    path,
  ])
}

function meanVolume(output: string): number {
  const match = /mean_volume:\s*(-?[\d.]+)\s*dB/.exec(output)
  return match ? Number(match[1]) : Number.NaN
}

function frameSize(output: string): string {
  const match = /Video:.*?,\s*(\d{2,5}x\d{2,5})/.exec(output)
  return match ? match[1] : 'unknown'
}

/**
 * How far apart two renders are, in dB, optionally over one part of the frame.
 * Identical pictures come back as Infinity, so a low number means something was
 * drawn there.
 */
async function difference(a: string, b: string, crop?: string): Promise<number> {
  const filter = crop ? `[0:v]${crop}[x];[1:v]${crop}[y];[x][y]psnr` : 'psnr'
  const output = await run(['-hide_banner', '-i', a, '-i', b, '-lavfi', filter, '-f', 'null', '-'])
  const match = /average:\s*(inf|-?[\d.]+)/.exec(output)
  if (!match) return Number.NaN
  return match[1] === 'inf' ? Number.POSITIVE_INFINITY : Number(match[1])
}

const TOP_STRIP = 'crop=iw:ih*0.3:0:0'
const CORNER = 'crop=iw*0.35:ih*0.35:iw*0.62:ih*0.62'

async function main() {
  const folder = await mkdtemp(join(tmpdir(), 'aicut-live-'))
  const source = join(folder, 'gameplay.mp4')
  const output = join(folder, 'short.mp4')

  try {
    console.log('Building a test clip…')
    await makeGameplayClip(source)

    console.log('Measuring it…')
    const analysis = await analyzeClip(source)
    check('the clip is measured as a minute long', Math.round(analysis.duration), 60)
    check('the clip has audio', analysis.hasAudio, true)
    check('there is about one loudness reading per second', analysis.loudness.length >= 55, true)

    const [best] = findHighlights(analysis.loudness, { duration: 10, sourceDuration: analysis.duration })
    check('the loud ten seconds are found', best.start >= 28 && best.start <= 32, true)
    check('the peak sits inside the burst', best.peakAt >= 29 && best.peakAt <= 41, true)

    // The whole recipe, through the same bridge the app uses.
    const item: MediaItem = {
      id: 'm1',
      name: 'gameplay.mp4',
      path: source,
      url: '',
      kind: 'video',
      duration: analysis.duration,
      size: 0,
      width: 1920,
      height: 1080,
      loading: false,
    }
    const clip: TimelineClip = {
      id: 'c1',
      mediaId: 'm1',
      name: 'gameplay',
      kind: 'video',
      track: 'video-1',
      start: 12,
      duration: analysis.duration,
      color: '#3d7cff',
    }

    let state: ProjectState = {
      media: [item],
      clips: [clip],
      tracks: [
        { id: 'video-1', name: 'Video track', kind: 'video' },
        { id: 'audio-1', name: 'Audio track', kind: 'audio' },
      ],
      overlays: [],
      playhead: 0,
      zoom: 24,
      selectedClipId: 'c1',
      memory: [],
    }

    const bridge = createHostBridge({
      getState: () => state,
      applyState: (next) => {
        state = next
      },
      importDialog: async () => [],
      importPaths: async () => ({ items: [], failed: [] }),
      desktop: {
        analysis: { clip: async (path: string) => analyzeClip(path) },
      } as unknown as NonNullable<Window['aicut']>,
    })

    console.log('Making a short…')
    const short = await bridge.makeShort({ duration: 10 })
    console.log(`      ${short.summary}`)
    check('making the short succeeded', short.error, undefined)
    check('the short is ten seconds', state.clips[0].duration, 10)
    check('it was cut from the loud part of the file', (state.clips[0].offset ?? 0) >= 28, true)
    check('it was reframed to 9:16', Number((state.clips[0].crop?.width ?? 1).toFixed(3)), 0.316)
    check('it sits at the head of the timeline', state.clips[0].start, 0)

    console.log('Rendering it…')
    const built = buildExportPlan({
      clips: state.clips,
      tracks: state.tracks,
      media: state.media,
      probes: { [source]: { hasAudio: true } },
      settings: { output },
    })
    if ('error' in built) throw new Error(built.error)

    check('the render is vertical without being asked', [built.plan.width, built.plan.height], [1080, 1920])
    await run(built.plan.args)

    const rendered = await run(['-hide_banner', '-i', output, '-af', 'volumedetect', '-f', 'null', '-'])
    check('the rendered file is 1080x1920', frameSize(rendered), '1080x1920')
    check('the rendered file is ten seconds', /Duration: 00:00:1[01]/.test(rendered), true)

    // Compared against the quiet opening of the same file rather than a fixed
    // level, so the test does not depend on encoder gain.
    const quiet = await run([
      '-hide_banner', '-t', '10', '-i', source, '-af', 'volumedetect', '-f', 'null', '-',
    ])
    const gain = meanVolume(rendered) - meanVolume(quiet)
    console.log(`      ${meanVolume(rendered)} dB against ${meanVolume(quiet)} dB for the quiet opening`)
    check('the rendered audio came from the loud moment, not the quiet start', gain > 15, true)

    // --- Text and a corner insert, drawn for real -------------------------
    console.log('Rendering text and a corner insert…')
    const font = systemFont()
    check('a font is found to draw text with', typeof font, 'string')

    const base: TimelineClip = { ...clip, id: 'b1', start: 0, duration: 3, crop: undefined }
    const corner: TimelineClip = {
      ...clip,
      id: 'b2',
      track: 'video-2',
      start: 0,
      duration: 3,
      crop: undefined,
      frame: frameForPlacement('bottom-right'),
    }
    // The overlay lane sits first so it draws over the footage below it.
    const layered: Track[] = [
      { id: 'video-2', name: 'Memes & overlays', kind: 'video' },
      { id: 'video-1', name: 'Video track', kind: 'video' },
    ]
    const words: TextOverlay[] = [
      { id: 't1', text: 'clutch', start: 0, duration: 3, position: 'top', style: 'meme' },
    ]

    const outputs = {
      plain: join(folder, 'plain.mp4'),
      text: join(folder, 'text.mp4'),
      inset: join(folder, 'inset.mp4'),
    }

    async function render(
      label: keyof typeof outputs,
      clips: TimelineClip[],
      overlays: TextOverlay[],
    ) {
      const plan = buildExportPlan({
        clips,
        tracks: layered,
        media: state.media,
        overlays,
        probes: { [source]: { hasAudio: true } },
        settings: { output: outputs[label], font: font ?? undefined },
      })
      if ('error' in plan) throw new Error(plan.error)
      await run(plan.plan.args)
      return plan.plan
    }

    const plainPlan = await render('plain', [base], [])
    const textPlan = await render('text', [base], words)
    const insetPlan = await render('inset', [base, corner], [])

    check('the plain render draws no text', plainPlan.textCount, 0)
    check('the text render draws the one line', textPlan.textCount, 1)
    check('the text render carries no warning about a missing font', textPlan.warnings, [])
    check('the insert is composited rather than replacing the footage', insetPlan.clipCount, 2)
    check('the insert does not change the shape of the output', [insetPlan.width, insetPlan.height], [1920, 1080])

    const textTop = await difference(outputs.text, outputs.plain, TOP_STRIP)
    const textCorner = await difference(outputs.text, outputs.plain, CORNER)
    console.log(`      text: ${textTop} dB across the top, ${textCorner} dB in the corner`)
    // An untouched region is not bit-identical, since drawing anywhere shifts how
    // the encoder spends its bits, but it stays far above the drawn region.
    check('the text really is drawn across the top of the picture', textTop < 30, true)
    check('the text leaves the rest of the picture alone', textCorner > 35, true)

    const insetCorner = await difference(outputs.inset, outputs.plain, CORNER)
    const insetTop = await difference(outputs.inset, outputs.plain, TOP_STRIP)
    console.log(`      insert: ${insetCorner} dB in the corner, ${insetTop} dB across the top`)
    check('the insert really is drawn into the corner', insetCorner < 30, true)
    check('the insert leaves the rest of the picture alone', insetTop > 35, true)

    const textFile = await run(['-hide_banner', '-i', outputs.text, '-f', 'null', '-'])
    check('the text render is still full size', frameSize(textFile), '1920x1080')
    check('the text render is three seconds', /Duration: 00:00:0[34]/.test(textFile), true)

    // --- A card drawn from nothing ---------------------------------------
    // Through the same function the app's IPC calls, so the folder, the font and
    // the reported dimensions are all exercised.
    console.log('Drawing a card…')
    const drawn = await generateClip(folder, { text: 'Fortnite Highlights', seconds: 3, aspect: '9:16' })
    if ('error' in drawn) throw new Error(drawn.error)

    const cardPath = drawn.path
    check('the card was written where it says', existsSync(cardPath), true)
    check('the card is not an empty file', drawn.size > 10_000, true)
    check('the card reports the shape it drew', [drawn.width, drawn.height], [1080, 1920])
    // A vertical frame is narrow, so the two words are set on two lines.
    check('the card reports the words it laid out', drawn.lines, ['Fortnite', 'Highlights'])

    const cardFile = await run(['-hide_banner', '-i', cardPath, '-f', 'null', '-'])
    check('the card is vertical because it was asked to be', frameSize(cardFile), '1080x1920')
    check('the card is three seconds', /Duration: 00:00:0[34]/.test(cardFile), true)
    check('the card carries a silent audio track', /Audio: aac/.test(cardFile), true)

    // Against an empty background of the same colour: the words and the rule
    // are the only things that can account for a difference.
    const blank = await generateClip(folder, { text: '', seconds: 3, aspect: '9:16' })
    if ('error' in blank) throw new Error(blank.error)
    check('a card with no words draws none', blank.lines, [])

    const cardMiddle = await difference(cardPath, blank.path, 'crop=iw:ih*0.3:0:ih*0.35')
    const cardTop = await difference(cardPath, blank.path, TOP_STRIP)
    console.log(`      card: ${cardMiddle} dB across the middle, ${cardTop} dB across the top`)
    check('the words really are drawn on the card', cardMiddle < 40, true)
    check('the rest of the card is left plain', cardTop > 40, true)
  } finally {
    await rm(folder, { recursive: true, force: true })
  }

  console.log(`\nRESULT: ${failures === 0 ? 'pass' : `fail (${failures})`}`)
  process.exit(failures === 0 ? 0 : 1)
}

void main().catch((error) => {
  console.error(error)
  process.exit(1)
})
