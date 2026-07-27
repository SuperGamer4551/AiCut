// Assertions for reading the user's disk: what gets listed, what gets skipped,
// and that a search stays bounded.
// Run with: npm run check:files
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { MAX_DEPTH, findMedia, isMediaFile, listFolder } from '../electron/fileBrowser'
import { collectRoots, looksLikePath, resolveFolderName, searchRoots } from '../electron/folders'
import { folderMention, searchTerm } from '../src/lib/agent/interpret'
import { describeMatches } from '../src/lib/agent/bridge'

let failures = 0

function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected)
  if (!pass) failures += 1
  console.log(`${pass ? 'pass' : 'FAIL'}  ${label}`)
  if (!pass) console.log(`      expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

async function tree(root: string, files: string[]) {
  for (const relative of files) {
    const full = path.join(root, relative)
    await mkdir(path.dirname(full), { recursive: true })
    await writeFile(full, 'x'.repeat(16), 'utf8')
  }
}

async function main() {
  check('a video is media', isMediaFile('holiday.MP4'), true)
  check('audio is media', isMediaFile('track.flac'), true)
  check('an image is media', isMediaFile('poster.jpeg'), true)
  check('a document is not media', isMediaFile('taxes.pdf'), false)
  check('a bare name is not media', isMediaFile('README'), false)

  const root = await mkdtemp(path.join(tmpdir(), 'aicut-files-'))
  await tree(root, [
    'beach.mp4',
    'notes.txt',
    'song.mp3',
    path.join('trips', 'beach-sunset.mp4'),
    path.join('trips', 'raw', 'beach-take-2.mov'),
    path.join('node_modules', 'junk.mp4'),
    path.join('.hidden', 'secret.mp4'),
  ])

  const listing = await listFolder(root)
  const names = listing.entries.map((entry) => entry.name).sort()
  check('media files are listed', names.includes('beach.mp4'), true)
  check('sub-folders are listed', names.includes('trips'), true)
  check('documents are left out', names.includes('notes.txt'), false)
  check('build folders are left out', names.includes('node_modules'), false)
  check('hidden folders are left out', names.includes('.hidden'), false)
  check('folders sort before files', listing.entries[0].kind, 'folder')
  check('a listed file carries its full path', listing.entries.some((entry) => entry.path === path.join(root, 'beach.mp4')), true)
  check('a listed file carries its size', listing.entries.find((entry) => entry.name === 'beach.mp4')?.size, 16)

  let missingError = ''
  try {
    await listFolder(path.join(root, 'does-not-exist'))
  } catch (error) {
    missingError = (error as NodeJS.ErrnoException).code ?? ''
  }
  check('a missing folder raises rather than lying', missingError, 'ENOENT')

  const found = await findMedia('beach', [root])
  const foundNames = found.matches.map((match) => match.name).sort()
  check('a search finds shallow matches', foundNames.includes('beach.mp4'), true)
  check('a search descends into sub-folders', foundNames.includes('beach-sunset.mp4'), true)
  check('a search descends further still', foundNames.includes('beach-take-2.mov'), true)
  check('a search ignores non-matching media', foundNames.includes('song.mp3'), false)
  check('a search skips build folders', foundNames.includes('junk.mp4'), false)
  check('matches carry absolute paths', found.matches.every((match) => path.isAbsolute(match.path)), true)

  check('a search is case-insensitive', (await findMedia('BEACH', [root])).matches.length, 3)
  check('an empty query returns all media', (await findMedia('', [root])).matches.length, 4)
  check('a hopeless search comes back empty', (await findMedia('yeti', [root])).matches.length, 0)
  check('a missing root is skipped quietly', (await findMedia('beach', [path.join(root, 'nope')])).matches.length, 0)

  const capped = await findMedia('', [root], { maxMatches: 2 })
  check('the match limit is respected', capped.matches.length, 2)
  check('hitting the limit is reported', capped.truncated, true)

  const shallow = await findMedia('beach', [root], { maxDepth: 0 })
  check('depth limits the walk', shallow.matches.map((m) => m.name), ['beach.mp4'])

  const visitCapped = await findMedia('beach-take-2', [root], { maxVisited: 1 })
  check('the visit budget stops the walk', visitCapped.matches.length, 0)
  check('a stopped walk is reported as truncated', visitCapped.truncated, true)

  // A deep tree must not be walked forever.
  const deep = path.join(...Array.from({ length: MAX_DEPTH + 3 }, (_, i) => `d${i}`), 'buried.mp4')
  await tree(root, [deep])
  check('files below the depth limit are not found', (await findMedia('buried', [root])).matches.length, 0)

  // --- Folder words have to reach real folders -----------------------------
  const paths = {
    home: 'C:\\Users\\sam',
    videos: 'C:\\Users\\sam\\Videos',
    downloads: 'C:\\Users\\sam\\Downloads',
    documents: 'C:\\Users\\sam\\OneDrive\\Documents',
    desktop: 'C:\\Users\\sam\\OneDrive\\Desktop',
    pictures: 'C:\\Users\\sam\\Pictures',
    music: 'C:\\Users\\sam\\Music',
  }

  check('"documents" reaches the documents folder', resolveFolderName('documents', paths), paths.documents)
  check('"my documents folder" reaches it too', resolveFolderName('my documents folder', paths), paths.documents)
  check('"docs" is understood', resolveFolderName('Docs', paths), paths.documents)
  check('"downloads" reaches downloads', resolveFolderName('downloads', paths), paths.downloads)
  check('a real path is left alone', resolveFolderName('D:\\clips\\raw', paths), 'D:\\clips\\raw')
  check('a posix path is left alone', resolveFolderName('/home/sam/clips', paths), '/home/sam/clips')
  check('an unknown word resolves to nothing', resolveFolderName('recycle bin', paths), null)
  check('a folder the machine lacks resolves to nothing', resolveFolderName('music', { home: 'C:\\Users\\sam' }), null)
  check('a windows path is recognised as a path', looksLikePath('C:/clips'), true)
  check('a folder word is not a path', looksLikePath('documents'), false)

  const roots = collectRoots(paths, () => true, path.win32.join)
  const rootNames = roots.map((entry) => entry.name)
  check('documents is one of the usual places', rootNames.includes('Documents'), true)
  check('the OneDrive copy is offered as well', rootNames.includes('OneDrive Videos'), true)
  check('a folder is only offered once', new Set(roots.map((entry) => entry.path)).size, roots.length)
  check(
    'a redirected folder is not listed twice under two names',
    roots.filter((entry) => entry.path === paths.documents).length,
    1,
  )

  const onlyReal = collectRoots(paths, (candidate) => !candidate.includes('OneDrive\\Videos'), path.win32.join)
  check('a folder that is not there is left out', onlyReal.map((entry) => entry.name).includes('OneDrive Videos'), false)

  const searched = searchRoots(roots)
  check('documents is searched by default', searched.includes(paths.documents), true)
  check('the whole home folder is not searched', searched.includes(paths.home), false)

  // --- The phrasings people actually use -----------------------------------
  check('a documents folder is spotted', folderMention('find my fortnite clip in my documents folder'), 'documents')
  check('the folder hint is stripped from the search term', searchTerm('find my fortnite clip in my documents folder'), 'fortnite')
  check('"docs" is spotted too', folderMention('is there anything in my docs folder'), 'docs')
  check('a bare folder request leaves no search term', searchTerm('find the video in my documents folder'), null)
  check('a quoted name survives', searchTerm('find "raid boss" in documents'), 'raid boss')
  check('a path in the sentence is the folder', folderMention('search D:\\gameplay for kills'), 'D:\\gameplay')

  check(
    'an empty search in a folder is described as everything in it',
    describeMatches('', [], false, ['C:\\Users\\sam\\OneDrive\\Documents']),
    'I found no media files in C:\\Users\\sam\\OneDrive\\Documents.',
  )
  check(
    'a failed search names where it looked',
    describeMatches('yeti', [], false, ['C:\\Users\\sam\\Videos']).includes('C:\\Users\\sam\\Videos'),
    true,
  )
  check(
    'a folder listing counts what it found',
    describeMatches('', [{ name: 'a.mp4', path: 'C:\\a.mp4', size: 1024 }], false, ['C:\\']).startsWith('1 media file in C:\\'),
    true,
  )

  console.log(failures === 0 ? '\nRESULT: pass' : `\nRESULT: fail (${failures})`)
  if (failures > 0) process.exitCode = 1
}

void main()
