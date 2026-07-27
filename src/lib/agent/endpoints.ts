/**
 * Where the assistant can get a model from. Everything listed here has a way to
 * run without paying: the two local runtimes are free outright, and the hosted
 * ones have free tiers that need nothing but a sign-up.
 */

export type ModelPreset = {
  id: string
  label: string
  baseUrl: string
  model: string
  /** Nothing to sign up for and nothing to spend. */
  free: boolean
  /** Local runtimes accept any key, including none at all. */
  needsKey: boolean
  hint: string
}

export const MODEL_PRESETS: ModelPreset[] = [
  {
    id: 'ollama',
    label: 'Ollama (on this computer)',
    baseUrl: 'http://localhost:11434/v1',
    model: 'llama3.1:8b',
    free: true,
    needsKey: false,
    hint: 'Install Ollama, run "ollama pull llama3.1:8b", and leave the key blank. Set OLLAMA_CONTEXT_LENGTH=16384 so the tool list fits. Nothing leaves your machine.',
  },
  {
    id: 'lmstudio',
    label: 'LM Studio (on this computer)',
    baseUrl: 'http://localhost:1234/v1',
    model: 'local-model',
    free: true,
    needsKey: false,
    hint: 'Load a model in LM Studio and start its local server. The key can stay blank.',
  },
  {
    id: 'groq',
    label: 'Groq free tier',
    baseUrl: 'https://api.groq.com/openai/v1',
    model: 'llama-3.3-70b-versatile',
    free: true,
    needsKey: true,
    hint: 'Free API key from console.groq.com, with a daily limit. Fast, and good at calling tools.',
  },
  {
    id: 'gemini',
    label: 'Google AI Studio free tier',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    model: 'gemini-2.0-flash',
    free: true,
    needsKey: true,
    hint: 'Free API key from aistudio.google.com, with a daily limit.',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter free models',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'meta-llama/llama-3.3-70b-instruct:free',
    free: true,
    needsKey: true,
    hint: 'Free key from openrouter.ai; models ending in ":free" cost nothing.',
  },
  {
    id: 'openai',
    label: 'OpenAI (paid)',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    free: false,
    needsKey: true,
    hint: 'Billed per request.',
  },
]

/**
 * A model served from this machine, which needs no key. Recognising this is what
 * lets a local runtime work with the key box left empty.
 */
export function isLocalEndpoint(baseUrl: string): boolean {
  const host = /^https?:\/\/([^/:]+)/i.exec(baseUrl.trim())?.[1]?.toLowerCase()
  if (!host) return false

  return (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '0.0.0.0' ||
    host === '::1' ||
    host === '[::1]' ||
    host.endsWith('.local')
  )
}

/** Whether a model can be reached at all with these settings. */
export function canReachModel(baseUrl: string, hasKey: boolean): boolean {
  return hasKey || isLocalEndpoint(baseUrl)
}

export function presetFor(baseUrl: string): ModelPreset | null {
  const normalized = baseUrl.trim().replace(/\/+$/, '').toLowerCase()
  return (
    MODEL_PRESETS.find((preset) => preset.baseUrl.replace(/\/+$/, '').toLowerCase() === normalized) ??
    null
  )
}
