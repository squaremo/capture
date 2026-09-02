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

// Resolves a house to its satellite, confirms it's reachable, actually is
// the house the config claims (catches a stale/mistyped satellites.json
// entry or a satellite started with the wrong HOUSE_ID — never trust the
// config's label over what the satellite itself reports), and supports
// Sonos, then dispatches a play request. Finding the actual best-matching
// track/speaker from the given query is the satellite's job, not ours —
// see designs/satellites.md.
export async function controlPlayback({ houses, house, room, title, artist, album }) {
  const address = houses[house]
  if (!address) throw new Error(`Unknown house: "${house}"`)

  const statusRes = await fetch(`${address}/api/status`)
  if (!statusRes.ok) throw new Error(`Satellite at "${house}" returned ${statusRes.status}`)
  const status = await statusRes.json()
  if (status.house !== house) {
    throw new Error(`Satellite at "${house}"'s address reports house "${status.house}" — config/satellite mismatch`)
  }
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

// Same shape as controlPlayback: resolve house -> satellite, confirm it's
// reachable and actually is the house it claims, confirm it has Dirigera
// configured, then dispatch. Room resolution and the isOn/lightLevel
// two-call quirk are the satellite's job — see designs/matter-lighting.md.
export async function controlLight({ houses, house, room, action, brightness }) {
  const address = houses[house]
  if (!address) throw new Error(`Unknown house: "${house}"`)

  const statusRes = await fetch(`${address}/api/status`)
  if (!statusRes.ok) throw new Error(`Satellite at "${house}" returned ${statusRes.status}`)
  const status = await statusRes.json()
  if (status.house !== house) {
    throw new Error(`Satellite at "${house}"'s address reports house "${status.house}" — config/satellite mismatch`)
  }
  if (!status.capabilities?.includes('dirigera')) {
    throw new Error(`"${house}" has no Dirigera capability configured`)
  }

  const res = await fetch(`${address}/api/lights`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ room, action, brightness }),
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error ?? `Satellite lights request failed: ${res.status}`)
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
// one down satellite doesn't block reporting on the others. houseMismatch
// is a distinct signal from reachable: false — the satellite answered, it
// just isn't the house this config entry claims it is (a config-side bug,
// worth surfacing differently from "just offline" so it's obvious which
// one to go fix).
export async function listSatellites(houses) {
  return Promise.all(
    Object.entries(houses).map(async ([house, address]) => {
      const status = await fetchStatus(address)
      if (status === null) {
        return { house, address, reachable: false, capabilities: [], houseMismatch: false }
      }
      if (status.house !== house) {
        return { house, address, reachable: false, capabilities: [], houseMismatch: true }
      }
      return { house, address, reachable: true, capabilities: status.capabilities ?? [], houseMismatch: false }
    })
  )
}
