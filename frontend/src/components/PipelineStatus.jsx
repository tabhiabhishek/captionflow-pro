import React from 'react'

const STAGES = [
  { key: 'udp_input', label: 'UDP Input' },
  { key: 'ffmpeg', label: 'FFmpeg' },
  { key: 'chunk_writer', label: 'Chunk Writer' },
  { key: 'whisper', label: 'Whisper' },
  { key: 'caption_generator', label: 'Caption Generator' },
  { key: 'websocket', label: 'WebSocket' },
  { key: 'frontend', label: 'Frontend' }
]

const STATE_STYLES = {
  running: { dot: 'bg-green-500', text: 'text-green-600 dark:text-green-400', label: 'Running' },
  waiting: { dot: 'bg-yellow-400', text: 'text-yellow-600 dark:text-yellow-400', label: 'Waiting' },
  error:   { dot: 'bg-red-500', text: 'text-red-600 dark:text-red-400', label: 'Error' },
  stopped: { dot: 'bg-gray-400', text: 'text-gray-500 dark:text-gray-400', label: 'Stopped' }
}

export default function PipelineStatus({ pipelineStatus }) {
  const status = pipelineStatus || {}

  return (
    <div className="mt-3 border border-gray-300 dark:border-gray-600 rounded p-3 bg-white dark:bg-gray-800">
      <h4 className="font-bold text-gray-800 dark:text-gray-100 mb-2">🛠 Pipeline</h4>
      <div className="space-y-1">
        {STAGES.map((stage, idx) => {
          const state = status[stage.key] || 'stopped'
          const style = STATE_STYLES[state] || STATE_STYLES.stopped
          return (
            <div key={stage.key}>
              <div className="flex items-center justify-between text-sm">
                <div className="flex items-center gap-2">
                  <span className={`inline-block w-2.5 h-2.5 rounded-full ${style.dot}`} />
                  <span className="text-gray-700 dark:text-gray-200">{stage.label}</span>
                </div>
                <span className={`text-xs font-medium ${style.text}`}>{style.label}</span>
              </div>
              {idx < STAGES.length - 1 && (
                <div className="ml-1 text-gray-300 dark:text-gray-600 text-xs leading-3">↓</div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
