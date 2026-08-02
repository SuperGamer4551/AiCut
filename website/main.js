const REPO = 'SuperGamer4551/AiCut'
const RELEASES = `https://api.github.com/repos/${REPO}/releases/latest`
const FALLBACK = `https://github.com/${REPO}/releases/latest`

const button = document.getElementById('download')
const meta = document.getElementById('download-meta')

function pickInstaller(assets) {
  if (!Array.isArray(assets)) return null
  const exe = assets.find(
    (asset) =>
      typeof asset?.name === 'string' &&
      /\.exe$/i.test(asset.name) &&
      /setup/i.test(asset.name) &&
      typeof asset.browser_download_url === 'string',
  )
  return exe || null
}

async function wireDownload() {
  if (!button || !meta) return

  button.classList.add('is-loading')

  try {
    const response = await fetch(RELEASES, {
      headers: { Accept: 'application/vnd.github+json' },
    })
    if (!response.ok) throw new Error(`GitHub ${response.status}`)

    const release = await response.json()
    const installer = pickInstaller(release.assets)
    const version = typeof release.tag_name === 'string' ? release.tag_name.replace(/^v/, '') : null

    if (installer) {
      button.href = installer.browser_download_url
      meta.textContent = version
        ? `Version ${version} · Windows installer`
        : 'Free · Windows installer'
    } else {
      button.href = release.html_url || FALLBACK
      meta.textContent = version
        ? `Version ${version} · Open the release page`
        : 'Open the latest release'
    }
  } catch {
    button.href = FALLBACK
    meta.textContent = 'Free · Opens the latest release'
  } finally {
    button.classList.remove('is-loading')
  }
}

void wireDownload()
