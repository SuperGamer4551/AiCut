/**
 * Turning the names people use for folders into real paths. Saying "my documents
 * folder" has to reach the actual Documents folder, including when OneDrive has
 * moved it, otherwise a search looks in the wrong place and finds nothing.
 */

export type MediaRoot = { name: string; path: string }

/** The folder words the assistant understands, in the order they are offered. */
export const KNOWN_FOLDERS: { name: string; key: string; words: string[] }[] = [
  { name: 'Videos', key: 'videos', words: ['videos', 'video', 'movies', 'my videos'] },
  { name: 'Downloads', key: 'downloads', words: ['downloads', 'download'] },
  { name: 'Documents', key: 'documents', words: ['documents', 'document', 'docs'] },
  { name: 'Desktop', key: 'desktop', words: ['desktop'] },
  { name: 'Pictures', key: 'pictures', words: ['pictures', 'photos', 'images'] },
  { name: 'Music', key: 'music', words: ['music', 'songs', 'audio'] },
  { name: 'Home', key: 'home', words: ['home', 'user folder', 'my folder'] },
]

/** Folders that are searched when no folder was named. */
const SEARCHED = ['Videos', 'Downloads', 'Documents', 'Desktop', 'Pictures', 'Music']

function clean(value: string): string {
  return value.trim().toLowerCase().replace(/^my\s+/, '').replace(/\s+folder$/, '')
}

export function looksLikePath(value: string): boolean {
  return /^([a-z]:[\\/]|\\\\|\/|~)/i.test(value.trim())
}

/**
 * A folder word to a path. Unknown words and anything that already looks like a
 * path are handed back untouched, so real paths still work.
 */
export function resolveFolderName(
  wanted: string,
  paths: Partial<Record<string, string>>,
): string | null {
  const value = wanted.trim()
  if (!value) return null
  if (looksLikePath(value)) return value

  const word = clean(value)
  const match = KNOWN_FOLDERS.find((folder) => folder.words.includes(word))
  return match ? (paths[match.key] ?? null) : null
}

/**
 * Every place worth looking for media. OneDrive keeps a second copy of the
 * user's folders, and which one the known-folder lookup reports depends on how
 * the machine was set up, so both are offered when both exist.
 */
export function collectRoots(
  paths: Partial<Record<string, string>>,
  exists: (path: string) => boolean,
  join: (...parts: string[]) => string,
): MediaRoot[] {
  const roots: MediaRoot[] = []
  const taken = new Set<string>()

  const add = (name: string, target: string | undefined | null) => {
    if (!target) return
    const key = target.toLowerCase()
    if (taken.has(key)) return
    if (!exists(target)) return
    taken.add(key)
    roots.push({ name, path: target })
  }

  for (const folder of KNOWN_FOLDERS) {
    add(folder.name, paths[folder.key])

    // A redirected folder is not always the one reported, so the OneDrive copy
    // is offered too when it is a different place.
    if (folder.key !== 'home' && paths.home) {
      add(`OneDrive ${folder.name}`, join(paths.home, 'OneDrive', folder.name))
    }
  }

  return roots
}

/** The roots a search covers when the user did not say where to look. */
export function searchRoots(roots: MediaRoot[]): string[] {
  return roots
    .filter((root) => SEARCHED.some((name) => root.name === name || root.name === `OneDrive ${name}`))
    .map((root) => root.path)
}
