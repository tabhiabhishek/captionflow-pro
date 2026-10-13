import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { exportCaptions, toTXT } from '../utils/download'

// Synced verify view: one shared audio player, then TWO stacked sections —
// upper = RAW model output, lower = POST-PROCESSED caption — for both feeds.
// When processing starts the audio auto-plays; every pane highlights the line at
// the playhead and auto-scrolls, so you can hear the audio and compare exactly
// what the model said vs what post-processing produced.

function fmtT(s) {
  s = Math.max(0, s || 0)
  const m = Math.floor(s / 60), sec = Math.floor(s % 60)
  return `${m}:${String(sec).padStart(2, '0')}`
}

function activeIndex(caps, t) {
  let idx = -1
  for (let i = 0; i < caps.length; i++) { if (t >= caps[i].start) idx = i; else break }
  return idx
}
const norm = s => (s || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim()

// A subtitle pane rendering one field ('raw' | 'text') of the caption list.
function Pane({ feedId, model, caps, field, activeIdx, onSeek, showExport }) {
  const paneRef = useRef(null)
  const activeRef = useRef(null)
  useEffect(() => {
    if (activeRef.current) activeRef.current.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [activeIdx])
  const label = `feed${feedId}_${field === 'raw' ? 'raw' : 'processed'}`
  return (
    <div className="flex-1 min-w-0 border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 flex flex-col">
      <div className="px-3 py-1.5 border-b border-gray-200 dark:border-gray-700 flex items-center justify-between">
        <div><span className="font-semibold text-sm">Feed {feedId}</span>
          <span className="text-xs text-gray-500 dark:text-gray-400 ml-2">{model || '—'}</span></div>
        {showExport && (
          <div className="flex gap-1">
            {['srt', 'txt', 'json'].map(f => (
              <button key={f} disabled={!caps.length} onClick={() => exportCaptions(caps, f, label)}
                className="text-xs px-2 py-0.5 rounded border border-gray-300 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-40">{f.toUpperCase()}</button>
            ))}
            <button disabled={!caps.length} onClick={() => navigator.clipboard?.writeText(toTXT(caps))}
              className="text-xs px-2 py-0.5 rounded border border-gray-300 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-40">Copy</button>
          </div>
        )}
      </div>
      <div ref={paneRef} className="h-40 overflow-y-auto p-2 text-sm space-y-0.5">
        {caps.length === 0
          ? <div className="italic text-gray-400 dark:text-gray-500">No captions yet…</div>
          : caps.map((c, i) => {
            const val = field === 'raw' ? (c.raw ?? '') : (c.text ?? '')
            const isActive = i === activeIdx
            return (
              <div key={c.id || i} ref={isActive ? activeRef : null} onClick={() => onSeek(c.start)}
                className={`flex gap-2 px-1 py-0.5 rounded cursor-pointer transition-colors
                  ${isActive ? 'bg-blue-100 dark:bg-blue-900/40' : 'hover:bg-gray-100 dark:hover:bg-gray-700/40'}`}>
                <span className="text-gray-400 dark:text-gray-500 font-mono text-xs shrink-0 w-10">{fmtT(c.start)}</span>
                <span className={isActive ? 'text-gray-900 dark:text-gray-50 font-medium' : 'text-gray-700 dark:text-gray-200'}>
                  {val || <span className="text-gray-400 dark:text-gray-600 italic">(empty)</span>}
                </span>
              </div>
            )
          })}
      </div>
    </div>
  )
}

export default function SyncedComparePlayer({ upload }) {
  const audioRef = useRef(null)
  const [t, setT] = useState(0)
  const [rate, setRate] = useState(1)
  const [blocked, setBlocked] = useState(false)
  const autoStartedRef = useRef(false)

  const audioReady = ['chunked', 'processing', 'completed'].includes(upload.phase) || !!upload.audio_path
  const isProcessing = ['extracting', 'chunked', 'processing'].includes(upload.phase)

  const feedIds = Object.keys(upload.feeds || { 1: {}, 2: {} }).map(Number).sort()
  const capsByFeed = useMemo(() => {
    const m = {}
    for (const fid of feedIds) m[fid] = (upload.captions?.[String(fid)] || []).slice().sort((a, b) => a.start - b.start)
    return m
  }, [upload.captions, feedIds.join(',')])

  const actives = {}
  feedIds.forEach(fid => { actives[fid] = activeIndex(capsByFeed[fid], t) })

  const seek = useCallback((sec) => {
    const el = audioRef.current
    if (el) { el.currentTime = sec; el.play().catch(() => {}) }
  }, [])
  const playFromStart = useCallback(() => {
    const el = audioRef.current
    if (!el) return
    el.currentTime = 0
    el.play().then(() => setBlocked(false)).catch(() => setBlocked(true))
  }, [])
  useEffect(() => { if (audioRef.current) audioRef.current.playbackRate = rate }, [rate])
  useEffect(() => {
    if (audioReady && isProcessing && !autoStartedRef.current && audioRef.current) {
      autoStartedRef.current = true
      const el = audioRef.current
      el.load()
      el.play().then(() => setBlocked(false)).catch(() => setBlocked(true))
    }
  }, [audioReady, isProcessing])

  const audioUrl = `/api/upload/${upload.id}/audio`

  return (
    <div>
      {/* Shared audio player */}
      <div className="flex items-center gap-3 mb-2">
        {audioReady ? (
          <audio ref={audioRef} src={audioUrl} controls preload="auto"
            onTimeUpdate={e => setT(e.target.currentTime)} className="flex-1 h-9" />
        ) : (
          <div className="flex-1 text-xs text-gray-500 dark:text-gray-400 italic">
            Extracting audio… playback will start automatically.
          </div>
        )}
        <label className="text-xs text-gray-500 dark:text-gray-400 flex items-center gap-1">
          Speed
          <select value={rate} onChange={e => setRate(Number(e.target.value))}
            className="text-xs px-1 py-0.5 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700">
            {[0.5, 0.75, 1, 1.25, 1.5, 2].map(r => <option key={r} value={r}>{r}×</option>)}
          </select>
        </label>
      </div>
      {audioReady && blocked && (
        <button onClick={playFromStart}
          className="mb-2 text-sm font-semibold px-4 py-1.5 rounded bg-green-600 text-white hover:bg-green-700">
          ▶ Play in sync with captions
        </button>
      )}

      {/* Current line at the playhead: raw vs processed, per feed */}
      <div className="flex flex-col md:flex-row gap-2 mb-3">
        {feedIds.map(fid => {
          const cur = capsByFeed[fid][actives[fid]]
          return (
            <div key={fid} className="flex-1 rounded-lg px-3 py-2 border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900">
              <div className="text-[10px] uppercase tracking-wide text-gray-400 dark:text-gray-500">
                Feed {fid} · {upload.feeds?.[String(fid)]?.model || '—'} @ {fmtT(t)}
              </div>
              <div className="text-xs text-amber-700 dark:text-amber-400 mt-0.5">
                RAW: {cur?.raw || <span className="italic text-gray-400 dark:text-gray-600">…</span>}
              </div>
              <div className="text-base text-gray-900 dark:text-gray-50">
                {cur?.text || <span className="italic text-gray-400 dark:text-gray-600">…</span>}
              </div>
            </div>
          )
        })}
      </div>

      {/* UPPER HALF — raw model output */}
      <div className="text-xs font-semibold text-amber-700 dark:text-amber-400 mb-1">Raw model output (as transcribed)</div>
      <div className="flex flex-col md:flex-row gap-2 mb-3">
        {feedIds.map(fid => (
          <Pane key={`raw${fid}`} feedId={fid} model={upload.feeds?.[String(fid)]?.model}
            caps={capsByFeed[fid]} field="raw" activeIdx={actives[fid]} onSeek={seek} showExport={false} />
        ))}
      </div>

      {/* LOWER HALF — post-processed captions */}
      <div className="text-xs font-semibold text-blue-700 dark:text-blue-400 mb-1">Post-processed captions (final)</div>
      <div className="flex flex-col md:flex-row gap-2">
        {feedIds.map(fid => (
          <Pane key={`proc${fid}`} feedId={fid} model={upload.feeds?.[String(fid)]?.model}
            caps={capsByFeed[fid]} field="text" activeIdx={actives[fid]} onSeek={seek} showExport={true} />
        ))}
      </div>
    </div>
  )
}
