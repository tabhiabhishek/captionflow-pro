import { useCallback, useEffect } from 'react'
import { useStore } from '../store'

// Loads the model list from the backend and keeps it in the store.
// Handles the current API shape ({ success, models: [{name, path}] }) and
// tolerates the legacy shape ({ models: ["run", ...] }).
export function useModels() {
  const availableModels = useStore(s => s.availableModels)
  const modelsLoading = useStore(s => s.modelsLoading)
  const modelsError = useStore(s => s.modelsError)
  const setAvailableModels = useStore(s => s.setAvailableModels)
  const setModelsLoading = useStore(s => s.setModelsLoading)
  const setModelsError = useStore(s => s.setModelsError)

  const loadModels = useCallback(async () => {
    setModelsLoading(true)
    setModelsError(null)
    console.log('[Models] Loading models from /api/models')
    try {
      const res = await fetch('/api/models')
      if (!res.ok) {
        let detail = `HTTP ${res.status}`
        try {
          const body = await res.json()
          if (body.detail) detail = body.detail
        } catch (_) { /* ignore */ }
        throw new Error(detail)
      }
      const data = await res.json()
      const normalised = (data.models || []).map(m =>
        typeof m === 'string' ? { name: m, path: m } : m
      )
      console.log(`[Models] Loaded ${normalised.length} model(s)`, normalised)
      setAvailableModels(normalised)
    } catch (err) {
      console.error('[Models] Failed to load models:', err)
      setModelsError(err.message || 'Failed to load models')
      setAvailableModels([])
    } finally {
      setModelsLoading(false)
    }
  }, [setAvailableModels, setModelsLoading, setModelsError])

  // Load on mount (i.e. whenever the page loads / reloads).
  useEffect(() => {
    loadModels()
  }, [loadModels])

  return { availableModels, modelsLoading, modelsError, reloadModels: loadModels }
}
