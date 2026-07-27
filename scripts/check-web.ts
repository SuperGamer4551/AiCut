// Assertions for the assistant's reach onto the internet: how each library's
// reply is read, how a plain request becomes a search rather than a hunt
// through the user's disk, and what comes back once something is downloaded.
// Run with: npm run check:web
import type { MediaItem, Track } from '../src/lib/types'
import type { ProjectState } from '../src/lib/agent/types'
import { interpretCommand, listChoice, onlineKind, webSubject } from '../src/lib/agent/interpret'
import { isStale, isYoutubeUrl, parseReport, progressFromLine, readFailure } from '../electron/ytdlp'
import { createHostBridge } from '../src/lib/agent/bridge'
import { converse } from '../src/lib/agent/converse'
import { linkLabel, splitLinks } from '../src/lib/links'
import {
  archiveSearchUrl,
  commonsUrl,
  extensionFor,
  fileKindFor,
  isPlayableExtension,
  openverseUrl,
  rankResults,
  readArchiveItem,
  readArchiveSearch,
  readCommons,
  readDuckDuckGo,
  readImgflip,
  readMediaKind,
  readOpenverse,
  readWikipediaSearch,
  readWikipediaSummary,
  readYoutubeResults,
  safeFileName,
} from '../src/lib/web/sources'

let failures = 0

function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected)
  if (!pass) failures += 1
  console.log(`${pass ? 'pass' : 'FAIL'}  ${label}`)
  if (!pass) console.log(`      expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

const TRACKS: Track[] = [
  { id: 'video-1', name: 'Video 1', kind: 'video' },
  { id: 'audio-1', name: 'Audio 1', kind: 'audio' },
]

function project(over: Partial<ProjectState> = {}): ProjectState {
  return {
    media: [],
    clips: [],
    tracks: TRACKS,
    overlays: [],
    playhead: 0,
    zoom: 1,
    selectedClipId: null,
    memory: [],
    ...over,
  }
}

function media(name: string): MediaItem {
  return {
    id: `m-${name}`,
    name,
    path: `C:/downloads/${name}`,
    url: `aicut://local/${name}`,
    kind: 'image',
    duration: 5,
    size: 2048,
    loading: false,
  }
}

/** The one call an interpretation should have produced. */
function route(input: string, state = project()): { name: string; args: Record<string, unknown> } | null {
  const { calls } = interpretCommand(input, state)
  return calls.length === 1 ? { name: calls[0].name, args: calls[0].args } : null
}

async function main() {
  // --- Reading each library's reply --------------------------------------

  const openverse = readOpenverse(
    {
      results: [
        {
          title: 'Sleeping cat',
          url: 'https://images.example/cat.jpg',
          foreign_landing_url: 'https://flickr.example/cat',
          license: 'by-sa',
          license_version: '4.0',
          creator: 'A Photographer',
          source: 'flickr',
          width: 1600,
          height: 900,
          filetype: 'jpg',
        },
        { title: 'No address', url: '' },
      ],
    },
    'image',
  )
  check('an Openverse result keeps its direct address', openverse[0].url, 'https://images.example/cat.jpg')
  check('the licence is reported so it can be credited', openverse[0].license, 'BY-SA 4.0')
  check('the page it came from is kept', openverse[0].pageUrl, 'https://flickr.example/cat')
  check('the source is named', openverse[0].source, 'Openverse · flickr')
  check('a result with no file is dropped', openverse.length, 1)

  const commons = readCommons(
    {
      query: {
        pages: {
          '1': {
            title: 'File:Rain on glass.webm',
            imageinfo: [
              {
                url: 'https://upload.example/rain.webm',
                descriptionurl: 'https://commons.example/rain',
                mime: 'video/webm',
                size: 4_000_000,
                width: 1280,
                height: 720,
                extmetadata: {
                  LicenseShortName: { value: 'CC BY 4.0' },
                  Artist: { value: '<a href="/x">Someone</a>' },
                },
              },
            ],
          },
        },
      },
    },
    'video',
  )
  check('a Commons file loses its File: prefix', commons[0].title, 'Rain on glass.webm')
  check('a Commons video is read as video', commons[0].kind, 'video')
  check('the markup around an author is stripped', commons[0].author, 'Someone')
  check('the Commons licence is carried through', commons[0].license, 'CC BY 4.0')

  const archiveHits = readArchiveSearch({
    response: { docs: [{ identifier: 'oldfilm', title: ['An Old Film'] }, { identifier: 'other', title: 'Other' }] },
  })
  check('an Archive search yields identifiers', archiveHits.map((hit) => hit.identifier), ['oldfilm', 'other'])
  check('a title given as a list is unwrapped', archiveHits[0].title, 'An Old Film')

  const archiveItem = readArchiveItem(
    {
      files: [
        { name: '__ia_thumb.jpg', format: 'Thumbnail', size: '900' },
        { name: 'master.mp4', format: 'MPEG4', size: '2000000000', length: '600' },
        { name: 'web.mp4', format: 'MPEG4', size: '8000000', length: '600' },
        { name: 'notes.txt', format: 'Text', size: '20' },
      ],
    },
    'oldfilm',
    'An Old Film',
    'video',
  )
  check('the web copy is chosen over the master', archiveItem?.url.endsWith('/web.mp4'), true)
  check('the download address is built from the identifier', archiveItem?.url, 'https://archive.org/download/oldfilm/web.mp4')
  check('the item page is kept for credit', archiveItem?.pageUrl, 'https://archive.org/details/oldfilm')
  check('the length is read off the file', archiveItem?.duration, 600)
  check('an item with nothing playable yields nothing', readArchiveItem({ files: [{ name: 'a.txt' }] }, 'x', 'X', 'video'), null)

  const imgflip = readImgflip(
    { data: { memes: [{ name: 'Distracted Boyfriend', url: 'https://i.example/bf.jpg', width: 1200, height: 800 }, { name: 'Unrelated', url: 'https://i.example/u.jpg' }] } },
    'boyfriend',
  )
  check('a meme template is matched by name', imgflip.length, 1)
  check('the meme keeps its address', imgflip[0].url, 'https://i.example/bf.jpg')

  const wiki = readWikipediaSearch({
    query: { search: [{ title: 'Fortnite', pageid: 42, snippet: 'A <span class="hit">battle royale</span> game' }] },
  })
  check('a Wikipedia hit is linked by its page id', wiki[0].url, 'https://en.wikipedia.org/?curid=42')
  check('the snippet markup is stripped', wiki[0].summary, 'A battle royale game')

  const summary = readWikipediaSummary({
    title: 'Fortnite',
    extract: 'Fortnite is an online video game.',
    content_urls: { desktop: { page: 'https://en.wikipedia.org/wiki/Fortnite' } },
  })
  check('a summary carries the prose', summary?.summary, 'Fortnite is an online video game.')
  check('a summary with no extract is nothing', readWikipediaSummary({ title: 'X' }), null)

  const duck = readDuckDuckGo({
    AbstractText: 'A short is a vertical video up to 60 seconds.',
    AbstractURL: 'https://example.com/shorts',
    AbstractSource: 'Wikipedia',
    Heading: 'YouTube Shorts',
    RelatedTopics: [{ Text: 'Reels - a similar format', FirstURL: 'https://example.com/reels' }, { Text: 'no url' }],
  })
  check('an instant answer becomes the answer', duck.answer, 'A short is a vertical video up to 60 seconds.')
  check('the answer and its related topics are both listed', duck.articles.length, 2)
  check('a related topic with no address is dropped', duck.articles[1].url, 'https://example.com/reels')

  // --- YouTube, which has no API to ask ----------------------------------

  const page = `<html><body><script>var ytInitialData = ${JSON.stringify({
    contents: {
      results: [
        {
          videoRenderer: {
            videoId: 'dQw4w9WgXcQ',
            title: { runs: [{ text: 'Best Fortnite Montage' }] },
            ownerText: { runs: [{ text: 'ClipMaster' }] },
            lengthText: { simpleText: '10:32' },
          },
        },
        {
          videoRenderer: {
            videoId: 'abcdefghijk',
            title: { runs: [{ text: 'How to edit a Short' }] },
            longBylineText: { runs: [{ text: 'EditSchool' }] },
          },
        },
      ],
    },
  })};</script></body></html>`

  const videos = readYoutubeResults(page)
  check('the results page yields real videos', videos.length, 2)
  check('a watch link is built from the id', videos[0].url, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ')
  check('the title is read out of its runs', videos[0].title, 'Best Fortnite Montage')
  check('the channel is read', videos[0].channel, 'ClipMaster')
  check('a channel given as a byline is still found', videos[1].channel, 'EditSchool')
  check('the length is carried when the page gives one', videos[0].length, '10:32')
  check('a page that will not parse yields nothing rather than throwing', readYoutubeResults('<html>nope</html>'), [])
  check('a limit is respected', readYoutubeResults(page, 1).length, 1)

  // --- Naming and sorting what comes back --------------------------------

  check('an address with an extension is trusted', extensionFor('https://x.example/a/photo.JPG'), 'jpg')
  check('the served type is used when the address has none', extensionFor('https://x.example/download?id=3', 'video/mp4'), 'mp4')
  check('a parameter after the name does not confuse it', extensionFor('https://x.example/clip.webm?v=2'), 'webm')
  check('audio falls back to mp3', extensionFor('https://x.example/thing', '', 'audio'), 'mp3')
  check('a type with a charset is still read', extensionFor('https://x.example/a', 'image/png; charset=binary'), 'png')
  check('documents are not playable', isPlayableExtension('pdf'), false)

  check('punctuation Windows rejects is stripped out', safeFileName('File:Cat "cute" / big.jpg', 'jpg'), 'Cat cute big.jpg')
  check('a name with nothing left still gets one', safeFileName('///', 'png'), 'download.png')
  check('a very long name is cut short', safeFileName('x'.repeat(200), 'gif').length <= 74, true)

  const shot = (title: string, url: string, width?: number) => ({
    title,
    url,
    pageUrl: '',
    source: '',
    license: '',
    extension: 'jpg',
    kind: 'image' as const,
    ...(width ? { width } : {}),
  })

  const ranked = rankResults(
    [shot('A window', 'a'), shot('A rainy window', 'b', 800), shot('A window', 'a')],
    'rainy window',
  )
  check('the result that matches most of the words comes first', ranked[0].url, 'b')
  check('the same file twice is listed once', ranked.length, 2)

  // What handed over a stranger when the libraries had nothing on the subject.
  check(
    'a title matching none of the search is thrown away',
    rankResults([shot('Bop House tour', 'a'), shot('Cooking at home', 'b')], 'fortnite gaming montage').length,
    0,
  )
  check(
    'the ones that do match survive that',
    rankResults([shot('Bop House tour', 'a'), shot('Fortnite build fight', 'b')], 'fortnite gaming montage').map(
      (result) => result.url,
    ),
    ['b'],
  )
  check(
    'a search with no word long enough to judge by keeps everything',
    rankResults([shot('Bop House tour', 'a')], 'ok').length,
    1,
  )

  check('a meme is a picture underneath', fileKindFor('meme'), 'image')
  check('a gif is a picture underneath', fileKindFor('gif'), 'image')
  check('"photo" is understood as an image', readMediaKind('photo'), 'image')
  check('"sfx" is understood as audio', readMediaKind('sfx'), 'audio')
  check('a word that means nothing here is refused', readMediaKind('sandwich'), null)

  check('an Openverse gif search asks for gifs', openverseUrl('cat', 'gif', 5).includes('extension=gif'), true)
  check('a meme search widens the words', openverseUrl('cat', 'meme', 5).includes('cat+meme'), true)
  check('a Commons video search filters to video', commonsUrl('rain', 'video', 5).includes('filetype%3Avideo'), true)
  check('an Archive video search asks for movies', archiveSearchUrl('film', 'video', 5).includes('mediatype%3Amovies'), true)

  // --- Reading the request -----------------------------------------------

  check('a meme request names the meme library', onlineKind('find me a meme'), 'meme')
  check('a gif beats the general picture case', onlineKind('find me a gif of a cat'), 'gif')
  check('footage means video', onlineKind('get some rain footage'), 'video')
  check('a sound effect means audio', onlineKind('find a swoosh sound effect'), 'audio')
  check('nothing to search for is nothing', onlineKind('make this a short'), null)

  check('the subject follows "about"', webSubject('find me a meme about losing'), 'losing')
  check('the subject follows "of"', webSubject('download a picture of a golden retriever'), 'golden retriever')
  check('the noun is not part of the subject', webSubject('get some rain footage'), 'rain')
  check('a time is an instruction, not the subject', webSubject('find a meme about failing at 0:12'), 'failing')
  check('a quoted subject is taken whole', webSubject('find a meme about "the floor is lava"'), 'the floor is lava')

  // --- Routing, with no model behind it ----------------------------------

  check('a meme request goes to the internet', route('find me a meme about losing'), {
    name: 'add_online_media',
    args: { query: 'losing', kind: 'meme' },
  })
  check('footage is fetched too', route('get some rain footage'), {
    name: 'add_online_media',
    args: { query: 'rain', kind: 'video' },
  })
  check('a sound effect is fetched', route('find a swoosh sound effect'), {
    name: 'add_online_media',
    args: { query: 'swoosh', kind: 'audio' },
  })
  check('the media panel is a place to put downloads', route('put a meme about failing in the media section'), {
    name: 'add_online_media',
    args: { query: 'failing', kind: 'meme' },
  })
  check('asking for options lists rather than takes', route('find me some options for cat gifs online'), {
    name: 'find_online_media',
    args: { query: 'cat', kind: 'gif' },
  })

  check('searching the web reads around a subject', route('search the web for the new fortnite season'), {
    name: 'search_web',
    args: { query: 'new fortnite season' },
  })
  check('"google" is a search', route('google fortnite chapter 6')?.name, 'search_web')
  check('"look up" is a search', route('look up how long a youtube short can be')?.name, 'search_web')
  check('an example is a reference to watch', route('show me examples of good gaming montages'), {
    name: 'find_reference_video',
    args: { query: 'gaming montages' },
  })

  // The disk still wins when the request is plainly about their own machine.
  check('their own clips are still found on disk', route('find my fortnite clips in my videos folder')?.name, 'find_media')
  check('a meme they already keep is still placed from disk', route('add the bruh meme at 0:12')?.name, 'insert_cutaway')
  check('drawing a card is not a download', route('generate a video about fortnite')?.name, 'generate_clip')
  check('making a short is untouched', route('make this into a youtube short')?.name, 'make_short')
  check('searching their files is not searching the web', route('search my documents for the raid clip')?.name, 'find_media')

  check('the assistant can say it reaches the internet', converse('can you search the internet', { connected: false, clips: 0, media: 0 })?.topic, 'internet')

  // --- Asking for a video that only YouTube has ---------------------------

  check('naming YouTube asks YouTube', route('get me a fortnite montage from youtube'), {
    name: 'download_video',
    args: { query: 'fortnite montage' },
  })
  check('a pasted link is the whole request', route('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), {
    name: 'download_video',
    args: { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' },
  })
  check('a short link counts too', route('grab this https://youtu.be/abc123')?.name, 'download_video')
  check('picking off the last list needs no new search', route('download the second one'), {
    name: 'download_video',
    args: { choice: 2 },
  })
  check('a numbered pick is read', listChoice('download number 3'), 3)
  check('nothing to pick from reads as nothing', listChoice('download that video'), null)

  // The reported failure: this used to hand back whatever the archive had.
  check('a plain video request still starts with the free libraries', route('get me a video about a fortnite gaming montage'), {
    name: 'add_online_media',
    args: { query: 'fortnite gaming montage', kind: 'video' },
  })
  // Watching and downloading are different asks, and stay that way.
  check('an example is still a link to watch', route('show me examples of fortnite montages on youtube')?.name, 'find_reference_video')
  check('a meme is still a free library', route('get me a meme about losing')?.name, 'add_online_media')

  // --- The downloader ------------------------------------------------------

  check('a watch address is YouTube', isYoutubeUrl('https://www.youtube.com/watch?v=abc'), true)
  check('a short address is YouTube', isYoutubeUrl('https://youtu.be/abc'), true)
  check('the mobile site is YouTube', isYoutubeUrl('https://m.youtube.com/watch?v=abc'), true)
  check('somewhere else is not', isYoutubeUrl('https://vimeo.com/123'), false)
  check('a lookalike host is not', isYoutubeUrl('https://youtube.com.evil.example/watch?v=abc'), false)
  check('nonsense is not', isYoutubeUrl('not a url'), false)

  check('progress is read off the line', progressFromLine('[download]  42.5% of 10.00MiB at 1.00MiB/s'), 0.425)
  check('the finished line reads as done', progressFromLine('[download] 100% of 10.00MiB'), 1)
  check('another line means nothing', progressFromLine('[youtube] abc: Downloading webpage'), null)

  check(
    'a private video is explained rather than repeated verbatim',
    readFailure('ERROR: [youtube] abc: Private video. Sign in if you\'ve been granted access'),
    'That video is private, age-restricted or region-locked, so it cannot be downloaded.',
  )
  check(
    'an unknown failure is still passed on',
    readFailure('ERROR: something went sideways'),
    'something went sideways',
  )
  check('no error line at all still says something', readFailure('') !== '', true)
  check(
    'a certificate failure points at the network rather than the video',
    readFailure('ERROR: [SSL: CERTIFICATE_VERIFY_FAILED] certificate verify failed').includes('inspecting traffic'),
    true,
  )

  // What yt-dlp actually wrote during a real run.
  check(
    'the report line is read back',
    parseReport('C:\\downloads\\A Montage [abc].mp4\tA Montage\tClipMaster\t260\r\n'),
    { path: 'C:\\downloads\\A Montage [abc].mp4', title: 'A Montage', channel: 'ClipMaster', duration: 260 },
  )
  // A direct file has no uploader, and yt-dlp writes NA rather than nothing.
  check('a missing field is not treated as a name', parseReport('C:\\downloads\\clip.mp4\tclip\tNA\tNA')?.channel, '')
  check('a missing length is zero', parseReport('C:\\downloads\\clip.mp4\tclip\tNA\tNA')?.duration, 0)
  check('an empty report is nothing', parseReport(''), null)
  check('a report with no path is nothing', parseReport('\ttitle\tchannel\t10'), null)

  check('a copy fetched today is not stale', isStale(Date.now()), false)
  check('a copy from last month is stale', isStale(Date.now() - 40 * 24 * 60 * 60 * 1000), true)

  // --- Addresses in a reply ----------------------------------------------

  const parts = splitLinks('Watch https://youtu.be/abc123 for a good one.')
  check('an address is picked out of a sentence', parts[1], { kind: 'link', value: 'https://youtu.be/abc123' })
  check('the words around it are kept', parts.map((part) => part.kind), ['text', 'link', 'text'])
  check('a full stop belongs to the sentence', splitLinks('See https://example.com/page.')[1], {
    kind: 'link',
    value: 'https://example.com/page',
  })
  check('text with no address is left alone', splitLinks('nothing here'), [{ kind: 'text', value: 'nothing here' }])
  check('a bare host reads as itself', linkLabel('https://www.youtube.com/'), 'youtube.com')
  check('a long address is shortened', linkLabel(`https://example.com/${'a'.repeat(90)}`).endsWith('…'), true)

  // --- Through the bridge -------------------------------------------------

  const asked: string[] = []
  let state = project()

  const desktopStub = {
    web: {
      search: async (query: string) => {
        asked.push(`search(${query})`)
        return {
          query,
          answer: 'Chapter 6 began in December.',
          articles: [{ title: 'Fortnite', summary: '', url: 'https://en.wikipedia.org/wiki/Fortnite', source: 'Wikipedia' }],
        }
      },
      media: async (query: string, kind: string) => {
        asked.push(`media(${query},${kind})`)
        return {
          query,
          kind,
          results: [
            { title: 'Sad Cat', url: 'https://i.example/sad.jpg', pageUrl: 'https://p.example/sad', source: 'Imgflip', license: 'Meme template, free to use', extension: 'jpg', kind: 'image' },
            { title: 'Crying Jordan', url: 'https://i.example/cry.jpg', pageUrl: 'https://p.example/cry', source: 'Imgflip', license: 'Meme template, free to use', extension: 'jpg', kind: 'image' },
          ],
        }
      },
      videos: async (query: string) => {
        asked.push(`videos(${query})`)
        return {
          query,
          videos: [{ title: 'A Montage', url: 'https://www.youtube.com/watch?v=abc', channel: 'ClipMaster', length: '4:20' }],
          searchUrl: 'https://www.youtube.com/results?search_query=x',
        }
      },
      download: async (url: string, name: string) => {
        asked.push(`download(${url},${name})`)
        return { path: `C:/downloads/${name || 'file'}.jpg`, name: `${name || 'file'}.jpg`, size: 51_200 }
      },
      youtube: async (url: string) => {
        asked.push(`youtube(${url})`)
        return {
          path: 'C:/downloads/A Montage [abc].mp4',
          name: 'A Montage [abc].mp4',
          size: 40 * 1024 * 1024,
          title: 'A Montage',
          channel: 'ClipMaster',
          duration: 260,
        }
      },
      onProgress: () => () => {},
      open: async () => true,
    },
  }

  const bridge = createHostBridge({
    getState: () => state,
    applyState: (next) => {
      state = next
    },
    importDialog: async () => [],
    importPaths: async (paths) => {
      const item = media(paths[0].split('/').pop() as string)
      state = { ...state, media: [...state.media, item] }
      return { items: [item], failed: [] }
    },
    desktop: desktopStub as unknown as NonNullable<Window['aicut']>,
  })

  const read = await bridge.searchWeb({ query: 'fortnite chapter 6' })
  check('a search reaches the desktop', asked.includes('search(fortnite chapter 6)'), true)
  check('the answer is reported', read.summary.includes('Chapter 6 began in December.'), true)
  check('the article is linked so it can be followed', read.summary.includes('https://en.wikipedia.org/wiki/Fortnite'), true)
  check('a search is not a failure', read.error, undefined)

  const listed = await bridge.findOnlineMedia({ query: 'losing', kind: 'meme' })
  check('a listing asks the right library', asked.includes('media(losing,meme)'), true)
  check('the results are numbered so one can be picked', listed.summary.includes('1. Sad Cat'), true)
  check('the licence is shown before anything is taken', listed.summary.includes('free to use'), true)
  check('nothing is downloaded just to look', asked.some((entry) => entry.startsWith('download(')), false)

  const second = await bridge.addOnlineMedia({ choice: 2 })
  check('a numbered choice takes that one', asked.includes('download(https://i.example/cry.jpg,Crying Jordan)'), true)
  check('the download lands in the library', state.media.length, 1)
  check('the reply names the file', second.summary.includes('Crying Jordan.jpg'), true)
  check('the reply credits the source', second.summary.includes('Imgflip'), true)
  check('the reply states the licence', second.summary.includes('free to use'), true)

  const missing = await bridge.addOnlineMedia({ choice: 9 })
  check('a number that is not in the list is refused', missing.error !== undefined, true)
  check('the refusal says how many there were', missing.summary.includes('2 results'), true)

  const straight = await bridge.addOnlineMedia({ query: 'winning', kind: 'meme' })
  check('a request with no listing searches first', asked.includes('media(winning,meme)'), true)
  check('the best match is taken without asking', straight.summary.includes('Sad Cat.jpg'), true)

  const watch = await bridge.findReferenceVideo({ query: 'gaming montages' })
  check('a reference search reaches the desktop', asked.includes('videos(gaming montages)'), true)
  check('a real link comes back', watch.summary.includes('https://www.youtube.com/watch?v=abc'), true)
  check('the channel and length are given', watch.summary.includes('ClipMaster (4:20)'), true)

  // --- Pulling a whole video down -----------------------------------------

  const pulled = await bridge.downloadVideo({ query: 'fortnite montage' })
  check('a download searches YouTube first', asked.includes('videos(fortnite montage)'), true)
  check('the top hit is what gets fetched', asked.includes('youtube(https://www.youtube.com/watch?v=abc)'), true)
  check('the file lands in the library', state.media.some((item) => item.name.includes('A Montage')), true)
  check('the reply names the video and channel', pulled.summary.includes('"A Montage" from ClipMaster'), true)
  check('the reply gives its size and length', pulled.summary.includes('4:20'), true)
  check('the reply says whose video it is', pulled.summary.includes('rather than yours'), true)
  check('the reply does not promise a safe clip length', /short enough to be exempt/.test(pulled.summary), true)
  check('a download is not a failure', pulled.error, undefined)

  // The list from find_reference_video is what "the first one" refers to.
  const byChoice = await bridge.downloadVideo({ choice: 1 })
  check('a numbered pick needs no fresh search', byChoice.error, undefined)
  const noSuch = await bridge.downloadVideo({ choice: 7 })
  check('a number past the end is refused', noSuch.error !== undefined, true)

  const direct = await bridge.downloadVideo({ url: 'https://youtu.be/xyz' })
  check('a given link is fetched as it stands', asked.includes('youtube(https://youtu.be/xyz)'), true)
  check('a given link skips the search', direct.error, undefined)

  // What went wrong for the user: the libraries have no gameplay, so the
  // request has to carry on to where the video actually is.
  const barren = createHostBridge({
    getState: () => state,
    applyState: (next) => {
      state = next
    },
    importDialog: async () => [],
    importPaths: async (paths) => {
      const item = media(paths[0].split('/').pop() as string)
      state = { ...state, media: [...state.media, item] }
      return { items: [item], failed: [] }
    },
    desktop: {
      web: {
        ...desktopStub.web,
        media: async (query: string, kind: string) => {
          asked.push(`media(${query},${kind})`)
          return { query, kind, results: [] }
        },
      },
    } as unknown as NonNullable<Window['aicut']>,
  })

  const fellBack = await barren.addOnlineMedia({ query: 'fortnite gaming montage', kind: 'video' })
  check('an empty library search for video carries on to YouTube', asked.includes('videos(fortnite gaming montage)'), true)
  check('the fallback actually brings the file back', fellBack.error, undefined)
  check('the fallback says where it came from', fellBack.summary.includes('ClipMaster'), true)

  const stillNothing = await barren.addOnlineMedia({ query: 'a quiet afternoon', kind: 'image' })
  check('an empty picture search does not go to YouTube', stillNothing.error !== undefined, true)

  const brokenLink = createHostBridge({
    getState: () => state,
    importDialog: async () => [],
    importPaths: async () => ({ items: [], failed: [] }),
    desktop: {
      web: { ...desktopStub.web, search: async () => ({ error: 'I could not reach the internet just now.' }) },
    } as unknown as NonNullable<Window['aicut']>,
  })
  const offline = await brokenLink.searchWeb({ query: 'anything' })
  check('being offline is reported as a failure', offline.error !== undefined, true)
  check('the failure says the internet was unreachable', offline.summary.includes('could not reach'), true)

  const browserOnly = createHostBridge({
    getState: () => project(),
    importDialog: async () => [],
    importPaths: async () => ({ items: [], failed: [] }),
  })
  check('without the desktop app there is no searching', (await browserOnly.searchWeb({ query: 'x' })).error !== undefined, true)
  check('without the desktop app there is no downloading', (await browserOnly.addOnlineMedia({ query: 'x' })).error !== undefined, true)

  console.log(failures === 0 ? '\nAll web checks passed.' : `\n${failures} check(s) failed.`)
  if (failures > 0) process.exitCode = 1
}

void main()
