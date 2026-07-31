import type { KeyboardEvent } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  ApiMessage,
  ChatAction,
  ChatMessage,
  ProjectState,
  ToolCall,
  ToolOutcome,
} from '../lib/agent/types'
import { API_TOOLS, SYSTEM_PROMPT, normalizeToolCall } from '../lib/agent/tools'
import { interpretCommand } from '../lib/agent/interpret'
import { converse, fallbackReply } from '../lib/agent/converse'
import { tidyReply } from '../lib/agent/reply'
import { learnFrom, memoryPrompt } from '../lib/agent/memory'
import { MODEL_PRESETS, canReachModel, presetFor } from '../lib/agent/endpoints'
import { EMPTY_TRANSCRIPT, forStorage, normalizeTranscript, transcriptKeyFor } from '../lib/agent/transcript'
import { readStored, writeStored } from '../lib/layout'
import { linkLabel, splitLinks } from '../lib/links'
import './AiChat.css'

type Props = {
  project: ProjectState
  /** Which saved project this conversation belongs to. */
  projectId: string
  describeProject: () => string
  onRunTools: (calls: ToolCall[]) => Promise<ToolOutcome[]>
}

type Settings = {
  baseUrl: string
  model: string
  hasKey: boolean
}

/**
 * How many times the model may act, look at what happened, and act again.
 * Researching before editing turns one request into a longer chain — look it
 * up, fetch the meme, place it, add the hook — so there is room for that.
 */
const MAX_ROUNDS = 9

/** How long a reply may take before there is a way to give up on it. */
const STOP_AFTER_MS = 10_000

const SUGGESTIONS = [
  'Make this into a YouTube short',
  'Find me a meme about losing',
  'Cut the dead air out of this',
  'Get me a Fortnite montage from YouTube',
  'Show me examples of good gaming montages',
  'Export this as a 1080p mp4',
]

/** Without a model, questions are worth offering too: they are answered locally. */
const OFFLINE_SUGGESTIONS = [
  'Make this into a YouTube short',
  'Cut the dead air out of this',
  'Generate a title card that says GG',
  'What can you do?',
  'Is any of this going to cost me?',
]

type YoutubeAccount = {
  connected: boolean
  hasCredentials: boolean
  channelTitle: string
}

function newId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `m-${Math.random().toString(36).slice(2, 10)}`
}

function actionsFrom(calls: ToolCall[], outcomes: ToolOutcome[]): ChatAction[] {
  return outcomes.map((outcome, index) => ({
    name: calls[index]?.name ?? 'describe_project',
    summary: outcome.summary,
    failed: Boolean(outcome.error),
  }))
}

/**
 * What to show when the model says nothing. "Done." was a lie whenever the tools
 * had done nothing, so the work itself does the talking instead.
 */
function spokenReply(content: string, performed: ChatAction[]): string {
  const words = tidyReply(content)
  if (words) return words

  const worked = performed.filter((action) => !action.failed)
  if (worked.length > 0) return worked.map((action) => action.summary).join(' ')
  if (performed.length > 0) return performed.map((action) => action.summary).join(' ')

  return 'The model came back with nothing at all, and nothing changed. Ask again, or put it another way.'
}

/**
 * Message text with any addresses in it made clickable. They open in the real
 * browser, because a window showing YouTube is not an editor any more.
 */
function Linked({ text }: { text: string }) {
  return (
    <>
      {splitLinks(text).map((part, index) =>
        part.kind === 'link' ? (
          <a
            key={index}
            className="ai-link"
            href={part.value}
            title={part.value}
            onClick={(event) => {
              event.preventDefault()
              void window.aicut?.web?.open(part.value)
            }}
          >
            {linkLabel(part.value)}
          </a>
        ) : (
          <span key={index}>{part.value}</span>
        ),
      )}
    </>
  )
}

export function AiChat({ project, projectId, describeProject, onRunTools }: Props) {
  const storageKey = transcriptKeyFor(projectId)
  const stored = useMemo(() => readStored(storageKey, normalizeTranscript), [storageKey])
  const [messages, setMessages] = useState<ChatMessage[]>(stored.messages)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [slow, setSlow] = useState(false)
  const [settings, setSettings] = useState<Settings | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [keyDraft, setKeyDraft] = useState('')
  const [baseUrlDraft, setBaseUrlDraft] = useState('')
  const [modelDraft, setModelDraft] = useState('')
  const [channel, setChannel] = useState<YoutubeAccount | null>(null)
  const [clientIdDraft, setClientIdDraft] = useState('')
  const [clientSecretDraft, setClientSecretDraft] = useState('')
  const [connecting, setConnecting] = useState(false)
  const [youtubeError, setYoutubeError] = useState<string | null>(null)

  const historyRef = useRef<ApiMessage[]>(stored.history)
  const listRef = useRef<HTMLDivElement>(null)
  const stoppedRef = useRef(false)
  const desktop = Boolean(window.aicut?.ai)

  useEffect(() => {
    if (!window.aicut?.ai) return
    void window.aicut.ai.getSettings().then((next) => {
      setSettings(next)
      setBaseUrlDraft(next.baseUrl)
      setModelDraft(next.model)
    })
    void window.aicut.youtube.status().then(setChannel)
  }, [])

  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages])

  // Kept on disk so closing the app does not lose the conversation.
  useEffect(() => {
    if (busy) return
    writeStored(storageKey, forStorage(messages, historyRef.current))
  }, [messages, busy, storageKey])

  // Nothing to give up on until a reply has actually taken a while.
  useEffect(() => {
    if (!busy) {
      setSlow(false)
      return
    }
    const timer = setTimeout(() => setSlow(true), STOP_AFTER_MS)
    return () => clearTimeout(timer)
  }, [busy])

  // A model on this machine needs no key, so having one is not the test.
  const connected = Boolean(settings && canReachModel(settings.baseUrl, settings.hasKey))
  const modelName = settings?.model ?? 'The model'

  const placeholder = useMemo(
    () => (connected ? 'Ask for an edit, or just talk it through…' : 'Try "make this into a youtube short"'),
    [connected],
  )

  const chatContext = useMemo(
    () => ({ connected, clips: project.clips.length, media: project.media.length }),
    [connected, project.clips.length, project.media.length],
  )

  function push(message: Omit<ChatMessage, 'id'>): string {
    const id = newId()
    setMessages((prev) => [...prev, { ...message, id }])
    return id
  }

  function update(id: string, patch: Partial<ChatMessage>) {
    setMessages((prev) => prev.map((message) => (message.id === id ? { ...message, ...patch } : message)))
  }

  /** No model configured: the built-in interpreter edits, and talk falls through. */
  async function runOffline(input: string, replyId: string, context = chatContext) {
    const { calls, unsupported } = interpretCommand(input, project)

    if (calls.length === 0) {
      update(replyId, {
        pending: false,
        text: unsupported
          ? `I can't do ${unsupported} yet. So far I can search your files and import them, place, move, split and trim clips, find the best moment, cut dead air, make vertical shorts, crop, add text and memes, punch in, build montages, manage tracks, export, and publish to YouTube.`
          : (converse(input, context)?.text ?? fallbackReply(context)),
      })
      return
    }

    const outcomes = await onRunTools(calls)
    const failed = outcomes.filter((outcome) => outcome.error)

    update(replyId, {
      pending: false,
      text:
        failed.length === outcomes.length
          ? outcomes.map((outcome) => outcome.summary).join(' ')
          : outcomes
              .filter((outcome) => !outcome.error)
              .map((outcome) => outcome.summary)
              .join(' '),
      actions: actionsFrom(calls, outcomes),
    })
  }

  async function runModel(input: string, replyId: string) {
    const history = historyRef.current
    history.push({ role: 'user', content: input })

    // Kept across rounds so the reply shows every edit, not just the last one.
    const performed: ChatAction[] = []

    for (let round = 0; round < MAX_ROUNDS; round += 1) {
      const learned = memoryPrompt(project.memory)
      const request: ApiMessage[] = [
        { role: 'system', content: SYSTEM_PROMPT },
        ...(learned ? [{ role: 'system' as const, content: learned }] : []),
        { role: 'system', content: `Current project:\n${describeProject()}` },
        ...history,
      ]

      const reply = await window.aicut!.ai.chat({ messages: request, tools: API_TOOLS })

      // Given up on deliberately: the transcript says so rather than blaming the
      // model, and the half-finished turn is dropped so the next one still works.
      if (reply.error === 'stopped' || stoppedRef.current) {
        historyRef.current = history.slice(0, history.length - 1)
        update(replyId, {
          pending: false,
          actions: performed.length > 0 ? [...performed] : undefined,
          text:
            performed.length > 0
              ? `Stopped there. ${performed.map((action) => action.summary).join(' ')}`
              : 'Stopped. Nothing was changed.',
        })
        return
      }

      if (reply.error) {
        // A model that cannot be reached, on the first round, should not stop the
        // conversation: the built-in half understands plenty of instructions on
        // its own, and can answer questions about the editor.
        const handled =
          round === 0 &&
          (interpretCommand(input, project).calls.length > 0 ||
            converse(input, { ...chatContext, connected: false }) !== null)
        update(replyId, {
          pending: handled,
          actions: performed.length > 0 ? [...performed] : undefined,
          text: handled
            ? ''
            : reply.error === 'no-key'
              ? 'No API key is saved yet. Open the settings above to connect a model, or give me a direct instruction.'
              : `The model call failed: ${reply.error}`,
          error: handled ? undefined : reply.error,
        })

        if (reply.error === 'no-key') setSettings((prev) => (prev ? { ...prev, hasKey: false } : prev))
        if (handled) {
          await runOffline(input, replyId, { ...chatContext, connected: false })
          update(replyId, { note: `${modelName} was unreachable, so I answered this myself.` })
        }
        return
      }

      const calls: ToolCall[] = []
      for (const call of reply.toolCalls) {
        const normalized = normalizeToolCall(call.name, call.arguments)
        if (normalized) calls.push({ ...normalized, id: call.id })
      }

      if (calls.length === 0) {
        history.push({ role: 'assistant', content: reply.content })
        update(replyId, {
          pending: false,
          text: spokenReply(reply.content, performed),
          actions: performed.length > 0 ? [...performed] : undefined,
        })
        return
      }

      history.push({
        role: 'assistant',
        content: reply.content,
        tool_calls: reply.toolCalls.map((call) => ({
          id: call.id,
          type: 'function' as const,
          function: { name: call.name, arguments: call.arguments },
        })),
      })

      const outcomes = await onRunTools(calls)
      outcomes.forEach((outcome, index) => {
        history.push({
          role: 'tool',
          tool_call_id: calls[index].id ?? `call-${index}`,
          content: outcome.error ? `Failed: ${outcome.summary}` : outcome.summary,
        })
      })

      performed.push(...actionsFrom(calls, outcomes))
      update(replyId, { pending: true, text: tidyReply(reply.content), actions: [...performed] })
    }

    update(replyId, {
      pending: false,
      actions: [...performed],
      text: 'I stopped after several rounds of edits. Tell me what to do next.',
    })
  }

  /**
   * A preference stated in passing is kept whether or not the model thinks to
   * remember it, so "I always want 9:16" holds next time the app opens.
   */
  async function keepPreference(text: string): Promise<string | null> {
    const learned = learnFrom(text)
    if (!learned) return null

    const known = project.memory.some((note) => note.text.toLowerCase() === learned.toLowerCase())
    if (known) return null

    const [outcome] = await onRunTools([{ name: 'remember', args: { text: learned } }])
    return outcome && !outcome.error ? learned : null
  }

  async function send(input: string) {
    const text = input.trim()
    if (!text || busy) return

    setDraft('')
    setBusy(true)
    stoppedRef.current = false
    push({ role: 'user', text })

    // The interpreter remembers on its own, so this only fills the gap a model
    // leaves when it answers without calling remember.
    const remembered = connected ? await keepPreference(text) : null
    const replyId = push({
      role: 'assistant',
      text: '',
      pending: true,
      ...(remembered ? { note: `Remembered: ${remembered}` } : {}),
    })

    try {
      if (connected) {
        await runModel(text, replyId)
      } else {
        await runOffline(text, replyId)
      }
    } catch (error) {
      update(replyId, {
        pending: false,
        text: `Something went wrong: ${error instanceof Error ? error.message : String(error)}`,
        error: 'failed',
      })
    } finally {
      setBusy(false)
      stoppedRef.current = false
    }
  }

  /** Abandons the reply in flight; what already landed on the timeline stays. */
  async function stopThinking() {
    stoppedRef.current = true
    await window.aicut?.ai.stop()
  }

  /**
   * Empties the conversation only. What the assistant has been taught lives in
   * the project's memory, not in the transcript, so a clear-out is a fresh page
   * rather than amnesia: preferences and the timeline both survive it.
   */
  function clearConversation() {
    setMessages([])
    historyRef.current = []
    writeStored(storageKey, EMPTY_TRANSCRIPT)
  }

  async function saveSettings() {
    if (!window.aicut?.ai) return

    const next = await window.aicut.ai.setSettings({
      baseUrl: baseUrlDraft,
      model: modelDraft,
      ...(keyDraft ? { apiKey: keyDraft } : {}),
    })

    setSettings(next)
    setKeyDraft('')
    setShowSettings(false)
    historyRef.current = []
  }

  async function clearKey() {
    if (!window.aicut?.ai) return
    const next = await window.aicut.ai.setSettings({ apiKey: '' })
    setSettings(next)
    setKeyDraft('')
  }

  async function connectYoutube() {
    const desktop = window.aicut
    if (!desktop) return

    setYoutubeError(null)

    if (clientIdDraft.trim() || clientSecretDraft.trim()) {
      setChannel(
        await desktop.youtube.setCredentials({
          ...(clientIdDraft.trim() ? { clientId: clientIdDraft.trim() } : {}),
          ...(clientSecretDraft.trim() ? { clientSecret: clientSecretDraft.trim() } : {}),
        }),
      )
      setClientSecretDraft('')
    }

    setConnecting(true)
    try {
      const result = await desktop.youtube.connect()
      if ('error' in result) {
        setYoutubeError(result.error)
        return
      }
      setChannel(result)
    } finally {
      setConnecting(false)
    }
  }

  async function disconnectYoutube() {
    const desktop = window.aicut
    if (!desktop) return
    setChannel(await desktop.youtube.disconnect())
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void send(draft)
    }
  }

  return (
    <aside className="panel ai-panel">
      <div className="panel-header">
        <h2 className="panel-title">Assistant</h2>
        <span className={`ai-status${connected ? ' is-connected' : ''}`}>
          {connected ? settings?.model : 'built-in commands'}
        </span>
        {messages.length > 0 && (
          <button
            className="ai-clear"
            type="button"
            onClick={clearConversation}
            disabled={busy}
            title="Clear the chat. What you have taught it is kept."
          >
            Clear
          </button>
        )}
        {desktop && (
          <button
            className="ai-gear"
            type="button"
            onClick={() => setShowSettings((open) => !open)}
            aria-label="Assistant settings"
            title="Assistant settings"
          >
            ⚙
          </button>
        )}
      </div>

      {showSettings && (
        <div className="ai-settings">
          <div className="ai-presets">
            <span className="ai-presets-label">Free options</span>
            <div className="ai-preset-row">
              {MODEL_PRESETS.filter((preset) => preset.free).map((preset) => (
                <button
                  key={preset.id}
                  className={`btn btn-small${presetFor(baseUrlDraft)?.id === preset.id ? ' btn-primary' : ''}`}
                  type="button"
                  title={preset.hint}
                  onClick={() => {
                    setBaseUrlDraft(preset.baseUrl)
                    setModelDraft(preset.model)
                  }}
                >
                  {preset.label}
                </button>
              ))}
            </div>
            {presetFor(baseUrlDraft) && <p className="ai-note">{presetFor(baseUrlDraft)?.hint}</p>}
          </div>

          <label className="ai-field">
            API base URL
            <input
              value={baseUrlDraft}
              onChange={(event) => setBaseUrlDraft(event.target.value)}
              placeholder="https://api.openai.com/v1"
              spellCheck={false}
            />
          </label>
          <label className="ai-field">
            Model
            <input
              value={modelDraft}
              onChange={(event) => setModelDraft(event.target.value)}
              placeholder="gpt-4o-mini"
              spellCheck={false}
            />
          </label>
          <label className="ai-field">
            API key
            <input
              type="password"
              value={keyDraft}
              onChange={(event) => setKeyDraft(event.target.value)}
              placeholder={settings?.hasKey ? 'stored — type to replace' : 'sk-…'}
              spellCheck={false}
            />
          </label>
          <p className="ai-note">
            Works with any OpenAI-compatible endpoint. The key is stored on this machine only and is
            never sent to the page. A model running on this computer needs no key at all and costs
            nothing, which is all it takes for open-ended conversation; with no model the built-in
            commands still handle shorts, highlights and dead air, and still answer questions about
            the editor.
          </p>
          <div className="ai-settings-actions">
            <button className="btn btn-small btn-primary" type="button" onClick={() => void saveSettings()}>
              Save
            </button>
            <button className="btn btn-small" type="button" onClick={() => setShowSettings(false)}>
              Cancel
            </button>
            {settings?.hasKey && (
              <button className="btn btn-small btn-ghost" type="button" onClick={() => void clearKey()}>
                Remove key
              </button>
            )}
          </div>

          <div className="ai-divider" />

          <div className="ai-field-label">YouTube</div>
          {channel?.connected ? (
            <>
              <p className="ai-note">
                Publishing to <strong>{channel.channelTitle}</strong>. Uploads go out private unless
                you ask for otherwise.
              </p>
              <div className="ai-settings-actions">
                <button className="btn btn-small btn-ghost" type="button" onClick={() => void disconnectYoutube()}>
                  Disconnect
                </button>
              </div>
            </>
          ) : (
            <>
              <label className="ai-field">
                Google OAuth client id
                <input
                  value={clientIdDraft}
                  onChange={(event) => setClientIdDraft(event.target.value)}
                  placeholder={channel?.hasCredentials ? 'saved — type to replace' : '…apps.googleusercontent.com'}
                  spellCheck={false}
                />
              </label>
              <label className="ai-field">
                Client secret
                <input
                  type="password"
                  value={clientSecretDraft}
                  onChange={(event) => setClientSecretDraft(event.target.value)}
                  placeholder={channel?.hasCredentials ? 'saved — type to replace' : 'GOCSPX-…'}
                  spellCheck={false}
                />
              </label>
              <p className="ai-note">
                Create a Desktop app OAuth client in Google Cloud with the YouTube Data API enabled,
                then connect. Consent opens in your own browser.
              </p>
              <div className="ai-settings-actions">
                <button
                  className="btn btn-small btn-primary"
                  type="button"
                  onClick={() => void connectYoutube()}
                  disabled={connecting || (!channel?.hasCredentials && !clientIdDraft.trim())}
                >
                  {connecting ? 'Waiting for Google…' : 'Connect channel'}
                </button>
              </div>
            </>
          )}
          {youtubeError && <p className="ai-error">{youtubeError}</p>}

          {project.memory.length > 0 && (
            <>
              <div className="ai-divider" />
              <div className="ai-field-label">Remembered ({project.memory.length})</div>
              <ul className="ai-memory">
                {project.memory.map((note) => (
                  <li key={note.id}>{note.text}</li>
                ))}
              </ul>
              <p className="ai-note">Say "forget …" to drop one, or "forget everything" to clear them.</p>
            </>
          )}

          <div className="ai-divider" />
          <p className="ai-note">
            This conversation is kept on this computer and comes back when you reopen the app.
            Clearing it wipes the chat only — anything you have taught the assistant stays, and so
            does your project.
          </p>
          <div className="ai-settings-actions">
            <button
              className="btn btn-small"
              type="button"
              onClick={clearConversation}
              disabled={messages.length === 0 || busy}
            >
              Clear conversation
            </button>
          </div>
        </div>
      )}

      <div className="ai-messages" ref={listRef}>
        {messages.length === 0 && (
          <div className="ai-empty">
            <p className="ai-empty-title">Tell me what to edit, or just ask</p>
            <p className="ai-empty-sub">
              I can find your files and import them, cut a recording down to its best moment, make it
              vertical for a short, drop the dead air, then render or publish it — and I will answer
              questions about any of it.
            </p>
            {project.memory.length > 0 && (
              <p className="ai-empty-sub">
                A clear chat is not a blank slate: {project.memory.length}{' '}
                {project.memory.length === 1 ? 'thing you told me is' : 'things you told me are'} still
                remembered, and your timeline is untouched. The gear lists them.
              </p>
            )}
            {!connected && (
              <p className="ai-empty-sub">
                Running on the built-in commands. A free model — Ollama on this computer, or a
                free-tier key — turns this into a proper conversation at no cost.
              </p>
            )}
            <div className="ai-suggestions">
              {(connected ? SUGGESTIONS : OFFLINE_SUGGESTIONS).map((suggestion) => (
                <button
                  key={suggestion}
                  className="ai-suggestion"
                  type="button"
                  onClick={() => void send(suggestion)}
                >
                  {suggestion}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((message) => (
          <div key={message.id} className={`ai-message role-${message.role}`}>
            {message.text && (
              <div className="ai-bubble">
                <Linked text={message.text} />
              </div>
            )}

            {message.actions?.map((action, index) => (
              <div key={`${action.name}-${index}`} className={`ai-action${action.failed ? ' is-failed' : ''}`}>
                <span className="ai-action-name">{action.name.replace(/_/g, ' ')}</span>
                <span className="ai-action-summary">
                  <Linked text={action.summary} />
                </span>
              </div>
            ))}

            {message.note && <div className="ai-message-note">{message.note}</div>}

            {message.pending && <div className="ai-typing" aria-label="Working" />}
          </div>
        ))}
      </div>

      <div className="ai-composer">
        <textarea
          className="ai-input"
          value={draft}
          rows={2}
          placeholder={placeholder}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={handleKeyDown}
          disabled={busy}
        />
        <div className="ai-composer-buttons">
          {busy && slow && connected && (
            <button className="btn btn-small ai-stop" type="button" onClick={() => void stopThinking()}>
              Stop
            </button>
          )}
          <button
            className="btn btn-primary btn-small"
            type="button"
            onClick={() => void send(draft)}
            disabled={busy || draft.trim().length === 0}
          >
            {busy ? '…' : 'Send'}
          </button>
        </div>
      </div>
    </aside>
  )
}
