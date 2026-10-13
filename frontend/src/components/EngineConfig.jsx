import React, { useCallback, useEffect, useMemo, useState } from 'react'

/**
 * Editor for backend/app/config.json — the file quick_captions.py actually reads.
 *
 * Deliberately generic: it walks whatever the backend returns rather than listing
 * fields by hand, so every key in the config is editable and new keys appear
 * automatically instead of silently going missing from the UI.
 */

const SECTION_HELP = {
  paths: 'Folders and files the engine reads/writes. A wrong path is NOT an error — the engine just loads nothing, so check the badges.',
  processing: 'Chunk geometry. chunk_duration drives both ffmpeg chunking and the caption timeline.',
  decode: 'Decoder + output-quality gates. min_text_length / max_repetition_ratio / min_unique_words_ratio drop degenerate decodes.',
  vad: 'Voice activity detection. Set a gate to 0 to disable it. flatness_threshold rejects pure tones; zcr_threshold rejects hiss.',
  pipeline: 'Master on/off switches for each post-processing stage.',
  models: 'Model backend, alignment (WhisperX) and timestamp settings.',
  audio: 'Pre-transcription audio enhancement and masking.',
  grammar: 'Filler words and hallucination blocklists.',
  cea608: 'Broadcast caption formatting — line length, frame rate, timing.',
  output: 'Caption JSON output options.',
  performance: 'Threading, batching and memory behaviour.',
  debug: 'Verbose per-chunk logging. Off by default (adds overhead).',
}

function titleize(k) {
  return k.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}

function Field({ path, value, onChange }) {
  const key = path[path.length - 1]
  const id = path.join('.')

  if (typeof value === 'boolean') {
    return (
      <label className="flex items-center gap-2 text-xs cursor-pointer py-0.5">
        <input type="checkbox" checked={value} onChange={e => onChange(path, e.target.checked)} />
        <span className="text-gray-700 dark:text-gray-200">{titleize(key)}</span>
      </label>
    )
  }
  if (typeof value === 'number') {
    return (
      <label className="block py-0.5">
        <span className="block text-[10px] uppercase tracking-wide text-gray-400 dark:text-gray-500">{titleize(key)}</span>
        <input type="number" step="any" value={value} id={id}
          onChange={e => onChange(path, e.target.value === '' ? 0 : Number(e.target.value))}
          className="w-full text-xs px-2 py-1 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-800 dark:text-gray-100" />
      </label>
    )
  }
  if (value === null || typeof value === 'string') {
    const long = typeof value === 'string' && value.length > 60
    return (
      <label className="block py-0.5">
        <span className="block text-[10px] uppercase tracking-wide text-gray-400 dark:text-gray-500">{titleize(key)}</span>
        {long
          ? <textarea rows={2} value={value ?? ''} onChange={e => onChange(path, e.target.value)}
              className="w-full text-xs px-2 py-1 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-800 dark:text-gray-100 font-mono" />
          : <input type="text" value={value ?? ''} placeholder={value === null ? '(null)' : ''}
              onChange={e => onChange(path, e.target.value)}
              className="w-full text-xs px-2 py-1 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-800 dark:text-gray-100 font-mono" />}
      </label>
    )
  }
  // Arrays and free-form maps (blocklists, term maps) — edited as JSON so no
  // entry is lost to a UI that only understands flat values.
  return <JsonField path={path} value={value} onChange={onChange} />
}

function JsonField({ path, value, onChange }) {
  const key = path[path.length - 1]
  const [text, setText] = useState(() => JSON.stringify(value, null, 2))
  const [err, setErr] = useState('')
  useEffect(() => { setText(JSON.stringify(value, null, 2)) }, [value])
  const commit = (t) => {
    setText(t)
    try {
      onChange(path, JSON.parse(t))
      setErr('')
    } catch (e) {
      setErr(e.message)
    }
  }
  const count = Array.isArray(value) ? `${value.length} items` : `${Object.keys(value || {}).length} keys`
  return (
    <label className="block py-0.5 col-span-2">
      <span className="block text-[10px] uppercase tracking-wide text-gray-400 dark:text-gray-500">
        {titleize(key)} <span className="normal-case text-gray-400">({count})</span>
      </span>
      <textarea rows={Math.min(10, Math.max(2, text.split('\n').length))} value={text}
        onChange={e => commit(e.target.value)}
        className={`w-full text-xs px-2 py-1 rounded border font-mono bg-white dark:bg-gray-700 text-gray-800 dark:text-gray-100
          ${err ? 'border-red-500' : 'border-gray-300 dark:border-gray-600'}`} />
      {err && <span className="text-[10px] text-red-600 dark:text-red-400">Invalid JSON: {err}</span>}
    </label>
  )
}

function Group({ path, obj, onChange, depth = 0 }) {
  const entries = Object.entries(obj || {})
  const scalars = entries.filter(([, v]) => v === null || typeof v !== 'object' || Array.isArray(v))
  const nested = entries.filter(([, v]) => v && typeof v === 'object' && !Array.isArray(v))
  return (
    <>
      <div className="grid grid-cols-2 gap-x-3">
        {scalars.map(([k, v]) => <Field key={k} path={[...path, k]} value={v} onChange={onChange} />)}
      </div>
      {nested.map(([k, v]) => (
        <div key={k} className={`mt-2 pl-3 border-l-2 ${depth ? 'border-gray-200 dark:border-gray-700' : 'border-blue-200 dark:border-blue-900'}`}>
          <div className="text-xs font-semibold text-gray-600 dark:text-gray-300 mb-1">{titleize(k)}</div>
          <Group path={[...path, k]} obj={v} onChange={onChange} depth={depth + 1} />
        </div>
      ))}
    </>
  )
}

function PathBadge({ info }) {
  // An absent write-target is normal (the engine creates it), so it must not be
  // shown as an error alongside genuinely mistyped input paths.
  const cls = info.exists
    ? 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300'
    : info.writable_target
      ? 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300'
      : 'bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300'
  return <span className={`text-[10px] px-1.5 py-0.5 rounded ${cls}`} title={info.value || ''}>{info.kind}</span>
}

export default function EngineConfig() {
  const [cfg, setCfg] = useState(null)
  const [orig, setOrig] = useState(null)
  const [pathInfo, setPathInfo] = useState([])
  const [filePath, setFilePath] = useState('')
  const [msg, setMsg] = useState('')
  const [err, setErr] = useState('')
  const [saving, setSaving] = useState(false)
  const [open, setOpen] = useState({})

  const load = useCallback(async () => {
    setErr(''); setMsg('')
    try {
      const r = await fetch('/api/engine/config')
      const d = await r.json()
      if (!d.success) throw new Error(d.detail || 'load failed')
      setCfg(d.config); setOrig(JSON.stringify(d.config)); setFilePath(d.path)
      setOpen(o => (Object.keys(o).length ? o : { paths: true, processing: true }))
    } catch (e) { setErr(String(e.message || e)) }
    try {
      const r2 = await fetch('/api/engine/paths')
      const d2 = await r2.json()
      if (d2.success) setPathInfo(d2.paths)
    } catch { /* badges are advisory */ }
  }, [])

  useEffect(() => { load() }, [load])

  const onChange = useCallback((path, value) => {
    setCfg(prev => {
      const next = structuredClone(prev)
      let node = next
      for (let i = 0; i < path.length - 1; i++) node = node[path[i]]
      node[path[path.length - 1]] = value
      return next
    })
  }, [])

  const dirty = cfg && orig && JSON.stringify(cfg) !== orig

  const save = async () => {
    setSaving(true); setErr(''); setMsg('')
    try {
      const r = await fetch('/api/engine/config', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config: cfg }),
      })
      const d = await r.json()
      if (!r.ok) throw new Error(d.detail || 'save failed')
      setMsg(d.message || 'Saved.')
      setOrig(JSON.stringify(cfg))
      const r2 = await fetch('/api/engine/paths'); const d2 = await r2.json()
      if (d2.success) setPathInfo(d2.paths)
    } catch (e) { setErr(String(e.message || e)) } finally { setSaving(false) }
  }

  const sections = useMemo(() => Object.keys(cfg || {}).filter(k => !k.startsWith('_')), [cfg])
  // Only input paths count as broken — write targets are created on the next run.
  const badPaths = pathInfo.filter(p => !p.exists && !p.writable_target)

  if (!cfg) {
    return (
      <div>
        <h1 className="text-2xl font-bold mb-2">Engine Config</h1>
        {err ? <div className="text-sm text-red-600 dark:text-red-400">{err}</div>
             : <div className="text-sm text-gray-500">Loading…</div>}
      </div>
    )
  }

  return (
    <div>
      <div className="flex items-center gap-2 mb-1">
        <h1 className="text-2xl font-bold">Engine Config</h1>
        {dirty && <span className="text-xs px-2 py-0.5 rounded bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300">unsaved changes</span>}
      </div>
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-1">
        Every value <code className="px-1 rounded bg-gray-100 dark:bg-gray-800">quick_captions.py</code> reads, from
        <code className="mx-1 px-1 rounded bg-gray-100 dark:bg-gray-800">{filePath}</code>.
      </p>
      <p className="text-xs text-gray-500 dark:text-gray-400 mb-4">
        The worker loads this file at startup, so a save applies on the next <b>model load</b> — reload the model
        (or restart the feed) to pick changes up. A backup is kept as <code>config.json.bak</code>.
      </p>

      {badPaths.length > 0 && (
        <div className="mb-4 rounded-lg border border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-900/20 p-3">
          <div className="text-sm font-semibold text-red-700 dark:text-red-300 mb-1">
            {badPaths.length} configured path{badPaths.length === 1 ? '' : 's'} not found on disk
          </div>
          <div className="text-xs text-red-700 dark:text-red-300">
            The engine does not error on these — it just loads nothing, so the related feature silently does nothing.
          </div>
          <ul className="mt-1 text-xs font-mono text-red-800 dark:text-red-200">
            {badPaths.map(p => <li key={p.key}>{p.key} = {String(p.value)}</li>)}
          </ul>
        </div>
      )}

      <div className="flex flex-wrap gap-2 mb-4">
        <button onClick={save} disabled={!dirty || saving}
          className="text-sm font-semibold px-4 py-2 rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50">
          {saving ? 'Saving…' : 'Save Config'}
        </button>
        <button onClick={load} disabled={saving}
          className="text-sm px-4 py-2 rounded border border-gray-300 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700">
          Reload from disk
        </button>
        <button onClick={() => setOpen(Object.fromEntries(sections.map(s => [s, true])))}
          className="text-sm px-3 py-2 rounded border border-gray-300 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700">Expand all</button>
        <button onClick={() => setOpen({})}
          className="text-sm px-3 py-2 rounded border border-gray-300 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700">Collapse all</button>
      </div>

      {msg && <div className="mb-3 text-sm text-green-700 dark:text-green-400">{msg}</div>}
      {err && <div className="mb-3 text-sm text-red-600 dark:text-red-400">{err}</div>}

      <div className="space-y-2">
        {sections.map(sect => {
          const isOpen = !!open[sect]
          const val = cfg[sect]
          return (
            <div key={sect} className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800">
              <button onClick={() => setOpen(o => ({ ...o, [sect]: !o[sect] }))}
                className="w-full flex items-center gap-2 px-4 py-2 text-left hover:bg-gray-50 dark:hover:bg-gray-700/40">
                <span className="text-gray-400 w-3">{isOpen ? '▾' : '▸'}</span>
                <span className="font-semibold text-sm">{titleize(sect)}</span>
                <span className="text-xs text-gray-400 dark:text-gray-500">
                  {val && typeof val === 'object' && !Array.isArray(val) ? `${Object.keys(val).length} keys` : ''}
                </span>
              </button>
              {isOpen && (
                <div className="px-4 pb-3">
                  {SECTION_HELP[sect] && (
                    <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">{SECTION_HELP[sect]}</p>
                  )}
                  {sect === 'paths' ? (
                    <div className="space-y-1">
                      {Object.entries(val).map(([k, v]) => {
                        const info = pathInfo.find(p => p.key === k)
                        return (
                          <div key={k} className="flex items-center gap-2">
                            <div className="flex-1">
                              <Field path={['paths', k]} value={v} onChange={onChange} />
                            </div>
                            <div className="pt-3 shrink-0">{info ? <PathBadge info={info} /> : null}</div>
                          </div>
                        )
                      })}
                    </div>
                  ) : (val && typeof val === 'object' && !Array.isArray(val)
                    ? <Group path={[sect]} obj={val} onChange={onChange} />
                    : <Field path={[sect]} value={val} onChange={onChange} />)}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
