import type { ToolCall, ToolName } from './types'

type JsonSchema = {
  type: 'object'
  properties: Record<string, unknown>
  required?: string[]
}

export type ToolSpec = {
  name: ToolName
  description: string
  parameters: JsonSchema
}

const TIME_DESCRIPTION =
  'Seconds, a timecode like "1:30", "playhead" for the current position, or "end" for the end of the track.'

const CLIP_DESCRIPTION =
  'Which clip: its name, its id, "selected" for the highlighted clip, or "last" for the most recently added.'

export const TOOL_SPECS: ToolSpec[] = [
  {
    name: 'describe_project',
    description:
      'Read the current project: imported media, timeline clips, tracks, playhead. Call this before editing when you need to know what exists.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'import_media',
    description:
      'Open the file picker so the user can choose video, audio, or image files to import. Use when the project has no media or the user asks to import or add files.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'add_clip',
    description: 'Place an imported media item onto a timeline track as a new clip.',
    parameters: {
      type: 'object',
      properties: {
        media: { type: 'string', description: 'Media name or id. Omit when only one item is imported.' },
        track: { type: 'string', description: 'Track name or id. Defaults to the first track that accepts this media.' },
        start: { type: 'string', description: TIME_DESCRIPTION },
      },
      required: ['media'],
    },
  },
  {
    name: 'move_clip',
    description: 'Move a clip to a new start time, optionally onto a different track.',
    parameters: {
      type: 'object',
      properties: {
        clip: { type: 'string', description: CLIP_DESCRIPTION },
        start: { type: 'string', description: TIME_DESCRIPTION },
        track: { type: 'string', description: 'Track name or id to move onto.' },
      },
      required: ['clip'],
    },
  },
  {
    name: 'trim_clip',
    description: 'Change how long a clip plays for. Give either a duration or an end time.',
    parameters: {
      type: 'object',
      properties: {
        clip: { type: 'string', description: CLIP_DESCRIPTION },
        duration: { type: 'string', description: 'New length in seconds or as a timecode.' },
        end: { type: 'string', description: 'New end time on the timeline.' },
      },
      required: ['clip'],
    },
  },
  {
    name: 'use_range',
    description:
      'Keep only part of a clip\'s source file, for example the twenty seconds where something happens. Times are seconds into the file, not positions on the timeline.',
    parameters: {
      type: 'object',
      properties: {
        clip: { type: 'string', description: CLIP_DESCRIPTION },
        from: { type: 'string', description: 'Where in the file to start, in seconds or as a timecode.' },
        to: { type: 'string', description: 'Where in the file to stop.' },
      },
      required: ['from', 'to'],
    },
  },
  {
    name: 'split_clip',
    description: 'Cut a clip in two at a point on the timeline, leaving both halves in place.',
    parameters: {
      type: 'object',
      properties: {
        clip: { type: 'string', description: CLIP_DESCRIPTION },
        at: { type: 'string', description: TIME_DESCRIPTION },
      },
      required: ['at'],
    },
  },
  {
    name: 'delete_clip',
    description: 'Remove a clip from the timeline. The media stays in the library.',
    parameters: {
      type: 'object',
      properties: { clip: { type: 'string', description: CLIP_DESCRIPTION } },
      required: ['clip'],
    },
  },
  {
    name: 'crop_clip',
    description:
      'Crop a clip to an aspect ratio, or clear an existing crop. Audio clips cannot be cropped.',
    parameters: {
      type: 'object',
      properties: {
        clip: { type: 'string', description: CLIP_DESCRIPTION },
        aspect: {
          type: 'string',
          description: 'One of "16:9", "1:1", "4:5", "9:16", or "reset" to remove the crop.',
        },
      },
      required: ['aspect'],
    },
  },
  {
    name: 'add_track',
    description: 'Add a video or audio track to the timeline.',
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string', description: '"video" or "audio".' },
        name: { type: 'string', description: 'Optional name for the new track.' },
      },
      required: ['kind'],
    },
  },
  {
    name: 'rename_track',
    description: 'Rename a track.',
    parameters: {
      type: 'object',
      properties: {
        track: { type: 'string', description: 'Track name or id.' },
        name: { type: 'string', description: 'New name.' },
      },
      required: ['track', 'name'],
    },
  },
  {
    name: 'remove_track',
    description: 'Delete a track and every clip on it. One track of each kind always remains.',
    parameters: {
      type: 'object',
      properties: { track: { type: 'string', description: 'Track name or id.' } },
      required: ['track'],
    },
  },
  {
    name: 'set_zoom',
    description: 'Set the timeline zoom in pixels per second, between 4 and 120.',
    parameters: {
      type: 'object',
      properties: { zoom: { type: 'string', description: 'Pixels per second, or "in"/"out"/"fit".' } },
      required: ['zoom'],
    },
  },
  {
    name: 'seek',
    description: 'Move the playhead.',
    parameters: {
      type: 'object',
      properties: { time: { type: 'string', description: TIME_DESCRIPTION } },
      required: ['time'],
    },
  },
  {
    name: 'list_folder',
    description:
      'List a folder on the user\'s computer, showing sub-folders and media files. Omit the path to see the usual places media lives. A folder word such as "documents", "downloads" or "videos" works as well as a full path.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Absolute folder path, or a folder name like "documents". Omit for the common media folders.',
        },
      },
    },
  },
  {
    name: 'find_media',
    description:
      'Search the computer for media files whose name matches some text, looking through Videos, Downloads, Documents, Desktop, Pictures and Music and their sub-folders. Use this to locate a file the user mentions before importing it. Leave the query empty to list everything playable in a folder.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Part of the file name to look for. Empty lists everything in the folder.' },
        folder: {
          type: 'string',
          description: 'Folder to search under: a full path, or a name like "documents". Defaults to all the usual folders.',
        },
      },
    },
  },
  {
    name: 'import_file',
    description:
      'Import specific files from disk by absolute path, without asking the user to pick them. Use paths returned by find_media or list_folder.',
    parameters: {
      type: 'object',
      properties: {
        paths: { type: 'array', items: { type: 'string' }, description: 'Absolute file paths to import.' },
      },
      required: ['paths'],
    },
  },
  {
    name: 'remember',
    description:
      'Store a standing instruction or preference so it survives future sessions, for example how the user likes clips cropped or named.',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string', description: 'The instruction to keep, written as a short sentence.' } },
      required: ['text'],
    },
  },
  {
    name: 'forget',
    description: 'Drop a remembered instruction. Pass "all" to clear everything.',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string', description: 'Part of the note to drop, or "all".' } },
      required: ['text'],
    },
  },
  {
    name: 'list_memory',
    description: 'List everything the user has taught you.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'make_short',
    description:
      'Turn footage into a vertical short in one step: finds the liveliest stretch by listening to the audio, cuts to it, reframes to 9:16 and moves it to the start of the timeline. This is the right tool for "make this a YouTube short", "make a TikTok", or "cut this down to the best bit". Follow it with export_project or publish_youtube if the user wants the file or the upload.',
    parameters: {
      type: 'object',
      properties: {
        clip: { type: 'string', description: `${CLIP_DESCRIPTION} Omit to use the only clip, or the first video imported.` },
        duration: { type: 'number', description: 'Target length in seconds. Defaults to 30, never more than 60.' },
        aspect: { type: 'number', description: 'Width divided by height. Defaults to 0.5625 for 9:16.' },
        reframe: { type: 'boolean', description: 'Set false to keep the original framing.' },
      },
    },
  },
  {
    name: 'remove_silence',
    description:
      'Cut the dead air out of a clip: measures the audio, drops the silent stretches, and closes the gaps. Use for "cut the boring parts", "remove the silence", or tightening a talking clip.',
    parameters: {
      type: 'object',
      properties: {
        clip: { type: 'string', description: CLIP_DESCRIPTION },
        padding: { type: 'number', description: 'Seconds of air kept either side of speech. Defaults to 0.15.' },
      },
    },
  },
  {
    name: 'find_highlight',
    description:
      'Report the liveliest stretches of a clip without changing anything, so you can tell the user what you found or pick one with use_range.',
    parameters: {
      type: 'object',
      properties: {
        clip: { type: 'string', description: CLIP_DESCRIPTION },
        duration: { type: 'number', description: 'Length of window to look for, in seconds. Defaults to 30.' },
        count: { type: 'number', description: 'How many windows to report, up to 5. Defaults to 3.' },
      },
    },
  },
  {
    name: 'analyze_clip',
    description:
      'Measure a clip\'s audio: how long it is, how loud it is on average, where it peaks, and how much silence it contains.',
    parameters: {
      type: 'object',
      properties: { clip: { type: 'string', description: CLIP_DESCRIPTION } },
    },
  },
  {
    name: 'add_text',
    description:
      'Burn a line of text into the picture: a hook at the start, a meme caption, a title card, or a label. Styles are "meme" (big white words with a heavy outline, across the top), "title" (a hook in the middle of the frame) and "caption" (a smaller line along the bottom).',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The words to show. One line.' },
        at: { type: 'string', description: TIME_DESCRIPTION },
        duration: { type: 'number', description: 'How long it stays up, in seconds. Defaults to 3.' },
        style: { type: 'string', description: '"meme", "title", or "caption".' },
        position: { type: 'string', description: '"top", "middle", or "bottom". Defaults to what the style implies.' },
      },
      required: ['text'],
    },
  },
  {
    name: 'remove_text',
    description: 'Remove text from the picture, by what it says or "all".',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string', description: 'Part of the words to remove, or "all".' } },
    },
  },
  {
    name: 'insert_cutaway',
    description:
      'Drop a meme, a reaction clip, an image or a sound effect in at a moment. Finds the file on disk if it is not imported yet. Video and images land on a lane above the footage: in a corner when something is already on screen, filling the frame when nothing is. Sound effects go on an audio track.',
    parameters: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'Name of the meme, sound or image, or an absolute path.' },
        at: { type: 'string', description: TIME_DESCRIPTION },
        duration: { type: 'number', description: 'How long it plays, in seconds. Defaults to about 2.5.' },
        placement: {
          type: 'string',
          description: '"full", "top-left", "top-right", "bottom-left", "bottom-right", or "center".',
        },
        size: { type: 'number', description: 'Scales a corner inset, where 1 is the standard size.' },
      },
      required: ['file'],
    },
  },
  {
    name: 'place_clip',
    description:
      'Move a clip that is already on the timeline into a corner of the frame, or back to filling it. Use for turning a facecam or a reaction into a picture-in-picture.',
    parameters: {
      type: 'object',
      properties: {
        clip: { type: 'string', description: CLIP_DESCRIPTION },
        placement: {
          type: 'string',
          description: '"full", "top-left", "top-right", "bottom-left", "bottom-right", or "center".',
        },
        size: { type: 'number', description: 'Scales the inset, where 1 is the standard size.' },
      },
      required: ['placement'],
    },
  },
  {
    name: 'punch_in',
    description:
      'Push the picture in on a moment for emphasis, the way gaming edits do on a kill or a reaction. Cuts the clip around the moment and crops that piece tighter. With no time given, it listens for the loudest moment and uses that.',
    parameters: {
      type: 'object',
      properties: {
        clip: { type: 'string', description: CLIP_DESCRIPTION },
        at: { type: 'string', description: TIME_DESCRIPTION },
        duration: { type: 'number', description: 'How long the punch-in lasts, in seconds. Defaults to 2.5.' },
        amount: { type: 'number', description: 'How much closer, where 1.6 is the default.' },
      },
    },
  },
  {
    name: 'make_montage',
    description:
      'Cut several clips into a montage: measures each imported video, takes its liveliest few seconds, and lays them end to end on the main video track. Replaces whatever is on that track.',
    parameters: {
      type: 'object',
      properties: {
        each: { type: 'number', description: 'Seconds taken from each clip. Defaults to 5.' },
        count: { type: 'number', description: 'How many clips to use. Defaults to all of them, up to 12.' },
        duration: { type: 'number', description: 'Total length to aim for, which sets the per-clip length.' },
      },
    },
  },
  {
    name: 'generate_clip',
    description:
      'Draw a new video clip from nothing and put it on the timeline: a title card, an end card, an intro, a "subscribe" card, or a plain coloured background for words to sit on. This is the only way you can make footage that does not exist yet, and it is a drawn card — it cannot be a recording of gameplay or of anything real. Use it for "generate an intro that says Fortnite Highlights", "make a title card", or "make me a 5 second outro". When someone asks for footage of a real thing, say plainly that you cannot film it, then offer this or offer to find their own recording with find_media.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Words to draw on it. Keep it short, a few words. Omit for a plain background.' },
        seconds: { type: 'number', description: 'How long it lasts. Defaults to 5, at most 30.' },
        aspect: { type: 'string', description: '"16:9" or "9:16". Defaults to matching the timeline.' },
        look: { type: 'string', description: 'dark, accent or light. Defaults to dark.' },
        at: { type: 'string', description: 'Where it goes on the timeline. Defaults to the playhead.' },
      },
    },
  },
  {
    name: 'search_web',
    description:
      'Read up on something on the internet and get back an answer and a few articles to follow. Use it whenever knowing the actual facts would make your reply better: what a game just patched, what a trend is, how long a Short can be, what a word means, who someone is. Also use it before writing titles, descriptions or hooks about a subject you are hazy on, rather than guessing. It only reads; it changes nothing in the project.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to look up, phrased as you would type it into a search box.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'find_online_media',
    description:
      'Search the free media libraries for pictures, footage, gifs, memes or sound the user is allowed to use, and list what is there with its licence. Nothing is downloaded and the project does not change: this is for showing the options. If they plainly just want it in the project, call add_online_media instead and skip this step.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What the material should show, such as "surprised cat" or "rain on a window".' },
        kind: {
          type: 'string',
          description: '"image", "video", "gif", "audio", or "meme". Defaults to image.',
        },
        count: { type: 'number', description: 'How many to list. Defaults to 5.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'add_online_media',
    description:
      'Download something from the free libraries and put it in the media panel, ready to drag onto the timeline. This is the tool for "find me a meme about losing", "get some rain footage", or "add a swoosh sound". Give it a query and it searches and takes the best match by itself. Give it choice: 2 to take the second thing you just listed, or a direct url when you already have one. Follow it with insert_cutaway or add_clip if it should go on the timeline too.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to find. Omit only when passing a url or a choice.' },
        kind: {
          type: 'string',
          description: '"image", "video", "gif", "audio", or "meme". Defaults to image.',
        },
        choice: { type: 'number', description: 'Take this one out of the results you last listed, counting from 1.' },
        url: { type: 'string', description: 'A direct link to the file, when you already have one.' },
      },
    },
  },
  {
    name: 'find_reference_video',
    description:
      'Find videos on YouTube to watch as a reference and hand back real links. Use it for "show me a good example of a Fortnite montage", "what does a good hook look like", or when your advice would land better with something to watch. This lists links without downloading anything; use download_video when they want the file.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What the reference should show.' },
        count: { type: 'number', description: 'How many links. Defaults to 4.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'download_video',
    description:
      'Download a whole YouTube video into the media panel as a file they can cut up. Use it when they ask to get, grab or download an actual video rather than a link, and the free libraries have nothing — gameplay, montages, trailers and anything else from a real channel live only on YouTube. Pass a url when you have one, a query to search and take the top hit, or choice to take one of the videos you last listed. The whole video comes down; they trim it themselves.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to search YouTube for. Omit when passing a url or a choice.' },
        url: { type: 'string', description: 'A YouTube link, when you already have one.' },
        choice: { type: 'number', description: 'Take this one out of the videos you last listed, counting from 1.' },
      },
    },
  },
  {
    name: 'export_project',
    description:
      'Render the timeline to a video file on disk. Omit the output path to let the user choose where it goes.',
    parameters: {
      type: 'object',
      properties: {
        output: { type: 'string', description: 'Absolute output file path. Omit to open a save dialog.' },
        format: { type: 'string', description: 'Container: mp4, webm, or mov. Defaults to mp4.' },
        resolution: { type: 'string', description: 'Output size such as "1920x1080", "1080p", or "vertical".' },
      },
    },
  },
  {
    name: 'youtube_status',
    description: 'Check whether a YouTube channel is connected, and which one.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'check_copyright',
    description:
      'Look over the timeline for anything that could draw a copyright claim or strike on YouTube, based on ' +
      'where each file came from, and report what could be done about it. Use this whenever the user asks ' +
      'whether their video is safe to upload, will get flagged, claimed, struck, or demonetised. Never ' +
      'suggest mirroring, cropping, changing the speed or keeping clips short as a way around Content ID: ' +
      'none of it works, and no length of someone else\'s work is automatically safe.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'publish_youtube',
    description:
      'Export the timeline and upload it to the connected YouTube channel. Uploads are private unless the user asks otherwise.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Video title.' },
        description: { type: 'string', description: 'Video description.' },
        visibility: { type: 'string', description: '"private", "unlisted", or "public". Defaults to private.' },
        tags: { type: 'string', description: 'Comma-separated tags.' },
        short: { type: 'boolean', description: 'Publish as a Short. Set when the video is vertical and under a minute.' },
      },
      required: ['title'],
    },
  },
]

/** The tool list in the shape an OpenAI-compatible endpoint expects. */
export const API_TOOLS = TOOL_SPECS.map((spec) => ({
  type: 'function' as const,
  function: { name: spec.name, description: spec.description, parameters: spec.parameters },
}))

const TOOL_NAMES = new Set<string>(TOOL_SPECS.map((spec) => spec.name))

export function isToolName(value: unknown): value is ToolName {
  return typeof value === 'string' && TOOL_NAMES.has(value)
}

export const SYSTEM_PROMPT = [
  'You are the editing assistant inside AiCut, a desktop video editor.',
  "Calling tools is the only way you can change the user's project; everything else you say is conversation.",
  'Hold that conversation properly. Answer questions, explain how the editor works, talk through what would make their video better, and follow them off topic if that is where they go. Call a tool only when they want the project changed, and never invent an edit as a way of replying.',
  'Work in small concrete steps and prefer acting over asking. If a request is ambiguous but has an obvious reading, take it.',
  'Call describe_project when you need to know what media, clips, or tracks exist before editing.',
  'You can read the user\'s files: list_folder and find_media locate media on disk, import_file brings specific paths in, and import_media opens the picker when you have nothing to go on. Never invent file paths.',
  'Times are seconds on the timeline. Clips never overlap: the editor slides a clip to the nearest free slot, so report where it actually landed.',
  'Prefer the tool that does the whole job. For "make this a YouTube short", a TikTok, a Reel, or "cut this to the best part", call make_short once: it listens to the audio, cuts to the liveliest stretch, reframes to 9:16 and moves it to the start. Do not hand-assemble that from crop_clip and trim_clip.',
  'remove_silence tightens a clip by dropping dead air. find_highlight and analyze_clip tell you what is in the audio without changing anything. use_range keeps a chosen stretch of a file, and split_clip cuts a clip in two.',
  'Do not ask which moment to keep when you can measure it. Act, then say what you picked and offer to move it.',
  'For YouTube work: add_text burns in a hook, a meme caption or a title; insert_cutaway drops a meme, a reaction or a sound effect in at a moment and finds the file itself; punch_in pushes the picture in on the action; make_montage cuts several clips down to their best moments back to back; place_clip turns a clip into a corner inset.',
  'A short wants a hook in the first couple of seconds. When you make one and the user has not written the words, offer a hook rather than inventing a claim about their footage.',
  'You cannot film or invent footage, and you must never pretend otherwise: there is no text-to-video here. Do not let that turn into refusing to act. When someone asks you to generate a video about a subject, call generate_clip to draw a card carrying that subject as its words, then say in one sentence that it is a card rather than footage. Only when they plainly mean their own recording — "a clip of my gameplay", "the match I recorded" — reach for find_media instead and hunt it down on disk.',
  'You can reach the internet, so stop guessing at things you could simply check. search_web reads around a subject and hands back an answer and links; use it before writing a title, a description or a hook about something you are hazy on, and any time a fact would sharpen your advice. find_online_media searches the free libraries and lists what is there, add_online_media downloads the best match straight into their media panel, and find_reference_video hands back real YouTube links to watch.',
  'download_video pulls a whole YouTube video in as a file. Reach for it when they want footage rather than a link and the free libraries have nothing, which is the usual case for gameplay, montages and anything from a real channel. Try add_online_media first when the subject is something the openly licensed libraries plausibly hold, because that footage is theirs to keep.',
  'Say where a file came from and how it is licensed when you add one. Be straight about the difference: their own recordings and the free libraries are theirs to publish, while a video off somebody\'s channel is not, and putting it in an upload risks a Content ID claim or a strike. Never tell them a short clip is exempt. There is no length that copyright ignores, no ten-second rule and no percentage rule; Content ID matches a couple of seconds quite happily, and background music is what it catches most. If they are set on using a piece of someone\'s video anyway, say the risk once, plainly, and then do as they asked.',
  'Chain these without being walked through it. "Find me a meme about losing and put it at the end" is add_online_media then insert_cutaway. "Make a short about the new season" is search_web to learn what the season is, then make_short, then add_text with a hook that reflects what you read. Take the next obvious step yourself and report the lot in one reply; ask only when a choice is genuinely theirs to make.',
  'The one thing you will not do, however it is phrased, is pretend a drawn card is real footage.',
  'Use remember when the user states a lasting preference, and follow anything already remembered, including where they keep their memes or sound effects.',
  'export_project renders the timeline to a file, at 1080x1920 when the clips are vertical. publish_youtube exports and uploads to the connected channel; uploads default to private, and you should not make something public unless the user says so.',
  'After your tool calls, reply with one or two short sentences describing what changed. Talk in plain sentences either way: no markdown headings and no bullet lists.',
].join(' ')

/** Model output is untrusted, so calls are shaped before they reach the runtime. */
export function normalizeToolCall(name: unknown, rawArgs: unknown): ToolCall | null {
  if (!isToolName(name)) return null

  let args: Record<string, unknown> = {}
  if (typeof rawArgs === 'string' && rawArgs.trim()) {
    try {
      const parsed = JSON.parse(rawArgs)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        args = parsed as Record<string, unknown>
      }
    } catch {
      return null
    }
  } else if (rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)) {
    args = rawArgs as Record<string, unknown>
  }

  return { name, args }
}
