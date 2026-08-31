import Fastify from 'fastify'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import * as sonos from './services/sonos.js'

const PORT = parseInt(process.env.PORT ?? '4000', 10)
const HOST = process.env.HOST ?? '0.0.0.0'
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

app.post('/api/play', async (req, reply) => {
  const { title, artist, album, room } = req.body ?? {}
  if (!title || typeof title !== 'string' || !title.trim()) {
    return reply.code(400).send({ error: 'title is required' })
  }
  return sonos.play({
    title: title.trim(),
    artist: typeof artist === 'string' ? artist.trim() : undefined,
    album: typeof album === 'string' ? album.trim() : undefined,
    room: typeof room === 'string' ? room.trim() : undefined,
  })
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
