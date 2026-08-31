import Fastify from 'fastify'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import * as sonos from './services/sonos.js'

const PORT = parseInt(process.env.PORT ?? '4000', 10)
const HOST = process.env.HOST ?? '0.0.0.0'
const HOUSE_ID = process.env.HOUSE_ID ?? 'unnamed-house'

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

app.get('/api/status', async () => ({ house: HOUSE_ID, ...sonos.getStatus() }))

app.post('/api/play', async (req, reply) => {
  const { track } = req.body ?? {}
  if (!track || typeof track !== 'string' || !track.trim()) {
    return reply.code(400).send({ error: 'track is required' })
  }
  return sonos.play(track.trim())
})

app.post('/api/pause', async () => sonos.pause())

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
