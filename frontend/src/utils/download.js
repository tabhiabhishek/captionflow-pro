// Caption export helpers (SRT / TXT / JSON) used by the Caption Monitor.

function pad(n, w = 2) {
  return String(n).padStart(w, '0')
}

function srtTime(seconds) {
  const s = Math.max(0, seconds || 0)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = Math.floor(s % 60)
  const ms = Math.round((s - Math.floor(s)) * 1000)
  return `${pad(h)}:${pad(m)}:${pad(sec)},${pad(ms, 3)}`
}

export function toSRT(captions) {
  return captions.map((c, i) => {
    const start = srtTime(c.start ?? 0)
    const end = srtTime(c.end ?? (c.start ?? 0) + 3)
    return `${i + 1}\n${start} --> ${end}\n${c.text || ''}\n`
  }).join('\n')
}

export function toTXT(captions) {
  return captions.map(c => c.text || '').join('\n')
}

export function toJSON(captions) {
  return JSON.stringify(captions, null, 2)
}

export function downloadFile(filename, content, mime = 'text/plain') {
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

export function exportCaptions(captions, format, feedLabel = 'feed') {
  // Drop the media extension so "clip.ts" exports "clip.srt", which players
  // auto-load next to the video (not "clip.ts.srt").
  const stamp = feedLabel.replace(/\.(ts|mp4|mkv|mov|mxf|avi|mpe?g|m2ts|wav|mp3|aac|flac|m4a|ogg)$/i, '')
    .replace(/\s+/g, '_').toLowerCase()
  if (format === 'srt') downloadFile(`${stamp}.srt`, toSRT(captions), 'text/plain')
  else if (format === 'txt') downloadFile(`${stamp}.txt`, toTXT(captions), 'text/plain')
  else if (format === 'json') downloadFile(`${stamp}.json`, toJSON(captions), 'application/json')
}
