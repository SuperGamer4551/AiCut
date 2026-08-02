// Assertions for local accounts: hashing, sign-up, sign-in, session and the
// per-user project folder. Run with: npm run check:auth
import { mkdtemp, mkdir, writeFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { session, signIn, signOut, signUp, userRoot } from '../electron/auth'
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

  if (failures > 0) {
    console.error(`\n${failures} auth check(s) failed`)
    process.exit(1)
  }

  console.log('\nall auth checks passed')
}

void main()
