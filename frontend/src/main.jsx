import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'
import { applyTheme } from './store'

// Apply the persisted/default theme before first paint so there is no flash of
// the wrong theme (Task 3).
try {
  applyTheme(localStorage.getItem('theme') || 'dark')
} catch {
  applyTheme('dark')
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
