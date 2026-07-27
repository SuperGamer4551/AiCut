import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import type { ExportPlan } from '../src/lib/export/plan'
import { progressFromLine } from '../src/lib/export/plan'

/** Runs ffmpeg: probing sources for audio, then rendering a plan. */

export type ExportRun = {
  ok: boolean
  output?: string
  error?: string
  canceled?: boolean
}

const BINARY = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'

/**
 * Candidate ffmpeg locations, in order: an explicit override, the copy that
 * ships with the app, the one next to the sources in development, then whatever
 * is on PATH.
 */
export function ffmpegCandidates(options: {
  override?: string
  resourcesPath?: string
  appPath?: string
}): string[] {
  const candidates: string[] = []

  if (options.override) candidates.push(options.override)
  if (options.resourcesPath) candidates.push(path.join(options.resourcesPath, BINARY))
  if (options.appPath) {
    candidates.push(path.join(options.appPath, 'node_modules', 'ffmpeg-static', BINARY))
  }
  candidates.push(BINARY)

  return candidates
}

export function resolveFfmpeg(options: {
  override?: string
  resourcesPath?: string
  appPath?: string
  exists?: (candidate: string) => boolean
}): string {
  const exists = options.exists ?? existsSync
  const candidates = ffmpegCandidates(options)
  // The bare name is the last resort: spawn will find it on PATH if it is there.
  return candidates.find((candidate) => candidate !== BINARY && exists(candidate)) ?? BINARY
}

/** The ffmpeg this machine will actually run. */
export function ffmpegBinary(): string {
  const electron = require('electron') as typeof import('electron')
  return resolveFfmpeg({
    override: process.env.AICUT_FFMPEG,
    resourcesPath: process.resourcesPath,
    appPath: electron.app?.getAppPath(),
  })
}

/** True when ffmpeg answers, which is what export depends on. */
export async function ffmpegAvailable(): Promise<{ available: boolean; path: string; version?: string }> {
  const binary = ffmpegBinary()

  return new Promise((resolve) => {
    let output = ''
    let child: ReturnType<typeof spawn>

    try {
      child = spawn(binary, ['-version'])
    } catch {
      resolve({ available: false, path: binary })
      return
    }

    child.stdout?.on('data', (chunk) => {
      output += String(chunk)
    })
    child.on('error', () => resolve({ available: false, path: binary }))
    child.on('close', (code) => {
      const version = /ffmpeg version (\S+)/.exec(output)?.[1]
      resolve({ available: code === 0, path: binary, version })
    })
  })
}

/**
 * Whether each file carries audio. ffmpeg reports its streams on stderr and
 * exits with an error when given no output, which is expected here.
 */
export async function probeSources(paths: string[]): Promise<Record<string, { hasAudio: boolean }>> {
  const binary = ffmpegBinary()
  const probes: Record<string, { hasAudio: boolean }> = {}

  await Promise.all(
    [...new Set(paths)].map(
      (file) =>
        new Promise<void>((resolve) => {
          let stderr = ''
          let child: ReturnType<typeof spawn>

          try {
            child = spawn(binary, ['-hide_banner', '-i', file])
          } catch {
            probes[file] = { hasAudio: false }
            resolve()
            return
          }

          child.stderr?.on('data', (chunk) => {
            stderr += String(chunk)
          })
          child.on('error', () => {
            probes[file] = { hasAudio: false }
            resolve()
          })
          child.on('close', () => {
            probes[file] = { hasAudio: /Stream #\d+:\d+.*: Audio:/.test(stderr) }
            resolve()
          })
        }),
    ),
  )

  return probes
}

let active: { child: ReturnType<typeof spawn>; canceled: boolean } | null = null

export function cancelExport(): boolean {
  if (!active) return false
  active.canceled = true
  active.child.kill()
  return true
}

export async function runExport(
  plan: ExportPlan,
  onProgress: (fraction: number) => void,
): Promise<ExportRun> {
  const binary = ffmpegBinary()

  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(binary, plan.args)
    } catch (error) {
      resolve({ ok: false, error: `ffmpeg could not start: ${(error as Error).message}` })
      return
    }

    const run = { child, canceled: false }
    active = run
    let stderr = ''

    child.stderr?.on('data', (chunk) => {
      const text = String(chunk)
      // Only the tail matters for diagnosing a failure.
      stderr = (stderr + text).slice(-4000)

      for (const line of text.split(/[\r\n]/)) {
        const fraction = progressFromLine(line, plan.duration)
        if (fraction !== null) onProgress(fraction)
      }
    })

    child.on('error', (error) => {
      active = null
      resolve({
        ok: false,
        error:
          (error as NodeJS.ErrnoException).code === 'ENOENT'
            ? 'ffmpeg was not found on this computer, so the project cannot be rendered.'
            : error.message,
      })
    })

    child.on('close', (code, signal) => {
      active = null
      if (run.canceled || signal) {
        resolve({ ok: false, canceled: true, error: 'The export was canceled.' })
        return
      }

      if (code === 0) {
        onProgress(1)
        resolve({ ok: true, output: plan.output })
        return
      }

      const reason = /(?:Error|error|Invalid|No such file)[^\r\n]*/.exec(stderr)?.[0] ?? `ffmpeg exited with code ${code}`
      resolve({ ok: false, error: reason })
    })
  })
}
