// Stand-in for real Sonos UPnP control until there's hardware to talk to.
// Exposes the same shape a real implementation would, so swapping this
// out later doesn't change the controller API in server.js.

let state = { playing: false, track: null, room: null }

export function getStatus() {
  return { ...state }
}

// Takes a rich query (title/artist/album) rather than one opaque string —
// finding the actual best-matching track is this function's job. For now
// it just composes a display string; a real implementation would search
// Spotify/Sonos and pick a match (see designs/satellites.md TODOs).
export function play({ title, artist, album, room }) {
  const track = [title, artist && `by ${artist}`, album && `(${album})`].filter(Boolean).join(' ')
  state = { playing: true, track, room: room ?? null }
  console.log(`[sonos stub] playing "${track}" in ${room ?? 'unspecified room'}`)
  return getStatus()
}

export function pause() {
  state = { ...state, playing: false }
  console.log('[sonos stub] paused')
  return getStatus()
}
