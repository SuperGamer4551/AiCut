// The model call and its settings file live here so both the Electron main
// process and the assertions in scripts/check-ai-chat.ts use the same code.
import { readFile, writeFile } from 'node:fs/promises'
import { isLocalEndpoint } from '../src/lib/agent/endpoints'

export type AiSettings = {
  baseUrl: string
  apiKey: string
  model: string
}

/** What the renderer is allowed to see: everything except the key itself. */
export type PublicAiSettings = {
  baseUrl: string
  model: string
  hasKey: boolean
}

export type ChatRequest = {
  messages: unknown[]
  tools: unknown[]
}

export type ChatResponse = {
  content: string
  toolCalls: { id: string; name: string; arguments: string }[]
  error?: string
}

export const DEFAULT_AI_SETTINGS: AiSettings = {
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-4o-mini',
  apiKey: '',
}

export const CHAT_TIMEOUT_MS = 90_000

export function publicSettings(settings: AiSettings): PublicAiSettings {
  return { baseUrl: settings.baseUrl, model: settings.model, hasKey: Boolean(settings.apiKey) }
}

export function normalizeSettings(value: unknown): AiSettings {
  const parsed = (value ?? {}) as Partial<AiSettings>
  return {
    baseUrl:
      typeof parsed.baseUrl === 'string' && parsed.baseUrl.trim()
        ? parsed.baseUrl.trim()
        : DEFAULT_AI_SETTINGS.baseUrl,
    model:
      typeof parsed.model === 'string' && parsed.model.trim()
        ? parsed.model.trim()
        : DEFAULT_AI_SETTINGS.model,
    apiKey: typeof parsed.apiKey === 'string' ? parsed.apiKey : '',
  }
}

/** An empty string clears a field back to its default; undefined leaves it alone. */
export function mergeSettings(current: AiSettings, patch: Partial<AiSettings>): AiSettings {
  return {
    baseUrl:
      typeof patch.baseUrl === 'string' && patch.baseUrl.trim() ? patch.baseUrl.trim() : current.baseUrl,
    model: typeof patch.model === 'string' && patch.model.trim() ? patch.model.trim() : current.model,
    apiKey: typeof patch.apiKey === 'string' ? patch.apiKey.trim() : current.apiKey,
  }
}

export async function readSettingsFile(filePath: string): Promise<AiSettings> {
  try {
    return normalizeSettings(JSON.parse(await readFile(filePath, 'utf8')))
  } catch {
    return DEFAULT_AI_SETTINGS
  }
}

export async function writeSettingsFile(filePath: string, settings: AiSettings): Promise<void> {
  await writeFile(filePath, JSON.stringify(settings, null, 2), 'utf8')
}

export function chatEndpoint(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/chat/completions`
}

type ApiPayload = {
  choices?: {
    message?: {
      content?: string | null
      tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[]
    }
  }[]
  error?: { message?: string }
}

export function parseChatPayload(payload: unknown): ChatResponse {
  const data = (payload ?? {}) as ApiPayload

  if (data.error?.message) return { content: '', toolCalls: [], error: data.error.message }

  const message = data.choices?.[0]?.message
  if (!message) return { content: '', toolCalls: [], error: 'The model returned no message.' }

  return {
    content: message.content ?? '',
    toolCalls: (message.tool_calls ?? []).map((call, index) => ({
      id: call.id ?? `call-${index}`,
      name: call.function?.name ?? '',
      arguments: call.function?.arguments ?? '{}',
    })),
  }
}

export async function requestChat(
  settings: AiSettings,
  request: ChatRequest,
  timeoutMs = CHAT_TIMEOUT_MS,
  /** Aborting this reports 'stopped', which is not the same as a timeout. */
  stop?: AbortSignal,
): Promise<ChatResponse> {
  const empty = { content: '', toolCalls: [] }
  // A model running on this machine needs no key, which is what makes the free
  // local setups work.
  const local = isLocalEndpoint(settings.baseUrl)
  if (!settings.apiKey && !local) return { ...empty, error: 'no-key' }
  if (stop?.aborted) return { ...empty, error: 'stopped' }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  const relay = () => controller.abort()
  stop?.addEventListener('abort', relay)

  try {
    const response = await fetch(chatEndpoint(settings.baseUrl), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(settings.apiKey ? { authorization: `Bearer ${settings.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: settings.model,
        messages: request.messages,
        tools: request.tools,
        tool_choice: 'auto',
        // Low enough to keep tool arguments literal, warm enough that the
        // talking between edits does not read like a manual.
        temperature: 0.4,
      }),
      signal: controller.signal,
    })

    if (!response.ok) {
      const detail = (await response.text()).slice(0, 400)
      return { ...empty, error: `${response.status} ${response.statusText}: ${detail}` }
    }

    return parseChatPayload(await response.json())
  } catch (error) {
    if (stop?.aborted) return { ...empty, error: 'stopped' }
    if (controller.signal.aborted) return { ...empty, error: 'The model took too long to answer.' }
    return { ...empty, error: error instanceof Error ? error.message : String(error) }
  } finally {
    clearTimeout(timeout)
    stop?.removeEventListener('abort', relay)
  }
}
