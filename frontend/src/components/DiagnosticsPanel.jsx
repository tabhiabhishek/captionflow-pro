import React, { useEffect, useState } from 'react'
import { useStore } from '../store'

// Polls /api/diagnostics and renders the System Diagnostics section (Task 6):
// CPU/GPU/GPU-memory, CUDA status, inference device, loaded models, per-feed
// queue length / current chunk / avg processing time / avg caption delay,
// active threads, WebSocket connection and log status.

function Stat({ label, value, tone = 'default' }) {
  const toneCls = {
    default: 'text-gray-800 dark:text-gray-100',
    good: 'text-green-600 dark:text-green-400',
    warn: 'text-amber-600 dark:text-amber-400',
    bad: 'text-red-600 dark:text-red-400',
  }[tone]
  return (
    <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2">
      <div className="text-xs text-gray-500 dark:text-gray-400">{label}</div>
      <div className={`text-sm font-semibold ${toneCls}`}>{value}</div>
    </div>
  )
}

function pct(n) { return `${Math.round(n || 0)}%` }

export default function DiagnosticsPanel() {
  const wsConnected = useStore(s => s.wsConnected)
  const setDiagnostics = useStore(s => s.setDiagnostics)
  const [diag, setDiag] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    let alive = true
    const poll = () => {
      fetch('/api/diagnostics')
        .then(r => r.json())
        .then(d => { if (alive) { setDiag(d); setDiagnostics(d); setError(null) } })
        .catch(err => { if (alive) setError(String(err)) })
    }
    poll()
    const t = setInterval(poll, 2000)   // 2s: matches the panel's needs without spamming
    return () => { alive = false; clearInterval(t) }
  }, [setDiagnostics])

  const sys = diag?.system || {}
  const gpuMem = diag?.gpu?.memory || {}
  const cuda = diag?.cuda || {}
  const cudaOk = cuda.torch || cuda.ctranslate2
  const device = diag?.inference_device || 'unknown'

  return (
    <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4">
      <div className="flex items-center justify-between mb-3">
        <h2 className="font-bold">System Diagnostics</h2>
        <span className={`text-xs px-2 py-0.5 rounded ${wsConnected
          ? 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300'
          : 'bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300'}`}>
          WS {wsConnected ? 'Connected' : 'Disconnected'}
        </span>
      </div>

      {error && (
        <div className="text-xs text-red-600 dark:text-red-400 mb-2">Diagnostics error: {error}</div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-3">
        <Stat label="CPU Usage" value={pct(sys.cpu)} tone={sys.cpu > 85 ? 'bad' : sys.cpu > 60 ? 'warn' : 'good'} />
        <Stat label="Memory" value={pct(sys.memory)} tone={sys.memory > 90 ? 'bad' : 'default'} />
        <Stat label="GPU Usage" value={pct(sys.gpu)} tone={sys.gpu > 0 ? 'good' : 'default'} />
        <Stat label="GPU Memory"
          value={gpuMem.total_gb ? `${gpuMem.used_gb} / ${gpuMem.total_gb} GB` : 'n/a'} />
        <Stat label="CUDA Status" value={cudaOk ? 'Available' : 'Not available'}
          tone={cudaOk ? 'good' : 'bad'} />
        <Stat label="Inference Device" value={device.toUpperCase()}
          tone={device === 'cuda' ? 'good' : device === 'cpu' ? 'warn' : 'default'} />
        <Stat label="GPU" value={diag?.gpu?.name || '—'} />
        <Stat label="Active Threads" value={diag?.active_threads ?? '—'} />
      </div>

      <div className="text-xs text-gray-500 dark:text-gray-400 mb-1">
        CUDA: torch={String(cuda.torch)} · ctranslate2={String(cuda.ctranslate2)} ·
        Active feeds: {diag?.active_feeds ?? 0}
      </div>

      {/* CUDA stack diagnostic (Task 1) */}
      {diag?.cuda_report && (() => {
        const cr = diag.cuda_report
        const bad = !cr.torch_cuda_available
        return (
          <div className={`rounded-lg border p-3 my-2 text-xs ${bad
            ? 'border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20'
            : 'border-green-300 dark:border-green-700 bg-green-50 dark:bg-green-900/20'}`}>
            <div className="font-semibold mb-1 text-gray-800 dark:text-gray-100">CUDA Stack</div>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-x-4 gap-y-0.5 text-gray-600 dark:text-gray-300">
              <div>Driver: <b>{cr.driver_version || '—'}</b></div>
              <div>PyTorch: <b>{cr.torch_version || '—'}</b></div>
              <div>Torch CUDA: <b className={cr.torch_cuda_available ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}>{String(cr.torch_cuda_available)}</b></div>
              <div>Torch build cuda: <b>{String(cr.torch_cuda_build)}</b></div>
              <div>CTranslate2 CUDA: <b className={cr.ct2_cuda ? 'text-green-600 dark:text-green-400' : ''}>{String(cr.ct2_cuda)}</b></div>
              <div>cuDNN: <b>{String(cr.cudnn_enabled)}</b></div>
              <div>GPU: <b>{cr.gpu_name || '—'}</b></div>
              <div>Compute: <b>{cr.compute_capability || '—'}</b></div>
              <div>Inference on GPU: <b className={cr.inference_ok ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}>{cr.inference_ok ? 'YES' : 'NO (CPU!)'}</b></div>
            </div>
            <div className={`mt-2 ${bad ? 'text-amber-700 dark:text-amber-300' : 'text-gray-600 dark:text-gray-300'}`}>
              {cr.diagnosis}
            </div>
            {bad && cr.recommended_fix && (
              <pre className="mt-1 whitespace-pre-wrap text-[11px] text-gray-700 dark:text-gray-200 bg-white/60 dark:bg-black/20 rounded p-2 overflow-x-auto">{cr.recommended_fix}</pre>
            )}
          </div>
        )
      })()}

      {/* Per-feed diagnostics table */}
      <div className="overflow-x-auto mt-2">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-700">
              <th className="py-1 pr-2">Feed</th>
              <th className="py-1 pr-2">Device</th>
              <th className="py-1 pr-2">Chunks</th>
              <th className="py-1 pr-2">Queue</th>
              <th className="py-1 pr-2">Dropped</th>
              <th className="py-1 pr-2">Current</th>
              <th className="py-1 pr-2">Avg proc (ms)</th>
              <th className="py-1 pr-2">Avg delay (s)</th>
            </tr>
          </thead>
          <tbody>
            {(diag?.feeds || []).length === 0
              ? <tr><td colSpan={8} className="py-2 italic text-gray-400 dark:text-gray-500">No active feeds.</td></tr>
              : diag.feeds.map(f => (
                <tr key={f.feed} className="border-b border-gray-100 dark:border-gray-800 text-gray-700 dark:text-gray-200">
                  <td className="py-1 pr-2">Feed {f.feed}</td>
                  <td className="py-1 pr-2">
                    <span className={f.device === 'cuda'
                      ? 'text-green-600 dark:text-green-400'
                      : f.device === 'cpu' ? 'text-amber-600 dark:text-amber-400' : ''}>
                      {(f.device || 'unknown').toUpperCase()}
                    </span>
                  </td>
                  <td className="py-1 pr-2">{f.chunks_done}</td>
                  <td className={`py-1 pr-2 ${(f.queue_len || 0) > 2 ? 'text-red-600 dark:text-red-400 font-semibold' : ''}`}>{f.queue_len}</td>
                  <td className={`py-1 pr-2 ${(f.chunks_dropped || 0) > 0 ? 'text-amber-600 dark:text-amber-400' : ''}`}>{f.chunks_dropped || 0}</td>
                  <td className="py-1 pr-2">{f.current_chunk || '—'}</td>
                  <td className="py-1 pr-2">{f.avg_processing_ms || 0}</td>
                  <td className="py-1 pr-2">{f.avg_caption_delay_s || 0}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>

      {/* Per-stage CPU profile (from the engine) for the first feed that has one */}
      {(() => {
        const withProfile = (diag?.feeds || []).find(f => f.profile)
        if (!withProfile) return null
        const p = withProfile.profile
        const rows = Object.entries(p).sort((a, b) => (b[1].share_pct || 0) - (a[1].share_pct || 0))
        return (
          <div className="mt-3">
            <div className="text-xs font-semibold text-gray-600 dark:text-gray-300 mb-1">
              CPU hotspots — Feed {withProfile.feed} (per-stage share)
            </div>
            <div className="space-y-1">
              {rows.map(([stage, s]) => (
                <div key={stage} className="flex items-center gap-2 text-xs">
                  <span className="w-28 text-gray-500 dark:text-gray-400">{stage}</span>
                  <div className="flex-1 h-2 rounded bg-gray-100 dark:bg-gray-700 overflow-hidden">
                    <div className="h-full bg-blue-500 dark:bg-blue-400" style={{ width: `${s.share_pct || 0}%` }} />
                  </div>
                  <span className="w-24 text-right text-gray-600 dark:text-gray-300">
                    {s.avg_ms}ms · {s.share_pct}%
                  </span>
                </div>
              ))}
            </div>
          </div>
        )
      })()}
    </div>
  )
}
