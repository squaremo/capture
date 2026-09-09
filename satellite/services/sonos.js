// Real Sonos discovery + transport control via `sonos-discovery`
// (github.com/jishi/node-sonos-discovery) — an actively maintained,
// promise-based UPnP client; not the abandoned `sonos`/`node-sonos` npm
// package. Constructing it starts SSDP discovery and its own local UPnP
// eventing listener immediately — there's no separate start() to call,
// and it needs to run somewhere with genuine LAN presence (SSDP
// multicast doesn't cross Tailscale), which the satellite already has.
//
// Track catalog search now happens on the central backend, directly
// against Spotify's Web API (see designs/satellites.md) — this only
// matches a room name against discovered speakers, and plays/pauses
// whatever track the hub already resolved.

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
    // Every discovered speaker, always — not just ones this satellite has
    // itself issued a play()/pause() to. Earlier this only listed
    // self-remembered "last command sent" state, which meant a freshly
    // booted (or simply idle) satellite showed no Sonos rows at all in
    // the local controls panel, even though speakers were discovered and
    // controllable — the light panel's room list, by contrast, always
    // showed everything, so the two halves of "controls" panel disagreed
    // on what "no activity yet" should look like. Fixed by reading
    // sonos-discovery's own live state (playbackState/currentTrack/
    // volume), kept current via real UPnP GENA eventing — genuine ground
    // truth, not remembered intent, resolving the "still unexplored"
    // note this used to carry in designs/satellites.md. track is null
    // when nothing has ever been loaded on that player (playbackState
    // 'STOPPED' with an empty currentTrack.title) — the frontend uses
    // that to skip the play/pause toggle but still offer volume.
    //
    // nextTrack is the same live-eventing shape, one further ahead in the
    // queue — see designs/satellites.md's "Sonos queue: now and next".
    // sonos-discovery already parses AVTransport's r:NextTrackURI/
    // NextTrackMetaData the same way it parses the current track, so this
    // is free once play()/queueTrack() actually populate the queue with
    // more than one item; null with nothing queued up after the current
    // track (or nothing playing at all).
    activity: system.players.map((player) => {
      const track = player.state.currentTrack
      const next = player.state.nextTrack
      return {
        speaker: player.roomName,
        playing: player.state.playbackState === 'PLAYING',
        track: track?.title ? { title: track.title, artist: track.artist || undefined, album: track.album || undefined } : null,
        nextTrack: next?.title ? { title: next.title, artist: next.artist || undefined, album: next.album || undefined } : null,
        volume: player.state.volume,
      }
    }),
  }
}

// Resolves a room name into a specific speaker, without committing
// playback — this is the realistic split: search first (can fail;
// changes nothing), then play() by the exact result, so what a human
// approved is exactly what plays, not a fresh re-match that could
// plausibly land on something else. Throws if room doesn't match any
// discovered speaker closely enough.
export async function matchRoom(room) {
  await ready
  const speaker = await matchSpeaker(room)
  if (speaker.confidence === 'no_match') {
    throw new Error(`No speaker matching "${speaker.requested}"`)
  }
  return { speaker }
}

// Shared by every command below that needs an already-resolved speaker —
// the "speaker vanished between resolve and commit" check used to be
// copy-pasted into play/pause/resume/setVolume individually.
function getPlayerOrThrow(speaker) {
  const player = system.getPlayer(speaker.name)
  if (!player) {
    throw new Error(`Speaker "${speaker.name}" is no longer available`)
  }
  return player
}

// Sonos's own address for "this player's queue" as an AVTransport source
// — distinct from the x-sonos-spotify: URI a single resolved track uses.
// Switching a player's transport to this is what makes it actually
// advance through what's been queued via addURIToQueue() below, and is
// what makes state.nextTrack (see getStatus()) mean anything.
function queueUri(player) {
  return `x-rincon-queue:${player.uuid}#0`
}

// Commits playback using an already-resolved track/speaker (from a prior
// matchRoom() call) against a real, discovered Sonos player — no
// matching happens here, so this can't land on a different result than
// what was resolved and shown for approval.
//
// Replaces the queue with this one track and plays it from there, rather
// than the earlier direct setAVTransport(spotifyUri) approach — the
// switch is what makes "play now" and queueTrack() below share one
// underlying queue, which is what "now and next" (see
// designs/satellites.md) actually reflects. The URI/metadata construction
// itself (the hard-won reverse-engineered part, see spotifyPlayable()) is
// unchanged; only the sequence of Sonos calls is. Not yet independently
// re-verified against real hardware in this queue-routed form — the
// direct-URI form this replaces was.
export async function play({ track, speaker }) {
  await ready
  const player = getPlayerOrThrow(speaker)
  const { uri, metadata } = spotifyPlayable(track)
  await player.clearQueue()
  await player.addURIToQueue(uri, metadata)
  await player.setAVTransport(queueUri(player))
  await player.play()
  return { playing: true, track, speaker: { name: player.roomName } }
}

// Appends a resolved track to a speaker's queue, without disturbing
// whatever's already playing — see designs/satellites.md's "Sonos queue:
// now and next". If the speaker is currently idle (nothing loaded, or
// stopped), there's nothing for the new item to queue behind, so this
// also switches it onto its own queue and starts playing — otherwise the
// track would just sit added and silent with no obvious way to start it.
// If something is already playing, this never touches transport state:
// the track lands after whatever's ahead of it in the queue and plays in
// its turn.
export async function queueTrack({ track, speaker }) {
  await ready
  const player = getPlayerOrThrow(speaker)
  const wasIdle = player.state.playbackState !== 'PLAYING' && player.state.playbackState !== 'PAUSED_PLAYBACK'
  const { uri, metadata } = spotifyPlayable(track)
  await player.addURIToQueue(uri, metadata)
  if (wasIdle) {
    await player.setAVTransport(queueUri(player))
    await player.play()
  }
  return { queued: true, startedPlaying: wasIdle, track, speaker: { name: player.roomName } }
}

// Pauses a specific, already-known speaker — there's no single "the
// system" to pause once there's more than one real player.
export async function pause({ speaker }) {
  await ready
  const player = getPlayerOrThrow(speaker)
  await player.pause()
  return { playing: false, speaker: { name: player.roomName } }
}

// Resumes a paused speaker from wherever it stopped — deliberately just
// player.play(), not play() above: re-running setAVTransport with the
// same URI reloads the track from the start rather than continuing, so
// this is a genuinely different operation, not "play() with a
// remembered track." No track/speaker body needed since the player
// already has one loaded from the original play() call.
export async function resume({ speaker }) {
  await ready
  const player = getPlayerOrThrow(speaker)
  await player.play()
  return { playing: true, speaker: { name: player.roomName } }
}

// Skips to the next/previous item in the speaker's own queue — only
// meaningful once play()/queueTrack() have put it there, since both now
// always route through the queue (see play() above). Manual, ungated,
// speaker-scoped, same as pause()/resume() — never proposed/approved by
// the LLM plan system, only reachable from the local controls panel.
export async function next({ speaker }) {
  await ready
  const player = getPlayerOrThrow(speaker)
  await player.nextTrack()
  return { speaker: { name: player.roomName } }
}

export async function previous({ speaker }) {
  await ready
  const player = getPlayerOrThrow(speaker)
  await player.previousTrack()
  return { speaker: { name: player.roomName } }
}

// Sets a specific speaker's volume (0-100) — same manual, ungated,
// speaker-scoped shape as play()/pause(). Nothing to record afterwards:
// getStatus() reads volume (and everything else) live off the player.
export async function setVolume({ speaker, level }) {
  await ready
  const player = getPlayerOrThrow(speaker)
  const clamped = Math.max(0, Math.min(100, Math.round(level)))
  await player.setVolume(clamped)
  return { speaker: { name: player.roomName }, volume: clamped }
}

// Builds the URI + DIDL-Lite metadata Sonos needs to play a Spotify
// track through its own linked-service integration — an undocumented
// protocol. Adapted from node-sonos-http-api's spotifyDef.js (the
// reference reverse-engineering of it) rather than guessed from scratch.
// Verified against real hardware with a fixed placeholder track id; only
// depends on track.id, so the backend's real Spotify search result is a
// drop-in — see designs/satellites.md.
//
// Deliberately diverges from the reference implementation on one point:
// spotifyDef.js sends an empty <dc:title> for track-type items (Sonos
// apparently expects to backfill display metadata itself from the
// service link) — in practice that left the Sonos app showing "Unknown
// content" instead of the track. Sending the real title/artist/album we
// already have avoids depending on that backfill working.
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
    `<dc:title>${escapeXml(track.title)}</dc:title>` +
    (track.artist ? `<dc:creator>${escapeXml(track.artist)}</dc:creator>` : '') +
    (track.album ? `<upnp:album>${escapeXml(track.album)}</upnp:album>` : '') +
    (track.image ? `<upnp:albumArtURI>${escapeXml(track.image)}</upnp:albumArtURI>` : '') +
    '<upnp:class>object.item.audioItem.musicTrack</upnp:class>' +
    `<desc id="cdudn" nameSpace="urn:schemas-rinconnetworks-com:metadata-1-0/">${token}</desc></item></DIDL-Lite>`

  return { uri, metadata }
}

// track.title/artist/album come from Spotify's catalog — external data
// being hand-embedded into XML, not trusted to already be safe.
function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
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
