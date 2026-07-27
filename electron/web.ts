// The assistant's window onto the internet: looking things up, finding footage
// and memes it is allowed to use, and pulling a file down onto the disk so the
// rest of the editor can treat it like anything else the user imported.
//
// All of it runs in the main process. The renderer's content policy blocks
// remote requests on purpose, and keeping the network here means a downloaded
// file arrives as a path rather than as bytes the page has to be trusted with.
import { createWriteStream } from 'node:fs'
import { mkdir, stat, unlink } from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReferenceVideo, WebArticle, WebMediaKind, WebMediaResult } from '../src/lib/web/sources'
import {
  archiveMetadataUrl,
  archiveSearchUrl,
  commonsUrl,
  duckDuckGoUrl,
  extensionFor,
  imgflipUrl,
  isPlayableExtension,
  openverseUrl,
  rankResults,
  readArchiveItem,
  readArchiveSearch,
  readCommons,
  readDuckDuckGo,
  readImgflip,
  readOpenverse,
  readWikipediaSearch,
  readWikipediaSummary,
  readYoutubeResults,
  requestHeaders,
  safeFileName,
  wikipediaSearchUrl,
  wikipediaSummaryUrl,
  youtubeSearchUrl,
} from '../src/lib/web/sources'

export type WebSearchReply =
  | { query: string; answer: string; articles: WebArticle[] }
  | { error: string }

export type WebMediaReply =
  | { query: string; kind: WebMediaKind; results: WebMediaResult[] }
  | { error: string }

export type ReferenceReply =
  | { query: string; videos: ReferenceVideo[]; searchUrl: string }
  | { error: string }

export type DownloadReply = { path: string; name: string; size: number } | { error: string }

const LOOKUP_TIMEOUT_MS = 12_000
const DOWNLOAD_TIMEOUT_MS = 180_000
/** Big enough for a stock clip, small enough that a stray link cannot fill a disk. */
const MAX_DOWNLOAD_BYTES = 300 * 1024 * 1024

/** Where downloaded material lands: the app's own folder, not the user's. */
export function downloadFolder(userData: string): string {
  return path.join(userData, 'downloads')
}

async function fetchWith(url: string, timeoutMs: number, accept = 'json'): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetch(url, {
      headers: {
        ...requestHeaders(),
        ...(accept === 'html' ? { accept: 'text/html' } : {}),
      },
      redirect: 'follow',
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
    return response
  } finally {
    clearTimeout(timer)
  }
}

async function getJson(url: string): Promise<unknown> {
  return (await fetchWith(url, LOOKUP_TIMEOUT_MS)).json()
}

async function getText(url: string): Promise<string> {
  return (await fetchWith(url, LOOKUP_TIMEOUT_MS, 'html')).text()
}

/** A source that is down or rate limiting should cost nothing but its own results. */
async function attempt<T>(work: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await work()
  } catch {
    return fallback
  }
}

function offline(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (/abort/i.test(message)) return 'The search timed out. The connection may be slow or down.'
  if (/fetch failed|ENOTFOUND|EAI_AGAIN|ECONNREFUSED/i.test(message)) {
    return 'I could not reach the internet just now.'
  }
  return message
}

// --- Looking things up ---------------------------------------------------

export async function searchWeb(rawQuery: string): Promise<WebSearchReply> {
  const query = rawQuery.trim()
  if (!query) return { error: 'Tell me what to look up.' }

  try {
    const [duck, wiki] = await Promise.all([
      attempt(async () => readDuckDuckGo(await getJson(duckDuckGoUrl(query))), {
        answer: '',
        articles: [] as WebArticle[],
      }),
      attempt(async () => readWikipediaSearch(await getJson(wikipediaSearchUrl(query))), [] as WebArticle[]),
    ])

    // The encyclopedia entry for the top hit is a better read than the snippet,
    // so it is fetched in full and used as the answer when nothing else has one.
    const lead = wiki[0]
      ? await attempt(async () => readWikipediaSummary(await getJson(wikipediaSummaryUrl(wiki[0].title))), null)
      : null

    const articles = [...(lead ? [lead] : []), ...duck.articles, ...wiki]
      .filter((article, index, all) => all.findIndex((other) => other.url === article.url) === index)
      .slice(0, 6)

    const answer = duck.answer || lead?.summary || ''
    if (!answer && articles.length === 0) {
      return { query, answer: '', articles: [] }
    }

    return { query, answer, articles }
  } catch (error) {
    return { error: offline(error) }
  }
}

// --- Finding usable pictures, footage, memes and sound -------------------

async function fromOpenverse(query: string, kind: WebMediaKind, limit: number): Promise<WebMediaResult[]> {
  return attempt(async () => readOpenverse(await getJson(openverseUrl(query, kind, limit)), kind), [])
}

async function fromCommons(query: string, kind: WebMediaKind, limit: number): Promise<WebMediaResult[]> {
  return attempt(async () => readCommons(await getJson(commonsUrl(query, kind, limit)), kind), [])
}

async function fromImgflip(query: string): Promise<WebMediaResult[]> {
  return attempt(async () => readImgflip(await getJson(imgflipUrl()), query), [])
}

async function fromArchive(query: string, kind: WebMediaKind, limit: number): Promise<WebMediaResult[]> {
  return attempt(async () => {
    const items = readArchiveSearch(await getJson(archiveSearchUrl(query, kind, limit))).slice(0, limit)
    const found = await Promise.all(
      items.map((item) =>
        attempt(
          async () => readArchiveItem(await getJson(archiveMetadataUrl(item.identifier)), item.identifier, item.title, kind),
          null,
        ),
      ),
    )
    return found.filter((entry): entry is WebMediaResult => entry !== null)
  }, [])
}

/** Which libraries are worth asking for a given kind of thing. */
function providersFor(query: string, kind: WebMediaKind, limit: number): Promise<WebMediaResult[]>[] {
  switch (kind) {
    case 'video':
      return [fromCommons(query, kind, limit), fromArchive(query, kind, 4)]
    case 'audio':
      return [fromOpenverse(query, kind, limit), fromArchive(query, kind, 3)]
    case 'gif':
      return [fromOpenverse(query, kind, limit), fromArchive(query, kind, 3)]
    case 'meme':
      return [fromImgflip(query), fromOpenverse(query, kind, limit)]
    default:
      return [fromOpenverse(query, kind, limit), fromCommons(query, kind, limit)]
  }
}

export async function findWebMedia(
  rawQuery: string,
  kind: WebMediaKind,
  limit = 6,
): Promise<WebMediaReply> {
  const query = rawQuery.trim()
  if (!query) return { error: 'Tell me what to search for.' }

  try {
    const batches = await Promise.all(providersFor(query, kind, limit))
    const results = rankResults(batches.flat(), query).slice(0, Math.min(Math.max(limit, 1), 12))
    return { query, kind, results }
  } catch (error) {
    return { error: offline(error) }
  }
}

// --- Reference videos ----------------------------------------------------

export async function findReferenceVideos(rawQuery: string, limit = 5): Promise<ReferenceReply> {
  const query = rawQuery.trim()
  if (!query) return { error: 'Tell me what the video should be about.' }

  const searchUrl = youtubeSearchUrl(query)

  try {
    const videos = readYoutubeResults(await getText(searchUrl), limit)
    return { query, videos, searchUrl }
  } catch (error) {
    // A search link is still a useful answer when the page will not parse.
    const message = offline(error)
    if (/could not reach|timed out/i.test(message)) return { error: message }
    return { query, videos: [], searchUrl }
  }
}

// --- Bringing a file down ------------------------------------------------

async function freeName(folder: string, wanted: string): Promise<string> {
  const extension = path.extname(wanted)
  const stem = path.basename(wanted, extension)

  for (let attemptNumber = 0; attemptNumber < 100; attemptNumber += 1) {
    const name = attemptNumber === 0 ? wanted : `${stem} (${attemptNumber})${extension}`
    const full = path.join(folder, name)
    try {
      await stat(full)
    } catch {
      return full
    }
  }

  return path.join(folder, `${stem} ${Date.now()}${extension}`)
}

export async function downloadMedia(
  userData: string,
  url: string,
  suggestedName = '',
): Promise<DownloadReply> {
  let address: URL
  try {
    address = new URL(url)
  } catch {
    return { error: `${url} is not a web address I can fetch.` }
  }

  if (address.protocol !== 'http:' && address.protocol !== 'https:') {
    return { error: 'I can only download over http or https.' }
  }

  const folder = downloadFolder(userData)
  try {
    await mkdir(folder, { recursive: true })
  } catch (error) {
    return { error: `I could not create ${folder}: ${(error as Error).message}` }
  }

  let response: Response
  try {
    response = await fetchWith(address.toString(), DOWNLOAD_TIMEOUT_MS, 'any')
  } catch (error) {
    return { error: `That download failed: ${offline(error)}` }
  }

  const mime = response.headers.get('content-type') ?? ''
  const extension = extensionFor(address.toString(), mime)
  if (!isPlayableExtension(extension)) {
    return { error: `That link is a ${mime || 'file'}, which is not video, audio or a picture.` }
  }

  const declared = Number(response.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > MAX_DOWNLOAD_BYTES) {
    return { error: `That file is ${Math.round(declared / 1024 / 1024)} MB, which is larger than I will download.` }
  }

  if (!response.body) return { error: 'That link returned nothing.' }

  const target = await freeName(folder, safeFileName(suggestedName || path.basename(address.pathname), extension))

  let written = 0
  const meter = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      written += chunk.byteLength
      if (written > MAX_DOWNLOAD_BYTES) throw new Error('the file kept going past the size I allow')
      controller.enqueue(chunk)
    },
  })

  try {
    await pipeline(Readable.fromWeb(response.body.pipeThrough(meter) as never), createWriteStream(target))
  } catch (error) {
    await unlink(target).catch(() => {})
    return { error: `That download failed: ${offline(error)}` }
  }

  let size = 0
  try {
    size = (await stat(target)).size
  } catch {
    return { error: `${target} was not written.` }
  }

  if (size === 0) {
    await unlink(target).catch(() => {})
    return { error: 'That link gave back an empty file.' }
  }

  return { path: target, name: path.basename(target), size }
}
