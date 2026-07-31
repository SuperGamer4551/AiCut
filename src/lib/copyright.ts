/**
 * What in a timeline might get claimed, and what would actually help.
 *
 * A word on what this deliberately does not do. There is a popular belief that
 * flipping a clip, speeding it up slightly, or keeping every cut under some
 * number of seconds will get you past Content ID. It will not: the matcher
 * normalises for mirroring, crops and speed before it compares, and YouTube
 * states plainly that no duration of someone else's work is automatically in
 * the clear. Worse, a trick that fools the scan and is later seen by a human
 * turns a claim, which costs you the money on one video, into a strike, and
 * three of those end a channel. So none of that is offered here. What is
 * offered is the boring set of things that genuinely lower the risk: use your
 * own footage, cut third-party music, and where you must use someone else's
 * work, build something of your own around it.
 *
 * The findings lean on where each file came from, which the app records at
 * import, rather than on watching the pixels. Knowing a clip was pulled off a
 * particular channel is worth more than any guess a frame-by-frame look could
 * make.
 */
import type { MediaItem, Origin, TimelineClip } from './types'

export type RiskLevel = 'high' | 'medium' | 'low' | 'clear'

/** Things the app can actually carry out, all of which are honest. */
export type RemedyKind = 'mute' | 'remove' | 'replace-audio' | 'manual'

export type Remedy = {
  kind: RemedyKind
  /** Shown on the button. */
  label: string
  /** What it will do, in the words of the change itself. */
  detail: string
}

export type Finding = {
  id: string
  level: RiskLevel
  /** Which clips this is about, so they can be highlighted. */
  clipIds: string[]
  title: string
  /** Why this is a risk, said plainly. */
  reason: string
  remedies: Remedy[]
}

export type Report = {
  level: RiskLevel
  /** A sentence for the top of the panel. */
  headline: string
  findings: Finding[]
  /** Seconds of the timeline that came from somebody else. */
  borrowedSeconds: number
  totalSeconds: number
}

const LEVEL_ORDER: Record<RiskLevel, number> = { clear: 0, low: 1, medium: 2, high: 3 }

export function worstOf(levels: RiskLevel[]): RiskLevel {
  return levels.reduce<RiskLevel>((worst, level) => (LEVEL_ORDER[level] > LEVEL_ORDER[worst] ? level : worst), 'clear')
}

/** Whether a licence obliges you to credit the author. */
export function needsAttribution(license: string): boolean {
  const word = license.toLowerCase()
  if (/^(cc0|public ?domain|pdm)/.test(word)) return false
  return /\bby\b|cc-by|attribution|share-?alike|\bsa\b/.test(word)
}

/** Whether a licence forbids the ad money that a channel is usually after. */
export function forbidsCommercial(license: string): boolean {
  return /\bnc\b|non-?commercial/i.test(license)
}

export function describeOrigin(origin: Origin | undefined): string {
  if (!origin) return 'an unknown source'

  switch (origin.from) {
    case 'youtube':
      return `${origin.channel} on YouTube`
    case 'library':
      return `${origin.source} (${origin.license})`
    case 'generated':
      return 'AiCut'
    case 'local':
      return 'this computer'
  }
}

/** Whether a file is someone else's work as far as we can tell. */
export function isBorrowed(item: MediaItem): boolean {
  return item.origin?.from === 'youtube' || item.origin?.from === 'library'
}

/**
 * Borrowed and with no licence behind it. A whole video built out of openly
 * licensed footage is exactly what those libraries are for, so it is not the
 * same situation as one built out of someone's channel, even though both came
 * from somebody else.
 */
export function isUnlicensed(item: MediaItem): boolean {
  return item.origin?.from === 'youtube'
}

/**
 * How much of the running time these clips cover, counting a moment once
 * however many of them are stacked on it. Adding durations up instead would
 * double-count music laid under footage and report a 50 second video as 100.
 */
export function coveredSeconds(clips: TimelineClip[]): number {
  const spans = clips
    .map((clip) => ({ start: clip.start, end: clip.start + clip.duration }))
    .sort((a, b) => a.start - b.start)

  let total = 0
  let reached = 0

  for (const span of spans) {
    const from = Math.max(span.start, reached)
    if (span.end > from) {
      total += span.end - from
      reached = span.end
    }
  }

  return total
}

/** Where the last clip ends, which is how long the video runs. */
export function timelineLength(clips: TimelineClip[]): number {
  return clips.reduce((end, clip) => Math.max(end, clip.start + clip.duration), 0)
}

/**
 * Clips still carrying sound. An image never had any, and one already silenced
 * has nothing left to take, so neither is worth offering to mute again.
 */
function audible(clip: TimelineClip): boolean {
  return clip.kind !== 'image' && !clip.muted
}

type Grouped = { item: MediaItem; clips: TimelineClip[] }

function groupByMedia(clips: TimelineClip[], media: MediaItem[]): Grouped[] {
  const groups = new Map<string, Grouped>()

  for (const clip of clips) {
    const item = media.find((entry) => entry.id === clip.mediaId)
    if (!item) continue

    const existing = groups.get(item.id)
    if (existing) existing.clips.push(clip)
    else groups.set(item.id, { item, clips: [clip] })
  }

  return [...groups.values()]
}

function clipWord(count: number): string {
  return count === 1 ? 'clip' : 'clips'
}

/**
 * Looks over a timeline and says what could be claimed. Nothing here talks to
 * the network or the file system, so it is instant and works offline.
 */
export function checkCopyright(clips: TimelineClip[], media: MediaItem[]): Report {
  const findings: Finding[] = []
  const total = timelineLength(clips)

  const groups = groupByMedia(clips, media)
  const borrowed = groups.filter((group) => isBorrowed(group.item))

  for (const { item, clips: used } of groups) {
    const origin = item.origin
    const span = coveredSeconds(used)
    const count = used.length

    if (origin?.from === 'youtube') {
      const withSound = used.filter(audible)

      // Audio is the sharper edge of the two. Content ID matches sound and
      // picture separately, and music is what nearly every claim lands on.
      const silenced = used.every((clip) => clip.kind === 'image' || clip.muted)

      findings.push({
        id: `yt-${item.id}`,
        level: 'high',
        clipIds: used.map((clip) => clip.id),
        title: `${item.name} is ${origin.channel}'s video`,
        reason:
          `${count} ${clipWord(count)}, ${Math.round(span)}s in total, came off ${origin.channel}'s channel. ` +
          `Content ID matches the picture and the sound separately, and a few seconds is enough for either. ` +
          `There is no length that is automatically safe.` +
          (silenced
            ? ` The sound is already off, which deals with the likeliest claim, but the picture can still match.`
            : ''),
        remedies: withSound.length
          ? [
              {
                kind: 'mute',
                label: 'Mute it',
                detail:
                  `Silences ${withSound.length} ${clipWord(withSound.length)} and keeps the picture. ` +
                  `Music is the usual claim, so talking over muted footage removes most of the risk.`,
              },
              {
                kind: 'remove',
                label: 'Take it out',
                detail: `Removes all ${count} ${clipWord(count)} from the timeline. The file stays in your media panel.`,
              },
              {
                kind: 'manual',
                label: 'Leave it',
                detail:
                  `Keep it and accept the risk. If you are commenting on or reacting to it, that is the case ` +
                  `you would be making, but only a court decides fair use, not YouTube.`,
              },
            ]
          : [
              {
                kind: 'remove',
                label: 'Take it out',
                detail: `Removes all ${count} ${clipWord(count)} from the timeline. The file stays in your media panel.`,
              },
              { kind: 'manual', label: 'Leave it', detail: 'Keep it and accept the risk.' },
            ],
      })
      continue
    }

    if (origin?.from === 'library') {
      const attribution = needsAttribution(origin.license)
      const commercial = forbidsCommercial(origin.license)

      if (!attribution && !commercial) continue

      const author = origin.author ? `${origin.author}` : 'the author'

      findings.push({
        id: `lib-${item.id}`,
        level: commercial ? 'medium' : 'low',
        clipIds: used.map((clip) => clip.id),
        title: commercial
          ? `${item.name} is not licensed for monetised video`
          : `${item.name} needs ${author} credited`,
        reason: commercial
          ? `${origin.source} licenses this as ${origin.license}. The NC in that means no commercial use, and a ` +
            `monetised upload counts. Using it could put you in breach even though the file was free to download.`
          : `${origin.source} licenses this as ${origin.license}, which lets you use it as long as you credit ` +
            `${author}. Put the credit in your description before you publish.`,
        remedies: commercial
          ? [
              {
                kind: 'remove',
                label: 'Take it out',
                detail: `Removes ${count} ${clipWord(count)} from the timeline. The file stays in your media panel.`,
              },
              {
                kind: 'manual',
                label: 'Leave it',
                detail: 'Keep it, and either turn monetisation off for this video or get permission.',
              },
            ]
          : [
              {
                kind: 'manual',
                label: 'Note the credit',
                detail:
                  `Nothing to change in the edit. Credit ${author} in the description` +
                  `${origin.pageUrl ? `, linking ${origin.pageUrl}` : ''}.`,
              },
            ],
      })
      continue
    }

    if (!origin) {
      findings.push({
        id: `unknown-${item.id}`,
        level: 'medium',
        clipIds: used.map((clip) => clip.id),
        title: `Nothing is known about where ${item.name} came from`,
        reason:
          `This was imported before the app started recording sources, or brought in from your computer. ` +
          `If you filmed or recorded it, there is nothing to worry about. If you downloaded it, treat it as ` +
          `someone else's.`,
        remedies: [
          { kind: 'manual', label: 'It is mine', detail: 'No change. Nothing else in this check will flag it.' },
          {
            kind: 'remove',
            label: 'Take it out',
            detail: `Removes ${count} ${clipWord(count)} from the timeline. The file stays in your media panel.`,
          },
        ],
      })
    }
  }

  const borrowedSeconds = coveredSeconds(borrowed.flatMap((group) => group.clips))

  const unlicensed = groups.filter((group) => isUnlicensed(group.item))
  const unlicensedSeconds = coveredSeconds(unlicensed.flatMap((group) => group.clips))

  // A video that is mostly somebody else's is a different problem from one that
  // quotes a few seconds, whatever the individual clips look like. Openly
  // licensed material is excluded: a film built entirely of public domain
  // footage is not a reupload of anything.
  if (total > 0 && unlicensedSeconds / total > 0.5 && unlicensed.length > 0) {
    findings.push({
      id: 'mostly-borrowed',
      level: 'high',
      clipIds: unlicensed.flatMap((group) => group.clips.map((clip) => clip.id)),
      title: 'Most of this video is other people\'s work',
      reason:
        `${Math.round((unlicensedSeconds / total) * 100)}% of the timeline came from someone's channel. ` +
        `Reuse defends itself best when your own contribution is the substance and the borrowed part is ` +
        `the thing you are talking about. As it stands it is closer to a reupload, which is the position ` +
        `hardest to argue and easiest to strike.`,
      remedies: [
        {
          kind: 'manual',
          label: 'Add your own',
          detail: 'Record commentary, a facecam or your own footage so the video is mostly yours.',
        },
      ],
    })
  }

  const level = worstOf(findings.map((finding) => finding.level))

  return {
    level,
    headline: headlineFor(level, findings.length, clips.length),
    findings,
    borrowedSeconds,
    totalSeconds: total,
  }
}

function headlineFor(level: RiskLevel, findings: number, clips: number): string {
  if (clips === 0) return 'There is nothing on the timeline to check yet.'

  switch (level) {
    case 'clear':
      return 'Nothing here looks likely to get claimed.'
    case 'low':
      return `${findings} thing${findings === 1 ? '' : 's'} to tidy up, none of it serious.`
    case 'medium':
      return `${findings} thing${findings === 1 ? '' : 's'} worth sorting before you upload.`
    case 'high':
      return `${findings} thing${findings === 1 ? '' : 's'} here could get this claimed or struck.`
  }
}

/**
 * The change a remedy would make, worked out but not applied. Showing this
 * before touching anything is the point: nothing is edited until you have seen
 * what it would do.
 */
export type Change = {
  /** One line per clip affected, for the preview list. */
  lines: string[]
  clips: TimelineClip[]
}

export function planRemedy(
  finding: Finding,
  remedy: RemedyKind,
  clips: TimelineClip[],
  media: MediaItem[],
): Change | null {
  const affected = clips.filter((clip) => finding.clipIds.includes(clip.id))
  if (affected.length === 0) return null

  if (remedy === 'remove') {
    return {
      lines: affected.map((clip) => `Remove "${clip.name}" at ${Math.round(clip.start)}s`),
      clips: clips.filter((clip) => !finding.clipIds.includes(clip.id)),
    }
  }

  if (remedy === 'mute') {
    // Anything already silent is left out, so the preview never promises a
    // change that would do nothing.
    const audibleClips = affected.filter(audible)
    if (audibleClips.length === 0) return null

    return {
      lines: audibleClips.map((clip) => `Mute "${clip.name}" at ${Math.round(clip.start)}s`),
      clips: clips.map((clip) =>
        audibleClips.some((entry) => entry.id === clip.id) ? { ...clip, muted: true } : clip,
      ),
    }
  }

  // Nothing to preview for advice the app cannot carry out itself.
  void media
  return null
}
