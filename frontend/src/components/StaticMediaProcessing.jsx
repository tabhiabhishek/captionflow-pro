import React, { useEffect, useRef, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { useStore } from '../store'
import SyncedComparePlayer from './SyncedComparePlayer'
import ProcessingSteps from './ProcessingSteps'
import ChunkComparison from './ChunkComparison'

const ACCEPT = '.mp4,.mov,.mkv,.mxf,.avi,.ts,.mpg,.mpeg,.m2ts,.wav,.mp3,.aac,.flac,.m4a,.ogg'

function fmtBytes(b) {
  if (!b) return '—'
  const u = ['B', 'KB', 'MB', 'GB']
  let i = 0, n = b
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++ }
  return `${n.toFixed(1)} ${u[i]}`
}
function fmtDur(s) {
  const n = Number(s)
  if (!n) return '—'
  const h = Math.floor(n / 3600), m = Math.floor((n % 3600) / 60), sec = Math.floor(n % 60)
  return h ? `${h}h ${m}m ${sec}s` : `${m}m ${sec}s`
}

function ProgressBar({ value, label }) {
  return (
    <div>
      {label && <div className="flex justify-between text-xs text-gray-500 dark:text-gray-400 mb-0.5">
        <span>{label}</span><span>{value}%</span></div>}
      <div className="h-2 rounded bg-gray-200 dark:bg-gray-700 overflow-hidden">
        <div className="h-full bg-blue-500 dark:bg-blue-400 transition-all" style={{ width: `${value || 0}%` }} />
      </div>
    </div>
  )
}

function UploadCard({ upload, models }) {
  const removeUpload = useStore(s => s.removeUpload)
  const setMonitorUpload = useStore(s => s.setMonitorUpload)
  const navigate = useNavigate()
  const m = upload.metadata || {}
  const hasCaptions = Object.values(upload.captions || {}).some(a => a?.length)
  const [resultView, setResultView] = useState('compare')

  // Which two models to compare. Default to the first two available; the operator
  // can change them before pressing Start.
  const [modelA, setModelA] = useState('')
  const [modelB, setModelB] = useState('')
  useEffect(() => {
    if (!models.length) return
    setModelA(a => a || models[0]?.id || '')
    setModelB(b => b || models[1]?.id || models[0]?.id || '')
  }, [models])

  const viewInMonitor = () => {
    setMonitorUpload(upload.id)
    navigate('/monitor')
  }

  const startProcessing = async () => {
    await fetch('/api/process', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ upload_id: upload.id, models: [modelA, modelB] }),
    })
  }
  const stopProcessing = () => fetch(`/api/upload/${upload.id}/stop`, { method: 'POST' })
  const restartProcessing = () => fetch(`/api/upload/${upload.id}/restart`, { method: 'POST' })
  const del = async () => {
    await fetch(`/api/upload/${upload.id}`, { method: 'DELETE' })
    removeUpload(upload.id)
  }

  const isProcessing = ['extracting', 'chunked', 'processing'].includes(upload.phase)
  const notStarted = ['uploaded', 'stopped'].includes(upload.status)

  return (
    <div className="border border-gray-200 dark:border-gray-700 rounded-lg bg-gray-50 dark:bg-gray-900 p-3 mb-3">
      {/* File header + metadata (Task 8) */}
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className="min-w-0">
          <div className="font-semibold truncate">{upload.filename}</div>
          <div className="text-xs text-gray-500 dark:text-gray-400">
            {fmtBytes(upload.size_bytes)} · {fmtDur(m.duration)}
            {m.video ? ` · ${m.video.codec} ${m.video.resolution} @ ${m.video.fps}` : ''}
            {m.audio ? ` · ${m.audio.codec} ${m.audio.sample_rate}Hz ${m.audio.channels}ch` : ''}
            {m.bitrate ? ` · ${Math.round(m.bitrate / 1000)}kbps` : ''}
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {/* Status badge (STEP 1) */}
          <span className={`text-xs font-medium px-2 py-0.5 rounded ${
            upload.status === 'completed' ? 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300'
            : upload.status === 'error' ? 'bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300'
            : isProcessing ? 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300'
            : upload.status === 'stopped' ? 'bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300'
            : 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300'}`}>
            {upload.status === 'completed' ? 'Completed' : upload.status === 'error' ? 'Error'
              : isProcessing ? 'Processing' : upload.status === 'stopped' ? 'Stopped' : 'Ready'}
          </span>
          {/* Start Processing — when ready / stopped / after an error. */}
          {(notStarted || upload.status === 'error') && (
            <button onClick={startProcessing}
              className="text-xs font-semibold px-3 py-1 rounded bg-green-600 text-white hover:bg-green-700">
              ▶ Start Processing
            </button>
          )}
          {/* Stop + Restart while running. */}
          {isProcessing && (
            <>
              <button onClick={stopProcessing}
                className="text-xs font-semibold px-3 py-1 rounded bg-red-600 text-white hover:bg-red-700">
                ■ Stop
              </button>
              <button onClick={restartProcessing}
                className="text-xs px-2 py-1 rounded border border-gray-300 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700">
                🔄 Restart
              </button>
            </>
          )}
          {upload.status === 'completed' && (
            <button onClick={restartProcessing}
              className="text-xs px-2 py-1 rounded border border-gray-300 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700">
              🔄 Reprocess
            </button>
          )}
          <button onClick={viewInMonitor} disabled={!hasCaptions}
            title={hasCaptions ? 'Show this upload in the Caption Monitor' : 'No captions yet'}
            className="text-xs px-2 py-1 rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40">
            📺 Monitor
          </button>
          <a href={`/api/upload/${upload.id}/audio`} target="_blank" rel="noreferrer"
             className="text-xs px-2 py-1 rounded border border-gray-300 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700">Audio</a>
          <button onClick={del}
            className="text-xs px-2 py-1 rounded border border-gray-300 dark:border-gray-600 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/30">Delete</button>
        </div>
      </div>

      {/* Model selection + Ready hint before processing (STEP 1) */}
      {notStarted && (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-2">
            {[['Model A', modelA, setModelA], ['Model B', modelB, setModelB]].map(([lbl, val, set]) => (
              <label key={lbl} className="text-xs text-gray-600 dark:text-gray-300">
                <span className="block mb-0.5 font-medium">{lbl}</span>
                <select value={val} onChange={e => set(e.target.value)}
                  className="w-full text-xs px-2 py-1.5 rounded border border-gray-300 dark:border-gray-600
                             bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100">
                  {models.length === 0 && <option value="">No models found</option>}
                  {models.map(mm => (
                    <option key={mm.id} value={mm.id}>
                      {mm.display_name}{mm.backend ? ` · ${mm.backend}` : ''}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>
          <div className="text-xs text-gray-500 dark:text-gray-400 mb-1">
            File uploaded and ready. Pick two models to compare, then press{' '}
            <span className="font-medium">▶ Start Processing</span> to extract audio,
            generate chunks once, and run both models on identical audio.
          </div>
        </>
      )}

      {/* Processing steps (STEP 6) — shown once processing has started */}
      {(isProcessing || upload.status === 'completed' || upload.status === 'error') && (
        <div className="mb-3"><ProcessingSteps upload={upload} /></div>
      )}

      {/* Results (STEP 5 / synced review) — toggle between per-chunk comparison and synced player */}
      {hasCaptions && (
        <div>
          <div className="flex gap-1 mb-2">
            {[['compare', 'Chunk Comparison'], ['synced', 'Synced Playback']].map(([k, lbl]) => (
              <button key={k} onClick={() => setResultView(k)}
                className={`text-xs px-3 py-1 rounded border transition-colors ${resultView === k
                  ? 'bg-blue-600 text-white border-blue-600'
                  : 'border-gray-300 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700'}`}>
                {lbl}
              </button>
            ))}
          </div>
          {resultView === 'compare'
            ? <ChunkComparison upload={upload} />
            : <SyncedComparePlayer upload={upload} />}
        </div>
      )}
    </div>
  )
}

export default function StaticMediaProcessing() {
  const uploads = useStore(s => s.uploads)
  const setUploads = useStore(s => s.setUploads)
  const upsertUpload = useStore(s => s.upsertUpload)
  const [dragOver, setDragOver] = useState(false)
  const [uploadPct, setUploadPct] = useState(null)   // null = not uploading
  const [uploadName, setUploadName] = useState('')
  const [error, setError] = useState('')
  const [models, setModels] = useState([])
  const inputRef = useRef(null)
  const xhrRef = useRef(null)

  // Load existing uploads + the live model list on mount. The model list is
  // scanned from C:\model_ai\Model on the server, so newly-added models appear.
  useEffect(() => {
    fetch('/api/uploads').then(r => r.json())
      .then(d => { if (d.success) setUploads(d.uploads) })
      .catch(() => {})
    fetch('/api/single/models').then(r => r.json())
      .then(d => { if (d.success) setModels(d.models || []) })
      .catch(() => {})
  }, [setUploads])

  const doUpload = useCallback((file) => {
    if (!file) return
    setError('')
    setUploadName(file.name)
    setUploadPct(0)
    const xhr = new XMLHttpRequest()
    xhrRef.current = xhr
    const form = new FormData()
    form.append('file', file)
    // Upload only — do NOT auto-process. The operator clicks Start to generate
    // chunks and run both feeds.
    xhr.open('POST', '/api/upload?autostart=false')
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) setUploadPct(Math.round(100 * e.loaded / e.total))
    }
    xhr.onload = () => {
      setUploadPct(null)
      xhrRef.current = null
      try {
        const res = JSON.parse(xhr.responseText)
        if (xhr.status >= 200 && xhr.status < 300 && res.upload) upsertUpload(res.upload)
        else setError(res.detail || 'Upload failed')
      } catch { setError('Upload failed') }
    }
    xhr.onerror = () => { setUploadPct(null); xhrRef.current = null; setError('Upload failed (network)') }
    xhr.send(form)
  }, [upsertUpload])

  const cancelUpload = () => {
    if (xhrRef.current) { xhrRef.current.abort(); xhrRef.current = null; setUploadPct(null); setError('Upload cancelled') }
  }

  const onDrop = (e) => {
    e.preventDefault(); setDragOver(false)
    const f = e.dataTransfer.files?.[0]
    if (f) doUpload(f)
  }

  const uploadList = Object.values(uploads).sort((a, b) => (b.created || 0) - (a.created || 0))

  return (
    <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4">
      <h2 className="font-bold mb-1">Static Media Processing</h2>
      <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">
        Upload a media file, then click <span className="font-medium">▶ Start Processing</span> to
        extract audio, generate chunks once, and run both feed models on identical audio.
        Watch captions stream chunk-by-chunk here and on the Caption Monitor page.
      </p>

      {/* Drag & drop / browse (Task 13) */}
      <div
        onDragOver={e => { e.preventDefault(); setDragOver(true) }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        onClick={() => inputRef.current?.click()}
        className={`cursor-pointer rounded-lg border-2 border-dashed p-6 text-center transition-colors ${dragOver
          ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20'
          : 'border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-700/40'}`}>
        <div className="text-sm text-gray-600 dark:text-gray-300">
          📁 Drag &amp; drop a video/audio file here, or <span className="text-blue-600 dark:text-blue-400 underline">browse</span>
        </div>
        <div className="text-xs text-gray-400 dark:text-gray-500 mt-1">
          MP4, MOV, MKV, MXF, AVI, MPEG-TS · WAV, MP3, AAC, FLAC, M4A, OGG
        </div>
        <input ref={inputRef} type="file" accept={ACCEPT} className="hidden"
          onChange={e => doUpload(e.target.files?.[0])} />
      </div>

      {/* Upload progress + cancel */}
      {uploadPct !== null && (
        <div className="mt-3 flex items-center gap-2">
          <div className="flex-1"><ProgressBar value={uploadPct} label={`Uploading ${uploadName}`} /></div>
          <button onClick={cancelUpload}
            className="text-xs px-2 py-1 rounded border border-gray-300 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700">Cancel</button>
        </div>
      )}
      {error && <div className="text-xs text-red-600 dark:text-red-400 mt-2">{error}</div>}

      {/* Uploads list */}
      <div className="mt-4">
        {uploadList.length === 0
          ? <div className="text-sm italic text-gray-400 dark:text-gray-500">No uploads yet.</div>
          : uploadList.map(u => <UploadCard key={u.id} upload={u} models={models} />)}
      </div>
    </div>
  )
}
