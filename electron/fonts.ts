import { existsSync } from 'node:fs'
import path from 'node:path'

/**
 * Finding a font file for ffmpeg's text drawing. drawtext needs a path to a
 * real font, so the usual system fonts are tried in turn and the first one
 * present wins.
 */

const WINDOWS = ['segoeuib.ttf', 'arialbd.ttf', 'impact.ttf', 'segoeui.ttf', 'arial.ttf', 'calibrib.ttf']

const MAC = [
  '/System/Library/Fonts/Supplemental/Impact.ttf',
  '/System/Library/Fonts/Supplemental/Arial Bold.ttf',
  '/System/Library/Fonts/Supplemental/Arial.ttf',
  '/System/Library/Fonts/Helvetica.ttc',
  '/Library/Fonts/Arial.ttf',
]

const LINUX = [
  '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf',
  '/usr/share/fonts/truetype/freefont/FreeSansBold.ttf',
  '/usr/share/fonts/TTF/DejaVuSans.ttf',
]

export function fontCandidates(
  platform: string,
  env: { windir?: string; override?: string } = {},
): string[] {
  const candidates: string[] = []
  if (env.override) candidates.push(env.override)

  if (platform === 'win32') {
    const root = env.windir ?? 'C:\\Windows'
    candidates.push(...WINDOWS.map((name) => path.join(root, 'Fonts', name)))
  } else if (platform === 'darwin') {
    candidates.push(...MAC)
  } else {
    candidates.push(...LINUX)
  }

  return candidates
}

/** The first candidate that exists, or null when the machine has none of them. */
export function pickFont(candidates: string[], exists: (file: string) => boolean): string | null {
  return candidates.find((candidate) => exists(candidate)) ?? null
}

export function systemFont(): string | null {
  return pickFont(
    fontCandidates(process.platform, { windir: process.env.WINDIR, override: process.env.AICUT_FONT }),
    existsSync,
  )
}
