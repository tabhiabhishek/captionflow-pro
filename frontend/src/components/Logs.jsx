import React, { useEffect, useRef, useState, useMemo, useCallback } from 'react'
import { useWebSocket, subscribeLogs } from '../hooks/useWebSocket'

const LEVEL_STYLES = {
  DEBUG: 'text-gray-400 dark:text-gray-500',
  INFO: 'text-gray-700 dark:text-gray-200',
  WARNING: 'text-amber-600 dark:text-amber-400',
  ERROR: 'text-red-600 dark:text-red-400',
  CRITICAL: 'text-red-700 dark:text-red-300 font-semibold',
}

const MAX_VIEW = 3000

function fmtTs(ts) {
  try {
    const d = new Date((ts || 0) * 1000)
    return d.toTimeString().slice(0, 8) + '.' + String(d.getMilliseconds()).padStart(3, '0')
  } catch {
    return ''
  }
}

export default function Logs() {
  const { sendCommand, connected } = useWebSocket()
  const [scopes, setScopes] = useState({})
  const [scope, setScope] = useState('system')
  const [category, setCategory] = useState('application')
  const [entries, setEntries] = useState([])
  const [search, setSearch] = useState('')
  const [levelFilter, setLevelFilter] = useState('ALL')
  const [paused, setPaused] = useState(false)
  const [autoScroll, setAutoScroll] = useState(true)

  const scrollRef = useRef(null)
  const pausedRef = useRef(false)
  const bufferRef = useRef([])           // entries received while paused
  const [pendingCount, setPendingCount] = useState(0)

  useEffect(() => { pausedRef.current = paused }, [paused])

  // Load the scope/category tree once.
  useEffect(() => {
    fetch('/api/logs/scopes')
      .then(r => r.json())
      .then(d => { if (d.success) setScopes(d.scopes || {}) })
      .catch(err => console.error('[Logs] scopes failed', err))
  }, [])

  const categories = scopes[scope] || ['application']

  // Keep category valid when scope changes.
  useEffect(() => {
    if (!categories.includes(category)) setCategory(categories[0] || 'application')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, scopes])

  // (Re)subscribe when scope/category changes.
  useEffect(() => {
    setEntries([])
    bufferRef.current = []
    setPendingCount(0)
    sendCommand({ type: 'log_subscribe', scope, category })
    return () => { /* server keeps one sub per socket; switching re-subscribes */ }
  }, [scope, category, sendCommand, connected])

  // Receive streamed log deltas.
  useEffect(() => {
    const unsub = subscribeLogs((msg) => {
      if (msg.scope !== scope || msg.category !== category) return
      const incoming = msg.entries || []
      if (msg.replace) {
        bufferRef.current = []
        setPendingCount(0)
        setEntries(incoming.slice(-MAX_VIEW))
        return
      }
      if (pausedRef.current) {
        bufferRef.current.push(...incoming)
        setPendingCount(bufferRef.current.length)
      } else {
        setEntries(prev => [...prev, ...incoming].slice(-MAX_VIEW))
      }
    })
    return unsub
  }, [scope, category])

  // Auto-scroll to the newest line when enabled and not paused.
  useEffect(() => {
    if (autoScroll && !paused && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [entries, autoScroll, paused])

  const onScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40
    setAutoScroll(atBottom)
  }, [])

  const resume = useCallback(() => {
    setEntries(prev => [...prev, ...bufferRef.current].slice(-MAX_VIEW))
    bufferRef.current = []
    setPendingCount(0)
    setPaused(false)
    setAutoScroll(true)
  }, [])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return entries.filter(e => {
      if (levelFilter !== 'ALL' && e.level !== levelFilter) return false
      if (q && !(e.msg || '').toLowerCase().includes(q)) return false
      return true
    })
  }, [entries, search, levelFilter])

  const downloadLog = () => {
    window.open(`/api/logs/${scope}/${category}/download`, '_blank')
  }

  const clearLog = async () => {
    try {
      await fetch(`/api/logs/${scope}/${category}`, { method: 'DELETE' })
      setEntries([])
      bufferRef.current = []
      setPendingCount(0)
    } catch (err) {
      console.error('[Logs] clear failed', err)
    }
  }

  const scopeLabel = (s) => s.startsWith('feed') ? s.replace('feed', 'Feed ') : s.charAt(0).toUpperCase() + s.slice(1)

  return (
    <div>
      <div className="flex items-center gap-2 mb-4">
        <h1 className="text-2xl font-bold">Logs</h1>
        <span className={`text-xs px-2 py-0.5 rounded ${connected
          ? 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300'
          : 'bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300'}`}>
          {connected ? 'Live' : 'Disconnected'}
        </span>
      </div>

      {/* Controls */}
      <div className="flex flex-wrap items-center gap-2 mb-3 p-3 rounded-lg
                      bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700">
        <select value={scope} onChange={e => setScope(e.target.value)}
          className="text-sm px-2 py-1.5 rounded border border-gray-300 dark:border-gray-600
                     bg-white dark:bg-gray-700 text-gray-800 dark:text-gray-100">
          {Object.keys(scopes).map(s => <option key={s} value={s}>{scopeLabel(s)}</option>)}
        </select>
        <select value={category} onChange={e => setCategory(e.target.value)}
          className="text-sm px-2 py-1.5 rounded border border-gray-300 dark:border-gray-600
                     bg-white dark:bg-gray-700 text-gray-800 dark:text-gray-100">
          {categories.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
        <select value={levelFilter} onChange={e => setLevelFilter(e.target.value)}
          className="text-sm px-2 py-1.5 rounded border border-gray-300 dark:border-gray-600
                     bg-white dark:bg-gray-700 text-gray-800 dark:text-gray-100">
          {['ALL', 'DEBUG', 'INFO', 'WARNING', 'ERROR', 'CRITICAL'].map(l =>
            <option key={l} value={l}>{l}</option>)}
        </select>
        <input value={search} onChange={e => setSearch(e.target.value)}
          placeholder="Search…"
          className="flex-1 min-w-[140px] text-sm px-2 py-1.5 rounded border border-gray-300 dark:border-gray-600
                     bg-white dark:bg-gray-700 text-gray-800 dark:text-gray-100 placeholder-gray-400" />

        <button onClick={() => (paused ? resume() : setPaused(true))}
          className={`text-sm px-3 py-1.5 rounded border transition-colors ${paused
            ? 'bg-blue-600 text-white border-blue-600 hover:bg-blue-700'
            : 'border-gray-300 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700'}`}>
          {paused ? `Resume${pendingCount ? ` (${pendingCount})` : ''}` : 'Pause'}
        </button>
        <button onClick={downloadLog}
          className="text-sm px-3 py-1.5 rounded border border-gray-300 dark:border-gray-600
                     hover:bg-gray-100 dark:hover:bg-gray-700">
          Download
        </button>
        <button onClick={clearLog}
          className="text-sm px-3 py-1.5 rounded border border-gray-300 dark:border-gray-600
                     text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/30">
          Clear
        </button>
      </div>

      {/* Log viewer */}
      <div ref={scrollRef} onScroll={onScroll}
        className="h-[62vh] overflow-y-auto rounded-lg border border-gray-200 dark:border-gray-700
                   bg-gray-50 dark:bg-gray-900 font-mono text-xs p-3">
        {filtered.length === 0
          ? <div className="italic text-gray-400 dark:text-gray-500">No log entries.</div>
          : filtered.map((e, i) => (
            <div key={e.seq ?? i} className="whitespace-pre-wrap break-words leading-5">
              <span className="text-gray-400 dark:text-gray-600 mr-2">{fmtTs(e.ts)}</span>
              <span className={`mr-2 ${LEVEL_STYLES[e.level] || ''}`}>{(e.level || '').padEnd(7)}</span>
              <span className={LEVEL_STYLES[e.level] || 'text-gray-700 dark:text-gray-200'}>{e.msg}</span>
            </div>
          ))}
      </div>
      <div className="text-xs text-gray-400 dark:text-gray-500 mt-2">
        {filtered.length} shown{paused ? ' · paused' : autoScroll ? ' · live' : ' · scroll paused'}
      </div>
    </div>
  )
}
