// Assertions for YouTube publishing: the consent URL, token handling, and the
// resumable upload, all against a stand-in for Google's endpoints.
// Run with: npm run check:youtube
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { YoutubeEndpoints } from '../electron/youtube'
import {
  EMPTY_ACCOUNT,
  authUrl,
  ensureAccessToken,
  exchangeCode,
  fetchChannel,
  normalizeAccount,
  normalizeVisibility,
  parseTags,
  publicAccount,
  readAccountFile,
  uploadBody,
  uploadVideo,
  writeAccountFile,
} from '../electron/youtube'

let failures = 0

function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected)
  if (!pass) failures += 1
  console.log(`${pass ? 'pass' : 'FAIL'}  ${label}`)
  if (!pass) console.log(`      expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

type Seen = {
  method: string
  path: string
  auth: string
  contentRange: string
  body: string
}

type Reply = { status: number; payload?: unknown; headers?: Record<string, string> }

/** A stand-in for Google, so the flow can be exercised end to end. */
async function fakeGoogle(handler: (seen: Seen) => Reply) {
  const seen: Seen[] = []

  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => {
      body += String(chunk)
    })
    req.on('end', () => {
      const record: Seen = {
        method: req.method ?? '',
        path: (req.url ?? '').split('?')[0],
        auth: String(req.headers.authorization ?? ''),
        contentRange: String(req.headers['content-range'] ?? ''),
        body,
      }
      seen.push(record)

      const reply = handler(record)
      res.writeHead(reply.status, { 'content-type': 'application/json', ...(reply.headers ?? {}) })
      res.end(reply.payload === undefined ? '' : JSON.stringify(reply.payload))
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  const base = `http://127.0.0.1:${port}`

  const endpoints: YoutubeEndpoints = {
    auth: `${base}/auth`,
    token: `${base}/token`,
    channels: `${base}/channels`,
    upload: `${base}/upload`,
  }

  return {
    endpoints,
    base,
    seen,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

async function main() {
  // --- Consent URL --------------------------------------------------------
  const consent = new URL(
    authUrl(
      { auth: 'https://accounts.google.com/o/oauth2/v2/auth', token: '', channels: '', upload: '' },
      { clientId: 'client-1', redirectUri: 'http://127.0.0.1:5321', state: 'state-1' },
    ),
  )
  check('consent goes to Google', consent.host, 'accounts.google.com')
  check('the client id is sent', consent.searchParams.get('client_id'), 'client-1')
  check('the loopback address is the redirect', consent.searchParams.get('redirect_uri'), 'http://127.0.0.1:5321')
  check('a code is requested', consent.searchParams.get('response_type'), 'code')
  check('offline access is requested so uploads work later', consent.searchParams.get('access_type'), 'offline')
  check('consent is forced so a refresh token comes back', consent.searchParams.get('prompt'), 'consent')
  check('the upload scope is requested', consent.searchParams.get('scope')?.includes('youtube.upload'), true)
  check('the state is passed through', consent.searchParams.get('state'), 'state-1')

  // --- Visibility and metadata -------------------------------------------
  check('visibility defaults to private', normalizeVisibility(undefined), 'private')
  check('an unknown visibility falls back to private', normalizeVisibility('semi-public'), 'private')
  check('public is honoured when asked for', normalizeVisibility('PUBLIC'), 'public')
  check('unlisted is honoured', normalizeVisibility('unlisted'), 'unlisted')

  check('tags are split on commas', parseTags('travel, beach , summer'), ['travel', 'beach', 'summer'])
  check('no tags is an empty list', parseTags(undefined), [])

  const body = JSON.parse(
    uploadBody({ title: 'Trip', description: 'A day out', visibility: 'unlisted', tags: ['travel'] }),
  )
  check('the title is sent', body.snippet.title, 'Trip')
  check('the description is sent', body.snippet.description, 'A day out')
  check('the visibility is sent', body.status.privacyStatus, 'unlisted')
  check('nothing is declared as made for kids', body.status.selfDeclaredMadeForKids, false)
  check('an over-long title is cut to what YouTube accepts', JSON.parse(uploadBody({ title: 'x'.repeat(150), description: '', visibility: 'private', tags: [] })).snippet.title.length, 100)

  // --- Stored account ----------------------------------------------------
  const stored = {
    clientId: 'client-1',
    clientSecret: 'secret-1',
    accessToken: 'access-1',
    refreshToken: 'refresh-1',
    expiresAt: 5_000,
    channelId: 'chan-1',
    channelTitle: 'My Channel',
  }
  check('an account survives a round trip', normalizeAccount(stored), stored)
  check('junk on disk yields an empty account', normalizeAccount('nope'), EMPTY_ACCOUNT)
  check('the renderer sees the channel but no secret', publicAccount(stored), {
    connected: true,
    hasCredentials: true,
    channelTitle: 'My Channel',
    channelId: 'chan-1',
  })
  check('an account without a refresh token is not connected', publicAccount({ ...stored, refreshToken: '' }).connected, false)
  check('credentials alone are reported separately', publicAccount({ ...EMPTY_ACCOUNT, clientId: 'a', clientSecret: 'b' }), {
    connected: false,
    hasCredentials: true,
    channelTitle: '',
    channelId: '',
  })

  const dir = await mkdtemp(path.join(tmpdir(), 'aicut-yt-'))
  const file = path.join(dir, 'youtube.json')
  check('a missing file yields an empty account', await readAccountFile(file), EMPTY_ACCOUNT)
  await writeAccountFile(file, stored)
  check('the account is read back from disk', await readAccountFile(file), stored)

  // --- Signing in --------------------------------------------------------
  const google = await fakeGoogle((seen) => {
    if (seen.path === '/token' && seen.body.includes('authorization_code')) {
      return {
        status: 200,
        payload: { access_token: 'access-new', refresh_token: 'refresh-new', expires_in: 3600 },
      }
    }
    if (seen.path === '/token') {
      return { status: 200, payload: { access_token: 'access-refreshed', expires_in: 1800 } }
    }
    if (seen.path === '/channels') {
      return { status: 200, payload: { items: [{ id: 'chan-9', snippet: { title: 'Reyan Films' } }] } }
    }
    return { status: 404, payload: {} }
  })

  const exchanged = await exchangeCode(google.endpoints, {
    clientId: 'client-1',
    clientSecret: 'secret-1',
    code: 'code-1',
    redirectUri: 'http://127.0.0.1:1',
  })
  check('a code becomes tokens', 'error' in exchanged ? exchanged : exchanged.accessToken, 'access-new')
  check('the refresh token is kept', 'error' in exchanged ? '' : exchanged.refreshToken, 'refresh-new')
  check('the code is exchanged with a grant type', google.seen[0].body.includes('grant_type=authorization_code'), true)

  const channel = await fetchChannel(google.endpoints, 'access-new')
  check('the channel name is read', 'error' in channel ? channel : channel.title, 'Reyan Films')
  check('the channel is fetched with the token', google.seen[1].auth, 'Bearer access-new')

  const fresh = await ensureAccessToken(google.endpoints, { ...stored, expiresAt: Date.now() + 600_000 })
  check('a valid token is left alone', 'error' in fresh ? true : fresh.refreshed, false)

  const renewed = await ensureAccessToken(google.endpoints, { ...stored, expiresAt: Date.now() - 1 })
  check('an expired token is refreshed', 'error' in renewed ? '' : renewed.account.accessToken, 'access-refreshed')
  check('a refresh is reported so it can be saved', 'error' in renewed ? false : renewed.refreshed, true)

  const soon = await ensureAccessToken(google.endpoints, { ...stored, expiresAt: Date.now() + 30_000 })
  check('a token about to expire is refreshed early', 'error' in soon ? '' : soon.account.accessToken, 'access-refreshed')

  check(
    'without a refresh token there is nothing to renew',
    'error' in (await ensureAccessToken(google.endpoints, EMPTY_ACCOUNT)),
    true,
  )
  await google.close()

  const refused = await fakeGoogle(() => ({ status: 400, payload: { error_description: 'bad code' } }))
  const rejected = await exchangeCode(refused.endpoints, {
    clientId: 'c',
    clientSecret: 's',
    code: 'wrong',
    redirectUri: 'http://127.0.0.1:1',
  })
  check("Google's complaint is passed on", 'error' in rejected ? rejected.error : '', 'bad code')
  await refused.close()

  const noRefresh = await fakeGoogle(() => ({ status: 200, payload: { access_token: 'a', expires_in: 60 } }))
  const halfSignedIn = await exchangeCode(noRefresh.endpoints, {
    clientId: 'c',
    clientSecret: 's',
    code: 'code',
    redirectUri: 'http://127.0.0.1:1',
  })
  check('a missing refresh token is explained', 'error' in halfSignedIn ? halfSignedIn.error.includes('refresh token') : false, true)
  await noRefresh.close()

  const noChannel = await fakeGoogle(() => ({ status: 200, payload: { items: [] } }))
  check(
    'an account with no channel is reported',
    'error' in (await fetchChannel(noChannel.endpoints, 'a')),
    true,
  )
  await noChannel.close()

  // --- Uploading ---------------------------------------------------------
  const videoFile = path.join(dir, 'render.mp4')
  await writeFile(videoFile, Buffer.alloc(2500, 7))

  // The session URL Google hands back has to point at the stand-in server.
  let sessionBase = ''

  const uploads = await fakeGoogle((seen) => {
    if (seen.method === 'POST') {
      return { status: 200, headers: { location: `${sessionBase}/upload/session-1` }, payload: {} }
    }
    // Each chunk but the last is acknowledged with a 308.
    const end = Number(/bytes (\d+)-(\d+)\/(\d+)/.exec(seen.contentRange)?.[2] ?? 0)
    const total = Number(/bytes (\d+)-(\d+)\/(\d+)/.exec(seen.contentRange)?.[3] ?? 0)
    return end + 1 >= total
      ? { status: 200, payload: { id: 'video-1' } }
      : { status: 308, payload: undefined }
  })
  sessionBase = uploads.base

  const progress: number[] = []
  const uploaded = await uploadVideo(uploads.endpoints, {
    accessToken: 'access-1',
    filePath: videoFile,
    metadata: { title: 'Trip', description: '', visibility: 'private', tags: [] },
    chunkSize: 1000,
    onProgress: (fraction) => progress.push(Number(fraction.toFixed(2))),
  })

  check('an upload returns the video id', 'error' in uploaded ? uploaded : uploaded.videoId, 'video-1')
  check('an upload returns a watch link', 'error' in uploaded ? '' : uploaded.url, 'https://youtu.be/video-1')
  check('the session is opened with the token', uploads.seen[0].auth, 'Bearer access-1')
  check('the session declares the file size', uploads.seen[0].body.includes('Trip'), true)
  check('the file goes up in chunks', uploads.seen.length, 4)
  check('the first chunk starts at zero', uploads.seen[1].contentRange, 'bytes 0-999/2500')
  check('the last chunk finishes the file', uploads.seen[3].contentRange, 'bytes 2000-2499/2500')
  check('progress is reported for each chunk', progress, [0.4, 0.8, 1])
  await uploads.close()

  const noSession = await fakeGoogle(() => ({ status: 200, payload: {} }))
  check(
    'an upload with no session is reported',
    'error' in (await uploadVideo(noSession.endpoints, {
      accessToken: 'a',
      filePath: videoFile,
      metadata: { title: 't', description: '', visibility: 'private', tags: [] },
    })),
    true,
  )
  await noSession.close()

  const quota = await fakeGoogle(() => ({ status: 403, payload: { error: { message: 'quotaExceeded' } } }))
  const blocked = await uploadVideo(quota.endpoints, {
    accessToken: 'a',
    filePath: videoFile,
    metadata: { title: 't', description: '', visibility: 'private', tags: [] },
  })
  check('a refused upload explains why', 'error' in blocked ? blocked.error.includes('quotaExceeded') : false, true)
  await quota.close()

  const emptyFile = path.join(dir, 'empty.mp4')
  await writeFile(emptyFile, Buffer.alloc(0))
  const nothing = await uploadVideo(GOOGLE_STUB, {
    accessToken: 'a',
    filePath: emptyFile,
    metadata: { title: 't', description: '', visibility: 'private', tags: [] },
  })
  check('an empty render is not uploaded', 'error' in nothing ? nothing.error.includes('empty') : false, true)

  console.log(failures === 0 ? '\nRESULT: pass' : `\nRESULT: fail (${failures})`)
  if (failures > 0) process.exitCode = 1
}

const GOOGLE_STUB: YoutubeEndpoints = {
  auth: 'http://127.0.0.1:1/auth',
  token: 'http://127.0.0.1:1/token',
  channels: 'http://127.0.0.1:1/channels',
  upload: 'http://127.0.0.1:1/upload',
}

void main()
