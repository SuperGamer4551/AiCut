import type { Dirent } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'

/**
 * Read-only exploration of the user's disk, limited to finding media. Every walk
 * is bounded so a request cannot wander into an enormous tree and hang.
 */

export const MEDIA_EXTENSIONS = [
  'mp4',
  'm4v',
  'mov',
  'webm',
  'mkv',
  'avi',
  'mp3',
  'wav',
  'aac',
  'm4a',
  'flac',
  'ogg',
  'png',
  'jpg',
  'jpeg',
  'webp',
  'gif',
]

/** Folders that only ever hold noise for our purposes. */
const SKIP_FOLDERS = new Set([
  'node_modules',
  '$recycle.bin',
  'system volume information',
  'appdata',
  'windows',
  'program files',
  'program files (x86)',
  'programdata',
  '.git',
  '.cache',
  'library',
  'onedrivetemp',
])

export const MAX_ENTRIES = 200
export const MAX_MATCHES = 40
export const MAX_DEPTH = 6
export const MAX_VISITED = 4000

export type FolderEntry = {
  name: string
  path: string
  kind: 'folder' | 'media'
  size: number
}

export type Listing = {
  folder: string
  entries: FolderEntry[]
  truncated: boolean
}

export function isMediaFile(name: string): boolean {
  const match = /\.([a-z0-9]+)$/i.exec(name)
  return match ? MEDIA_EXTENSIONS.includes(match[1].toLowerCase()) : false
}

function skippable(name: string): boolean {
  return name.startsWith('.') || SKIP_FOLDERS.has(name.toLowerCase())
}

export async function listFolder(folder: string): Promise<Listing> {
  const resolved = path.resolve(folder)
  const found = await readdir(resolved, { withFileTypes: true })

  const entries: FolderEntry[] = []
  let truncated = false

  for (const entry of found) {
    if (entries.length >= MAX_ENTRIES) {
      truncated = true
      break
    }

    if (entry.isDirectory()) {
      if (skippable(entry.name)) continue
      entries.push({ name: entry.name, path: path.join(resolved, entry.name), kind: 'folder', size: 0 })
      continue
    }

    if (!entry.isFile() || !isMediaFile(entry.name)) continue

    const full = path.join(resolved, entry.name)
    let size = 0
    try {
      size = (await stat(full)).size
    } catch {
      // Listed anyway; an unreadable size is not worth failing over.
    }
    entries.push({ name: entry.name, path: full, kind: 'media', size })
  }

  entries.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'folder' ? -1 : 1))
  return { folder: resolved, entries, truncated }
}

/** Breadth-first so shallow, likely matches surface before deep ones. */
export async function findMedia(
  query: string,
  roots: string[],
  limits: { maxMatches?: number; maxDepth?: number; maxVisited?: number } = {},
): Promise<{ matches: FolderEntry[]; visited: number; truncated: boolean }> {
  const needle = query.trim().toLowerCase()
  const maxMatches = limits.maxMatches ?? MAX_MATCHES
  const maxDepth = limits.maxDepth ?? MAX_DEPTH
  const maxVisited = limits.maxVisited ?? MAX_VISITED

  const matches: FolderEntry[] = []
  const seen = new Set<string>()
  let queue = roots.map((root) => ({ folder: path.resolve(root), depth: 0 }))
  let visited = 0
  let truncated = false

  while (queue.length > 0) {
    const next: typeof queue = []

    for (const { folder, depth } of queue) {
      if (matches.length >= maxMatches || visited >= maxVisited) {
        truncated = true
        break
      }
      if (seen.has(folder.toLowerCase())) continue
      seen.add(folder.toLowerCase())

      let entries: Dirent[]
      try {
        entries = await readdir(folder, { withFileTypes: true })
      } catch {
        continue
      }

      visited += 1

      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (depth < maxDepth && !skippable(entry.name)) {
            next.push({ folder: path.join(folder, entry.name), depth: depth + 1 })
          }
          continue
        }

        if (!entry.isFile() || !isMediaFile(entry.name)) continue
        if (needle && !entry.name.toLowerCase().includes(needle)) continue
        if (matches.length >= maxMatches) {
          truncated = true
          continue
        }

        const full = path.join(folder, entry.name)
        let size = 0
        try {
          size = (await stat(full)).size
        } catch {
          // Keep the match; the size is only shown for context.
        }
        matches.push({ name: entry.name, path: full, kind: 'media', size })
      }
    }

    if (matches.length >= maxMatches || visited >= maxVisited) {
      truncated = truncated || queue.length > 0
      break
    }

    queue = next
  }

  return { matches, visited, truncated }
}
