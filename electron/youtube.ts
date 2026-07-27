import { createReadStream } from 'node:fs'
import { readFile, stat, writeFile } from 'node:fs/promises'

/**
 * YouTube publishing over the Data API v3. The OAuth loopback flow and the
 * resumable upload are written against plain fetch so they can be exercised
 * against a stand-in server in tests.
 */

export const OAUTH_SCOPE = 'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly'

export type YoutubeEndpoints = {
  auth: string
  token: string
  channels: string
  upload: string
}

export const GOOGLE_ENDPOINTS: YoutubeEndpoints = {
  auth: 'https://accounts.google.com/o/oauth2/v2/auth',
  token: 'https://oauth2.googleapis.com/token',
  channels: 'https://www.googleapis.com/youtube/v3/channels',
  upload: 'https://www.googleapis.com/upload/youtube/v3/videos',
}

export type YoutubeAccount = {
  clientId: string
  clientSecret: string
  accessToken: string
  refreshToken: string
  /** Epoch milliseconds. */
  expiresAt: number
  channelId: string
  channelTitle: string
}

export const EMPTY_ACCOUNT: YoutubeAccount = {
  clientId: '',
  clientSecret: '',
  accessToken: '',
  refreshToken: '',
  expiresAt: 0,
  channelId: '',
  channelTitle: '',
}

export type PublicYoutubeAccount = {
  connected: boolean
  hasCredentials: boolean
  channelTitle: string
  channelId: string
}

export const VISIBILITIES = ['private', 'unlisted', 'public'] as const

export type Visibility = (typeof VISIBILITIES)[number]

/** Uploads stay private unless the user explicitly says otherwise. */
export function normalizeVisibility(value: string | undefined): Visibility {
  const raw = (value ?? '').trim().toLowerCase()
  return (VISIBILITIES as readonly string[]).includes(raw) ? (raw as Visibility) : 'private'
}

export function normalizeAccount(value: unknown): YoutubeAccount {
  if (!value || typeof value !== 'object') return EMPTY_ACCOUNT
  const parsed = value as Partial<YoutubeAccount>

  const text = (input: unknown): string => (typeof input === 'string' ? input : '')
  return {
    clientId: text(parsed.clientId),
    clientSecret: text(parsed.clientSecret),
    accessToken: text(parsed.accessToken),
    refreshToken: text(parsed.refreshToken),
    expiresAt: typeof parsed.expiresAt === 'number' ? parsed.expiresAt : 0,
    channelId: text(parsed.channelId),
    channelTitle: text(parsed.channelTitle),
  }
}

export function publicAccount(account: YoutubeAccount): PublicYoutubeAccount {
  return {
    connected: Boolean(account.refreshToken && account.channelId),
    hasCredentials: Boolean(account.clientId && account.clientSecret),
    channelTitle: account.channelTitle,
    channelId: account.channelId,
  }
}

export async function readAccountFile(filePath: string): Promise<YoutubeAccount> {
  try {
    return normalizeAccount(JSON.parse(await readFile(filePath, 'utf8')))
  } catch {
    return EMPTY_ACCOUNT
  }
}

export async function writeAccountFile(filePath: string, account: YoutubeAccount): Promise<void> {
  await writeFile(filePath, JSON.stringify(account, null, 2), 'utf8')
}

export function authUrl(
  endpoints: YoutubeEndpoints,
  args: { clientId: string; redirectUri: string; state: string },
): string {
  const query = new URLSearchParams({
    client_id: args.clientId,
    redirect_uri: args.redirectUri,
    response_type: 'code',
    scope: OAUTH_SCOPE,
    access_type: 'offline',
    // Without this an already-approved account returns no refresh token.
    prompt: 'consent',
    state: args.state,
  })

  return `${endpoints.auth}?${query.toString()}`
}

type TokenReply = {
  access_token?: string
  refresh_token?: string
  expires_in?: number
  error?: string
  error_description?: string
}

async function postForm(url: string, body: Record<string, string>): Promise<TokenReply> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  })

  const payload = (await response.json().catch(() => ({}))) as TokenReply
  if (!response.ok) {
    return { error: payload.error_description ?? payload.error ?? `${response.status} ${response.statusText}` }
  }
  return payload
}

export async function exchangeCode(
  endpoints: YoutubeEndpoints,
  args: { clientId: string; clientSecret: string; code: string; redirectUri: string },
): Promise<{ accessToken: string; refreshToken: string; expiresAt: number } | { error: string }> {
  const reply = await postForm(endpoints.token, {
    client_id: args.clientId,
    client_secret: args.clientSecret,
    code: args.code,
    redirect_uri: args.redirectUri,
    grant_type: 'authorization_code',
  })

  if (reply.error) return { error: reply.error }
  if (!reply.access_token) return { error: 'Google did not return an access token.' }
  if (!reply.refresh_token) {
    return { error: 'Google did not return a refresh token. Remove the app from your Google account permissions and try again.' }
  }

  return {
    accessToken: reply.access_token,
    refreshToken: reply.refresh_token,
    expiresAt: Date.now() + (reply.expires_in ?? 3600) * 1000,
  }
}

/** Refreshes when the token is spent or about to be, and leaves it alone otherwise. */
export async function ensureAccessToken(
  endpoints: YoutubeEndpoints,
  account: YoutubeAccount,
  now = Date.now(),
): Promise<{ account: YoutubeAccount; refreshed: boolean } | { error: string }> {
  if (!account.refreshToken) return { error: 'not-connected' }
  if (account.accessToken && account.expiresAt - now > 60_000) {
    return { account, refreshed: false }
  }

  const reply = await postForm(endpoints.token, {
    client_id: account.clientId,
    client_secret: account.clientSecret,
    refresh_token: account.refreshToken,
    grant_type: 'refresh_token',
  })

  if (reply.error) return { error: reply.error }
  if (!reply.access_token) return { error: 'Google did not return a new access token.' }

  return {
    account: {
      ...account,
      accessToken: reply.access_token,
      expiresAt: now + (reply.expires_in ?? 3600) * 1000,
    },
    refreshed: true,
  }
}

export async function fetchChannel(
  endpoints: YoutubeEndpoints,
  accessToken: string,
): Promise<{ id: string; title: string } | { error: string }> {
  const response = await fetch(`${endpoints.channels}?part=snippet&mine=true`, {
    headers: { authorization: `Bearer ${accessToken}` },
  })

  const payload = (await response.json().catch(() => ({}))) as {
    items?: { id?: string; snippet?: { title?: string } }[]
    error?: { message?: string }
  }

  if (!response.ok) {
    return { error: payload.error?.message ?? `${response.status} ${response.statusText}` }
  }

  const channel = payload.items?.[0]
  if (!channel?.id) return { error: 'That Google account has no YouTube channel.' }

  return { id: channel.id, title: channel.snippet?.title ?? 'Your channel' }
}

export type UploadMetadata = {
  title: string
  description: string
  visibility: Visibility
  tags: string[]
}

export function uploadBody(metadata: UploadMetadata): string {
  return JSON.stringify({
    snippet: {
      title: metadata.title.slice(0, 100),
      description: metadata.description.slice(0, 5000),
      tags: metadata.tags.slice(0, 30),
    },
    status: {
      privacyStatus: metadata.visibility,
      selfDeclaredMadeForKids: false,
    },
  })
}

export function parseTags(value: string | undefined): string[] {
  if (!value) return []
  return value
    .split(',')
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0)
}

/** 8 MB keeps the request count sane while still reporting progress often. */
export const CHUNK_SIZE = 8 * 1024 * 1024

async function readChunk(filePath: string, start: number, end: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const piece of createReadStream(filePath, { start, end })) {
    chunks.push(piece as Buffer)
  }
  return Buffer.concat(chunks)
}

export type UploadResult = { videoId: string; url: string } | { error: string }

/**
 * Resumable upload: open a session, then send the file in chunks so progress can
 * be reported and a stall does not mean starting over.
 */
export async function uploadVideo(
  endpoints: YoutubeEndpoints,
  args: {
    accessToken: string
    filePath: string
    metadata: UploadMetadata
    onProgress?: (fraction: number) => void
    chunkSize?: number
    fileSize?: number
  },
): Promise<UploadResult> {
  const size = args.fileSize ?? (await stat(args.filePath)).size
  if (size <= 0) return { error: 'The rendered file is empty, so there is nothing to upload.' }

  const start = await fetch(`${endpoints.upload}?uploadType=resumable&part=snippet,status`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${args.accessToken}`,
      'content-type': 'application/json',
      'x-upload-content-length': String(size),
      'x-upload-content-type': 'video/*',
    },
    body: uploadBody(args.metadata),
  })

  if (!start.ok) {
    const detail = (await start.text()).slice(0, 300)
    return { error: `YouTube refused the upload (${start.status}): ${detail}` }
  }

  const session = start.headers.get('location')
  if (!session) return { error: 'YouTube did not return an upload session.' }

  const chunkSize = args.chunkSize ?? CHUNK_SIZE
  let offset = 0

  while (offset < size) {
    const end = Math.min(offset + chunkSize, size) - 1
    const body = await readChunk(args.filePath, offset, end)

    const response = await fetch(session, {
      method: 'PUT',
      headers: {
        'content-length': String(body.byteLength),
        'content-range': `bytes ${offset}-${end}/${size}`,
      },
      body: new Uint8Array(body),
    })

    // 308 means the chunk landed and more is expected.
    if (response.status === 308 || response.status === 201 || response.status === 200) {
      offset = end + 1
      args.onProgress?.(offset / size)

      if (response.status === 200 || response.status === 201) {
        const payload = (await response.json().catch(() => ({}))) as { id?: string }
        if (!payload.id) return { error: 'The upload finished but YouTube returned no video id.' }
        return { videoId: payload.id, url: `https://youtu.be/${payload.id}` }
      }
      continue
    }

    const detail = (await response.text()).slice(0, 300)
    return { error: `The upload failed at ${Math.round((offset / size) * 100)}% (${response.status}): ${detail}` }
  }

  return { error: 'The upload ended without a confirmation from YouTube.' }
}
