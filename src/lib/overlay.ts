import type { Frame, TextOverlay, TextPosition, TextStyle } from './types'

/**
 * Everything on top of the footage: words burnt into the picture, and clips that
 * sit in a corner of the frame instead of filling it. Shared by the preview and
 * the renderer so what is seen is what is exported.
 */

export const DEFAULT_TEXT_SECONDS = 3
export const MIN_TEXT_SECONDS = 0.3
export const MAX_TEXT_LENGTH = 120

export type TextLook = {
  /** Font size as a fraction of the frame height. */
  size: number
  /** Outline width, also a fraction of the height. */
  border: number
  /** A dark band behind the words, for readability over busy footage. */
  box: boolean
  color: string
  uppercase: boolean
  position: TextPosition
}

export const TEXT_STYLES: Record<TextStyle, TextLook> = {
  // The classic loud caption: white, heavy black outline, shouted.
  meme: { size: 0.082, border: 0.006, box: false, color: 'white', uppercase: true, position: 'top' },
  // A hook or a title card, sat in the middle of the frame.
  title: { size: 0.07, border: 0.002, box: true, color: 'white', uppercase: false, position: 'middle' },
  // A quieter line along the bottom, for names and asides.
  caption: { size: 0.045, border: 0.002, box: true, color: 'white', uppercase: false, position: 'bottom' },
}

export const TEXT_STYLE_NAMES = Object.keys(TEXT_STYLES) as TextStyle[]

export function isTextStyle(value: string): value is TextStyle {
  return (TEXT_STYLE_NAMES as string[]).includes(value)
}

export function isTextPosition(value: string): value is TextPosition {
  return value === 'top' || value === 'middle' || value === 'bottom'
}

/** Trimmed to one line, since a line is what gets drawn. */
export function cleanText(value: string): string {
  return value.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT_LENGTH)
}

export function displayText(overlay: TextOverlay): string {
  return TEXT_STYLES[overlay.style].uppercase ? overlay.text.toUpperCase() : overlay.text
}

export function overlayEnd(overlay: TextOverlay): number {
  return overlay.start + overlay.duration
}

/** The overlays covering a moment, in the order they were added. */
export function overlaysAt(overlays: TextOverlay[], time: number): TextOverlay[] {
  return overlays.filter((overlay) => time >= overlay.start - 1e-6 && time < overlayEnd(overlay))
}

export type Placement =
  | 'full'
  | 'top-left'
  | 'top-right'
  | 'bottom-left'
  | 'bottom-right'
  | 'center'

const PLACEMENTS: Record<Exclude<Placement, 'full'>, Frame> = {
  'top-left': { x: 0.04, y: 0.05, width: 0.34, height: 0.34 },
  'top-right': { x: 0.62, y: 0.05, width: 0.34, height: 0.34 },
  'bottom-left': { x: 0.04, y: 0.61, width: 0.34, height: 0.34 },
  'bottom-right': { x: 0.62, y: 0.61, width: 0.34, height: 0.34 },
  center: { x: 0.25, y: 0.3, width: 0.5, height: 0.4 },
}

export const PLACEMENT_NAMES = ['full', ...Object.keys(PLACEMENTS)] as Placement[]

const PLACEMENT_WORDS: Record<string, Placement> = {
  full: 'full',
  fullscreen: 'full',
  cutaway: 'full',
  whole: 'full',
  cover: 'full',
  reset: 'full',
  corner: 'top-right',
  'top right': 'top-right',
  'top-right': 'top-right',
  topright: 'top-right',
  'upper right': 'top-right',
  'top left': 'top-left',
  'top-left': 'top-left',
  topleft: 'top-left',
  'upper left': 'top-left',
  'bottom right': 'bottom-right',
  'bottom-right': 'bottom-right',
  bottomright: 'bottom-right',
  'lower right': 'bottom-right',
  'bottom left': 'bottom-left',
  'bottom-left': 'bottom-left',
  bottomleft: 'bottom-left',
  'lower left': 'bottom-left',
  center: 'center',
  centre: 'center',
  middle: 'center',
}

export function readPlacement(value: unknown): Placement | null {
  if (typeof value !== 'string') return null
  const raw = value.trim().toLowerCase()
  return PLACEMENT_WORDS[raw] ?? null
}

/**
 * The rectangle a placement means, scaled about its own centre so "smaller" and
 * "bigger" keep the inset where it was.
 */
export function frameForPlacement(placement: Placement, size = 1): Frame | undefined {
  if (placement === 'full') return undefined

  const base = PLACEMENTS[placement]
  const scale = Math.max(0.1, Math.min(1, size))
  if (scale === 1) return base

  const width = base.width * scale
  const height = base.height * scale
  return {
    x: clampFraction(base.x + (base.width - width) / 2, width),
    y: clampFraction(base.y + (base.height - height) / 2, height),
    width,
    height,
  }
}

function clampFraction(value: number, span: number): number {
  return Math.max(0, Math.min(1 - span, value))
}

/** Which placement a frame matches, for reporting it back in words. */
export function describeFrame(frame: Frame | undefined): string {
  if (!frame) return 'full frame'

  const match = (Object.keys(PLACEMENTS) as Exclude<Placement, 'full'>[]).find((name) => {
    const candidate = PLACEMENTS[name]
    return Math.abs(candidate.x - frame.x) < 0.12 && Math.abs(candidate.y - frame.y) < 0.12
  })

  const size = `${Math.round(frame.width * 100)}% wide`
  return match ? `${match.replace('-', ' ')}, ${size}` : size
}

/** Zooms a crop rectangle in about its centre, for a punch-in on the action. */
export function tightenCrop(
  crop: { x: number; y: number; width: number; height: number } | undefined,
  amount: number,
): { x: number; y: number; width: number; height: number } {
  const current = crop ?? { x: 0, y: 0, width: 1, height: 1 }
  const scale = 1 / Math.max(1.05, Math.min(4, amount))

  const width = current.width * scale
  const height = current.height * scale
  return {
    x: current.x + (current.width - width) / 2,
    y: current.y + (current.height - height) / 2,
    width,
    height,
  }
}
