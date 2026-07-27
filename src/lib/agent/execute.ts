import { runTool } from './runtime'
import type { HostBridge, HostReply, ProjectState, ToolCall, ToolName, ToolOutcome } from './types'

/** Tools carried out by the host because they touch the disk or the network. */
export const HOST_TOOLS: ToolName[] = [
  'import_media',
  'import_file',
  'list_folder',
  'find_media',
  'analyze_clip',
  'find_highlight',
  'make_short',
  'remove_silence',
  'insert_cutaway',
  'punch_in',
  'make_montage',
  'generate_clip',
  'export_project',
  'publish_youtube',
  'youtube_status',
]

export function isHostTool(name: ToolName): boolean {
  return HOST_TOOLS.includes(name)
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function paths(value: unknown): string[] {
  if (typeof value === 'string') return value.trim() ? [value.trim()] : []
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
}

function refuse(message: string): HostReply {
  return { summary: message, error: message }
}

/** Models are loose with types, so "30" and 30 both have to work. */
function num(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'string') return undefined

  const timecode = /^(\d+):([0-5]?\d(?:\.\d+)?)$/.exec(value.trim())
  if (timecode) return Number(timecode[1]) * 60 + Number(timecode[2])

  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function bool(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value
  if (value === 'true') return true
  if (value === 'false') return false
  return undefined
}

async function callHost(call: ToolCall, host: HostBridge): Promise<HostReply> {
  const { args } = call

  switch (call.name) {
    case 'import_media':
      return host.importDialog()

    case 'import_file': {
      const wanted = paths(args.paths ?? args.path)
      if (wanted.length === 0) return refuse('Give me the full path of the file to import.')
      return host.importPaths(wanted)
    }

    case 'list_folder':
      return host.listFolder(str(args.path) ?? null)

    case 'find_media': {
      const query = str(args.query)
      const folder = str(args.folder) ?? null
      // Without a name to match, a folder is enough: everything playable in it
      // is a sensible answer to "what have I got in Documents".
      if (!query && !folder) return refuse('Tell me what to search for, or which folder to look in.')
      return host.findMedia(query ?? '', folder)
    }

    case 'analyze_clip':
      return host.analyzeClip({ clip: args.clip })

    case 'find_highlight':
      return host.findHighlight({
        clip: args.clip,
        duration: num(args.duration ?? args.length),
        count: num(args.count),
      })

    case 'make_short':
      return host.makeShort({
        clip: args.clip,
        duration: num(args.duration ?? args.length),
        aspect: num(args.aspect),
        reframe: bool(args.reframe),
      })

    case 'remove_silence':
      return host.removeSilence({ clip: args.clip, padding: num(args.padding) })

    case 'insert_cutaway': {
      const file = str(args.file ?? args.media ?? args.name ?? args.path ?? args.meme)
      return host.insertCutaway({
        file,
        at: args.at ?? args.start,
        duration: num(args.duration ?? args.length),
        placement: args.placement ?? args.position ?? args.where,
        size: num(args.size ?? args.scale),
      })
    }

    case 'punch_in':
      return host.punchIn({
        clip: args.clip,
        at: args.at ?? args.time,
        duration: num(args.duration ?? args.length),
        amount: num(args.amount ?? args.zoom ?? args.scale),
      })

    case 'make_montage':
      return host.makeMontage({
        each: num(args.each ?? args.per_clip ?? args.perClip),
        count: num(args.count ?? args.clips),
        duration: num(args.duration ?? args.total),
      })

    case 'generate_clip':
      return host.generateClip({
        text: args.text ?? args.words ?? args.title,
        seconds: num(args.seconds ?? args.duration ?? args.length),
        aspect: args.aspect ?? args.ratio ?? args.shape,
        look: args.look ?? args.style ?? args.theme,
        at: args.at ?? args.start,
      })

    case 'export_project':
      return host.exportProject({
        output: str(args.output),
        format: str(args.format),
        resolution: str(args.resolution),
      })

    case 'publish_youtube':
      return host.publish({
        title: str(args.title),
        description: str(args.description),
        visibility: str(args.visibility),
        tags: str(args.tags),
        short: bool(args.short),
      })

    case 'youtube_status':
      return host.youtubeStatus()

    default:
      return refuse(`"${String(call.name)}" is not a host tool.`)
  }
}

export async function executeCall(
  state: ProjectState,
  call: ToolCall,
  host: HostBridge,
): Promise<ToolOutcome> {
  if (!isHostTool(call.name)) return runTool(state, call)

  try {
    const reply = await callHost(call, host)
    // An import changes the project behind our back, so the state is read back
    // rather than carried over from before the call.
    return { state: host.latestState?.() ?? state, ...reply }
  } catch (error) {
    const message = `That failed: ${error instanceof Error ? error.message : String(error)}`
    return { state, summary: message, error: message }
  }
}

/**
 * Runs a batch in order, feeding each edit into the next call. A failure is
 * recorded but does not abandon the rest of the batch, so partial work lands.
 */
export async function executeCalls(
  state: ProjectState,
  calls: ToolCall[],
  host: HostBridge,
): Promise<{ state: ProjectState; outcomes: ToolOutcome[] }> {
  let current = state
  const outcomes: ToolOutcome[] = []

  for (const call of calls) {
    const outcome = await executeCall(current, call, host)
    current = outcome.state
    outcomes.push(outcome)
  }

  return { state: current, outcomes }
}
