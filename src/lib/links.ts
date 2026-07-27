/**
 * Now that the assistant answers with addresses — an article it read, a video
 * worth watching, the page a meme came from — those have to be clickable rather
 * than something to copy out by hand.
 */

export type TextPart = { kind: 'text'; value: string } | { kind: 'link'; value: string }

/**
 * Trailing punctuation is left out of the address: a sentence ending "see
 * https://example.com/page." means the full stop belongs to the sentence.
 */
const LINK = /https?:\/\/[^\s<>"'`]+[^\s<>"'`.,;:!?)\]}]/g

export function splitLinks(text: string): TextPart[] {
  const parts: TextPart[] = []
  let at = 0

  for (const match of text.matchAll(LINK)) {
    const start = match.index ?? 0
    if (start > at) parts.push({ kind: 'text', value: text.slice(at, start) })
    parts.push({ kind: 'link', value: match[0] })
    at = start + match[0].length
  }

  if (at < text.length) parts.push({ kind: 'text', value: text.slice(at) })
  if (parts.length === 0) parts.push({ kind: 'text', value: text })

  return parts
}

/** A readable stand-in for a long address, so a bubble is not mostly URL. */
export function linkLabel(url: string, limit = 48): string {
  let host = url
  let rest = ''

  try {
    const parsed = new URL(url)
    host = parsed.host.replace(/^www\./, '')
    rest = `${parsed.pathname}${parsed.search}`.replace(/\/$/, '')
  } catch {
    return url.length > limit ? `${url.slice(0, limit - 1)}…` : url
  }

  if (rest === '' || rest === '/') return host

  const full = `${host}${rest}`
  return full.length > limit ? `${full.slice(0, limit - 1)}…` : full
}
