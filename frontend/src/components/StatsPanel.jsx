import React from 'react'
import { useStore } from '../store'

export default function StatsPanel({ feedId }) {
  const stats = useStore(state => state.feeds[feedId]?.stats || {})
  return (
    <div className="grid grid-cols-3 gap-2 text-sm mt-2 p-2 bg-gray-100 dark:bg-gray-700 rounded">
      <div>Latency: {stats.latency ?? '-'}s</div>
      <div>Confidence: {stats.confidence ?? '-'}</div>
      <div>Words: {stats.words ?? 0}</div>
      <div>WPM: {stats.wpm ?? '-'}</div>
      <div>Chunks: {stats.chunks ?? 0}</div>
      <div>Inference: {stats.inference_time ?? '-'}s</div>
    </div>
  )
}