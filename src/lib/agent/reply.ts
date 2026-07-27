/**
 * Model replies are shown as plain text in a bubble, so markdown arrives as
 * literal asterisks and hashes. Small models reach for it however firmly the
 * prompt asks them not to, so the syntax is taken back out here rather than
 * fought over: the words are kept, the punctuation of a document is not.
 */

export function tidyReply(text: string): string {
  return (
    text
      .replace(/\r\n/g, '\n')
      // Fences and inline backticks: the text inside is worth keeping.
      .replace(/^```[a-z]*\n?/gim, '')
      .replace(/`([^`\n]+)`/g, '$1')
      .replace(/^#{1,6}\s+/gm, '')
      .replace(/^\s*>\s?/gm, '')
      // Bullets become a mark that reads as text; numbered lists already do.
      .replace(/^[ \t]*[-*+][ \t]+/gm, '• ')
      .replace(/\*\*([^*\n]+)\*\*/g, '$1')
      .replace(/__([^_\n]+)__/g, '$1')
      .replace(/(^|\s)\*([^*\n]+)\*(?=$|[\s.,!?;:])/g, '$1$2')
      // A rule across the bubble is noise.
      .replace(/^\s*([-*_])(?:\s*\1){2,}\s*$/gm, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  )
}
