import React, { useCallback, useEffect, useState } from 'react'

function Row({ label, value, ok }) {
  return (
    <div className="flex justify-between text-sm py-1 border-b border-gray-100 dark:border-gray-700">
      <span className="text-gray-500 dark:text-gray-400">{label}</span>
      <span className={`font-mono text-xs ${ok === true ? 'text-green-600 dark:text-green-400'
        : ok === false ? 'text-red-600 dark:text-red-400' : 'text-gray-800 dark:text-gray-100'}`}>
        {value ?? '—'}
      </span>
    </div>
  )
}

export default function SystemDiagnostics() {
  const [ffmpeg, setFfmpeg] = useState(null)
  const [whisper, setWhisper] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const [f, w] = await Promise.all([
        fetch('/api/ffmpeg').then(r => r.json()),
        fetch('/api/whisper').then(r => r.json())
      ])
      setFfmpeg(f.diagnostics)
      setWhisper(w)
    } catch (err) {
      setError(err.message || 'Failed to load diagnostics')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="font-bold">FFmpeg Diagnostics</h3>
        <button onClick={load} className="text-xs px-2 py-1 rounded border border-gray-300 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700">
          {loading ? 'Refreshing…' : '⟳ Refresh'}
        </button>
      </div>
      {error && <div className="text-sm text-red-600 dark:text-red-400">⚠️ {error}</div>}
      {ffmpeg && (
        <div className="border border-gray-200 dark:border-gray-700 rounded p-3 bg-white dark:bg-gray-800">
          <Row label="ffmpeg path" value={ffmpeg.ffmpeg.path} />
          <Row label="ffmpeg available" value={ffmpeg.ffmpeg.available ? 'yes' : 'no'} ok={ffmpeg.ffmpeg.available} />
          <Row label="ffmpeg version" value={ffmpeg.ffmpeg.version} />
          <Row label="ffprobe path" value={ffmpeg.ffprobe.path} />
          <Row label="ffprobe available" value={ffmpeg.ffprobe.available ? 'yes' : 'no'} ok={ffmpeg.ffprobe.available} />
          <Row label="ffprobe version" value={ffmpeg.ffprobe.version} />
          {ffmpeg.ffmpeg.source_env && <Row label="resolved via env" value={ffmpeg.ffmpeg.source_env} />}
        </div>
      )}

      <h3 className="font-bold pt-2">Whisper / Model Diagnostics</h3>
      {whisper && (
        <div className="border border-gray-200 dark:border-gray-700 rounded p-3 bg-white dark:bg-gray-800">
          <Row label="model folder" value={whisper.model_folder} />
          <Row label="model count" value={whisper.model_count} ok={whisper.model_count > 0} />
          {(whisper.models || []).map(m => (
            <Row key={m.name} label={m.name} value={m.backend || 'unknown'} />
          ))}
          {whisper.success === false && <Row label="error" value={whisper.error} ok={false} />}
        </div>
      )}
    </div>
  )
}
