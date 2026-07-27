// Standalone check that the aicut:// media protocol streams local files with range support.
// Run with: npx electron scripts/check-media-protocol.cjs
const { app, protocol, net } = require('electron')
const { mkdtemp, writeFile, rm } = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { createReadStream } = require('node:fs')
const { stat } = require('node:fs/promises')
const { Readable } = require('node:stream')

const MEDIA_SCHEME = 'aicut'

protocol.registerSchemesAsPrivileged([
  {
    scheme: MEDIA_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
])

function filePathFromRequest(rawUrl) {
  const { pathname } = new URL(rawUrl)
  return path.normalize(decodeURIComponent(pathname.replace(/^\//, '')))
}

async function handler(request) {
  const filePath = filePathFromRequest(request.url)
  const info = await stat(filePath)
  const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get('Range') ?? '')

  if (range) {
    const start = range[1] ? Number(range[1]) : 0
    const end = range[2] ? Math.min(Number(range[2]), info.size - 1) : info.size - 1
    return new Response(Readable.toWeb(createReadStream(filePath, { start, end })), {
      status: 206,
      headers: {
        'Content-Type': 'video/mp4',
        'Content-Length': String(end - start + 1),
        'Content-Range': `bytes ${start}-${end}/${info.size}`,
        'Accept-Ranges': 'bytes',
      },
    })
  }

  return new Response(Readable.toWeb(createReadStream(filePath)), {
    status: 200,
    headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(info.size) },
  })
}

app.whenReady().then(async () => {
  protocol.handle(MEDIA_SCHEME, handler)

  const dir = await mkdtemp(path.join(os.tmpdir(), 'aicut-test-'))
  const filePath = path.join(dir, 'sample space & symbols.mp4')
  const payload = Buffer.from('0123456789ABCDEF')
  await writeFile(filePath, payload)

  const url = `${MEDIA_SCHEME}://local/${encodeURIComponent(filePath)}`
  let failures = 0

  const full = await net.fetch(url)
  const fullBody = Buffer.from(await full.arrayBuffer()).toString()
  console.log('full request      ->', full.status, JSON.stringify(fullBody))
  if (full.status !== 200 || fullBody !== payload.toString()) failures += 1

  const partial = await net.fetch(url, { headers: { Range: 'bytes=4-7' } })
  const partialBody = Buffer.from(await partial.arrayBuffer()).toString()
  console.log('range request     ->', partial.status, JSON.stringify(partialBody), partial.headers.get('content-range'))
  if (partial.status !== 206 || partialBody !== '4567') failures += 1

  const missing = await net.fetch(`${MEDIA_SCHEME}://local/${encodeURIComponent(path.join(dir, 'nope.mp4'))}`)
    .then((res) => res.status)
    .catch(() => 'rejected')
  console.log('missing file      ->', missing)

  await rm(dir, { recursive: true, force: true })
  console.log(failures === 0 ? 'RESULT: pass' : `RESULT: fail (${failures})`)
  app.exit(failures === 0 ? 0 : 1)
})
