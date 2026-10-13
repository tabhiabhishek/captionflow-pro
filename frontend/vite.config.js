import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Proxy targets use 127.0.0.1, NOT "localhost". On Windows localhost resolves to
// ::1 (IPv6) first, but uvicorn binds 0.0.0.0 which is IPv4-only — so the
// WebSocket proxy failed with ECONNREFUSED and the UI rendered with no live
// data (no captions, no status, permanently "Disconnected").
const BACKEND = 'http://127.0.0.1:8000'

export default defineConfig({
  plugins: [react()],
  server: {
    // Dual-stack: '::' with node's default ipv6Only=false accepts BOTH
    // http://localhost (which resolves to ::1 on Windows) and http://127.0.0.1.
    // Binding either one alone leaves the other refused — pinning 127.0.0.1
    // broke every "localhost" bookmark.
    host: '::',
    proxy: {
      '/api': BACKEND,
      '/ws': {
        target: 'ws://127.0.0.1:8000',
        ws: true,
      },
    },
  },
})
