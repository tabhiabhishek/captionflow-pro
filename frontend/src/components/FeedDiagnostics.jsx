import React, { useState } from 'react'
import { useStore } from '../store'
import { useWebSocket } from '../hooks/useWebSocket'
import { useInterfaces } from '../hooks/useInterfaces'
import { useModels } from '../hooks/useModels'
import { feedPayload } from './FeedCard'
import ProbeResultCard from './ProbeResultCard'
import PipelineStatus from './PipelineStatus'
import DebugPanel from './DebugPanel'

export default function FeedDiagnostics({ feedId }) {
  const feed = useStore(s => s.feeds[feedId]) || {}
  const update = useStore(s => s.updateFeedConfig)
  const { sendCommand, connected } = useWebSocket()
  const { interfaces, loading: ifaceLoading, reloadInterfaces } = useInterfaces()
  const { availableModels } = useModels()
  const [notice, setNotice] = useState('')

  const modelObj = availableModels.find(m => m.name === feed.model)

  const handleProbe = () => {
    setNotice('')
    if (!(feed.url || '').trim()) { setNotice('Enter a UDP URL on the Dashboard first.'); return }
    if (!connected) { setNotice('Backend unavailable — cannot probe.'); return }
    sendCommand({ type: 'probe', ...feedPayload(feedId, feed, modelObj) })
  }

  const inputCls = 'w-full border p-2 rounded text-sm dark:bg-gray-700 dark:border-gray-600'

  return (
    <div className="border border-gray-200 dark:border-gray-700 rounded-lg bg-gray-50 dark:bg-gray-900 p-4">
      <div className="flex items-center justify-between mb-2">
        <h3 className="font-bold">Feed {feedId} Diagnostics</h3>
        <span className="text-xs text-gray-400 truncate max-w-[50%]">{feed.url || 'no URL set'}</span>
      </div>

      {/* Network interface (for multicast probe) */}
      <label className="block mb-2">
        <span className="text-xs font-medium text-gray-600 dark:text-gray-300">Network Interface</span>
        <div className="flex items-center gap-2">
          <select className={inputCls} value={feed.interface || ''} disabled={ifaceLoading}
            onChange={e => update(feedId, { interface: e.target.value })}>
            {interfaces.map(i => <option key={i.address || 'auto'} value={i.address}>{i.name}</option>)}
          </select>
          <button onClick={reloadInterfaces} title="Reload interfaces"
            className="px-2 py-2 rounded border border-gray-300 dark:border-gray-600 text-sm hover:bg-gray-100 dark:hover:bg-gray-700">
            {ifaceLoading ? <span className="inline-block animate-spin">⟳</span> : '⟳'}
          </button>
        </div>
        <span className="text-[11px] text-gray-400">Auto tries every NIC and picks the one that receives the stream.</span>
      </label>

      <button onClick={handleProbe} disabled={!connected}
        className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700 disabled:opacity-50 text-sm">
        🔍 Probe Feed {feedId}
      </button>
      {notice && <div className="text-xs text-red-600 dark:text-red-400 mt-1">{notice}</div>}

      <ProbeResultCard probeResult={feed.probeResult} />
      <PipelineStatus pipelineStatus={feed.pipelineStatus} />
      <DebugPanel feedId={feedId} />
    </div>
  )
}
