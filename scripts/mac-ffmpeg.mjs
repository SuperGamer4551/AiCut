// Fetches the two mac ffmpeg binaries the release needs, into build/ffmpeg.
//
// The app carries ffmpeg so there is nothing to install, but ffmpeg-static only
// downloads the binary for the machine doing the installing. A mac release is
// built once and has to run on both Apple silicon and Intel, so the pair is
// pulled straight from the same GitHub release ffmpeg-static installs from,
// pinned to whatever version this project already depends on.
//
// Run with: npm run ffmpeg:mac
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const out = path.join(root, 'build', 'ffmpeg')

const ARCHES = ['x64', 'arm64']

/** ffmpeg is around 70 MB; anything tiny is an error page wearing its name. */
const SMALLEST_PLAUSIBLE = 10 * 1024 * 1024

/** The release ffmpeg-static itself installs from, so the app runs one ffmpeg. */
async function releaseTag() {
  const manifest = path.join(root, 'node_modules', 'ffmpeg-static', 'package.json')

  try {
    const pkg = JSON.parse(await readFile(manifest, 'utf8'))
    const tag = pkg['ffmpeg-static']?.['binary-release-tag']
    if (tag) return tag
    throw new Error('no binary-release-tag in ffmpeg-static')
  } catch (error) {
    throw new Error(`could not read ${manifest} — run npm install first (${error.message})`)
  }
}

async function sizeOf(file) {
  try {
    return (await stat(file)).size
  } catch {
    return 0
  }
}

async function fetchBinary(url, target) {
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok) throw new Error(`${url} answered ${response.status} ${response.statusText}`)

  const body = Buffer.from(await response.arrayBuffer())
  if (body.length < SMALLEST_PLAUSIBLE) {
    throw new Error(`${url} returned ${body.length} bytes, which is not ffmpeg`)
  }

  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(target, body)
  // Copied into the app bundle as-is, and macOS will not run it otherwise.
  await chmod(target, 0o755)

  return body.length
}

const tag = await releaseTag()

for (const arch of ARCHES) {
  const target = path.join(out, arch, 'ffmpeg')
  const already = await sizeOf(target)

  if (already >= SMALLEST_PLAUSIBLE) {
    console.log(`ffmpeg ${arch}  already here`)
    continue
  }

  const url = `https://github.com/eugeneware/ffmpeg-static/releases/download/${tag}/ffmpeg-darwin-${arch}`
  const size = await fetchBinary(url, target)
  console.log(`ffmpeg ${arch}  ${(size / 1024 / 1024).toFixed(1)} MB from ${tag}`)
}

console.log(`written to ${out}`)
