/**
 * Picking the interesting part of a clip from its audio, so a long recording can
 * be cut down without a model and without any paid service.
 *
 * Loudness is a crude proxy for excitement, but for gameplay and talking-head
 * footage it is a good one: shots, hits, shouting and laughter are all loud, and
 * dead air is quiet.
 */

export type LoudnessPoint = {
  /** Seconds into the file. */
  time: number
  /** RMS level in dBFS, so quiet is around -60 and loud is near 0. */
  level: number
}

/** What measuring a file with ffmpeg produces. */
export type ClipMeasurement = {
  path: string
  hasAudio: boolean
  duration: number
  loudness: LoudnessPoint[]
  silences: { start: number; end: number }[]
  error?: string
}

export type Highlight = {
  start: number
  end: number
  /** 0 to 1, relative to the loudest window found. */
  score: number
  /** Loudest instant inside the window, which is usually the moment itself. */
  peakAt: number
}

const SILENT_FLOOR = -91

/** Levels ffmpeg could not measure come through as -inf. */
export function parseLevel(value: string): number | null {
  const raw = value.trim()
  if (!raw) return null
  if (/^-?inf$/i.test(raw)) return SILENT_FLOOR

  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : null
}

/**
 * Reads the frame/metadata pairs ffmpeg's ametadata filter prints:
 *
 *   frame:12  pts:576000  pts_time:12
 *   lavfi.astats.Overall.RMS_level=-23.5
 */
export function parseLoudness(output: string): LoudnessPoint[] {
  const points: LoudnessPoint[] = []
  let time: number | null = null

  for (const line of output.split(/\r?\n/)) {
    const frame = /pts_time:\s*([\d.]+)/.exec(line)
    if (frame) {
      time = Number(frame[1])
      continue
    }

    const level = /RMS_level=\s*(\S+)/.exec(line)
    if (level && time !== null) {
      const parsed = parseLevel(level[1])
      if (parsed !== null) points.push({ time, level: parsed })
      time = null
    }
  }

  return points
}

/** Silence intervals from ffmpeg's silencedetect filter. */
export function parseSilences(output: string): { start: number; end: number }[] {
  const silences: { start: number; end: number }[] = []
  let start: number | null = null

  for (const line of output.split(/\r?\n/)) {
    const opened = /silence_start:\s*(-?[\d.]+)/.exec(line)
    if (opened) {
      start = Math.max(0, Number(opened[1]))
      continue
    }

    const closed = /silence_end:\s*([\d.]+)/.exec(line)
    if (closed && start !== null) {
      silences.push({ start, end: Number(closed[1]) })
      start = null
    }
  }

  // A file that fades out ends mid-silence, with no closing line.
  if (start !== null) silences.push({ start, end: Number.POSITIVE_INFINITY })

  return silences
}

/** The parts worth keeping: everything that is not silence, with a little air. */
export function keepRangesFrom(
  silences: { start: number; end: number }[],
  duration: number,
  padding = 0.15,
): { start: number; end: number }[] {
  const ranges: { start: number; end: number }[] = []
  let cursor = 0

  for (const silence of [...silences].sort((a, b) => a.start - b.start)) {
    const gapStart = Math.max(0, Math.min(silence.start, duration))
    if (gapStart - cursor > 0.01) {
      ranges.push({ start: Math.max(0, cursor - padding), end: Math.min(duration, gapStart + padding) })
    }
    cursor = Math.max(cursor, Math.min(silence.end, duration))
  }

  if (duration - cursor > 0.01) {
    ranges.push({ start: Math.max(0, cursor - padding), end: duration })
  }

  // Padding can make neighbours touch, in which case they are really one piece.
  const merged: { start: number; end: number }[] = []
  for (const range of ranges) {
    const last = merged[merged.length - 1]
    if (last && range.start - last.end < 0.05) {
      last.end = Math.max(last.end, range.end)
      continue
    }
    merged.push({ ...range })
  }

  return merged
}

function averageBetween(points: LoudnessPoint[], from: number, to: number): number {
  const inside = points.filter((point) => point.time >= from && point.time < to)
  if (inside.length === 0) return SILENT_FLOOR
  return inside.reduce((sum, point) => sum + point.level, 0) / inside.length
}

function loudestBetween(points: LoudnessPoint[], from: number, to: number): LoudnessPoint | null {
  const inside = points.filter((point) => point.time >= from && point.time < to)
  if (inside.length === 0) return null
  return inside.reduce((best, point) => (point.level > best.level ? point : best))
}

/**
 * Scores every window of the requested length and returns the best few, without
 * overlaps. A window is judged on how loud it is on average and on how much its
 * loudest moment stands out, which favours a burst of action over a steady wall
 * of noise.
 */
export function findHighlights(
  points: LoudnessPoint[],
  options: {
    duration: number
    sourceDuration: number
    count?: number
    /** How far apart candidate windows are tried. */
    step?: number
  },
): Highlight[] {
  const want = Math.max(1, options.duration)
  const total = Math.max(0, options.sourceDuration)
  const count = Math.max(1, options.count ?? 1)

  if (points.length === 0 || total <= 0) return []

  // Nothing to choose from: the whole file is the highlight.
  if (total <= want * 1.05) {
    const peak = loudestBetween(points, 0, total)
    return [{ start: 0, end: total, score: 1, peakAt: peak?.time ?? 0 }]
  }

  const step = options.step ?? Math.max(0.5, want / 6)
  const overall = averageBetween(points, 0, total)

  const candidates: Highlight[] = []
  const steps = Math.floor((total - want) / step + 0.001)

  for (let index = 0; index <= steps; index += 1) {
    // Counted rather than accumulated, so window bounds stay round numbers.
    const start = Math.round(index * step * 1000) / 1000
    const end = start + want
    const mean = averageBetween(points, start, end)
    const peak = loudestBetween(points, start, end)
    if (!peak) continue

    // dB are negative, so shifting by the file's own average keeps the numbers
    // comparable between a quiet recording and a loud one.
    const raw = (mean - overall) * 1.5 + (peak.level - overall) * 0.5
    candidates.push({ start, end, score: raw, peakAt: peak.time })
  }

  if (candidates.length === 0) return []

  const best = Math.max(...candidates.map((candidate) => candidate.score))
  const worst = Math.min(...candidates.map((candidate) => candidate.score))
  const spread = best - worst || 1

  const ranked = candidates
    .map((candidate) => ({ ...candidate, score: (candidate.score - worst) / spread }))
    .sort((a, b) => b.score - a.score)

  const chosen: Highlight[] = []
  for (const candidate of ranked) {
    if (chosen.length >= count) break
    const clashes = chosen.some(
      (taken) => candidate.start < taken.end - 0.001 && candidate.end > taken.start + 0.001,
    )
    if (!clashes) chosen.push(candidate)
  }

  return chosen.sort((a, b) => a.start - b.start)
}

/** A sentence about the audio, for the transcript and for the model to read. */
export function describeLoudness(points: LoudnessPoint[], silences: { start: number; end: number }[]): string {
  if (points.length === 0) return 'The clip has no audio to measure.'

  const levels = points.map((point) => point.level)
  const average = levels.reduce((sum, level) => sum + level, 0) / levels.length
  const peak = points.reduce((best, point) => (point.level > best.level ? point : best))
  const quiet = silences.reduce((sum, silence) => sum + (silence.end - silence.start), 0)

  return [
    `Average level ${average.toFixed(1)} dB, loudest at ${peak.time.toFixed(1)}s (${peak.level.toFixed(1)} dB).`,
    silences.length === 0
      ? 'No silent stretches.'
      : `${silences.length} silent stretch${silences.length === 1 ? '' : 'es'} totalling ${quiet.toFixed(1)}s.`,
  ].join(' ')
}
