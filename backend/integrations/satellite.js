// Resolves a house to its satellite, confirms it's reachable and supports
// Sonos, then dispatches a play request. Finding the actual best-matching
// track/speaker from the given query is the satellite's job, not ours —
// see designs/satellites.md.
export async function controlPlayback({ houses, house, room, title, artist, album }) {
  const address = houses[house]
  if (!address) throw new Error(`Unknown house: "${house}"`)

  const statusRes = await fetch(`${address}/api/status`)
  if (!statusRes.ok) throw new Error(`Satellite at "${house}" returned ${statusRes.status}`)
  const status = await statusRes.json()
  if (!status.capabilities?.includes('sonos')) {
    throw new Error(`"${house}" has no Sonos capability configured`)
  }

  const res = await fetch(`${address}/api/play`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, artist, album, room }),
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error ?? `Satellite play failed: ${res.status}`)
  }
  return res.json()
}
