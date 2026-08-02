// Local accounts for the desktop app. Each person who uses this computer
// signs in, and their projects live in a folder of their own. Passwords never
// leave the machine; they are hashed with scrypt before anything is written.
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { projectsFolder } from './projects'

export type AccountRecord = {
  id: string
  name: string
  email: string
  /** scrypt salt, hex. */
  salt: string
  /** scrypt hash of the password, hex. */
  hash: string
  created: number
}

export type PublicAccount = {
  id: string
  name: string
  email: string
}

export type AuthReply = { user: PublicAccount } | { error: string }
export type SessionReply = { user: PublicAccount | null }

type Store = {
  accounts: AccountRecord[]
}

const ACCOUNTS_FILE = 'accounts.json'
const SESSION_FILE = 'session.json'
const USERS_DIR = 'users'

const SCRYPT_KEYLEN = 64

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

/** Root folder for the signed-in user's projects, or null when nobody is in. */
export async function activeUserRoot(userData: string): Promise<string | null> {
  const current = await session(userData)
  if (!current.user) return null
  return userRoot(userData, current.user.id)
}
