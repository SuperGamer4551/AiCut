// Local accounts for the desktop app. Each person who uses this computer
// signs in, and their projects live in a folder of their own. Passwords never
// leave the machine; they are hashed with scrypt before anything is written.
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { projectsFolder } from './projects'

/** A code that has been emailed out and is waiting to be typed back in. */
export type ResetRequest = {
  salt: string
  hash: string
  /** Epoch milliseconds after which the code is refused. */
  expires: number
  /** Wrong guesses so far, so a six-digit code cannot be worked through. */
  attempts: number
}

export type AccountRecord = {
  id: string
  name: string
  email: string
  /** scrypt salt, hex. */
  salt: string
  /** scrypt hash of the password, hex. */
  hash: string
  created: number
  reset?: ResetRequest
}

export type PublicAccount = {
  id: string
  name: string
  email: string
}

export type AuthReply = { user: PublicAccount } | { error: string }
export type SessionReply = { user: PublicAccount | null }
export type SentReply = { sent: true; email: string } | { error: string }

/** Hands the code to whatever can actually deliver an email. */
export type SendCode = (to: {
  email: string
  name: string
  code: string
}) => Promise<{ ok: true } | { error: string }>

type Store = {
  accounts: AccountRecord[]
}

const ACCOUNTS_FILE = 'accounts.json'
const SESSION_FILE = 'session.json'
const USERS_DIR = 'users'

const SCRYPT_KEYLEN = 64

/** Long enough to go and find the email, short enough to be worth expiring. */
export const RESET_TTL_MS = 10 * 60 * 1000
export const RESET_MAX_ATTEMPTS = 5

function accountsPath(userData: string): string {
  return path.join(userData, ACCOUNTS_FILE)
}

function sessionPath(userData: string): string {
  return path.join(userData, SESSION_FILE)
}

export function userRoot(userData: string, userId: string): string {
  return path.join(userData, USERS_DIR, userId)
}

export function publicAccount(account: AccountRecord): PublicAccount {
  return { id: account.id, name: account.name, email: account.email }
}

function cleanName(value: string): string {
  return value.trim().replace(/\s+/g, ' ').slice(0, 60)
}

function cleanEmail(value: string): string {
  return value.trim().toLowerCase().slice(0, 120)
}

function looksLikeEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
}

function hashPassword(password: string, saltHex: string): string {
  return scryptSync(password, Buffer.from(saltHex, 'hex'), SCRYPT_KEYLEN).toString('hex')
}

function passwordsMatch(password: string, saltHex: string, hashHex: string): boolean {
  try {
    const expected = Buffer.from(hashHex, 'hex')
    const actual = Buffer.from(hashPassword(password, saltHex), 'hex')
    return expected.length === actual.length && timingSafeEqual(expected, actual)
  } catch {
    return false
  }
}

async function readStore(userData: string): Promise<Store> {
  try {
    const raw = JSON.parse(await readFile(accountsPath(userData), 'utf8')) as Partial<Store>
    const accounts = Array.isArray(raw.accounts) ? raw.accounts : []
    return {
      accounts: accounts.filter(
        (entry): entry is AccountRecord =>
          Boolean(
            entry &&
              typeof entry.id === 'string' &&
              typeof entry.name === 'string' &&
              typeof entry.email === 'string' &&
              typeof entry.salt === 'string' &&
              typeof entry.hash === 'string',
          ),
      ),
    }
  } catch {
    return { accounts: [] }
  }
}

async function writeStore(userData: string, store: Store): Promise<void> {
  const target = accountsPath(userData)
  const scratch = `${target}.tmp`
  await writeFile(scratch, JSON.stringify(store, null, 2), 'utf8')
  await rename(scratch, target)
}

async function readSessionId(userData: string): Promise<string | null> {
  try {
    const raw = JSON.parse(await readFile(sessionPath(userData), 'utf8')) as { userId?: unknown }
    return typeof raw.userId === 'string' && raw.userId ? raw.userId : null
  } catch {
    return null
  }
}

async function writeSession(userData: string, userId: string | null): Promise<void> {
  const target = sessionPath(userData)
  if (!userId) {
    await rm(target, { force: true })
    return
  }

  const scratch = `${target}.tmp`
  await writeFile(scratch, JSON.stringify({ userId }, null, 2), 'utf8')
  await rename(scratch, target)
}

/** Move projects that lived in the old shared folder into this account. */
async function claimLegacyProjects(userData: string, userId: string): Promise<void> {
  const legacy = projectsFolder(userData)
  const owned = projectsFolder(userRoot(userData, userId))

  try {
    const { readdir } = await import('node:fs/promises')
    const names = await readdir(legacy)
    if (names.length === 0) return

    await mkdir(owned, { recursive: true })
    for (const name of names) {
      await rename(path.join(legacy, name), path.join(owned, name)).catch(() => {
        // A file that will not move is left where it is rather than lost.
      })
    }
  } catch {
    // No legacy folder is the common case after a fresh install.
  }
}

export async function session(userData: string): Promise<SessionReply> {
  const userId = await readSessionId(userData)
  if (!userId) return { user: null }

  const store = await readStore(userData)
  const account = store.accounts.find((entry) => entry.id === userId)
  if (!account) {
    await writeSession(userData, null)
    return { user: null }
  }

  return { user: publicAccount(account) }
}

export async function signUp(
  userData: string,
  name: string,
  email: string,
  password: string,
): Promise<AuthReply> {
  const cleanedName = cleanName(name)
  const cleanedEmail = cleanEmail(email)

  if (!cleanedName) return { error: 'Pick a name so people know who you are.' }
  if (!looksLikeEmail(cleanedEmail)) return { error: 'That does not look like an email address.' }
  if (password.length < 8) return { error: 'Use at least 8 characters for the password.' }

  const store = await readStore(userData)
  if (store.accounts.some((entry) => entry.email === cleanedEmail)) {
    return { error: 'An account with that email already exists. Sign in instead.' }
  }

  const salt = randomBytes(16).toString('hex')
  const account: AccountRecord = {
    id: `u${Date.now().toString(36)}${randomBytes(4).toString('hex')}`,
    name: cleanedName,
    email: cleanedEmail,
    salt,
    hash: hashPassword(password, salt),
    created: Date.now(),
  }

  store.accounts.push(account)
  await writeStore(userData, store)
  await mkdir(projectsFolder(userRoot(userData, account.id)), { recursive: true })

  // The first account inherits anything that was saved before accounts existed.
  if (store.accounts.length === 1) {
    await claimLegacyProjects(userData, account.id)
  }

  await writeSession(userData, account.id)
  return { user: publicAccount(account) }
}

export async function signIn(
  userData: string,
  email: string,
  password: string,
): Promise<AuthReply> {
  const cleanedEmail = cleanEmail(email)
  if (!looksLikeEmail(cleanedEmail)) return { error: 'That does not look like an email address.' }
  if (!password) return { error: 'Enter your password.' }

  const store = await readStore(userData)
  const account = store.accounts.find((entry) => entry.email === cleanedEmail)
  // Same message either way, so guessing emails does not get a free hint.
  if (!account || !passwordsMatch(password, account.salt, account.hash)) {
    return { error: 'Email or password is wrong.' }
  }

  await mkdir(projectsFolder(userRoot(userData, account.id)), { recursive: true })
  await writeSession(userData, account.id)
  return { user: publicAccount(account) }
}

export async function signOut(userData: string): Promise<{ ok: true }> {
  await writeSession(userData, null)
  return { ok: true }
}

/**
 * Removes the signed-in account and everything saved under it. There is no
 * undo and nothing is kept back: the record goes, the projects folder goes,
 * and the session with it.
 */
export async function deleteAccount(userData: string): Promise<{ ok: true } | { error: string }> {
  const current = await session(userData)
  if (!current.user) return { error: 'Nobody is signed in.' }

  const store = await readStore(userData)
  const remaining = store.accounts.filter((entry) => entry.id !== current.user!.id)
  if (remaining.length === store.accounts.length) {
    return { error: 'That account no longer exists.' }
  }

  try {
    await writeStore(userData, { accounts: remaining })
    // The folder is only worth removing once the record is gone, so a failure
    // here leaves orphaned files rather than an account nobody can sign into.
    await rm(userRoot(userData, current.user.id), { recursive: true, force: true })
    await writeSession(userData, null)
    return { ok: true }
  } catch (error) {
    return { error: `The account could not be deleted: ${(error as Error).message}` }
  }
}

// --- Forgotten passwords ---------------------------------------------------

/** Six digits, drawn from the same source as the salts rather than Math.random. */
export function makeResetCode(bytes: (size: number) => Buffer = randomBytes): string {
  // Rejection sampling, so 000000–999999 are all equally likely.
  for (;;) {
    const value = bytes(4).readUInt32BE(0)
    const limit = 4_294_967_296 - (4_294_967_296 % 1_000_000)
    if (value < limit) return String(value % 1_000_000).padStart(6, '0')
  }
}

/**
 * Emails a code to the address on an account. Whether the address is known is
 * not hidden: the accounts file sits on this computer next to the person
 * reading it, so pretending otherwise would only waste their time.
 */
export async function requestPasswordReset(
  userData: string,
  email: string,
  send: SendCode,
  now: number = Date.now(),
): Promise<SentReply> {
  const cleanedEmail = cleanEmail(email)
  if (!looksLikeEmail(cleanedEmail)) return { error: 'That does not look like an email address.' }

  const store = await readStore(userData)
  const account = store.accounts.find((entry) => entry.email === cleanedEmail)
  if (!account) return { error: 'There is no account with that email on this computer.' }

  const code = makeResetCode()
  const delivered = await send({ email: account.email, name: account.name, code })
  // The code is only recorded once it is genuinely on its way, so a failed
  // send does not invalidate a code the person is still holding.
  if ('error' in delivered) return { error: delivered.error }

  const salt = randomBytes(16).toString('hex')
  account.reset = {
    salt,
    hash: hashPassword(code, salt),
    expires: now + RESET_TTL_MS,
    attempts: 0,
  }

  await writeStore(userData, store)
  return { sent: true, email: account.email }
}

/**
 * Takes the code and the new password together. Getting it right signs them
 * back in, since they have just proved the address is theirs.
 */
export async function resetPassword(
  userData: string,
  email: string,
  code: string,
  password: string,
  now: number = Date.now(),
): Promise<AuthReply> {
  const cleanedEmail = cleanEmail(email)
  const cleanedCode = code.replace(/\D/g, '')

  const store = await readStore(userData)
  const account = store.accounts.find((entry) => entry.email === cleanedEmail)
  if (!account?.reset) {
    return { error: 'Ask for a new code — there is nothing waiting for this account.' }
  }

  if (account.reset.expires < now) {
    delete account.reset
    await writeStore(userData, store)
    return { error: 'That code has expired. Ask for a new one.' }
  }

  if (account.reset.attempts >= RESET_MAX_ATTEMPTS) {
    delete account.reset
    await writeStore(userData, store)
    return { error: 'Too many wrong codes. Ask for a new one.' }
  }

  if (!passwordsMatch(cleanedCode, account.reset.salt, account.reset.hash)) {
    account.reset.attempts += 1
    const left = RESET_MAX_ATTEMPTS - account.reset.attempts
    await writeStore(userData, store)
    return {
      error: left > 0 ? `That code is wrong. ${left} ${left === 1 ? 'try' : 'tries'} left.` : 'That code is wrong. Ask for a new one.',
    }
  }

  // The password is only checked once the code is known to be good, so a
  // short password does not burn one of the tries.
  if (password.length < 8) return { error: 'Use at least 8 characters for the password.' }

  const salt = randomBytes(16).toString('hex')
  account.salt = salt
  account.hash = hashPassword(password, salt)
  delete account.reset

  await writeStore(userData, store)
  await mkdir(projectsFolder(userRoot(userData, account.id)), { recursive: true })
  await writeSession(userData, account.id)

  return { user: publicAccount(account) }
}

/** Root folder for the signed-in user's projects, or null when nobody is in. */
export async function activeUserRoot(userData: string): Promise<string | null> {
  const current = await session(userData)
  if (!current.user) return null
  return userRoot(userData, current.user.id)
}
