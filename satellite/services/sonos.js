// Real Sonos discovery + transport control via `sonos-discovery`
// (github.com/jishi/node-sonos-discovery) — an actively maintained,
// promise-based UPnP client; not the abandoned `sonos`/`node-sonos` npm
// package. Constructing it starts SSDP discovery and its own local UPnP
// eventing listener immediately — there's no separate start() to call,
// and it needs to run somewhere with genuine LAN presence (SSDP
// multicast doesn't cross Tailscale), which the satellite already has.
//
// Track search is still a stub — see Open questions in
// designs/satellites.md — but play()/pause() now issue real AVTransport
// calls against real, discovered speakers. Since there's no catalog
// search yet, the "resolved" track is always the same known-good,
// playable Spotify track regardless of what was asked for, so the
// approval text a human sees always matches what will actually play
// rather than echoing back a request it can't fulfil.

// sonos-discovery is CommonJS with `module.exports = SonosSystem` — Node's
// ESM interop only exposes that as the default export, not a named one.
import SonosSystem from 'sonos-discovery'

const system = new SonosSystem({})

// Resolves once discovery has found the household's zones and linked
// services (SonosSystem's 'initialized' event) — or after a timeout, so
// a house with no reachable Sonos system still boots the satellite
// instead of hanging every request forever.
const READY_TIMEOUT_MS = 10_000
const ready = Promise.race([
  new Promise((resolve) => system.once('initialized', resolve)),
  new Promise((resolve) => setTimeout(resolve, READY_TIMEOUT_MS)),
])

// Stands in for real catalog search until that's built. Whatever
// title/artist/album was actually asked for is ignored — the resolved
// result always describes *this* track, not a fabrication of the
// request, so what's shown for approval always matches what plays.
const PLACEHOLDER_TRACK = {
  id: '4uLU6hMCjMI75M1A2tKUQC', // Rick Astley – Never Gonna Give You Up
  title: 'Never Gonna Give You Up',
  artist: 'Rick Astley',
  album: 'Whenever You Need Somebody',
}

// Sonos's own numeric id for "the Spotify service" in this household,
// read live off the discovered system (throws if Spotify isn't linked in
// the Sonos app). "sn" — which linked Spotify account, if there's more
// than one — has no discoverable value; it's an empirically-determined
// per-household constant (the reference implementation this is adapted
// from hardcodes a single working value with a comment calling it a
// hack). Override via SPOTIFY_ACCOUNT_SN once you've worked out yours
// against real hardware — see Open questions in designs/satellites.md.
const SPOTIFY_ACCOUNT_SN = process.env.SPOTIFY_ACCOUNT_SN ?? '1'

export function getStatus() {
  return {
    ready: system.players.length > 0,
    playersFound: system.players.length,
    rooms: system.players.map((p) => p.roomName),
  }
}

// Resolves a rich query into a specific track + speaker, without
// committing playback — this is the realistic split: search first (can
// fail; changes nothing), then play() by the exact result, so what a
// human approved is exactly what plays, not a fresh re-search that could
// plausibly land on something else. Track search and speaker matching
// don't depend on each other, so they run concurrently. Throws if room
// doesn't match any discovered speaker closely enough.
export async function search({ room }) {
  await ready
  const [track, speaker] = await Promise.all([
    searchTrack(),
    matchSpeaker(room),
  ])
  if (speaker.confidence === 'no_match') {
    throw new Error(`No speaker matching "${speaker.requested}"`)
  }
  return { track, speaker }
}

// Commits playback using an already-resolved track/speaker (from a prior
// search() call) against a real, discovered Sonos player — no matching
// happens here, so this can't land on a different result than what was
// resolved and shown for approval.
export async function play({ track, speaker }) {
  await ready
  const player = system.getPlayer(speaker.name)
  if (!player) {
    throw new Error(`Speaker "${speaker.name}" is no longer available`)
  }
  const { uri, metadata } = spotifyPlayable(track)
  await player.setAVTransport(uri, metadata)
  await player.play()
  return { playing: true, track, speaker: { name: player.roomName } }
}

// Pauses a specific, already-known speaker — there's no single "the
// system" to pause once there's more than one real player, so (unlike
// the old stub) this now needs to be told which one.
export async function pause({ speaker }) {
  await ready
  const player = system.getPlayer(speaker.name)
  if (!player) {
    throw new Error(`Speaker "${speaker.name}" is no longer available`)
  }
  await player.pause()
  return { playing: false, speaker: { name: player.roomName } }
}

// Builds the URI + DIDL-Lite metadata Sonos needs to play a Spotify
// track through its own linked-service integration — an undocumented
// protocol. Adapted from node-sonos-http-api's spotifyDef.js (the
// reference reverse-engineering of it) rather than guessed from scratch,
// but still unverified against real hardware — see Open questions in
// designs/satellites.md, particularly around SPOTIFY_ACCOUNT_SN.
function spotifyPlayable(track) {
  const sid = system.getServiceId('Spotify')
  const serviceType = system.getServiceType('Spotify')
  const encodedId = encodeURIComponent(track.id)

  const uri = `x-sonos-spotify:spotify%3atrack%3a${encodedId}?sid=${sid}&flags=8224&sn=${SPOTIFY_ACCOUNT_SN}`

  const token = `SA_RINCON${serviceType}_X_#Svc${serviceType}-0-Token`
  const metadata =
    '<DIDL-Lite xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" ' +
    'xmlns:r="urn:schemas-rinconnetworks-com:metadata-1-0/" xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/">' +
    `<item id="00032020spotify%3atrack%3a${encodedId}" parentID="00020000track:${track.id}" restricted="true">` +
    '<dc:title></dc:title><upnp:class>object.item.audioItem.musicTrack</upnp:class>' +
    `<desc id="cdudn" nameSpace="urn:schemas-rinconnetworks-com:metadata-1-0/">${token}</desc></item></DIDL-Lite>`

  return { uri, metadata }
}

// Stand-in for a real catalog search (Spotify's, or Sonos's own) —
// always resolves to the same known-good track. matchConfidence:
// 'placeholder' makes it obvious this isn't a real match yet, wherever
// it surfaces.
async function searchTrack() {
  return { ...PLACEHOLDER_TRACK, matchConfidence: 'placeholder' }
}

// Fuzzy-matches free text ("bedroom") against this house's actual,
// discovered Sonos room names ("Master Bedroom") — never the LLM's job,
// see designs/satellites.md. Exact match, then substring either
// direction, then a bounded edit-distance fallback; nothing within a
// plausible distance reports no_match rather than guessing wildly. No
// room given at all defaults to the first discovered speaker.
async function matchSpeaker(query) {
  const rooms = system.players.map((p) => p.roomName)

  if (!query) {
    return { name: rooms[0] ?? null, requested: null, confidence: rooms.length ? 'default' : 'no_match' }
  }

  const q = query.trim().toLowerCase()

  const exact = rooms.find(r => r.toLowerCase() === q)
  if (exact) return { name: exact, requested: query, confidence: 'exact' }

  const partial = rooms.find(r => r.toLowerCase().includes(q) || q.includes(r.toLowerCase()))
  if (partial) return { name: partial, requested: query, confidence: 'approximate' }

  let best = null
  let bestDistance = Infinity
  for (const r of rooms) {
    const distance = levenshtein(q, r.toLowerCase())
    if (distance < bestDistance) {
      bestDistance = distance
      best = r
    }
  }
  const threshold = Math.max(3, Math.floor((best?.length ?? 0) / 2))
  if (best && bestDistance <= threshold) return { name: best, requested: query, confidence: 'approximate' }

  return { name: null, requested: query, confidence: 'no_match' }
}

function levenshtein(a, b) {
  const rows = a.length + 1
  const cols = b.length + 1
  const d = Array.from({ length: rows }, (_, i) => {
    const row = new Array(cols).fill(0)
    row[0] = i
    return row
  })
  for (let j = 0; j < cols; j++) d[0][j] = j

  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost)
    }
  }
  return d[rows - 1][cols - 1]
}
