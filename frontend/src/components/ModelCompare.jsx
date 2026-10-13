import React from 'react'
import FeedControl from './FeedControl'
import CaptionDisplay from './CaptionDisplay'
import StatsPanel from './StatsPanel'

export default function ModelCompare() {
  return (
    <div>
      <h1 className="text-2xl font-bold mb-4">Model Compare</h1>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <FeedControl feedId={1} />
          <CaptionDisplay feedId={1} />
          <StatsPanel feedId={1} />
        </div>
        <div>
          <FeedControl feedId={2} />
          <CaptionDisplay feedId={2} />
          <StatsPanel feedId={2} />
        </div>
      </div>
    </div>
  )
}