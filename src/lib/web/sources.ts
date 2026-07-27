// Where the assistant looks things up on the internet, and how it reads what
// comes back. Every source here is free and needs no account, so research works
// out of the box; the media sources are deliberately limited to libraries that
// publish licences, because a YouTuber who gets a copyright strike from a clip
// this app handed them is worse off than one who got nothing.
import { AUDIO_EXTENSIONS, IMAGE_EXTENSIONS, VIDEO_EXTENSIONS, extensionOf } from '../types'
import type { MediaKind } from '../types'

/** What the user is hunting for. "meme" is an intent rather than a file type. */
export type WebMediaKind = 'image' | 'video' | 'gif' | 'audio' | 'meme'

export const WEB_MEDIA_KINDS: WebMediaKind[] = ['image', 'video', 'gif', 'audio', 'meme']

export type WebMediaResult = {
  title: string
  /** Direct link to the file itself, which is what gets downloaded. */
  url: string
  /** The page it belongs to, for crediting it. */
  pageUrl: string
  source: string
  license: string
  author?: string
  extension: string
  kind: MediaKind
  width?: number
  height?: number
  duration?: number
  size?: number
}

export type WebArticle = {
  title: string
  summary: string
  url: string
  source: string
}

export type ReferenceVideo = {
  title: string
  url: string
  channel: string
  length?: string
}

const USER_AGENT = 'AiCut/1.0 (desktop video editor; https://github.com/SuperGamer4551/AiCut)'

/** Wikimedia asks for a descriptive agent, and the rest do not mind one. */
export function requestHeaders(): Record<string, string> {
  return { 'user-agent': USER_AGENT, accept: 'application/json,text/html;q=0.9' }
}

/** The file type a search of this kind should end up with. */
export function fileKindFor(kind: WebMediaKind): MediaKind {
  if (kind === 'video') return 'video'
  if (kind === 'audio') return 'audio'
  return 'image'
}

export function readMediaKind(value: unknown): WebMediaKind | null {
  if (typeof value !== 'string') return null
  const word = value.trim().toLowerCase()
  if (WEB_MEDIA_KINDS.includes(word as WebMediaKind)) return word as WebMediaKind
  if (word === 'picture' || word === 'photo' || word === 'still') return 'image'
  if (word === 'clip' || word === 'footage' || word === 'movie') return 'video'
  if (word === 'sound' || word === 'music' || word === 'sfx') return 'audio'
  if (word === 'reaction' || word === 'memes') return 'meme'
  return null
}

const MIME_EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/ogg': 'ogv',
  'video/quicktime': 'mov',
  'video/x-matroska': 'mkv',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/ogg': 'ogg',
  'audio/flac': 'flac',
  'audio/mp4': 'm4a',
}

const PLAYABLE = new Set([...VIDEO_EXTENSIONS, ...AUDIO_EXTENSIONS, ...IMAGE_EXTENSIONS])

/**
 * The extension to save a download under. The address is trusted first because
 * it is usually honest, then the type the source declared, and a sensible
 * default last so a file never lands without a suffix the editor can read.
 *
 * The declared type is not always a MIME type: Openverse reports a bare "wav",
 * so both spellings are accepted rather than guessing and getting it wrong.
 */
export function extensionFor(url: string, mime = '', kind: WebMediaKind = 'image'): string {
  const fromUrl = extensionOf(pathOf(url))
  if (PLAYABLE.has(fromUrl)) return fromUrl

  const declared = mime.split(';')[0].trim().toLowerCase()
  const fromMime = MIME_EXTENSIONS[declared] ?? (PLAYABLE.has(declared) ? declared : undefined)
  if (fromMime) return fromMime

  if (kind === 'video') return 'mp4'
  if (kind === 'audio') return 'mp3'
  if (kind === 'gif') return 'gif'
  return 'jpg'
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname
  } catch {
    return url
  }
}

export function isPlayableExtension(extension: string): boolean {
  return PLAYABLE.has(extension.toLowerCase())
}

/** Windows rejects a good half of the punctuation that titles arrive with. */
export function safeFileName(title: string, extension: string): string {
  const cleaned = title
    .replace(/^File:/i, '')
    .replace(/\.[a-z0-9]{1,5}$/i, '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 70)
    .trim()
    .replace(/[. ]+$/, '')

  return `${cleaned || 'download'}.${extension}`
}

function words(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 2)
}

/**
 * Puts the likeliest answer first and throws away the rest. Titles that echo
 * the search win, and a result that knows its own size is preferred because it
 * is more likely to be the real file rather than a placeholder.
 *
 * A title echoing none of the search is dropped rather than ranked last. These
 * libraries answer a query they cannot satisfy with whatever was nearest, so
 * keeping the also-rans means the top result for something they simply do not
 * hold is a stranger — which is worse than admitting there was nothing.
 */
export function rankResults(results: WebMediaResult[], query: string): WebMediaResult[] {
  const wanted = words(query)
  const seen = new Set<string>()
  const unique: WebMediaResult[] = []

  for (const result of results) {
    if (seen.has(result.url)) continue
    seen.add(result.url)
    unique.push(result)
  }

  return unique
    .map((result, index) => {
      const title = result.title.toLowerCase()
      const hits = wanted.filter((word) => title.includes(word)).length
      const score = hits * 10 + (result.width ? 2 : 0) + (result.duration ? 1 : 0)
      return { result, score, index, hits }
    })
    // Nothing to judge by means everything stays; a query worth matching has to
    // be matched.
    .filter((entry) => wanted.length === 0 || entry.hits > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.result)
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** Sizes and durations arrive as numbers from one source and strings from the next. */
function count(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''))
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

function rows(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

function stripHtml(value: string): string {
  return value
    .replace(/<[^>]*>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// --- Openverse: openly licensed images and audio -------------------------

export function openverseUrl(query: string, kind: WebMediaKind, limit: number): string {
  const family = kind === 'audio' ? 'audio' : 'images'
  const params = new URLSearchParams({
    q: kind === 'meme' ? `${query} meme` : query,
    page_size: String(Math.min(Math.max(limit, 1), 20)),
    mature: 'false',
  })
  if (kind === 'gif') params.set('extension', 'gif')
  return `https://api.openverse.org/v1/${family}/?${params.toString()}`
}

export function readOpenverse(payload: unknown, kind: WebMediaKind): WebMediaResult[] {
  const results: WebMediaResult[] = []

  for (const entry of rows(record(payload).results)) {
    const row = record(entry)
    const url = text(row.url)
    if (!url) continue

    const extension = extensionFor(url, text(row.filetype), kind)
    if (!isPlayableExtension(extension)) continue

    results.push({
      title: text(row.title) || text(row.creator) || 'Untitled',
      url,
      pageUrl: text(row.foreign_landing_url) || url,
      source: `Openverse${text(row.source) ? ` · ${text(row.source)}` : ''}`,
      license: [text(row.license).toUpperCase(), text(row.license_version)].filter(Boolean).join(' ') || 'See source',
      author: text(row.creator) || undefined,
      extension,
      kind: kind === 'audio' ? 'audio' : 'image',
      width: count(row.width),
      height: count(row.height),
      duration: count(row.duration) ? Number(row.duration) / 1000 : undefined,
    })
  }

  return results
}

// --- Wikimedia Commons: free images and video ----------------------------

export function commonsUrl(query: string, kind: WebMediaKind, limit: number): string {
  const filter = kind === 'video' ? ' filetype:video' : kind === 'audio' ? ' filetype:audio' : ' filetype:bitmap'
  const params = new URLSearchParams({
    action: 'query',
    format: 'json',
    generator: 'search',
    gsrsearch: `${query}${filter}`,
    gsrnamespace: '6',
    gsrlimit: String(Math.min(Math.max(limit, 1), 20)),
    prop: 'imageinfo',
    iiprop: 'url|size|mime|extmetadata',
  })
  return `https://commons.wikimedia.org/w/api.php?${params.toString()}`
}

export function readCommons(payload: unknown, kind: WebMediaKind): WebMediaResult[] {
  const pages = record(record(record(payload).query).pages)
  const results: WebMediaResult[] = []

  for (const page of Object.values(pages)) {
    const row = record(page)
    const info = record(rows(row.imageinfo)[0])
    const url = text(info.url)
    if (!url) continue

    const extension = extensionFor(url, text(info.mime), kind)
    if (!isPlayableExtension(extension)) continue

    const meta = record(info.extmetadata)
    results.push({
      title: stripHtml(text(row.title).replace(/^File:/, '')),
      url,
      pageUrl: text(info.descriptionurl) || url,
      source: 'Wikimedia Commons',
      license: stripHtml(text(record(meta.LicenseShortName).value)) || 'See source',
      author: stripHtml(text(record(meta.Artist).value)).slice(0, 60) || undefined,
      extension,
      kind: extension === 'gif' ? 'image' : fileKindFor(kind),
      width: count(info.width),
      height: count(info.height),
      size: count(info.size),
    })
  }

  return results
}

// --- Internet Archive: public domain video, audio and gifs ---------------

const ARCHIVE_MEDIATYPE: Record<WebMediaKind, string> = {
  video: 'movies',
  audio: 'audio',
  image: 'image',
  gif: 'image',
  meme: 'image',
}

export function archiveSearchUrl(query: string, kind: WebMediaKind, limit: number): string {
  const params = new URLSearchParams({
    q: `${query} AND mediatype:${ARCHIVE_MEDIATYPE[kind]}`,
    rows: String(Math.min(Math.max(limit, 1), 10)),
    page: '1',
    output: 'json',
  })
  // The bracketed field parameter repeats, which URLSearchParams cannot express
  // through its constructor.
  return `https://archive.org/advancedsearch.php?${params.toString()}&fl%5B%5D=identifier&fl%5B%5D=title&sort%5B%5D=downloads+desc`
}

export function readArchiveSearch(payload: unknown): { identifier: string; title: string }[] {
  return rows(record(record(payload).response).docs)
    .map((entry) => {
      const row = record(entry)
      const identifier = text(row.identifier)
      const title = Array.isArray(row.title) ? text(row.title[0]) : text(row.title)
      return { identifier, title: title || identifier }
    })
    .filter((entry) => entry.identifier.length > 0)
}

export function archiveMetadataUrl(identifier: string): string {
  return `https://archive.org/metadata/${encodeURIComponent(identifier)}`
}

/** Picks the one file worth having out of an item that may hold hundreds. */
export function readArchiveItem(
  payload: unknown,
  identifier: string,
  title: string,
  kind: WebMediaKind,
): WebMediaResult | null {
  const wanted = fileKindFor(kind)
  const files = rows(record(payload).files)
    .map((entry) => record(entry))
    .filter((file) => {
      const name = text(file.name)
      if (!name || name.startsWith('__')) return false
      const extension = extensionOf(name)
      if (kind === 'gif') return extension === 'gif'
      if (!isPlayableExtension(extension)) return false
      if (wanted === 'video') return VIDEO_EXTENSIONS.includes(extension)
      if (wanted === 'audio') return AUDIO_EXTENSIONS.includes(extension)
      return IMAGE_EXTENSIONS.includes(extension)
    })

  if (files.length === 0) return null

  // Smallest usable file: these items often carry a 2 GB master alongside a
  // perfectly good web copy, and nobody wants the master dropped into a project.
  const best = files.sort((a, b) => (count(a.size) ?? Infinity) - (count(b.size) ?? Infinity))[0]
  const name = text(best.name)
  const extension = extensionOf(name)

  return {
    title: stripHtml(title),
    url: `https://archive.org/download/${encodeURIComponent(identifier)}/${encodeURI(name)}`,
    pageUrl: `https://archive.org/details/${encodeURIComponent(identifier)}`,
    source: 'Internet Archive',
    license: 'Public domain or open licence — check the item page',
    extension,
    kind: extension === 'gif' ? 'image' : wanted,
    duration: count(best.length),
    size: count(best.size),
  }
}

// --- Imgflip: the meme templates everyone recognises ----------------------

export function imgflipUrl(): string {
  return 'https://api.imgflip.com/get_memes'
}

export function readImgflip(payload: unknown, query: string): WebMediaResult[] {
  const wanted = words(query)
  const memes = rows(record(record(payload).data).memes)

  return memes
    .map((entry) => record(entry))
    .filter((meme) => {
      if (wanted.length === 0) return true
      const name = text(meme.name).toLowerCase()
      return wanted.some((word) => name.includes(word))
    })
    .map((meme) => {
      const url = text(meme.url)
      return {
        title: text(meme.name),
        url,
        pageUrl: 'https://imgflip.com/memetemplates',
        source: 'Imgflip',
        license: 'Meme template, free to use',
        extension: extensionFor(url, '', 'meme'),
        kind: 'image' as MediaKind,
        width: count(meme.width),
        height: count(meme.height),
      }
    })
    .filter((meme) => meme.url.length > 0)
}

// --- Reading up: Wikipedia and DuckDuckGo --------------------------------

export function wikipediaSearchUrl(query: string, limit = 4): string {
  const params = new URLSearchParams({
    action: 'query',
    format: 'json',
    list: 'search',
    srsearch: query,
    srlimit: String(Math.min(Math.max(limit, 1), 10)),
  })
  return `https://en.wikipedia.org/w/api.php?${params.toString()}`
}

export function readWikipediaSearch(payload: unknown): WebArticle[] {
  return rows(record(record(payload).query).search)
    .map((entry) => {
      const row = record(entry)
      return {
        title: text(row.title),
        summary: stripHtml(text(row.snippet)),
        url: `https://en.wikipedia.org/?curid=${String(row.pageid ?? '')}`,
        source: 'Wikipedia',
      }
    })
    .filter((article) => article.title.length > 0)
}

export function wikipediaSummaryUrl(title: string): string {
  return `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/ /g, '_'))}`
}

export function readWikipediaSummary(payload: unknown): WebArticle | null {
  const row = record(payload)
  const extract = text(row.extract)
  if (!extract) return null

  return {
    title: text(row.title),
    summary: extract,
    url: text(record(record(row.content_urls).desktop).page),
    source: 'Wikipedia',
  }
}

export function duckDuckGoUrl(query: string): string {
  const params = new URLSearchParams({
    q: query,
    format: 'json',
    no_html: '1',
    skip_disambig: '1',
    t: 'aicut',
  })
  return `https://api.duckduckgo.com/?${params.toString()}`
}

export function readDuckDuckGo(payload: unknown): { answer: string; articles: WebArticle[] } {
  const row = record(payload)
  const answer = text(row.AbstractText) || text(row.Answer)
  const articles: WebArticle[] = []

  const abstractUrl = text(row.AbstractURL)
  if (answer && abstractUrl) {
    articles.push({
      title: text(row.Heading) || 'Summary',
      summary: answer,
      url: abstractUrl,
      source: text(row.AbstractSource) || 'DuckDuckGo',
    })
  }

  for (const entry of rows(row.RelatedTopics)) {
    const topic = record(entry)
    const url = text(topic.FirstURL)
    const blurb = text(topic.Text)
    if (!url || !blurb) continue
    articles.push({
      title: blurb.split(' - ')[0].slice(0, 80),
      summary: blurb,
      url,
      source: 'DuckDuckGo',
    })
    if (articles.length >= 6) break
  }

  return { answer, articles }
}

// --- Reference videos on YouTube -----------------------------------------

export function youtubeSearchUrl(query: string): string {
  return `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`
}

export function youtubeWatchUrl(id: string): string {
  return `https://www.youtube.com/watch?v=${id}`
}

function firstRun(value: unknown): string {
  const runs = rows(record(value).runs)
  const joined = runs.map((run) => text(record(run).text)).join('')
  return joined || text(record(value).simpleText)
}

/**
 * YouTube has no free search API, but the results page ships its data as JSON
 * for its own front end to render. Reading that is the only way to hand back a
 * real link without an API key, so it is done defensively: anything unexpected
 * yields nothing rather than throwing, and the caller falls back to a plain
 * search link.
 */
export function readYoutubeResults(html: string, limit = 5): ReferenceVideo[] {
  const match = /ytInitialData"?\]?\s*=\s*(\{.+?\})\s*;\s*(?:<\/script>|var |window\.)/s.exec(html)
  if (!match) return []

  let data: unknown
  try {
    data = JSON.parse(match[1])
  } catch {
    return []
  }

  const found: ReferenceVideo[] = []
  const seen = new Set<string>()
  // Breadth first, so the videos come out roughly in the order the page lists
  // them rather than whichever branch happened to be deepest.
  const queue: unknown[] = [data]

  for (let at = 0; at < queue.length && found.length < limit; at += 1) {
    const node = queue[at]
    if (!node || typeof node !== 'object') continue

    if (Array.isArray(node)) {
      for (const child of node) queue.push(child)
      continue
    }

    const row = node as Record<string, unknown>
    const id = text(row.videoId)
    const title = firstRun(row.title)

    if (id.length === 11 && title && !seen.has(id)) {
      seen.add(id)
      found.push({
        title,
        url: youtubeWatchUrl(id),
        channel: firstRun(row.ownerText) || firstRun(row.longBylineText) || 'YouTube',
        length: firstRun(row.lengthText) || undefined,
      })
      continue
    }

    for (const child of Object.values(row)) queue.push(child)
  }

  return found
}
