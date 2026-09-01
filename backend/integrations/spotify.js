const TOKEN_URL = 'https://accounts.spotify.com/api/token'
const SEARCH_URL = 'https://api.spotify.com/v1/search'

// Client-credentials has no per-user scope, so one app-level token serves
// every search — cached per client id and refreshed a bit before it
// actually expires rather than waiting for a request to fail.
const tokenCache = new Map()

async function getAccessToken({ clientId, clientSecret }) {
  const cached = tokenCache.get(clientId)
  if (cached && Date.now() < cached.expiresAt) return cached.token

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
    },
    body: 'grant_type=client_credentials',
  })
  if (!res.ok) throw new Error(`Spotify token request failed: ${res.status}`)

  const { access_token, expires_in } = await res.json()
  tokenCache.set(clientId, { token: access_token, expiresAt: Date.now() + (expires_in - 60) * 1000 })
  return access_token
}

// Resolves a rich query into a specific track via Spotify's catalog — a
// plain read against public data, no user context needed, so
// client-credentials covers it fully. Runs on the central backend rather
// than the satellite: unlike Sonos playback, catalog search has no
// local-network dependency (see designs/satellites.md).
export async function searchTrack({ clientId, clientSecret, title, artist, album }) {
  const token = await getAccessToken({ clientId, clientSecret })

  const q = [title, artist && `artist:${artist}`, album && `album:${album}`].filter(Boolean).join(' ')
  const url = new URL(SEARCH_URL)
  url.searchParams.set('q', q)
  url.searchParams.set('type', 'track')
  url.searchParams.set('limit', '1')

  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
  if (!res.ok) throw new Error(`Spotify search failed: ${res.status}`)

  const { tracks } = await res.json()
  const track = tracks?.items?.[0]
  if (!track) throw new Error(`No Spotify track matching "${title}"`)

  return {
    id: track.id,
    title: track.name,
    artist: track.artists?.[0]?.name ?? null,
    album: track.album?.name ?? null,
    // Spotify's search doesn't return a relevance score — reuse the same
    // honesty heuristic the stub it replaces used: a caller-supplied
    // artist narrows the query enough to call it exact, otherwise
    // approximate.
    matchConfidence: artist ? 'exact' : 'approximate',
  }
}
