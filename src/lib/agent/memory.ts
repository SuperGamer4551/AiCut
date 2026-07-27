/**
 * Things the user has taught the assistant. Notes are kept as plain sentences
 * so the model can read them directly, and a few structured preferences are
 * parsed out of them so the built-in commands can honour them too.
 */
export type MemoryNote = {
  id: string
  text: string
  createdAt: number
}

export const MEMORY_STORAGE_KEY = 'aicut.memory.v1'

/** Old notes fall off the end rather than growing the prompt without limit. */
export const MEMORY_LIMIT = 60

const MAX_NOTE_LENGTH = 240

const RATIOS = ['16:9', '9:16', '1:1', '4:5', '4:3', '3:4']

const RATIO_WORDS: Record<string, string> = {
  vertical: '9:16',
  portrait: '9:16',
  tiktok: '9:16',
  shorts: '9:16',
  reels: '9:16',
  square: '1:1',
  landscape: '16:9',
  widescreen: '16:9',
  horizontal: '16:9',
}

const FORMATS = ['mp4', 'webm', 'mov', 'mkv']

const VISIBILITIES = ['private', 'unlisted', 'public']

/** Phrasings that mean "keep this in mind from now on". */
const TEACHING_PATTERNS: RegExp[] = [
  /\b(?:please\s+)?remember(?:\s+that|\s+this)?[:,]?\s+(.+)/i,
  /\b(?:take a )?note(?:\s+that)?[:,]\s+(.+)/i,
  /\bfrom now on[,]?\s+(.+)/i,
  /\bgoing forward[,]?\s+(.+)/i,
  /\bby default[,]?\s+(.+)/i,
  /\b(always\s+.+)/i,
  /\b(never\s+.+)/i,
  /\bi (?:always\s+)?(prefer\s+.+)/i,
  /\bi (?:usually|normally|generally)\s+(.+)/i,
  /\bmy (?:default|usual|go.to)\s+(.+)/i,
  /\b(?:call|treat)\s+(.+\s+(?:as|my)\s+.+)/i,
  /\bkeep in mind(?:\s+that)?[:,]?\s+(.+)/i,
]

function newId(): string {
  const source = globalThis.crypto
  if (source && typeof source.randomUUID === 'function') return source.randomUUID()
  return `note-${Math.random().toString(36).slice(2, 10)}`
}

function tidy(text: string): string {
  return text.trim().replace(/\s+/g, ' ').replace(/^[,:;-]\s*/, '').replace(/[.!]+$/, '').slice(0, MAX_NOTE_LENGTH)
}

function comparable(text: string): string {
  return tidy(text).toLowerCase()
}

export function normalizeMemory(value: unknown): MemoryNote[] {
  if (!Array.isArray(value)) return []

  const notes: MemoryNote[] = []
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue
    const candidate = entry as Partial<MemoryNote>
    if (typeof candidate.text !== 'string' || !candidate.text.trim()) continue

    notes.push({
      id: typeof candidate.id === 'string' && candidate.id ? candidate.id : newId(),
      text: tidy(candidate.text),
      createdAt: typeof candidate.createdAt === 'number' ? candidate.createdAt : 0,
    })
  }

  return notes.slice(-MEMORY_LIMIT)
}

export function addNote(
  notes: MemoryNote[],
  text: string,
  now = Date.now(),
): { notes: MemoryNote[]; note: MemoryNote | null; duplicate: boolean } {
  const clean = tidy(text)
  if (clean.length < 3) return { notes, note: null, duplicate: false }

  const existing = notes.find((note) => comparable(note.text) === comparable(clean))
  if (existing) return { notes, note: existing, duplicate: true }

  const note: MemoryNote = { id: newId(), text: clean, createdAt: now }
  return { notes: [...notes, note].slice(-MEMORY_LIMIT), note, duplicate: false }
}

export function removeNotes(
  notes: MemoryNote[],
  query: string,
): { notes: MemoryNote[]; removed: MemoryNote[] } {
  const raw = comparable(query)
  if (!raw) return { notes, removed: [] }

  if (raw === 'all' || raw === 'everything') return { notes: [], removed: notes }

  const removed = notes.filter(
    (note) => note.id.toLowerCase() === raw || comparable(note.text).includes(raw),
  )

  return {
    notes: notes.filter((note) => !removed.includes(note)),
    removed,
  }
}

/** The block of remembered instructions handed to the model each turn. */
export function memoryPrompt(notes: MemoryNote[]): string {
  if (notes.length === 0) return ''
  return [
    'The user has taught you these standing instructions. Follow them unless this message contradicts them:',
    ...notes.map((note) => `- ${note.text}`),
  ].join('\n')
}

export type LearnedDefaults = {
  /** Aspect ratio to use when a crop is asked for without one. */
  aspect: string | null
  /** Container to export to when none is given. */
  format: string | null
  /** YouTube visibility to publish with when none is given. */
  visibility: string | null
  /** Nicknames for media files, so "my intro" finds intro_take3.mp4. */
  aliases: Record<string, string>
  /** Where a kind of material is kept: memes, sound effects, gameplay. */
  folders: Record<string, string>
}

/** Words that say what a folder holds, mapped to the kind they mean. */
const FOLDER_KINDS: Record<string, string> = {
  meme: 'memes',
  memes: 'memes',
  reaction: 'memes',
  reactions: 'memes',
  sfx: 'sounds',
  'sound effect': 'sounds',
  'sound effects': 'sounds',
  sound: 'sounds',
  sounds: 'sounds',
  music: 'music',
  songs: 'music',
  clip: 'clips',
  clips: 'clips',
  footage: 'clips',
  gameplay: 'clips',
  recordings: 'clips',
}

const FOLDER_WORDS = ['videos', 'downloads', 'documents', 'desktop', 'pictures', 'music']

/** A folder mentioned in a note, either as a path or as a well-known name. */
function findFolder(text: string): string | null {
  const explicit = /([a-z]:[\\/][^"'\s]*|\/(?:[\w .()-]+\/?)+)/i.exec(text)
  if (explicit && !/\.[a-z0-9]{2,4}$/i.test(explicit[1])) return explicit[1]

  const named = new RegExp(`\\b(?:in|inside|under)\\s+(?:my\\s+)?(${FOLDER_WORDS.join('|')})\\b`, 'i').exec(text)
  return named ? named[1].toLowerCase() : null
}

function findRatio(text: string): string | null {
  const direct = RATIOS.find((ratio) => text.includes(ratio))
  if (direct) return direct

  const word = Object.keys(RATIO_WORDS).find((key) => text.includes(key))
  return word ? RATIO_WORDS[word] : null
}

/**
 * Preferences the built-in commands can act on without a model. Only notes that
 * read like a standing choice are considered, so a passing mention of "9:16"
 * does not silently become a default.
 */
export function learnedDefaults(notes: MemoryNote[]): LearnedDefaults {
  const defaults: LearnedDefaults = {
    aspect: null,
    format: null,
    visibility: null,
    aliases: {},
    folders: {},
  }

  for (const note of notes) {
    const text = note.text.toLowerCase()
    // Stored notes are durable by construction, so the bar for reading one as a
    // standing choice is low.
    const standing = /\b(always|default|prefer|usually|normally|every time|from now on|keep|only|stick to|make sure)\b/.test(
      text,
    )

    if (standing) {
      const ratio = findRatio(text)
      if (ratio && /\b(crop|aspect|ratio|vertical|portrait|square|landscape|format|video)\b/.test(text)) {
        defaults.aspect = defaults.aspect ?? ratio
      }

      const format = FORMATS.find((candidate) => new RegExp(`\\b${candidate}\\b`).test(text))
      if (format && /\b(export|render|save|output|file)\b/.test(text)) {
        defaults.format = defaults.format ?? format
      }

      const visibility = VISIBILITIES.find((candidate) => text.includes(candidate))
      if (visibility && /\b(publish|upload|youtube|video)\b/.test(text)) {
        defaults.visibility = defaults.visibility ?? visibility
      }
    }

    // "my memes are in D:\memes", "I keep sound effects in my downloads folder"
    const folder = findFolder(note.text)
    if (folder) {
      const kind = Object.keys(FOLDER_KINDS)
        .sort((a, b) => b.length - a.length)
        .find((word) => new RegExp(`\\b${word}\\b`).test(text))
      if (kind && !(FOLDER_KINDS[kind] in defaults.folders)) {
        defaults.folders[FOLDER_KINDS[kind]] = folder
      }
    }

    // "my intro means intro_take3.mp4", "call clip_042.mp4 the b-roll"
    const meaning = /^(?:call\s+)?["']?(.+?)["']?\s+(?:means|refers to|is|=)\s+["']?([\w .()-]+\.[a-z0-9]{2,4})["']?$/i.exec(
      note.text,
    )
    if (meaning) {
      defaults.aliases[comparable(meaning[1])] = meaning[2].trim()
      continue
    }

    const naming = /^(?:call|treat)\s+["']?([\w .()-]+\.[a-z0-9]{2,4})["']?\s+(?:as|my)\s+["']?(.+?)["']?$/i.exec(
      note.text,
    )
    if (naming) defaults.aliases[comparable(naming[2])] = naming[1].trim()
  }

  return defaults
}

/**
 * Pulls a durable instruction out of an ordinary message, so the assistant
 * picks up preferences from the way the user talks instead of only when they
 * say "remember".
 */
export function learnFrom(input: string): string | null {
  const text = input.trim()
  if (!text || text.length > 400) return null
  // Questions are not instructions.
  if (/\?\s*$/.test(text)) return null

  for (const pattern of TEACHING_PATTERNS) {
    const match = pattern.exec(text)
    if (!match) continue

    const learned = tidy(match[1] ?? '')
    // Guard against picking up one-off commands like "always" on its own.
    if (learned.length < 6) continue
    return learned
  }

  return null
}
