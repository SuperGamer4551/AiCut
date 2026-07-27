// Pulling a video down off YouTube.
//
// YouTube has no download API and changes how its player hands out streams
// every few weeks, so this leans on yt-dlp, which keeps up with that. The
// binary is not shipped in the installer: a copy frozen at release time breaks
// within a month or two, and the app cannot ship updates that fast. Instead it
// is fetched from the project's own releases on first use, kept in the app's
// folder, and quietly replaced once it goes stale.
//
// Merging YouTube's separate video and audio streams needs ffmpeg, which the
// app already carries for export, so yt-dlp is pointed at that copy.
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ffmpegBinary } from './exporter'

export type FetchedVideo =
  | { path: string; name: string; size: number; title: string; channel: string; duration: number }
  | { error: string }

/** Beyond this the copy on disk is old enough that YouTube may have outrun it. */
const STALE_AFTER_MS = 10 * 24 * 60 * 60 * 1000

const DOWNLOAD_TIMEOUT_MS = 20 * 60 * 1000
const TOOL_TIMEOUT_MS = 5 * 60 * 1000

/** A ceiling that still allows a long montage but not a whole film archive. */
const MAX_VIDEO_BYTES = 600 * 1024 * 1024

/** Tall enough to edit and re-upload from, without pulling 4K nobody needs. */
const MAX_HEIGHT = 1080

const RELEASES = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download'

type Platform = { asset: string; name: string }

function platform(): Platform {
  switch (process.platform) {
    case 'win32':
      return { asset: 'yt-dlp.exe', name: 'yt-dlp.exe' }
    case 'darwin':
      return { asset: 'yt-dlp_macos', name: 'yt-dlp' }
    default:
      return { asset: 'yt-dlp', name: 'yt-dlp' }
  }
}

export function toolPath(userData: string): string {
  return path.join(userData, 'tools', platform().name)
}

/** True once the copy on disk is old enough to be worth replacing. */
export function isStale(modified: number, now = Date.now()): boolean {
  return now - modified > STALE_AFTER_MS
}

async function ageOf(file: string): Promise<number | null> {
  try {
    const info = await stat(file)
    return info.size > 0 ? info.mtimeMs : null
  } catch {
    return null
  }
}

/**
 * The published checksum for an asset. Both this and the binary come from the
 * same host over TLS, so this is really a guard against a truncated or
 * half-written download rather than against a hostile one.
 */
async function publishedSum(asset: string): Promise<string | null> {
  try {
    const response = await fetch(`${RELEASES}/SHA2-256SUMS`, { redirect: 'follow' })
    if (!response.ok) return null

    for (const line of (await response.text()).split(/\r?\n/)) {
      const [sum, name] = line.trim().split(/\s+/)
      if (name === asset && /^[a-f0-9]{64}$/i.test(sum)) return sum.toLowerCase()
    }
  } catch {
    return null
  }

  return null
}

async function fetchTool(target: string): Promise<string | null> {
  const { asset } = platform()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TOOL_TIMEOUT_MS)

  try {
    const [response, expected] = await Promise.all([
      fetch(`${RELEASES}/${asset}`, { redirect: 'follow', signal: controller.signal }),
      publishedSum(asset),
    ])
    if (!response.ok) return `GitHub answered ${response.status} for ${asset}.`

    const body = Buffer.from(await response.arrayBuffer())
    if (body.byteLength === 0) return 'the download came back empty'

    if (expected) {
      const got = createHash('sha256').update(body).digest('hex')
      if (got !== expected) return 'the downloaded copy did not match its published checksum'
    }

    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, body)
    if (process.platform !== 'win32') await chmod(target, 0o755)

    return null
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return /abort/i.test(message) ? 'the download timed out' : message
  } finally {
    clearTimeout(timer)
  }
}

/**
 * The downloader this machine will run, fetching it if it is missing and
 * refreshing it once it is stale. A refresh that fails is not fatal: an old
 * copy that still works beats no copy at all.
 */
export async function ensureTool(userData: string): Promise<{ path: string } | { error: string }> {
  const target = toolPath(userData)
  const modified = await ageOf(target)

  if (modified !== null && !isStale(modified)) return { path: target }

  const failure = await fetchTool(target)
  if (!failure) return { path: target }
  if (modified !== null) return { path: target }

  return {
    error: `I need yt-dlp to pull video off YouTube and could not fetch it: ${failure}. It downloads once from github.com/yt-dlp/yt-dlp; check the connection, or whether antivirus removed it.`,
  }
}

// --- Running it -----------------------------------------------------------

/** Only real YouTube addresses, so this cannot be pointed at anything else. */
export function isYoutubeUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '').toLowerCase()
    return host === 'youtube.com' || host === 'm.youtube.com' || host === 'youtu.be' || host === 'music.youtube.com'
  } catch {
    return false
  }
}

/** yt-dlp reports progress as "[download]  42.5% of ...". */
export function progressFromLine(line: string): number | null {
  const match = /^\[download\]\s+([\d.]+)%/.exec(line.trim())
  if (!match) return null

  const percent = Number.parseFloat(match[1])
  return Number.isFinite(percent) ? Math.min(Math.max(percent / 100, 0), 1) : null
}

/**
 * yt-dlp is chatty on failure and most of it is traceback. The last line that
 * says ERROR is the one worth repeating.
 */
export function readFailure(output: string): string {
  const errors = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^ERROR:/i.test(line))

  const last = errors[errors.length - 1] ?? ''
  const message = last.replace(/^ERROR:\s*/i, '').trim()

  if (/private video|sign in to confirm|members-only|not available/i.test(message)) {
    return 'That video is private, age-restricted or region-locked, so it cannot be downloaded.'
  }
  if (/unavailable|removed|terminated/i.test(message)) return 'That video is no longer on YouTube.'
  if (/file is larger|max-filesize/i.test(message)) return 'That video is larger than I will download.'
  if (/certificate_verify_failed|ssl:|certificate verify/i.test(message)) {
    return 'The download could not verify YouTube\'s certificate, which usually means something on this network is inspecting traffic — a company or school connection, or antivirus with HTTPS scanning turned on.'
  }

  return message || 'yt-dlp could not download that video.'
}

export function downloadArgs(url: string, folder: string, report: string, ffmpeg: string): string[] {
  return [
    url,
    // A link copied from a playlist should still mean the one video.
    '--no-playlist',
    '--no-mtime',
    // Progress on its own line, so it can be read as it goes.
    '--newline',
    '--progress',
    '--no-colors',
    '-f',
    [
      `bestvideo[height<=${MAX_HEIGHT}][ext=mp4]+bestaudio[ext=m4a]`,
      `bestvideo[height<=${MAX_HEIGHT}]+bestaudio`,
      `best[height<=${MAX_HEIGHT}]`,
      'best',
    ].join('/'),
    '--merge-output-format',
    'mp4',
    '--max-filesize',
    String(MAX_VIDEO_BYTES),
    '--ffmpeg-location',
    ffmpeg,
    '--windows-filenames',
    '--trim-filenames',
    '80',
    '-o',
    path.join(folder, '%(title)s [%(id)s].%(ext)s'),
    // Where the file actually landed, which is otherwise guesswork once the
    // title has been trimmed and sanitised.
    '--print-to-file',
    'after_move:%(filepath)s\t%(title)s\t%(uploader)s\t%(duration)s',
    report,
  ]
}

/** yt-dlp writes a bare NA where a field is missing, which is not a name. */
function given(value: string | undefined): string {
  const text = (value ?? '').trim()
  return text === 'NA' ? '' : text
}

export function parseReport(text: string): { path: string; title: string; channel: string; duration: number } | null {
  const line = text.split(/\r?\n/).find((entry) => entry.trim().length > 0)
  if (!line) return null

  const [file, title, channel, duration] = line.split('\t')
  if (!file?.trim()) return null

  const seconds = Number.parseFloat(given(duration))
  return {
    path: file.trim(),
    title: given(title),
    channel: given(channel),
    duration: Number.isFinite(seconds) && seconds > 0 ? seconds : 0,
  }
}

export async function fetchYoutubeVideo(
  userData: string,
  folder: string,
  url: string,
  onProgress?: (fraction: number) => void,
): Promise<FetchedVideo> {
  if (!isYoutubeUrl(url)) return { error: `${url} is not a YouTube address.` }

  const tool = await ensureTool(userData)
  if ('error' in tool) return tool

  try {
    await mkdir(folder, { recursive: true })
  } catch (error) {
    return { error: `I could not create ${folder}: ${(error as Error).message}` }
  }

  const report = path.join(os.tmpdir(), `aicut-ytdlp-${Date.now()}.txt`)

  const run = await new Promise<{ code: number | null; output: string; failed?: string }>((resolve) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(tool.path, downloadArgs(url, folder, report, ffmpegBinary()), { windowsHide: true })
    } catch (error) {
      resolve({ code: null, output: '', failed: (error as Error).message })
      return
    }

    let output = ''
    let settled = false

    const timer = setTimeout(() => {
      child.kill()
      settled = true
      resolve({ code: null, output, failed: 'the download took too long and was stopped' })
    }, DOWNLOAD_TIMEOUT_MS)

    const read = (chunk: Buffer) => {
      const text = chunk.toString()
      // Only the tail matters, and a long download prints a great deal.
      output = (output + text).slice(-8000)
      if (!onProgress) return

      for (const line of text.split(/[\r\n]/)) {
        const fraction = progressFromLine(line)
        if (fraction !== null) onProgress(fraction)
      }
    }

    child.stdout?.on('data', read)
    child.stderr?.on('data', read)

    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code: null, output, failed: error.message })
    })

    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code, output })
    })
  })

  let written = ''
  try {
    written = await readFile(report, 'utf8')
  } catch {
    written = ''
  }
  await rm(report, { force: true }).catch(() => {})

  if (run.failed) {
    return { error: `That download failed: ${run.failed}.` }
  }

  const details = parseReport(written)
  if (run.code !== 0 || !details) {
    return { error: readFailure(run.output) }
  }

  let size = 0
  try {
    size = (await stat(details.path)).size
  } catch {
    return { error: 'yt-dlp reported success but the file is not on disk.' }
  }

  if (size === 0) return { error: 'That download produced an empty file.' }

  return {
    path: details.path,
    name: path.basename(details.path),
    size,
    title: details.title,
    channel: details.channel,
    duration: details.duration,
  }
}
