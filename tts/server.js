import Fastify from 'fastify'
import { fileURLToPath } from 'url'
import { listVoices, synthesize } from './synthesize.js'

// A separate, optional service — mirrors whisper/server.js's shape for
// the opposite direction (text in, audio out instead of audio in, text
// out). See docker-compose.satellite.yml's `tts` entry (its own Compose
// profile, never started unless opted in) and designs/
// satellite-hardware.md's playback design.
const PORT = parseInt(process.env.PORT ?? '5002', 10)
// Only ever called by the satellite process on the same box (both run
// with network_mode: host — see docker-compose.satellite.yml), so this
// deliberately binds to localhost only, same reasoning as whisper/server.js.
const HOST = process.env.HOST ?? '127.0.0.1'

export const app = Fastify({ logger: true })

app.get('/health', async () => ({ ok: true }))

// Lists whatever voices are actually baked into this image (see the
// Dockerfile's PIPER_VOICES build arg) — lets a caller (or a person
// poking at this with curl) discover what POST /synthesize's `voice`
// will accept without reading the Dockerfile.
app.get('/voices', async () => ({ voices: await listVoices() }))

app.post('/synthesize', async (req, reply) => {
  const { text, voice } = req.body ?? {}
  if (typeof text !== 'string' || !text.trim()) {
    return reply.code(400).send({ error: 'text is required' })
  }
  try {
    const wav = await synthesize(text, voice)
    reply.type('audio/wav')
    return wav
  } catch (err) {
    return reply.code(422).send({ error: err.message })
  }
})

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await app.listen({ port: PORT, host: HOST })
    app.log.info(`tts service listening on http://${HOST}:${PORT}`)
  } catch (err) {
    app.log.error(err)
    process.exit(1)
  }
}
