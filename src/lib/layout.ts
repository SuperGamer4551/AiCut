export type PanelId = 'media' | 'preview' | 'timeline' | 'ai'

/**
 * Docking slots. `center` and `bottom` are stacked in the middle column, so any
 * panel can sit in any of the four regions of the workspace.
 */
export type ZoneId = 'left' | 'center' | 'bottom' | 'right'

export type Layout = Record<ZoneId, PanelId>

export type SizeKey = 'left' | 'right' | 'bottom' | 'gutter'

export type Sizes = Record<SizeKey, number>

export const PANEL_IDS: PanelId[] = ['media', 'preview', 'timeline', 'ai']

export const ZONE_IDS: ZoneId[] = ['left', 'center', 'bottom', 'right']

export const PANEL_TITLES: Record<PanelId, string> = {
  media: 'Media',
  preview: 'Preview',
  timeline: 'Timeline',
  ai: 'Assistant',
}

export const DEFAULT_LAYOUT: Layout = {
  left: 'media',
  center: 'preview',
  bottom: 'timeline',
  right: 'ai',
}

export const DEFAULT_SIZES: Sizes = { left: 260, right: 300, bottom: 340, gutter: 168 }

export const SIZE_LIMITS: Record<SizeKey, { min: number; max: number }> = {
  left: { min: 180, max: 560 },
  right: { min: 200, max: 600 },
  bottom: { min: 160, max: 1000 },
  gutter: { min: 88, max: 360 },
}

/** Space the flexible middle column always keeps, however far the sides grow. */
export const MIN_CENTER_PX = 320

/** Space kept above the bottom region so the upper panel never collapses. */
export const MIN_TOP_PX = 140

export const LAYOUT_STORAGE_KEY = 'aicut.layout.v1'
export const SIZES_STORAGE_KEY = 'aicut.sizes.v1'

export function clampSize(key: SizeKey, value: number, max = Number.POSITIVE_INFINITY): number {
  const limit = SIZE_LIMITS[key]
  if (!Number.isFinite(value)) return DEFAULT_SIZES[key]

  const ceiling = Math.max(limit.min, Math.min(limit.max, max))
  return Math.round(Math.min(ceiling, Math.max(limit.min, value)))
}

export function zoneOfPanel(layout: Layout, panel: PanelId): ZoneId | null {
  return ZONE_IDS.find((zone) => layout[zone] === panel) ?? null
}

export function swapZones(layout: Layout, a: ZoneId, b: ZoneId): Layout {
  if (a === b) return layout
  return { ...layout, [a]: layout[b], [b]: layout[a] }
}

/** Dropping a panel on an occupied zone trades places with whatever lives there. */
export function movePanel(layout: Layout, panel: PanelId, zone: ZoneId): Layout {
  const from = zoneOfPanel(layout, panel)
  if (!from) return layout
  return swapZones(layout, from, zone)
}

export function normalizeLayout(value: unknown): Layout {
  if (!value || typeof value !== 'object') return DEFAULT_LAYOUT

  const candidate = value as Record<string, unknown>
  const seen = new Set<PanelId>()

  for (const zone of ZONE_IDS) {
    const panel = candidate[zone]
    if (typeof panel !== 'string') return DEFAULT_LAYOUT
    if (!PANEL_IDS.includes(panel as PanelId)) return DEFAULT_LAYOUT
    if (seen.has(panel as PanelId)) return DEFAULT_LAYOUT
    seen.add(panel as PanelId)
  }

  return {
    left: candidate.left as PanelId,
    center: candidate.center as PanelId,
    bottom: candidate.bottom as PanelId,
    right: candidate.right as PanelId,
  }
}

export function normalizeSizes(value: unknown): Sizes {
  if (!value || typeof value !== 'object') return DEFAULT_SIZES

  const candidate = value as Record<string, unknown>
  const next = { ...DEFAULT_SIZES }

  for (const key of Object.keys(DEFAULT_SIZES) as SizeKey[]) {
    const size = candidate[key]
    next[key] = typeof size === 'number' ? clampSize(key, size) : DEFAULT_SIZES[key]
  }

  return next
}

export function sizesEqual(a: Sizes, b: Sizes): boolean {
  return (Object.keys(DEFAULT_SIZES) as SizeKey[]).every((key) => a[key] === b[key])
}

/** Largest a region may grow to, given what the neighbouring regions need. */
export function maxSize(key: SizeKey, sizes: Sizes, width: number, height: number): number {
  switch (key) {
    case 'left':
      return width - sizes.right - MIN_CENTER_PX
    case 'right':
      return width - sizes.left - MIN_CENTER_PX
    case 'bottom':
      return height - MIN_TOP_PX
    case 'gutter':
      return SIZE_LIMITS.gutter.max
  }
}

/** Shrinks regions proportionally so a smaller window still shows every panel. */
export function fitSizes(sizes: Sizes, width: number, height: number): Sizes {
  const next = normalizeSizes(sizes)
  if (!Number.isFinite(width) || width <= 0) return next

  const overflow = next.left + next.right + MIN_CENTER_PX - width
  if (overflow > 0) {
    const total = next.left + next.right
    const scale = Math.max(0, (total - overflow) / total)
    next.left = clampSize('left', next.left * scale)
    next.right = clampSize('right', next.right * scale)
  }

  if (Number.isFinite(height) && height > 0) {
    next.bottom = clampSize('bottom', next.bottom, maxSize('bottom', next, width, height))
  }

  return next
}

export function readStored<T>(key: string, normalize: (value: unknown) => T): T {
  try {
    if (typeof localStorage === 'undefined') return normalize(null)
    const raw = localStorage.getItem(key)
    return normalize(raw === null ? null : JSON.parse(raw))
  } catch {
    return normalize(null)
  }
}

export function writeStored(key: string, value: unknown): void {
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Storage can be unavailable or full; layout preferences are not critical.
  }
}
