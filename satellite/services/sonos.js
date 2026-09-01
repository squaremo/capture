// Stand-in for real Sonos + catalog-search integration until there's
// hardware/an API to talk to. Exposes the same shape a real
// implementation would — a matched track and a matched speaker, each
// carrying a confidence label — so swapping this out later doesn't
// change callers. See designs/satellites.md.

// Stub device list — a real implementation would discover these from the
// house's actual Sonos system rather than hardcoding them (there's no
// per-house device config yet, see Open questions in the design doc).
const SPEAKERS = ['Living Room', 'Bedroom', 'Kitchen']

let state = { playing: false, track: null, speaker: null }

export function getStatus() {
  return { ...state }
}

// Resolves a rich query into a specific track + speaker, without
// committing playback — this is the realistic split: search first (can
// fail; changes nothing), then play() by the exact result, so what a
// human approved is exactly what plays, not a fresh re-search that could
// plausibly land on something else. Track search and speaker matching
// don't depend on each other, so they run concurrently — trivial for
// these stubs, but the point where a real implementation would have two
// genuinely independent I/O calls (catalog search vs device discovery).
// Throws if room doesn't match any configured speaker closely enough.
export async function search({ title, artist, album, room }) {
  const [track, speaker] = await Promise.all([
    searchTrack({ title, artist, album }),
    matchSpeaker(room, SPEAKERS),
  ])
  if (speaker.confidence === 'no_match') {
    throw new Error(`No speaker matching "${speaker.requested}"`)
  }
  return { track, speaker }
}

// Commits playback using an already-resolved track/speaker (from a prior
// search() call) — no matching happens here, so this can't land on a
// different result than what was resolved and shown for approval.
export function play({ track, speaker }) {
  state = { playing: true, track, speaker }
  console.log(
    `[sonos stub] playing "${track.title}"${track.artist ? ` by ${track.artist}` : ''} ` +
    `(${track.matchConfidence} match) on ${speaker.name} (${speaker.confidence} match for "${speaker.requested}")`
  )
  return getStatus()
}

export function pause() {
  state = { ...state, playing: false }
  console.log('[sonos stub] paused')
  return getStatus()
}

// Stand-in for a real catalog search (Spotify, Sonos's own search, ...).
// Returns a plausible-shaped result — an id and a confidence label based
// on how specific the query was — without actually querying anything. A
// real implementation swaps only this function; callers don't change.
async function searchTrack({ title, artist, album }) {
  return {
    id: `trk_${Math.random().toString(36).slice(2, 10)}`,
    title,
    artist: artist ?? null,
    album: album ?? null,
    matchConfidence: artist ? 'exact' : 'approximate',
  }
}

// Fuzzy-matches free text ("bedroom") against this satellite's actual
// speaker names ("Master Bedroom") — never the LLM's job, see
// designs/satellites.md. Exact match, then substring either direction,
// then a bounded edit-distance fallback; nothing within a plausible
// distance reports no_match rather than guessing wildly. No room given at
// all defaults to the first configured speaker.
async function matchSpeaker(query, speakers) {
  if (!query) {
    return { name: speakers[0] ?? null, requested: null, confidence: speakers.length ? 'default' : 'no_match' }
  }

  const q = query.trim().toLowerCase()

  const exact = speakers.find(s => s.toLowerCase() === q)
  if (exact) return { name: exact, requested: query, confidence: 'exact' }

  const partial = speakers.find(s => s.toLowerCase().includes(q) || q.includes(s.toLowerCase()))
  if (partial) return { name: partial, requested: query, confidence: 'approximate' }

  let best = null
  let bestDistance = Infinity
  for (const s of speakers) {
    const distance = levenshtein(q, s.toLowerCase())
    if (distance < bestDistance) {
      bestDistance = distance
      best = s
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
