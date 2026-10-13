import React, { useEffect, useRef, useState, useMemo, useCallback } from 'react'
import { useStore } from '../store'
import { useWebSocket } from '../hooks/useWebSocket'
import { exportCaptions } from '../utils/download'

// How many caption rows to keep mounted in the DOM at once. Full history stays in
// the store (and is used for downloads); only a trailing window renders, so a feed
// can accumulate thousands of captions without the DOM degrading (Task 4/5).
const RENDER_WINDOW = 400
// How long a freshly-arrived caption stays highlighted.
const HIGHLIGHT_MS = 1500

function fmtClock(sec) {
  try {
    return new Date((sec || 0) * 1000).toISOString().substr(11, 8)
  } catch {
    return '00:00:00'
  }
}

// A single caption row. Memoized so appending new captions does NOT re-render
// existing rows (Task 4: incremental rendering, no full-list replace).
// Each caption JSON carries BOTH the model's exact output (raw_text) and the
// result of the Quick Caption pipeline (text). `view` picks which to show;
// "compare" stacks them so you can see exactly what post-processing changed.
const CaptionRow = React.memo(function CaptionRow({ caption, isNew, index, view, isLiveRow }) {
  const raw = (caption.raw || '').trim()
  const proc = (caption.text || '').trim()
  const changed = raw && proc && raw !== proc
  return (
    <div
      className={`text-sm border-b border-gray-100 dark:border-gray-800 py-1 px-1 rounded-sm
        transition-colors duration-700 ${isLiveRow
          ? 'bg-red-50 dark:bg-red-900/30 ring-1 ring-red-300 dark:ring-red-800'
          : isNew ? 'bg-blue-50 dark:bg-blue-900/30' : ''}`}
    >
      <span className={`mr-1 font-mono text-xs ${isLiveRow
        ? 'text-red-600 dark:text-red-400 font-bold' : 'text-blue-400 dark:text-blue-500'}`}>
        {isLiveRow ? '●' : ''}#{caption.chunk ?? index}
      </span>
      <span className="text-gray-400 dark:text-gray-500 mr-2 font-mono text-xs">
        {fmtClock(caption.start)}
      </span>
      {view === 'processed' && (
        <span className="text-gray-800 dark:text-gray-100">{proc || raw}</span>
      )}
      {view === 'raw' && (
        <span className="text-gray-800 dark:text-gray-100 font-mono">
          {raw || <span className="italic text-gray-400 dark:text-gray-600">— no raw text —</span>}
        </span>
      )}
      {view === 'compare' && (
        <span className="inline-block align-top">
          <span className="block font-mono text-gray-500 dark:text-gray-400">
            <span className="text-[10px] uppercase mr-1 text-gray-400">raw</span>{raw || '—'}
          </span>
          {changed
            ? <span className="block text-emerald-700 dark:text-emerald-400">
                <span className="text-[10px] uppercase mr-1 opacity-70">proc</span>{proc}
              </span>
            : <span className="block text-[10px] uppercase text-gray-400 dark:text-gray-600">unchanged by pipeline</span>}
        </span>
      )}
    </div>
  )
})

function DeviceBadge({ deviceInfo }) {
  if (!deviceInfo) return null
  const dev = deviceInfo.device || 'unknown'
  const fallback = deviceInfo.cpu_fallback
  const cls = dev === 'cuda'
    ? 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300'
    : fallback
      ? 'bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300'
      : 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300'
  return (
    <span className={`text-xs px-2 py-0.5 rounded ${cls}`} title={deviceInfo.reason || ''}>
      {dev === 'cuda' ? 'GPU' : 'CPU'}{fallback ? ' (fallback)' : ''}
    </span>
  )
}

// `single` renders the Single Model lane instead of a numbered feed. That lane
// streams on its own channel (single_caption → store.single), so without this it
// never appeared in the monitor at all.
function FeedColumn({ feedId, activeUpload, single = false }) {
  const feed = useStore(s => (single ? s.single : s.feeds[feedId])) || {}
  const clearFeedCaptions = useStore(s => s.clearCaptions)
  const clearSingleCaptions = useStore(s => s.clearSingleCaptions)
  const clearCaptions = single ? (() => clearSingleCaptions()) : clearFeedCaptions
  const liveCaptions = feed.captions || []

  // Merge live-feed captions with the currently-processing upload's captions for
  // this feed, so the Caption Monitor streams whichever source is running,
  // chunk-by-chunk, in realtime.
  const uploadCaptions = single ? [] : (activeUpload?.captions?.[String(feedId)] || [])
  const captions = useMemo(
    () => (uploadCaptions.length ? [...liveCaptions, ...uploadCaptions] : liveCaptions),
    [liveCaptions, uploadCaptions]
  )
  const isRunning = single ? (feed.phase === 'processing') : feed.isRunning
  const deviceInfo = single ? (feed.device ? { device: feed.device } : null) : feed.deviceInfo
  const modelName = single ? feed.displayName : feed.model
  const sourceLabel = single
    ? (feed.live
        ? `📡 ${(feed.source || 'udp').toUpperCase()} LIVE${feed.liveUrl ? ` · ${feed.liveUrl}` : ''}`
        : (feed.filename ? `📁 STATIC FILE · ${feed.filename}` : null))
    : uploadCaptions.length
      ? `📁 STATIC FILE · ${activeUpload?.filename || 'upload'}`
      : (feed.isRunning ? '📡 UDP LIVE' : null)

  const scrollRef = useRef(null)
  const [autoScroll, setAutoScroll] = useState(true)
  const [search, setSearch] = useState('')
  const [minWords, setMinWords] = useState(0)
  const [view, setView] = useState('compare')   // processed | raw | compare
  const label = single ? 'Single Model' : `Feed ${feedId}`

  // Filtered view (search + min-words). useMemo so filtering only reruns when
  // inputs change, not on every unrelated store update (Task 5).
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q && !minWords) return captions
    return captions.filter(c => {
      // Search both texts — a term the pipeline rewrote should still be findable.
      const t = (c.text || '')
      const r = (c.raw || '')
      if (q && !t.toLowerCase().includes(q) && !r.toLowerCase().includes(q)) return false
      if (minWords && (t || r).split(/\s+/).filter(Boolean).length < minWords) return false
      return true
    })
  }, [captions, search, minWords])

  // Only render the trailing window in the DOM.
  const windowed = filtered.length > RENDER_WINDOW ? filtered.slice(-RENDER_WINDOW) : filtered
  const hiddenCount = filtered.length - windowed.length
  const now = Date.now()

  // Auto-scroll to the newest caption, but only while enabled.
  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [windowed.length, autoScroll])

  // Detect manual upward scroll → pause auto-scroll; re-enable when back at bottom.
  const onScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40
    setAutoScroll(atBottom)
  }, [])

  const jumpToLatest = useCallback(() => {
    setAutoScroll(true)
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [])

  return (
    <div className="border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 shadow-sm flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-gray-200 dark:border-gray-700">
        <div className="flex items-center gap-2">
          <h3 className="font-bold">{label}</h3>
          <span className={`text-xs px-2 py-0.5 rounded ${isRunning || uploadCaptions.length
            ? 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300'
            : 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300'}`}>
            {isRunning || uploadCaptions.length ? 'Running' : 'Idle'}
          </span>
          {sourceLabel && (
            <span className="text-xs px-2 py-0.5 rounded bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300"
                  title="Caption source">
              {sourceLabel}
            </span>
          )}
          <DeviceBadge deviceInfo={deviceInfo} />
          <span className="text-xs text-gray-400 dark:text-gray-500">{modelName || '—'}</span>
        </div>
        <div className="flex items-center gap-2">
          {isRunning && (
            <span className="text-xs px-2 py-0.5 rounded bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300 font-mono"
                  title="Chunk most recently returned by the model">
              ● now: {(single && feed.currentChunk) || `#${captions[captions.length - 1]?.chunk ?? '—'}`}
            </span>
          )}
          <span className="text-xs text-gray-500 dark:text-gray-400">{captions.length} lines</span>
        </div>
      </div>

      {/* Search + filter */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-gray-200 dark:border-gray-700">
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search captions…"
          className="flex-1 text-xs px-2 py-1 rounded border border-gray-300 dark:border-gray-600
                     bg-white dark:bg-gray-700 text-gray-800 dark:text-gray-100 placeholder-gray-400"
        />
        <select
          value={minWords}
          onChange={e => setMinWords(Number(e.target.value))}
          className="text-xs px-2 py-1 rounded border border-gray-300 dark:border-gray-600
                     bg-white dark:bg-gray-700 text-gray-800 dark:text-gray-100"
          title="Minimum words filter"
        >
          <option value={0}>All</option>
          <option value={2}>≥ 2 words</option>
          <option value={4}>≥ 4 words</option>
          <option value={8}>≥ 8 words</option>
        </select>
        {/* Raw model output vs Quick Caption pipeline output — both live in the
            same caption JSON, so switching is instant and needs no reprocessing. */}
        <div className="flex rounded border border-gray-300 dark:border-gray-600 overflow-hidden text-xs shrink-0">
          {[['processed', 'Processed'], ['raw', 'Raw'], ['compare', 'Both']].map(([k, lbl]) => (
            <button key={k} onClick={() => setView(k)} title={
              k === 'raw' ? 'Exact model output, before post-processing'
                : k === 'processed' ? 'After the Quick Caption pipeline'
                  : 'Raw and processed stacked, so you can see what changed'}
              className={`px-2 py-1 ${view === k ? 'bg-blue-600 text-white' : 'hover:bg-gray-100 dark:hover:bg-gray-700'}`}>
              {lbl}
            </button>
          ))}
        </div>
      </div>

      {/* Caption stream */}
      <div className="relative flex-1">
        <div
          ref={scrollRef}
          onScroll={onScroll}
          className="overflow-y-auto p-3 space-y-1 h-[52vh]"
        >
          {hiddenCount > 0 && (
            <div className="text-center text-xs text-gray-400 dark:text-gray-500 py-1">
              {hiddenCount} earlier line{hiddenCount === 1 ? '' : 's'} hidden — use Download for full history
            </div>
          )}
          {filtered.length === 0
            ? <div className="italic text-gray-400 dark:text-gray-500">
                {captions.length ? 'No captions match the filter.' : 'No captions yet…'}
              </div>
            : windowed.map((c, i) => (
                <CaptionRow key={c.id} caption={c} view={view}
                  index={filtered.length - windowed.length + i + 1}
                  isLiveRow={isRunning && i === windowed.length - 1}
                  isNew={c._rx && now - c._rx < HIGHLIGHT_MS} />
              ))}
        </div>

        {/* Jump to latest (only when auto-scroll is paused) */}
        {!autoScroll && (
          <button
            onClick={jumpToLatest}
            className="absolute bottom-3 right-4 text-xs px-3 py-1.5 rounded-full shadow-lg
                       bg-blue-600 text-white hover:bg-blue-700 transition-colors"
          >
            ↓ Jump to Latest
          </button>
        )}
      </div>

      {/* Downloads */}
      <div className="flex items-center gap-2 px-3 py-2 border-t border-gray-200 dark:border-gray-700">
        <span className="text-xs text-gray-500 dark:text-gray-400 mr-auto">
          Download{autoScroll ? '' : ' · auto-scroll paused'}:
        </span>
        {['srt', 'txt', 'json'].map(fmt => (
          <button key={fmt} disabled={!captions.length}
            onClick={() => exportCaptions(captions, fmt, label)}
            className="text-xs px-2 py-1 rounded border border-gray-300 dark:border-gray-600
                       hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-40">
            {fmt.toUpperCase()}
          </button>
        ))}
        <button disabled={!captions.length} onClick={() => clearCaptions(feedId)}
          className="text-xs px-2 py-1 rounded border border-gray-300 dark:border-gray-600
                     text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/30 disabled:opacity-40">
          Clear
        </button>
      </div>
    </div>
  )
}

export default function CaptionMonitor() {
  const { connected } = useWebSocket()   // ensure the shared socket is running
  const feedIds = Object.keys(useStore(s => s.feeds)).map(Number).sort((a, b) => a - b)
  const uploads = useStore(s => s.uploads)
  const monitorUploadId = useStore(s => s.monitorUploadId)
  const setMonitorUpload = useStore(s => s.setMonitorUpload)
  // Show the Single Model lane here too, once a model is loaded or it has output.
  const singleActive = useStore(s => s.single.status !== 'idle' || (s.single.captions?.length || 0) > 0)

  // Source priority: an explicitly-selected upload (via "View in Caption Monitor")
  // → the upload currently processing → the most recent upload with captions.
  const activeUpload = useMemo(() => {
    const list = Object.values(uploads || {})
    if (monitorUploadId && uploads[monitorUploadId]) return uploads[monitorUploadId]
    return list.find(u => u.status === 'processing')
      || list.filter(u => u.captions && Object.values(u.captions).some(a => a?.length))
             .sort((a, b) => (b.created || 0) - (a.created || 0))[0]
      || null
  }, [uploads, monitorUploadId])

  return (
    <div>
      <div className="flex items-center gap-2 mb-1">
        <h1 className="text-2xl font-bold">Caption Monitor</h1>
        <span className={`text-xs px-2 py-0.5 rounded ${connected
          ? 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300'
          : 'bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300'}`}>
          {connected ? 'Live' : 'Disconnected'}
        </span>
      </div>
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
        Side-by-side realtime captions, chunk-by-chunk, for both feeds — live UDP streams
        and uploaded-media processing. Each feed keeps its own scroll, search, filters and
        SRT / TXT / JSON export.
      </p>
      {activeUpload && (
        <div className="flex items-center gap-2 text-xs text-blue-600 dark:text-blue-400 mb-3">
          <span>
            Showing captions from upload: <span className="font-medium">{activeUpload.filename}</span>
            {activeUpload.status === 'processing'
              ? ` — processing (${activeUpload.progress || 0}%)`
              : ' — completed'}
            {monitorUploadId ? ' (pinned)' : ''}
          </span>
          {monitorUploadId && (
            <button onClick={() => setMonitorUpload(null)}
              className="px-2 py-0.5 rounded border border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700">
              ← Back to live
            </button>
          )}
        </div>
      )}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {singleActive && <FeedColumn key="single" single activeUpload={null} />}
        {feedIds.map(id => <FeedColumn key={id} feedId={id} activeUpload={activeUpload} />)}
      </div>
    </div>
  )
}
