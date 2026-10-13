import React, { useRef, useState } from 'react'
import { useStore } from '../store'

// Uploads a terminology file (word list / corrections) for a feed to the backend.
export default function TerminologyUpload({ feedId }) {
  const feed = useStore(s => s.feeds[feedId]) || {}
  const update = useStore(s => s.updateFeedConfig)
  const fileRef = useRef(null)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState(null)

  const onFile = async (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    setUploading(true)
    setError(null)
    try {
      const form = new FormData()
      form.append('file', file)
      const res = await fetch(`/api/terminology/${feedId}`, { method: 'POST', body: form })
      if (!res.ok) {
        let detail = `HTTP ${res.status}`
        try { const b = await res.json(); if (b.detail) detail = b.detail } catch (_) {}
        throw new Error(detail)
      }
      const data = await res.json()
      update(feedId, { terminology: { filename: data.filename, dir: data.dir }, terminology_dir: data.dir })
      console.log('[Terminology] Uploaded', data)
    } catch (err) {
      console.error('[Terminology] Upload failed', err)
      setError(err.message || 'Upload failed')
    } finally {
      setUploading(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  return (
    <div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={uploading}
          className="text-sm px-3 py-1.5 rounded border border-gray-300 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-50"
        >
          {uploading ? 'Uploading…' : '📄 Upload Terminology'}
        </button>
        {feed.terminology?.filename && (
          <span className="text-xs text-green-600 dark:text-green-400 truncate">
            ✓ {feed.terminology.filename}
          </span>
        )}
        <input ref={fileRef} type="file" accept=".txt,.csv,.json,.tsv" onChange={onFile} className="hidden" />
      </div>
      {error && <div className="text-xs text-red-600 dark:text-red-400 mt-1">⚠️ {error}</div>}
    </div>
  )
}
