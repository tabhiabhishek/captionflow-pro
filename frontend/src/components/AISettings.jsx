import React from 'react'
import { useStore } from '../store'

const LANGUAGES = [
  { code: '', label: 'Auto-detect' },
  { code: 'en', label: 'English' },
  { code: 'hi', label: 'Hindi' },
  { code: 'es', label: 'Spanish' },
  { code: 'fr', label: 'French' },
  { code: 'ta', label: 'Tamil' },
  { code: 'te', label: 'Telugu' },
  { code: 'bn', label: 'Bengali' },
  { code: 'mr', label: 'Marathi' }
]

const BACKENDS = [
  { value: 'auto', label: 'Auto' },
  { value: 'ctranslate2', label: 'CTranslate2 (fast)' },
  { value: 'transformers', label: 'Transformers' }
]

function Field({ label, hint, children }) {
  return (
    <label className="block">
      <span className="text-xs font-medium text-gray-600 dark:text-gray-300">{label}</span>
      {children}
      {hint && <span className="block text-[11px] text-gray-400 mt-0.5">{hint}</span>}
    </label>
  )
}

function Toggle({ label, checked, onChange, hint }) {
  return (
    <label className="flex items-start gap-2 cursor-pointer">
      <input type="checkbox" checked={!!checked} onChange={e => onChange(e.target.checked)} className="mt-1" />
      <span>
        <span className="text-xs font-medium text-gray-700 dark:text-gray-200">{label}</span>
        {hint && <span className="block text-[11px] text-gray-400">{hint}</span>}
      </span>
    </label>
  )
}

// Editable AI / caption-engine settings for a single feed. Reused on the
// Dashboard feed card and in Settings.
export default function AISettings({ feedId }) {
  const feed = useStore(s => s.feeds[feedId]) || {}
  const update = useStore(s => s.updateFeedConfig)
  const set = (patch) => update(feedId, patch)

  const inputCls = 'w-full border p-1.5 rounded text-sm dark:bg-gray-700 dark:border-gray-600'

  return (
    <div className="grid grid-cols-2 gap-3">
      <Field label="Language">
        <select className={inputCls} value={feed.language ?? ''} onChange={e => set({ language: e.target.value })}>
          {LANGUAGES.map(l => <option key={l.code} value={l.code}>{l.label}</option>)}
        </select>
      </Field>

      <Field label="Model Backend" hint="Auto picks per model folder">
        <select className={inputCls} value={feed.modelBackend ?? 'auto'} onChange={e => set({ modelBackend: e.target.value })}>
          {BACKENDS.map(b => <option key={b.value} value={b.value}>{b.label}</option>)}
        </select>
      </Field>

      <Field label="Audio Padding (s)" hint="Silence pad per chunk">
        <input type="number" step="0.1" min="0" className={inputCls}
          value={feed.audioPad ?? 1.0} onChange={e => set({ audioPad: Number(e.target.value) })} />
      </Field>

      <Field label="Chunk Overlap (s)" hint="Context carried between chunks">
        <input type="number" step="0.1" min="0" className={inputCls}
          value={feed.overlap ?? 2.0} onChange={e => set({ overlap: Number(e.target.value) })} />
      </Field>

      <Field label="Chunk Size (s)">
        <input type="number" step="1" min="1" className={inputCls}
          value={feed.chunkSize ?? 3} onChange={e => set({ chunkSize: Number(e.target.value) })} />
      </Field>

      <div className="flex flex-col gap-2 justify-center">
        <Toggle label="Hallucination Filtering" checked={feed.hallucinationFilter}
          onChange={v => set({ hallucinationFilter: v })} hint="Drop low-confidence phantom text" />
        <Toggle label="Calibration (alignment)" checked={feed.calibration}
          onChange={v => set({ calibration: v })} hint="Word-level timing; slower" />
      </div>
    </div>
  )
}
