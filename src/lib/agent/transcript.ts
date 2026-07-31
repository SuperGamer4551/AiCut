/**
 * The conversation, kept across restarts. Closing the app used to lose it,
 * which is no way to work: you come back to a project and the assistant has
 * forgotten what you were doing.
 *
 * Only the words are kept. The model's own view of the exchange is trimmed
 * harder, because it is resent on every turn and a long tail costs context.
 */

import type { ApiMessage, ChatAction, ChatMessage } from './types'
import { isToolName } from './tools'

export const TRANSCRIPT_STORAGE_KEY = 'aicut.chat.v1'

/**
 * Each project gets its own conversation, so the assistant is never talking
 * about a timeline you are no longer looking at. What it has learned about how
 * you like things done is separate, and stays shared across all of them.
 */
export function transcriptKeyFor(projectId: string | null): string {
  return projectId ? `${TRANSCRIPT_STORAGE_KEY}.${projectId}` : TRANSCRIPT_STORAGE_KEY
}

export const TRANSCRIPT_LIMIT = 200
export const HISTORY_LIMIT = 40

export type Transcript = {
  messages: ChatMessage[]
  history: ApiMessage[]
}

export const EMPTY_TRANSCRIPT: Transcript = { messages: [], history: [] }

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function action(value: unknown): ChatAction | null {
  const entry = (value ?? {}) as Record<string, unknown>
  if (!isToolName(entry.name)) return null
  return { name: entry.name, summary: text(entry.summary), failed: entry.failed === true }
}

function message(value: unknown, index: number): ChatMessage | null {
  const entry = (value ?? {}) as Record<string, unknown>
  const role = entry.role
  if (role !== 'user' && role !== 'assistant' && role !== 'system') return null

  const actions = Array.isArray(entry.actions)
    ? entry.actions.map(action).filter((item): item is ChatAction => item !== null)
    : undefined

  const body = text(entry.text)
  // A reply that was still being written when the app closed has nothing to say.
  if (!body && (!actions || actions.length === 0)) return null

  return {
    id: text(entry.id) || `stored-${index}`,
    role,
    text: body,
    ...(actions && actions.length > 0 ? { actions } : {}),
    ...(text(entry.note) ? { note: text(entry.note) } : {}),
  }
}

/** Model-side turns, kept only in the shapes an endpoint will accept back. */
function apiMessage(value: unknown): ApiMessage | null {
  const entry = (value ?? {}) as Record<string, unknown>
  const role = entry.role
  if (role !== 'system' && role !== 'user' && role !== 'assistant' && role !== 'tool') return null

  const calls = Array.isArray(entry.tool_calls)
    ? entry.tool_calls
        .map((call) => {
          const item = (call ?? {}) as Record<string, unknown>
          const fn = (item.function ?? {}) as Record<string, unknown>
          if (!text(item.id) || !isToolName(fn.name)) return null
          return {
            id: text(item.id),
            type: 'function' as const,
            function: { name: String(fn.name), arguments: text(fn.arguments) || '{}' },
          }
        })
        .filter((call): call is NonNullable<typeof call> => call !== null)
    : undefined

  // A tool result with no call to answer would be rejected by the endpoint.
  if (role === 'tool' && !text(entry.tool_call_id)) return null

  return {
    role,
    content: text(entry.content),
    ...(calls && calls.length > 0 ? { tool_calls: calls } : {}),
    ...(role === 'tool' ? { tool_call_id: text(entry.tool_call_id) } : {}),
  }
}

/**
 * A tool result cannot lead: endpoints reject one that answers a call they were
 * not shown. Trimming the history can leave exactly that, so the head is cut
 * back to the first turn that stands on its own.
 */
function startsCleanly(history: ApiMessage[]): ApiMessage[] {
  let first = 0
  while (first < history.length && history[first].role === 'tool') first += 1
  return history.slice(first)
}

export function normalizeTranscript(value: unknown): Transcript {
  const stored = (value ?? {}) as Record<string, unknown>

  const messages = Array.isArray(stored.messages)
    ? stored.messages
        .map(message)
        .filter((entry): entry is ChatMessage => entry !== null)
        .slice(-TRANSCRIPT_LIMIT)
    : []

  const history = Array.isArray(stored.history)
    ? startsCleanly(
        stored.history
          .map(apiMessage)
          .filter((entry): entry is ApiMessage => entry !== null)
          .slice(-HISTORY_LIMIT),
      )
    : []

  return { messages, history }
}

/** What gets written: pending state and internal error tags are not worth keeping. */
export function forStorage(messages: ChatMessage[], history: ApiMessage[]): Transcript {
  return {
    messages: messages
      .filter((entry) => entry.text || (entry.actions?.length ?? 0) > 0)
      .slice(-TRANSCRIPT_LIMIT)
      .map(({ id, role, text: body, actions, note }) => ({
        id,
        role,
        text: body,
        ...(actions && actions.length > 0 ? { actions } : {}),
        ...(note ? { note } : {}),
      })),
    history: startsCleanly(history.slice(-HISTORY_LIMIT)),
  }
}
