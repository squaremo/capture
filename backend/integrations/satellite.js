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
// the given capability. Shared by every resolve/commit pair below — each
// needs the same checks, done independently since approval can land a
// while after proposal and either could have changed in between.
async function verifySatellite(houses, house, capability, label) {
  const address = houses[house]
  if (!address) throw new Error(`Unknown house: "${house}"`)

  const statusRes = await fetch(`${address}/api/status`)
  if (!statusRes.ok) throw new Error(`Satellite at "${house}" returned ${statusRes.status}`)
  const status = await statusRes.json()
  if (status.house !== house) {
    throw new Error(`Satellite at "${house}"'s address reports house "${status.house}" — config/satellite mismatch`)
  }
  if (!status.capabilities?.includes(capability)) {
    throw new Error(`"${house}" has no ${label} capability configured`)
  }
  return address
}

// Looks up the actual matching speaker for a room name — doesn't play
// anything. Track search happens directly against Spotify's Web API on
// the backend (see spotify.js) rather than through the satellite: unlike
// speaker resolution, it has no local-network dependency. What
// resolve_playback shows for approval combines both, so a human approves
// the exact resolved particulars, not a raw request that then gets
// (re-)interpreted after the fact. See designs/satellites.md.
export async function resolveSpeaker({ houses, house, room }) {
  const address = await verifySatellite(houses, house, 'sonos', 'Sonos')

  const res = await fetch(`${address}/api/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ room }),
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error ?? `Satellite search failed: ${res.status}`)
  }
  return res.json()
}

// Commits playback of an already-resolved track/speaker (from a prior
// resolvePlayback call) — never re-searches, so this can't land on a
// different result than whatever was approved.
export async function commitPlayback({ houses, house, track, speaker }) {
  const address = await verifySatellite(houses, house, 'sonos', 'Sonos')

  const res = await fetch(`${address}/api/play`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ track, speaker }),
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error ?? `Satellite play failed: ${res.status}`)
  }
  return res.json()
}

// Resolves a room name (and validates action/brightness) without
// changing any device state — same split as resolveSpeaker above. See
// designs/matter-lighting.md.
export async function resolveLight({ houses, house, room, action, brightness }) {
  const address = await verifySatellite(houses, house, 'dirigera', 'Dirigera')

  const res = await fetch(`${address}/api/lights/resolve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ room, action, brightness }),
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error ?? `Satellite light resolve failed: ${res.status}`)
  }
  return res.json()
}

// Commits an already-resolved room/action/brightness (from a prior
// resolveLight call) — no free-text room accepted here, so this can't
// land on a different room than whatever was resolved/approved.
export async function commitLight({ houses, house, room, action, brightness }) {
  const address = await verifySatellite(houses, house, 'dirigera', 'Dirigera')

  const res = await fetch(`${address}/api/lights`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ room, action, brightness }),
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error ?? `Satellite light commit failed: ${res.status}`)
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
