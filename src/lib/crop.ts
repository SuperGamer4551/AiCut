import type { CSSProperties } from 'react'
import type { Crop } from './types'

export const FULL_CROP: Crop = { x: 0, y: 0, width: 1, height: 1 }

/** Keeps a crop window large enough to stay grabbable. */
export const MIN_CROP = 0.08

export type AspectPreset = {
  id: string
  label: string
  /** Width divided by height, or null for a free-form crop. */
  ratio: number | null
}

export const ASPECT_PRESETS: AspectPreset[] = [
  { id: 'free', label: 'Free', ratio: null },
  { id: '16:9', label: '16:9', ratio: 16 / 9 },
  { id: '1:1', label: '1:1', ratio: 1 },
  { id: '4:5', label: '4:5', ratio: 4 / 5 },
  { id: '9:16', label: '9:16', ratio: 9 / 16 },
]

export function isCropped(crop: Crop | undefined): boolean {
  if (!crop) return false
  return crop.x > 0.001 || crop.y > 0.001 || crop.width < 0.999 || crop.height < 0.999
}

export function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value))
}

export function clampCrop(crop: Crop): Crop {
  const width = Math.min(1, Math.max(MIN_CROP, crop.width))
  const height = Math.min(1, Math.max(MIN_CROP, crop.height))
  return {
    width,
    height,
    x: Math.min(1 - width, Math.max(0, crop.x)),
    y: Math.min(1 - height, Math.max(0, crop.y)),
  }
}

/**
 * Largest centered crop that yields the requested display aspect ratio for a
 * source of the given pixel dimensions.
 */
export function cropForAspect(ratio: number, mediaWidth: number, mediaHeight: number): Crop {
  const sourceRatio = mediaWidth / mediaHeight
  let width = 1
  let height = sourceRatio / ratio

  if (height > 1) {
    height = 1
    width = ratio / sourceRatio
  }

  return clampCrop({ width, height, x: (1 - width) / 2, y: (1 - height) / 2 })
}

/** Crop percentage of the source that a crop rect represents, for display. */
export function cropSummary(crop: Crop, mediaWidth?: number, mediaHeight?: number): string {
  if (!mediaWidth || !mediaHeight) {
    return `${Math.round(crop.width * 100)}% × ${Math.round(crop.height * 100)}%`
  }
  return `${Math.round(crop.width * mediaWidth)} × ${Math.round(crop.height * mediaHeight)}`
}

/** Editing overlay geometry, in percentages of the source frame. */
export function cropRectStyle(crop: Crop): CSSProperties {
  return {
    left: `${crop.x * 100}%`,
    top: `${crop.y * 100}%`,
    width: `${crop.width * 100}%`,
    height: `${crop.height * 100}%`,
  }
}

/**
 * Playback view of a crop: mask away everything outside the window, then scale
 * the remainder up to fit the frame without distorting it.
 */
export function croppedMediaStyle(crop: Crop | undefined): CSSProperties {
  if (!crop || !isCropped(crop)) return {}

  const scale = Math.min(1 / crop.width, 1 / crop.height)
  const centerX = crop.x + crop.width / 2
  const centerY = crop.y + crop.height / 2

  const inset = [
    crop.y * 100,
    (1 - crop.x - crop.width) * 100,
    (1 - crop.y - crop.height) * 100,
    crop.x * 100,
  ]
    .map((value) => `${value}%`)
    .join(' ')

  return {
    clipPath: `inset(${inset})`,
    transform: `scale(${scale}) translate(${-(centerX - 0.5) * 100}%, ${-(centerY - 0.5) * 100}%)`,
  }
}
