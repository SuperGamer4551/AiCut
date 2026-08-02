const REPO = 'SuperGamer4551/AiCut'
const RELEASES = `https://api.github.com/repos/${REPO}/releases/latest`
const FALLBACK = `https://github.com/${REPO}/releases/latest`

/**
 * The builds a release can hold, in the order they are offered to somebody the
 * page could not place. Each release is matched by the name of its file rather
 * than its position, so a missing build is simply not offered.
 */
const BUILDS = [
  {
    id: 'win',
    label: 'Windows',
    kind: 'Windows installer',
    matches: (name) => /setup/i.test(name) && /\.exe$/i.test(name),
  },
  {
    id: 'mac-arm64',
    label: 'Mac · Apple silicon',
    kind: 'Mac disk image, Apple silicon',
    matches: (name) => /arm64\.dmg$/i.test(name),
  },
  {
    id: 'mac-x64',
    label: 'Mac · Intel',
    kind: 'Mac disk image, Intel',
    matches: (name) => /(x64|x86_64)\.dmg$/i.test(name),
  },
]

/** The disk image is signed ad-hoc, so the first launch has to be allowed. */
const MAC_NOTE =
  'First time on a Mac: open Applications, right-click AiCut and choose Open. macOS asks once because the app is not from the App Store.'

const button = document.getElementById('download')
const meta = document.getElementById('download-meta')
const alt = document.getElementById('download-alt')
const note = document.getElementById('download-note')

/**
 * Which Mac this is. Browsers stopped telling anyone — every Mac calls itself
 * Intel in the user agent — so the graphics card is the honest answer, and a
 * Mac that will not say is far more likely to be Apple silicon than not.
 */
function isAppleSilicon() {
  try {
    const gl = document.createElement('canvas').getContext('webgl')
    const debug = gl?.getExtension('WEBGL_debug_renderer_info')
    const renderer = debug ? String(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)) : ''

    if (/apple\s*m\d|apple gpu/i.test(renderer)) return true
    if (/intel|radeon|amd|nvidia|geforce/i.test(renderer)) return false
  } catch {
    // Nothing to learn from a blocked canvas; fall through to the guess.
  }

  return true
}

function thisComputer() {
  const ua = navigator.userAgent
  if (/mac/i.test(ua) && !/iphone|ipad/i.test(ua)) return isAppleSilicon() ? 'mac-arm64' : 'mac-x64'
  if (/win/i.test(ua)) return 'win'
  return null
}

function findAssets(assets) {
  const found = new Map()
  if (!Array.isArray(assets)) return found

  for (const build of BUILDS) {
    const asset = assets.find(
      (item) =>
        typeof item?.name === 'string' &&
        typeof item.browser_download_url === 'string' &&
        build.matches(item.name),
    )
    if (asset) found.set(build.id, asset)
  }

  return found
}

/** Everything on offer that is not what the button already points at. */
function showAlternatives(found, chosen) {
  const others = BUILDS.filter((build) => build.id !== chosen && found.has(build.id))
  if (!others.length) return

  alt.textContent = 'Also for '
  others.forEach((build, index) => {
    if (index) alt.append(index === others.length - 1 ? ' and ' : ', ')
    const link = document.createElement('a')
    link.href = found.get(build.id).browser_download_url
    link.textContent = build.label
    alt.append(link)
  })
  alt.hidden = false
}

async function wireDownload() {
  if (!button || !meta || !alt || !note) return

  button.classList.add('is-loading')

  try {
    const response = await fetch(RELEASES, {
      headers: { Accept: 'application/vnd.github+json' },
    })
    if (!response.ok) throw new Error(`GitHub ${response.status}`)

    const release = await response.json()
    const found = findAssets(release.assets)
    const version = typeof release.tag_name === 'string' ? release.tag_name.replace(/^v/, '') : null

    // Offer what this computer runs, and failing that the first build there is,
    // so a Linux visitor still gets a working link rather than a dead button.
    const wanted = thisComputer()
    const chosen = found.has(wanted) ? wanted : BUILDS.find((build) => found.has(build.id))?.id
    const build = BUILDS.find((item) => item.id === chosen)

    if (build) {
      button.href = found.get(chosen).browser_download_url
      button.textContent = `Download for ${build.label}`
      meta.textContent = version ? `Version ${version} · ${build.kind}` : `Free · ${build.kind}`
      showAlternatives(found, chosen)

      if (chosen.startsWith('mac')) {
        note.textContent = MAC_NOTE
        note.hidden = false
      }
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
