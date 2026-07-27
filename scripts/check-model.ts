// Talks to the model that is actually configured, with the prompt and the tool
// list the app sends, and checks it can do both halves of the job: hold a
// conversation, and call the right tool when there is work to do.
//
// Needs a model running or reachable. Run with: npm run check:model
import { homedir } from 'node:os'
import path from 'node:path'
import { readSettingsFile, requestChat } from '../electron/aiClient'
import type { AiSettings } from '../electron/aiClient'
import { API_TOOLS, SYSTEM_PROMPT, normalizeToolCall } from '../src/lib/agent/tools'
import { tidyReply } from '../src/lib/agent/reply'

const PROJECT = [
  'Media: gameplay.mp4 (video, 3:00)',
  'Tracks: Video track (video), Audio track (audio)',
  'Clips: gameplay on Video track from 00:00 to 03:00',
  'Selected clip: gameplay',
  'Playhead: 00:00',
].join('\n')

function settingsFile(): string {
  // Where Electron keeps it on this platform, so the check uses whatever the app
  // is configured with rather than a copy of the settings.
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA ?? path.join(homedir(), 'AppData', 'Roaming'), 'aicut', 'ai-settings.json')
  }
  if (process.platform === 'darwin') {
    return path.join(homedir(), 'Library', 'Application Support', 'aicut', 'ai-settings.json')
  }
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(homedir(), '.config'), 'aicut', 'ai-settings.json')
}

function ask(settings: AiSettings, message: string) {
  return requestChat(settings, {
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'system', content: `Current project:\n${PROJECT}` },
      { role: 'user', content: message },
    ],
    tools: API_TOOLS,
  })
}

let failures = 0

function check(label: string, pass: boolean, detail?: string) {
  if (!pass) failures += 1
  console.log(`${pass ? 'pass' : 'FAIL'}  ${label}`)
  if (detail) console.log(`      ${detail}`)
}

async function main() {
  const settings: AiSettings = {
    ...(await readSettingsFile(settingsFile())),
    ...(process.env.AICUT_BASE_URL ? { baseUrl: process.env.AICUT_BASE_URL } : {}),
    ...(process.env.AICUT_MODEL ? { model: process.env.AICUT_MODEL } : {}),
    ...(process.env.AICUT_API_KEY ? { apiKey: process.env.AICUT_API_KEY } : {}),
  }

  const size = JSON.stringify({ prompt: SYSTEM_PROMPT, tools: API_TOOLS }).length
  console.log(`model ${settings.model} at ${settings.baseUrl}`)
  console.log(`prompt and tools: ${(size / 1024).toFixed(1)} KB, roughly ${Math.round(size / 4)} tokens\n`)

  const started = Date.now()
  const talk = await ask(settings, 'hey — what would you suggest I do with a three minute gameplay recording?')
  const talkMs = Date.now() - started

  if (talk.error) {
    check('the model can be reached', false, talk.error)
    console.log('\nRESULT: fail (unreachable)')
    process.exit(1)
  }

  const said = tidyReply(talk.content)
  check('the model can be reached', true, `${(talkMs / 1000).toFixed(1)}s for the first reply, model load included`)
  check('a question gets words back', said.length > 0, said.slice(0, 400))
  check('a question is not answered by editing', talk.toolCalls.length === 0, talk.toolCalls.map((call) => call.name).join(', '))
  check('what it writes reads as plain text', !/\*\*|^#{1,6}\s|^[-*+]\s/m.test(said), said.slice(0, 200))

  const warm = Date.now()
  const work = await ask(settings, 'make this into a youtube short')
  check('a warm reply is quick', Date.now() - warm < 30_000, `${((Date.now() - warm) / 1000).toFixed(1)}s`)
  if (work.error) {
    check('an instruction reaches the model', false, work.error)
    console.log('\nRESULT: fail')
    process.exit(1)
  }

  const calls = work.toolCalls
    .map((call) => normalizeToolCall(call.name, call.arguments))
    .filter((call): call is NonNullable<typeof call> => call !== null)

  check('an instruction becomes a tool call', calls.length > 0, work.toolCalls.map((call) => `${call.name}(${call.arguments})`).join(' '))
  check(
    'the whole-job tool is the one it reaches for',
    calls.some((call) => call.name === 'make_short'),
    calls.map((call) => call.name).join(', ') || 'nothing',
  )

  console.log(`\nRESULT: ${failures === 0 ? 'pass' : `fail (${failures})`}`)
  process.exit(failures === 0 ? 0 : 1)
}

void main()
