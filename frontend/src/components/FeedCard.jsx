import React, { useState } from 'react'
import { useStore } from '../store'
import { useModels } from '../hooks/useModels'
import { useWebSocket } from '../hooks/useWebSocket'
import { useSdiDevices } from '../hooks/useSdiDevices'
import AISettings from './AISettings'
import TerminologyUpload from './TerminologyUpload'

// Builds the WS command payload from a feed's config (incl. AI settings).
export function feedPayload(feedId, feed, modelObj) {
  return {
    feed: feedId,
    url: (feed.url || '').trim(),
    source_type: feed.sourceType || 'udp',
    device: feed.device || '',
    model: feed.model,
    model_path: modelObj ? modelObj.path : undefined,
    interface: feed.interface || '',
    prompt: feed.prompt || '',
    chunk_size: Number(feed.chunkSize || 3),
    language: feed.language || '',
    audio_pad: feed.audioPad,
    overlap: feed.overlap,
    hallucination_filter: feed.hallucinationFilter,
    calibration: feed.calibration,
    model_backend: feed.modelBackend,
    terminology_dir: feed.terminology?.dir
  }
}

// Small labelled value used in the live-status grid.
function Info({ label, value, tone }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-gray-400 dark:text-gray-500">{label}</div>
      <div className={`text-xs font-medium truncate ${tone || 'text-gray-700 dark:text-gray-200'}`}>{value}</div>
    </div>
  )
}

export default function FeedCard({ feedId, sourceType = 'udp' }) {
  const feed = useStore(s => s.feeds[feedId]) || {}
  const update = useStore(s => s.updateFeedConfig)
  const setRunning = useStore(s => s.setRunning)
  const systemStats = useStore(s => s.systemStats)
  const { availableModels, modelsLoading, modelsError, reloadModels } = useModels()
  const { sendCommand, connected } = useWebSocket()
  const isSdi = sourceType === 'sdi'
  const { devices: sdiDevices, loading: sdiLoading, reloadDevices } = useSdiDevices()

  const [showAdvanced, setShowAdvanced] = useState(false)

  // Keep the feed's sourceType in sync with the active tab.
  if ((feed.sourceType || 'udp') !== sourceType) update(feedId, { sourceType })

  // Config-only validity hint + per-feed start/stop gating.
  const errors = []
  if (isSdi) {
    if (!feed.device) errors.push('No SDI device selected')
  } else {
    if (!(feed.url || '').trim()) errors.push('UDP URL is empty')
    else if (!/^udp:\/\//i.test((feed.url || '').trim())) errors.push('URL must start with udp://')
  }
  if (!feed.model) errors.push('No model selected')
  const canStart = connected && errors.length === 0

  // Live runtime fields (Task 2).
  const caps = feed.captions || []
  const currentCaption = caps.length ? caps[caps.length - 1].text : '—'
  const device = feed.deviceInfo?.device || feed.stats?.device || 'unknown'
  const ffmpegStatus = feed.pipelineStatus?.ffmpeg || (feed.isRunning ? 'running' : 'idle')
  const captionDelay = feed.stats?.latency != null ? `${feed.stats.latency}s` : '—'
  const procTime = feed.stats?.avg_processing_ms || feed.stats?.inference_time
  const termFile = feed.terminology?.filename || '—'

  const toggleFeed = () => {
    const m = availableModels.find(x => x.name === feed.model)
    const type = feed.isRunning ? 'stop' : 'start'
    const ok = sendCommand({ type, ...feedPayload(feedId, feed, m) })
    if (ok) setRunning(feedId, !feed.isRunning)
  }

  const inputCls = 'w-full border p-2 rounded text-sm dark:bg-gray-700 dark:border-gray-600'

  return (
    <div className="border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 shadow-sm">
      {/* Header + single Start/Stop control (Task 2) */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-gray-700">
        <div className="flex items-center gap-2">
          <h3 className="text-lg font-bold">Feed {feedId}</h3>
          <span className={`text-xs font-medium px-2 py-0.5 rounded ${feed.isRunning
            ? 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300'
            : 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300'}`}>
            {feed.isRunning ? '🟢 Running' : '⚪ Idle'}
          </span>
        </div>
        <button
          onClick={toggleFeed}
          disabled={!feed.isRunning && !canStart}
          title={feed.isRunning ? 'Stop this feed' : (canStart ? 'Start this feed' : 'Feed not ready')}
          className={`text-sm font-semibold px-4 py-1.5 rounded-md text-white transition-colors ${feed.isRunning
            ? 'bg-red-500 hover:bg-red-600'
            : 'bg-green-600 hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed'}`}>
          {feed.isRunning ? '■ Stop Feed' : '▶ Start Feed'}
        </button>
      </div>

      {/* Live runtime status grid (Task 2) */}
      <div className="grid grid-cols-3 gap-3 px-4 py-3 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/40">
        <Info label="Model" value={feed.model || '—'} />
        <Info label="GPU / Device" value={device.toUpperCase()}
          tone={device === 'cuda' ? 'text-green-600 dark:text-green-400' : device === 'cpu' ? 'text-amber-600 dark:text-amber-400' : ''} />
        <Info label="CPU" value={`${Math.round(systemStats.cpu || 0)}%`} />
        <Info label="FFmpeg" value={ffmpegStatus}
          tone={ffmpegStatus === 'running' ? 'text-green-600 dark:text-green-400' : ffmpegStatus === 'error' ? 'text-red-600 dark:text-red-400' : ''} />
        <Info label="Caption Delay" value={captionDelay} />
        <Info label="Processing" value={procTime ? `${procTime}ms` : '—'} />
        <Info label="Terminology" value={termFile} />
        <Info label="Prompt" value={feed.prompt ? (feed.prompt.length > 22 ? feed.prompt.slice(0, 22) + '…' : feed.prompt) : '—'} />
        <Info label="Lines" value={caps.length} />
      </div>
      <div className="px-4 py-2 border-b border-gray-200 dark:border-gray-700">
        <div className="text-[10px] uppercase tracking-wide text-gray-400 dark:text-gray-500">Current Caption</div>
        <div className="text-sm text-gray-800 dark:text-gray-100 truncate">{currentCaption}</div>
      </div>

      <div className="p-4 space-y-3">
        {/* Feed source — UDP URL or SDI device depending on the active tab */}
        {isSdi ? (
          <label className="block">
            <span className="text-xs font-medium text-gray-600 dark:text-gray-300">SDI Device (DeckLink)</span>
            <div className="flex items-center gap-2">
              <select className={`${inputCls} disabled:opacity-50`} value={feed.device || ''}
                onChange={e => update(feedId, { device: e.target.value })}
                disabled={sdiLoading || sdiDevices.length === 0}>
                <option value="">
                  {sdiLoading ? 'Detecting devices…' : sdiDevices.length === 0 ? 'No SDI devices found' : 'Select an SDI input'}
                </option>
                {sdiDevices.map(d => <option key={d.name} value={d.name}>{d.name}</option>)}
              </select>
              <button onClick={reloadDevices} title="Rescan SDI devices"
                className="px-2 py-2 rounded border border-gray-300 dark:border-gray-600 text-sm hover:bg-gray-100 dark:hover:bg-gray-700">
                {sdiLoading ? <span className="inline-block animate-spin">⟳</span> : '⟳'}
              </button>
            </div>
            {!sdiLoading && sdiDevices.length === 0 &&
              <span className="text-xs text-yellow-600 dark:text-yellow-400">No DeckLink SDI devices detected.</span>}
          </label>
        ) : (
          <label className="block">
            <span className="text-xs font-medium text-gray-600 dark:text-gray-300">Feed Source (UDP URL)</span>
            <input className={inputCls} value={feed.url || ''} placeholder="udp://@236.1.1.1:6004"
              onChange={e => update(feedId, { url: e.target.value })} />
          </label>
        )}

        {/* AI Model Selection */}
        <label className="block">
          <span className="text-xs font-medium text-gray-600 dark:text-gray-300">AI Model</span>
          <div className="flex items-center gap-2">
            <select className={`${inputCls} disabled:opacity-50`} value={feed.model || ''}
              onChange={e => update(feedId, { model: e.target.value })}
              disabled={modelsLoading || availableModels.length === 0}>
              <option value="">
                {modelsLoading ? 'Loading models…' : availableModels.length === 0 ? 'No models found' : 'Select a model'}
              </option>
              {availableModels.map(m => (
                <option key={m.name} value={m.name}>{m.name}{m.backend ? ` · ${m.backend}` : ''}</option>
              ))}
            </select>
            <button onClick={reloadModels} title="Reload models"
              className="px-2 py-2 rounded border border-gray-300 dark:border-gray-600 text-sm hover:bg-gray-100 dark:hover:bg-gray-700">
              {modelsLoading ? <span className="inline-block animate-spin">⟳</span> : '⟳'}
            </button>
          </div>
          {modelsError && <span className="text-xs text-red-600 dark:text-red-400">⚠️ {modelsError}</span>}
          {!modelsLoading && !modelsError && availableModels.length === 0 &&
            <span className="text-xs text-yellow-600 dark:text-yellow-400">No models found. Check model_folder in config.json.</span>}
        </label>

        {/* Prompt Editor */}
        <label className="block">
          <span className="text-xs font-medium text-gray-600 dark:text-gray-300">Prompt</span>
          <textarea className={inputCls} rows={2} value={feed.prompt || ''} placeholder="e.g. Sports commentary"
            onChange={e => update(feedId, { prompt: e.target.value })} />
        </label>

        {/* Terminology Upload */}
        <TerminologyUpload feedId={feedId} />

        {/* Advanced AI Settings */}
        <div className="border-t dark:border-gray-700 pt-2">
          <button onClick={() => setShowAdvanced(v => !v)}
            className="text-sm font-medium text-gray-700 dark:text-gray-200 flex items-center gap-1">
            <span>{showAdvanced ? '▲' : '▼'}</span> Advanced AI Settings
          </button>
          {showAdvanced && <div className="mt-3"><AISettings feedId={feedId} /></div>}
        </div>

        {/* Config validity hint (start/stop handled by the Dashboard master control) */}
        {errors.length > 0 && (
          <div className="text-xs text-yellow-600 dark:text-yellow-400 border-t dark:border-gray-700 pt-2">
            {errors.map((e, i) => <div key={i}>• {e}</div>)}
          </div>
        )}
        {errors.length === 0 && (
          <div className="text-xs text-green-600 dark:text-green-400 border-t dark:border-gray-700 pt-2">
            ✓ Ready — controlled by the Start/Stop button above
          </div>
        )}
      </div>
    </div>
  )
}
