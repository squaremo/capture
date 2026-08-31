import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DEFAULT_HOUSES_PATH = join(__dirname, '..', 'satellites.json')

// house-id -> satellite base URL, e.g. {"home":"http://localhost:4000"}.
// Deliberately NOT committed config — this is server-local, mutable state
// (which houses exist right now, and where), same volume/pattern as
// DB_PATH. Re-read on every call rather than cached, so hand-editing the
// file takes effect on the next request, no restart needed. Missing or
// malformed file just means no houses known yet, not an error — see
// designs/satellites.md.
export function getHouses() {
  const path = process.env.SATELLITE_HOUSES_PATH ?? DEFAULT_HOUSES_PATH
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return {}
  }
}

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

// A short timeout so one unreachable satellite (laptop switched off, say)
// doesn't hang the whole report — the caller just sees it as unreachable.
async function fetchStatus(address, timeoutMs = 3000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(`${address}/api/status`, { signal: controller.signal })
    return res.ok ? res.json() : null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

// Reports what's configured (houses) and what's actually reachable right
// now (capabilities) — for the UI. Each house is queried independently so
// one down satellite doesn't block reporting on the others.
export async function listSatellites(houses) {
  return Promise.all(
    Object.entries(houses).map(async ([house, address]) => {
      const status = await fetchStatus(address)
      return { house, address, reachable: status !== null, capabilities: status?.capabilities ?? [] }
    })
  )
}
