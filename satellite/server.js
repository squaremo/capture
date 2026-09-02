import Fastify from 'fastify'
import fastifyStatic from '@fastify/static'
import { readFileSync, existsSync } from 'fs'
import { networkInterfaces } from 'os'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import * as sonos from './services/sonos.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

const PORT = parseInt(process.env.PORT ?? '4000', 10)
// Only the backend ever calls this, over Tailscale — bind to the tailnet
// interface specifically rather than 0.0.0.0, so the controller isn't
// reachable from the LAN or any other interface on the box. Falls back to
// localhost-only (not 0.0.0.0) when no Tailscale interface is up, e.g. for
// local dev — still restrictive, never "listen everywhere" by default.
// HOST always overrides, if you really need something else. Note this
// now also gates who can load the UI below, not just the controller API
// — see designs/satellites.md's Satellite-served frontend section.
const HOST = process.env.HOST ?? findTailscaleAddress() ?? '127.0.0.1'
const HOUSE_ID = process.env.HOUSE_ID ?? 'unnamed-house'

// Where the served frontend should send capture/inbox calls — an
// absolute origin, since the frontend is no longer same-origin with the
// central backend once this satellite is the one serving it. Required
// for the real UI to actually work here; left unset, the served
// frontend falls back to a relative /api (which 404s on this server) —
// see /config.json below.
const BACKEND_URL = process.env.BACKEND_URL ?? null

// Where the built frontend lives — a sibling directory in a repo
// checkout by default, since that's how this is actually run today (see
// Running modes in the design doc). Needs `npm run build` in frontend/
// first; falls back to the manual test page below if that hasn't
// happened, so this still boots usefully for Sonos-only testing without
// a frontend build nearby.
const FRONTEND_DIST = process.env.FRONTEND_DIST_PATH ?? join(__dirname, '../frontend/dist')

// Which local services this satellite can currently reach. Only Sonos is
// wired up so far; the hub checks this before dispatching an action rather
// than firing blind into an unsupported house.
const CAPABILITIES = ['sonos']

const testPageHtml = readFileSync(join(__dirname, 'public/index.html'), 'utf8')

export const app = Fastify({ logger: true })

// ── Runtime config for the frontend ─────────────────────────
// Replaces what used to be a frontend build-time constant (DEFAULT_HOUSE)
// — see designs/satellites.md's House attribution. Generated fresh per
// request from this process's own env vars, not baked in anywhere, so
// the same frontend build works here unmodified.
app.get('/config.json', async () => ({
  defaultHouse: HOUSE_ID,
  backendUrl: BACKEND_URL,
}))

// ── UI ─────────────────────────────────────────────────────
// The real capture frontend, once built — same build as everywhere else,
// configured via /config.json above rather than anything satellite-
// specific baked into it.
if (existsSync(join(FRONTEND_DIST, 'index.html'))) {
  app.register(fastifyStatic, { root: FRONTEND_DIST })
} else {
  app.log.warn(
    `No frontend build found at ${FRONTEND_DIST} — set FRONTEND_DIST_PATH ` +
    'or run "npm run build" in frontend/. Serving the manual test page at / instead.'
  )
  app.get('/', async (req, reply) => reply.type('text/html').send(testPageHtml))
}
// Kept at a fixed path regardless of whether the real frontend is being
// served at / — useful for exercising /api/search + /api/play directly
// without a full capture round-trip. Superseded once the real frontend
// gets its own local now-playing panel (see Open questions).
app.get('/test', async (req, reply) => reply.type('text/html').send(testPageHtml))

// ── Controller API ─────────────────────────────────────────
// The central backend (or, for now, the UI above) calls these to reach
// whatever this house needs locally. Only Sonos is wired up so far.

app.get('/api/status', async () => ({
  house: HOUSE_ID,
  capabilities: CAPABILITIES,
  ...sonos.getStatus(),
}))

// Resolves a room name into a specific speaker, without playing anything
// — the caller (the hub, or the UI below) already has a track resolved
// via Spotify by this point (see designs/satellites.md), and shows this
// exact speaker match alongside it for approval before ever calling
// /api/play.
app.post('/api/search', async (req, reply) => {
  const { room } = req.body ?? {}
  try {
    return await sonos.matchRoom(typeof room === 'string' ? room.trim() : undefined)
  } catch (err) {
    return reply.code(422).send({ error: err.message })
  }
})

// Commits playback of an already-resolved track/speaker (from a prior
// /api/search) — deliberately does not accept a free-text query, so this
// can't land on a different match than whatever was searched/approved.
app.post('/api/play', async (req, reply) => {
  const { track, speaker } = req.body ?? {}
  if (!track?.title || typeof track.title !== 'string') {
    return reply.code(400).send({ error: 'track.title is required' })
  }
  if (!speaker?.name || typeof speaker.name !== 'string') {
    return reply.code(400).send({ error: 'speaker.name is required' })
  }
  try {
    return await sonos.play({ track, speaker })
  } catch (err) {
    return reply.code(422).send({ error: err.message })
  }
})

// Needs a speaker now that this controls real, possibly-multiple
// hardware — there's no single "the system" to pause.
app.post('/api/pause', async (req, reply) => {
  const { speaker } = req.body ?? {}
  if (!speaker?.name || typeof speaker.name !== 'string') {
    return reply.code(400).send({ error: 'speaker.name is required' })
  }
  try {
    return await sonos.pause({ speaker })
  } catch (err) {
    return reply.code(422).send({ error: err.message })
  }
})

// Continues a paused speaker — distinct from /api/play, which always
// reloads a track from the start; this just resumes wherever it stopped.
app.post('/api/resume', async (req, reply) => {
  const { speaker } = req.body ?? {}
  if (!speaker?.name || typeof speaker.name !== 'string') {
    return reply.code(400).send({ error: 'speaker.name is required' })
  }
  try {
    return await sonos.resume({ speaker })
  } catch (err) {
    return reply.code(422).send({ error: err.message })
  }
})

// Same manual, speaker-scoped shape as /api/pause — local control only,
// never proposed/approved by the LLM plan system.
app.post('/api/volume', async (req, reply) => {
  const { speaker, level } = req.body ?? {}
  if (!speaker?.name || typeof speaker.name !== 'string') {
    return reply.code(400).send({ error: 'speaker.name is required' })
  }
  if (typeof level !== 'number' || !Number.isFinite(level)) {
    return reply.code(400).send({ error: 'level (a number, 0-100) is required' })
  }
  try {
    return await sonos.setVolume({ speaker, level })
  } catch (err) {
    return reply.code(422).send({ error: err.message })
  }
})

// ── Start ──────────────────────────────────────────────────
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await app.listen({ port: PORT, host: HOST })
    app.log.info(`satellite "${HOUSE_ID}" listening on ${HOST}:${PORT}`)
  } catch (err) {
    app.log.error(err)
    process.exit(1)
  }
}

// ── Helpers ────────────────────────────────────────────────
// Same 100.64.0.0/10 (Tailscale's CGNAT range) check the backend already
// uses for its own allowlist — here applied to the box's own interfaces
// rather than an incoming request's IP.
function findTailscaleAddress() {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family === 'IPv4' && isInSubnet(addr.address, '100.64.0.0/10')) {
        return addr.address
      }
    }
  }
  return null
}

function isInSubnet(ip, subnet) {
  try {
    const [subnetIp, prefixLen] = subnet.split('/')
    const prefix = parseInt(prefixLen, 10)
    const mask = ~((1 << (32 - prefix)) - 1) >>> 0
    return (ipToInt(ip) & mask) === (ipToInt(subnetIp) & mask)
  } catch {
    return false
  }
}

function ipToInt(ip) {
  return ip.split('.').reduce((acc, oct) => (acc << 8) + parseInt(oct, 10), 0) >>> 0
}
