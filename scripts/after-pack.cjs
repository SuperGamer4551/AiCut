// electron-builder hands the packed app over here, before it is put in a dmg.
// Two things still have to happen to a mac build.
//
// The first is ffmpeg. The Windows build copies it in through extraResources,
// but the mac release is packed twice, once per architecture, and each copy
// needs the binary for its own. So it is placed here, where the architecture
// being packed is known.
//
// The second is a signature. macOS will not load arm64 code with no signature
// at all, and there is no Apple developer certificate behind this project, so
// the bundle is signed ad-hoc. That satisfies the loader; Gatekeeper still
// stops the first launch and asks the person to confirm, which the download
// page explains.
const { execFileSync } = require('node:child_process')
const { chmodSync, copyFileSync, existsSync, mkdirSync } = require('node:fs')
const path = require('node:path')

/** electron-builder reports the architecture as an index into its own enum. */
const ARCH_NAMES = { 0: 'ia32', 1: 'x64', 2: 'armv7l', 3: 'arm64', 4: 'universal' }

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return

  const arch = ARCH_NAMES[context.arch] ?? String(context.arch)
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)

  const source = path.join(context.packager.projectDir, 'build', 'ffmpeg', arch, 'ffmpeg')
  if (!existsSync(source)) {
    throw new Error(`no ${arch} ffmpeg at ${source} — run "npm run ffmpeg:mac" before packaging`)
  }

  const resources = path.join(app, 'Contents', 'Resources')
  mkdirSync(resources, { recursive: true })

  const target = path.join(resources, 'ffmpeg')
  copyFileSync(source, target)
  chmodSync(target, 0o755)

  // Everything inside the bundle has to be in place before it is signed.
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' })

  console.log(`  • carried ffmpeg and signed ad-hoc  arch=${arch}`)
}
