import Fastify from 'fastify'
import { fileURLToPath } from 'url'
import { transcribe } from './transcribe.js'

// A separate, optional service from the satellite proper — see
// designs/satellite-hardware.md's "Voice input: three modes" and
// docker-compose.satellite.yml's `whisper` entry (Compose profile
// "whisper", never started unless opted in). Kept out of the satellite
// image/process entirely so a satellite with no mic hardware, or one
// that just hasn't opted in yet, never pulls whisper.cpp/ffmpeg/the
// model file at all — only satellite/services/whisper.js's WHISPER_URL
// needs pointing at this once it's running.
const PORT = parseInt(process.env.PORT ?? '5001', 10)
// Only ever called by the satellite process on the same box (both run
// with network_mode: host — see docker-compose.satellite.yml), never
// from the Tailscale-facing side of anything, so this deliberately binds
// to localhost only, tighter than the satellite's own Tailscale-address
// default — there's no reason for this to be reachable from the LAN or
// tailnet at all.
const HOST = process.env.HOST ?? '127.0.0.1'

export const app = Fastify({ logger: true, bodyLimit: 5 * 1024 * 1024 })

// MediaRecorder in Chromium produces audio/webm — Fastify only parses
// application/json out of the box, so anything else 415s unless a parser
// is registered. This one just buffers the raw bytes; transcribe.js does
// the actual decoding (via ffmpeg) below.
app.addContentTypeParser('audio/webm', { parseAs: 'buffer' }, (req, body, done) => {
  done(null, body)
})

app.get('/health', async () => ({ ok: true }))

app.post('/transcribe', async (req, reply) => {
  try {
    const text = await transcribe(req.body)
    return { text }
  } catch (err) {
    return reply.code(422).send({ error: err.message })
  }
})

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await app.listen({ port: PORT, host: HOST })
    app.log.info(`whisper service listening on http://${HOST}:${PORT}`)
  } catch (err) {
    app.log.error(err)
    process.exit(1)
  }
}
