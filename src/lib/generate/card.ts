/**
 * Making footage out of nothing. No model can invent a Fortnite match on this
 * computer, but a title card, an end card or a plain background with words on it
 * is a real video file, and ffmpeg draws one in about a second.
 *
 * The plan is pure so it can be asserted without running anything.
 */

import { quoteFilterValue } from '../export/plan'

export type CardLook = 'dark' | 'accent' | 'light'

export type CardRequest = {
  /** Words to draw. Empty means a plain background. */
  text: string
  seconds: number
  width: number
  height: number
  look: CardLook
  output: string
  /** Absolute path to a font file; without one the card is drawn blank. */
  font?: string
}

export type CardPlan = {
  args: string[]
  output: string
  width: number
  height: number
  seconds: number
  lines: string[]
}

export const CARD_MIN_SECONDS = 0.5
export const CARD_MAX_SECONDS = 30
export const CARD_DEFAULT_SECONDS = 5

/** How many characters read comfortably across a wide frame; a tall one takes fewer. */
const CHARS_PER_LINE = 24
const NARROW_CHARS_PER_LINE = 14
const MAX_LINES = 4

/**
 * Average glyph advance as a fraction of the font size, for the bold sans faces
 * ffmpeg will be handed. Only used to keep a line inside the frame, so being a
 * little pessimistic is the safe direction.
 */
const GLYPH_WIDTH = 0.54

/** Text stays inside this much of the frame, leaving a margin either side. */
const SAFE_WIDTH = 0.84

const LOOKS: Record<CardLook, { background: string; text: string; rule: string }> = {
  dark: { background: '0x0a0d15', text: 'white', rule: '0x4ae3a8' },
  accent: { background: '0x123b32', text: 'white', rule: '0x4ae3a8' },
  light: { background: '0xf2f5f7', text: '0x0a0d15', rule: '0x0f8f6b' },
}

export function readLook(value: unknown): CardLook | null {
  return value === 'dark' || value === 'accent' || value === 'light' ? value : null
}

export function cardSeconds(asked: unknown): number {
  const value = typeof asked === 'number' && Number.isFinite(asked) ? asked : CARD_DEFAULT_SECONDS
  return Math.min(CARD_MAX_SECONDS, Math.max(CARD_MIN_SECONDS, Math.round(value * 10) / 10))
}

/** Frame size for an aspect, at 1080 on its long edge. */
export function cardFrame(aspect: unknown): { width: number; height: number } {
  const ratio = typeof aspect === 'number' && aspect > 0 ? aspect : aspectFromWords(aspect)
  if (ratio && ratio < 1) return { width: 1080, height: Math.round(1080 / ratio / 2) * 2 }
  return { width: 1920, height: Math.round(1920 / (ratio ?? 16 / 9) / 2) * 2 }
}

function aspectFromWords(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const pair = /^(\d+)\s*[:x/]\s*(\d+)$/.exec(value.trim())
  if (pair) {
    const width = Number(pair[1])
    const height = Number(pair[2])
    return height > 0 ? width / height : null
  }
  if (/vertical|portrait|short|tiktok|reel/i.test(value)) return 9 / 16
  if (/square/i.test(value)) return 1
  return null
}

/**
 * drawtext draws one line at a time, so the words are broken up here rather
 * than fighting with escaped newlines inside a filter string.
 */
export function wrapText(text: string, perLine = CHARS_PER_LINE): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return []

  const lines: string[] = []
  let line = ''

  for (const word of words) {
    if (!line) {
      line = word
    } else if (`${line} ${word}`.length <= perLine) {
      line = `${line} ${word}`
    } else {
      lines.push(line)
      line = word
    }
  }
  if (line) lines.push(line)

  return lines
}

/**
 * A card holds a few lines, not a paragraph. Too many words are set narrower
 * first, and only what still does not fit is dropped.
 */
export function layoutText(text: string, width: number, height: number): string[] {
  const per = charsPerLine(width, height)
  const wrapped = wrapText(text, per)
  const lines = wrapped.length > MAX_LINES ? wrapText(text, Math.round(per * 1.7)) : wrapped

  if (lines.length <= MAX_LINES) return lines

  const kept = lines.slice(0, MAX_LINES)
  kept[MAX_LINES - 1] = `${kept[MAX_LINES - 1]}…`
  return kept
}

export function charsPerLine(width: number, height: number): number {
  return width >= height ? CHARS_PER_LINE : NARROW_CHARS_PER_LINE
}

/**
 * Big enough to read from a phone, small enough that the longest line still fits
 * across the frame. A tall frame is narrow, which is what caught the words out.
 */
export function cardFontSize(lines: string[], width: number, height: number): number {
  if (lines.length === 0) return 0

  const longest = Math.max(...lines.map((line) => line.length), 1)
  const byWidth = (width * SAFE_WIDTH) / (GLYPH_WIDTH * longest)
  const byHeight = height * (lines.length > 2 ? 0.075 : 0.1)

  return Math.max(20, Math.round(Math.min(byWidth, byHeight)))
}

export function buildCardPlan(request: CardRequest): CardPlan {
  const look = LOOKS[request.look] ?? LOOKS.dark
  const seconds = cardSeconds(request.seconds)
  const lines = request.font ? layoutText(request.text, request.width, request.height) : []

  const size = cardFontSize(lines, request.width, request.height)
  const gap = Math.round(size * 1.28)
  const block = gap * lines.length
  const top = Math.round((request.height - block) / 2)

  const filters = [`color=c=${look.background}:s=${request.width}x${request.height}:r=30:d=${seconds}`]

  lines.forEach((line, index) => {
    filters.push(
      [
        'drawtext=expansion=none',
        `fontfile=${quoteFilterValue(request.font ?? '')}`,
        `text=${quoteFilterValue(line)}`,
        `fontcolor=${look.text}`,
        `fontsize=${size}`,
        `borderw=${Math.max(1, Math.round(size * 0.035))}`,
        'bordercolor=black@0.55',
        'x=(w-text_w)/2',
        `y=${top + index * gap}`,
      ].join(':'),
    )
  })

  if (lines.length > 0) {
    // A short rule under the words, which reads as design rather than a blank.
    const ruleWidth = Math.round(request.width * 0.14)
    const ruleHeight = Math.max(3, Math.round(request.height * 0.005))
    filters.push(
      `drawbox=x=(iw-${ruleWidth})/2:y=${top + block + Math.round(gap * 0.35)}:w=${ruleWidth}:h=${ruleHeight}:color=${
        look.rule
      }:t=fill`,
    )
  }

  filters.push('vignette=PI/6', 'format=pix_fmts=yuv420p')

  return {
    args: [
      '-hide_banner',
      '-y',
      '-f',
      'lavfi',
      '-i',
      filters.join(','),
      '-f',
      'lavfi',
      '-i',
      `anullsrc=channel_layout=stereo:sample_rate=48000:d=${seconds}`,
      '-t',
      String(seconds),
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '20',
      '-c:a',
      'aac',
      '-b:a',
      '128k',
      '-shortest',
      '-movflags',
      '+faststart',
      request.output,
    ],
    output: request.output,
    width: request.width,
    height: request.height,
    seconds,
    lines,
  }
}

/** A file name that says what the card is, without depending on the clock. */
export function cardFileName(text: string, seconds: number): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return `${slug || 'card'}-${Math.round(seconds)}s.mp4`
}
