import Fastify from 'fastify'
import { readFileSync } from 'fs'
import { networkInterfaces } from 'os'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import * as sonos from './services/sonos.js'

const PORT = parseInt(process.env.PORT ?? '4000', 10)
// Only the backend ever calls this, over Tailscale — bind to the tailnet
// interface specifically rather than 0.0.0.0, so the controller isn't
// reachable from the LAN or any other interface on the box. Falls back to
// localhost-only (not 0.0.0.0) when no Tailscale interface is up, e.g. for
// local dev — still restrictive, never "listen everywhere" by default.
// HOST always overrides, if you really need something else.
const HOST = process.env.HOST ?? findTailscaleAddress() ?? '127.0.0.1'
const HOUSE_ID = process.env.HOUSE_ID ?? 'unnamed-house'

// Which local services this satellite can currently reach. Only Sonos is
// wired up so far; the hub checks this before dispatching an action rather
// than firing blind into an unsupported house.
const CAPABILITIES = ['sonos']

const __dirname = dirname(fileURLToPath(import.meta.url))
const indexHtml = readFileSync(join(__dirname, 'public/index.html'), 'utf8')

export const app = Fastify({ logger: true })

// ── UI ─────────────────────────────────────────────────────
app.get('/', async (req, reply) => {
  reply.type('text/html').send(indexHtml)
})

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
