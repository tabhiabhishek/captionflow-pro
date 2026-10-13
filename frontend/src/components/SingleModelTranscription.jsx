import React, { useEffect, useRef, useState, useMemo, useCallback } from 'react'
import { useStore } from '../store'
import { useWebSocket } from '../hooks/useWebSocket'
import { useInterfaces } from '../hooks/useInterfaces'
import { exportCaptions, toTXT } from '../utils/download'

const STEPS = [
  ['uploaded', 'Uploading'],
  ['extracting', 'Extracting Audio'],
  ['chunked', 'Generating Chunks'],
  ['processing', 'Running Model + Quick Caption Pipeline'],
  ['exporting', 'Saving SRT + Subtitled MKV'],
  ['completed', 'Completed'],
]
// A live source skips upload/extract entirely — ffmpeg writes chunks straight
// into the model's input folder.
const LIVE_STEPS = [
  ['loaded', 'Model Loaded'],
  ['processing', 'Capturing + Running Model + Quick Caption Pipeline'],
]
const SOURCES = [['file', 'Static File'], ['udp', 'UDP']]

// Transcription language. This is the ONLY switch the operator needs: the
// backend keys the whole stack off the chosen lane's language, so picking
// Hindi swaps engine, config, terminology, prompts, logs and output folders
// together. Mixing them (English engine on Hindi audio) yields blank captions,
// so the two sets are never combined.
const LANGUAGES = [
  ['en', 'English', 'quick_captions.py + config.json'],
  ['hi', 'हिन्दी Hindi', 'quick_captions_hi.py + config_hi.json'],
]
const PHASE_ORDER = ['idle', 'loading', 'loaded', 'uploaded', 'extracting', 'chunked', 'processing', 'exporting', 'completed']

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

export default function SingleModelTranscription() {
  const { connected } = useWebSocket()
  const single = useStore(s => s.single)
  const setSingle = useStore(s => s.setSingle)
  const resetSingle = useStore(s => s.resetSingle)
  const clearSingleCaptions = useStore(s => s.clearSingleCaptions)
  const addSingleCaption = useStore(s => s.addSingleCaption)

  const { interfaces } = useInterfaces()

  const [models, setModels] = useState([])
  const [modelsErr, setModelsErr] = useState('')
  const [selModel, setSelModel] = useState('')
  // Which script transcribes: the built-in Quick Captions worker, or any
  // standalone script in backend/pipelines/ (e.g. WhisperX full-file).
  const [pipelines, setPipelines] = useState([])
  const [selPipeline, setSelPipeline] = useState('quick_captions')
  const [lang, setLang] = useState('en')                // en | hi
  const [source, setSource] = useState('file')          // file | udp
  const [udpUrl, setUdpUrl] = useState('udp://@236.1.1.1:6004')
  const [iface, setIface] = useState('')
  const [listening, setListening] = useState(false)
  const [followLive, setFollowLive] = useState(true)
  // Bumping this remounts the <audio> so a new stream is opened rather than the
  // browser replaying a stale, already-ended response.
  const [liveAudioKey, setLiveAudioKey] = useState(0)
  const [rawOnly, setRawOnly] = useState(false)  // worker mode: false = run post-processing (so Compare has both)
  const [view, setView] = useState('compare')    // caption display: processed | raw | compare
  const [uploadPct, setUploadPct] = useState(null)
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')
  const [t, setT] = useState(0)
  const inputRef = useRef(null)
  const xhrRef = useRef(null)
  const audioRef = useRef(null)
  const scrollRef = useRef(null)
  const activeRef = useRef(null)

  // Model list. Fetching this exactly once on mount meant that if the backend was
  // restarting at that moment, the dropdown stayed empty forever with the error
  // swallowed — the page looked like "no models configured". So: report the
  // failure, retry, and refetch whenever the socket reconnects.
  const loadModels = useCallback(async () => {
    setModelsErr('')
    try {
      const r = await fetch('/api/single/models')
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const d = await r.json()
      if (!d.success) throw new Error(d.detail || 'backend returned an error')
      setModels(d.models || [])
      try {
        const pr = await fetch('/api/single/pipelines')
        if (pr.ok) setPipelines((await pr.json()).pipelines || [])
      } catch { /* keep the previous list */ }
      return true
    } catch (e) {
      setModelsErr(`Could not load models: ${e.message}`)
      return false
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    let attempt = 0
    const tick = async () => {
      if (cancelled) return
      const ok = await loadModels()
      if (!ok && ++attempt < 10) setTimeout(tick, 2000)   // backend may still be starting
    }
    tick()
    return () => { cancelled = true }
  }, [loadModels])

  // The socket reconnecting means the backend came back — refresh the list.
  useEffect(() => { if (connected) loadModels() }, [connected, loadModels])

  // The checkpoint is multilingual, so the SAME model serves both languages —
  // no per-language model list, no duplicate weights on disk or in GPU memory.
  // Language is sent at load time and selects the engine/config trio instead.
  const langModels = models

  useEffect(() => {
    if (!models.length) { setSelModel(''); return }
    if (!models.some(m => m.id === selModel)) setSelModel(models[0].id)
  }, [models, selModel])

  // A script declares which model formats it runs (PIPELINE_BACKENDS); live
  // UDP needs the resident Quick Captions worker, so scripts are file-only.
  const selBackend = models.find(m => m.id === selModel)?.backend
  const usablePipelines = useMemo(() => pipelines.filter(p =>
    p.id === 'quick_captions' || (source === 'file' && (!p.backends || !selBackend || p.backends.includes(selBackend)))
  ), [pipelines, selBackend, source])
  useEffect(() => {
    if (usablePipelines.length && !usablePipelines.some(p => p.id === selPipeline))
      setSelPipeline('quick_captions')
  }, [usablePipelines, selPipeline])

  // Adopt the newest upload the server already holds, so a page reload — or a
  // backend restart — never forces the operator to upload the same file twice.
  // The backend rebuilds its registry from uploads/original/ on boot
  // (StaticProcessingService._restore_from_disk), so anything it lists is still
  // on disk and playable. Only runs while no upload is selected, so it can never
  // yank the page off a file the operator just picked.
  useEffect(() => {
    if (single.uploadId) return
    let cancelled = false
    ;(async () => {
      try {
        const r = await fetch('/api/uploads')
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        const d = await r.json()
        const latest = (d.uploads || [])[0]      // list_uploads() sorts newest first
        if (cancelled || !d.success || !latest) return
        setSingle({
          uploadId: latest.id,
          filename: latest.filename,
          phase: latest.phase || 'uploaded',
          status: latest.status || 'uploaded',
          progress: latest.progress || 0,
          totalChunks: latest.total_chunks || 0,
        })
        // A finished run has captions on disk; pull them back so the transcript
        // and the seekable audio player are populated exactly as they were left.
        if ((latest.phase || latest.status) === 'completed') {
          const cr = await fetch(`/api/upload/${latest.id}/captions`)
          if (cr.ok && !cancelled) {
            const cd = await cr.json()
            const segs = cd.captions || cd.segments
              || Object.values(cd.feeds || {})[0]?.captions || []
            if (segs.length) addSingleCaption(segs)
          }
        }
      } catch {
        // No upload to restore is a normal empty state, not an error worth showing.
      }
    })()
    return () => { cancelled = true }
  }, [single.uploadId, setSingle, addSingleCaption])

  // ---- actions ----
  const doUpload = useCallback((file) => {
    if (!file) return
    setError(''); setUploadPct(0)
    const xhr = new XMLHttpRequest(); xhrRef.current = xhr
    const form = new FormData(); form.append('file', file)
    xhr.open('POST', '/api/upload?autostart=false')
    xhr.upload.onprogress = e => { if (e.lengthComputable) setUploadPct(Math.round(100 * e.loaded / e.total)) }
    xhr.onload = () => {
      setUploadPct(null); xhrRef.current = null
      try {
        const res = JSON.parse(xhr.responseText)
        if (res.upload) setSingle({ uploadId: res.upload.id, filename: res.upload.filename })
        else setError(res.detail || 'Upload failed')
      } catch { setError('Upload failed') }
    }
    xhr.onerror = () => { setUploadPct(null); setError('Upload failed (network)') }
    xhr.send(form)
  }, [setSingle])

  const post = (url, body) => fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  // `language` is what picks the engine/config trio — the model itself is
  // multilingual and identical either way.
  const loadModel = () => selModel && post('/api/single/load',
    { model_id: selModel, raw_only: rawOnly, language: lang, pipeline: selPipeline })
  // The backend answers 200 with {success:false} when it cannot start (no model
  // loaded, unknown upload). Ignoring that made Start look dead while the old
  // run kept scrolling — surface it instead.
  const startFile = useCallback(async () => {
    if (!single.uploadId) { setError('Choose a file first'); return }
    setError('')
    clearSingleCaptions()        // this run owns the monitor from here on
    try {
      const res = await post('/api/single/start', { upload_id: single.uploadId })
      const d = await res.json().catch(() => ({}))
      if (!res.ok || d.success === false) {
        setError(d.message || d.detail || 'Could not start file processing')
      }
    } catch (e) {
      setError(`Could not start file processing: ${e.message}`)
    }
  }, [single.uploadId, clearSingleCaptions])
  const startLive = useCallback(async () => {
    setError('')
    clearSingleCaptions()          // a new run starts from a clean monitor
    setListening(false)            // drop any monitor stream from the previous run
    setLiveAudioKey(k => k + 1)

    const res = await post('/api/single/start_live', {
      url: udpUrl,
      source_type: 'udp',
      interface: iface,
    })
    if (!res.ok) {
      const d = await res.json().catch(() => ({}))
      setError(d.detail || 'Could not start live capture')
    }
  }, [udpUrl, iface, clearSingleCaptions])
  const start = () => (source === 'file' ? startFile() : startLive())
  const stop = () => post('/api/single/stop')
  const reset = async () => { await post('/api/single/unload'); resetSingle() }

  // ---- sync: highlight active caption by audio time ----
  // Declared before every use below — `const` is not hoisted, and referencing it
  // earlier threw a ReferenceError on each render, which blanked the whole page.
  const isLive = source !== 'file'
  const caps = single.captions || []
  // On a live feed there is no audio timeline, so the "active" row can't be
  // derived from playback position — the newest caption IS the live one.
  const liveIdx = caps.length - 1
  const activeIdx = isLive ? liveIdx : activeIndex(caps, t)
  useEffect(() => {
    if (activeRef.current) activeRef.current.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [activeIdx])
  // Follow the feed: scroll to the newest caption as it arrives, unless the user
  // has scrolled up to read back (then leave their position alone).
  useEffect(() => {
    if (!isLive || !followLive) return
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [caps.length, isLive, followLive])
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return q ? caps.filter(c => (c.text || '').toLowerCase().includes(q)) : caps
  }, [caps, search])
  const seek = (sec) => { const el = audioRef.current; if (el) { el.currentTime = sec; el.play().catch(() => {}) } }

  const audioReady = !isLive && !!single.uploadId && ['extracting', 'chunked', 'processing', 'completed'].includes(single.phase)
  const modelLoaded = ['loaded', 'processing', 'completed'].includes(single.status)
  const pi = Math.max(0, PHASE_ORDER.indexOf(single.phase))
  const cur = caps[activeIdx]
  const running = single.phase === 'processing'
  // Start is NOT gated on `running`. Both backend start paths take over from
  // whatever was running, so switching source mid-run and pressing Start is a
  // valid, deliberate action. Disabling it here was why picking Static File
  // left UDP permanently unstartable: a file run that stalled (or a long one)
  // held phase='processing' forever and locked the whole panel.
  const canStart = modelLoaded && (
    source === 'file' ? !!single.uploadId : !!udpUrl.trim())

  return (
    <div>
      <div className="flex items-center gap-2 mb-1">
        <h1 className="text-2xl font-bold">Single Model Transcription</h1>
        <span className={`text-xs px-2 py-0.5 rounded ${connected
          ? 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300'
          : 'bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300'}`}>{connected ? 'Live' : 'Disconnected'}</span>
      </div>
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
        One model at a time — from a static file or a live UDP feed. Both run the identical
        production pipeline (chunk → model → Quick Caption); only the chunk source differs.
        The language below selects the whole stack —
        <code className="mx-1 px-1 rounded bg-gray-100 dark:bg-gray-800">
          {LANGUAGES.find(([k]) => k === lang)?.[2]}
        </code>
        — and its own terminology, prompt, log and output folders.
      </p>

      {/* Language — swaps the entire stack (engine + config + terminology). */}
      <div className="flex items-center gap-2 mb-3">
        <span className="text-xs uppercase tracking-wide text-gray-400 dark:text-gray-500">Language</span>
        <div className="flex rounded border border-gray-300 dark:border-gray-600 overflow-hidden text-sm">
          {LANGUAGES.map(([k, lbl, stack]) => (
            <button key={k} onClick={() => setLang(k)} disabled={running} title={stack}
              className={`px-3 py-1.5 disabled:opacity-40 ${lang === k
                ? 'bg-indigo-600 text-white'
                : 'hover:bg-gray-100 dark:hover:bg-gray-700'}`}>{lbl}</button>
          ))}
        </div>
        <code className="text-[11px] px-1.5 py-0.5 rounded bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300">
          {LANGUAGES.find(([k]) => k === lang)?.[2]}
        </code>
        {modelLoaded && (single.language || 'en').toLowerCase() !== lang && (
          <span className="text-[11px] px-2 py-0.5 rounded bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200">
            loaded model is {(single.language || 'en').toUpperCase()} — reload to apply
          </span>
        )}
      </div>

      {/* Source selector — decides who produces the chunks. Enabled during a
          run on purpose: Start takes over, so switching source is one click. */}
      <div className="flex items-center gap-2 mb-4">
        <span className="text-xs uppercase tracking-wide text-gray-400 dark:text-gray-500">Source</span>
        <div className="flex rounded border border-gray-300 dark:border-gray-600 overflow-hidden text-sm">
          {SOURCES.map(([k, lbl]) => (
            <button key={k} onClick={() => setSource(k)}
              className={`px-3 py-1.5 ${source === k
                ? 'bg-blue-600 text-white'
                : 'hover:bg-gray-100 dark:hover:bg-gray-700'}`}>{lbl}</button>
          ))}
        </div>
        {running && (
          <span className="text-[11px] text-gray-500 dark:text-gray-400">
            running — pressing Start switches to {source === 'file' ? 'the file' : 'UDP'}
          </span>
        )}
        {single.live && (
          <span className="text-xs px-2 py-0.5 rounded bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300">
            ● LIVE — {single.chunksCaptured} chunks captured
          </span>
        )}
        {/* Dropped chunks ARE lost words — the model never saw that audio. */}
        {single.chunksDropped > 0 && (
          <span className="text-xs px-2 py-0.5 rounded bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200"
                title="Chunks discarded because inference could not keep up. That audio was never transcribed, so words are missing from the output.">
            ⚠ {single.chunksDropped} chunk{single.chunksDropped === 1 ? '' : 's'} dropped — words lost
          </span>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Left: source + model + controls + info */}
        <div className="space-y-4">
          {/* Upload (static file only) */}
          {source === 'file' && (
          <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4">
            <div className="font-semibold mb-2">Upload Media File</div>
            <div onClick={() => inputRef.current?.click()}
              className="cursor-pointer rounded-lg border-2 border-dashed border-gray-300 dark:border-gray-600 p-5 text-center text-sm text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/40">
              📁 {single.filename || 'Click to choose a video/audio file'}
              <input ref={inputRef} type="file" className="hidden"
                accept=".mp4,.mov,.mkv,.mxf,.avi,.ts,.wav,.mp3,.aac,.flac,.m4a,.ogg"
                onChange={e => doUpload(e.target.files?.[0])} />
            </div>
            {uploadPct !== null && (
              <div className="mt-2 h-2 rounded bg-gray-200 dark:bg-gray-700 overflow-hidden">
                <div className="h-full bg-blue-500" style={{ width: `${uploadPct}%` }} /></div>
            )}
            {error && <div className="text-xs text-red-600 dark:text-red-400 mt-2">{error}</div>}
          </div>
          )}

          {/* Live source (UDP) */}
          {isLive && (
          <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4">
            <div className="font-semibold mb-2">UDP Source</div>
            <label className="block text-[10px] uppercase tracking-wide text-gray-400 dark:text-gray-500 mb-1">Stream URL</label>
            <input value={udpUrl} onChange={e => setUdpUrl(e.target.value)} disabled={running}
              placeholder="udp://@236.1.1.1:6004"
              className="w-full text-sm px-2 py-1.5 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-800 dark:text-gray-100 disabled:opacity-50" />
            <label className="block text-[10px] uppercase tracking-wide text-gray-400 dark:text-gray-500 mt-3 mb-1">Network Interface</label>
            <select value={iface} onChange={e => setIface(e.target.value)} disabled={running}
              className="w-full text-sm px-2 py-1.5 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-800 dark:text-gray-100 disabled:opacity-50">
              {interfaces.map(i => <option key={i.address || 'auto'} value={i.address}>{i.name}{i.address ? ` — ${i.address}` : ''}</option>)}
            </select>
            <p className="text-[11px] text-gray-500 dark:text-gray-400 mt-2">
              For multicast, pick the NIC the stream arrives on — "Auto" follows the default route
              and will miss the feed if that is the wrong adapter.
            </p>
            {error && <div className="text-xs text-red-600 dark:text-red-400 mt-2">{error}</div>}
          </div>
          )}

          {/* Model selector + info */}
          <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4">
            <div className="flex items-center gap-2 mb-2">
              <div className="font-semibold">Choose Model</div>
              <span className="text-xs text-gray-400 dark:text-gray-500">
                {langModels.length} {lang === 'hi' ? 'Hindi' : 'English'} lane{langModels.length === 1 ? '' : 's'}
              </span>
              <button onClick={loadModels}
                className="ml-auto text-xs px-2 py-0.5 rounded border border-gray-300 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700">
                ↻ Refresh
              </button>
            </div>
            <select value={selModel} onChange={e => setSelModel(e.target.value)}
              className="w-full text-sm px-2 py-1.5 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-800 dark:text-gray-100">
              {langModels.length === 0 && (
                <option value="">{modelsErr ? 'Model list unavailable'
                  : `No ${lang === 'hi' ? 'Hindi' : 'English'} lane configured`}</option>
              )}
              {langModels.map(m => <option key={m.id} value={m.id}>{m.display_name}</option>)}
            </select>
            <div className="font-semibold mt-3 mb-1 text-sm">Transcribe with</div>
            <select value={selPipeline} onChange={e => setSelPipeline(e.target.value)}
              className="w-full text-sm px-2 py-1.5 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-800 dark:text-gray-100">
              {(usablePipelines.length ? usablePipelines : [{ id: 'quick_captions', label: 'Quick Captions (chunked live pipeline)' }])
                .map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
            </select>
            {modelLoaded && single.pipeline && single.pipeline !== selPipeline && (
              <div className="text-xs text-amber-600 dark:text-amber-400 mt-1">Reload the model to switch pipeline.</div>
            )}
            {langModels.length === 0 && !modelsErr && (
              <div className="text-xs text-amber-600 dark:text-amber-400 mt-1">
                Add a lane with <code>"language": "{lang}"</code> to config/static_config.json,
                then restart the backend.
              </div>
            )}
            {modelsErr && (
              <div className="text-xs text-red-600 dark:text-red-400 mt-1">
                {modelsErr} — retrying. Check the backend is running on :8000.
              </div>
            )}
            <div className="grid grid-cols-2 gap-2 mt-3 text-xs">
              <Info label="Model" value={single.displayName || (models.find(m => m.id === selModel)?.display_name) || '—'} />
              <Info label="Pipeline" value={single.pipelineLabel || '—'} />
              <Info label="Stage" value={single.stage || '—'} />
              <Info label="Status" value={single.status} tone={modelLoaded ? 'good' : single.status === 'error' ? 'bad' : 'default'} />
              <Info label="Device" value={single.device || (models.find(m => m.id === selModel)?.device) || '—'} tone={single.device === 'cuda' ? 'good' : 'default'} />
              <Info label="GPU Memory" value={single.gpuMemory ? `${single.gpuMemory.used_gb} / ${single.gpuMemory.total_gb} GB` : '—'} />
              <div className="col-span-2"><Info label="Model Path" value={single.modelPath || (models.find(m => m.id === selModel)?.model_path) || '—'} /></div>
            </div>

            {/* Raw ASR only — judge the pure model output (no post-processing).
                Applied at load time, so change it before loading the model. */}
            <label className="flex items-start gap-2 mt-3 text-xs cursor-pointer select-none">
              <input type="checkbox" checked={rawOnly} onChange={e => setRawOnly(e.target.checked)}
                className="mt-0.5" />
              <span className="text-gray-700 dark:text-gray-200">
                <span className="font-medium">Raw ASR only</span>
                <span className="text-gray-500 dark:text-gray-400">
                  {' '}— emit the model's exact output with no post-processing, dedup, or
                  hallucination filter. Best for judging pure model quality.
                  {modelLoaded && single.rawOnly !== rawOnly &&
                    <span className="text-amber-600 dark:text-amber-400"> (reload the model to apply)</span>}
                </span>
              </span>
            </label>
          </div>

          {/* Controls */}
          <div className="flex flex-wrap gap-2">
            <button onClick={loadModel} disabled={!selModel || single.status === 'loading'}
              className="text-sm font-semibold px-4 py-2 rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50">
              {single.status === 'loading' ? 'Loading…' : modelLoaded ? '↻ Reload Model' : 'Load Model'}
            </button>
            <button onClick={start} disabled={!canStart}
              className="text-sm font-semibold px-4 py-2 rounded bg-green-600 text-white hover:bg-green-700 disabled:opacity-50">
              {isLive ? '▶ Start Live' : '▶ Start'}
            </button>
            <button onClick={stop} disabled={!running}
              className="text-sm font-semibold px-4 py-2 rounded bg-red-600 text-white hover:bg-red-700 disabled:opacity-50">■ Stop</button>
            <button onClick={reset}
              className="text-sm px-4 py-2 rounded border border-gray-300 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700">Reset</button>
          </div>

          {/* Progress */}
          <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 p-3 space-y-1">
            {(isLive ? LIVE_STEPS : STEPS).map(([key, label]) => {
              const idx = PHASE_ORDER.indexOf(key)
              const state = single.phase === 'completed' ? 'done' : pi > idx ? 'done' : pi === idx ? 'active' : 'pending'
              const icon = state === 'done' ? '✓' : state === 'active' ? '⟳' : '•'
              const cls = state === 'done' ? 'text-green-600 dark:text-green-400'
                : state === 'active' ? 'text-blue-600 dark:text-blue-400' : 'text-gray-400 dark:text-gray-600'
              const detail = key !== 'processing' ? ''
                : isLive ? `${single.processed || 0} processed / ${single.chunksCaptured || 0} captured`
                  : single.pipeline && single.pipeline !== 'quick_captions' ? `${single.stage || ''} ${single.progress || 0}%`
                  : single.totalChunks ? `Chunk ${single.processed} / ${single.totalChunks}` : ''
              return (
                <div key={key} className="flex items-center gap-2 text-xs">
                  <span className={`w-4 text-center ${cls}`}>{icon}</span>
                  <span className={state === 'pending' ? 'text-gray-400 dark:text-gray-600' : 'text-gray-700 dark:text-gray-200'}>{label}</span>
                  <span className="ml-auto text-gray-500 dark:text-gray-400">{detail}</span>
                </div>
              )
            })}
            {single.error && <div className="text-xs text-red-600 dark:text-red-400">Error: {single.error}</div>}
            {single.exports && (
              <div className="text-xs text-gray-600 dark:text-gray-300 break-all space-y-0.5">
                {single.exports.srt && <div>SRT: {single.exports.srt}</div>}
                {single.exports.mkv && <div>Video + subtitles: {single.exports.mkv}</div>}
                {single.exports.error && <div className="text-amber-600 dark:text-amber-400">Export: {single.exports.error}</div>}
              </div>
            )}
          </div>
        </div>

        {/* Right: audio player + live caption + monitor */}
        <div className="space-y-3">
          <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-3">
            {isLive && single.live ? (
              // Live monitor: taps the same PCM the model is transcribing, so what
              // you hear matches the captions rather than a second UDP reader.
              <div>
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-xs font-semibold text-gray-700 dark:text-gray-200">🎧 Live Monitor</span>
                  {!listening && (
                    <button onClick={() => setListening(true)}
                      className="text-xs px-2 py-1 rounded bg-blue-600 text-white hover:bg-blue-700">Listen</button>
                  )}
                  {listening && (
                    <button onClick={() => setListening(false)}
                      className="text-xs px-2 py-1 rounded border border-gray-300 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700">Stop listening</button>
                  )}
                  <span className="text-[11px] text-gray-500 dark:text-gray-400">
                    {listening ? 'streaming the captured audio' : 'off — click Listen to monitor the feed'}
                  </span>
                </div>
                {listening && (
                  <audio key={liveAudioKey} src={`/api/single/live-audio?t=${liveAudioKey}`}
                    controls autoPlay className="w-full h-9"
                    onError={() => setError('Live audio stream ended or unavailable.')} />
                )}
              </div>
            ) : audioReady ? (
              <audio ref={audioRef} src={`/api/upload/${single.uploadId}/audio`} controls preload="auto"
                onTimeUpdate={e => setT(e.target.currentTime)} className="w-full h-9" />
            ) : (
              <div className="text-xs italic text-gray-500 dark:text-gray-400">
                {isLive
                  ? 'Live source — captions stream in as chunks are captured (no seekable audio).'
                  : 'Audio available once processing starts.'}
              </div>
            )}
            <div className="mt-2 rounded-lg px-3 py-2 border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900">
              <div className="text-[10px] uppercase tracking-wide text-gray-400 dark:text-gray-500">
                @ {fmtT(t)} {cur ? `· chunk #${cur.chunk ?? ''}` : ''}
              </div>
              <div className="text-base text-gray-900 dark:text-gray-50">{cur?.text || <span className="italic text-gray-400 dark:text-gray-600">…</span>}</div>
            </div>
          </div>

          {/* Live Caption Window / Monitor (processed only) */}
          <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 flex flex-col">
            <div className="flex items-center gap-2 px-3 py-2 border-b border-gray-200 dark:border-gray-700 flex-wrap">
              <span className="font-semibold text-sm">Live Captions</span>
              <span className="text-xs text-gray-500 dark:text-gray-400">{caps.length} lines</span>
              {isLive && single.live && (
                <>
                  {/* Where the feed currently is, so you can tell a stalled
                      monitor from a quiet passage at a glance. */}
                  <span className="text-xs px-2 py-0.5 rounded bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300 font-mono">
                    ● now: {single.currentChunk || '—'}
                  </span>
                  <button onClick={() => setFollowLive(v => !v)}
                    title={followLive ? 'Following the live edge — click to freeze and read back'
                                      : 'Frozen — click to jump back to the live edge'}
                    className={`text-xs px-2 py-1 rounded border ${followLive
                      ? 'bg-blue-600 text-white border-blue-600'
                      : 'border-gray-300 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700'}`}>
                    {followLive ? '↓ Following' : '⏸ Frozen'}
                  </button>
                </>
              )}
              {/* Raw vs Processed view — decide which post-processing helps/hurts */}
              <div className="flex rounded border border-gray-300 dark:border-gray-600 overflow-hidden text-xs">
                {[['processed', 'Processed'], ['raw', 'Raw ASR'], ['compare', 'Compare']].map(([k, lbl]) => (
                  <button key={k} onClick={() => setView(k)}
                    className={`px-2 py-1 ${view === k ? 'bg-blue-600 text-white' : 'hover:bg-gray-100 dark:hover:bg-gray-700'}`}>{lbl}</button>
                ))}
              </div>
              <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search…"
                className="ml-auto text-xs px-2 py-1 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-800 dark:text-gray-100" />
              {['srt', 'txt'].map(f => (
                <button key={f} disabled={!caps.length} onClick={() => exportCaptions(caps, f, single.filename || 'single')}
                  className="text-xs px-2 py-1 rounded border border-gray-300 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-40">{f.toUpperCase()}</button>
              ))}
              <button disabled={!caps.length} onClick={() => navigator.clipboard?.writeText(toTXT(caps))}
                className="text-xs px-2 py-1 rounded border border-gray-300 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-40">Copy</button>
            </div>
            <div ref={scrollRef}
              onScroll={() => {
                const el = scrollRef.current
                if (!el || !isLive) return
                // Re-arm following only when the user returns to the bottom.
                setFollowLive(el.scrollHeight - el.scrollTop - el.clientHeight < 40)
              }}
              className="h-[46vh] overflow-y-auto p-2 text-sm space-y-0.5">
              {filtered.length === 0
                ? <div className="italic text-gray-400 dark:text-gray-500">No captions yet…</div>
                : filtered.map((c) => {
                  const isActive = c.id === caps[activeIdx]?.id
                  const isLiveRow = isLive && single.live && c.id === caps[liveIdx]?.id
                  const raw = (c.raw || '').trim()
                  const proc = (c.text || '').trim()
                  const changed = raw && proc && raw !== proc
                  return (
                    <div key={c.id} ref={isActive ? activeRef : null} onClick={() => seek(c.start)}
                      className={`flex gap-2 px-1 py-0.5 rounded cursor-pointer ${
                        isLiveRow ? 'bg-red-50 dark:bg-red-900/30 ring-1 ring-red-300 dark:ring-red-800'
                          : isActive ? 'bg-blue-100 dark:bg-blue-900/40'
                            : 'hover:bg-gray-100 dark:hover:bg-gray-700/40'}`}>
                      <span className={`font-mono text-xs shrink-0 ${isLiveRow
                        ? 'text-red-600 dark:text-red-400 font-bold' : 'text-blue-400 dark:text-blue-500'}`}>
                        {isLiveRow ? '●' : ''}#{c.chunk ?? ''}
                      </span>
                      <span className="text-gray-400 dark:text-gray-500 font-mono text-xs shrink-0 w-10">{fmtT(c.start)}</span>
                      {view === 'processed' && (
                        <span className={isActive ? 'text-gray-900 dark:text-gray-50 font-medium' : 'text-gray-800 dark:text-gray-100'}>{proc || raw}</span>
                      )}
                      {view === 'raw' && (
                        <span className="text-gray-800 dark:text-gray-100 font-mono">{raw || <span className="italic text-gray-400">—</span>}</span>
                      )}
                      {view === 'compare' && (
                        <span className="flex-1 min-w-0">
                          <span className="block font-mono text-gray-500 dark:text-gray-400">
                            <span className="text-[10px] uppercase mr-1 text-gray-400">raw</span>{raw || '—'}
                          </span>
                          {changed
                            ? <span className="block text-emerald-700 dark:text-emerald-400">
                                <span className="text-[10px] uppercase mr-1 opacity-70">proc</span>{proc}
                              </span>
                            : <span className="block text-[10px] uppercase text-gray-400">unchanged</span>}
                        </span>
                      )}
                    </div>
                  )
                })}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function Info({ label, value, tone = 'default' }) {
  const toneCls = { default: 'text-gray-800 dark:text-gray-100', good: 'text-green-600 dark:text-green-400', bad: 'text-red-600 dark:text-red-400' }[tone]
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-gray-400 dark:text-gray-500">{label}</div>
      <div className={`text-xs font-medium truncate ${toneCls}`}>{value}</div>
    </div>
  )
}
