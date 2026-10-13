import React, { useMemo, useState } from 'react'

// STEP 5 — per-chunk Raw vs Processed comparison across all models.
// Aligns every model's caption for the same chunk into one row so you can compare
// what each model produced (raw + Quick-Caption-processed) for identical audio.

function srtT(sec) {
  sec = Math.max(0, sec || 0)
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60)
  const s = Math.floor(sec % 60), ms = Math.round((sec - Math.floor(sec)) * 1000)
  const p = (n, w = 2) => String(n).padStart(w, '0')
  return `${p(h)}:${p(m)}:${p(s)}.${p(ms, 3)}`
}

export default function ChunkComparison({ upload }) {
  const feedIds = Object.keys(upload.feeds || { 1: {}, 2: {} }).map(Number).sort()
  const [search, setSearch] = useState('')

  // Index each model's captions by chunk number.
  const byChunk = useMemo(() => {
    const map = {}   // chunk -> { start, end, [feedId]: caption }
    for (const fid of feedIds) {
      for (const c of (upload.captions?.[String(fid)] || [])) {
        const k = c.chunk ?? Math.round((c.start || 0) / 3)
        if (!map[k]) map[k] = { chunk: k, start: c.start, end: c.end }
        map[k][fid] = c
        if (c.start < map[k].start) map[k].start = c.start
      }
    }
    return map
  }, [upload.captions, feedIds.join(',')])

  const rows = useMemo(() => {
    let list = Object.values(byChunk).sort((a, b) => a.chunk - b.chunk)
    const q = search.trim().toLowerCase()
    if (q) list = list.filter(r => feedIds.some(fid => {
      const c = r[fid]
      return c && ((c.text || '').toLowerCase().includes(q) || (c.raw || '').toLowerCase().includes(q))
    }))
    return list
  }, [byChunk, search, feedIds.join(',')])

  return (
    <div>
      <div className="flex items-center gap-2 mb-2">
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search chunks…"
          className="flex-1 text-sm px-2 py-1 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-800 dark:text-gray-100 placeholder-gray-400" />
        <span className="text-xs text-gray-500 dark:text-gray-400">{rows.length} chunk(s)</span>
      </div>

      <div className="max-h-[60vh] overflow-y-auto space-y-2 pr-1">
        {rows.length === 0
          ? <div className="italic text-gray-400 dark:text-gray-500 text-sm">No processed chunks yet.</div>
          : rows.map(r => (
            <div key={r.chunk} className="border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
              <div className="px-3 py-1 bg-gray-100 dark:bg-gray-800 text-xs font-mono text-gray-600 dark:text-gray-300 flex justify-between">
                <span>Chunk #{String(r.chunk).padStart(4, '0')}</span>
                <span>{srtT(r.start)} → {srtT(r.end)}</span>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 divide-y md:divide-y-0 md:divide-x divide-gray-200 dark:divide-gray-700">
                {feedIds.map(fid => {
                  const c = r[fid]
                  return (
                    <div key={fid} className="p-2">
                      <div className="text-[10px] uppercase tracking-wide text-gray-400 dark:text-gray-500 mb-1">
                        Model {fid} · {upload.feeds?.[String(fid)]?.model || '—'}
                      </div>
                      <div className="text-xs text-amber-700 dark:text-amber-400">
                        <span className="text-gray-400 dark:text-gray-500">RAW: </span>
                        {c?.raw || <span className="italic text-gray-400 dark:text-gray-600">—</span>}
                      </div>
                      <div className="text-sm text-gray-900 dark:text-gray-50 mt-1">
                        <span className="text-[10px] px-1 rounded bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300 mr-1">QuickCaption</span>
                        {c?.text || <span className="italic text-gray-400 dark:text-gray-600">—</span>}
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          ))}
      </div>
    </div>
  )
}
