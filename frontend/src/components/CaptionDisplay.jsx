import React, { useEffect, useRef } from 'react'
import { useStore } from '../store'

export default function CaptionDisplay({ feedId }) {
  const captions = useStore(state => state.feeds[feedId]?.captions || [])
  const containerRef = useRef(null)

  useEffect(() => {
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight
    }
  }, [captions])

  return (
    <div className="border rounded p-2 h-64 overflow-y-auto bg-gray-50 dark:bg-gray-800" ref={containerRef}>
      {captions.map((seg, idx) => (
        <div key={idx} className="text-sm border-b border-gray-200 dark:border-gray-700 py-1">
          <span className="text-gray-500 dark:text-gray-400 mr-2">
            {new Date(seg.start * 1000).toISOString().substr(11, 12)}
          </span>
          <span>{seg.text}</span>
          <span className="text-xs text-gray-400 ml-2">(conf: {seg.confidence?.toFixed(2) ?? '1.00'})</span>
        </div>
      ))}
      {captions.length === 0 && <div className="text-gray-400 italic">No captions yet...</div>}
    </div>
  )
}