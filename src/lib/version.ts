/**
 * What this build is, and what changed to get here. The list is the source of
 * truth for the version shown in the app, so a release is one entry added at
 * the top rather than a number edited in three places.
 */

export type Release = {
  version: string
  /** ISO date, so the entry says when as well as what. */
  date: string
  /** The headline for this release, in one line. */
  title: string
  changes: string[]
}

export const RELEASES: Release[] = [
  {
    version: '1.3.0',
    date: '2026-08-02',
    title: 'Leaving is as easy as arriving, and updates are on the dashboard',
    changes: [
      'Your name in the corner of the dashboard is now a menu. Signing out lives there, and so does deleting your account.',
      'Deleting asks "Sure?" before it does anything, then removes the account, every project in it and the conversations that went with them. There is no undo, and it says so.',
      'Check for updates is on the dashboard as well as in the editor. Waiting for a new version was never a good reason to have to open a project first.',
    ],
  },
  {
    version: '1.2.0',
    date: '2026-08-02',
    title: 'A forgotten password is no longer the end of an account',
    changes: [
      'There is a "Forgot your password?" link on the sign-in screen. It emails a six-digit code to the address on your account, and typing that code in lets you set a new password.',
      'The code lasts ten minutes and stops working after five wrong guesses, so nobody gets to sit and work through six digits.',
      'Getting it right signs you straight back in, and your projects are exactly where you left them.',
    ],
  },
  {
    version: '1.1.0',
    date: '2026-08-02',
    title: 'Accounts, so your projects stay yours',
    changes: [
      'The app opens on a sign-in screen. Create an account with your name, email and a password, and your projects live under that account on this computer.',
      'Sign out from the dashboard when someone else wants a turn. Their work will not mix with yours.',
      'Anything you already had saved before accounts existed is kept and handed to the first account you create.',
    ],
  },
  {
    version: '1.0.0',
    date: '2026-07-31',
    title: 'Your work gets kept, and you can ask what might get claimed',
    changes: [
      'Projects are saved. Everything you did used to disappear the moment the window closed; now the app opens on a dashboard of what you have been working on, and picks up where you left off.',
      'A project is a short, a full video or a mini-movie, and the choice sets the shape of the frame, the tracks you start with and what an export defaults to. You can rename one from the dashboard or from the title while you are editing.',
      'A Copyright button in the toolbar goes through the timeline and tells you what could get claimed, based on where each file came from — which channel a download came off, or which library and under what licence.',
      'It offers real fixes rather than tricks: muting borrowed footage, taking it out, or crediting the author where the licence asks for it. Each one shows you exactly what it would change before it changes anything.',
      'Mirroring, cropping and keeping cuts short are not offered, because they do not work. Content ID normalises all of that before it compares, and no length of someone else\'s work is automatically safe.',
      'You can also just ask the assistant "will this get claimed" and get the same answer in the chat.',
    ],
  },
  {
    version: '0.10.1',
    date: '2026-07-27',
    title: 'You can ask it to check for updates',
    changes: [
      'The bottom bar has a "Check for updates" button. It used to look once at startup and then not again for six hours, with no way to hurry it along and nothing on screen explaining the wait.',
      'It answers you either way now: "Up to date" when there is nothing new, rather than appearing to do nothing at all.',
    ],
  },
  {
    version: '0.10.0',
    date: '2026-07-27',
    title: 'It gets videos off YouTube now',
    changes: [
      '"Get me a fortnite montage from youtube" downloads the whole video into your media panel, ready to cut up. Paste a link and it fetches that one instead.',
      'Asking for a video no longer hands you a stranger. The free libraries have no gameplay in them, and rather than offering whatever was nearest, it now says so and goes to YouTube instead.',
      'It picks the best copy up to 1080p and merges picture and sound into one file. A progress figure shows while it runs.',
      'It is honest about what you can reuse. Your own recordings and the free libraries are yours to publish; a video off someone\'s channel is not, and it says so without pretending a short enough clip is exempt, because no such length exists.',
      'The downloader keeps itself current in the background, so it does not stop working every time YouTube changes something.',
    ],
  },
  {
    version: '0.9.0',
    date: '2026-07-26',
    title: 'It can go and look things up',
    changes: [
      'The assistant reaches the internet. "Find me a meme about losing" downloads one straight into your media panel, and the same works for footage, pictures, gifs and sound effects.',
      'It only pulls from libraries that state a licence — Openverse, Wikimedia Commons, the Internet Archive and Imgflip — and it tells you the licence every time, so nothing it hands you should earn a copyright strike.',
      '"Look up the new Fortnite season" reads around a subject before answering, so its advice and the hooks it writes are based on something rather than nothing.',
      '"Show me examples of good gaming montages" hands back real YouTube links to watch. Links in the chat are clickable and open in your browser.',
      'It chains steps on its own now: look it up, fetch the meme, place it, write the hook, all from one sentence.',
      'It will not download somebody else\'s YouTube video. That one is theirs.',
    ],
  },
  {
    version: '0.8.1',
    date: '2026-07-26',
    title: 'It keeps itself up to date',
    changes: [
      'AiCut checks for new versions on its own and fetches them quietly in the background. When one is ready, the bottom bar offers to restart into it.',
      'Nothing interrupts an edit: an update waits until you say so, or installs the next time you quit.',
      'It stays quiet when there is nothing to report, rather than announcing every check that found nothing.',
    ],
  },
  {
    version: '0.8.0',
    date: '2026-07-26',
    title: 'A program of its own',
    changes: [
      'AiCut installs like any other program now, with its own name and icon. Pinning it to the taskbar and reopening it gets you AiCut rather than something called Electron.',
      'ffmpeg ships inside the installed app, so there is no terminal window to leave open and nothing to set up on a new machine.',
      'A Clear button at the top of the chat, so a finished conversation can be put away without digging through settings.',
      'Clearing is a fresh page, not amnesia: what you have taught it and your timeline both survive, and the empty chat says how much it still remembers.',
    ],
  },
  {
    version: '0.7.1',
    date: '2026-07-26',
    title: 'It takes the point',
    changes: [
      '"Generate a video about fortnite" now draws the card it was always able to draw. Asking for a "video" rather than an "intro" used to stop it dead, which made generating look broken after it had just worked.',
      'Whatever the video is about becomes the words on the card, and the reply still says plainly that it is a card rather than footage.',
      '"Make me a 5 second intro" is understood as well as "generate" one, instead of going unanswered.',
      'A title card no longer comes out with the word "card" written across it.',
      'Asking for a clip of your own gameplay still goes looking for your recording rather than drawing over it.',
    ],
  },
  {
    version: '0.7.0',
    date: '2026-07-26',
    title: 'It makes things, and it remembers',
    changes: [
      'Cards drawn from nothing: "generate a 5 second intro that says Fortnite Highlights" renders a real clip with ffmpeg, imports it and drops it on the timeline.',
      'Asked for footage it cannot film, it says so plainly instead of claiming it is done, and offers the card or a hunt through your own recordings.',
      'No more "Done." for nothing: when a model answers with silence, the reply says what the tools actually did — including when the file picker was closed without importing.',
      'The conversation is kept on this computer and comes back when you reopen the app, along with what the model had been told.',
      'A preference mentioned in passing is remembered even if the model does not think to write it down.',
      'A Stop button appears above Send once a reply has taken ten seconds, and it really does abandon the request.',
    ],
  },
  {
    version: '0.6.0',
    date: '2026-07-26',
    title: 'It talks back',
    changes: [
      'The assistant holds a conversation as well as taking orders: ask what it can do, how to make a short worth watching, where your files went, or whether any of this costs money.',
      'Questions are no longer mistaken for instructions, so "how do I make a short" gets an answer instead of a cut.',
      'Answers work with no model at all, and a free model — Ollama on this computer, or a free-tier key — opens it up to anything you want to talk about.',
      'A connected model is told to talk plainly and only reach for a tool when there is something to change.',
      'A setup walkthrough for a free local model, and "npm run check:model" to prove it is wired up before you rely on it.',
    ],
  },
  {
    version: '0.5.0',
    date: '2026-07-26',
    title: 'Smoother by design',
    changes: [
      'New type throughout: Sora for headings and numbers, Manrope for everything else, so timecodes read like an interface rather than a terminal.',
      'Digits hold their column as they tick, so nothing jitters during playback.',
      'Softer panels with depth and blur, lit clip edges, a glowing playhead and a ruler that fades instead of ruling hard lines.',
      'One easing curve and one duration behind every hover, drag and pop-in, and all of it stills for reduced-motion.',
      'Transport icons are drawn rather than typed, so they cannot fall back to a stray glyph.',
    ],
  },
  {
    version: '0.4.0',
    date: '2026-07-26',
    title: 'Made for YouTube',
    changes: [
      'Text on screen: meme captions, hooks in the middle of the frame, and lower-third captions, drawn into the export.',
      'Drop a meme, a reaction or a sound effect in at a moment; the assistant finds the file on disk if it is not imported.',
      'Punch in on the action, and turn any clip into a corner inset.',
      'Build a montage from several clips, each cut to its liveliest few seconds.',
      'Folder names like "documents" now reach the real folder, so a search there finds what is in it.',
      'A version and its history along the bottom of the window.',
      'A launcher, so the app can be reopened by double-clicking rather than through a terminal.',
    ],
  },
  {
    version: '0.3.0',
    date: '2026-07-25',
    title: 'Shorts without a subscription',
    changes: [
      'make_short listens to a clip, cuts to the liveliest stretch, reframes it vertical and moves it to the start.',
      'Dead air removal, highlight reports and clip splitting, all measured with ffmpeg on this computer.',
      'Clips can use part of a file, so trimming no longer throws the rest away.',
      'One-click setup for free local models (Ollama, LM Studio) and free hosted tiers, with a fallback to the built-in commands.',
    ],
  },
  {
    version: '0.2.0',
    date: '2026-07-24',
    title: 'An assistant with hands',
    changes: [
      'The AI panel became a chat that edits the project by calling tools.',
      'It can read folders on this computer, import what it finds, and remember standing instructions.',
      'Export to mp4, webm or mov with ffmpeg, and publish straight to a connected YouTube channel.',
    ],
  },
  {
    version: '0.1.0',
    date: '2026-07-23',
    title: 'The editor',
    changes: [
      'Import media, drag it onto a timeline of video and audio tracks, and snap clips together.',
      'Crop clips to an aspect ratio, scrub and play back, and rearrange the panels.',
    ],
  },
]

export const APP_VERSION = RELEASES[0].version

export const CURRENT_RELEASE = RELEASES[0]

/** Bumped whenever the release notes should be shown again. */
export const SEEN_VERSION_KEY = 'aicut.seenVersion.v1'
