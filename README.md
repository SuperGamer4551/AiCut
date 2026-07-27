# AiCut

A desktop video editor with an assistant that edits the project for you. Electron + React + TypeScript, with ffmpeg for rendering.

## Installing it

Build a real installer, then run it:

```bash
npm run dist
```

That writes `release/AiCut Setup <version>.exe`. Installing puts AiCut in the Start menu and on the Desktop with its own name and icon, so it pins to the taskbar like any other program and reopens as AiCut. Nothing else needs to be running: ffmpeg ships inside it, and there is no terminal window to keep open.

### Running it from the source instead

**Double-click `AiCut.cmd`** in this folder. It installs anything missing the first time, then starts the app. Keep the small black window open while you edit — closing it closes the editor. This is the development mode: handy while changing the code, but it is Node running the app rather than the app itself, so do not pin it.

From a terminal, `npm start` does the same thing. If nothing happens, install [Node.js](https://nodejs.org) and try again.

The version is shown in the bottom-right corner; click it for what changed in each release.

## Working on it

```bash
npm install
npm run dev      # Vite + Electron with hot reload
npm run build    # type-check and build the renderer and Electron bundles
npm run check    # every assertion suite (see below)
```

## The look

Two typefaces do the work: **Sora** for headings, labels and every number, **Manrope** for reading text. Digits are set with tabular figures, so a timecode ticking up never shifts the layout — numbers belong to the interface rather than looking like terminal output. Panels are glass over a lit backdrop, clips have a lit top edge and a soft drop, and one easing curve and duration (`--ease`, `--speed` in `src/index.css`) drive every hover, drag and pop-in. Everything stills for `prefers-reduced-motion`.

Colour, radii, shadows and motion are all tokens on `:root`, and the accent is stored as `--accent-rgb` so a single line re-tints the whole app.

## The editor

- **Media** — import with the button, by dragging files onto the window, or by dragging from the library onto a track. Files are streamed from disk through a private `aicut://` protocol rather than copied.
- **Timeline** — drag clips between tracks, snap them to neighbours and the playhead, add and rename tracks, and crop a clip to a ratio. A clip can play any part of its file, so the same recording can appear as several pieces. Scroll to zoom around the cursor, drag empty space to pan.
- **Text** — the lane above the tracks holds on-screen text. **+ Text** adds a line at the playhead; double-click to write it, drag it to move it. It shows in the preview and is burned into the export.
- **Panels** — Media, Preview, Timeline, and Assistant can be dragged into any zone and resized; the arrangement is remembered.
- **Export** — the toolbar button renders the timeline to a file and shows progress as it goes.
- **Status bar** — the version, what is on the timeline, and export progress.

## The assistant

The Assistant panel takes plain instructions and carries them out by calling tools: reading the project, searching your disk, importing files, placing and editing clips, exporting, and publishing.

It works in two modes:

- **Built-in commands** (no setup, nothing to pay for). Direct instructions are understood without a model: `make this into a youtube short`, `find the best 20 seconds`, `cut the dead air`, `split it here`, `keep 1:10 to 1:40`, `find beach in my videos`, `export as 1080p mp4`.
- **With a model connected**, it talks freely, chains several edits together, and decides which tools to use. Open the gear in the Assistant panel and pick one of the free options, or type in any OpenAI-compatible endpoint. Keys are stored in the app's own data folder in the main process and never reach the page.

### Talking to it

Not everything is an instruction, so the panel answers questions too — with or without a model behind it.

- Ask what it can do, how to make a short people watch, how long a short should be, where text and memes come from, how to export or publish, what it remembers, or whether any of it costs money. Questions are recognised as questions: `how do I make a short` gets an explanation, not a cut.
- A question about a folder still searches (`what is in my downloads`), and a question about the project still reads it (`how many clips do I have`).
- With no model connected the answers come from the app itself, which keeps them accurate but narrow. Connect one of the free models and the conversation opens up to anything — `Ollama` or `LM Studio` on this computer cost nothing at all, and Groq, Google AI Studio and OpenRouter `:free` models need only a free key.
- The conversation is kept on this computer, so closing the app and coming back later carries on where you left off. Clear it from the Assistant settings.
- A reply that takes more than ten seconds grows a **Stop** button above **Send**. Stopping abandons the request; anything already applied to the timeline stays, and the transcript says so.
- Nothing claims to have worked when it did not. If a model answers with silence, the reply reports what the tools actually did — including "the file picker was closed without importing anything".

### Making something out of nothing

There is no text-to-video here, and the assistant will not pretend otherwise: a recording of a real match has to come from your own footage. What it can draw is a card, rendered with ffmpeg in about a second, imported and placed on the timeline:

- `generate a 5 second intro that says Fortnite Highlights`
- `create an end card saying "thanks for watching"`
- `generate a 9:16 title card that says GG` — cards follow the timeline's shape unless told otherwise
- `generate a plain background for 3 seconds` — somewhere to put text, or a gap to fill

Cards come in three looks (`dark`, `accent`, `light`), hold up to four lines, and are written to the app's own data folder. Ask for footage of something real and you get an honest answer plus the two things that would help: a card, or a search through what you already have.

### Shorts, highlights and dead air

The heavy lifting does not need a model at all: ffmpeg measures the audio, and the loudest, liveliest stretch is where the interesting part of a recording almost always is.

- **`make this into a youtube short`** measures the clip, cuts to the best stretch (30 seconds by default, never more than 60), reframes it to 9:16, and moves it to the head of the timeline. Exporting then renders 1080×1920 without being asked, and publishing tags it as a Short.
- **`find the best 20 seconds`** reports the strongest windows and where they peak, changing nothing.
- **`cut the dead air out of this`** drops the silent stretches and closes the gaps, leaving one piece per surviving section.
- **`analyze this clip`** reports its length, average level, loudest moment and how much silence it holds.

Measuring only decodes the audio, so a long recording takes a few seconds.

### Made for YouTube

The same plain instructions cover the parts of a video that are not cutting:

- **`add a hook that says "wait for it"`** puts text on screen. `meme` is heavy white text at the top, `title` is large in the middle, `caption` sits along the bottom. Position and how long it holds can be asked for: `put a caption at the bottom saying "clip 1 of 3" for 4 seconds`.
- **`drop the bruh meme in at 0:12`** finds the file, imports it, and drops it in. Over footage it goes to a corner so it does not hide the action; on its own it takes the whole frame. `put it in the top right corner` says where. Sound effects go to an audio track instead: `add a vine boom at the playhead`.
- **`punch in on the action`** cuts a few seconds out and pushes the picture in on them for emphasis. With no time given, the loudest moment is the one it picks.
- **`make me a montage`** takes the best few seconds of every clip in the library and lays them end to end. `make a 30 second montage` or `3 seconds from each clip` sets the pace.
- **`put the facecam in the bottom left corner`** turns any clip into a picture-in-picture inset, composited at export.

Teach it where your stuff lives and it will look there first: `my memes are in D:\memes`.

### A model without paying

The Assistant settings list free options as one-click presets:

| Preset | Cost | Key |
| --- | --- | --- |
| Ollama, LM Studio | free, runs on this computer | none needed |
| Groq, Google AI Studio, OpenRouter `:free` models | free tier, daily limits | free sign-up |

A model served from `localhost` needs no key at all, and nothing leaves the machine.

#### Setting one up with Ollama

1. Install it: `winget install --id Ollama.Ollama --source winget`, or download it from [ollama.com](https://ollama.com). It runs a server on `http://localhost:11434` and starts with Windows.
2. Pull a model. `ollama pull llama3.1:8b` (5 GB) suits a smaller card; `ollama pull gpt-oss:20b` (13 GB) is better at conversation and tool calling and wants about 16 GB of VRAM.
3. Give it room for the tools. The assistant sends its prompt and 33 tool schemas on every turn, which is more than Ollama's default 4096-token window, so set `OLLAMA_CONTEXT_LENGTH=16384` in your user environment variables and restart Ollama. Without this the model sees a truncated tool list and behaves oddly.
4. In the app, open the gear in the Assistant panel, press the **Ollama** preset, leave the key blank, set the model name to what you pulled, and **Save**. The chip beside "Assistant" turns from `built-in commands` into the model name.
5. Prove it works: `npm run check:model` sends the real prompt and tool list to whatever is configured, and checks that a question comes back as words and that "make this into a youtube short" comes back as a `make_short` call.

`npm run check:model` reads the same settings file the app writes, and `AICUT_BASE_URL`, `AICUT_MODEL` and `AICUT_API_KEY` override it for a one-off run against something else.

If replies crawl, run `ollama ps`. A model that says `100% GPU` but answers slowly usually means something else is holding video memory — a second `llama-server.exe` left behind by a restart is the common one, and killing it restores full speed.

### Files on your computer

The assistant can list folders, search for media by name, and import specific paths. Reads are limited to folder listings and media files, walks are bounded in depth and result count, and system folders are skipped. Nothing is written except the files you export.

Folders can be named the way you would say them — `find my fortnite clip in my documents folder`, `what is in my downloads` — including the OneDrive copies of Documents, Desktop and Pictures that Windows redirects to. If a named folder turns up nothing, the search widens to the usual places and says where it looked.

### The internet

The assistant can go and get things, and it does the fetching in the main process because the page itself is not allowed to make remote requests.

- **`find me a meme about losing`** searches the free libraries, downloads the best match into the media panel and tells you where it came from. The same works for the rest: `get some rain footage`, `find a swoosh sound effect`, `download a picture of a golden retriever`. `find me some options for cat gifs` lists them instead so you can pick one, then `add the second one`.
- **`look up the new fortnite season`** reads around a subject and answers with what it found and the articles to follow, rather than guessing. The model is told to do this before writing a title, a description or a hook about something it is unsure of.
- **`show me examples of good gaming montages`** hands back real YouTube links. Links in the chat are clickable and open in your own browser.

Downloads land in the app's own `downloads` folder, capped at 300 MB each, and only if the file turns out to be video, audio or a picture.

Sources are limited to ones that publish a licence — [Openverse](https://openverse.org), [Wikimedia Commons](https://commons.wikimedia.org), the [Internet Archive](https://archive.org) and Imgflip's meme templates — and the licence is quoted every time something is added, because a copyright strike on your channel is a worse outcome than a missing meme. None of them need an account or a key. Somebody else's YouTube video is theirs, so it is linked and never downloaded.

Anything that mentions your own machine still goes to the disk instead: `find my fortnite clips` searches your folders, and `add the bruh meme at 0:12` uses the file you already keep.

### What it remembers

Standing preferences are learned from ordinary messages — `always crop to 9:16`, `never make anything public`, `"my intro" means intro_take3.mp4` — and kept across sessions. Remembered notes are shown in the Assistant settings, are handed to the model each turn, and are honoured by the built-in commands too: with the note above, a bare "crop it" gives you 9:16. Say `forget the 9:16 thing` or `forget everything` to clear them.

Learning happens in the app rather than in the model, so a preference sticks whether or not the model thinks to write it down; the reply says `Remembered: …` when something new was picked up. The conversation itself is kept separately, and both survive a restart.

### Publishing to YouTube

Uploading needs your own Google OAuth client, because the YouTube Data API is per-application:

1. In Google Cloud, create a project and enable the **YouTube Data API v3**.
2. Create an **OAuth client ID** of type **Desktop app**, and add yourself as a test user on the consent screen.
3. Paste the client id and secret into the Assistant settings and press **Connect channel**. Consent opens in your normal browser and returns to a one-shot local server; only the resulting tokens are stored.
4. Ask the assistant to publish: `publish to youtube titled Summer Trip`.

Uploads are **private** unless you ask for `unlisted` or `public`. An app that has not been through Google's verification can only upload as private, so leave verification in mind if you want public uploads.

## Rendering

Export builds a single ffmpeg command from the timeline: clips are trimmed to the part of the file they use, cropped, scaled and padded into the output frame, layered so upper tracks draw over lower ones, and every audio source is mixed over a silent bed so the sound stays in sync with the picture. Output is H.264/AAC in MP4 or MOV, or VP9/Opus in WebM.

An inset clip is scaled into its own box and composited over the frame below it, and text is drawn last with `drawtext` using a system font. If no font can be found, the render still goes ahead and says the text was skipped; `AICUT_FONT` points at a specific font file.

With no size asked for, the frame follows the crop: vertical clips render 1080×1920, square ones 1080×1080, and anything else 1080p. A clip parked in a corner does not get a say in that — the full-frame footage decides.

ffmpeg comes from `ffmpeg-static` in development and from the app resources once packaged. Set `AICUT_FFMPEG` to use a different binary.

## Assertions

Logic lives in small modules with a matching suite, all run by `npm run check`:

| Suite | Covers |
| --- | --- |
| `check:timeline` | snapping, collisions, track rules, crop maths |
| `check:agent` | tool runtime, plain-language commands, memory, the host bridge, text, memes, punch-ins, montages |
| `check:web` | reading each library's reply, naming a download, routing a request to the internet rather than the disk, links in a reply |
| `check:ai` | model transport, settings storage, reply parsing |
| `check:export` | the ffmpeg command built from a timeline, text and inset filters, font discovery, progress parsing |
| `check:files` | folder names, folder listing and bounded search |
| `check:youtube` | consent URL, token refresh, chunked resumable upload |
| `check:highlights` | reading ffmpeg's measurements, picking highlights, source/timeline time, free endpoints |

`npm run check:live` is separate because it needs ffmpeg and about a minute: it builds a clip with a loud burst in the middle, asks the assistant to make a short of it, renders the result, and proves the audio came from the burst rather than the quiet part. It then renders text and a corner insert and compares the frames against a plain render, so the overlay layers are proven to reach the picture and to leave the rest of it alone.
