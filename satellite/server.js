import Fastify from 'fastify'
import fastifyStatic from '@fastify/static'
import { readFileSync, existsSync } from 'fs'
import { networkInterfaces } from 'os'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import * as sonos from './services/sonos.js'
import * as dirigera from './services/dirigera.js'
import * as whisper from './services/whisper.js'
import * as tts from './services/tts.js'

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

// Set on a satellite that's actually a wall-mounted panel, not just a
// house's local controller — see CLAUDE.md's Station entry. Tells the
// served frontend to render station.js's one-thing-at-a-time shell
// instead of the phone/laptop layout, without relying on a `?station`
// query param baked into however the Pi's kiosk browser is launched.
const IS_STATION = process.env.STATION === 'true'

// Where the built frontend lives — a sibling directory in a repo
// checkout by default, since that's how this is actually run today (see
// Running modes in the design doc). Needs `npm run build` in frontend/
// first; falls back to the manual test page below if that hasn't
// happened, so this still boots usefully for Sonos-only testing without
// a frontend build nearby.
const FRONTEND_DIST = process.env.FRONTEND_DIST_PATH ?? join(__dirname, '../frontend/dist')

// Optional: terminate HTTPS directly in this process, using a cert minted
// via `tailscale cert <hostname>` for this satellite's own MagicDNS name
// (same mechanism the central server's nginx already uses — see
// infra/cloud-init.yaml.tpl). Without these, the satellite listens on
// plain HTTP, which is fine for the controller API (Tailscale already
// encrypts that at the WireGuard layer — see Hub → satellite dispatch in
// the design doc) but breaks browser features that require a secure
// context on a non-localhost origin, notably the Web Speech API used for
// voice capture: it's silently unavailable, not just degraded.
const TLS_CERT_PATH = process.env.TLS_CERT_PATH ?? null
const TLS_KEY_PATH = process.env.TLS_KEY_PATH ?? null
const tlsOptions = TLS_CERT_PATH && TLS_KEY_PATH
  ? { cert: readFileSync(TLS_CERT_PATH), key: readFileSync(TLS_KEY_PATH) }
  : undefined

// Which local services this satellite can currently reach. Sonos is
// always listed (real discovery — see services/sonos.js); Dirigera only
// when a token is actually configured. The hub checks this before
// dispatching an action rather than firing blind into an unsupported
// house.
const CAPABILITIES = [
  'sonos',
  ...(dirigera.isConfigured() ? ['dirigera'] : []),
  ...(whisper.isConfigured() ? ['whisper'] : []),
  ...(tts.isConfigured() ? ['tts'] : []),
]

const testPageHtml = readFileSync(join(__dirname, 'public/index.html'), 'utf8')

// Fastify's default bodyLimit (1 MiB) is tight for a webm/opus recording —
// raised so the ~20-25s hold-to-record cap the frontend enforces (see
// capture.js) always fits with headroom, at typical voice bitrates.
export const app = Fastify({ logger: true, https: tlsOptions, bodyLimit: 5 * 1024 * 1024 })

// MediaRecorder in Chromium produces audio/webm — Fastify only parses
// application/json out of the box, so anything else 415s unless a parser
// is registered. This one just buffers the raw bytes; whisper.js does the
// actual decoding (via ffmpeg) once they reach POST /api/transcribe below.
app.addContentTypeParser('audio/webm', { parseAs: 'buffer' }, (req, body, done) => {
  done(null, body)
})

// ── Runtime config for the frontend ─────────────────────────
// Replaces what used to be a frontend build-time constant (DEFAULT_HOUSE)
// — see designs/satellites.md's House attribution. Generated fresh per
// request from this process's own env vars, not baked in anywhere, so
// the same frontend build works here unmodified.
app.get('/config.json', async () => ({
  defaultHouse: HOUSE_ID,
  backendUrl: BACKEND_URL,
  isStation: IS_STATION,
  // Tells createCaptureInput() (frontend/src/components/capture.js) which
  // voice-input mode to wire the mic button to — 'whisper-stream' only
  // when the separate `whisper` service is configured (WHISPER_URL set —
  // see services/whisper.js and whisper/README.md), 'webspeech' (the
  // existing browser-only mode) everywhere else, unchanged from today.
  // See designs/satellite-hardware.md's "Voice input: three modes".
  voiceMode: whisper.isConfigured() ? 'whisper-stream' : 'webspeech',
  // Tells speech.js (frontend/src/speech.js) which read-aloud engine to
  // use — 'local' only when the separate `tts` service is configured
  // (TTS_URL set — see services/tts.js and tts/README.md), 'browser'
  // (the existing speechSynthesis mode) everywhere else. Worth having:
  // Chromium on Linux (what the kiosk runs) typically ships with no
  // speechSynthesis voices installed at all, so 'browser' can be
  // silently non-functional on a station specifically — see designs/
  // satellite-hardware.md's playback section.
  speechMode: tts.isConfigured() ? 'local' : 'browser',
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
// served at / — useful for exercising /api/search + /api/play (and the
// Dirigera equivalents below) directly without a full capture round-trip.
// Superseded once the real frontend gets its own local now-playing panel
// (see Open questions).
app.get('/test', async (req, reply) => reply.type('text/html').send(testPageHtml))

// ── Controller API ─────────────────────────────────────────
// The central backend (or, for now, the UI above) calls these to reach
// whatever this house needs locally.

app.get('/api/status', async () => ({
  house: HOUSE_ID,
  capabilities: CAPABILITIES,
  ...sonos.getStatus(),
  ...(await dirigera.getStatus()),
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

// Adds an already-resolved track to a speaker's queue instead of playing
// it immediately — same resolved-track/speaker shape as /api/play, same
// "no free text accepted" guarantee. See designs/satellites.md's "Sonos
// queue: now and next".
app.post('/api/queue', async (req, reply) => {
  const { track, speaker } = req.body ?? {}
  if (!track?.title || typeof track.title !== 'string') {
    return reply.code(400).send({ error: 'track.title is required' })
  }
  if (!speaker?.name || typeof speaker.name !== 'string') {
    return reply.code(400).send({ error: 'speaker.name is required' })
  }
  try {
    return await sonos.queueTrack({ track, speaker })
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

// Skip to the next/previous item in the queue — same manual, ungated,
// speaker-scoped shape as /api/pause/resume, only reachable from the
// local controls panel, not the LLM plan system.
app.post('/api/next', async (req, reply) => {
  const { speaker } = req.body ?? {}
  if (!speaker?.name || typeof speaker.name !== 'string') {
    return reply.code(400).send({ error: 'speaker.name is required' })
  }
  try {
    return await sonos.next({ speaker })
  } catch (err) {
    return reply.code(422).send({ error: err.message })
  }
})

app.post('/api/previous', async (req, reply) => {
  const { speaker } = req.body ?? {}
  if (!speaker?.name || typeof speaker.name !== 'string') {
    return reply.code(400).send({ error: 'speaker.name is required' })
  }
  try {
    return await sonos.previous({ speaker })
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

// Transcribes a held-to-record clip for the whisper-stream voice-input
// mode (see designs/satellite-hardware.md) — the frontend's own
// MediaRecorder captures the whole press-to-release clip and POSTs it
// here once, rather than streaming chunks (see the whisper-streaming
// design discussion: Whisper's encoder isn't causal, so re-decoding
// overlapping windows in real time buys nothing for a few seconds of
// push-to-talk speech and costs accuracy). Just proxies to the separate
// `whisper` service (services/whisper.js) — this satellite never runs
// ffmpeg/whisper.cpp itself, see whisper/README.md for why that's a
// distinct, optional image. Always returns 422 rather than 500 on a
// pipeline failure (service unreachable, bad model, empty result) — same
// shape as the other resolve-style endpoints below, so the frontend can
// surface it as a normal capture failure instead of a fetch exception.
app.post('/api/transcribe', async (req, reply) => {
  if (!whisper.isConfigured()) {
    return reply.code(400).send({ error: 'whisper not configured on this satellite (WHISPER_URL unset)' })
  }
  try {
    const text = await whisper.transcribe(req.body)
    return { text }
  } catch (err) {
    return reply.code(422).send({ error: err.message })
  }
})

// Synthesizes speech for local read-aloud — the mirror image of
// /api/transcribe above (text in, audio out instead of audio in, text
// out). speech.js (frontend) calls this instead of the browser's own
// speechSynthesis when GET /config.json's speechMode is 'local'. Just
// proxies to the separate `tts` service (services/tts.js) — this
// satellite never runs Piper itself, see tts/README.md for why that's a
// distinct, optional image. Always returns 422 rather than 500 on a
// pipeline failure (service unreachable, unknown voice, empty text) —
// same shape as /api/transcribe.
app.post('/api/speak', async (req, reply) => {
  if (!tts.isConfigured()) {
    return reply.code(400).send({ error: 'tts not configured on this satellite (TTS_URL unset)' })
  }
  const { text, voice } = req.body ?? {}
  if (typeof text !== 'string' || !text.trim()) {
    return reply.code(400).send({ error: 'text is required' })
  }
  try {
    const wav = await tts.synthesize(text, voice)
    reply.type('audio/wav')
    return wav
  } catch (err) {
    return reply.code(422).send({ error: err.message })
  }
})

// Resolves a room name (and validates action/brightness) without
// changing any device state — same search-then-commit split as
// /api/search + /api/play above. See designs/matter-lighting.md.
app.post('/api/lights/resolve', async (req, reply) => {
  if (!dirigera.isConfigured()) {
    return reply.code(400).send({ error: 'Dirigera not configured on this satellite' })
  }
  const { room, action, brightness, color } = req.body ?? {}
  if (!room || typeof room !== 'string' || !room.trim()) {
    return reply.code(400).send({ error: 'room is required' })
  }
  try {
    return await dirigera.resolveLight({ room: room.trim(), action, brightness, color })
  } catch (err) {
    return reply.code(422).send({ error: err.message })
  }
})

// Commits an already-resolved room/action/brightness (from a prior
// /api/lights/resolve) — no free-text room accepted here, so this can't
// land on a different room than whatever was resolved/approved.
app.post('/api/lights', async (req, reply) => {
  if (!dirigera.isConfigured()) {
    return reply.code(400).send({ error: 'Dirigera not configured on this satellite' })
  }
  const { room, action, brightness, color } = req.body ?? {}
  if (!room?.id || typeof room.id !== 'string') {
    return reply.code(400).send({ error: 'room (a resolved room object) is required' })
  }
  try {
    return await dirigera.commitLight({ room, action, brightness, color })
  } catch (err) {
    return reply.code(422).send({ error: err.message })
  }
})

// ── Start ──────────────────────────────────────────────────
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await app.listen({ port: PORT, host: HOST })
    const scheme = tlsOptions ? 'https' : 'http'
    app.log.info(`satellite "${HOUSE_ID}" listening on ${scheme}://${HOST}:${PORT}`)
    if (!tlsOptions) {
      app.log.warn(
        'No TLS_CERT_PATH/TLS_KEY_PATH set — serving plain HTTP. Voice capture ' +
        '(Web Speech API) needs a secure context and will be unavailable at a ' +
        'non-localhost address. See README.md.'
      )
    }
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
