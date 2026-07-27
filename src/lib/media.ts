import type { MediaItem, MediaKind } from './types'
import { baseName, detectKind, isSupported } from './types'

const PROBE_TIMEOUT_MS = 15000
const STILL_IMAGE_DURATION = 5

type Probe = {
  duration: number
  width?: number
  height?: number
  error?: string
}

function probeImage(url: string): Promise<Probe> {
  return new Promise((resolve) => {
    const img = new Image()
    const timer = window.setTimeout(
      () => resolve({ duration: STILL_IMAGE_DURATION, error: 'Timed out reading image' }),
      PROBE_TIMEOUT_MS,
    )

    img.onload = () => {
      window.clearTimeout(timer)
      resolve({
        duration: STILL_IMAGE_DURATION,
        width: img.naturalWidth,
        height: img.naturalHeight,
      })
    }
    img.onerror = () => {
      window.clearTimeout(timer)
      resolve({ duration: STILL_IMAGE_DURATION, error: 'Could not decode image' })
    }
    img.src = url
  })
}

function probeAv(url: string, kind: MediaKind): Promise<Probe> {
  return new Promise((resolve) => {
    const el = document.createElement(kind === 'audio' ? 'audio' : 'video')
    el.preload = 'metadata'
    el.muted = true

    let settled = false
    const finish = (probe: Probe) => {
      if (settled) return
      settled = true
      window.clearTimeout(timer)
      el.removeAttribute('src')
      el.load()
      resolve(probe)
    }

    const timer = window.setTimeout(
      () => finish({ duration: 0, error: 'Timed out reading metadata' }),
      PROBE_TIMEOUT_MS,
    )

    el.onloadedmetadata = () => {
      const video = el as HTMLVideoElement
      finish({
        duration: Number.isFinite(el.duration) ? el.duration : 0,
        width: video.videoWidth || undefined,
        height: video.videoHeight || undefined,
      })
    }
    el.onerror = () =>
      finish({ duration: 0, error: 'Unsupported or unreadable file' })

    el.src = url
  })
}

export function probeMedia(url: string, kind: MediaKind): Promise<Probe> {
  return kind === 'image' ? probeImage(url) : probeAv(url, kind)
}

function newId(): string {
  return typeof crypto?.randomUUID === 'function'
    ? crypto.randomUUID()
    : `id-${Math.random().toString(36).slice(2)}-${Date.now()}`
}

/** Builds a library entry from an absolute path, streamed via the app's media protocol. */
export function itemFromPath(filePath: string, size = 0): MediaItem {
  const name = baseName(filePath)
  const url = window.aicut?.toMediaUrl(filePath) ?? `file://${filePath}`
  return {
    id: newId(),
    name,
    path: filePath,
    url,
    kind: detectKind(name),
    duration: 0,
    size,
    loading: true,
  }
}

/** Builds a library entry from a File, using its real path on desktop and a blob URL otherwise. */
export function itemFromFile(file: File): MediaItem {
  const filePath = window.aicut?.getPathForFile(file) ?? null

  if (filePath) {
    return itemFromPath(filePath, file.size)
  }

  return {
    id: newId(),
    name: file.name,
    path: null,
    url: URL.createObjectURL(file),
    kind: detectKind(file.name, file.type),
    duration: 0,
    size: file.size,
    loading: true,
  }
}

export function supportedFiles(files: File[]): File[] {
  return files.filter((file) => isSupported(file.name, file.type))
}

export function releaseItem(item: MediaItem): void {
  if (item.url.startsWith('blob:')) URL.revokeObjectURL(item.url)
}
