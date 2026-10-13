import { create } from 'zustand'

// Cap the number of captions kept per feed in memory. Full history for downloads
// is preserved up to this bound; beyond it the oldest are dropped so a long live
// session cannot grow the array (and DOM) without limit (Task 5).
const MAX_CAPTIONS = 5000

const emptyFeed = () => ({
  url: '',
  sourceType: 'udp',        // 'udp' | 'sdi'
  device: '',               // SDI device name (when sourceType === 'sdi')
  model: '',
  interface: '',
  prompt: '',
  chunkSize: 3,
  isRunning: false,
  captions: [],
  captionIds: {},            // id -> true, for O(1) dedup (Task 4)
  stats: {},
  probeResult: null,
  pipelineStatus: null,
  deviceInfo: null,          // resolved inference device (Task 1/6)
  profile: null,             // per-stage profiling report (Task 1)
  // AI / caption engine settings
  language: '',              // '' = auto-detect
  audioPad: 1.0,
  overlap: 2.0,
  hallucinationFilter: true,
  calibration: false,
  modelBackend: 'auto',
  terminology: null          // { filename, dir }
})

// ---- Theme helpers (Task 3) ------------------------------------------------
export function applyTheme(theme) {
  const dark = theme !== 'light'
  const root = document.documentElement
  root.classList.toggle('dark', dark)
  root.setAttribute('data-theme', dark ? 'dark' : 'light')
  try { localStorage.setItem('theme', dark ? 'dark' : 'light') } catch { /* ignore */ }
}

const initialTheme = (() => {
  try { return localStorage.getItem('theme') || 'dark' } catch { return 'dark' }
})()

export const useStore = create((set) => ({
  feeds: {
    1: { ...emptyFeed(), model: 'base' },
    2: { ...emptyFeed(), model: 'base' }
  },
  systemStats: { cpu: 0, memory: 0, gpu: 0 },
  diagnostics: null,          // aggregate /api/diagnostics payload (Task 6)

  // Static media uploads: { [id]: { ...meta, captions: { '1': [], '2': [] } } }
  uploads: {},
  // Upload explicitly chosen to view in the Caption Monitor (null = auto/live).
  monitorUploadId: null,
  setMonitorUpload: (id) => set({ monitorUploadId: id }),

  // Single Model Transcription page (separate feature).
  single: {
    status: 'idle', phase: 'idle', progress: 0, modelId: null, displayName: null,
    modelPath: null, language: null, device: null, gpuMemory: null,
    uploadId: null, filename: null, totalChunks: 0, processed: 0,
    captions: [], captionIds: {},
    // Live source (UDP / SDI) run on the Single Model page.
    source: 'file', live: false, liveUrl: null, chunksCaptured: 0,
  },
  setSingle: (patch) => set((state) => ({ single: { ...state.single, ...patch } })),
  addSingleCaption: (segs) => set((state) => {
    const s = state.single
    const ids = { ...s.captionIds }
    const fresh = []
    for (const seg of (segs || [])) {
      const id = seg.id || `s-${Date.now()}-${Math.random()}`
      if (ids[id]) continue
      ids[id] = true
      fresh.push({ ...seg, id, _rx: Date.now() })
    }
    if (!fresh.length) return {}
    return { single: { ...s, captions: [...s.captions, ...fresh], captionIds: ids } }
  }),
  clearSingleCaptions: () => set((state) => ({
    single: { ...state.single, captions: [], captionIds: {} },
  })),
  resetSingle: () => set((state) => ({
    single: {
      ...state.single, status: 'idle', phase: 'idle', progress: 0,
      uploadId: null, filename: null, totalChunks: 0, processed: 0,
      captions: [], captionIds: {},
      source: 'file', live: false, liveUrl: null, chunksCaptured: 0,
    },
  })),
  setUploads: (list) => set((state) => {
    const uploads = {}
    for (const u of (list || [])) {
      uploads[u.id] = { ...(state.uploads[u.id] || { captions: {} }), ...u }
    }
    return { uploads }
  }),
  upsertUpload: (u) => set((state) => ({
    uploads: {
      ...state.uploads,
      [u.id]: { ...(state.uploads[u.id] || { captions: {} }), ...u }
    }
  })),
  addUploadCaption: (id, feed, segments) => set((state) => {
    // Tolerate captions that arrive before the upload record is loaded (e.g. the
    // user opened the Caption Monitor mid-processing): create a stub so nothing
    // is dropped — a later upload_status fills in the metadata.
    const up = state.uploads[id] || { id, captions: {}, status: 'processing', filename: 'upload' }
    const caps = { ...(up.captions || {}) }
    const key = String(feed)
    const existing = caps[key] || []
    const seen = new Set(existing.map(c => c.id))
    const now = Date.now()
    const fresh = (segments || [])
      .filter(s => !s.id || !seen.has(s.id))
      .map(s => ({ ...s, _rx: now }))   // arrival stamp for highlight/ordering
    caps[key] = [...existing, ...fresh]
    return { uploads: { ...state.uploads, [id]: { ...up, captions: caps } } }
  }),
  removeUpload: (id) => set((state) => {
    const uploads = { ...state.uploads }
    delete uploads[id]
    const monitorUploadId = state.monitorUploadId === id ? null : state.monitorUploadId
    return { uploads, monitorUploadId }
  }),

  // Theme (Task 3)
  theme: initialTheme,
  setTheme: (theme) => { applyTheme(theme); set({ theme }) },
  toggleTheme: () => set((state) => {
    const next = state.theme === 'dark' ? 'light' : 'dark'
    applyTheme(next)
    return { theme: next }
  }),

  // Model discovery state
  availableModels: [],      // [{ name, path }]
  modelsLoading: false,
  modelsError: null,

  // Connection state
  wsConnected: false,

  logs: { feed1: [], feed2: [], system: [] },

  // Set main config (does not overwrite availableModels)
  setConfig: (config) => set((state) => {
    const newFeeds = { ...state.feeds }
    ;(config.feeds || []).forEach(f => {
      newFeeds[f.id] = {
        ...emptyFeed(),
        ...state.feeds[f.id],
        ...f,
        isRunning: false
      }
    })
    return { feeds: newFeeds }
  }),

  // Model discovery
  setModelsLoading: (loading) => set({ modelsLoading: loading }),
  setModelsError: (error) => set({ modelsError: error }),
  setAvailableModels: (models) => set({ availableModels: models || [], modelsError: null }),

  setWsConnected: (connected) => set({ wsConnected: connected }),

  // Append ONLY new captions (dedup by id), preserve order, bound the length,
  // and stamp each with a stable id + arrival time for incremental rendering.
  addCaption: (feedId, segments) => set((state) => {
    const feed = state.feeds[feedId]
    if (!feed) return {}
    const ids = { ...feed.captionIds }
    const fresh = []
    let counter = feed.captions.length
    for (const seg of segments) {
      const id = seg.id || `${feedId}-${Date.now()}-${counter++}`
      if (ids[id]) continue          // already have it — skip (no re-render churn)
      ids[id] = true
      fresh.push({ ...seg, id, _rx: Date.now() })
    }
    if (!fresh.length) return {}
    let captions = [...feed.captions, ...fresh]
    if (captions.length > MAX_CAPTIONS) {
      const dropped = captions.slice(0, captions.length - MAX_CAPTIONS)
      captions = captions.slice(-MAX_CAPTIONS)
      for (const d of dropped) delete ids[d.id]
    }
    return { feeds: { ...state.feeds, [feedId]: { ...feed, captions, captionIds: ids } } }
  }),

  clearCaptions: (feedId) => set((state) => ({
    feeds: {
      ...state.feeds,
      [feedId]: { ...state.feeds[feedId], captions: [], captionIds: {} }
    }
  })),

  setDeviceInfo: (feedId, deviceInfo) => set((state) => ({
    feeds: { ...state.feeds, [feedId]: { ...state.feeds[feedId], deviceInfo } }
  })),

  setProfile: (feedId, profile) => set((state) => ({
    feeds: { ...state.feeds, [feedId]: { ...state.feeds[feedId], profile } }
  })),

  setDiagnostics: (diagnostics) => set({ diagnostics }),

  // Fresh Start (Task 15): clear all runtime state, keep feed CONFIG (url, model,
  // prompt, settings), theme, models and connection. Returns the UI to Idle.
  resetWorkspace: () => set((state) => {
    const feeds = {}
    for (const [id, feed] of Object.entries(state.feeds)) {
      feeds[id] = {
        ...feed,               // preserve saved config for this feed
        isRunning: false,
        captions: [],
        captionIds: {},
        stats: {},
        probeResult: null,
        pipelineStatus: null,
        deviceInfo: null,
        profile: null,
      }
    }
    return {
      feeds,
      systemStats: { cpu: 0, memory: 0, gpu: 0 },
      diagnostics: null,
    }
  }),

  updateFeedStats: (feedId, stats) => set((state) => ({
    feeds: {
      ...state.feeds,
      [feedId]: { ...state.feeds[feedId], stats }
    }
  })),

  setProbeResult: (feedId, probeResult) => set((state) => ({
    feeds: {
      ...state.feeds,
      [feedId]: { ...state.feeds[feedId], probeResult }
    }
  })),

  setPipelineStatus: (feedId, pipelineStatus) => set((state) => ({
    feeds: {
      ...state.feeds,
      [feedId]: { ...state.feeds[feedId], pipelineStatus }
    }
  })),

  updateSystemStats: (stats) => set({ systemStats: stats }),

  setRunning: (feedId, running) => set((state) => ({
    feeds: {
      ...state.feeds,
      [feedId]: { ...state.feeds[feedId], isRunning: running }
    }
  })),

  updateFeedConfig: (feedId, data) => set((state) => ({
    feeds: {
      ...state.feeds,
      [feedId]: { ...state.feeds[feedId], ...data }
    }
  }))
}))
