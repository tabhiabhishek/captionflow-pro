import { useCallback, useEffect, useState } from 'react'

// Loads SDI capture devices (Blackmagic DeckLink) from the backend.
// Shape: [{ name }].
export function useSdiDevices() {
  const [devices, setDevices] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  const loadDevices = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/sdi/devices')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      setDevices(Array.isArray(data.devices) ? data.devices : [])
    } catch (err) {
      console.error('[SDI] Failed to load devices:', err)
      setError(err.message || 'Failed to load SDI devices')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { loadDevices() }, [loadDevices])

  return { devices, loading, error, reloadDevices: loadDevices }
}
