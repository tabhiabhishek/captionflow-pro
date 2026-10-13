import React, { useState } from 'react'
import { useStore } from '../store'
import { useWebSocket } from '../hooks/useWebSocket'
import { useModels } from '../hooks/useModels'
import FeedCard, { feedPayload } from './FeedCard'
import StaticMediaProcessing from './StaticMediaProcessing'

function StatPill({ label, value, unit }) {
  return (
    <div className="px-3 py-2 rounded bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 text-center">
      <div className="text-xs text-gray-500 dark:text-gray-400">{label}</div>
      <div className="text-lg font-semibold">{value ?? 0}{unit}</div>
    </div>
  )
}

function isValid(feed) {
  if (!feed.model) return false
  if ((feed.sourceType || 'udp') === 'sdi') return !!feed.device
  const url = (feed.url || '').trim()
  return !!url && /^udp:\/\//i.test(url)
}

const SOURCE_TABS = [
  { key: 'static', label: '📁 Static File', hint: 'Upload a media file' },
  { key: 'udp', label: '📡 UDP', hint: 'Live multicast UDP streams' },
  { key: 'sdi', label: '🎞 SDI', hint: 'Blackmagic DeckLink capture' },
]

export default function Dashboard() {
  const system = useStore(s => s.systemStats)
  const feeds = useStore(s => s.feeds)
  const setRunning = useStore(s => s.setRunning)
  const { sendCommand, connected } = useWebSocket()
  const { availableModels } = useModels()
  const [notice, setNotice] = useState('')
  const [sourceTab, setSourceTab] = useState('static')

  const resetWorkspace = useStore(s => s.resetWorkspace)
  const [showReset, setShowReset] = useState(false)
  const [resetting, setResetting] = useState(false)

  const feedIds = Object.keys(feeds).map(Number).sort((a, b) => a - b)
  const anyRunning = feedIds.some(id => feeds[id].isRunning)
  const isLive = sourceTab === 'udp' || sourceTab === 'sdi'

  const handleFreshStart = async () => {
    setResetting(true)
    setNotice('')
    try {
      const r = await fetch('/api/workspace/reset', { method: 'POST' })
      const d = await r.json()
      // The backend broadcasts workspace_reset to all clients, but reset locally
      // too so the UI clears immediately even if the socket is momentarily down.
      resetWorkspace()
      feedIds.forEach(id => setRunning(id, false))
      setNotice(d.message || 'Workspace reset successfully.')
    } catch (err) {
      setNotice('Fresh Start failed: ' + err)
    } finally {
      setResetting(false)
      setShowReset(false)
    }
  }
  const startable = feedIds.filter(id => isValid(feeds[id]))
  const canStartAll = connected && startable.length > 0

  const handleToggleAll = () => {
    setNotice('')
    if (anyRunning) {
      // Stop every feed.
      feedIds.forEach(id => {
        const m = availableModels.find(x => x.name === feeds[id].model)
        sendCommand({ type: 'stop', ...feedPayload(id, feeds[id], m) })
        setRunning(id, false)
      })
      return
    }
    if (!connected) { setNotice('Backend disconnected — cannot start.'); return }
    if (!startable.length) {
      setNotice('No feed is ready. Each feed needs a udp:// URL and a selected model.')
      return
    }
    // Start every valid feed at the same time.
    startable.forEach(id => {
      const m = availableModels.find(x => x.name === feeds[id].model)
      const ok = sendCommand({ type: 'start', ...feedPayload(id, feeds[id], m) })
      if (ok) setRunning(id, true)
    })
    const skipped = feedIds.filter(id => !isValid(feeds[id]))
    if (skipped.length) {
      setNotice(`Started ${startable.length} feed(s). Skipped ${skipped.map(i => `Feed ${i}`).join(', ')} (missing URL or model).`)
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-2xl font-bold">Dashboard</h1>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowReset(true)}
            title="Clear runtime data and return to a clean Idle state (models stay on GPU)"
            className="text-xs font-medium px-3 py-1.5 rounded border border-gray-300 dark:border-gray-600
                       text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors">
            🔄 Fresh Start
          </button>
          <span className={`text-xs font-medium px-2 py-1 rounded ${connected
            ? 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300'
            : 'bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300'}`}>
            {connected ? '● Backend Connected' : '● Backend Disconnected'}
          </span>
        </div>
      </div>

      {/* Fresh Start confirmation dialog (Task 15) */}
      {showReset && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
             onClick={() => !resetting && setShowReset(false)}>
          <div className="max-w-md w-full rounded-lg bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700
                          shadow-xl p-5" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-bold mb-2 text-gray-900 dark:text-gray-100">Fresh Start</h3>
            <p className="text-sm text-gray-600 dark:text-gray-300 mb-4">
              This will clear all current captions, temporary files, generated audio chunks,
              processing queues, cached data, and reset all feed states. Uploaded files and
              saved settings will not be deleted. Do you want to continue?
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setShowReset(false)}
                disabled={resetting}
                className="text-sm px-4 py-2 rounded border border-gray-300 dark:border-gray-600
                           hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-50">
                Cancel
              </button>
              <button
                onClick={handleFreshStart}
                disabled={resetting}
                className="text-sm px-4 py-2 rounded bg-red-600 text-white hover:bg-red-700 disabled:opacity-50">
                {resetting ? 'Resetting…' : 'Fresh Start'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Source tabs: choose the input for the two-model comparison */}
      <div className="flex gap-1 mb-4 border-b border-gray-200 dark:border-gray-700">
        {SOURCE_TABS.map(tab => (
          <button key={tab.key} onClick={() => setSourceTab(tab.key)} title={tab.hint}
            className={`text-sm px-4 py-2 -mb-px border-b-2 transition-colors ${sourceTab === tab.key
              ? 'border-blue-600 text-blue-600 dark:text-blue-400 font-semibold'
              : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200'}`}>
            {tab.label}
          </button>
        ))}
      </div>

      {/* System resources */}
      <div className="grid grid-cols-3 gap-3 mb-4">
        <StatPill label="CPU" value={system.cpu} unit="%" />
        <StatPill label="Memory" value={system.memory} unit="%" />
        <StatPill label="GPU" value={system.gpu} unit="%" />
      </div>

      {/* Live sources (UDP / SDI): master control + operator feed cards */}
      {isLive && (
        <>
          <div className="mb-5">
            <button onClick={handleToggleAll}
              disabled={!anyRunning && !canStartAll}
              title={anyRunning ? 'Stop all feeds' : (canStartAll ? 'Start all ready feeds' : 'No feed ready to start')}
              className={`w-full py-3 rounded-lg font-semibold text-white text-lg transition-colors ${anyRunning
                ? 'bg-red-500 hover:bg-red-600'
                : 'bg-green-600 hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed'}`}>
              {anyRunning ? '■ Stop All Feeds' : `▶ Start All Feeds (${sourceTab.toUpperCase()})`}
            </button>
            {notice && <div className="text-xs text-yellow-600 dark:text-yellow-400 mt-2 text-center">{notice}</div>}
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
            {feedIds.map(id => <FeedCard key={id} feedId={id} sourceType={sourceTab} />)}
          </div>
        </>
      )}

      {/* Static file source: upload → dual-model compare */}
      {sourceTab === 'static' && (
        <div className="mb-4">
          <StaticMediaProcessing />
        </div>
      )}
    </div>
  )
}
