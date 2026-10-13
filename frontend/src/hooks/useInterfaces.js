import { useCallback, useEffect, useState } from 'react'

// Loads selectable network interfaces (for multicast UDP) from the backend.
// Shape: [{ name, address }] with an "Auto" entry (empty address) first.
export function useInterfaces() {
  const [interfaces, setInterfaces] = useState([{ name: 'Auto (default route)', address: '' }])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  const loadInterfaces = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/interfaces')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      if (Array.isArray(data.interfaces) && data.interfaces.length) {
        setInterfaces(data.interfaces)
      }
      console.log('[Interfaces] Loaded', data.interfaces)
    } catch (err) {
      console.error('[Interfaces] Failed to load:', err)
      setError(err.message || 'Failed to load interfaces')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadInterfaces()
  }, [loadInterfaces])

  return { interfaces, loading, error, reloadInterfaces: loadInterfaces }
}
