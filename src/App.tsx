import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  Crop,
  DragMedia,
  MediaItem,
  TextOverlay,
  TimelineClip,
  Track,
  TrackKind,
} from './lib/types'
import { CLIP_COLORS, SUPPORTED_EXTENSIONS, stripExtension } from './lib/types'
import { DEFAULT_TEXT_SECONDS, cleanText } from './lib/overlay'
import { itemFromFile, itemFromPath, probeMedia, releaseItem, supportedFiles } from './lib/media'
import {
  INITIAL_TRACKS,
  addTrack as addTrackTo,
  clampZoom,
  defaultTrackId,
  endOfTrack,
  placeClip,
} from './lib/timeline'
import { isCropped } from './lib/crop'
import type { ProjectState, ToolCall, ToolOutcome } from './lib/agent/types'
import { runTool } from './lib/agent/runtime'
import { executeCalls } from './lib/agent/execute'
import { createHostBridge } from './lib/agent/bridge'
import type { MemoryNote } from './lib/agent/memory'
import { MEMORY_STORAGE_KEY, normalizeMemory } from './lib/agent/memory'
import type { Layout, PanelId, SizeKey, Sizes, ZoneId } from './lib/layout'
import {
  DEFAULT_LAYOUT,
  DEFAULT_SIZES,
  LAYOUT_STORAGE_KEY,
  PANEL_TITLES,
  SIZES_STORAGE_KEY,
  ZONE_IDS,
  clampSize,
  fitSizes,
  maxSize,
  movePanel,
  normalizeLayout,
  normalizeSizes,
  readStored,
  sizesEqual,
  writeStored,
} from './lib/layout'
import { TopBar } from './components/TopBar'
import { MediaLibrary } from './components/MediaLibrary'
import { Preview } from './components/Preview'
import { Timeline } from './components/Timeline'
import { AiChat } from './components/AiChat'
import { Splitter } from './components/Splitter'
import { StatusBar } from './components/StatusBar'
import './App.css'

const ACCEPT = SUPPORTED_EXTENSIONS.map((ext) => `.${ext}`).join(',')

type PanelDrag = {
  panel: PanelId
  x: number
  y: number
  over: ZoneId | null
  moved: boolean
}

export default function App() {
  const [media, setMedia] = useState<MediaItem[]>([])
  const [clips, setClips] = useState<TimelineClip[]>([])
  const [selectedMediaId, setSelectedMediaId] = useState<string | null>(null)
  const [playhead, setPlayhead] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [zoom, setZoom] = useState(24)
  const [dragging, setDragging] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [dragMedia, setDragMedia] = useState<DragMedia | null>(null)
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null)
  const [tracks, setTracks] = useState<Track[]>(INITIAL_TRACKS)
  const [overlays, setOverlays] = useState<TextOverlay[]>([])
  const [cropMode, setCropMode] = useState(false)
  const [layout, setLayout] = useState<Layout>(() =>
    readStored(LAYOUT_STORAGE_KEY, normalizeLayout),
  )
  const [sizes, setSizes] = useState<Sizes>(() => readStored(SIZES_STORAGE_KEY, normalizeSizes))
  const [panelDrag, setPanelDrag] = useState<PanelDrag | null>(null)
  const [memory, setMemory] = useState<MemoryNote[]>(() =>
    readStored(MEMORY_STORAGE_KEY, normalizeMemory),
  )
  const [progress, setProgress] = useState<{ phase: string; fraction: number } | null>(null)

  const fileInputRef = useRef<HTMLInputElement>(null)
  const workspaceRef = useRef<HTMLDivElement>(null)
  // Kept in sync every render so a batch of assistant tool calls can be applied
  // one after another without waiting for React to re-render in between.
  const projectRef = useRef<ProjectState>({
    media,
    clips,
    tracks,
    overlays,
    playhead,
    zoom,
    selectedClipId,
    memory,
  })
  // Lets the host bridge push an edit back without being rebuilt every render.
  const applyRef = useRef<(next: ProjectState) => void>(() => {})
  const zoneRefs = useRef<Partial<Record<ZoneId, HTMLDivElement | null>>>({})
  const resizeRef = useRef({ value: 0, max: Number.POSITIVE_INFINITY })
  const panelDragRef = useRef<PanelDrag | null>(null)

  projectRef.current = { media, clips, tracks, overlays, playhead, zoom, selectedClipId, memory }

  const selectedClip = useMemo(
    () => clips.find((clip) => clip.id === selectedClipId) ?? null,
    [clips, selectedClipId],
  )

  // A selected clip drives the preview; otherwise the library selection does.
  const previewMedia = useMemo(() => {
    const id = selectedClip?.mediaId ?? selectedMediaId
    return media.find((item) => item.id === id) ?? null
  }, [media, selectedClip, selectedMediaId])

  const timelineDuration = useMemo(() => {
    if (clips.length === 0) return 30
    return Math.max(...clips.map((clip) => clip.start + clip.duration), 30)
  }, [clips])

  const previewDuration = previewMedia?.duration ?? timelineDuration
  const usesRealPlayback = Boolean(
    previewMedia && previewMedia.kind !== 'image' && !previewMedia.loading,
  )
  const canCrop = Boolean(selectedClip && selectedClip.kind !== 'audio')
  const cropping = cropMode && canCrop

  // Images and empty projects have no media element to drive time, so tick manually.
  useEffect(() => {
    if (!playing || usesRealPlayback) return
    const id = window.setInterval(() => {
      setPlayhead((t) => {
        const next = t + 0.1
        if (next >= previewDuration) {
          setPlaying(false)
          return previewDuration
        }
        return next
      })
    }, 100)
    return () => window.clearInterval(id)
  }, [playing, usesRealPlayback, previewDuration])

  useEffect(() => {
    if (!notice) return
    const id = window.setTimeout(() => setNotice(null), 4000)
    return () => window.clearTimeout(id)
  }, [notice])

  // Pulling a video off YouTube can run for a minute, which is far too long to
  // sit in silence. The toast keeps itself alive while the numbers keep moving.
  useEffect(() => {
    const web = window.aicut?.web
    if (!web?.onProgress) return

    return web.onProgress((progress) => {
      if (progress.phase === 'done' || progress.phase === 'failed') return
      const percent = Math.round(progress.fraction * 100)
      setNotice(progress.phase === 'download' ? `Downloading… ${percent}%` : progress.what)
    })
  }, [])

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Delete' && event.key !== 'Backspace') return
      const target = event.target as HTMLElement | null
      if (target && /^(INPUT|TEXTAREA)$/.test(target.tagName)) return
      if (!selectedClipId) return

      event.preventDefault()
      setClips((prev) => prev.filter((clip) => clip.id !== selectedClipId))
      setSelectedClipId(null)
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [selectedClipId])

  // Crop applies to one clip, so changing selection leaves crop mode.
  useEffect(() => {
    setCropMode(false)
  }, [selectedClipId])

  useEffect(() => writeStored(LAYOUT_STORAGE_KEY, layout), [layout])
  useEffect(() => writeStored(SIZES_STORAGE_KEY, sizes), [sizes])

  // Keep every region reachable when the window shrinks.
  useEffect(() => {
    const el = workspaceRef.current
    if (!el) return

    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect
      if (!rect) return
      setSizes((prev) => {
        const next = fitSizes(prev, rect.width, rect.height)
        return sizesEqual(prev, next) ? prev : next
      })
    })

    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  function beginResize(key: SizeKey) {
    const rect = workspaceRef.current?.getBoundingClientRect()
    resizeRef.current = {
      value: sizes[key],
      max: rect ? maxSize(key, sizes, rect.width, rect.height) : Number.POSITIVE_INFINITY,
    }
  }

  function applyResize(key: SizeKey, delta: number) {
    // The right column and bottom row grow when dragged toward the centre.
    const direction = key === 'right' || key === 'bottom' ? -1 : 1
    const { value, max } = resizeRef.current
    setSizes((prev) => ({ ...prev, [key]: clampSize(key, value + direction * delta, max) }))
  }

  function nudgeSize(key: SizeKey, delta: number) {
    const rect = workspaceRef.current?.getBoundingClientRect()
    const max = rect ? maxSize(key, sizes, rect.width, rect.height) : Number.POSITIVE_INFINITY
    const direction = key === 'right' || key === 'bottom' ? -1 : 1
    setSizes((prev) => ({ ...prev, [key]: clampSize(key, prev[key] + direction * delta, max) }))
  }

  function zoneAt(x: number, y: number): ZoneId | null {
    return (
      ZONE_IDS.find((zone) => {
        const rect = zoneRefs.current[zone]?.getBoundingClientRect()
        return rect ? x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom : false
      }) ?? null
    )
  }

  // Panel headers double as drag handles, so panels themselves stay unaware of
  // where they are docked.
  function beginPanelDrag(event: ReactPointerEvent<HTMLDivElement>, panel: PanelId) {
    if (event.button !== 0) return

    const target = event.target as HTMLElement | null
    if (!target?.closest('.panel-header')) return
    if (target.closest('button, input, select, textarea, label, a')) return

    // Keeps the press from starting a text selection that trails the drag.
    event.preventDefault()

    const next: PanelDrag = { panel, x: event.clientX, y: event.clientY, over: null, moved: false }
    panelDragRef.current = next
    setPanelDrag(next)
  }

  useEffect(() => {
    if (!panelDrag) return

    function handleMove(event: PointerEvent) {
      const current = panelDragRef.current
      if (!current) return

      if (event.buttons === 0) {
        handleUp()
        return
      }

      const moved =
        current.moved || Math.hypot(event.clientX - current.x, event.clientY - current.y) > 4

      const next: PanelDrag = {
        ...current,
        over: moved ? zoneAt(event.clientX, event.clientY) : null,
        moved,
      }
      panelDragRef.current = next
      setPanelDrag(next)
    }

    function handleUp() {
      const current = panelDragRef.current
      panelDragRef.current = null
      setPanelDrag(null)

      if (!current?.moved || !current.over) return
      setLayout((prev) => movePanel(prev, current.panel, current.over as ZoneId))
    }

    window.addEventListener('pointermove', handleMove)
    window.addEventListener('pointerup', handleUp)
    window.addEventListener('pointercancel', handleUp)

    return () => {
      window.removeEventListener('pointermove', handleMove)
      window.removeEventListener('pointerup', handleUp)
      window.removeEventListener('pointercancel', handleUp)
    }
  }, [panelDrag?.panel])

  function resetLayout() {
    setLayout(DEFAULT_LAYOUT)
    setSizes(DEFAULT_SIZES)
    setNotice('Layout reset')
  }

  /** Resolves once metadata has been read, so callers know real durations. */
  const addItems = useCallback(async (items: MediaItem[]): Promise<MediaItem[]> => {
    if (items.length === 0) return []

    setMedia((prev) => [...prev, ...items])
    setSelectedMediaId((current) => current ?? items[0].id)
    setPlaying(false)

    const probed = await Promise.all(
      items.map(async (item) => {
        const probe = await probeMedia(item.url, item.kind)
        const ready: MediaItem = {
          ...item,
          duration: probe.duration,
          width: probe.width,
          height: probe.height,
          loading: false,
          error: probe.error,
        }

        setMedia((prev) => prev.map((existing) => (existing.id === item.id ? ready : existing)))
        return ready
      }),
    )

    // The assistant may act on these before React re-renders.
    projectRef.current = {
      ...projectRef.current,
      media: [...projectRef.current.media.filter((entry) => !probed.some((item) => item.id === entry.id)), ...probed],
    }

    return probed
  }, [])

  const importFromDialog = useCallback(async (): Promise<MediaItem[]> => {
    if (!window.aicut?.openMedia) {
      fileInputRef.current?.click()
      return []
    }

    const files = await window.aicut.openMedia()
    if (files.length === 0) return []

    const items = await addItems(files.map((file) => itemFromPath(file.path, file.size)))
    setNotice(`Imported ${files.length} file${files.length === 1 ? '' : 's'}`)
    return items
  }, [addItems])

  /** Import by absolute path, which is how the assistant brings in files it found. */
  const importPaths = useCallback(
    async (paths: string[]): Promise<{ items: MediaItem[]; failed: string[] }> => {
      const desktop = window.aicut
      if (!desktop?.statFile) return { items: [], failed: paths }

      const failed: string[] = []
      const candidates: MediaItem[] = []

      for (const target of paths) {
        const info = await desktop.statFile(target)
        if (!info) {
          failed.push(target)
          continue
        }
        candidates.push(itemFromPath(info.path, info.size))
      }

      const items = await addItems(candidates)
      if (items.length > 0) {
        setNotice(`Imported ${items.length} file${items.length === 1 ? '' : 's'}`)
      }

      return { items, failed }
    },
    [addItems],
  )

  const importFiles = useCallback(
    async (fileList: FileList | File[]) => {
      const all = Array.from(fileList)
      const usable = supportedFiles(all)
      const skipped = all.length - usable.length

      if (usable.length > 0) {
        await addItems(usable.map(itemFromFile))
      }

      if (skipped > 0) {
        setNotice(`Skipped ${skipped} unsupported file${skipped === 1 ? '' : 's'}`)
      } else if (usable.length > 0) {
        setNotice(`Imported ${usable.length} file${usable.length === 1 ? '' : 's'}`)
      }
    },
    [addItems],
  )

  const host = useMemo(
    () =>
      createHostBridge({
        getState: () => projectRef.current,
        applyState: (next) => applyRef.current(next),
        importDialog: importFromDialog,
        importPaths,
        desktop: window.aicut,
        notify: setNotice,
      }),
    [importFromDialog, importPaths],
  )

  useEffect(() => writeStored(MEMORY_STORAGE_KEY, memory), [memory])

  // Render and upload progress, so long jobs are visible outside the chat.
  useEffect(() => {
    const desktop = window.aicut
    if (!desktop?.exporter) return

    return desktop.exporter.onProgress((update) => {
      if (update.phase === 'done' || update.phase === 'failed') {
        setProgress(null)
        return
      }
      setProgress({ phase: update.phase, fraction: update.fraction })
    })
  }, [])

  // OS-level drag and drop onto the window.
  useEffect(() => {
    let depth = 0

    const onDragEnter = (event: DragEvent) => {
      if (!event.dataTransfer?.types.includes('Files')) return
      depth += 1
      setDragging(true)
    }
    const onDragOver = (event: DragEvent) => {
      if (!event.dataTransfer?.types.includes('Files')) return
      event.preventDefault()
      event.dataTransfer.dropEffect = 'copy'
    }
    const onDragLeave = () => {
      depth = Math.max(0, depth - 1)
      if (depth === 0) setDragging(false)
    }
    const onDrop = (event: DragEvent) => {
      if (!event.dataTransfer?.files.length) return
      event.preventDefault()
      depth = 0
      setDragging(false)
      void importFiles(event.dataTransfer.files)
    }

    window.addEventListener('dragenter', onDragEnter)
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('dragleave', onDragLeave)
    window.addEventListener('drop', onDrop)

    return () => {
      window.removeEventListener('dragenter', onDragEnter)
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('dragleave', onDragLeave)
      window.removeEventListener('drop', onDrop)
    }
  }, [importFiles])

  function removeMedia(id: string) {
    const item = media.find((entry) => entry.id === id)
    if (item) releaseItem(item)

    setMedia((prev) => prev.filter((entry) => entry.id !== id))
    setClips((prev) => prev.filter((clip) => clip.mediaId !== id))
    setSelectedMediaId((current) => (current === id ? null : current))
  }

  function clipFromMedia(item: MediaItem, track: string, start: number): TimelineClip {
    return {
      id: crypto.randomUUID(),
      mediaId: item.id,
      name: stripExtension(item.name),
      kind: item.kind,
      track,
      start,
      duration: Math.max(item.duration, 1),
      color: CLIP_COLORS[item.kind],
    }
  }

  function addSelectedToTimeline() {
    const item = media.find((entry) => entry.id === selectedMediaId)
    if (!item || item.loading) return

    const track = defaultTrackId(tracks, item.kind)
    if (!track) {
      setNotice(`Add a ${item.kind === 'audio' ? 'audio' : 'video'} track first`)
      return
    }

    const clip = clipFromMedia(item, track, endOfTrack(clips, track))
    setClips((prev) => [...prev, clip])
    setSelectedClipId(clip.id)
  }

  function dropMediaOnTimeline(mediaId: string, track: string, start: number) {
    const item = media.find((entry) => entry.id === mediaId)
    if (!item || item.loading) return

    const clip = clipFromMedia(item, track, start)
    setClips((prev) => [...prev, clip])
    setSelectedClipId(clip.id)
    setDragMedia(null)
  }

  function addTrack(kind: TrackKind) {
    const { tracks: next, track } = addTrackTo(tracks, kind)
    setTracks(next)
    setNotice(`Added ${track.name}`)
  }

  function renameTrack(id: string, name: string) {
    setTracks((prev) => prev.map((track) => (track.id === id ? { ...track, name } : track)))
  }

  function removeTrack(id: string) {
    const track = tracks.find((entry) => entry.id === id)
    if (!track) return

    const removedClips = clips.filter((clip) => clip.track === id)
    setTracks((prev) => prev.filter((entry) => entry.id !== id))
    setClips((prev) => prev.filter((clip) => clip.track !== id))
    setSelectedClipId((current) =>
      removedClips.some((clip) => clip.id === current) ? null : current,
    )
    setNotice(
      removedClips.length > 0
        ? `Removed ${track.name} and ${removedClips.length} clip${removedClips.length === 1 ? '' : 's'}`
        : `Removed ${track.name}`,
    )
  }

  function setClipCrop(crop: Crop) {
    if (!selectedClipId) return
    setClips((prev) =>
      prev.map((clip) =>
        clip.id === selectedClipId ? { ...clip, crop: isCropped(crop) ? crop : undefined } : clip,
      ),
    )
  }

  function moveClip(clipId: string, track: string, start: number) {
    setClips((prev) => {
      const clip = prev.find((entry) => entry.id === clipId)
      if (!clip) return prev

      // Re-run placement against the committed state so the clip can never
      // land on top of a neighbour.
      const { start: resolved } = placeClip({
        clips: prev,
        track,
        excludeId: clipId,
        desiredStart: start,
        duration: clip.duration,
        zoom,
        playhead,
      })

      return prev.map((entry) =>
        entry.id === clipId ? { ...entry, track, start: resolved } : entry,
      )
    })
  }

  function deleteClip(clipId: string) {
    setClips((prev) => prev.filter((clip) => clip.id !== clipId))
    setSelectedClipId((current) => (current === clipId ? null : current))
  }

  /** A placeholder that reads as an instruction until it is typed over. */
  function addText() {
    const overlay: TextOverlay = {
      id: crypto.randomUUID(),
      text: 'Double-click to edit',
      start: playhead,
      duration: DEFAULT_TEXT_SECONDS,
      position: 'middle',
      style: 'title',
    }

    setOverlays((prev) => [...prev, overlay])
    setNotice('Added text at the playhead')
  }

  function editText(id: string, text: string) {
    const cleaned = cleanText(text)
    // Emptying the box is how you delete one.
    if (!cleaned) {
      setOverlays((prev) => prev.filter((overlay) => overlay.id !== id))
      return
    }

    setOverlays((prev) =>
      prev.map((overlay) => (overlay.id === id ? { ...overlay, text: cleaned } : overlay)),
    )
  }

  function removeText(id: string) {
    setOverlays((prev) => prev.filter((overlay) => overlay.id !== id))
  }

  // The assistant edits the project through these entry points: it reads a
  // snapshot and applies tool calls to it.
  function applyProject(next: ProjectState) {
    projectRef.current = next
    setMedia(next.media)
    setClips(next.clips)
    setTracks(next.tracks)
    setOverlays(next.overlays)
    setPlayhead(next.playhead)
    setZoom(next.zoom)
    setSelectedClipId(next.selectedClipId)
    setMemory(next.memory)
  }

  applyRef.current = applyProject

  async function runToolCalls(calls: ToolCall[]): Promise<ToolOutcome[]> {
    const { state: next, outcomes } = await executeCalls(projectRef.current, calls, host)
    applyProject(next)
    return outcomes
  }

  function describeProject(): string {
    return runTool(projectRef.current, { name: 'describe_project', args: {} }).summary
  }

  async function exportProject() {
    const reply = await host.exportProject({})
    setNotice(reply.summary)
  }

  const panels: Record<PanelId, ReactNode> = {
    media: (
      <MediaLibrary
        items={media}
        selectedId={selectedMediaId}
        onSelect={(id) => {
          setSelectedMediaId(id)
          setSelectedClipId(null)
          setPlayhead(0)
          setPlaying(false)
        }}
        onImport={importFromDialog}
        onRemove={removeMedia}
        onDropFiles={importFiles}
        onDragMediaStart={setDragMedia}
        onDragMediaEnd={() => setDragMedia(null)}
      />
    ),
    preview: (
      <Preview
        media={previewMedia}
        clip={selectedClip}
        overlays={overlays}
        cropping={cropping}
        playhead={playhead}
        playing={playing}
        onTime={setPlayhead}
        onEnded={() => setPlaying(false)}
        onPlayingChange={setPlaying}
        onImport={importFromDialog}
        onCropChange={setClipCrop}
        onCropDone={() => setCropMode(false)}
      />
    ),
    timeline: (
      <Timeline
        clips={clips}
        tracks={tracks}
        overlays={overlays}
        playhead={playhead}
        duration={timelineDuration}
        zoom={zoom}
        dragMedia={dragMedia}
        selectedClipId={selectedClipId}
        cropping={cropping}
        canCrop={canCrop}
        gutterWidth={sizes.gutter}
        onGutterWidthChange={(next) => setSizes((prev) => ({ ...prev, gutter: clampSize('gutter', next) }))}
        onZoomChange={(next) => setZoom(clampZoom(next))}
        onSeek={(t) => {
          setPlaying(false)
          setPlayhead(t)
        }}
        onSelectClip={setSelectedClipId}
        onMoveClip={moveClip}
        onDropMedia={dropMediaOnTimeline}
        onDeleteClip={deleteClip}
        onAddTrack={addTrack}
        onRenameTrack={renameTrack}
        onRemoveTrack={removeTrack}
        onToggleCrop={() => setCropMode((mode) => !mode)}
        onAddText={addText}
        onEditText={editText}
        onRemoveText={removeText}
      />
    ),
    ai: (
      <AiChat
        project={projectRef.current}
        describeProject={describeProject}
        onRunTools={runToolCalls}
      />
    ),
  }

  function renderZone(zone: ZoneId) {
    const panel = layout[zone]
    const dragging = panelDrag?.moved === true
    const isSource = dragging && panelDrag?.panel === panel
    const isTarget = dragging && panelDrag?.over === zone && !isSource

    return (
      <div
        className={`zone${isSource ? ' is-source' : ''}${isTarget ? ' is-target' : ''}`}
        ref={(el) => {
          zoneRefs.current[zone] = el
        }}
        onPointerDown={(event) => beginPanelDrag(event, panel)}
      >
        {panels[panel]}
        {isTarget && panelDrag && (
          <div className="zone-hint">
            Swap {PANEL_TITLES[panelDrag.panel]} with {PANEL_TITLES[panel]}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className={`app-shell${panelDrag?.moved ? ' is-moving-panel' : ''}`}>
      <TopBar
        playing={playing}
        playhead={playhead}
        duration={previewDuration}
        progress={progress}
        canExport={clips.length > 0}
        onTogglePlay={() => setPlaying((p) => !p)}
        onImport={importFromDialog}
        onAddToTimeline={addSelectedToTimeline}
        onResetLayout={resetLayout}
        onExport={() => void exportProject()}
        canPlay={Boolean(previewMedia)}
        canAdd={Boolean(
          selectedMediaId && media.some((item) => item.id === selectedMediaId && !item.loading),
        )}
      />

      <div
        className="workspace"
        ref={workspaceRef}
        style={{
          gridTemplateColumns: `${sizes.left}px 10px minmax(0, 1fr) 10px ${sizes.right}px`,
        }}
      >
        {renderZone('left')}

        <Splitter
          orientation="vertical"
          label="Resize left panel"
          onStart={() => beginResize('left')}
          onMove={(delta) => applyResize('left', delta)}
          onNudge={(delta) => nudgeSize('left', delta)}
        />

        <div
          className="center-column"
          style={{ gridTemplateRows: `minmax(0, 1fr) 10px ${sizes.bottom}px` }}
        >
          {renderZone('center')}

          <Splitter
            orientation="horizontal"
            label="Resize bottom panel"
            onStart={() => beginResize('bottom')}
            onMove={(delta) => applyResize('bottom', delta)}
            onNudge={(delta) => nudgeSize('bottom', delta)}
          />

          {renderZone('bottom')}
        </div>

        <Splitter
          orientation="vertical"
          label="Resize right panel"
          onStart={() => beginResize('right')}
          onMove={(delta) => applyResize('right', delta)}
          onNudge={(delta) => nudgeSize('right', delta)}
        />

        {renderZone('right')}
      </div>

      {panelDrag?.moved && (
        <div className="panel-ghost" style={{ left: panelDrag.x, top: panelDrag.y }}>
          {PANEL_TITLES[panelDrag.panel]}
        </div>
      )}

      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept={ACCEPT}
        className="hidden-file-input"
        onChange={(event) => {
          if (event.target.files) void importFiles(event.target.files)
          event.target.value = ''
        }}
      />

      {dragging && (
        <div className="drop-overlay">
          <div className="drop-card">
            <div className="drop-title">Drop files to import</div>
            <div className="drop-sub">Video, audio, and images</div>
          </div>
        </div>
      )}

      <StatusBar
        clips={clips.length}
        tracks={tracks.length}
        overlays={overlays.length}
        status={
          progress
            ? `${progress.phase === 'upload' ? 'Uploading' : 'Rendering'} ${Math.round(progress.fraction * 100)}%`
            : null
        }
      />

      {notice && <div className="toast">{notice}</div>}
    </div>
  )
}
