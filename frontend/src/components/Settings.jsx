import React, { useState } from 'react'
import { useStore } from '../store'
import FeedDiagnostics from './FeedDiagnostics'
import SystemDiagnostics from './SystemDiagnostics'
import DiagnosticsPanel from './DiagnosticsPanel'
import PostProcessSettings from './PostProcessSettings'
import AISettings from './AISettings'

function Section({ title, subtitle, children, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 mb-3">
      <button onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between px-4 py-3 text-left">
        <div>
          <div className="font-bold">{title}</div>
          {subtitle && <div className="text-xs text-gray-500 dark:text-gray-400">{subtitle}</div>}
        </div>
        <span className="text-gray-400">{open ? '▲' : '▼'}</span>
      </button>
      {open && <div className="px-4 pb-4">{children}</div>}
    </div>
  )
}

export default function Settings() {
  const feedIds = Object.keys(useStore(s => s.feeds)).map(Number).sort((a, b) => a - b)
  const [diagFeed, setDiagFeed] = useState(feedIds[0] || 1)

  return (
    <div>
      <h1 className="text-2xl font-bold mb-1">Settings</h1>
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
        Diagnostics &amp; troubleshooting. Day-to-day feed operation lives on the Dashboard.
      </p>

      {/* Feed selector for feed-scoped sections */}
      <div className="flex items-center gap-2 mb-4">
        <span className="text-sm text-gray-500">Diagnostics for:</span>
        {feedIds.map(id => (
          <button key={id} onClick={() => setDiagFeed(id)}
            className={`text-sm px-3 py-1 rounded border ${diagFeed === id
              ? 'bg-blue-600 text-white border-blue-600'
              : 'hover:bg-gray-100 dark:hover:bg-gray-700'}`}>
            Feed {id}
          </button>
        ))}
      </div>

      <Section title="System Diagnostics" subtitle="CPU/GPU usage, GPU memory, CUDA stack, inference device, per-feed queue & timings" defaultOpen>
        <DiagnosticsPanel />
      </Section>

      <Section title="Post-Processing Corrections" subtitle="Player names, terminology fixes, and hallucination phrases applied to the processed output" defaultOpen>
        <PostProcessSettings />
      </Section>

      <Section title="Feed Diagnostics" subtitle="Probe, FFprobe results, pipeline visualization, audio/video/PID/codec/bitrate">
        <FeedDiagnostics feedId={diagFeed} />
      </Section>

      <Section title="AI Advanced Settings" subtitle="Language, backend, audio padding, overlap, calibration, hallucination filtering (per feed)">
        <AISettings feedId={diagFeed} />
        <p className="text-xs text-gray-400 mt-3">
          These are the same settings shown under “Advanced AI Settings” on each Dashboard feed card — edited here for Feed {diagFeed}.
        </p>
      </Section>

      <Section title="FFmpeg &amp; Whisper Diagnostics" subtitle="Binary paths, versions, availability and detected model backends">
        <SystemDiagnostics />
      </Section>
    </div>
  )
}
