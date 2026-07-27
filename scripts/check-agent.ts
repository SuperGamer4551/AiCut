// Assertions for the editing assistant: how plain instructions become tool
// calls, and what those calls do to the project.
// Run with: npm run check:agent
import type { MediaItem, TimelineClip, Track } from '../src/lib/types'
import type { HostBridge, ProjectState, ToolCall } from '../src/lib/agent/types'
import { findClip, findMedia, findTrack, parseSeconds, runTool, runTools } from '../src/lib/agent/runtime'
import { interpretCommand } from '../src/lib/agent/interpret'
import { converse, fallbackReply } from '../src/lib/agent/converse'
import { tidyReply } from '../src/lib/agent/reply'
import { isToolName, normalizeToolCall } from '../src/lib/agent/tools'
import { EMPTY_TRANSCRIPT, HISTORY_LIMIT, TRANSCRIPT_LIMIT, forStorage, normalizeTranscript } from '../src/lib/agent/transcript'
import { HOST_TOOLS, executeCalls, isHostTool } from '../src/lib/agent/execute'
import { addNote, learnFrom, learnedDefaults, memoryPrompt, normalizeMemory, removeNotes } from '../src/lib/agent/memory'
import type { MemoryNote } from '../src/lib/agent/memory'
import { createHostBridge, describeListing, describeMatches, looksLikeShort } from '../src/lib/agent/bridge'
import {
  addClipFor,
  addOverlay,
  cropToAspect,
  keepSourceRanges,
  moveClipTo,
  punchIn,
  sourceLimit,
  splitAt,
  useSourceRange,
} from '../src/lib/agent/recipes'
import { isCropped } from '../src/lib/crop'

let failures = 0

function normalize(value: unknown): string {
  return JSON.stringify(value, (_key, inner) => {
    if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
      return Object.fromEntries(Object.entries(inner).sort(([a], [b]) => a.localeCompare(b)))
    }
    return inner
  })
}

function check(label: string, actual: unknown, expected: unknown) {
  const pass = normalize(actual) === normalize(expected)
  if (!pass) failures += 1
  console.log(`${pass ? 'pass' : 'FAIL'}  ${label}`)
  if (!pass) console.log(`      expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

function media(name: string, kind: MediaItem['kind'], duration: number): MediaItem {
  return {
    id: `m-${name}`,
    name,
    path: `C:/clips/${name}`,
    url: `aicut://local/${name}`,
    kind,
    duration,
    size: 1024,
    width: kind === 'audio' ? undefined : 1920,
    height: kind === 'audio' ? undefined : 1080,
    loading: false,
  }
}

function clip(name: string, track: string, start: number, duration: number): TimelineClip {
  return {
    id: `c-${name}`,
    mediaId: `m-${name}.mp4`,
    name,
    kind: track.startsWith('audio') ? 'audio' : 'video',
    track,
    start,
    duration,
    color: '#3d7cff',
  }
}

const TRACKS: Track[] = [
  { id: 'video-1', name: 'Video track', kind: 'video' },
  { id: 'audio-1', name: 'Audio track', kind: 'audio' },
]

function note(text: string): MemoryNote {
  return { id: `n-${text.slice(0, 8)}`, text, createdAt: 1 }
}

function project(overrides: Partial<ProjectState> = {}): ProjectState {
  return {
    media: [media('intro.mp4', 'video', 12), media('theme.mp3', 'audio', 30)],
    clips: [],
    tracks: TRACKS,
    overlays: [],
    playhead: 4,
    zoom: 24,
    selectedClipId: null,
    memory: [],
    ...overrides,
  }
}

const run = (state: ProjectState, name: ToolCall['name'], args: Record<string, unknown> = {}) =>
  runTool(state, { name, args })

// --- Time parsing ----------------------------------------------------------
check('plain seconds parse', parseSeconds('12'), 12)
check('decimal seconds parse', parseSeconds('2.5'), 2.5)
check('a timecode parses to seconds', parseSeconds('1:30'), 90)
check('an hour-long timecode parses', parseSeconds('1:02:03'), 3723)
check('"90s" parses', parseSeconds('90s'), 90)
check('"1m30s" parses', parseSeconds('1m30s'), 90)
check('"2 minutes" parses', parseSeconds('2 minutes'), 120)
check('numbers pass through', parseSeconds(7), 7)
check('gibberish does not parse', parseSeconds('soon'), null)
check('negative times clamp to zero', parseSeconds(-5), 0)

// --- Resolving things by name ---------------------------------------------
const stocked = project({
  clips: [clip('intro', 'video-1', 0, 12), clip('outro', 'video-1', 12, 6)],
  selectedClipId: 'c-outro',
})

check('media resolves by exact name', findMedia(stocked, 'intro.mp4')?.name, 'intro.mp4')
check('media resolves without the extension', findMedia(stocked, 'intro')?.name, 'intro.mp4')
check('media resolves case-insensitively', findMedia(stocked, 'INTRO')?.name, 'intro.mp4')
check('media resolves by kind word', findMedia(stocked, 'music')?.name, 'theme.mp3')
check('"last" picks the newest import', findMedia(stocked, 'last')?.name, 'theme.mp3')
check('an unknown name resolves to nothing', findMedia(stocked, 'bloopers'), null)
check('a single import needs no name', findMedia(project({ media: [media('only.mp4', 'video', 5)] }), '')?.name, 'only.mp4')

check('"selected" resolves to the highlighted clip', findClip(stocked, 'selected')?.name, 'outro')
check('an unnamed clip request uses the selection', findClip(stocked, '')?.name, 'outro')
check('clips resolve by name', findClip(stocked, 'intro')?.name, 'intro')
check('"first" resolves to the earliest clip', findClip(stocked, 'first')?.name, 'intro')

check('tracks resolve by name', findTrack(stocked, 'Audio track')?.id, 'audio-1')
check('tracks resolve by kind', findTrack(stocked, 'video')?.id, 'video-1')
check('tracks resolve by kind and number', findTrack(stocked, 'audio 1')?.id, 'audio-1')
check('a missing track resolves to nothing', findTrack(stocked, 'video 4'), null)

// --- Placing clips --------------------------------------------------------
const added = run(project(), 'add_clip', { media: 'intro' })
check('adding a clip puts it on the video track', added.state.clips[0].track, 'video-1')
check('adding a clip with no time starts at zero', added.state.clips[0].start, 0)
check('adding a clip selects it', added.state.selectedClipId, added.state.clips[0].id)
check('adding a clip is reported plainly', added.summary, 'Added intro to Video track at 00:00.')

check('audio lands on the audio track', run(project(), 'add_clip', { media: 'theme.mp3' }).state.clips[0].track, 'audio-1')
check('a clip can start at the playhead', run(project(), 'add_clip', { media: 'intro', start: 'playhead' }).state.clips[0].start, 4)
check('a clip can start at a timecode', run(project(), 'add_clip', { media: 'intro', start: '0:10' }).state.clips[0].start, 10)

const appended = run(project({ clips: [clip('intro', 'video-1', 0, 12)] }), 'add_clip', { media: 'intro' })
check('a second clip appends after the first', appended.state.clips[1].start, 12)

const collided = run(project({ clips: [clip('intro', 'video-1', 0, 12)] }), 'add_clip', {
  media: 'intro',
  start: '5',
})
check('an overlapping placement slides to a free slot', collided.state.clips[1].start, 12)
check('the report says where it actually landed', collided.summary.includes('nearest free slot'), true)

check('unknown media is refused', run(project(), 'add_clip', { media: 'bloopers' }).error !== undefined, true)
check('an empty library is explained', run(project({ media: [] }), 'add_clip', { media: 'anything' }).summary.includes('Nothing is imported yet'), true)
check('audio cannot go on a video track', run(project(), 'add_clip', { media: 'theme.mp3', track: 'video-1' }).error !== undefined, true)
check('a refused call leaves the project alone', run(project(), 'add_clip', { media: 'bloopers' }).state.clips.length, 0)

// --- Moving, trimming, deleting ------------------------------------------
const placed = project({ clips: [clip('intro', 'video-1', 0, 12)], selectedClipId: 'c-intro' })

check('a clip moves to a given time', run(placed, 'move_clip', { clip: 'intro', start: '20' }).state.clips[0].start, 20)
check('a clip moves across tracks', run(project({ clips: [clip('beat', 'audio-1', 0, 4)] }), 'move_clip', { clip: 'beat', track: 'audio-1', start: '2' }).state.clips[0].start, 2)
check('a video clip cannot move onto an audio track', run(placed, 'move_clip', { clip: 'intro', track: 'audio-1', start: '0' }).error !== undefined, true)

check('a clip trims to a duration', run(placed, 'trim_clip', { clip: 'intro', duration: '5' }).state.clips[0].duration, 5)
check('a clip trims to an end time', run(placed, 'trim_clip', { clip: 'intro', end: '8' }).state.clips[0].duration, 8)
check('trimming past the source length is capped', run(placed, 'trim_clip', { clip: 'intro', duration: '600' }).state.clips[0].duration, 12)
check('a capped trim says so', run(placed, 'trim_clip', { clip: 'intro', duration: '600' }).summary.includes('limited by'), true)
check('a clip cannot be trimmed to nothing', run(placed, 'trim_clip', { clip: 'intro', duration: '0' }).error !== undefined, true)
check('trimming needs a length', run(placed, 'trim_clip', { clip: 'intro' }).error !== undefined, true)

const neighbours = project({
  clips: [clip('intro', 'video-1', 0, 5), clip('outro', 'video-1', 6, 5)],
  selectedClipId: 'c-intro',
})
check('growing a clip stops at its neighbour', run(neighbours, 'trim_clip', { clip: 'intro', duration: '10' }).state.clips[0].duration, 6)

check('a clip can be deleted', run(placed, 'delete_clip', { clip: 'intro' }).state.clips.length, 0)
check('deleting clears the selection', run(placed, 'delete_clip', { clip: 'intro' }).state.selectedClipId, null)

// --- Cropping -------------------------------------------------------------
const cropped = run(placed, 'crop_clip', { clip: 'intro', aspect: '9:16' })
check('cropping to 9:16 marks the clip cropped', isCropped(cropped.state.clips[0].crop), true)
check('a 9:16 crop keeps the full height', cropped.state.clips[0].crop?.height, 1)
check('a crop can be cleared', run(cropped.state, 'crop_clip', { clip: 'intro', aspect: 'reset' }).state.clips[0].crop, undefined)
check('audio cannot be cropped', run(project({ clips: [clip('beat', 'audio-1', 0, 4)], selectedClipId: 'c-beat' }), 'crop_clip', { aspect: '1:1' }).error !== undefined, true)
check('an unknown ratio is refused', run(placed, 'crop_clip', { clip: 'intro', aspect: '7:3' }).error !== undefined, true)

// --- Tracks ---------------------------------------------------------------
check('a video track can be added', run(project(), 'add_track', { kind: 'video' }).state.tracks.length, 3)
check('a new track can be named', run(project(), 'add_track', { kind: 'audio', name: 'Music' }).state.tracks[2].name, 'Music')
check('a track kind is required', run(project(), 'add_track', { kind: 'sideways' }).error !== undefined, true)
check('a track can be renamed', run(project(), 'rename_track', { track: 'video-1', name: 'A-roll' }).state.tracks[0].name, 'A-roll')
check('the last track of a kind cannot be removed', run(project(), 'remove_track', { track: 'video-1' }).error !== undefined, true)

const threeTracks = run(project(), 'add_track', { kind: 'video' }).state
const withClip = { ...threeTracks, clips: [clip('intro', 'video-2', 0, 4)] }
const removed = run(withClip, 'remove_track', { track: 'video 2' })
check('removing a track takes its clips with it', removed.state.clips.length, 0)
check('removing a track reports the lost clips', removed.summary.includes('1 clip'), true)

// --- Playhead and zoom ---------------------------------------------------
check('the playhead can be moved', run(project(), 'seek', { time: '0:30' }).state.playhead, 30)
check('zoom can be set directly', run(project(), 'set_zoom', { zoom: '60' }).state.zoom, 60)
check('zoom clamps to the maximum', run(project(), 'set_zoom', { zoom: '9000' }).state.zoom, 120)
check('zooming in multiplies the level', run(project(), 'set_zoom', { zoom: 'in' }).state.zoom, 36)

// --- Reading the project -------------------------------------------------
const described = run(stocked, 'describe_project').summary
check('the summary lists media', described.includes('intro.mp4'), true)
check('the summary lists clips with times', described.includes('from 00:00 to 00:12'), true)
check('the summary names the selected clip', described.includes('Selected clip: outro'), true)
check('an empty project says so', run(project({ media: [] }), 'describe_project').summary.includes('empty'), true)

// --- Batches -------------------------------------------------------------
const batch = runTools(project(), [
  { name: 'add_clip', args: { media: 'intro' } },
  { name: 'add_clip', args: { media: 'theme.mp3' } },
  { name: 'seek', args: { time: '2' } },
])
check('a batch applies every call in order', batch.state.clips.length, 2)
check('a batch reports one outcome per call', batch.outcomes.length, 3)
check('later calls see earlier edits', batch.state.playhead, 2)

const partial = runTools(project(), [
  { name: 'add_clip', args: { media: 'nope' } },
  { name: 'add_clip', args: { media: 'intro' } },
])
check('a failed call does not stop the batch', partial.state.clips.length, 1)
check('the failure is still reported', partial.outcomes[0].error !== undefined, true)

// --- Model output is untrusted -------------------------------------------
check('known tool names are accepted', isToolName('add_clip'), true)
check('unknown tool names are rejected', isToolName('rm_rf'), false)
check('json arguments are parsed', normalizeToolCall('add_clip', '{"media":"intro"}'), { name: 'add_clip', args: { media: 'intro' } })
check('object arguments are accepted', normalizeToolCall('seek', { time: 3 }), { name: 'seek', args: { time: 3 } })
check('empty arguments become an empty object', normalizeToolCall('describe_project', ''), { name: 'describe_project', args: {} })
check('malformed json is rejected', normalizeToolCall('add_clip', '{oops'), null)
check('an unknown tool is rejected', normalizeToolCall('drop_database', '{}'), null)
check('an unknown tool call is refused by the runtime', runTool(project(), { name: 'nonsense' as ToolCall['name'], args: {} }).error !== undefined, true)

// --- Plain-language commands ---------------------------------------------
const spoken = project({ clips: [clip('intro', 'video-1', 0, 12)], selectedClipId: 'c-intro' })
const said = (input: string) => interpretCommand(input, spoken).calls

check('"what is in my project" reads the project', said('what is in my project?'), [{ name: 'describe_project', args: {} }])
check('"show me the timeline" reads the project', said('show me the timeline')[0].name, 'describe_project')
check('"import some files" opens the picker', said('import some files'), [{ name: 'import_media', args: {} }])
check('"open a file from my computer" opens the picker', said('open a file from my computer')[0].name, 'import_media')
check('"add an audio track" adds a track', said('add an audio track'), [{ name: 'add_track', args: { kind: 'audio' } }])
check('"create another video track" adds a track', said('create another video track'), [{ name: 'add_track', args: { kind: 'video' } }])
check('"put my intro on the timeline" places a clip', said('put my intro on the timeline')[0], { name: 'add_clip', args: { media: 'intro.mp4' } })
check('"add theme at 5s" places with a time', said('add theme at 5s')[0], { name: 'add_clip', args: { media: 'theme.mp3', start: '5' } })
check('"add intro at the playhead" uses the playhead', said('add intro at the playhead')[0].args.start, 'playhead')
check('"add theme to the audio track" targets a track', said('add theme to the audio track')[0].args.track, 'audio')
check('"crop it to 9:16" crops the selection', said('crop it to 9:16')[0], { name: 'crop_clip', args: { clip: 'selected', aspect: '9:16' } })
check('"make it vertical for tiktok" crops to 9:16', said('crop it for tiktok')[0].args.aspect, '9:16')
check('"remove the crop" clears it', said('remove the crop')[0].args.aspect, 'reset')
check('"trim the clip to 5 seconds" trims the selection', said('trim the clip to 5 seconds')[0], { name: 'trim_clip', args: { clip: 'selected', duration: '5' } })
check('"trim intro to 5s" names the clip', said('trim intro to 5s')[0].args.clip, 'intro')
check('"shorten it to 1m30s" trims', said('shorten it to 1m30s')[0].args.duration, '90')
check('"move intro to 0:10" moves it', said('move intro to 0:10')[0], { name: 'move_clip', args: { clip: 'intro', start: '0:10' } })
check('"delete the selected clip" deletes it', said('delete the selected clip')[0], { name: 'delete_clip', args: { clip: 'selected' } })
check('"delete the audio track" removes a track', said('delete the audio track')[0], { name: 'remove_track', args: { track: 'audio' } })
check('"rename the video track to A-roll" renames', said('rename the video track to A-roll')[0], { name: 'rename_track', args: { track: 'video', name: 'A-roll' } })
check('"zoom in" zooms', said('zoom in')[0], { name: 'set_zoom', args: { zoom: 'in' } })
check('"zoom out" zooms', said('zoom out')[0].args.zoom, 'out')
check('"go to 1:00" seeks', said('go to 1:00')[0], { name: 'seek', args: { time: '1:00' } })

check('an empty message asks for nothing', said(''), [])
check('small talk asks for nothing', said('you are doing great'), [])
check(
  'captions from speech are named as unsupported',
  interpretCommand('add captions to my video', spoken).unsupported,
  'captions written from speech',
)
check('transitions are named as unsupported', interpretCommand('add a crossfade between them', spoken).unsupported, 'fades and transitions')

// --- Talking, not editing --------------------------------------------------
const alone = { connected: false, clips: 1, media: 2 }
const withModel = { connected: true, clips: 1, media: 2 }
const topicOf = (input: string) => converse(input, alone)?.topic ?? null
const saidAlone = (input: string) => converse(input, alone)?.text ?? ''

check('a greeting is answered', topicOf('hey'), 'greeting')
check('a greeting mentions what is already loaded', saidAlone('hello').includes('a clip'), true)
check('thanks is answered', topicOf('thanks!'), 'thanks')
check('praise is answered', topicOf('you are doing great'), 'praise')
check('an apology is answered', topicOf('sorry, my bad'), 'apology')
check('being asked how it is going is answered', topicOf("how's it going"), 'mood')
check('being asked what it is is answered', topicOf('what are you?'), 'identity')
check('a capability question lists the work', topicOf('what can you do'), 'capability')
check('a capability answer names the montage', saidAlone('what can you do?').includes('montage'), true)
check('an offline identity answer offers a free model', saidAlone('are you an ai').includes('free'), true)
check('a connected identity answer does not sell a model', converse('are you an ai', withModel)?.text.includes('free-tier'), false)

check('a cost question is answered', topicOf('is this going to cost me anything?'), 'cost')
check('the cost answer says conversation is free', saidAlone('do i have to pay for the ai').includes('Open-ended conversation is free'), true)
check('the cost answer names the local runtimes', saidAlone('is it free').includes('Ollama'), true)
check('a setup question is answered', topicOf('how do i connect ollama'), 'model')
check('the setup answer points at the settings', saidAlone('how do i connect a model').includes('gear'), true)

check('a question about shorts is answered, not acted on', said('how do i make a good youtube short'), [])
check('a question about shorts explains the tool', topicOf('how do i make a good youtube short'), 'shorts')
check('a hook question is answered', topicOf('any tips for hooks?'), 'hook')
check('a text question is answered', topicOf('how do i put text on screen'), 'text')
check('a meme question is answered', topicOf('can you explain the meme thing'), 'memes')
check('a montage question is answered', topicOf('what is the best way to build a montage'), 'montage')
check('a gaming question is answered', topicOf('i have a fortnite clip, what should i do with it'), 'gaming')
check('an export question is answered', topicOf('how do i export'), 'export')
check('a publish question is answered', topicOf('how do i publish to youtube'), 'publish')
check('a file question is answered', topicOf('how do i import from my documents folder'), 'files')
check('a length question is answered', topicOf('how long should a short be'), 'length')
check('a timeline question is answered', topicOf('how do i pan the timeline'), 'timeline')
check('a launch question is answered', topicOf('how do i reopen the app'), 'launch')
check('a version question is answered', topicOf('what is new in this version'), 'version')
check('a memory question is answered', topicOf('how do you remember things'), 'memory')
check('an undo question gets an honest answer', saidAlone('how do i undo').includes('no undo'), true)
check('"undo that" is answered rather than listed as missing', interpretCommand('undo that', spoken).unsupported, undefined)
check('"undo that" is answered honestly', topicOf('undo that'), 'undo')
check('a privacy question is answered', topicOf('does any of my footage get uploaded'), 'privacy')
check('a short acknowledgement is answered', topicOf('ok'), 'ack')
check('a goodbye is answered', topicOf('bye'), 'farewell')
check('a report of something broken is answered', topicOf('it is not working'), 'trouble')
check('being asked what to do next is answered', topicOf('any ideas?'), 'next')
check('being asked what to do with a clip is answered', topicOf('what should i do with this clip'), 'next')
check('advice with nothing imported starts at the import', converse('what should i do', { ...alone, clips: 0, media: 0 })?.text.includes('Import'), true)

check('off-topic is turned down kindly when alone', topicOf('tell me a joke'), 'off-topic')
check('the off-topic answer offers a free model', saidAlone('what is the weather').includes('free'), true)
check('off-topic is welcomed once a model is behind it', converse('tell me a joke', withModel)?.text.includes('ask away'), true)

// Talk is the last resort: an instruction is claimed by the interpreter first, so
// the same words only reach the conversation when nothing could be done with them.
check('an instruction still reaches the interpreter', said('make this into a youtube short')[0].name, 'make_short')
check('a bare mention with no instruction in it is talk', topicOf('shorts?'), 'shorts')
check('gibberish has nothing to say', converse('asdfgh', alone), null)
check('an empty message has nothing to say', converse('   ', alone), null)
check('the fallback admits it plainly', fallbackReply(alone).startsWith('I did not follow that.'), true)
check('the fallback offers free conversation', fallbackReply(alone).includes('nothing to pay'), true)
check('the fallback stays short with a model connected', fallbackReply(withModel).includes('Ollama'), false)

check('a question about the editor is not read as work', said('how do i crop this'), [])
check('a question about fades still says fades are missing', interpretCommand('how do i add a fade', spoken).unsupported, 'fades and transitions')
check('"what can you do" is talk, not a project summary', said('what can you do?'), [])
check('"tell me a joke" is talk, not a project summary', said('tell me a joke'), [])
check('"what is in my project" is still a project read', said('what is in my project?')[0].name, 'describe_project')
check('"how many clips do i have" is still a project read', said('how many clips do i have')[0].name, 'describe_project')
check('"show me the timeline" is still a project read', said('show me the timeline')[0].name, 'describe_project')
check('"how loud is intro" is still a measurement', said('how loud is intro')[0].name, 'analyze_clip')
check('a folder named without the word folder is still listed', said('what is in my downloads')[0], {
  name: 'list_folder',
  args: { path: 'downloads' },
})

// --- Tidying what a model writes -------------------------------------------
check('bold markers are dropped', tidyReply('Use **remove_silence** first.'), 'Use remove_silence first.')
check('italics are dropped', tidyReply('Try *make_short* on it.'), 'Try make_short on it.')
check('underscored bold is dropped', tidyReply('__Trim__ it.'), 'Trim it.')
check('backticks are dropped', tidyReply('Call `make_short`.'), 'Call make_short.')
check('headings lose their hashes', tidyReply('## What I would do\nCut it.'), 'What I would do\nCut it.')
check('bullets become plain marks', tidyReply('- trim it\n- add a hook'), '• trim it\n• add a hook')
check('starred bullets become plain marks', tidyReply('* trim it'), '• trim it')
check('indented bullets are caught too', tidyReply('  - trim it'), '• trim it')
check('numbered lists are left alone', tidyReply('1. trim it\n2. add a hook'), '1. trim it\n2. add a hook')
check('quotes lose their markers', tidyReply('> keep the best bit'), 'keep the best bit')
check('a horizontal rule goes', tidyReply('Done.\n\n---\n\nNext?'), 'Done.\n\nNext?')
check('fences go but the words stay', tidyReply('```\nexport as mp4\n```'), 'export as mp4')
check('blank runs are collapsed', tidyReply('One.\n\n\n\nTwo.'), 'One.\n\nTwo.')
check('surrounding space is trimmed', tidyReply('\n  Done.  \n'), 'Done.')
check('multiplication is not italics', tidyReply('Renders at 1080*1920.'), 'Renders at 1080*1920.')
check('plain prose is untouched', tidyReply('I cut it to the loudest 30 seconds.'), 'I cut it to the loudest 30 seconds.')
check('an empty reply stays empty', tidyReply(''), '')

// --- Goal-level requests, which is how people actually ask -----------------
check('"make this into a youtube short" makes a short', said('make this into a youtube short')[0].name, 'make_short')
check('"turn this into a tiktok" makes a short', said('turn this into a tiktok')[0].name, 'make_short')
check('"make me a 45 second short" carries the length', said('make me a 45 second short')[0].args.duration, 45)
check('"make a reel out of this" makes a short', said('make a reel out of this')[0].name, 'make_short')
check('"make this a vertical short" makes a short', said('make this a vertical short')[0].name, 'make_short')
check('"cut this down to the best 20 seconds" makes a short', said('cut this down to the best 20 seconds')[0], {
  name: 'make_short',
  args: { clip: 'selected', duration: 20, reframe: false },
})
check('a plain best-bit request keeps the framing', said('cut it down to the best part')[0].args.reframe, false)
check('"crop it for tiktok" still just crops', said('crop it for tiktok')[0], {
  name: 'crop_clip',
  args: { clip: 'selected', aspect: '9:16' },
})
check('"make it vertical" still just crops', said('make it vertical')[0].name, 'crop_clip')
check('"export this as a short" still exports', said('export this as a short')[0].name, 'export_project')

check('"find the best part" reports highlights', said('find the best part of this clip')[0].name, 'find_highlight')
check('"where is the action" reports highlights', said('where is the action in intro')[0].name, 'find_highlight')
check('a highlight request carries the window length', said('find the best 15 seconds')[0].args.duration, 15)
check('"cut the dead air" removes silence', said('cut the dead air out of this')[0].name, 'remove_silence')
check('"remove the silence" removes silence', said('remove the silence from intro')[0], {
  name: 'remove_silence',
  args: { clip: 'intro' },
})
check('"trim the boring parts" removes silence', said('trim the boring parts')[0].name, 'remove_silence')
check('"analyze this clip" measures it', said('analyze this clip')[0].name, 'analyze_clip')
check('"how loud is intro" measures it', said('how loud is intro')[0].args.clip, 'intro')

check('"split the clip at the playhead" splits', said('split the clip at the playhead')[0], {
  name: 'split_clip',
  args: { clip: 'selected', at: 'playhead' },
})
check('"split intro at 0:30" carries the time', said('split intro at 0:30')[0].args.at, '0:30')
check('"cut it in half here" splits', said('cut it in half here')[0].name, 'split_clip')
check('"keep 1:10 to 1:40" uses that range', said('keep 1:10 to 1:40')[0], {
  name: 'use_range',
  args: { clip: 'selected', from: '1:10', to: '1:40' },
})
check('"just use 12s to 30s" uses that range', said('just use 12s to 30s')[0].args.from, '12')
check('"post it to youtube as a short" publishes as a short', said('post it to youtube as a short')[0].args.short, true)

// --- Text on screen -------------------------------------------------------
check('a quoted hook becomes text', said('add a hook that says "wait for it"')[0], {
  name: 'add_text',
  args: { text: 'wait for it', style: 'title' },
})
check('an unquoted phrase becomes text', said('put text saying subscribe for more')[0].args.text, 'subscribe for more')
check('a meme line asks for the meme look', said('add a meme caption saying "bro really did that"')[0].args.style, 'meme')
check('a bottom caption asks for the caption look', said('add a caption at the bottom saying "clip 1 of 3"')[0].args.style, 'caption')
check('a position is carried through', said('put text at the top saying "GG"')[0].args.position, 'top')
check('a hold time is carried through', said('add a title saying "round two" for 4 seconds')[0].args.duration, 4)
check('a time is carried through', said('add a title saying "round two" at 0:12')[0].args.at, '0:12')
check('the hold time is not mistaken for the words', said('add a title saying "round two" for 4 seconds')[0].args.text, 'round two')
check('text with nothing to say asks for the words', said('add some text')[0], { name: 'add_text', args: { text: '' } })
check('"remove the text" removes text', said('remove the text')[0], { name: 'remove_text', args: { text: 'all' } })
check('text can be removed by what it says', said('delete the text that says "wait for it"')[0].args.text, 'wait for it')

// --- Memes, reactions, and sound effects ----------------------------------
check('"put a meme here" drops one in', said('put a meme here')[0].name, 'insert_cutaway')
check('a named meme is passed through', said('drop the bruh meme in at 0:12')[0].args.file, 'bruh')
check('the moment is passed through', said('drop the bruh meme in at 0:12')[0].args.at, '0:12')
check('a sound effect is an insert too', said('add a vine boom sound effect at the playhead')[0], {
  name: 'insert_cutaway',
  args: { file: 'vine boom', at: 'playhead' },
})
check('a corner is passed through', said('put the reaction in the top right corner')[0].args.placement, 'top-right')
check('a file name is passed through', said('insert meme.png here')[0].args.file, 'meme.png')
check('a hold time is passed through', said('put a meme in for 2 seconds')[0].args.duration, 2)

// --- Montages and punch-ins ----------------------------------------------
check('"make me a montage" builds one', said('make me a montage')[0].name, 'make_montage')
check('a highlight reel is a montage', said('make a highlight reel from my clips')[0].name, 'make_montage')
check('a per-clip length is carried through', said('make a montage with 3 seconds from each clip')[0].args.each, 3)
check('a clip count is carried through', said('montage from 4 clips')[0].args.count, 4)
check('a total length becomes the target', said('make a 30 second montage')[0].args.duration, 30)

check('"punch in here" punches in', said('punch in here')[0].name, 'punch_in')
check('"zoom in on the action" punches in', said('zoom in on the action')[0].name, 'punch_in')
check('a punch-in amount is carried through', said('punch in 2x at 0:30')[0].args.amount, 2)
check('a plain "zoom in" is still the timeline zoom', said('zoom in')[0].name, 'set_zoom')
check('"zoom out" is still the timeline zoom', said('zoom out')[0].name, 'set_zoom')

check('a facecam can be sent to a corner', said('put the facecam in the bottom left corner', )[0].name, 'place_clip')
check('a corner request carries the corner', said('move it to the bottom left corner')[0].args.placement, 'bottom-left')

// --- Looking around the computer -----------------------------------------
check('a folder search names the folder', said('find my fortnite clip in my documents folder')[0], {
  name: 'find_media',
  args: { query: 'fortnite', folder: 'documents' },
})
check('a folder with nothing named lists everything in it', said('is there anything in my documents folder')[0], {
  name: 'find_media',
  args: { query: '', folder: 'documents' },
})

// A spoken instruction should survive the whole path: text to call to edit.
const spokenEdit = runTools(spoken, interpretCommand('crop it to 1:1', spoken).calls)
check('a spoken crop actually crops the clip', isCropped(spokenEdit.state.clips[0].crop), true)
const spokenAdd = runTools(project(), interpretCommand('add intro at 3 seconds', project()).calls)
check('a spoken placement actually adds a clip', spokenAdd.state.clips.length, 1)
check('a spoken placement lands at the asked time', spokenAdd.state.clips[0].start, 3)

// --- Learning from what the user says ------------------------------------
check('"remember that ..." is learned', learnFrom('remember that I hate long intros'), 'I hate long intros')
check('"always ..." is learned', learnFrom('always crop my clips to 9:16'), 'always crop my clips to 9:16')
check('"never ..." is learned', learnFrom('never make anything public'), 'never make anything public')
check('"from now on ..." is learned', learnFrom('from now on export in 4k'), 'export in 4k')
check('"i prefer ..." is learned', learnFrom('i prefer vertical video'), 'prefer vertical video')
check('a plain command teaches nothing', learnFrom('add my intro at 5s'), null)
check('a question teaches nothing', learnFrom('should I always use 9:16?'), null)
check('an empty message teaches nothing', learnFrom('   '), null)
check('a trailing period is trimmed', learnFrom('remember that I shoot at 60fps.'), 'I shoot at 60fps')

const learnedOnce = addNote([], 'always crop to 9:16')
check('a note is stored', learnedOnce.notes.length, 1)
check('a repeat is not stored twice', addNote(learnedOnce.notes, 'Always crop to 9:16').notes.length, 1)
check('a repeat is reported as a duplicate', addNote(learnedOnce.notes, 'always crop to 9:16').duplicate, true)
check('an empty note is refused', addNote([], ' ').note, null)
check('notes can be dropped by text', removeNotes(learnedOnce.notes, '9:16').notes.length, 0)
check('dropping reports what went', removeNotes(learnedOnce.notes, '9:16').removed.length, 1)
check('"all" clears everything', removeNotes(learnedOnce.notes, 'all').notes.length, 0)
check('dropping an unknown note removes nothing', removeNotes(learnedOnce.notes, 'sausages').removed.length, 0)
check('stored notes are read back', normalizeMemory([{ id: 'a', text: 'hi there', createdAt: 2 }]).length, 1)
check('junk in storage is ignored', normalizeMemory([{ nope: true }, 'string', null]), [])
check('notes reach the model prompt', memoryPrompt([note('always use 9:16')]).includes('always use 9:16'), true)
check('an empty memory adds no prompt', memoryPrompt([]), '')

const taught = learnedDefaults([
  note('always crop my videos to 9:16'),
  note('always export as webm'),
  note('keep uploads unlisted on youtube'),
  note('"my intro" means intro_take3.mp4'),
])
check('a standing crop preference is picked up', taught.aspect, '9:16')
check('a standing format preference is picked up', taught.format, 'webm')
check('a passing mention is not a default', learnedDefaults([note('this clip is 9:16')]).aspect, null)
check('a nickname is picked up', taught.aliases['my intro'], 'intro_take3.mp4')

const remembering = run(project(), 'remember', { text: 'always crop to 9:16' })
check('the remember tool stores a note', remembering.state.memory.length, 1)
check('the remember tool needs text', run(project(), 'remember', {}).error !== undefined, true)
check('the forget tool drops a note', run(remembering.state, 'forget', { text: '9:16' }).state.memory.length, 0)
check('forgetting nothing is reported', run(project(), 'forget', { text: 'anything' }).error !== undefined, true)
check('memory can be listed', run(remembering.state, 'list_memory').summary.includes('always crop to 9:16'), true)
check('an empty memory says so', run(project(), 'list_memory').summary.includes('not taught me anything'), true)

// Preferences change what a bare instruction does.
const preferring = project({
  clips: [clip('intro', 'video-1', 0, 12)],
  selectedClipId: 'c-intro',
  memory: [note('always crop my clips to 9:16')],
})
check('a bare "crop it" uses the remembered ratio', interpretCommand('crop it', preferring).calls[0].args.aspect, '9:16')
check('a bare crop call uses the remembered ratio', isCropped(run(preferring, 'crop_clip', { clip: 'intro' }).state.clips[0].crop), true)
check('an explicit ratio still wins', run(preferring, 'crop_clip', { clip: 'intro', aspect: '1:1' }).state.clips[0].crop?.width, 0.5625)

const nicknamed = project({ memory: [note('"my intro" means intro.mp4')] })
check('a nickname resolves to the file', findMedia(nicknamed, 'my intro')?.name, 'intro.mp4')
check('the summary mentions what was taught', run(nicknamed, 'describe_project').summary.includes('Remembered (1)'), true)

// --- Using part of a file, splitting, and dropping dead air ---------------
const long = project({
  media: [media('gameplay.mp4', 'video', 300)],
  clips: [{ ...clip('gameplay', 'video-1', 0, 300), mediaId: 'm-gameplay.mp4' }],
  selectedClipId: 'c-gameplay',
})
const wholeClip = long.clips[0]

const ranged = useSourceRange(long, wholeClip, 70, 100)
check('a source range sets the in-point', 'state' in ranged ? ranged.state.clips[0].offset : null, 70)
check('a source range sets the length', 'state' in ranged ? ranged.state.clips[0].duration : null, 30)
check('a source range leaves the clip where it sits', 'state' in ranged ? ranged.state.clips[0].start : null, 0)
check(
  'a range past the end of the file is capped',
  'state' in useSourceRange(long, wholeClip, 290, 400) ? 'ok' : 'refused',
  'ok',
)
check(
  'a range past the end of the file keeps what is left',
  (useSourceRange(long, wholeClip, 290, 400) as { state: ProjectState }).state.clips[0].duration,
  10,
)
check('reversed times are read either way round', (useSourceRange(long, wholeClip, 100, 70) as { state: ProjectState }).state.clips[0].offset, 70)
check('a range with nothing in it is refused', 'error' in useSourceRange(long, wholeClip, 70, 70), true)
check('sourceLimit accounts for the in-point', sourceLimit((ranged as { state: ProjectState }).state, (ranged as { state: ProjectState }).state.clips[0]), 230)
check(
  'a trimmed clip cannot be grown past what is left of its file',
  run((ranged as { state: ProjectState }).state, 'trim_clip', { clip: 'gameplay', duration: '400' }).state.clips[0].duration,
  230,
)
check(
  'the summary reports the part of the file in use',
  run((ranged as { state: ProjectState }).state, 'describe_project').summary.includes('source 01:10'),
  true,
)

const halved = splitAt(long, wholeClip, 120)
check('splitting leaves two clips', 'state' in halved ? halved.state.clips.length : 0, 2)
check('the first half ends at the cut', 'state' in halved ? halved.state.clips[0].duration : 0, 120)
check('the second half starts at the cut', 'state' in halved ? halved.state.clips[1].start : 0, 120)
check('the second half continues the source', 'state' in halved ? halved.state.clips[1].offset : 0, 120)
check('the second half becomes the selection', 'state' in halved ? halved.state.selectedClipId : '', 'state' in halved ? halved.state.clips[1].id : '')
check('splitting at the very start is refused', 'error' in splitAt(long, wholeClip, 0), true)
check('splitting past the end is refused', 'error' in splitAt(long, wholeClip, 300), true)
check(
  'a split of an already trimmed clip carries its in-point',
  (splitAt((ranged as { state: ProjectState }).state, (ranged as { state: ProjectState }).state.clips[0], 10) as { state: ProjectState }).state.clips[1].offset,
  80,
)

const kept = keepSourceRanges(long, wholeClip, [
  { start: 0, end: 40 },
  { start: 100, end: 160 },
])
check('each kept range becomes a clip', 'state' in kept ? kept.state.clips.length : 0, 2)
check('the pieces sit end to end', 'state' in kept ? kept.state.clips.map((entry) => [entry.start, entry.duration]) : [], [[0, 40], [40, 60]])
check('each piece points at its own part of the file', 'state' in kept ? kept.state.clips.map((entry) => entry.offset) : [], [0, 100])
check('the time dropped is reported', 'state' in kept ? Math.round(kept.removed) : 0, 200)
check(
  'ranges too small to matter are ignored',
  (keepSourceRanges(long, wholeClip, [{ start: 0, end: 40 }, { start: 50, end: 50.05 }]) as { state: ProjectState }).state.clips.length,
  1,
)
check('a clip with nothing to cut is left alone', 'error' in keepSourceRanges(long, wholeClip, [{ start: 0, end: 300 }]), true)
check('a clip with nothing worth keeping is refused', 'error' in keepSourceRanges(long, wholeClip, []), true)

// Clips after the shortened one slide back so no gap is left behind.
const withTail = project({
  media: [media('gameplay.mp4', 'video', 300)],
  clips: [
    { ...clip('gameplay', 'video-1', 0, 100), mediaId: 'm-gameplay.mp4' },
    { ...clip('outro', 'video-1', 100, 10), mediaId: 'm-gameplay.mp4' },
  ],
})
const tightened = keepSourceRanges(withTail, withTail.clips[0], [{ start: 0, end: 60 }])
check(
  'later clips close the gap left behind',
  'state' in tightened ? tightened.state.clips.find((entry) => entry.name === 'outro')?.start : null,
  60,
)

const vertical = cropToAspect(long, wholeClip, 9 / 16)
check('reframing to 9:16 keeps the full height', vertical.crop.height, 1)
check('reframing to 9:16 narrows the frame to 9:16', Number(vertical.crop.width.toFixed(4)), 0.3164)
check('reframing to 9:16 centres the picture', Number(vertical.crop.x.toFixed(4)), 0.3418)
check('reframing marks the clip cropped', isCropped(vertical.state.clips[0].crop), true)

check('a recipe can place media that is not on the timeline yet', 'clip' in addClipFor(project(), 'm-intro.mp4', 'video-1', 0), true)
check('placing unknown media is refused', 'error' in addClipFor(project(), 'nope', 'video-1', 0), true)
check(
  'moving a clip to the head of the timeline lands at zero',
  moveClipTo(long, wholeClip, 0).start,
  0,
)

// --- The same edits through the tool layer --------------------------------
check('use_range sets the in-point', run(long, 'use_range', { clip: 'gameplay', from: '1:10', to: '1:40' }).state.clips[0].offset, 70)
check('use_range reports the part in use', run(long, 'use_range', { clip: 'gameplay', from: '70', to: '100' }).summary.includes('01:10 to 01:40'), true)
check('use_range needs both ends', run(long, 'use_range', { clip: 'gameplay', from: '70' }).error !== undefined, true)
check('use_range refuses an unknown clip', run(long, 'use_range', { clip: 'nope', from: '1', to: '2' }).error !== undefined, true)
check('split_clip splits at the playhead by default', run({ ...long, playhead: 30 }, 'split_clip', { clip: 'gameplay' }).state.clips.length, 2)
check('split_clip splits at a given time', run(long, 'split_clip', { clip: 'gameplay', at: '2:00' }).state.clips[1].start, 120)
check('split_clip refuses an impossible cut', run(long, 'split_clip', { clip: 'gameplay', at: '0' }).error !== undefined, true)

// --- Text on screen, as state -------------------------------------------
const titled = run(project(), 'add_text', { text: 'wait for it', at: '5', duration: 3, style: 'meme' })
check('add_text stores the words', titled.state.overlays[0].text, 'wait for it')
check('add_text stores when it starts', titled.state.overlays[0].start, 5)
check('add_text stores how long it holds', titled.state.overlays[0].duration, 3)
check('add_text stores the look', titled.state.overlays[0].style, 'meme')
check('a meme line sits at the top by default', titled.state.overlays[0].position, 'top')
check('a title sits in the middle by default', run(project(), 'add_text', { text: 'hi' }).state.overlays[0].position, 'middle')
check('a caption sits at the bottom by default', run(project(), 'add_text', { text: 'hi', style: 'caption' }).state.overlays[0].position, 'bottom')
check('add_text defaults to the playhead', run(project({ playhead: 8 }), 'add_text', { text: 'hi' }).state.overlays[0].start, 8)
check('add_text needs words', run(project(), 'add_text', {}).error !== undefined, true)
check('add_text refuses a look it does not have', run(project(), 'add_text', { text: 'hi', style: 'neon' }).error !== undefined, true)
check('add_text reports what it wrote', titled.summary.includes('wait for it'), true)
check('text is very short by demand but never zero', run(project(), 'add_text', { text: 'hi', duration: 0 }).state.overlays[0].duration > 0, true)

const twoLines = run(titled.state, 'add_text', { text: 'told you', at: '20' }).state
check('remove_text drops one line by what it says', run(twoLines, 'remove_text', { text: 'told you' }).state.overlays.length, 1)
check('remove_text drops everything when asked', run(twoLines, 'remove_text', { text: 'all' }).state.overlays.length, 0)
check('remove_text with no text drops everything', run(twoLines, 'remove_text', {}).state.overlays.length, 0)
check('remove_text on a bare timeline is refused', run(project(), 'remove_text', { text: 'all' }).error !== undefined, true)
check('remove_text says what went', run(twoLines, 'remove_text', { text: 'told you' }).summary.includes('told you'), true)

const overlaid = addOverlay(project(), { text: '  spaced  out  ', start: -4 })
check('text is tidied before it is stored', 'overlay' in overlaid ? overlaid.overlay.text : null, 'spaced out')
check('text cannot start before the timeline', 'overlay' in overlaid ? overlaid.overlay.start : null, 0)
check('empty text is refused by the recipe', 'error' in addOverlay(project(), { text: '   ', start: 0 }), true)
check('the timeline summary counts the text', run(twoLines, 'describe_project').summary.includes('Text (2)'), true)

// --- Picture-in-picture -------------------------------------------------
const framed = run(long, 'place_clip', { clip: 'gameplay', placement: 'bottom-right' })
check('place_clip puts the clip in a box', framed.state.clips[0].frame !== undefined, true)
check('a corner box sits in that corner', (framed.state.clips[0].frame?.x ?? 0) > 0.5, true)
check('a corner box is smaller than the frame', (framed.state.clips[0].frame?.width ?? 1) < 1, true)
check('place_clip can hand the frame back', run(framed.state, 'place_clip', { clip: 'gameplay', placement: 'full' }).state.clips[0].frame, undefined)
check('place_clip understands "corner"', run(long, 'place_clip', { clip: 'gameplay', placement: 'corner' }).state.clips[0].frame !== undefined, true)
check('place_clip refuses a place it does not know', run(long, 'place_clip', { clip: 'gameplay', placement: 'sideways' }).error !== undefined, true)
check('a smaller inset is smaller', (run(long, 'place_clip', { clip: 'gameplay', placement: 'bottom-right', size: 0.5 }).state.clips[0].frame?.width ?? 1) < (framed.state.clips[0].frame?.width ?? 0), true)
check('an inset stays inside the frame', (() => {
  const frame = run(long, 'place_clip', { clip: 'gameplay', placement: 'top-left', size: 1 }).state.clips[0].frame
  return frame !== undefined && frame.x >= 0 && frame.y >= 0 && frame.x + frame.width <= 1 && frame.y + frame.height <= 1
})(), true)
check('place_clip says where it put it', framed.summary.toLowerCase().includes('bottom right'), true)

const punched = punchIn(long, wholeClip, 100, 4, 1.5)
check('a punch-in cuts a piece out', 'state' in punched ? punched.state.clips.length : 0, 3)
check('the punched piece is the one asked for', 'state' in punched ? Math.round(punched.state.clips[1].duration) : 0, 4)
check('the punched piece is cropped in', 'state' in punched ? isCropped(punched.state.clips[1].crop) : false, true)
check('the punched piece is selected', 'state' in punched ? punched.state.selectedClipId : null, 'state' in punched ? punched.state.clips[1].id : null)
check('the pieces either side are left alone', 'state' in punched ? punched.state.clips[0].crop : 'x', undefined)
check('a punch-in at the head needs only one cut', 'state' in punchIn(long, wholeClip, 0, 4, 1.5) ? punchIn(long, wholeClip, 0, 4, 1.5).state.clips.length : 0, 2)
check('a punch-in longer than the clip is capped', 'state' in punchIn(long, wholeClip, 0, 999, 1.5) ? punchIn(long, wholeClip, 0, 999, 1.5).state.clips.length : 0, 1)
const punchedLate = punchIn(long, wholeClip, 999, 4, 1.5)
check('a punch-in past the end slides back so it still fits', 'state' in punchedLate ? punchedLate.from : null, 296)
check('a punch-in at the tail needs only one cut', 'state' in punchedLate ? punchedLate.state.clips.length : 0, 2)
check('the tail piece is the one pushed in', 'state' in punchedLate ? isCropped(punchedLate.state.clips[1].crop) : false, true)

// --- Files, export, and publishing are host tools -------------------------
check('host tools are recognised', isHostTool('find_media'), true)
check('state tools are not host tools', isHostTool('add_clip'), false)
check('every host tool is listed once', HOST_TOOLS.length, new Set(HOST_TOOLS).size)

const seen: string[] = []
const fakeHost: HostBridge = {
  importDialog: async () => {
    seen.push('importDialog')
    return { summary: 'Imported 1 file: picked.mp4.' }
  },
  importPaths: async (paths) => {
    seen.push(`importPaths(${paths.join('|')})`)
    return { summary: `Imported ${paths.length} file.` }
  },
  listFolder: async (folder) => {
    seen.push(`listFolder(${folder ?? 'roots'})`)
    return { summary: 'listing' }
  },
  analyzeClip: async (options) => {
    seen.push(`analyze(${String(options.clip ?? 'selected')})`)
    return { summary: 'measured' }
  },
  findHighlight: async (options) => {
    seen.push(`highlight(${String(options.clip ?? 'selected')},${options.duration ?? 'default'})`)
    return { summary: 'highlights' }
  },
  makeShort: async (options) => {
    seen.push(`short(${String(options.clip ?? 'selected')},${options.duration ?? 'default'},${options.reframe ?? 'default'})`)
    return { summary: 'made a short' }
  },
  removeSilence: async (options) => {
    seen.push(`silence(${String(options.clip ?? 'selected')},${options.padding ?? 'default'})`)
    return { summary: 'cut dead air' }
  },
  findMedia: async (query, folder) => {
    seen.push(`findMedia(${query},${folder ?? 'default'})`)
    return { summary: 'matches' }
  },
  insertCutaway: async (options) => {
    seen.push(`cutaway(${options.file},${options.at ?? 'playhead'},${options.placement ?? 'default'})`)
    return { summary: 'dropped a meme in' }
  },
  punchIn: async (options) => {
    seen.push(`punch(${String(options.clip ?? 'selected')},${options.at ?? 'auto'},${options.amount ?? 'default'})`)
    return { summary: 'punched in' }
  },
  makeMontage: async (options) => {
    seen.push(`montage(${options.each ?? 'default'},${options.count ?? 'all'})`)
    return { summary: 'built a montage' }
  },
  generateClip: async (options) => {
    seen.push(
      `generate(${String(options.text ?? 'blank')},${options.seconds ?? 'default'},${String(
        options.aspect ?? 'auto',
      )},${String(options.look ?? 'dark')})`,
    )
    return { summary: 'drew a card' }
  },
  exportProject: async (options) => {
    seen.push(`export(${options.format ?? 'mp4'},${options.resolution ?? 'auto'})`)
    return { summary: 'Exported to disk.' }
  },
  publish: async (options) => {
    seen.push(`publish(${options.title},${options.visibility ?? 'private'})`)
    return { summary: 'Published.' }
  },
  youtubeStatus: async () => {
    seen.push('youtubeStatus')
    return { summary: 'Connected.' }
  },
}

async function hostChecks() {
  const mixed = await executeCalls(project(), [
    { name: 'find_media', args: { query: 'beach' } },
    { name: 'import_file', args: { paths: ['C:/clips/beach.mp4'] } },
    { name: 'add_clip', args: { media: 'intro' } },
    { name: 'export_project', args: { format: 'webm', resolution: '1080p' } },
    { name: 'publish_youtube', args: { title: 'Trip', visibility: 'public' } },
  ], fakeHost)

  check('host and state tools run in one batch', mixed.outcomes.length, 5)
  check('state edits still apply inside a mixed batch', mixed.state.clips.length, 1)
  check(
    'each host tool is dispatched with its arguments',
    seen,
    ['findMedia(beach,default)', 'importPaths(C:/clips/beach.mp4)', 'export(webm,1080p)', 'publish(Trip,public)'],
  )

  // The recipes are host tools too, since they have to listen to the file.
  seen.length = 0
  await executeCalls(project(), [
    { name: 'make_short', args: { clip: 'gameplay', duration: '45' } },
    { name: 'remove_silence', args: { padding: 0.3 } },
    { name: 'find_highlight', args: { duration: 20 } },
    { name: 'analyze_clip', args: {} },
  ], fakeHost)
  check('the recipes are dispatched with their arguments', seen, [
    'short(gameplay,45,default)',
    'silence(selected,0.3)',
    'highlight(selected,20)',
    'analyze(selected)',
  ])

  seen.length = 0
  await executeCalls(project(), [
    { name: 'insert_cutaway', args: { file: 'bruh.mp4', at: '0:12', placement: 'top-right' } },
    { name: 'punch_in', args: { at: '0:30', amount: 2 } },
    { name: 'make_montage', args: { each: 3, count: 4 } },
  ], fakeHost)
  check('the youtube tools are dispatched with their arguments', seen, [
    'cutaway(bruh.mp4,0:12,top-right)',
    'punch(selected,0:30,2)',
    'montage(3,4)',
  ])

  // An insert with nothing named still reaches the host, which knows what to
  // ask for and where it has been taught to look.
  seen.length = 0
  await executeCalls(project(), [{ name: 'insert_cutaway', args: {} }], fakeHost)
  check('an insert with no file still reaches the host', seen, ['cutaway(undefined,playhead,default)'])

  const looseArgs = await executeCalls(project(), [
    { name: 'make_short', args: { duration: '1:00', reframe: 'false' } },
  ], fakeHost)
  check('a model writing "1:00" and "false" is understood', seen[seen.length - 1], 'short(selected,60,false)')
  check('a loose recipe call still succeeds', looseArgs.outcomes[0].error, undefined)

  const single = await executeCalls(project(), [{ name: 'import_file', args: { path: 'C:/one.mp4' } }], fakeHost)
  check('a single path is accepted in place of a list', single.outcomes[0].error, undefined)

  const missing = await executeCalls(project(), [{ name: 'import_file', args: {} }], fakeHost)
  check('importing with no path is refused', missing.outcomes[0].error !== undefined, true)

  const vague = await executeCalls(project(), [{ name: 'find_media', args: {} }], fakeHost)
  check('searching with no query is refused', vague.outcomes[0].error !== undefined, true)

  // Importing happens outside the runtime, so the state has to be read back or
  // the new media is lost when the batch is applied.
  const beforeImport = project({ media: [] })
  const importing: HostBridge = {
    ...fakeHost,
    latestState: () => ({ ...beforeImport, media: [media('found.mp4', 'video', 7)] }),
  }
  const afterImport = await executeCalls(beforeImport, [
    { name: 'import_file', args: { paths: ['C:/found.mp4'] } },
    { name: 'add_clip', args: { media: 'found.mp4' } },
  ], importing)
  check('imported media survives the batch', afterImport.state.media.map((item) => item.name), ['found.mp4'])
  check('a clip can be placed from media imported in the same batch', afterImport.state.clips.length, 1)
  check('placing the fresh import did not fail', afterImport.outcomes[1].error, undefined)

  const exploding: HostBridge = {
    ...fakeHost,
    exportProject: async () => {
      throw new Error('ffmpeg vanished')
    },
  }
  const crashed = await executeCalls(project(), [{ name: 'export_project', args: {} }], exploding)
  check('a host tool that throws is reported, not fatal', crashed.outcomes[0].error?.includes('ffmpeg vanished'), true)

  // --- The bridge that talks to the desktop ------------------------------
  const listing = {
    folder: 'C:/Users/me/Videos',
    entries: [
      { name: 'trips', path: 'C:/Users/me/Videos/trips', kind: 'folder' as const, size: 0 },
      { name: 'beach.mp4', path: 'C:/Users/me/Videos/beach.mp4', kind: 'media' as const, size: 5_242_880 },
    ],
    truncated: false,
  }
  check('a listing names the folder', describeListing(listing).includes('C:/Users/me/Videos'), true)
  check('a listing separates folders from media', describeListing(listing).includes('Folders (1)'), true)
  check('a listing gives full paths so files can be imported', describeListing(listing).includes('C:/Users/me/Videos/beach.mp4'), true)
  check('an empty folder is described plainly', describeListing({ folder: 'C:/empty', entries: [], truncated: false }).includes('no sub-folders'), true)
  check('matches are listed with sizes', describeMatches('beach', [{ name: 'beach.mp4', path: 'C:/beach.mp4', size: 2_097_152 }], false).includes('2.0 MB'), true)
  check('no matches is said clearly', describeMatches('yeti', [], false).includes('Nothing matching'), true)

  const asked: string[] = []
  // A quiet three minutes with twenty loud seconds in the middle, the shape of a
  // gameplay recording, plus a couple of silent stretches to cut.
  const gameplayAudio = {
    path: 'C:/clips/gameplay.mp4',
    hasAudio: true,
    duration: 180,
    loudness: Array.from({ length: 180 }, (_unused, second) => ({
      time: second,
      level: second >= 100 && second < 120 ? -12 : -42,
    })),
    silences: [
      { start: 20, end: 40 },
      { start: 140, end: 160 },
    ],
  }

  const desktopStub = {
    analysis: {
      clip: async (path: string) => {
        asked.push(`analysis(${path})`)
        return gameplayAudio
      },
    },
    files: {
      roots: async () => [{ name: 'Videos', path: 'C:/Users/me/Videos' }],
      list: async (folder: string | null) => {
        asked.push(`list(${folder})`)
        return listing
      },
      find: async (query: string) => {
        asked.push(`find(${query})`)
        return { matches: listing.entries.filter((e) => e.kind === 'media'), truncated: false, roots: [] }
      },
    },
    exporter: {
      choosePath: async (suggestion: string, format: string) => {
        asked.push(`choosePath(${suggestion},${format})`)
        return `C:/out/${suggestion}.${format}`
      },
      run: async (payload: any) => {
        asked.push(`run(${payload.settings.output},${payload.settings.format})`)
        return { ok: true, output: payload.settings.output, duration: 12, width: 1920, height: 1080, warnings: [] }
      },
      status: async () => ({ available: true, path: 'ffmpeg' }),
      cancel: async () => true,
      onProgress: () => () => undefined,
    },
    youtube: {
      status: async () => ({ connected: true, hasCredentials: true, channelTitle: 'My Channel', channelId: 'c1' }),
      setCredentials: async () => ({ connected: false, hasCredentials: true, channelTitle: '', channelId: '' }),
      connect: async () => ({ connected: true, hasCredentials: true, channelTitle: 'My Channel', channelId: 'c1' }),
      disconnect: async () => ({ connected: false, hasCredentials: true, channelTitle: '', channelId: '' }),
      publish: async (payload: any) => {
        asked.push(`publish(${payload.title},${payload.visibility})`)
        return { ok: true, videoId: 'abc123', url: 'https://youtu.be/abc123', visibility: payload.visibility, channelTitle: 'My Channel' }
      },
    },
  }

  const loaded = project({ clips: [clip('intro', 'video-1', 0, 12)] })
  const bridge = createHostBridge({
    getState: () => loaded,
    applyState: () => undefined,
    importDialog: async () => [],
    importPaths: async () => ({ items: [], failed: [] }),
    desktop: desktopStub as unknown as NonNullable<Window['aicut']>,
  })

  // --- The recipes, end to end -------------------------------------------
  // One instruction has to do the whole job: measure, cut to the best moment,
  // reframe vertical, and move it to the head of the timeline.
  function gameplayProject(): ProjectState {
    return project({
      media: [media('gameplay.mp4', 'video', 180)],
      clips: [{ ...clip('gameplay', 'video-1', 30, 180), mediaId: 'm-gameplay.mp4' }],
      selectedClipId: 'c-gameplay',
    })
  }

  let edited = gameplayProject()
  const recipes = createHostBridge({
    getState: () => edited,
    applyState: (next) => {
      edited = next
    },
    importDialog: async () => [],
    importPaths: async () => ({ items: [], failed: [] }),
    desktop: desktopStub as unknown as NonNullable<Window['aicut']>,
  })

  const short = await recipes.makeShort({})
  check('making a short measures the file', asked.includes('analysis(C:/clips/gameplay.mp4)'), true)
  check(
    'a short is cut around the loud stretch',
    (edited.clips[0].offset ?? 0) <= 100 && (edited.clips[0].offset ?? 0) + edited.clips[0].duration >= 120,
    true,
  )
  check('a short defaults to thirty seconds', edited.clips[0].duration, 30)
  check('a short is reframed vertical', Number((edited.clips[0].crop?.width ?? 1).toFixed(4)), 0.3164)
  check('a short moves to the head of the timeline', edited.clips[0].start, 0)
  check('the playhead follows it back to the start', edited.playhead, 0)
  check('the short reports the moment it cut around', short.summary.includes('loudest moment at 1:40'), true)
  check('the short says it will render vertical', short.summary.includes('1080×1920'), true)
  check('making a short is not reported as a failure', short.error, undefined)

  edited = gameplayProject()
  await recipes.makeShort({ duration: 15 })
  check('a requested length is honoured', edited.clips[0].duration, 15)

  edited = gameplayProject()
  await recipes.makeShort({ duration: 300 })
  check('a short is never longer than a minute', edited.clips[0].duration, 60)

  edited = gameplayProject()
  await recipes.makeShort({ reframe: false })
  check('the framing can be left alone', edited.clips[0].crop, undefined)

  // With nothing on the timeline, the clip is placed before it is cut.
  edited = project({ media: [media('gameplay.mp4', 'video', 180)] })
  const fromLibrary = await recipes.makeShort({})
  check('a short can be made straight from the library', edited.clips.length, 1)
  check('the placed clip is cut around the highlight', (edited.clips[0].offset ?? 0) >= 90, true)
  check('making a short from the library is not a failure', fromLibrary.error, undefined)

  edited = project()
  check('a short needs something to work on', (await recipes.makeShort({ clip: 'nothing' })).error !== undefined, true)

  edited = gameplayProject()
  const highlights = await recipes.findHighlight({ duration: 20, count: 2 })
  check('highlights are reported without editing', edited.clips[0].duration, 180)
  check('the loud stretch is reported first', highlights.summary.includes('1. 1:40–2:00'), true)
  check('a highlight report names the peak', highlights.summary.includes('loudest at'), true)

  edited = gameplayProject()
  const measured = await recipes.analyzeClip({})
  check('measuring reports the length', measured.summary.includes('180s'), true)
  check('measuring reports the silence', measured.summary.includes('2 silent stretches'), true)

  edited = gameplayProject()
  const tightenedClip = await recipes.removeSilence({})
  check('dead air is cut into separate pieces', edited.clips.length, 3)
  check('the pieces sit end to end from where the clip started', edited.clips.map((entry) => Math.round(entry.start)), [30, 50, 150])
  check('each piece keeps its own place in the file', edited.clips.map((entry) => Math.round(entry.offset ?? 0)), [0, 40, 160])
  check('the time cut is reported', tightenedClip.summary.includes('39.4s'), true)
  check('the pieces leave no gaps', edited.clips.every((entry, index) => index === 0 || Math.abs(entry.start - (edited.clips[index - 1].start + edited.clips[index - 1].duration)) < 0.001), true)

  const noAudio = createHostBridge({
    getState: () => edited,
    applyState: (next) => {
      edited = next
    },
    importDialog: async () => [],
    importPaths: async () => ({ items: [], failed: [] }),
    desktop: {
      ...desktopStub,
      analysis: {
        clip: async () => ({
          path: 'C:/clips/gameplay.mp4',
          hasAudio: false,
          duration: 180,
          loudness: [],
          silences: [],
          error: 'That file has no audio track to measure.',
        }),
      },
    } as unknown as NonNullable<Window['aicut']>,
  })

  edited = gameplayProject()
  const silent = await noAudio.makeShort({})
  check('a silent clip is still cut and reframed', edited.clips[0].duration, 30)
  check('a silent clip is cut from its head', edited.clips[0].offset, 0)
  check('the short admits it had no audio to judge by', silent.summary.includes('no audio'), true)
  check('cutting silence out of a silent clip is refused', (await noAudio.removeSilence({})).error !== undefined, true)
  const verticalShort = edited

  // --- Memes, punch-ins and montages, end to end -------------------------
  edited = project({
    media: [media('gameplay.mp4', 'video', 180), media('bruh.png', 'image', 0)],
    clips: [{ ...clip('gameplay', 'video-1', 0, 180), mediaId: 'm-gameplay.mp4' }],
    selectedClipId: 'c-gameplay',
    playhead: 40,
  })
  const meme = await recipes.insertCutaway({ file: 'bruh.png' })
  check('a meme lands on the timeline', edited.clips.length, 2)
  check('a meme lands at the playhead', edited.clips.find((entry) => entry.mediaId === 'm-bruh.png')?.start, 40)
  check('a still is held for a couple of seconds', edited.clips.find((entry) => entry.mediaId === 'm-bruh.png')?.duration, 2.5)
  check('a meme over a clip goes to a corner rather than hiding it', edited.clips.find((entry) => entry.mediaId === 'm-bruh.png')?.frame !== undefined, true)
  check('a meme goes on a lane of its own so it draws on top', edited.tracks[0].name, 'Memes & overlays')
  check('the insert says where it went', meme.summary.includes('bruh.png'), true)
  check('the insert is not reported as a failure', meme.error, undefined)

  edited = project({ media: [media('bruh.png', 'image', 0)] })
  const alone = await recipes.insertCutaway({ file: 'bruh.png' })
  check('a meme with nothing under it takes the whole frame', edited.clips[0].frame, undefined)
  check('a lone meme is not a failure', alone.error, undefined)

  edited = project({ media: [media('boom.mp3', 'audio', 3)], playhead: 12 })
  const boom = await recipes.insertCutaway({ file: 'boom.mp3' })
  check('a sound effect goes on an audio track', edited.clips[0].track.startsWith('audio'), true)
  check('a sound effect lands at the playhead', edited.clips[0].start, 12)
  check('a sound effect is not framed', edited.clips[0].frame, undefined)
  check('the sound effect is not a failure', boom.error, undefined)

  edited = project()
  check('an insert with nothing named asks for a name', (await recipes.insertCutaway({ file: '' })).error !== undefined, true)

  edited = gameplayProject()
  const punch = await recipes.punchIn({})
  check('a punch-in cuts the clip into pieces', edited.clips.length, 3)
  check('the middle piece is pushed in', isCropped(edited.clips[1].crop), true)
  check('a punch-in finds the loud moment on its own', punch.summary.includes('loudest moment at'), true)
  check('a punch-in reports how far it went', punch.summary.includes('×'), true)
  check('a punch-in is not a failure', punch.error, undefined)

  // The gameplay clip sits at 0:30 on the timeline, so 0:40 is ten seconds in.
  edited = gameplayProject()
  await recipes.punchIn({ at: '0:40', duration: 5, amount: 3 })
  check('a punch-in honours the moment asked for', Math.round(edited.clips[1].start), 40)
  check('a punch-in honours the length asked for', Math.round(edited.clips[1].duration), 5)
  check('a bigger punch-in crops harder', (edited.clips[1].crop?.width ?? 1) < 0.5, true)

  edited = gameplayProject()
  await recipes.punchIn({ at: '0:30', duration: 5 })
  check('a punch-in at the very start of a clip needs one cut', edited.clips.length, 2)
  check('a punch-in at the start pushes in on the head', isCropped(edited.clips[0].crop), true)

  edited = project({ media: [] })
  check('a punch-in needs something to work on', (await recipes.punchIn({})).error !== undefined, true)

  edited = project({
    media: [media('one.mp4', 'video', 180), media('two.mp4', 'video', 180), media('three.mp4', 'video', 180)],
  })
  const montage = await recipes.makeMontage({ each: 4 })
  check('a montage uses every clip imported', edited.clips.length, 3)
  check('the montage pieces are the length asked for', edited.clips.map((entry) => Math.round(entry.duration)), [4, 4, 4])
  check('the montage pieces sit end to end', edited.clips.map((entry) => Math.round(entry.start)), [0, 4, 8])
  check('each montage piece is cut from its own best moment', edited.clips.every((entry) => (entry.offset ?? 0) > 0), true)
  check('the montage reports what it used', montage.summary.includes('one.mp4'), true)
  check('the montage is not a failure', montage.error, undefined)

  edited = project({
    media: [media('one.mp4', 'video', 180), media('two.mp4', 'video', 180), media('three.mp4', 'video', 180)],
  })
  await recipes.makeMontage({ count: 2 })
  check('a clip count is honoured', edited.clips.length, 2)

  edited = project({
    media: [media('one.mp4', 'video', 180), media('two.mp4', 'video', 180), media('three.mp4', 'video', 180)],
  })
  await recipes.makeMontage({ duration: 15 })
  check('a total length is shared out between the clips', Math.round(edited.clips[0].duration), 5)

  edited = project({
    media: [media('one.mp4', 'video', 60), media('two.mp4', 'video', 60)],
    clips: [clip('old', 'video-1', 0, 30)],
  })
  await recipes.makeMontage({})
  check('a montage replaces what was on the track', edited.clips.some((entry) => entry.name === 'old'), false)

  edited = project({ media: [media('one.mp4', 'video', 60)] })
  check('a montage needs more than one clip', (await recipes.makeMontage({})).error !== undefined, true)
  edited = project({ media: [] })
  check('a montage needs something imported', (await recipes.makeMontage({})).error !== undefined, true)

  // Whether an upload counts as a Short.
  check('a vertical clip under a minute is a Short', looksLikeShort(verticalShort), true)
  check('a full-length landscape timeline is not', looksLikeShort(gameplayProject()), false)
  check('an empty timeline is not', looksLikeShort(project()), false)

  check('listing with no folder offers the usual places', (await bridge.listFolder(null)).summary.includes('Videos'), true)
  check('listing a folder asks the desktop for it', (await bridge.listFolder('C:/Users/me/Videos')).summary.includes('beach.mp4'), true)
  check('searching reaches the desktop', (await bridge.findMedia('beach', null)).summary.includes('beach.mp4'), true)

  const exported = await bridge.exportProject({})
  check('exporting picks a path when none is given', asked.includes('choosePath(intro,mp4)'), true)
  check('exporting reports the finished file', exported.summary.includes('C:/out/intro.mp4'), true)
  check('exporting reports the size', exported.summary.includes('1920×1080'), true)

  await bridge.exportProject({ output: 'C:/chosen.webm', format: 'webm' })
  check('a given path is used as-is', asked.includes('run(C:/chosen.webm,webm)'), true)

  const published = await bridge.publish({ title: 'Trip' })
  check('publishing defaults to private', asked.includes('publish(Trip,private)'), true)
  check('publishing reports the link', published.summary.includes('https://youtu.be/abc123'), true)

  const remembered = createHostBridge({
    getState: () => ({ ...loaded, memory: [note('always export as webm'), note('keep youtube uploads unlisted')] }),
    importDialog: async () => [],
    importPaths: async () => ({ items: [], failed: [] }),
    desktop: desktopStub as unknown as NonNullable<Window['aicut']>,
  })
  await remembered.exportProject({})
  check('a remembered format is used when none is asked for', asked.includes('choosePath(intro,webm)'), true)
  await remembered.publish({ title: 'Trip' })
  check('a remembered visibility is honoured', asked.includes('publish(Trip,unlisted)'), true)

  const emptyBridge = createHostBridge({
    getState: () => project(),
    importDialog: async () => [],
    importPaths: async () => ({ items: [], failed: [] }),
    desktop: desktopStub as unknown as NonNullable<Window['aicut']>,
  })
  check('exporting an empty timeline is refused', (await emptyBridge.exportProject({})).error !== undefined, true)
  check('publishing an empty timeline is refused', (await emptyBridge.publish({ title: 'x' })).error !== undefined, true)

  const disconnected = createHostBridge({
    getState: () => loaded,
    importDialog: async () => [],
    importPaths: async () => ({ items: [], failed: [] }),
    desktop: {
      ...desktopStub,
      youtube: {
        ...desktopStub.youtube,
        status: async () => ({ connected: false, hasCredentials: false, channelTitle: '', channelId: '' }),
      },
    } as unknown as NonNullable<Window['aicut']>,
  })
  check('publishing without a channel is refused', (await disconnected.publish({ title: 'x' })).error !== undefined, true)
  check('the refusal explains how to connect', (await disconnected.publish({ title: 'x' })).summary.includes('client id'), true)
  check('status reports a missing connection', (await disconnected.youtubeStatus()).summary.includes('not connected'), true)

  const browserOnly = createHostBridge({
    getState: () => loaded,
    importDialog: async () => [],
    importPaths: async () => ({ items: [], failed: [] }),
  })
  check('without the desktop app, file access is refused', (await browserOnly.listFolder('C:/')).error !== undefined, true)
  check('without the desktop app, export is refused', (await browserOnly.exportProject({})).error !== undefined, true)

  const importer = createHostBridge({
    getState: () => project(),
    importDialog: async () => [media('picked.mp4', 'video', 4)],
    importPaths: async (paths) => ({
      items: paths.filter((p) => p.endsWith('.mp4')).map((p) => media(p.split('/').pop() as string, 'video', 3)),
      failed: paths.filter((p) => !p.endsWith('.mp4')),
    }),
    desktop: desktopStub as unknown as NonNullable<Window['aicut']>,
  })
  // A card is rendered, imported and placed, and the reply says it was drawn.
  const drawn: string[] = []
  let generated = project()
  const drawer = createHostBridge({
    getState: () => generated,
    applyState: (next) => {
      generated = next
    },
    importDialog: async () => [],
    importPaths: async (paths) => {
      drawn.push(`import(${paths[0]})`)
      const item = media('fortnite-highlights-5s.mp4', 'video', 5)
      generated = { ...generated, media: [...generated.media, item] }
      return { items: [item], failed: [] }
    },
    desktop: {
      ...desktopStub,
      generate: {
        clip: async (request: { text?: string; seconds?: number; aspect?: number | string; look?: string }) => {
          drawn.push(`render(${request.text ?? ''},${request.seconds ?? 'default'},${String(request.aspect)})`)
          return {
            path: 'C:/generated/fortnite-highlights-5s.mp4',
            name: 'fortnite-highlights-5s.mp4',
            size: 90_000,
            duration: 5,
            width: 1920,
            height: 1080,
            lines: ['Fortnite', 'Highlights'],
          }
        },
      },
    } as unknown as NonNullable<Window['aicut']>,
  })

  const card = await drawer.generateClip({ text: 'Fortnite Highlights', seconds: 5 })
  check('a card is rendered before anything else', drawn[0], 'render(Fortnite Highlights,5,16:9)')
  check('the rendered file is imported', drawn[1], 'import(C:/generated/fortnite-highlights-5s.mp4)')
  check('the card lands on the timeline', generated.clips.length, 1)
  check('the card is as long as it was drawn', generated.clips[0].duration, 5)
  check('the reply says what it drew', card.summary.includes('Fortnite Highlights'), true)
  check('the reply admits it is a card, not footage', card.summary.includes('cannot invent'), true)
  check('drawing a card is not a failure', card.error, undefined)

  const failedDraw = createHostBridge({
    getState: () => project(),
    importDialog: async () => [],
    importPaths: async () => ({ items: [], failed: [] }),
    desktop: {
      ...desktopStub,
      generate: { clip: async () => ({ error: 'ffmpeg was not found' }) },
    } as unknown as NonNullable<Window['aicut']>,
  })
  check('a render that fails is reported', (await failedDraw.generateClip({ text: 'x' })).error !== undefined, true)
  check(
    'without the desktop app, drawing is refused',
    (await browserOnly.generateClip({ text: 'x' })).error !== undefined,
    true,
  )

  check('the picker result is reported', (await importer.importDialog()).summary.includes('picked.mp4'), true)
  check('imported paths are reported with durations', (await importer.importPaths(['C:/a.mp4'])).summary.includes('3s'), true)
  check('unreadable paths are called out', (await importer.importPaths(['C:/a.mp4', 'C:/missing.txt'])).summary.includes('missing.txt'), true)
  check('an import with nothing readable fails', (await importer.importPaths(['C:/nope.txt'])).error !== undefined, true)
}

// --- Plain-language commands for the new tools ---------------------------
const filed = project({ clips: [clip('intro', 'video-1', 0, 12)], selectedClipId: 'c-intro' })
const asked2 = (input: string) => interpretCommand(input, filed).calls

check('"find beach in my videos" searches', asked2('find beach in my videos')[0], { name: 'find_media', args: { query: 'beach', folder: 'videos' } })
check('"do i have any drone footage" searches', asked2('do i have any drone footage')[0].name, 'find_media')
check('"search for sunset" searches', asked2('search for sunset')[0].args.query, 'sunset')
check('"what is in my downloads folder" lists it', asked2('show me what is in my downloads folder')[0], { name: 'list_folder', args: { path: 'downloads' } })
check('"list C:\\clips" lists that path', asked2('list C:\\clips')[0].args.path, 'C:\\clips')
check('an absolute path is imported directly', asked2('import C:\\clips\\beach.mp4')[0], { name: 'import_file', args: { paths: ['C:\\clips\\beach.mp4'] } })
check('"export this" exports', asked2('export this')[0].name, 'export_project')
check('"export as 1080p mp4" carries the settings', asked2('export as 1080p mp4')[0].args, { format: 'mp4', resolution: '1080p' })
check('"render it vertical" carries the shape', asked2('render it vertical')[0].args.resolution, 'vertical')
check('"export to C:\\out\\final.mp4" carries the path', asked2('export to C:\\out\\final.mp4')[0].args.output, 'C:\\out\\final.mp4')
check('"publish to youtube" publishes', asked2('publish to youtube')[0].name, 'publish_youtube')
check('a publish title is picked up', asked2('upload to youtube titled Summer Trip')[0].args.title, 'Summer Trip')
check('a publish visibility is picked up', asked2('publish to youtube as public titled "Trip"')[0].args.visibility, 'public')
check('"is my youtube connected" checks status', asked2('is my youtube channel connected?')[0].name, 'youtube_status')
check('"remember that ..." is stored', asked2('remember that I always want 9:16')[0], { name: 'remember', args: { text: 'I always want 9:16' } })
check('"forget the 9:16 thing" drops it', asked2('forget the 9:16 thing')[0], { name: 'forget', args: { text: '9:16 thing' } })
check('"forget everything" clears memory', asked2('forget everything')[0].args.text, 'all')
check('"what do you remember" lists memory', asked2('what do you remember?')[0].name, 'list_memory')
check('placing a clip still wins over exporting', asked2('add intro to the timeline')[0].name, 'add_clip')

// --- Making something out of nothing --------------------------------------
check('"generate a title card" draws one', asked2('generate a title card')[0].name, 'generate_clip')
check(
  '"generate a 5 second intro that says Fortnite Highlights" carries the words',
  asked2('generate a 5 second intro that says Fortnite Highlights')[0].args,
  { text: 'Fortnite Highlights', seconds: 5 },
)
check('an end card is drawn too', asked2('create an end card saying "thanks for watching"')[0].args.text, 'thanks for watching')
check('a card about a subject uses it as the words', asked2('generate an intro about my fortnite stream')[0].args.text, 'Fortnite Stream')
check('a look is picked up', asked2('draw a light title card that says Hello')[0].args.look, 'light')
check('green reads as the accent look', asked2('generate a green card saying GG')[0].args.look, 'accent')
check('a vertical card is asked for by ratio', asked2('generate a 9:16 title card saying Go')[0].args.aspect, '9:16')
check('a blank background is still a card', asked2('generate a plain background for 3 seconds')[0].name, 'generate_clip')
check('a card is not confused with a new track', asked2('create another video track')[0].name, 'add_track')
check('naming the card does not write "card" on it', asked2('generate a title card')[0].args.text, undefined)
check('the words come from "says", not from "title"', asked2('generate a title card that says Fortnite')[0].args.text, 'Fortnite')

// Asking for a "video" about something is the same request as asking for an
// "intro" about it: the word should not decide whether anything happens.
check('"generate a video about fortnite" draws a card', asked2('generate a video about fortnite')[0].name, 'generate_clip')
check(
  'the subject becomes the words on it',
  asked2('can you generate a simple video about fortnite, just 5 seconds long')[0].args,
  { text: 'Fortnite', seconds: 5 },
)
check('"make me a 5 second intro" draws one too', asked2('make me a 5 second intro')[0], {
  name: 'generate_clip',
  args: { seconds: 5 },
})
check('their own recording is still hunted for, not drawn', asked2('generate a video of my gameplay').length, 0)
check('nothing is claimed as unsupported for footage', interpretCommand('generate a video of my gameplay', filed).unsupported, undefined)
check('"make the intro longer" is an edit, not a new card', asked2('make the intro longer')[0]?.name !== 'generate_clip', true)

const invented = converse('can you generate a simple video about fortnite, just 5 seconds long', {
  connected: true,
  clips: 0,
  media: 0,
})
check('asking for invented footage gets an honest answer', invented !== null, true)
check('the answer refuses to pretend', invented?.text.includes('cannot film'), true)
check('the answer offers the card instead', invented?.text.includes('generate a 5 second intro'), true)
check('the answer offers to find real footage', invented?.text.includes('find my fortnite clips'), true)
check(
  'text-to-video is answered the same way',
  converse('is there text to video in here?', { connected: true, clips: 0, media: 0 })?.topic,
  'invent',
)
check(
  'an instruction still reaches the interpreter first',
  interpretCommand('make this into a youtube short', filed).calls[0].name,
  'make_short',
)

// --- The conversation survives a restart ---------------------------------
const storedChat = normalizeTranscript({
  messages: [
    { id: 'a', role: 'user', text: 'make it vertical' },
    { id: 'b', role: 'assistant', text: 'Cropped it to 9:16.', actions: [{ name: 'crop_clip', summary: 'Cropped.', failed: false }] },
    { id: 'c', role: 'assistant', text: '', pending: true },
    { id: 'd', role: 'wizard', text: 'nope' },
  ],
  history: [
    { role: 'user', content: 'make it vertical' },
    { role: 'assistant', content: '', tool_calls: [{ id: 't1', type: 'function', function: { name: 'crop_clip', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 't1', content: 'Cropped.' },
  ],
})
check('a stored conversation comes back', storedChat.messages.length, 2)
check('the words come back', storedChat.messages[0].text, 'make it vertical')
check('what was done comes back with it', storedChat.messages[1].actions?.[0].name, 'crop_clip')
check('a reply left half-written is dropped', storedChat.messages.some((entry) => entry.text === ''), false)
check('a role that does not exist is dropped', storedChat.messages.some((entry) => entry.id === 'd'), false)
check('the model history comes back', storedChat.history.length, 3)
check('a tool result keeps the call it answers', storedChat.history[2].tool_call_id, 't1')
check('nothing stored reads as an empty conversation', normalizeTranscript(null).messages.length, 0)
check('garbage stored reads as an empty conversation', normalizeTranscript({ messages: 'no' }).history.length, 0)

const headless = normalizeTranscript({
  messages: [],
  history: [
    { role: 'tool', tool_call_id: 't9', content: 'orphaned' },
    { role: 'user', content: 'and then' },
  ],
})
check('a tool result with no call in front of it is dropped', headless.history.length, 1)
check('the turn that stands alone is kept', headless.history[0].role, 'user')

const written = forStorage(
  [
    { id: 'a', role: 'user', text: 'hello' },
    { id: 'b', role: 'assistant', text: '', pending: true },
  ],
  [{ role: 'user', content: 'hello' }],
)
check('an unfinished reply is not written out', written.messages.length, 1)
check('the pending flag is not written out', 'pending' in written.messages[0], false)
check(
  'a long conversation is trimmed to the tail',
  forStorage(
    Array.from({ length: TRANSCRIPT_LIMIT + 20 }, (_, index) => ({
      id: `m-${index}`,
      role: 'user' as const,
      text: `line ${index}`,
    })),
    [],
  ).messages.length,
  TRANSCRIPT_LIMIT,
)
check(
  'the model history is trimmed harder',
  forStorage([], Array.from({ length: HISTORY_LIMIT + 10 }, () => ({ role: 'user' as const, content: 'x' }))).history.length,
  HISTORY_LIMIT,
)

// --- Clearing the chat is a fresh page, not amnesia -----------------------
const wiped = forStorage(EMPTY_TRANSCRIPT.messages, EMPTY_TRANSCRIPT.history)
check('clearing leaves no messages behind', wiped.messages.length, 0)
check('clearing leaves no model history behind', wiped.history.length, 0)
check('a cleared conversation reads back empty', normalizeTranscript(wiped).messages.length, 0)

// What the assistant was taught lives in memory, which the transcript never
// held, so an emptied chat still opens the next turn knowing it.
const stillKnown = [note('always crop to 9:16'), note('my memes live in D:\\memes')]
check('what it was taught is not part of the transcript', 'memory' in wiped, false)
check('so a cleared chat still carries it', memoryPrompt(stillKnown).includes('always crop to 9:16'), true)
check('and still carries the rest of it', memoryPrompt(stillKnown).includes('D:\\memes'), true)

void hostChecks().then(() => {
  console.log(failures === 0 ? '\nRESULT: pass' : `\nRESULT: fail (${failures})`)
  if (failures > 0) process.exitCode = 1
})
