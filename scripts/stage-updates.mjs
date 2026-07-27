// Collects what the updater needs out of release/ and into update-site/, which
// is the folder that gets deployed. electron-builder writes latest.yml beside
// the installer; the app reads that file to decide whether it is out of date.
// Run with: npm run updates:stage
import { copyFileSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const release = path.join(root, 'release')
const site = path.join(root, 'update-site')

/** Vercel refuses a static file bigger than this on the free plan. */
const VERCEL_FREE_LIMIT = 100 * 1024 * 1024

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`

let entries
try {
  entries = readdirSync(release)
} catch {
  console.error('No release folder. Run "npm run dist" first.')
  process.exit(1)
}

const wanted = entries.filter(
  (name) => name === 'latest.yml' || name.endsWith('.exe') || name.endsWith('.blockmap'),
)

if (!wanted.includes('latest.yml')) {
  console.error('No latest.yml in release/. The build needs a "publish" entry to write one.')
  process.exit(1)
}

mkdirSync(site, { recursive: true })

let oversized = []
for (const name of wanted) {
  const from = path.join(release, name)
  const size = statSync(from).size
  copyFileSync(from, path.join(site, name))
  if (size > VERCEL_FREE_LIMIT) oversized.push({ name, size })
  console.log(`  ${name.padEnd(34)} ${mb(size)}`)
}

// A plain landing page, so opening the URL in a browser says what it is rather
// than returning a directory listing or a 404.
const version = /version:\s*(\S+)/.exec(readFileSync(path.join(site, 'latest.yml'), 'utf8'))?.[1] ?? '?'
writeFileSync(
  path.join(site, 'index.html'),
  `<!doctype html>
<meta charset="utf-8">
<title>AiCut updates</title>
<style>body{background:#0a0d15;color:#e8ecf1;font:15px/1.6 system-ui,sans-serif;margin:0;display:grid;place-items:center;height:100vh}a{color:#4ae3a8}</style>
<div>
  <h1>AiCut ${version}</h1>
  <p>This host feeds updates to the AiCut desktop app.</p>
  <p><a href="./latest.yml">latest.yml</a></p>
</div>
`,
)

console.log(`\nStaged into ${site}`)

if (oversized.length > 0) {
  console.log('\nToo big for Vercel on the free plan (100 MB a file):')
  for (const { name, size } of oversized) console.log(`  ${name} is ${mb(size)}`)
  console.log('Host the installer elsewhere and redirect to it, or deploy on a paid plan.')
}
