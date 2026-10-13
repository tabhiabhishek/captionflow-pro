import React, { useState, useEffect } from 'react'
import { useStore } from '../store'
import { useWebSocket } from '../hooks/useWebSocket'
import { useModels } from '../hooks/useModels'
import { useInterfaces } from '../hooks/useInterfaces'
import ProbeResultCard from './ProbeResultCard'
import PipelineStatus from './PipelineStatus'
import DebugPanel from './DebugPanel'

export default function FeedControl({ feedId }) {
  const feed = useStore(state => state.feeds[feedId])
  const updateFeedConfig = useStore(state => state.updateFeedConfig)
  const setRunning = useStore(state => state.setRunning)
  const { sendCommand, connected } = useWebSocket()
  const { availableModels, modelsLoading, modelsError, reloadModels } = useModels()
  const { interfaces, loading: ifaceLoading, reloadInterfaces } = useInterfaces()

  const [url, setUrl] = useState(feed.url || '')
  const [model, setModel] = useState(feed.model || '')
  const [iface, setIface] = useState(feed.interface || '')
  const [prompt, setPrompt] = useState(feed.prompt || '')
  const [chunkSize, setChunkSize] = useState(feed.chunkSize || feed.chunk_size || 3)
  const [notice, setNotice] = useState('')

  useEffect(() => {
    updateFeedConfig(feedId, { url, model, prompt, chunkSize, interface: iface })
  }, [url, model, prompt, chunkSize, iface])

  // Adopt config values pushed from the backend once, if the user hasn't typed.
  useEffect(() => {
    if (!url && feed.url) setUrl(feed.url)
    if (!model && feed.model) setModel(feed.model)
  }, [feed.url, feed.model])

  const selectedModelObj = availableModels.find(m => m.name === model)

  // ---- validation ---------------------------------------------------------
  const validationErrors = []
  if (!connected) validationErrors.push('Backend disconnected')
  if (!url.trim()) validationErrors.push('UDP URL is empty')
  else if (!/^udp:\/\//i.test(url.trim())) validationErrors.push('UDP URL should start with udp://')
  if (!model) validationErrors.push('No model selected')
  const canStart = validationErrors.length === 0

  const commandPayload = () => ({
    feed: feedId,
    url: url.trim(),
    model,
    model_path: selectedModelObj ? selectedModelObj.path : undefined,
    interface: iface,
    prompt,
    chunk_size: Number(chunkSize)
  })

  const handleProbe = () => {
    setNotice('')
    if (!url.trim()) {
      setNotice('Enter a UDP URL before probing.')
      return
    }
    if (!connected) {
      setNotice('Backend unavailable — cannot probe.')
      return
    }
    sendCommand({ type: 'probe', ...commandPayload() })
  }

  const handleStart = () => {
    setNotice('')
    if (!canStart) {
      setNotice(validationErrors.join(' • '))
      return
    }
    const ok = sendCommand({ type: 'start', ...commandPayload() })
    if (ok) setRunning(feedId, true)
  }

  const handleStop = () => {
    setNotice('')
    sendCommand({ type: 'stop', ...commandPayload() })
    setRunning(feedId, false)
  }

  return (
    <div className="p-4 border rounded bg-white dark:bg-gray-800 shadow">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-lg font-bold">Feed {feedId}</h3>
        <span className={`text-xs px-2 py-0.5 rounded ${connected ? 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300' : 'bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300'}`}>
          {connected ? '● Connected' : '● Disconnected'}
        </span>
      </div>

      <div className="space-y-2">
        <input
          className="w-full border p-2 rounded dark:bg-gray-700"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="UDP URL (e.g. udp://@236.1.1.1:6004)"
        />

        {/* ---- Model dropdown with loading / empty / error states ---- */}
        <div>
          <div className="flex items-center gap-2">
            <select
              className="w-full border p-2 rounded dark:bg-gray-700 disabled:opacity-50"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              disabled={modelsLoading || availableModels.length === 0}
            >
              <option value="">
                {modelsLoading
                  ? 'Loading models…'
                  : availableModels.length === 0
                    ? 'No models found'
                    : 'Select a model'}
              </option>
              {availableModels.map(m => (
                <option key={m.name} value={m.name}>{m.name}</option>
              ))}
            </select>
            <button
              onClick={reloadModels}
              title="Reload model list"
              className="px-2 py-2 rounded border text-sm hover:bg-gray-100 dark:hover:bg-gray-700"
            >
              {modelsLoading ? (
                <span className="inline-block animate-spin">⟳</span>
              ) : '⟳'}
            </button>
          </div>
          {modelsError && (
            <div className="text-xs text-red-600 dark:text-red-400 mt-1">
              ⚠️ Could not load models: {modelsError}
            </div>
          )}
          {!modelsLoading && !modelsError && availableModels.length === 0 && (
            <div className="text-xs text-yellow-600 dark:text-yellow-400 mt-1">
              No models found. Check <code>model_folder</code> in config.json.
            </div>
          )}
        </div>

        {/* ---- Network interface (for multicast UDP) ---- */}
        <div>
          <div className="flex items-center gap-2">
            <select
              className="w-full border p-2 rounded dark:bg-gray-700 disabled:opacity-50"
              value={iface}
              onChange={(e) => setIface(e.target.value)}
              disabled={ifaceLoading}
              title="Local network interface used to join the multicast UDP stream"
            >
              {interfaces.map(i => (
                <option key={i.address || 'auto'} value={i.address}>{i.name}</option>
              ))}
            </select>
            <button
              onClick={reloadInterfaces}
              title="Reload network interfaces"
              className="px-2 py-2 rounded border text-sm hover:bg-gray-100 dark:hover:bg-gray-700"
            >
              {ifaceLoading ? <span className="inline-block animate-spin">⟳</span> : '⟳'}
            </button>
          </div>
          <div className="text-xs text-gray-400 mt-0.5">
            Network interface for UDP multicast (choose your NIC if probe times out).
          </div>
        </div>

        <textarea
          className="w-full border p-2 rounded dark:bg-gray-700"
          rows={2}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="Prompt"
        />
        <input
          type="number"
          className="w-full border p-2 rounded dark:bg-gray-700"
          value={chunkSize}
          onChange={(e) => setChunkSize(Number(e.target.value))}
          placeholder="Chunk size (s)"
        />

        <div className="flex space-x-2">
          <button
            onClick={handleProbe}
            disabled={!connected}
            className="bg-blue-500 text-white px-4 py-1 rounded hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Probe
          </button>
          <button
            onClick={handleStart}
            disabled={!canStart}
            title={canStart ? 'Start pipeline' : validationErrors.join(', ')}
            className="bg-green-500 text-white px-4 py-1 rounded hover:bg-green-600 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Start
          </button>
          <button
            onClick={handleStop}
            className="bg-red-500 text-white px-4 py-1 rounded hover:bg-red-600"
          >
            Stop
          </button>
        </div>

        {/* ---- validation / notices ---- */}
        {!canStart && (
          <div className="text-xs text-yellow-600 dark:text-yellow-400">
            {validationErrors.map((v, i) => <div key={i}>• {v}</div>)}
          </div>
        )}
        {notice && (
          <div className="text-xs text-red-600 dark:text-red-400">{notice}</div>
        )}

        <div className="text-sm text-gray-500">
          Status: {feed.isRunning ? '🟢 Running' : '🔴 Stopped'}
        </div>
      </div>

      {/* ---- diagnostics ---- */}
      <ProbeResultCard probeResult={feed.probeResult} />
      <PipelineStatus pipelineStatus={feed.pipelineStatus} />
      <DebugPanel feedId={feedId} />
    </div>
  )
}
