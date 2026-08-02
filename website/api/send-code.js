// Sends an AiCut password reset code by email.
//
// The desktop app makes the code and checks it; this only delivers it. Keeping
// the mail key here rather than in the installer is the whole point, so the
// endpoint stays deliberately dull: one fixed message, to one address, with
// six digits in it.
//
// Two ways to send, whichever is configured:
//   RESEND_API_KEY + MAIL_FROM   — needs a domain verified with Resend before
//                                  it will write to anyone but your own address
//   SMTP_USER + SMTP_PASS        — a Gmail app password, which reaches anyone
import nodemailer from 'nodemailer'

const RESEND_ENDPOINT = 'https://api.resend.com/emails'

const WINDOW_MS = 15 * 60 * 1000
const MAX_PER_WINDOW = 4

// Best effort only: a serverless instance is not shared or permanent, so this
// slows a nuisance down rather than stopping a determined one.
const recent = new Map()

function tooMany(key, now) {
  const hits = (recent.get(key) ?? []).filter((at) => now - at < WINDOW_MS)
  hits.push(now)
  recent.set(key, hits)

  if (recent.size > 500) {
    for (const [entry, times] of recent) {
      if (times.every((at) => now - at >= WINDOW_MS)) recent.delete(entry)
    }
  }

  return hits.length > MAX_PER_WINDOW
}

function looksLikeEmail(value) {
  return typeof value === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 120
}

function cleanName(value) {
  return typeof value === 'string' ? value.replace(/[\r\n<>]/g, '').trim().slice(0, 60) : ''
}

function message(name, code) {
  const greeting = name ? `Hi ${name},` : 'Hi,'

  const text = [
    greeting,
    '',
    `Your AiCut password reset code is ${code}.`,
    '',
    'Type it into the app to set a new password. It expires in 10 minutes.',
    'If you did not ask for this, you can ignore this email — nothing has changed.',
  ].join('\n')

  const html = `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;background:#0a0d15;color:#eef1f8;padding:32px;border-radius:14px">
  <p style="margin:0 0 18px;font-size:15px;color:#a4aec3">${greeting}</p>
  <p style="margin:0 0 8px;font-size:15px;color:#a4aec3">Your AiCut password reset code is</p>
  <p style="margin:0 0 18px;font-size:38px;font-weight:700;letter-spacing:8px;color:#4ae3a8">${code}</p>
  <p style="margin:0 0 8px;font-size:14px;color:#a4aec3">Type it into the app to set a new password. It expires in 10 minutes.</p>
  <p style="margin:0;font-size:13px;color:#717c93">If you did not ask for this, you can ignore this email — nothing has changed.</p>
</div>`

  return { subject: `${code} is your AiCut reset code`, text, html }
}

async function sendWithResend(to, mail) {
  const sent = await fetch(RESEND_ENDPOINT, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ from: process.env.MAIL_FROM, to: [to], ...mail }),
  })

  if (sent.ok) return { ok: true }

  const detail = await sent.text().catch(() => '')
  console.error('resend refused', sent.status, detail)

  // The commonest failure by far is sending to anyone but yourself before a
  // domain is verified, and the raw message does not make that obvious.
  if (sent.status === 403 && /verify a domain|own email/i.test(detail)) {
    return {
      error:
        'Resend will only email the address that owns the account until a domain is verified.',
    }
  }

  return { error: 'The email service refused to send that code.' }
}

async function sendWithSmtp(to, mail) {
  const user = process.env.SMTP_USER
  const transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: Number(process.env.SMTP_PORT || 465),
    secure: String(process.env.SMTP_PORT || '465') === '465',
    auth: { user, pass: process.env.SMTP_PASS },
  })

  try {
    await transport.sendMail({ from: process.env.MAIL_FROM || `AiCut <${user}>`, to, ...mail })
    return { ok: true }
  } catch (error) {
    console.error('smtp failed', error)
    return { error: 'The email could not be sent. Try again in a moment.' }
  }
}

export default async function handler(request, response) {
  if (request.method !== 'POST') {
    response.setHeader('Allow', 'POST')
    return response.status(405).json({ error: 'Send a POST request.' })
  }

  const viaResend = Boolean(process.env.RESEND_API_KEY && process.env.MAIL_FROM)
  const viaSmtp = Boolean(process.env.SMTP_USER && process.env.SMTP_PASS)

  if (!viaResend && !viaSmtp) {
    return response.status(503).json({
      error: 'Email is not set up on the AiCut site yet, so no code can be sent.',
    })
  }

  const payload = typeof request.body === 'string' ? safeParse(request.body) : request.body ?? {}
  const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : ''
  const code = typeof payload.code === 'string' ? payload.code : ''
  const name = cleanName(payload.name)

  if (!looksLikeEmail(email)) return response.status(400).json({ error: 'That is not an email address.' })
  if (!/^\d{6}$/.test(code)) return response.status(400).json({ error: 'That is not a reset code.' })

  const caller = request.headers['x-forwarded-for']?.split(',')[0]?.trim() ?? 'unknown'
  if (tooMany(`${caller}|${email}`, Date.now())) {
    return response.status(429).json({ error: 'Too many codes requested. Wait a few minutes.' })
  }

  const mail = message(name, code)
  const result = viaResend ? await sendWithResend(email, mail) : await sendWithSmtp(email, mail)

  if ('error' in result) return response.status(502).json({ error: result.error })
  return response.status(200).json({ sent: true })
}

function safeParse(raw) {
  try {
    return JSON.parse(raw)
  } catch {
    return {}
  }
}
