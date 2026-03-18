import Fastify from 'fastify'
import { fileURLToPath } from 'url'
import { createItem, getItem, listItems, updateItem } from './db.js'
import { processCapture } from './integrations/claude.js'

const PORT = parseInt(process.env.PORT ?? '3000', 10)
const HOST = process.env.HOST ?? '0.0.0.0'

export const app = Fastify({ logger: true })

// ── Tailscale IP allowlist ─────────────────────────────────
app.addHook('onRequest', async (req, reply) => {
  const subnet = process.env.TAILSCALE_SUBNET
  if (!subnet) return
  const ip = req.ip
  if (!isInSubnet(ip, subnet)) {
    reply.code(403).send({ error: 'Forbidden: Tailscale access only' })
  }
})

// ── CORS (dev) ─────────────────────────────────────────────
app.addHook('onSend', async (req, reply) => {
  reply.header('Access-Control-Allow-Origin', '*')
  reply.header('Access-Control-Allow-Methods', 'GET,POST,PATCH,OPTIONS')
  reply.header('Access-Control-Allow-Headers', 'Content-Type')
})
app.options('*', async () => ({}))

// ── Routes ─────────────────────────────────────────────────

// POST /api/capture — save item as pending, process async
app.post('/api/capture', async (req, reply) => {
  const { text } = req.body ?? {}
  if (!text || typeof text !== 'string' || !text.trim()) {
    return reply.code(400).send({ error: 'text is required' })
  }

  const item = createItem(text.trim())

  // Process in background — don't await
  processCapture(item.text)
    .then(({ status, tags, action_result }) => {
      updateItem(item.id, { status, tags, action_result })
    })
    .catch(err => {
      app.log.error({ err, itemId: item.id }, 'Claude processing failed')
      updateItem(item.id, { status: 'failed', action_result: 'Processing failed.' })
    })

  return reply.code(201).send(item)
})

// GET /api/items — list all items, optional ?status= filter
app.get('/api/items', async (req) => {
  const { status } = req.query ?? {}
  return listItems(status ? { status } : {})
})

// GET /api/items/:id — get single item (used for polling)
app.get('/api/items/:id', async (req, reply) => {
  const item = getItem(req.params.id)
  if (!item) return reply.code(404).send({ error: 'Not found' })
  return item
})

// PATCH /api/items/:id — manual status update
app.patch('/api/items/:id', async (req, reply) => {
  const item = getItem(req.params.id)
  if (!item) return reply.code(404).send({ error: 'Not found' })
  const { status, tags, action_result } = req.body ?? {}
  return updateItem(req.params.id, { status, tags, action_result })
})

// ── Start ──────────────────────────────────────────────────
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await app.listen({ port: PORT, host: HOST })
  } catch (err) {
    app.log.error(err)
    process.exit(1)
  }
}

// ── Helpers ────────────────────────────────────────────────
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
