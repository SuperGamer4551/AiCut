/**
 * Talking, as opposed to editing. A connected model holds a real conversation;
 * this is what the assistant can say on its own, so the panel answers questions
 * about itself, about making videos, and about what a model would cost — which
 * is nothing, if you pick one of the free ones.
 *
 * Nothing here changes the project. It runs only after the command interpreter
 * has found no instruction in the message.
 */

export type ChatContext = {
  /** Whether a model is also answering, which changes what is worth offering. */
  connected: boolean
  clips: number
  media: number
}

export type Answer = {
  /** Which topic replied, which is what the assertions pin down. */
  topic: string
  text: string
}

const FREE_MODELS =
  'Open-ended conversation is free: run Ollama or LM Studio on this computer and there is nothing to sign up for and nothing to pay, or paste a free-tier key from Groq, Google AI Studio or OpenRouter into the settings above.'

const CAN_DO =
  'I can look through your folders and import what I find, search the internet for memes, footage, pictures and sound you are allowed to use and drop them straight into your media, download a whole video off YouTube for you to cut up, read up on a subject before we talk about it, point you at videos worth watching, cut a recording down to its best moment, make it vertical for a short, drop the dead air, add text and memes, punch in on the action, build a montage, draw title and end cards, then render it or publish it to YouTube.'

function nothingYet(context: ChatContext): string {
  if (context.clips > 0) return `You have ${context.clips === 1 ? 'a clip' : `${context.clips} clips`} on the timeline.`
  if (context.media > 0) return 'Your media is imported, so drag a clip onto a track and we can start.'
  return 'Import a clip and we can start.'
}

type Topic = {
  id: string
  /** Matched against the message in lower case. */
  test: RegExp
  answer: (context: ChatContext) => string
}

/**
 * A question rather than an instruction. "Make this a short" is work; "how do I
 * make a short" is a conversation, and the interpreter hands it over here.
 */
export const ASKING = new RegExp(
  [
    '^(?:so |ok(?:ay)?,? |hey,? |and )?',
    '(?:',
    'how (?:do|can|would|should|might) (?:i|we|you)\\b',
    '|how (?:does|is|would) (?:this|that|it|the)\\b',
    '|what(?:\'s| is| are) (?:the best|a good|your)\\b',
    '|what should i\\b',
    '|what can you\\b',
    '|what (?:do|would) you (?:think|reckon|suggest|recommend|do)\\b',
    '|does (?:it|this|that|the app|any)\\b',
    '|will (?:it|this|that)\\b',
    '|tell me (?:a|an|about|the)\\b',
    '|why\\b',
    '|should i\\b',
    '|is (?:it|this|that) (?:possible|ok|okay|better|free|worth)\\b',
    '|do (?:i|you) (?:need|have to|support)\\b',
    '|what happens\\b',
    '|tell me about\\b',
    '|any (?:tips|advice|ideas)\\b',
    ')',
  ].join(''),
  'i',
)

const TOPICS: Topic[] = [
  {
    id: 'greeting',
    test: /^(?:hi|hey|hello|yo|sup|hiya|howdy|good (?:morning|afternoon|evening))\b/,
    answer: (context) => `Hey. ${nothingYet(context)} Tell me what you want it to end up as and I will do the cutting.`,
  },
  {
    id: 'thanks',
    test: /\b(?:thanks|thank you|thx|ty|cheers|appreciate it|nice one)\b/,
    answer: () => 'Any time. Say the word when you want the next edit.',
  },
  {
    id: 'praise',
    test: /\b(?:good job|nice work|well done|that(?:'s| is) (?:great|perfect|sick|clean)|you(?:'re| are) (?:doing )?(?:great|awesome|the best|good)|love (?:this|it)|amazing|impressive)\b/,
    answer: () => 'Glad it landed. Point me at the next clip whenever you are ready.',
  },
  {
    id: 'apology',
    test: /\b(?:sorry|my bad|my mistake|oops)\b/,
    answer: () => 'Nothing to apologise for. Tell me what you meant and I will redo it.',
  },
  {
    id: 'mood',
    test: /\b(?:how are you|how(?:'s| is) it going|you good|hows your day)\b/,
    answer: () => 'Running fine and nothing queued. What are we making?',
  },
  {
    id: 'farewell',
    test: /^(?:bye|goodbye|good ?night|see you|later|that(?:'s| is) (?:it|all|enough))\b/,
    answer: () => 'Right then. Export before you close the window if you want to keep it.',
  },
  {
    id: 'ack',
    test: /^(?:ok(?:ay)?|k|sure|yeah?|yep|yes|no|nope|nah|cool|nice|right|got it|fine|hmm+|never ?mind|wait)[\s.!]*$/,
    answer: (context) => `Standing by. ${nothingYet(context)}`,
  },
  {
    id: 'invent',
    test: /\b(?:generate|create|make|produce|render|invent|draw)\b[^.?!]{0,30}?\b(?:video|clip|footage|scene|animation|movie)\b|\btext[ -]?to[ -]?video\b|\bai[ -]?generated\b/,
    answer: () =>
      'I cannot film anything, and I will not pretend to: there is no text-to-video in here, so footage of a real match or a real place has to come from your own recording. What I can make from nothing is a card — "generate a 5 second intro that says Fortnite Highlights" renders one and puts it on the timeline. For the gameplay itself, say "find my fortnite clips in my videos folder" and I will cut what you already have.',
  },
  {
    id: 'trouble',
    test: /\b(?:not working|does ?n[o']t work|broken|crashed?|frozen|froze|stuck|failed|nothing happens|black screen|no sound|why (?:is|isn't|is not) (?:it|this|nothing))\b/,
    answer: () =>
      'Tell me what you were doing and I will say what I can see. Worth checking first: the small black window that started the app has to stay open, a clip needs to be selected for most edits, and an export that fails usually says which file it could not read.',
  },
  {
    id: 'identity',
    test: /\b(?:who are you|what are you|your name|who (?:made|built|wrote) you|are you (?:an? )?(?:ai|bot|robot|human|person|real)|are you chatgpt)\b/,
    answer: (context) =>
      context.connected
        ? 'I am the assistant built into AiCut. I edit your project by driving the editor, and I can talk it through with you first.'
        : 'I am the assistant built into AiCut. Right now I am running on the commands built into the app, with no model behind me, so I am better at doing than at chatting. ' +
          FREE_MODELS,
  },
  {
    id: 'cost',
    test: /\b(?:free|cost|costs|pay|paid|price|pricing|subscription|billed|billing|money|expensive|cheap|credit card|trial)\b/,
    answer: () =>
      'Nothing here charges you. The editor and every built-in command are free, the rendering is done by ffmpeg on this computer, and uploads use your own YouTube account. ' +
      FREE_MODELS,
  },
  {
    id: 'model',
    test: /\b(?:model|ollama|lm ?studio|llama|groq|openrouter|gemini|api key|openai|connect(?:ed)?|offline|local model)\b/,
    answer: (context) =>
      (context.connected
        ? 'A model is connected, so you can talk to me in whatever words you like and I will work out which edits to make. '
        : 'With no model connected I only understand direct instructions, so a question like this is about as far as I go. ') +
      FREE_MODELS +
      ' Open the gear above, pick one of the free options, then save.',
  },
  {
    id: 'capability',
    test: /\b(?:what can you do|what do you do|what else can you|help me|what are you (?:able|capable)|how (?:do|does) (?:you|this|it) work|features|abilities|commands)\b/,
    answer: (context) =>
      `${CAN_DO} ${
        context.connected
          ? 'Ask in your own words; I will work out the steps.'
          : 'Say it plainly — "make this into a youtube short", "cut the dead air", "add a hook saying wait for it" — and I will get on with it.'
      }`,
  },
  {
    id: 'privacy',
    test: /\b(?:privacy|private|telemetry|my data|track me|sends? my|sent anywhere|cloud|uploads? my|(?:get|getting) uploaded|leaves? (?:my|this) (?:computer|machine)|stays? (?:on this|local))\b/,
    answer: () =>
      'Your footage stays on this computer. Editing and rendering are local, a model on localhost sees nothing outside the machine, and only a hosted model or a YouTube upload sends anything out — the first gets the text of our conversation, the second the file you asked me to publish.',
  },
  {
    id: 'length',
    test: /\bhow long\b|\bhow many (?:seconds|minutes)\b|\b(?:ideal|best|right) length\b/,
    answer: () =>
      'Shorts are capped at sixty seconds and usually land better between fifteen and thirty. I default to thirty, and "make me a 20 second short" overrides it.',
  },
  {
    id: 'hook',
    test: /\bhooks?\b|\b(?:retention|thumbnail|algorithm|views|grow|engagement|watch time|go viral)\b/,
    answer: () =>
      'Put a hook on screen in the first second and make the cut land before anyone gets bored: "add a hook saying wait for it" writes it in, and "punch in on the action" gives the moment some weight. Short, loud, and no dead air at the front.',
  },
  {
    id: 'shorts',
    test: /\b(?:short|shorts|tiktok|reel|reels|vertical|9:16)\b/,
    answer: () =>
      'Say "make this into a youtube short" and I measure the audio, cut to the liveliest thirty seconds, reframe it to 9:16 and move it to the start. Then add a hook in the first second or two, because that is what decides whether anyone stays.',
  },
  {
    id: 'text',
    test: /\b(?:text|caption|captions|title|titles|subtitle|words on screen)\b/,
    answer: () =>
      'Say "add a hook saying \'wait for it\'" or "add a caption at the bottom saying clip 1 of 3". There are three looks: meme is heavy white text at the top, title is large in the middle, caption sits along the bottom. It shows in the preview and is burned into the export. Captions written from speech are not in yet.',
  },
  {
    // Ahead of the internet topic, which also talks about licences but means
    // where to find free footage rather than what might get claimed. Only
    // reached with an empty timeline; with clips on it the interpreter runs the
    // real check instead of talking in generalities.
    id: 'copyright',
    test: /\b(?:copyright|content ?id|claim(?:ed|s)?|strike[sd]?|flagged|demoneti[sz]\w*|dmca|fair use)\b/,
    answer: () =>
      'Put something on the timeline and press Copyright in the toolbar, or ask me again, and I will go through it clip by clip. What I go on is where each file came from, so anything I download for you is tagged with the channel or the licence it came under. The short version: music is what gets claimed most, your own footage is safe unless something copyrighted is playing in it, and openly licensed material is fine though some of it wants a credit and some forbids monetised use. Mirroring, cropping, changing the speed or keeping cuts short do not work — Content ID normalises all of that, and no length of someone else\'s work is automatically safe. The only certain answer comes from uploading unlisted and reading the Copyright tab in YouTube Studio.',
  },
  {
    id: 'internet',
    test: /\b(?:internet|online|the web|search the web|google|browse|download|stock footage|b.?roll|licen[sc]e|royalty.?free|creative commons)\b/,
    answer: () =>
      'I can go and get things. "Find me a meme about losing" downloads one into your media panel, and the same works for footage, pictures, gifs and sound effects — "get some rain footage", "find a swoosh sound". Those come from libraries that state a licence, so they are yours to publish and I tell you the licence each time. Gameplay and montages are not in those libraries, so for those I go to YouTube: "get me a fortnite montage from youtube" downloads the whole video for you to cut up, and "show me examples of good gaming montages" hands back links to watch instead. A video off someone\'s channel is theirs, though — fine to study, but leaving any of it in your own upload risks a Content ID claim, usually on the music, and no clip is short enough to be exempt from that.',
  },
  {
    id: 'memes',
    test: /\b(?:meme|memes|reaction|sound effect|sound effects|sfx|vine boom|bruh)\b/,
    answer: () =>
      'Two ways. "Find me a meme about losing" goes to the internet and downloads one into your media panel. "Drop the bruh meme in at 0:12" looks on your own computer, imports it and places it — over footage it goes to a corner so it does not hide the action, and sounds land on an audio track. Tell me where you keep yours — "my memes are in D:\\memes" — and I will look there first.',
  },
  {
    id: 'montage',
    test: /\b(?:montage|highlight reel|compilation|best bits)\b/,
    answer: () =>
      'Import the clips, then say "make me a montage". I measure each file, take its liveliest few seconds and lay them end to end. "3 seconds from each clip" or "make a 30 second montage" sets the pace.',
  },
  {
    id: 'gaming',
    test: /\b(?:gameplay|gaming|fortnite|warzone|minecraft|valorant|clip of me playing|kill|stream)\b/,
    answer: () =>
      'Drop the recording in and say "make this into a youtube short". I find the loudest moment, which in gameplay is almost always the kill, cut around it, and go vertical. Then "punch in on the action" for emphasis and a hook across the top.',
  },
  {
    id: 'export',
    test: /\b(?:export|render|save (?:it|the|my)|mp4|webm|mov|resolution|1080|4k|file size)\b/,
    answer: () =>
      'Press Export in the top bar, or say "export as 1080p mp4". Vertical clips render 1080×1920 without being asked. ffmpeg does the work on this computer, so there is no upload and no limit on length.',
  },
  {
    id: 'publish',
    test: /\b(?:youtube|publish|upload|channel|post it)\b/,
    answer: () =>
      'Connect your channel in the settings above with a Google OAuth client, then say "publish to youtube titled Summer Trip". Uploads go out private unless you ask for unlisted or public.',
  },
  {
    id: 'files',
    test: /\b(?:import|files|file|folder|documents|downloads|desktop|find my|where (?:is|are) my)\b/,
    answer: () =>
      'Say "find my fortnite clip in my documents folder" or "what is in my downloads". I can list folders, search by name and import what I find, including the OneDrive copies of Documents and Desktop that Windows redirects to. I only read media files, and I never write anything except what you export.',
  },
  {
    id: 'timeline',
    test: /\b(?:timeline|track|tracks|drag|pan|zoom out|layout|panel|panels|snap|playhead)\b/,
    answer: () =>
      'Scroll to zoom around the cursor, drag empty space to pan, and drag a clip to move it — it snaps to its neighbours and the playhead. Panel headers drag into any corner, and the line between the track names and the lanes resizes.',
  },
  {
    id: 'launch',
    test: /\b(?:open the app|reopen|closed the app|launch|shortcut|start(?:ing)? (?:the )?app|desktop icon)\b/,
    answer: () =>
      'Double-click AiCut.cmd in the project folder, or use the AiCut shortcut on your Desktop. Keep the small black window open while you edit; closing it closes the editor.',
  },
  {
    id: 'version',
    test: /\b(?:version|update|updates|changelog|what(?:'s| is) new|release)\b/,
    answer: () => 'The version sits in the bottom-left corner. Click it for what changed in each release.',
  },
  {
    id: 'memory',
    test: /\b(?:remember|remembers|memory|forget|preference|preferences|learn)\b/,
    answer: () =>
      'Tell me a standing preference — "always crop to 9:16", "never make anything public", "my memes are in D:\\memes" — and I keep it across sessions and follow it. "Forget the 9:16 thing" drops one, "forget everything" clears them.',
  },
  {
    id: 'undo',
    test: /\b(?:undo|redo|revert|go back|mistake)\b/,
    answer: () =>
      'There is no undo yet, which is the honest answer. Nothing is written over your files though, so the worst case is deleting a clip and placing it again.',
  },
  {
    id: 'next',
    test: /\bwhat should i (?:do|make|cut|try|use)\b|\bwhere (?:do|should) i (?:start|begin)\b|\b(?:any )?(?:ideas|suggestions)\b|\bwhat (?:would|do) you (?:do|suggest|recommend)\b/,
    answer: (context) =>
      context.clips === 0
        ? 'Import the recording first, drag it onto a track, then say "make this into a youtube short" and I will find the part worth keeping.'
        : 'Start with "cut the dead air out of this" to tighten it, then "make this into a youtube short" for a vertical cut of the best stretch, then a hook across the first couple of seconds. Export when it looks right.',
  },
  {
    id: 'off-topic',
    test: /\b(?:weather|joke|poem|story|recipe|football|president|election|stock|bitcoin|homework|math|capital of)\b/,
    answer: (context) =>
      context.connected
        ? 'I would rather keep to your video, but ask away — I am here either way.'
        : `That is outside what I know on my own; the built-in half of me only knows this editor. ${FREE_MODELS}`,
  },
]

/** A reply for anything the interpreter did not read as an instruction. */
export function converse(input: string, context: ChatContext): Answer | null {
  const text = input.trim().toLowerCase()
  if (!text) return null

  const topic = TOPICS.find((entry) => entry.test.test(text))
  if (!topic) return null

  return { topic: topic.id, text: topic.answer(context) }
}

/** What to say when even the conversation has nothing to match on. */
export function fallbackReply(context: ChatContext): string {
  if (context.connected) {
    return 'I did not follow that. Say it another way, or tell me the edit you want and I will make it.'
  }

  return [
    'I did not follow that. With no model behind me I take direct instructions rather than anything phrased loosely.',
    CAN_DO,
    'Try "make this into a youtube short", "find me a meme about losing", "look up the new fortnite season", or "what can you do".',
    FREE_MODELS,
  ].join(' ')
}
