import { stripExtension } from '../types'
import { ASKING } from './converse'
import { learnFrom, learnedDefaults } from './memory'
import type { ProjectState, ToolCall } from './types'

export type Interpretation = {
  calls: ToolCall[]
  /** Set when the request is understood but the editor cannot do it yet. */
  unsupported?: string
}

const NOTHING: Interpretation = { calls: [] }

const RATIO_WORDS: Record<string, string> = {
  '16:9': '16:9',
  '9:16': '9:16',
  '4:5': '4:5',
  '4:3': '4:3',
  '3:4': '3:4',
  '1:1': '1:1',
  square: '1:1',
  vertical: '9:16',
  portrait: '9:16',
  tiktok: '9:16',
  reels: '9:16',
  shorts: '9:16',
  landscape: '16:9',
  widescreen: '16:9',
}

/**
 * Requests that are clearly about editing but that the editor cannot do yet.
 * Checked before anything else so, for example, "add captions to my video" is
 * not mistaken for placing a clip.
 */
const UNSUPPORTED: { pattern: RegExp; label: string }[] = [
  { pattern: /\bfade|\btransition|\bcrossfade\b/, label: 'fades and transitions' },
  { pattern: /\bsubtitle|\btranscri|\bauto.?caption/, label: 'automatic captions' },
  { pattern: /\bvolume\b|\bmute\b|\bgain\b|\bfade out\b/, label: 'volume control' },
  { pattern: /\bspeed\b|\bslow.?mo|\btime.?lapse\b/, label: 'speed changes' },
  { pattern: /\bcolor grade|\bgrading\b|\blut\b/, label: 'color grading' },
]

const CARD_NOUN =
  /\b(title card|end card|title screen|end screen|intro|outro|card|slate|background|placeholder|filler)\b/

const DRAW_VERB = /\b(generate|create|draw|design|render|produce|generating)\b/

/**
 * "make me a 5 second intro" asks for the same drawing as "generate" one, but
 * "make" belongs to shorts and montages too, so it only counts when the card is
 * introduced as a new one — "make the intro longer" is an edit, not a card.
 */
const DRAWS_A_CARD = new RegExp(
  `\\b(?:make|build|put together|whip up|give me)\\b[^.?!]*?\\b(?:a|an|another|new|me)\\b[^.?!]*?${CARD_NOUN.source}`,
  'i',
)

/** Their own recording, which has to be found on disk rather than drawn. */
const OWN_FOOTAGE =
  /\b(?:my|our)\s+(?:own\s+)?(?:gameplay|recording|footage|clips?|videos?|stream|match|game|session|vod)\b|\bi\s+(?:recorded|filmed|took|shot|captured)\b/i

function mediaMention(input: string, state: ProjectState): string | null {
  const lower = input.toLowerCase()

  // Longest name first, so "intro take 2" wins over "intro".
  const named = state.media
    .map((item) => ({ item, key: stripExtension(item.name).toLowerCase() }))
    .filter(({ key }) => key.length > 1)
    .sort((a, b) => b.key.length - a.key.length)
    .find(({ key }) => lower.includes(key))
  if (named) return named.item.name

  const quoted = /"([^"]+)"|'([^']+)'/.exec(input)
  if (quoted) return quoted[1] ?? quoted[2]

  const filename = /\b([\w-]+\.[a-z0-9]{2,4})\b/i.exec(input)
  if (filename) return filename[1]

  const kind = /\b(video|audio|music|song|sound|image|photo|picture|footage|clip)\b/.exec(lower)
  return kind ? kind[1] : null
}

function clipMention(input: string, state: ProjectState): string | null {
  const lower = input.toLowerCase()

  const named = state.clips
    .map((clip) => ({ clip, key: clip.name.toLowerCase() }))
    .filter(({ key }) => key.length > 1)
    .sort((a, b) => b.key.length - a.key.length)
    .find(({ key }) => lower.includes(key))
  if (named) return named.clip.name

  if (/\b(selected|highlighted|current|this one|this clip)\b/.test(lower)) return 'selected'
  if (/\b(last|latest|newest|the one i just)\b/.test(lower)) return 'last'
  if (/\bfirst\b/.test(lower)) return 'first'

  const quoted = /"([^"]+)"|'([^']+)'/.exec(input)
  if (quoted) return quoted[1] ?? quoted[2]

  return 'selected'
}

function trackMention(input: string): string | null {
  const match = /\b(video|audio)\s*(?:track\s*)?(\d+)?\b/i.exec(input)
  if (!match) return null
  return match[2] ? `${match[1].toLowerCase()} ${match[2]}` : match[1].toLowerCase()
}

function timeMention(input: string): string | null {
  const lower = input.toLowerCase()

  if (/\bplayhead|\bcursor\b/.test(lower)) return 'playhead'
  if (/\b(the )?end\b/.test(lower)) return 'end'
  if (/\b(the )?(start|beginning)\b/.test(lower)) return 'start'

  const stamp = /\b(\d{1,2}:\d{2}(?::\d{2})?)\b/.exec(lower)
  if (stamp) return stamp[1]

  const withUnit = /\b(\d+(?:\.\d+)?)\s*(?:s\b|sec|second)/.exec(lower)
  if (withUnit) return withUnit[1]

  const minutes = /\b(\d+(?:\.\d+)?)\s*(?:m\b|min|minute)/.exec(lower)
  if (minutes) return String(Number(minutes[1]) * 60)

  const after = /\b(?:at|to)\s+(\d+(?:\.\d+)?)\b/.exec(lower)
  return after ? after[1] : null
}

function durationMention(input: string): string | null {
  const lower = input.toLowerCase()

  const minutesAndSeconds = /\b(\d+)\s*(?:m|min|minutes?)\s*(\d+)\s*(?:s|sec|seconds?)?\b/.exec(lower)
  if (minutesAndSeconds) return String(Number(minutesAndSeconds[1]) * 60 + Number(minutesAndSeconds[2]))

  const minutes = /\b(\d+(?:\.\d+)?)\s*(?:m\b|min|minutes?)\b/.exec(lower)
  if (minutes) return String(Number(minutes[1]) * 60)

  const seconds = /\b(\d+(?:\.\d+)?)\s*(?:s\b|sec|seconds?)\b/.exec(lower)
  if (seconds) return seconds[1]

  const stamp = /\b(\d{1,2}:\d{2})\b/.exec(lower)
  if (stamp) return stamp[1]

  const bare = /\b(\d+(?:\.\d+)?)\b/.exec(lower)
  return bare ? bare[1] : null
}

/** "make a 45 second short" and "make this a short" both have to work. */
export function shortLength(input: string): number | null {
  const lower = input.toLowerCase()

  const stamp = /\b(\d{1,2}):([0-5]\d)\b/.exec(lower)
  if (stamp) return Number(stamp[1]) * 60 + Number(stamp[2])

  const seconds = /\b(\d+(?:\.\d+)?)\s*(?:s\b|sec|seconds?)/.exec(lower)
  if (seconds) return Number(seconds[1])

  const minutes = /\b(\d+(?:\.\d+)?)\s*(?:m\b|min|minutes?)/.exec(lower)
  if (minutes) return Number(minutes[1]) * 60

  return null
}

/** A source range, from phrasings like "keep 1:10 to 1:40" or "use 12s-30s". */
export function rangeMention(input: string): { from: string; to: string } | null {
  const lower = input.toLowerCase()

  const both =
    /\b(\d{1,2}:\d{2}|\d+(?:\.\d+)?)\s*(?:s|sec|seconds?)?\s*(?:to|until|till|through|-|–|and)\s*(\d{1,2}:\d{2}|\d+(?:\.\d+)?)\s*(?:s|sec|seconds?)?/.exec(
      lower,
    )
  if (both) return { from: both[1], to: both[2] }

  const fromTo = /\bfrom\s+(\d{1,2}:\d{2}|\d+(?:\.\d+)?)\b[^\d]*?\b(\d{1,2}:\d{2}|\d+(?:\.\d+)?)\b/.exec(lower)
  if (fromTo) return { from: fromTo[1], to: fromTo[2] }

  return null
}

/** "for 3 seconds" and nothing else; a bare number is not a length here. */
function heldFor(input: string): number | null {
  const match = /\bfor\s+(\d+(?:\.\d+)?)\s*(?:s\b|sec|seconds?)/i.exec(input)
  return match ? Number(match[1]) : null
}

/** "an intro about my fortnite stream" leaves "Fortnite Stream" to draw. */
function cleanSubject(text: string): string | null {
  const words = text
    .replace(/[.!?]+$/, '')
    .replace(/\b(?:just|please|thanks)\b/gi, '')
    .replace(/\b\d+(?:\.\d+)?\s*(?:s|sec|seconds?|m|min|minutes?)\b.*$/i, '')
    .replace(/^\s*(?:my|the|a|an|some)\s+/i, '')
    .replace(/[\s,;:]+$/, '')
    .trim()

  if (!words) return null

  const short = words.split(/\s+/).slice(0, 6).join(' ')
  return short.replace(/\b[a-z]/g, (letter) => letter.toUpperCase())
}

/** The words that should appear on screen, from however the user phrased it. */
export function textPhrase(input: string): string | null {
  const quoted = /"([^"]{1,200})"|“([^”]{1,200})”/.exec(input)
  if (quoted) return (quoted[1] ?? quoted[2]).trim() || null

  // In "a title card that says Hello" the words follow "says", not "title", so
  // the phrasings that introduce speech are tried before the bare nouns.
  const said =
    /\b(?:saying|that says|says|reading|that reads)\b\s*[:\-]?\s*(.+)$/i.exec(input.trim()) ??
    /\b(?:text|title|caption|hook|label)\b\s*[:\-]?\s*(.+)$/i.exec(input.trim())
  if (!said) return null

  // Trailing instructions about when and how long are not part of the words,
  // and neither is the word that introduced them.
  const cleaned = said[1]
    .replace(/^(?:saying|says|that says|reads|reading|is|that|of|:)\s+/i, '')
    .replace(/\s+for\s+\d+(?:\.\d+)?\s*(?:s|sec|seconds?)\b.*$/i, '')
    .replace(/\s+at\s+(?:the\s+)?(?:start|beginning|end|playhead|top|middle|bottom|\d[\d:.]*\s*s?)\b.*$/i, '')
    .replace(/\s+(?:in|as)\s+(?:the\s+)?(?:meme|title|caption)\s+style\b.*$/i, '')
    .replace(/\s+(?:at|across|along)\s+the\s+(?:top|middle|bottom)\b.*$/i, '')
    // "generate a title card" names the thing, it does not spell out any words.
    .replace(/^(?:card|screen|slate|background)\b\s*/i, '')
    .replace(/^["']|["'.!]+$/g, '')
    .trim()

  return cleaned.length > 0 ? cleaned : null
}

/** What kind of thing is being dropped in, and what it is called. */
export function cutawayMention(input: string): string | null {
  const quoted = /"([^"]{1,80})"|'([^']{2,80})'/.exec(input)
  if (quoted) return (quoted[1] ?? quoted[2]).trim() || null

  const file = /\b([\w-]+\.[a-z0-9]{2,4})\b/i.exec(input)
  if (file) return file[1]

  // "the bruh meme", "a vine boom sound effect"
  const before =
    /\b(?:the|a|an|my)\s+([\w' -]{2,40}?)\s+(?:meme|gif|sound(?:\s+effect)?|sfx|effect|reaction|clip|image)\b/i.exec(
      input,
    )
  if (before) return before[1].trim()

  // "a meme of a cat", "sound effect called vine boom"
  const after =
    /\b(?:meme|gif|sound(?:\s+effect)?|sfx|reaction|image)\s+(?:of|called|named|for)\s+(?:the\s+|a\s+)?([\w' -]{2,40})/i.exec(
      input,
    )
  return after ? after[1].trim() : null
}

/** Phrasings that plainly mean "go and read the internet", not "search my disk". */
const RESEARCH =
  /\b(?:search|look)\s+(?:the\s+)?(?:web|internet|online)\b|\bsearch online\b|\bgoogle\b|\blook (?:it )?up\b|\bresearch\b|\bread up on\b|\bfind out\b|\blatest news\b|\bwhat(?:'s| is) (?:the )?(?:latest|new)\b/

/** Asking to be pointed at something to watch, rather than to be given a file. */
const REFERENCE =
  /\b(?:reference|examples?|inspiration|inspo|tutorial|walkthrough|how others?|other creators?|similar videos?)\b/

/**
 * Verbs that mean "go and get me one". "add" and "put" are deliberately absent:
 * "add the bruh meme at 0:12" is about a file they already keep somewhere, and
 * that still belongs to the disk unless the internet is named outright.
 */
const FETCH_VERB = /\b(?:find|get|grab|download|fetch|search|source|pull|show me|give me|bring me)\b/

const ONLINE_WORDS = /\b(?:online|internet|the web|off the web|web)\b/

const YOUTUBE = /\byou\s?tube\b|\byt\b/

const YOUTUBE_LINK = /https?:\/\/(?:www\.|m\.|music\.)?(?:youtube\.com|youtu\.be)\/\S+/i

/** Verbs that mean the file itself, not a link to it. */
const DOWNLOAD_VERB = /\b(?:download|rip|save)\b/

const MEDIA_PANEL = /\bmedia\s+(?:section|panel|library|bin|list)\b/

const WEB_STOP = new Set([
  'me', 'us', 'a', 'an', 'the', 'some', 'any', 'few', 'my', 'please', 'thanks',
  'meme', 'memes', 'gif', 'gifs', 'sticker', 'stickers', 'reaction', 'image', 'images',
  'picture', 'pictures', 'photo', 'photos', 'wallpaper', 'video', 'videos', 'footage',
  'clip', 'clips', 'sound', 'sounds', 'effect', 'effects', 'sfx', 'music', 'song', 'audio',
  'stock', 'broll', 'online', 'internet', 'web', 'youtube', 'yt', 'good', 'nice', 'cool', 'funny',
  'and', 'of', 'for', 'about', 'to', 'into', 'section', 'panel', 'library',
  'options', 'choices', 'list', 'browse', 'see', 'there', 'something', 'anything',
  // Pointing at what is already open is not a subject to search for: "the best
  // part of this clip" is an edit, and leaving nothing behind here is what
  // stops it being read as one.
  'this', 'that', 'these', 'those', 'it', 'its', 'one', 'ones', 'here', 'mine', 'ours',
])

/** Which library to search, read off whatever noun the request used. */
export function onlineKind(input: string): 'image' | 'video' | 'gif' | 'audio' | 'meme' | null {
  const lower = input.toLowerCase()

  if (/\bgifs?\b/.test(lower)) return 'gif'
  if (/\b(?:meme|memes|reaction|sticker)\b/.test(lower)) return 'meme'
  if (/\b(?:sound|sounds|sfx|sound effects?|music|song|audio|track|jingle)\b/.test(lower)) return 'audio'
  if (/\b(?:footage|b.?roll|video|videos|clip|clips|movie)\b/.test(lower)) return 'video'
  if (/\b(?:image|images|picture|pictures|photo|photos|wallpaper|background|art|logo|icon)\b/.test(lower)) {
    return 'image'
  }

  return null
}

const ORDINALS: Record<string, number> = {
  first: 1, '1st': 1, one: 1,
  second: 2, '2nd': 2, two: 2,
  third: 3, '3rd': 3, three: 3,
  fourth: 4, '4th': 4, four: 4,
  fifth: 5, '5th': 5, five: 5,
}

/** Which of something already listed is meant: "the second one", "number 3". */
export function listChoice(input: string): number | null {
  const lower = input.toLowerCase()

  const named = /\b(first|second|third|fourth|fifth|1st|2nd|3rd|4th|5th|one|two|three|four|five)\s+(?:one|video|link|result|option)\b/.exec(
    lower,
  )
  if (named) return ORDINALS[named[1]] ?? null

  const numbered = /\b(?:number|no\.?|#)\s*([1-9])\b/.exec(lower)
  if (numbered) return Number(numbered[1])

  const bare = /\b(first|second|third|fourth|fifth)\b/.exec(lower)
  return bare ? (ORDINALS[bare[1]] ?? null) : null
}

/** What a web request is actually about, once the asking has been stripped off. */
export function webSubject(input: string): string | null {
  const quoted = /"([^"]+)"|'([^']+)'/.exec(input)
  if (quoted) return (quoted[1] ?? quoted[2]).trim() || null

  const about = /\b(?:of|about|showing|featuring|involving|with)\s+(.+)$/i.exec(input.trim())
  const asked =
    /\b(?:find|get|grab|download|fetch|search for|search|look up|look for|google|research|read up on|show me|give me|bring me|need|want|add|put)\b\s*(.+)$/i.exec(
      input.trim(),
    )

  const tail = about?.[1] ?? asked?.[1]
  if (!tail) return null

  const cleaned = tail
    .replace(
      /\b(?:on|from|in|off|to|into)\s+(?:the\s+|my\s+)?(?:internet|web|google|online|you\s?tube|yt|media\s+\w+)\b/gi,
      ' ',
    )
    // Where it goes and how long it lasts are instructions, not part of the search.
    .replace(/\s+\b(?:at|around|near)\s+(?:the\s+)?(?:start|end|beginning|playhead|\d[\d:.]*\s*(?:s|sec|seconds?)?)\b.*$/i, '')
    .replace(/\s+\bfor\s+\d+(?:\.\d+)?\s*(?:s|sec|seconds?)\b.*$/i, '')
    .replace(/[?.!]+$/, '')
    .trim()

  const words = cleaned.split(/\s+/).filter((word) => word.length > 0 && !WEB_STOP.has(word.toLowerCase()))
  const term = words.join(' ').trim()

  return term.length > 1 ? term : null
}

function ratioMention(input: string): string | null {
  const lower = input.toLowerCase()
  const key = Object.keys(RATIO_WORDS).find((word) => lower.includes(word))
  return key ? RATIO_WORDS[key] : null
}

const FOLDER_WORDS = [
  'videos', 'downloads', 'desktop', 'music', 'pictures', 'movies', 'documents', 'docs',
  'photos', 'images', 'home', 'onedrive',
]

const STOP_WORDS = new Set([
  'my', 'a', 'an', 'the', 'any', 'some', 'file', 'files', 'video', 'videos', 'clip', 'clips',
  'footage', 'audio', 'music', 'song', 'songs', 'image', 'images', 'photo', 'photos', 'called',
  'named', 'for', 'on', 'in', 'from', 'computer', 'pc', 'disk', 'drive', 'anywhere', 'somewhere',
  'please', 'me', 'folder', 'directory', 'documents', 'docs', 'downloads', 'desktop', 'pictures',
  'is', 'there', 'it', 'that', 'inside', 'within', 'saved', 'stored', 'sitting', 'and', 'of',
  'anything', 'something', 'everything', 'media', 'my',
])

/** An absolute path with a file extension, on Windows or a POSIX system. */
export function filePathMention(input: string): string | null {
  const quoted = /["']([a-z]:[\\/][^"']+\.[a-z0-9]{2,4}|\/[^"']+\.[a-z0-9]{2,4})["']/i.exec(input)
  if (quoted) return quoted[1]

  const windows = /([a-z]:[\\/][^\s"'<>|?*]*\.[a-z0-9]{2,4})/i.exec(input)
  if (windows) return windows[1]

  const posix = /(\/[^\s"'<>|?*]*\.[a-z0-9]{2,4})/.exec(input)
  return posix ? posix[1] : null
}

/** Either an absolute folder path or a well-known folder name. */
export function folderMention(input: string): string | null {
  const quoted = /["']([a-z]:[\\/][^"']*|\/[^"']+)["']/i.exec(input)
  if (quoted && !/\.[a-z0-9]{2,4}$/i.test(quoted[1])) return quoted[1]

  const windows = /([a-z]:[\\/][^\s"'<>|?*]*)/i.exec(input)
  if (windows && !/\.[a-z0-9]{2,4}$/i.test(windows[1])) return windows[1]

  const lower = input.toLowerCase()
  const word = FOLDER_WORDS.find((candidate) => new RegExp(`\\b${candidate}\\b`).test(lower))
  return word ?? null
}

/** What to search for, once the phrasing and folder hints are stripped off. */
export function searchTerm(input: string): string | null {
  const quoted = /"([^"]+)"|'([^']+)'/.exec(input)
  if (quoted) return quoted[1] ?? quoted[2]

  const after = /\b(?:find|search for|search|look for|locate|where is|do i have|is there)\b\s*(.+)$/i.exec(input.trim())
  if (!after) return null

  // The folder hint is stripped wherever it appears, so "find the raid clip in
  // my documents folder" searches for "raid" rather than for "documents folder".
  const trimmed = after[1]
    .replace(
      /\b(?:in|inside|under|on|within|from)\b\s+(?:my\s+|the\s+)?(?:[a-z]:[\\/][^\s]*|(?:[\w-]+\s+){0,2}folder|videos|downloads|desktop|music|pictures|documents|docs|onedrive)\b/gi,
      ' ',
    )
    .replace(/[?.!]+$/, '')
    .trim()

  const words = trimmed
    .split(/\s+/)
    .filter((word) => word.length > 0 && !STOP_WORDS.has(word.toLowerCase()))

  const term = words.join(' ').trim()
  return term.length > 1 ? term : null
}

export function exportArgs(input: string): Record<string, unknown> {
  const args: Record<string, unknown> = {}
  const lower = input.toLowerCase()

  const format = ['mp4', 'webm', 'mov'].find((candidate) => new RegExp(`\\b${candidate}\\b`).test(lower))
  if (format) args.format = format

  const size = /\b(\d{3,4}\s*[x×]\s*\d{3,4}|2160p|1440p|1080p|720p|480p|4k)\b/.exec(lower)
  if (size) {
    args.resolution = size[1].replace(/\s+/g, '')
  } else {
    const shape = ['vertical', 'portrait', 'square', 'landscape', 'shorts', 'tiktok', 'reels'].find((word) =>
      lower.includes(word),
    )
    if (shape) args.resolution = shape
  }

  const output = filePathMention(input)
  if (output) args.output = output

  return args
}

export function publishArgs(input: string): Record<string, unknown> {
  const args: Record<string, unknown> = {}
  const lower = input.toLowerCase()

  const quoted = /"([^"]+)"|'([^']+)'/.exec(input)
  const titled = /\b(?:titled|called|named|title)\b[:\s]+(.+?)(?:\s*[,.]|$)/i.exec(input)
  const title = quoted ? (quoted[1] ?? quoted[2]) : titled ? titled[1].trim() : null
  if (title) args.title = title

  const visibility = ['private', 'unlisted', 'public'].find((word) => lower.includes(word))
  if (visibility) args.visibility = visibility

  const description = /\bdescription\b[:\s]+(.+)$/i.exec(input)
  if (description) args.description = description[1].trim()

  const tags = /\btags?\b[:\s]+(.+)$/i.exec(input)
  if (tags) args.tags = tags[1].trim()

  return args
}

/** The remainder of a sentence after a keyword, used for "forget <thing>". */
function subjectAfter(input: string, keyword: RegExp): string | null {
  const index = input.search(keyword)
  if (index < 0) return null

  const rest = input
    .slice(index)
    .replace(keyword, '')
    .replace(/^\s*(?:that|about|the|my)\s+/i, '')
    .replace(/[.!?]+$/, '')
    .trim()

  return rest.length > 1 ? rest : null
}

function newName(input: string): string | null {
  const quoted = /"([^"]+)"|'([^']+)'/.exec(input)
  if (quoted) return quoted[1] ?? quoted[2]

  const toWord = /\b(?:to|as|called|named)\s+(.+)$/i.exec(input.trim())
  return toWord ? toWord[1].replace(/[.!?]+$/, '').trim() || null : null
}

/**
 * Turns a plain instruction into tool calls without a model, so the assistant
 * still works before an API key is configured. Deliberately narrow: it only
 * fires on clear phrasings and otherwise reports that it did not understand.
 */
export function interpretCommand(input: string, state: ProjectState): Interpretation {
  const raw = input.trim()
  if (!raw) return NOTHING
  const lower = raw.toLowerCase()

  const asks = (pattern: RegExp) => pattern.test(lower)
  const call = (name: ToolCall['name'], args: Record<string, unknown> = {}): Interpretation => ({
    calls: [{ name, args }],
  })

  const blocked = UNSUPPORTED.find(({ pattern }) => pattern.test(lower))
  if (blocked) return { calls: [], unsupported: blocked.label }

  // "How do I make a short" is a question about the editor, not an instruction to
  // cut one. Questions go back unhandled so the conversation can answer them.
  if (ASKING.test(raw)) return NOTHING

  // Teaching the assistant something durable.
  if (asks(/\bforget\b/)) {
    const target = asks(/\b(everything|all|it all)\b/) ? 'all' : (newName(raw) ?? subjectAfter(raw, /\bforget\b/))
    if (target) return call('forget', { text: target })
  }

  if (asks(/\bwhat (do|have) you (remember|learn|know)|\byour (memory|notes)\b|\bwhat did i tell you\b/)) {
    return call('list_memory')
  }

  const learned = learnFrom(raw)
  if (learned) return call('remember', { text: learned })

  // The internet, before anything that would send the same words to the disk.
  // "find me a meme about losing" is a download, not a hunt through Documents.

  if (asks(RESEARCH) && !asks(/\bmy (?:files|folder|computer|pc|drive|documents|videos)\b/)) {
    return call('search_web', { query: webSubject(raw) ?? raw.replace(/[?.!]+$/, '') })
  }

  if (asks(REFERENCE) || (asks(/\b(?:link|links)\b/) && asks(/\bvideos?\b/))) {
    const subject = webSubject(raw)
    if (subject) return call('find_reference_video', { query: subject })
  }

  // A pasted link is the whole request: there is nothing to search for and no
  // other reading of it.
  const pasted = YOUTUBE_LINK.exec(raw)
  if (pasted) return call('download_video', { url: pasted[0] })

  // "download the second one", answering a list handed over a moment ago. Which
  // list that was is the bridge's to remember.
  if (asks(DOWNLOAD_VERB)) {
    const which = listChoice(raw)
    if (which) return call('download_video', { choice: which })
  }

  // YouTube named outright means the file from there, not a rummage through
  // libraries that were never going to hold it.
  if (asks(YOUTUBE) && (asks(DOWNLOAD_VERB) || asks(FETCH_VERB))) {
    const subject = webSubject(raw)
    if (subject) return call('download_video', { query: subject })
  }

  const wantsOnline = onlineKind(raw)
  // Anything pointing at their own machine keeps this on the disk.
  const theirOwn = asks(/\bmy\b/) || folderMention(raw) !== null || filePathMention(raw) !== null
  if (
    wantsOnline &&
    !asks(CARD_NOUN) &&
    !OWN_FOOTAGE.test(raw) &&
    (asks(ONLINE_WORDS) || asks(MEDIA_PANEL) || (asks(FETCH_VERB) && !theirOwn))
  ) {
    const subject = webSubject(raw)
    // A bare "add the meme" means one they already have; only a subject to
    // search for makes this a download.
    if (subject) {
      // Listing without taking is what "show me some options" asks for.
      const browsing = asks(/\b(?:options|choices|what(?:'s| is) (?:out )?there|list|browse|see what)\b/)
      return call(browsing ? 'find_online_media' : 'add_online_media', { query: subject, kind: wantsOnline })
    }
  }

  // Making something out of nothing. A card is the only thing that can be drawn,
  // so asking for "a video about fortnite" draws one about Fortnite rather than
  // stalling over the noun — it is the reply that says it is a card, not footage.
  if (asks(DRAW_VERB) || DRAWS_A_CARD.test(raw)) {
    // "create another video track" is a track, not a thing to draw.
    const wantsClip =
      asks(/\b(video|clip|footage|scene|animation|movie)\b/) && !asks(/\b(track|lane|tracks)\b/)

    if (asks(CARD_NOUN) || wantsClip) {
      const subject = /\b(?:of|about|showing|featuring)\s+(.+)$/i.exec(raw)

      // "a clip of my gameplay" means the recording they already have, so that
      // goes back unhandled and the answer can offer to hunt for it instead.
      if (!asks(CARD_NOUN) && subject && OWN_FOOTAGE.test(subject[1])) return NOTHING

      const words = textPhrase(raw) ?? (subject ? cleanSubject(subject[1]) : null)

      const look = /\b(dark|light|green|accent)\b/i.exec(raw)?.[1].toLowerCase()
      const length = heldFor(raw) ?? shortLength(raw)
      const ratio = ratioMention(raw)
      // "a 5 second intro" is a length, not a position, so only an explicit
      // "at …" decides where it goes.
      const at = /\bat\b/i.test(raw) ? timeMention(raw) : null

      return call('generate_clip', {
        ...(words ? { text: words } : {}),
        ...(length ? { seconds: length } : {}),
        ...(ratio ? { aspect: ratio } : {}),
        ...(look ? { look: look === 'green' ? 'accent' : look } : {}),
        ...(at ? { at } : {}),
      })
    }
  }

  // Text on screen, before anything that could read "add" as placing a clip.
  const textWord = /\b(text|title|titles|caption|captions|hook|words|label|subtitle)\b/
  if (asks(textWord) || asks(/\b(?:that )?says\b/)) {
    if (asks(/\b(remove|delete|drop|get rid of|clear|take off|no more)\b/)) {
      return call('remove_text', { text: textPhrase(raw) ?? 'all' })
    }

    if (asks(/\b(add|put|write|overlay|show|stick|slap|type|say|says|include|need|want)\b/)) {
      const words = textPhrase(raw)

      // Writing out captions for spoken words means transcribing, which is a
      // different job from putting a line on screen.
      if (!words && asks(/\b(caption|captions|subtitle|subtitles)\b/)) {
        return { calls: [], unsupported: 'captions written from speech' }
      }
      // Without any words there is nothing to draw; the tool says so better
      // than a flat "I did not understand".
      if (!words) return call('add_text', { text: '' })

      const style = asks(/\bmeme\b/)
        ? 'meme'
        : asks(/\b(caption|subtitle|lower third|bottom)\b/)
          ? 'caption'
          : 'title'
      const position = asks(/\btop\b/)
        ? 'top'
        : asks(/\bbottom\b/)
          ? 'bottom'
          : asks(/\b(middle|center|centre)\b/)
            ? 'middle'
            : undefined
      const at = timeMention(raw)
      const seconds = heldFor(raw)

      return call('add_text', {
        text: words,
        style,
        ...(position ? { position } : {}),
        ...(at ? { at } : {}),
        ...(seconds ? { duration: seconds } : {}),
      })
    }
  }

  // Memes, reactions and sound effects dropped in over the footage.
  const cutawayWord = /\b(meme|memes|reaction|gif|sound effect|sound effects|sfx|cutaway|cut away|emote|jumpscare)\b/
  if (asks(cutawayWord) && asks(/\b(add|put|insert|drop|throw|slap|stick|place|bring|use|need|want|show)\b/)) {
    const at = timeMention(raw)
    const seconds = heldFor(raw)
    const placement = /\b(top|bottom)[ -](left|right)\b|\b(corner|full screen|fullscreen|full frame|middle|center|centre)\b/i.exec(
      raw,
    )

    return call('insert_cutaway', {
      ...(cutawayMention(raw) ? { file: cutawayMention(raw) } : {}),
      ...(at ? { at } : {}),
      ...(seconds ? { duration: seconds } : {}),
      ...(placement ? { placement: placement[0].toLowerCase().replace(/\s+/g, '-') } : {}),
    })
  }

  // A montage before shorts, since "highlight reel" reads as both.
  if (
    asks(/\bmontage\b/) ||
    asks(/\bhighlight (reel|video)\b/) ||
    (asks(/\b(all|every|my)\b.*\bclips\b/) && asks(/\b(together|montage|one video|back to back|string)\b/))
  ) {
    const total = shortLength(raw)
    const each = /\b(\d+(?:\.\d+)?)\s*(?:s|sec|seconds?)\s*(?:each|from each|per clip|of each)\b/i.exec(raw)
    const count = /\b(\d+)\s*clips?\b/i.exec(raw)

    return call('make_montage', {
      ...(each ? { each: Number(each[1]) } : total ? { duration: total } : {}),
      ...(count ? { count: Number(count[1]) } : {}),
    })
  }

  // Pushing the picture in, which is a different thing from timeline zoom.
  if (asks(/\bpunch in\b|\bpunch it in\b/) || (asks(/\bzoom\b/) && asks(/\bon\b/) && !asks(/\btimeline\b/))) {
    const at = timeMention(raw)
    const amount = /\b(\d+(?:\.\d+)?)\s*(?:x|times)\b/i.exec(raw)
    const seconds = heldFor(raw)

    return call('punch_in', {
      clip: clipMention(raw, state),
      ...(at ? { at } : {}),
      ...(seconds ? { duration: seconds } : {}),
      ...(amount ? { amount: Number(amount[1]) } : {}),
    })
  }

  // Putting a clip in a corner of the frame.
  if (
    asks(/\b(corner|picture in picture|picture-in-picture|pip|inset|overlay it|small)\b/) &&
    asks(/\b(put|place|move|make|show|shrink|set)\b/) &&
    !asks(cutawayWord)
  ) {
    const spot = /\b(top|bottom)[ -](left|right)\b|\b(middle|center|centre|full screen|fullscreen|full frame)\b/i.exec(raw)
    return call('place_clip', {
      clip: clipMention(raw, state),
      placement: spot ? spot[0].toLowerCase().replace(/\s+/g, '-') : 'top-right',
    })
  }

  // Goal-level requests first: one call that does the whole job beats a pile of
  // small edits, and this is how most people actually ask.
  const shortWord = /\b(short|shorts|tiktok|tik tok|reel|reels)\b/
  const makeVerb = /\b(make|turn|convert|cut|edit|create|give me|do)\b/

  // The short has to be the thing being made, so "make it vertical for tiktok"
  // stays a reframe rather than a whole recut.
  const shortGoal =
    asks(/\b(?:into|to|as)\s+(?:a|an|my)?\s*(?:[\w:.]+\s+){0,3}?(short|shorts|tiktok|tik tok|reel|reels)\b/) ||
    asks(/\b(?:make|turn|convert|create|cut|edit|give me)\s+(?:me\s+)?(?:this|it|that|a|an|the)\s+(?:[\w:.]+\s+){0,3}?(short|shorts|tiktok|tik tok|reel|reels)\b/)

  if (shortGoal && !asks(/\b(publish|upload|post|export|render|save)\b/)) {
    const length = shortLength(raw)
    return call('make_short', {
      ...(clipMention(raw, state) ? { clip: clipMention(raw, state) } : {}),
      ...(length ? { duration: length } : {}),
    })
  }

  if (asks(/\b(best|highlight|highlights|good part|best part|exciting|action|interesting)\b/)) {
    if (asks(/\b(find|show|where|which|what|tell me|any)\b/)) {
      return call('find_highlight', {
        clip: clipMention(raw, state),
        ...(shortLength(raw) ? { duration: shortLength(raw) } : {}),
      })
    }
    // "cut this down to the best bit" is a short in everything but name.
    if (asks(makeVerb)) {
      return call('make_short', {
        clip: clipMention(raw, state),
        ...(shortLength(raw) ? { duration: shortLength(raw) } : {}),
        ...(asks(shortWord) || asks(/\bvertical\b/) ? {} : { reframe: false }),
      })
    }
  }

  if (
    asks(/\b(silence|silent|dead air|dead space|quiet parts?|boring parts?|filler|pauses?|gaps?)\b/) &&
    asks(/\b(cut|remove|delete|drop|trim|strip|clean|tighten|get rid of|take out)\b/)
  ) {
    return call('remove_silence', { clip: clipMention(raw, state) })
  }

  if (asks(/\b(analy[sz]e|measure|how loud|loudness|audio levels?|listen to)\b/)) {
    return call('analyze_clip', { clip: clipMention(raw, state) })
  }

  // Publishing and exporting, before the generic verbs below.
  if (asks(/\b(publish|upload|post)\b/) && asks(/\b(youtube|channel|yt|short|shorts)\b/)) {
    return call('publish_youtube', {
      ...publishArgs(raw),
      ...(asks(shortWord) ? { short: true } : {}),
    })
  }

  if (asks(/\b(youtube|channel)\b/) && asks(/\b(connected|linked|status|which|am i)\b/)) {
    return call('youtube_status')
  }

  if (asks(/\b(export|render|save (it|this|the (video|project|file))|make (me )?(a|an) (mp4|video file)|output)\b/)) {
    return call('export_project', exportArgs(raw))
  }

  // Looking around the computer, checked before questions about the project so
  // "show me my downloads folder" is not read as "describe the project".
  const aboutProject = asks(/\b(project|timeline|sequence)\b/)
  const folder = folderMention(raw)

  if (!aboutProject && asks(/\b(find|search|look for|locate|where is|do i have|is there)\b/)) {
    const query = searchTerm(raw)
    // With a folder named but nothing specific to match, everything playable in
    // that folder is the useful answer.
    if (query || folder) return call('find_media', { query: query ?? '', ...(folder ? { folder } : {}) })
  }

  if (
    !aboutProject &&
    asks(/\b(?:list|show|open|browse|look in|see|what(?:'s|s| is| are)? in)\b/) &&
    (folder || asks(/\bfolder\b/))
  ) {
    return call('list_folder', folder ? { path: folder } : {})
  }

  // Questions about the project — which means the project has to be in them.
  // "What can you do" and "tell me a joke" are conversation, not a summary.
  if (
    (asks(/^(?:what|what's|whats|which|how many|show|list|describe|summar|tell me)\b/) &&
      asks(/\b(project|timeline|sequence|clips?|tracks?|media|library|overlays?)\b/)) ||
    asks(/\bproject status\b|\bwhat do i have\b/)
  ) {
    return call('describe_project')
  }

  // An absolute path is a direct instruction to import that file.
  const explicitPath = filePathMention(raw)
  if (explicitPath && asks(/\b(import|add|open|use|bring|load|put|place)\b/)) {
    return call('import_file', { paths: [explicitPath] })
  }

  // Importing from disk.
  if (asks(/\b(import|browse|file picker|open a file|from my (computer|pc|device|laptop|desktop)|add (some )?(files|media))\b/)) {
    return call('import_media')
  }

  // Track management, checked before clip placement so "add an audio track" is
  // not read as placing media.
  if (asks(/\b(add|create|make|insert|new|another)\b/) && asks(/\btrack\b/) && !asks(/\bto the\b.*\btrack\b/)) {
    const kind = asks(/\baudio|sound|music\b/) ? 'audio' : 'video'
    const name = /\bcalled\s+(.+)$/i.exec(raw)
    return call('add_track', name ? { kind, name: name[1].replace(/[.!?]+$/, '').trim() } : { kind })
  }

  if (asks(/\brename\b/)) {
    const track = trackMention(raw)
    const name = newName(raw)
    if (track && name) return call('rename_track', { track, name })
  }

  if (asks(/\b(delete|remove|get rid of|drop)\b/) && asks(/\btrack\b/)) {
    const track = trackMention(raw)
    if (track) return call('remove_track', { track })
  }

  // Cropping, including bare shape words like "make it vertical".
  if (asks(/\bcrop|\baspect|\bratio\b/) || asks(/\b(vertical|portrait|square|landscape|widescreen)\b/)) {
    if (asks(/\b(uncrop|un-crop|reset|remove|clear|undo|full frame|original)\b/)) {
      return call('crop_clip', { clip: clipMention(raw, state), aspect: 'reset' })
    }
    // A remembered preference covers a bare "crop it".
    const aspect = ratioMention(raw) ?? learnedDefaults(state.memory).aspect
    if (aspect) return call('crop_clip', { clip: clipMention(raw, state), aspect })
  }

  // Splitting, and keeping a chosen stretch of a file.
  if (asks(/\b(split|razor|slice|cut)\b/) && asks(/\b(in (half|two)|at|here|playhead)\b/)) {
    const at = timeMention(raw)
    return call('split_clip', { clip: clipMention(raw, state), at: at ?? 'playhead' })
  }

  if (asks(/\b(keep|use|just|only|take|want)\b/) || asks(/\bfrom\b.*\bto\b/)) {
    const range = rangeMention(raw)
    if (range) return call('use_range', { clip: clipMention(raw, state), ...range })
  }

  // Trimming, before moving, since both mention times.
  if (asks(/\b(trim|shorten|lengthen|extend|make (it|the clip).*(long|short)|duration|length)\b/)) {
    const duration = durationMention(raw)
    if (duration) return call('trim_clip', { clip: clipMention(raw, state), duration })
  }

  if (asks(/\bzoom\b/)) {
    if (asks(/\bin\b/)) return call('set_zoom', { zoom: 'in' })
    if (asks(/\bout\b/)) return call('set_zoom', { zoom: 'out' })
    const level = /\b(\d+(?:\.\d+)?)\b/.exec(lower)
    if (level) return call('set_zoom', { zoom: level[1] })
  }

  if (asks(/\b(go to|jump to|seek|scrub|playhead to|move the playhead)\b/)) {
    const time = timeMention(raw)
    if (time) return call('seek', { time })
  }

  if (asks(/\b(move|shift|slide|reposition)\b/)) {
    const time = timeMention(raw)
    const track = asks(/\btrack\b/) ? trackMention(raw) : null
    if (time || track) {
      return call('move_clip', {
        clip: clipMention(raw, state),
        ...(time ? { start: time } : {}),
        ...(track ? { track } : {}),
      })
    }
  }

  if (asks(/\b(delete|remove|get rid of|take out)\b/)) {
    return call('delete_clip', { clip: clipMention(raw, state) })
  }

  // Placing media on the timeline.
  if (asks(/\b(add|put|place|drop|insert|bring|use)\b/)) {
    const media = mediaMention(raw, state)
    if (media) {
      const time = timeMention(raw)
      const track = asks(/\btrack\b/) ? trackMention(raw) : null
      return call('add_clip', {
        media,
        ...(time ? { start: time } : {}),
        ...(track ? { track } : {}),
      })
    }
    if (state.media.length === 0) return call('import_media')
  }

  return NOTHING
}
