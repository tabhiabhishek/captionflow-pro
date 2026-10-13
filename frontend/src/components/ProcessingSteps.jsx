import React from 'react'

// STEP 6 — modern processing indicator with distinct phases.
// Derives each step's state from the upload's phase + per-model progress.

function Bar({ pct, tone = 'blue' }) {
  const color = tone === 'green' ? 'bg-green-500 dark:bg-green-400' : 'bg-blue-500 dark:bg-blue-400'
  return (
    <div className="h-2 rounded bg-gray-200 dark:bg-gray-700 overflow-hidden">
      <div className={`h-full ${color} transition-all`} style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} />
    </div>
  )
}

function Step({ label, state, detail, pct }) {
  const icon = state === 'done' ? '✓' : state === 'active' ? '⟳' : '•'
  const iconCls = state === 'done' ? 'text-green-600 dark:text-green-400'
    : state === 'active' ? 'text-blue-600 dark:text-blue-400 animate-pulse' : 'text-gray-400 dark:text-gray-600'
  return (
    <div className="flex items-center gap-3 py-1">
      <span className={`w-4 text-center ${iconCls}`}>{icon}</span>
      <div className="flex-1">
        <div className="flex justify-between text-xs mb-0.5">
          <span className={state === 'pending' ? 'text-gray-400 dark:text-gray-600' : 'text-gray-700 dark:text-gray-200'}>{label}</span>
          <span className="text-gray-500 dark:text-gray-400">{detail}</span>
        </div>
        <Bar pct={pct} tone={state === 'done' ? 'green' : 'blue'} />
      </div>
    </div>
  )
}

export default function ProcessingSteps({ upload }) {
  const phase = upload.phase || upload.status
  const order = ['uploaded', 'extracting', 'chunked', 'processing', 'completed']
  const pi = Math.max(0, order.indexOf(phase))
  const isError = upload.status === 'error'
  const total = upload.total_chunks || 0
  const feeds = Object.values(upload.feeds || {})
  const processedMax = feeds.reduce((m, f) => Math.max(m, f.processed || 0), 0)
  const modelPct = total ? Math.round(100 * processedMax / total) : (phase === 'completed' ? 100 : 0)

  const st = (idx) => phase === 'completed' ? 'done' : pi > idx ? 'done' : pi === idx ? 'active' : 'pending'
  const pct = (idx, active) => (st(idx) === 'done' ? 100 : st(idx) === 'active' ? (active ?? 60) : 0)

  return (
    <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 p-3 space-y-1">
      <Step label="Uploading" state="done" detail="Completed" pct={100} />
      <Step label="Extracting Audio" state={st(1)} detail={st(1) === 'done' ? 'Completed' : st(1) === 'active' ? 'Working…' : ''} pct={pct(1)} />
      <Step label="Creating Chunks" state={st(2)} detail={total ? `${total} chunks` : (st(2) === 'active' ? 'Working…' : '')} pct={pct(2)} />
      <Step label="Running AI Models" state={st(3)} detail={phase === 'processing' || phase === 'completed' ? `Chunk ${processedMax} / ${total || '…'}` : ''} pct={pct(3, modelPct)} />
      <Step label="Applying Text Processing" state={st(3)} detail={phase === 'completed' ? 'Completed' : phase === 'processing' ? 'Per chunk' : ''} pct={pct(3, modelPct)} />
      <Step label="Generating Final Output" state={phase === 'completed' ? 'done' : 'pending'} detail={phase === 'completed' ? 'Completed' : ''} pct={phase === 'completed' ? 100 : 0} />
      {isError && <div className="text-xs text-red-600 dark:text-red-400 pt-1">Error: {upload.error}</div>}
    </div>
  )
}
