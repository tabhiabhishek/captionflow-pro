import React, { useState } from 'react'
import { useStore } from '../store'

function Metric({ label, value }) {
  return (
    <div className="flex justify-between text-xs py-0.5 border-b border-gray-100 dark:border-gray-700">
      <span className="text-gray-500 dark:text-gray-400">{label}</span>
      <span className="font-mono text-gray-800 dark:text-gray-100">{value ?? 'N/A'}</span>
    </div>
  )
}

export default function DebugPanel({ feedId }) {
  const [open, setOpen] = useState(false)
  const feed = useStore(s => s.feeds[feedId]) || {}
  const systemStats = useStore(s => s.systemStats)
  const wsConnected = useStore(s => s.wsConnected)

  const stats = feed.stats || {}
  const captions = feed.captions || []
  const lastCaption = captions.length ? captions[captions.length - 1] : null

  return (
    <div className="mt-3 border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between px-3 py-2 text-sm font-bold text-gray-700 dark:text-gray-200"
      >
        <span>🐞 Caption Debug Panel</span>
        <span className="text-gray-400">{open ? '▲' : '▼'}</span>
      </button>
      {open && (
        <div className="px-3 pb-3">
          <Metric label="Model Name" value={feed.model} />
          <Metric label="Current Chunk" value={stats.chunks ? `chunk_${String(stats.chunks).padStart(4, '0')}` : null} />
          <Metric label="Chunk Number" value={stats.chunks} />
          <Metric label="Chunk Duration" value={feed.chunkSize ? `${feed.chunkSize}s` : null} />
          <Metric label="Processing Time" value={stats.inference_time != null ? `${stats.inference_time} ms` : null} />
          <Metric label="Average Latency" value={stats.latency != null ? `${stats.latency} s` : null} />
          <Metric label="Words Detected" value={stats.words} />
          <Metric label="Queue Size" value={stats.queue ?? null} />
          <Metric label="CPU" value={systemStats.cpu != null ? `${systemStats.cpu}%` : null} />
          <Metric label="GPU" value={systemStats.gpu != null ? `${systemStats.gpu}%` : null} />
          <Metric label="WebSocket State" value={wsConnected ? 'Connected' : 'Disconnected'} />
          <div className="mt-2 text-xs">
            <div className="text-gray-500 dark:text-gray-400 mb-1">Current Caption</div>
            <div className="font-mono text-gray-800 dark:text-gray-100 bg-gray-50 dark:bg-gray-900 rounded p-2 min-h-[2rem]">
              {lastCaption ? lastCaption.text : <span className="italic text-gray-400">—</span>}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
