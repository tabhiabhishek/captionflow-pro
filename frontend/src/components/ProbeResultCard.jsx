import React from 'react'

function Row({ label, value }) {
  if (value === null || value === undefined || value === '') return null
  return (
    <div className="flex justify-between text-sm py-0.5">
      <span className="text-gray-500 dark:text-gray-400">{label}</span>
      <span className="font-mono text-gray-800 dark:text-gray-100">{String(value)}</span>
    </div>
  )
}

export default function ProbeResultCard({ probeResult }) {
  if (!probeResult) return null

  // ---- Failure card -------------------------------------------------------
  if (probeResult.status !== 'success') {
    return (
      <div className="mt-3 border border-red-300 dark:border-red-700 rounded p-3 bg-red-50 dark:bg-red-900/30">
        <h4 className="font-bold text-red-700 dark:text-red-300 mb-1">⚠️ Probe Failed</h4>
        {probeResult.reason && <Row label="Reason" value={probeResult.reason} />}
        {probeResult.error && (
          <div className="text-sm mt-1">
            <div className="text-gray-500 dark:text-gray-400">Error Message</div>
            <pre className="whitespace-pre-wrap break-words font-mono text-xs text-red-700 dark:text-red-300">
              {probeResult.error}
            </pre>
          </div>
        )}
        {probeResult.suggested_fix && (
          <div className="text-sm mt-2 text-green-700 dark:text-green-400">
            💡 <span className="font-semibold">Suggested Fix:</span> {probeResult.suggested_fix}
          </div>
        )}
      </div>
    )
  }

  // ---- Success card -------------------------------------------------------
  const { video, audio, program, bitrate, duration, interface_used, warnings = [], errors = [] } = probeResult
  return (
    <div className="mt-3 border border-gray-300 dark:border-gray-600 rounded p-3 bg-white dark:bg-gray-800">
      <h4 className="font-bold text-gray-800 dark:text-gray-100 mb-2">🔍 Probe Result</h4>

      <Row label="Program" value={program} />
      <Row label="Interface" value={interface_used ? interface_used : (interface_used === '' ? 'Auto (default route)' : null)} />
      <Row label="Duration" value={duration ? `${Number(duration).toFixed(1)} s` : null} />
      <Row label="Bitrate" value={bitrate ? `${Math.round(Number(bitrate) / 1000)} kbps` : null} />

      <div className="grid grid-cols-2 gap-3 mt-2">
        <div className="border-t border-gray-200 dark:border-gray-700 pt-2">
          <div className="text-xs uppercase tracking-wide text-gray-400 mb-1">Video</div>
          {video ? (
            <>
              <Row label="Codec" value={video.codec} />
              <Row label="Resolution" value={video.resolution} />
              <Row label="FPS" value={video.frame_rate} />
              <Row label="PID" value={video.pid} />
            </>
          ) : (
            <div className="text-sm text-gray-400 italic">No video</div>
          )}
        </div>
        <div className="border-t border-gray-200 dark:border-gray-700 pt-2">
          <div className="text-xs uppercase tracking-wide text-gray-400 mb-1">Audio</div>
          {audio ? (
            <>
              <Row label="Codec" value={audio.codec} />
              <Row label="Sample Rate" value={audio.sample_rate ? `${audio.sample_rate} Hz` : null} />
              <Row label="Channels" value={audio.channels} />
              <Row label="PID" value={audio.pid} />
              <Row label="Language" value={audio.language} />
            </>
          ) : (
            <div className="text-sm text-gray-400 italic">No audio</div>
          )}
        </div>
      </div>

      {warnings.length > 0 && (
        <div className="mt-2 text-sm text-yellow-600 dark:text-yellow-400">
          {warnings.map((w, i) => <div key={i}>⚠️ {w}</div>)}
        </div>
      )}
      {errors.length > 0 && (
        <div className="mt-2 text-sm text-red-600 dark:text-red-400">
          {errors.map((e, i) => <div key={i}>❌ {e}</div>)}
        </div>
      )}
    </div>
  )
}
