import React, { useEffect, useState, useCallback } from 'react'

// Edit the post-processing correction lists (player names, terminology, hallucination).
// These are applied when captions pass through the quick_captions.py pipeline.

function linesToArr(text) {
  return text.split('\n').map(s => s.trim()).filter(Boolean)
}
function arrToLines(arr) {
  return (arr || []).join('\n')
}
// terminology text: "wrong = correct" per line  <->  {wrong: correct}
function textToFixes(text) {
  const fixes = {}
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (!t) continue
    const m = t.split(/\s*=\s*|\s*:\s*/)
    if (m.length >= 2 && m[0].trim()) fixes[m[0].trim()] = m.slice(1).join('=').trim()
  }
  return fixes
}
function fixesToText(fixes) {
  return Object.entries(fixes || {}).map(([k, v]) => `${k} = ${v}`).join('\n')
}

function Editor({ title, hint, value, onChange, onSave, saving, saved }) {
  return (
    <div className="mb-4">
      <div className="flex items-center justify-between mb-1">
        <div>
          <div className="text-sm font-semibold text-gray-800 dark:text-gray-100">{title}</div>
          <div className="text-xs text-gray-500 dark:text-gray-400">{hint}</div>
        </div>
        <button onClick={onSave} disabled={saving}
          className="text-xs px-3 py-1 rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50">
          {saving ? 'Saving…' : saved ? '✓ Saved' : 'Save'}
        </button>
      </div>
      <textarea value={value} onChange={e => onChange(e.target.value)} rows={8}
        className="w-full text-sm font-mono px-2 py-1.5 rounded border border-gray-300 dark:border-gray-600
                   bg-white dark:bg-gray-700 text-gray-800 dark:text-gray-100" />
    </div>
  )
}

export default function PostProcessSettings() {
  const [players, setPlayers] = useState('')
  const [terms, setTerms] = useState('')
  const [hExact, setHExact] = useState('')
  const [hStarts, setHStarts] = useState('')
  const [saving, setSaving] = useState('')
  const [saved, setSaved] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    fetch('/api/postprocess').then(r => r.json()).then(d => {
      if (!d.success) return
      setPlayers(arrToLines(d.lists.players?.names))
      setTerms(fixesToText(d.lists.terminology?.fixes))
      setHExact(arrToLines(d.lists.hallucination?.exact))
      setHStarts(arrToLines(d.lists.hallucination?.starts_with))
    }).catch(err => setError(String(err)))
  }, [])

  const put = useCallback(async (kind, data) => {
    setSaving(kind); setSaved(''); setError('')
    try {
      const r = await fetch(`/api/postprocess/${kind}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      setSaved(kind)
      setTimeout(() => setSaved(''), 2000)
    } catch (err) {
      setError(`Save ${kind} failed: ${err}`)
    } finally {
      setSaving('')
    }
  }, [])

  return (
    <div>
      <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">
        These lists are applied in the post-processing pipeline. Changes take effect on the next
        processing run (restart the feed / reprocess the file).
      </p>
      {error && <div className="text-xs text-red-600 dark:text-red-400 mb-2">{error}</div>}

      <Editor title="Player Names" hint="One name per line — corrected/capitalised as proper nouns."
        value={players} onChange={setPlayers} saving={saving === 'players'} saved={saved === 'players'}
        onSave={() => put('players', { names: linesToArr(players) })} />

      <Editor title="Terminology" hint="One per line as  wrong = correct  (e.g. boomra = Bumrah)."
        value={terms} onChange={setTerms} saving={saving === 'terminology'} saved={saved === 'terminology'}
        onSave={() => put('terminology', { fixes: textToFixes(terms) })} />

      <Editor title="Hallucination — exact match" hint="One phrase per line — whole caption dropped if it equals this."
        value={hExact} onChange={setHExact} saving={saving === 'hallucination'} saved={saved === 'hallucination'}
        onSave={() => put('hallucination', { exact: linesToArr(hExact), starts_with: linesToArr(hStarts) })} />

      <Editor title="Hallucination — starts with" hint="One phrase per line — caption dropped if it starts with this."
        value={hStarts} onChange={setHStarts} saving={saving === 'hallucination'} saved={saved === 'hallucination'}
        onSave={() => put('hallucination', { exact: linesToArr(hExact), starts_with: linesToArr(hStarts) })} />
    </div>
  )
}
