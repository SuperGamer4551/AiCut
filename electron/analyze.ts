import { spawn } from 'node:child_process'
import type { ClipMeasurement } from '../src/lib/analyze/highlights'
import { parseLoudness, parseSilences } from '../src/lib/analyze/highlights'
import { ffmpegBinary } from './exporter'

/**
 * Measuring a file with ffmpeg: per-second loudness and silent stretches. Audio
 * decoding only, so even a long recording is read in a few seconds.
 */

export type ClipAnalysis = ClipMeasurement

/** Windows for the loudness readings, in seconds. */
const WINDOW = 1

const SILENCE_THRESHOLD_DB = -32
const SILENCE_MIN_SECONDS = 0.6

const ANALYSIS_TIMEOUT_MS = 4 * 60 * 1000

function run(args: string[], timeoutMs = ANALYSIS_TIMEOUT_MS): Promise<{ output: string; failed: boolean }> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>

    try {
      child = spawn(ffmpegBinary(), args)
    } catch {
      resolve({ output: '', failed: true })
      return
    }

    let output = ''
    const timer = setTimeout(() => child.kill(), timeoutMs)

    // The filters print to stdout, the stream summary to stderr; both matter.
    child.stdout?.on('data', (chunk) => {
      output += String(chunk)
    })
    child.stderr?.on('data', (chunk) => {
      output += String(chunk)
    })

    child.on('error', () => {
      clearTimeout(timer)
      resolve({ output, failed: true })
    })
    child.on('close', () => {
      clearTimeout(timer)
      resolve({ output, failed: false })
    })
  })
}

function durationFrom(output: string): number {
  const match = /Duration:\s*(\d+):(\d{2}):(\d{2})(?:\.(\d+))?/.exec(output)
  if (!match) return 0
  return (
    Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(`0.${match[4] ?? 0}`)
  )
}

export async function analyzeClip(path: string): Promise<ClipAnalysis> {
  const empty: ClipAnalysis = { path, hasAudio: false, duration: 0, loudness: [], silences: [] }

  const measured = await run([
    '-hide_banner',
    '-i',
    path,
    '-map',
    '0:a:0?',
    '-af',
    [
      `astats=metadata=1:reset=${WINDOW}`,
      'ametadata=print:key=lavfi.astats.Overall.RMS_level',
      `silencedetect=noise=${SILENCE_THRESHOLD_DB}dB:d=${SILENCE_MIN_SECONDS}`,
    ].join(','),
    '-f',
    'null',
    '-',
  ])

  const duration = durationFrom(measured.output)
  const hasAudio = /Stream #\d+:\d+.*: Audio:/.test(measured.output)

  if (measured.failed && duration === 0) {
    return { ...empty, error: 'ffmpeg could not read that file.' }
  }

  if (!hasAudio) return { ...empty, duration, error: 'That file has no audio track to measure.' }

  return {
    path,
    hasAudio: true,
    duration,
    loudness: parseLoudness(measured.output),
    silences: parseSilences(measured.output).map((silence) => ({
      start: silence.start,
      end: Number.isFinite(silence.end) ? silence.end : duration,
    })),
  }
}
