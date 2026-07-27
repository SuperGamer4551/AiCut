// Renders a generated clip — a title card, an end card, a plain background with
// words on it — with the same ffmpeg that exports the project.
import { spawn } from 'node:child_process'
import { mkdir, stat } from 'node:fs/promises'
import path from 'node:path'
import type { CardPlan } from '../src/lib/generate/card'
import { buildCardPlan, cardFileName, cardFrame, cardSeconds, readLook } from '../src/lib/generate/card'
import { ffmpegBinary } from './exporter'
import { systemFont } from './fonts'

export type GenerateRequest = {
  text?: string
  seconds?: number
  aspect?: number | string
  look?: string
}

export type GeneratedClip = {
  path: string
  name: string
  size: number
  duration: number
  width: number
  height: number
  /** The words as they were laid out, so the reply can say what it drew. */
  lines: string[]
}

export type GenerateReply = GeneratedClip | { error: string }

/** Where generated pieces live: beside the app's own data, not in the user's folders. */
export function generatedFolder(userData: string): string {
  return path.join(userData, 'generated')
}

function run(plan: CardPlan): Promise<{ ok: boolean; error?: string }> {
  const binary = ffmpegBinary()

  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(binary, plan.args)
    } catch (error) {
      resolve({ ok: false, error: `ffmpeg could not start: ${(error as Error).message}` })
      return
    }

    let stderr = ''
    child.stderr?.on('data', (chunk) => {
      stderr = (stderr + String(chunk)).slice(-4000)
    })
    child.on('error', (error) => {
      resolve({
        ok: false,
        error:
          (error as NodeJS.ErrnoException).code === 'ENOENT'
            ? 'ffmpeg was not found on this computer, so nothing can be rendered.'
            : error.message,
      })
    })
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ ok: true })
        return
      }
      const reason = /(?:Error|error|Invalid)[^\r\n]*/.exec(stderr)?.[0] ?? `ffmpeg exited with code ${code}`
      resolve({ ok: false, error: reason })
    })
  })
}

export async function generateClip(userData: string, request: GenerateRequest): Promise<GenerateReply> {
  const text = typeof request.text === 'string' ? request.text.trim() : ''
  const seconds = cardSeconds(request.seconds)
  const frame = cardFrame(request.aspect)
  const folder = generatedFolder(userData)

  try {
    await mkdir(folder, { recursive: true })
  } catch (error) {
    return { error: `I could not create ${folder}: ${(error as Error).message}` }
  }

  const font = systemFont() ?? undefined
  const plan = buildCardPlan({
    text,
    seconds,
    width: frame.width,
    height: frame.height,
    look: readLook(request.look) ?? 'dark',
    output: path.join(folder, cardFileName(text, seconds)),
    font,
  })

  const rendered = await run(plan)
  if (!rendered.ok) return { error: rendered.error ?? 'The render failed.' }

  let size = 0
  try {
    size = (await stat(plan.output)).size
  } catch {
    return { error: `${plan.output} was not written.` }
  }

  return {
    path: plan.output,
    name: path.basename(plan.output),
    size,
    duration: plan.seconds,
    width: plan.width,
    height: plan.height,
    lines: plan.lines,
  }
}
