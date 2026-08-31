// Stand-in for real Sonos UPnP control until there's hardware to talk to.
// Exposes the same shape a real implementation would, so swapping this
// out later doesn't change the controller API in server.js.

let state = { playing: false, track: null, room: null }

export function getStatus() {
  return { ...state }
}

export function play(track, room) {
  state = { playing: true, track, room: room ?? null }
  console.log(`[sonos stub] playing "${track}" in ${room ?? 'unspecified room'}`)
  return getStatus()
}

export function pause() {
  state = { ...state, playing: false }
  console.log('[sonos stub] paused')
  return getStatus()
}
