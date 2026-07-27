// Creates the GitHub release before electron-builder starts uploading to it.
//
// Without this, the installer and its blockmap are published in parallel and
// each one, finding no release for the tag, creates its own. The tag then
// resolves to whichever won, and if that is the release holding only the
// blockmap then latest.yml is unreachable and no installed copy ever sees the
// update. That happened on 0.9.0 and had to be repaired by hand.
//
// Anything unexpected here is a warning rather than a failure: the build should
// still go out, and the worst case is the same race as before.
import { readFileSync } from 'node:fs'

const API = 'https://api.github.com'

function warn(message) {
  console.warn(`ensure-release: ${message}`)
}

async function main() {
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN
  if (!token) {
    warn('no GH_TOKEN, leaving the release to electron-builder')
    return
  }

  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const target = pkg.build?.publish?.find((entry) => entry.provider === 'github')
  if (!target?.owner || !target?.repo) {
    warn('no github publish target in package.json')
    return
  }

  const tag = `v${pkg.version}`
  const repo = `${target.owner}/${target.repo}`
  const headers = {
    authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json',
    'user-agent': 'aicut-release',
  }

  const existing = await fetch(`${API}/repos/${repo}/releases/tags/${tag}`, { headers })
  if (existing.ok) {
    console.log(`ensure-release: ${tag} already exists, uploading into it`)
    return
  }
  if (existing.status !== 404) {
    warn(`could not check for ${tag}: ${existing.status} ${existing.statusText}`)
    return
  }

  const created = await fetch(`${API}/repos/${repo}/releases`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ tag_name: tag, name: tag, draft: false, prerelease: false }),
  })

  if (!created.ok) {
    warn(`could not create ${tag}: ${created.status} ${created.statusText}`)
    return
  }

  console.log(`ensure-release: created ${tag} for ${repo}`)
}

await main()
