// Assertions for local accounts: hashing, sign-up, sign-in, session and the
// per-user project folder. Run with: npm run check:auth
import { mkdtemp, mkdir, writeFile, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  RESET_MAX_ATTEMPTS,
  RESET_TTL_MS,
  deleteAccount,
  makeResetCode,
  requestPasswordReset,
  resetPassword,
  session,
  signIn,
  signOut,
  signUp,
  userRoot,
} from '../electron/auth'
import type { SendCode } from '../electron/auth'
import { projectsFolder } from '../electron/projects'

let failures = 0

function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected)
  if (!pass) failures += 1
  console.log(`${pass ? 'pass' : 'FAIL'}  ${label}`)
  if (!pass) console.log(`      expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

async function main() {
  const root = await mkdtemp(path.join(tmpdir(), 'aicut-auth-'))

  check('nobody is signed in at first', (await session(root)).user, null)

  const badEmail = await signUp(root, 'Rey', 'not-an-email', 'password123')
  check('rejects a bad email', 'error' in badEmail, true)

  const short = await signUp(root, 'Rey', 'rey@example.com', 'short')
  check('rejects a short password', 'error' in short, true)

  const created = await signUp(root, 'Rey', 'rey@example.com', 'password123')
  check('sign-up returns a user', 'user' in created, true)
  if ('user' in created) {
    check('sign-up name is kept', created.user.name, 'Rey')
    check('sign-up email is lowercased', created.user.email, 'rey@example.com')
  }

  check('session remembers them', (await session(root)).user?.email, 'rey@example.com')

  const again = await signUp(root, 'Other', 'rey@example.com', 'password123')
  check('duplicate email is refused', 'error' in again, true)

  await signOut(root)
  check('sign-out clears the session', (await session(root)).user, null)

  const wrong = await signIn(root, 'rey@example.com', 'wrong-password')
  check('wrong password fails', 'error' in wrong, true)

  const back = await signIn(root, 'Rey@example.com', 'password123')
  check('sign-in works case-insensitively on email', 'user' in back, true)

  if ('user' in created) {
    const folder = projectsFolder(userRoot(root, created.user.id))
    const names = await readdir(folder).catch(() => null)
    check('a projects folder exists for the user', Array.isArray(names), true)
  }

  // Legacy projects from before accounts existed move into the first account.
  const fresh = await mkdtemp(path.join(tmpdir(), 'aicut-auth-legacy-'))
  const legacy = projectsFolder(fresh)
  await mkdir(legacy, { recursive: true })
  await writeFile(path.join(legacy, 'plegacy1.aicut.json'), '{"id":"plegacy1","kind":"short"}', 'utf8')

  const first = await signUp(fresh, 'Owner', 'owner@example.com', 'password123')
  if ('user' in first) {
    const moved = await readdir(projectsFolder(userRoot(fresh, first.user.id)))
    check('legacy projects are claimed by the first account', moved.includes('plegacy1.aicut.json'), true)
  } else {
    check('legacy projects are claimed by the first account', false, true)
  }

  // --- Forgotten passwords -------------------------------------------------

  const codes = [makeResetCode(), makeResetCode(), makeResetCode()]
  check('a code is six digits', codes.every((entry) => /^\d{6}$/.test(entry)), true)

  const box: string[] = []
  const post: SendCode = async ({ code }) => {
    box.push(code)
    return { ok: true }
  }
  const broken: SendCode = async () => ({ error: 'The mail service is down.' })

  const home = await mkdtemp(path.join(tmpdir(), 'aicut-reset-'))
  await signUp(home, 'Rey', 'rey@example.com', 'password123')
  await signOut(home)

  const unknown = await requestPasswordReset(home, 'nobody@example.com', post)
  check('a code is not sent to an unknown account', 'error' in unknown, true)
  check('nothing was sent for an unknown account', box.length, 0)

  const undelivered = await requestPasswordReset(home, 'rey@example.com', broken)
  check('a failed send is reported', 'error' in undelivered, true)
  check(
    'a failed send leaves no code to guess',
    'error' in (await resetPassword(home, 'rey@example.com', '000000', 'newpassword1')),
    true,
  )

  const asked = await requestPasswordReset(home, 'Rey@example.com', post)
  check('a code is sent for a known account', 'sent' in asked, true)
  check('the code went out once', box.length, 1)

  const code = box[box.length - 1]
  const notTheCode = code === '111111' ? '222222' : '111111'

  const badCode = await resetPassword(home, 'rey@example.com', notTheCode, 'newpassword1')
  check('a wrong code is refused', 'error' in badCode, true)
  check('a wrong code says how many tries are left', 'error' in badCode ? /tries left/.test(badCode.error) : false, true)

  const shortOne = await resetPassword(home, 'rey@example.com', code, 'short')
  check('a short new password is refused', 'error' in shortOne, true)

  // Getting the code right must not have cost one of the tries, so the real
  // attempt after a rejected password still works.
  const done = await resetPassword(home, 'rey@example.com', code, 'newpassword1')
  check('the right code sets the new password', 'user' in done, true)
  check('resetting signs you in', (await session(home)).user?.email, 'rey@example.com')

  const reused = await resetPassword(home, 'rey@example.com', code, 'another-one-1')
  check('a used code cannot be used again', 'error' in reused, true)

  await signOut(home)
  check('the old password no longer works', 'error' in (await signIn(home, 'rey@example.com', 'password123')), true)
  check('the new password works', 'user' in (await signIn(home, 'rey@example.com', 'newpassword1')), true)

  // Expiry is checked against the clock passed in, so this needs no waiting.
  const later = Date.now()
  await requestPasswordReset(home, 'rey@example.com', post, later)
  const stale = box[box.length - 1]
  const expired = await resetPassword(home, 'rey@example.com', stale, 'later-password-1', later + RESET_TTL_MS + 1)
  check('an expired code is refused', 'error' in expired, true)
  check('an expired code says so', 'error' in expired ? /expired/.test(expired.error) : false, true)

  await requestPasswordReset(home, 'rey@example.com', post)
  const live = box[box.length - 1]
  const miss = live === '111111' ? '222222' : '111111'
  for (let attempt = 0; attempt < RESET_MAX_ATTEMPTS; attempt += 1) {
    await resetPassword(home, 'rey@example.com', miss, 'guessed-password-1')
  }
  const burned = await resetPassword(home, 'rey@example.com', live, 'guessed-password-1')
  check('too many wrong guesses burns the code', 'error' in burned, true)

  // --- Deleting an account -------------------------------------------------

  const shared = await mkdtemp(path.join(tmpdir(), 'aicut-delete-'))
  const keeper = await signUp(shared, 'Keeper', 'keeper@example.com', 'password123')
  await signOut(shared)
  const goer = await signUp(shared, 'Goer', 'goer@example.com', 'password123')

  check('deleting needs somebody signed in', 'user' in goer, true)

  if ('user' in goer) {
    const folder = userRoot(shared, goer.user.id)
    await writeFile(path.join(projectsFolder(folder), 'p1abcdef.aicut.json'), '{"id":"p1abcdef"}', 'utf8')

    const gone = await deleteAccount(shared)
    check('the account is deleted', 'ok' in gone, true)
    check('deleting signs you out', (await session(shared)).user, null)
    check('their projects are gone from disk', existsSync(folder), false)
    check(
      'the deleted account cannot sign back in',
      'error' in (await signIn(shared, 'goer@example.com', 'password123')),
      true,
    )
  }

  check('nobody signed in cannot delete', 'error' in (await deleteAccount(shared)), true)

  if ('user' in keeper) {
    check(
      'the other account is untouched',
      'user' in (await signIn(shared, 'keeper@example.com', 'password123')),
      true,
    )
    check('their projects survive', existsSync(userRoot(shared, keeper.user.id)), true)
  }

  if (failures > 0) {
    console.error(`\n${failures} auth check(s) failed`)
    process.exit(1)
  }

  console.log('\nall auth checks passed')
}

void main()
