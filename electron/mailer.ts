/**
 * Getting a reset code out to an email address.
 *
 * The app cannot send mail by itself — that needs a mail service and a key,
 * and a key shipped inside an installer is a key everyone has. So the code is
 * handed to a small endpoint on the AiCut website, which holds the key and
 * sends the message. Nothing but the address, the name and the six digits
 * leaves this computer, and the code itself is only ever checked here.
 */
export const DEFAULT_MAIL_ENDPOINT = 'https://website-nine-theta-83.vercel.app/api/send-code'

const TIMEOUT_MS = 20_000

export function mailEndpoint(): string {
  return process.env.AICUT_MAIL_ENDPOINT?.trim() || DEFAULT_MAIL_ENDPOINT
}

export async function deliverResetCode(to: {
  email: string
  name: string
  code: string
}): Promise<{ ok: true } | { error: string }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)

  try {
    const response = await fetch(mailEndpoint(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(to),
      signal: controller.signal,
    })

    if (response.ok) return { ok: true }

    // The endpoint explains itself when it can — that it is not set up yet, or
    // that too many codes have gone out — and that is worth passing straight on.
    const said = await response
      .json()
      .then((body: { error?: unknown }) => (typeof body.error === 'string' ? body.error : ''))
      .catch(() => '')

    return { error: said || `The code could not be sent (${response.status}).` }
  } catch (error) {
    if ((error as Error).name === 'AbortError') {
      return { error: 'Sending the code timed out. Check your connection and try again.' }
    }
    return { error: `The code could not be sent: ${(error as Error).message}` }
  } finally {
    clearTimeout(timer)
  }
}
