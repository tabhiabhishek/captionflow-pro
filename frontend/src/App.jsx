import { useEffect } from 'react'
import { BrowserRouter as Router, Routes, Route, NavLink } from 'react-router-dom'
import { useStore } from './store'
import Dashboard from './components/Dashboard'
import CaptionMonitor from './components/CaptionMonitor'
import SingleModelTranscription from './components/SingleModelTranscription'
import Settings from './components/Settings'
import EngineConfig from './components/EngineConfig'
import Logs from './components/Logs'
import Login from './components/Login'

const NAV = [
  { to: '/', label: 'Dashboard', end: true },
  { to: '/single', label: 'Single Model' },
  { to: '/monitor', label: 'Caption Monitor' },
  { to: '/engine', label: 'Engine Config' },
  { to: '/settings', label: 'Settings' },
  { to: '/logs', label: 'Logs' },
]

function ThemeToggle() {
  const theme = useStore(s => s.theme)
  const toggleTheme = useStore(s => s.toggleTheme)
  return (
    <button
      onClick={toggleTheme}
      title="Toggle light / dark theme"
      className="ml-auto text-xs px-3 py-1.5 rounded-md border border-gray-300 dark:border-gray-600
                 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
    >
      {theme === 'dark' ? '☀ Light' : '🌙 Dark'}
    </button>
  )
}

function App() {
  const setConfig = useStore(state => state.setConfig)
  const setTheme = useStore(state => state.setTheme)

  useEffect(() => {
    fetch('/api/config')
      .then(r => r.json())
      .then(data => {
        setConfig(data)
        // Honour the theme saved in the backend config, if present.
        if (data && data.theme) setTheme(data.theme)
      })
      .catch(err => console.error('[Config] Failed to load /api/config:', err))
  }, [])

  return (
    <Router>
      <div className="min-h-screen bg-gray-100 dark:bg-gray-900 text-gray-900 dark:text-gray-100 transition-colors">
        <nav className="bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 shadow-sm
                        px-4 py-3 flex items-center gap-1">
          <span className="font-semibold text-sm mr-4 text-gray-800 dark:text-gray-100">Model AI</span>
          {NAV.map(n => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.end}
              className={({ isActive }) =>
                `text-sm px-3 py-1.5 rounded-md transition-colors ${
                  isActive
                    ? 'bg-blue-600 text-white'
                    : 'text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700'
                }`
              }
            >
              {n.label}
            </NavLink>
          ))}
          <ThemeToggle />
        </nav>
        <div className="container mx-auto p-4">
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/single" element={<SingleModelTranscription />} />
            <Route path="/monitor" element={<CaptionMonitor />} />
            <Route path="/engine" element={<EngineConfig />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="/logs" element={<Logs />} />
            <Route path="/login" element={<Login />} />
          </Routes>
        </div>
      </div>
    </Router>
  )
}

export default App
