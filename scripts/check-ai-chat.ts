// Assertions for the assistant's model transport: settings storage, request
// shape, and how replies and failures are read back.
// Run with: npm run check:ai
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  DEFAULT_AI_SETTINGS,
  chatEndpoint,
  mergeSettings,
  normalizeSettings,
  parseChatPayload,
  publicSettings,
  readSettingsFile,
  requestChat,
  writeSettingsFile,
} from '../electron/aiClient'

let failures = 0

function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected)
  if (!pass) failures += 1
  console.log(`${pass ? 'pass' : 'FAIL'}  ${label}`)
  if (!pass) console.log(`      expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

type Recorded = { path: string; auth: string | undefined; body: any }

/** Stands in for an OpenAI-compatible endpoint. */
async function fakeApi(handler: (body: any) => { status: number; payload: unknown }) {
  const seen: Recorded[] = []

  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
    })
    req.on('end', () => {
      let body: any = null
      try {
        body = JSON.parse(raw)
      } catch {
        body = raw
      }
      seen.push({ path: req.url ?? '', auth: req.headers.authorization, body })

      const { status, payload } = handler(body)
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(typeof payload === 'string' ? payload : JSON.stringify(payload))
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo

  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    seen,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

async function main() {
  // --- Endpoint building ---------------------------------------------------
  check('the chat endpoint is built from the base url', chatEndpoint('https://api.openai.com/v1'), 'https://api.openai.com/v1/chat/completions')
  check('a trailing slash does not double up', chatEndpoint('http://localhost:11434/v1/'), 'http://localhost:11434/v1/chat/completions')

  // --- Settings ------------------------------------------------------------
  check('empty settings fall back to defaults', normalizeSettings(null), DEFAULT_AI_SETTINGS)
  check('a blank model falls back to the default', normalizeSettings({ model: '  ' }).model, DEFAULT_AI_SETTINGS.model)
  check('stored values are kept', normalizeSettings({ baseUrl: 'http://x/v1', model: 'llama3', apiKey: 'k' }), { baseUrl: 'http://x/v1', model: 'llama3', apiKey: 'k' })

  const stored = { baseUrl: 'http://x/v1', model: 'llama3', apiKey: 'secret-key' }
  check('the renderer never sees the key', publicSettings(stored), { baseUrl: 'http://x/v1', model: 'llama3', hasKey: true })
  check('a missing key is reported as absent', publicSettings({ ...stored, apiKey: '' }).hasKey, false)

  check('a patch leaves untouched fields alone', mergeSettings(stored, { model: 'gpt-4o' }), { ...stored, model: 'gpt-4o' })
  check('an empty patch string clears the key', mergeSettings(stored, { apiKey: '' }).apiKey, '')
  check('an omitted key keeps the stored one', mergeSettings(stored, { model: 'x' }).apiKey, 'secret-key')
  check('keys are trimmed', mergeSettings(stored, { apiKey: '  padded  ' }).apiKey, 'padded')

  const dir = await mkdtemp(path.join(tmpdir(), 'aicut-ai-'))
  const file = path.join(dir, 'ai-settings.json')
  check('a missing settings file yields defaults', await readSettingsFile(file), DEFAULT_AI_SETTINGS)
  await writeSettingsFile(file, stored)
  check('settings survive a round trip', await readSettingsFile(file), stored)
  check('the key is stored on disk, not in the renderer', JSON.parse(await readFile(file, 'utf8')).apiKey, 'secret-key')
  await writeFile(file, '{ not json', 'utf8')
  check('a corrupt settings file yields defaults', await readSettingsFile(file), DEFAULT_AI_SETTINGS)

  // --- Reply parsing -------------------------------------------------------
  check('plain replies are read', parseChatPayload({ choices: [{ message: { content: 'Done.' } }] }), { content: 'Done.', toolCalls: [] })
  check(
    'tool calls are read',
    parseChatPayload({
      choices: [
        {
          message: {
            content: null,
            tool_calls: [{ id: 'call_1', function: { name: 'add_clip', arguments: '{"media":"intro"}' } }],
          },
        },
      ],
    }),
    { content: '', toolCalls: [{ id: 'call_1', name: 'add_clip', arguments: '{"media":"intro"}' }] },
  )
  check('an api error message is surfaced', parseChatPayload({ error: { message: 'bad model' } }).error, 'bad model')
  check('an empty payload is an error', parseChatPayload({}).error, 'The model returned no message.')
  check('a call with no arguments defaults to an empty object', parseChatPayload({ choices: [{ message: { tool_calls: [{ id: 'c', function: { name: 'describe_project' } }] } }] }).toolCalls[0].arguments, '{}')

  // --- Requests ------------------------------------------------------------
  check('no key short-circuits before any request', (await requestChat({ ...DEFAULT_AI_SETTINGS, apiKey: '' }, { messages: [], tools: [] })).error, 'no-key')

  // A model served from this machine is free and needs no key at all.
  const localModel = await fakeApi(() => ({
    status: 200,
    payload: { choices: [{ message: { content: 'Working on it.' } }] },
  }))
  const keyless = await requestChat(
    { baseUrl: localModel.baseUrl, model: 'llama3.1:8b', apiKey: '' },
    { messages: [{ role: 'user', content: 'make this a short' }], tools: [] },
  )
  check('a local model answers without a key', keyless.content, 'Working on it.')
  check('no authorization header is sent when there is no key', localModel.seen[0].auth, undefined)
  await localModel.close()

  const ok = await fakeApi(() => ({
    status: 200,
    payload: {
      choices: [
        {
          message: {
            content: 'Placing it now.',
            tool_calls: [{ id: 'call_a', function: { name: 'add_clip', arguments: '{"media":"intro"}' } }],
          },
        },
      ],
    },
  }))

  const reply = await requestChat(
    { baseUrl: ok.baseUrl, model: 'test-model', apiKey: 'test-key' },
    { messages: [{ role: 'user', content: 'add my intro' }], tools: [{ type: 'function' }] },
  )

  check('a successful call returns the content', reply.content, 'Placing it now.')
  check('a successful call returns the tool calls', reply.toolCalls, [{ id: 'call_a', name: 'add_clip', arguments: '{"media":"intro"}' }])
  check('no error on success', reply.error, undefined)
  check('the request hits the chat completions path', ok.seen[0].path, '/v1/chat/completions')
  check('the key is sent as a bearer token', ok.seen[0].auth, 'Bearer test-key')
  check('the configured model is sent', ok.seen[0].body.model, 'test-model')
  check('messages are forwarded', ok.seen[0].body.messages[0].content, 'add my intro')
  check('tools are advertised', Array.isArray(ok.seen[0].body.tools), true)
  check('the model may choose a tool', ok.seen[0].body.tool_choice, 'auto')
  await ok.close()

  const unauthorized = await fakeApi(() => ({ status: 401, payload: { error: { message: 'Invalid key' } } }))
  const rejected = await requestChat(
    { baseUrl: unauthorized.baseUrl, model: 'm', apiKey: 'wrong' },
    { messages: [], tools: [] },
  )
  check('an http failure reports the status', rejected.error?.startsWith('401'), true)
  check('an http failure includes the detail', rejected.error?.includes('Invalid key'), true)
  check('an http failure yields no tool calls', rejected.toolCalls, [])
  await unauthorized.close()

  const garbled = await fakeApi(() => ({ status: 200, payload: 'not json at all' }))
  const broken = await requestChat({ baseUrl: garbled.baseUrl, model: 'm', apiKey: 'k' }, { messages: [], tools: [] })
  check('an unreadable body is reported as an error', typeof broken.error === 'string' && broken.error.length > 0, true)
  await garbled.close()

  const slow = await fakeApi(() => ({ status: 200, payload: {} }))
  const stalled = await requestChat(
    { baseUrl: `http://127.0.0.1:1/v1`, model: 'm', apiKey: 'k' },
    { messages: [], tools: [] },
    50,
  )
  check('an unreachable endpoint fails instead of hanging', typeof stalled.error === 'string', true)
  await slow.close()

  // --- Giving up on a slow reply ------------------------------------------
  // A model that never answers is exactly what the Stop button is for, and a
  // stop has to read differently from a timeout.
  const hanging = createServer(() => {
    // Deliberately never responds.
  })
  await new Promise<void>((resolve) => hanging.listen(0, '127.0.0.1', resolve))
  const hangingUrl = `http://127.0.0.1:${(hanging.address() as AddressInfo).port}/v1`

  const stopper = new AbortController()
  const stoppedCall = requestChat(
    { baseUrl: hangingUrl, model: 'm', apiKey: 'k' },
    { messages: [], tools: [] },
    60_000,
    stopper.signal,
  )
  setTimeout(() => stopper.abort(), 30)
  const stopped = await stoppedCall
  check('a stopped call says it was stopped', stopped.error, 'stopped')
  check('a stopped call changes nothing', stopped.toolCalls, [])

  const timedOut = await requestChat(
    { baseUrl: hangingUrl, model: 'm', apiKey: 'k' },
    { messages: [], tools: [] },
    40,
    new AbortController().signal,
  )
  check('a timeout still reads as a timeout, not a stop', timedOut.error, 'The model took too long to answer.')

  const alreadyStopped = new AbortController()
  alreadyStopped.abort()
  check(
    'a call stopped before it starts never leaves the app',
    (
      await requestChat(
        { baseUrl: hangingUrl, model: 'm', apiKey: 'k' },
        { messages: [], tools: [] },
        60_000,
        alreadyStopped.signal,
      )
    ).error,
    'stopped',
  )
  await new Promise<void>((resolve) => hanging.close(() => resolve()))

  console.log(failures === 0 ? '\nRESULT: pass' : `\nRESULT: fail (${failures})`)
  if (failures > 0) process.exitCode = 1
}

void main()
