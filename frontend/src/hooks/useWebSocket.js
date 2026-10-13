import { useEffect, useState } from 'react'
import { useStore } from '../store'

// ---------------------------------------------------------------------------
// Singleton WebSocket connection with auto-reconnect.
// Multiple components (feed cards, diagnostics panels) share ONE socket
// instead of each opening its own.
// ---------------------------------------------------------------------------
let socket = null
let reconnectTimer = null
let reconnectAttempts = 0
let started = false

// Lightweight pub/sub for streamed log entries. Kept OUT of the Zustand store so
// high-frequency log lines don't trigger app-wide re-renders (Task 5).
const logListeners = new Set()
export function subscribeLogs(cb) {
  logListeners.add(cb)
  return () => logListeners.delete(cb)
}

const WS_URL =
  (window.location.protocol === 'https:' ? 'wss://' : 'ws://') +
  window.location.host + '/ws'

function log(...args) {
  console.log('%c[WS]', 'color:#3b82f6', ...args)
}

function connect() {
  const store = useStore.getState()

  log('Connecting to', WS_URL, reconnectAttempts ? `(reconnect #${reconnectAttempts})` : '')
  socket = new WebSocket(WS_URL)

  socket.onopen = () => {
    log('Connection opened')
    reconnectAttempts = 0
    useStore.getState().setWsConnected(true)
  }

  socket.onclose = (ev) => {
    log('Connection closed', ev.code, ev.reason || '')
    useStore.getState().setWsConnected(false)
    scheduleReconnect()
  }

  socket.onerror = (err) => {
    console.error('%c[WS]', 'color:#ef4444', 'Error', err)
  }

  socket.onmessage = (event) => {
    let msg
    try {
      msg = JSON.parse(event.data)
    } catch (e) {
      console.error('[WS] Bad message', event.data)
      return
    }
    const s = useStore.getState()
    switch (msg.type) {
      case 'config':
        log('Config received')
        s.setConfig(msg.data)
        break
      case 'caption':
        log('Caption received', 'feed', msg.feed, `${msg.segments?.length || 0} segment(s)`)
        s.addCaption(msg.feed, msg.segments || [])
        break
      case 'feed_stats':
        s.updateFeedStats(msg.feed, msg.data)
        break
      case 'system_stats':
        s.updateSystemStats(msg.data)
        break
      case 'probe_result':
        log('Probe response', 'feed', msg.feed, 'status:', msg.data?.status)
        s.setProbeResult(msg.feed, msg.data)
        break
      case 'pipeline_status':
        log('Status update (pipeline)', 'feed', msg.feed, msg.data)
        s.setPipelineStatus(msg.feed, msg.data)
        break
      case 'device_info':
        log('Device info', 'feed', msg.feed, msg.data?.device)
        s.setDeviceInfo(msg.feed, msg.data)
        break
      case 'profile':
        s.setProfile(msg.feed, msg.data)
        break
      case 'workspace_reset':
        log('Workspace reset — clearing UI state')
        s.resetWorkspace()
        break
      case 'upload_status':
        if (msg.data) s.upsertUpload(msg.data)
        break
      case 'upload_complete':
        if (msg.data) s.upsertUpload(msg.data)
        // STEP 7: auto-populate the Caption Monitor with the finished upload.
        s.setMonitorUpload(msg.upload_id)
        break
      case 'upload_caption':
        s.addUploadCaption(msg.upload_id, msg.feed, msg.segments || [])
        break
      case 'upload_error':
        s.upsertUpload({ id: msg.upload_id, status: 'error', error: msg.data?.error })
        break
      case 'upload_deleted':
        s.removeUpload(msg.upload_id)
        break
      case 'single_status': {
        const d = msg.data || {}
        s.setSingle({
          status: d.status, phase: d.phase, progress: d.progress,
          modelId: d.model_id, displayName: d.display_name, modelPath: d.model_path,
          language: d.language, device: d.device, gpuMemory: d.gpu_memory,
          // Preserve the locally-chosen upload: the backend reports upload_id=null
          // until single_start runs, so a Load/idle status must NOT wipe it (that
          // disabled the Start button). Cleared explicitly by resetSingle instead.
          uploadId: d.upload_id || s.single.uploadId,
          totalChunks: d.total_chunks, processed: d.processed,
          rawOnly: d.raw_only,
          source: d.source || 'file', live: !!d.live, liveUrl: d.live_url,
          chunksCaptured: d.chunks_captured || 0,
          chunksDropped: d.chunks_dropped || 0,
          currentChunk: d.current_chunk || null,
          exports: d.exports || null,
          pipeline: d.pipeline || 'quick_captions',
          pipelineLabel: d.pipeline_label || null,
          stage: d.stage || null,
          error: d.error,
        })
        break
      }
      case 'single_caption':
        s.addSingleCaption(msg.segments || [])
        break
      case 'log':
        // Fan out to whichever Logs page component is listening.
        logListeners.forEach(cb => { try { cb(msg) } catch (e) { /* ignore */ } })
        break
      default:
        log('Unknown message', msg)
    }
  }
}

function scheduleReconnect() {
  if (reconnectTimer) return
  reconnectAttempts += 1
  const delay = Math.min(1000 * 2 ** (reconnectAttempts - 1), 15000)
  log(`Reconnect attempt scheduled in ${delay}ms`)
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    connect()
  }, delay)
}

function ensureStarted() {
  if (!started) {
    started = true
    connect()
  }
}

export function sendCommand(command) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    log('Send', command.type, command)
    socket.send(JSON.stringify(command))
    return true
  }
  console.warn('[WS] Not open, command dropped:', command.type)
  return false
}

export function useWebSocket() {
  const wsConnected = useStore(state => state.wsConnected)
  const [, force] = useState(0)

  useEffect(() => {
    ensureStarted()
    // Nudge a re-render if the socket was already open before mount.
    force(n => n + 1)
    // Intentionally do NOT close the shared socket on unmount; it is a
    // process-wide singleton reused by every component.
  }, [])

  return { sendCommand, connected: wsConnected }
}
