import Fastify from 'fastify'
import { fileURLToPath } from 'url'
import { createItem, getItem, listItems, updateItem, createFavourite, getFavourite, listFavourites, deleteFavourite } from './db.js'
import { processCapture, executeAction, runProgram, getFormFields, getFavouriteLabel, LINEAR_ENABLED, SATELLITES_ENABLED, SPOTIFY_ENABLED } from './integrations/claude.js'
import { listSatellites, getHouses } from './integrations/satellite.js'
import { BACKEND_VERSION, getConfigVersion } from './version.js'

const PORT = parseInt(process.env.PORT ?? '3000', 10)
const HOST = process.env.HOST ?? '0.0.0.0'

export const app = Fastify({ logger: true, trustProxy: true })

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
  reply.header('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS')
  reply.header('Access-Control-Allow-Headers', 'Content-Type')
})
app.options('*', async () => ({}))

// ── Routes ─────────────────────────────────────────────────

// Attaches the editable "form" (see getFormFields() in claude.js) derived
// from a record's plan_steps — the same shape for an item's proposed/
// executed action and a favourite's frozen one, since both are just "a
// program" now. Empty when there's no plan_steps yet (a still-pending
// item) or none was ever recorded (a favourite saved before this existed).
function withFormFields(record) {
  return { ...record, form_fields: getFormFields(record.plan_steps) }
}

// POST /api/capture — save item as pending, process async
app.post('/api/capture', async (req, reply) => {
  const { text, house } = req.body ?? {}
  if (!text || typeof text !== 'string' || !text.trim()) {
    return reply.code(400).send({ error: 'text is required' })
  }

  const item = createItem(text.trim(), house ?? null)

  // Process in background — don't await
  const planProgress = []
  processCapture(item.text, {
    house: item.house,
    onStep: (step) => {
      planProgress.push(step)
      updateItem(item.id, { plan_progress: planProgress })
    },
  })
    .then(({ status, tags, action_result, pending_action, plan_steps }) => {
      updateItem(item.id, { status, tags, action_result, pending_action: pending_action ?? null, plan_steps })
    })
    .catch(err => {
      app.log.error({ err, itemId: item.id }, 'Claude processing failed')
      updateItem(item.id, { status: 'failed', action_result: 'Processing failed.' })
    })

  return reply.code(201).send(withFormFields(item))
})

// POST /api/items/:id/approve — run a proposed action. An optional
// { overrides: { stepId: { field: value } } } body lets the human tweak
// the plan's literal inputs (shown as a form — see getFormFields()) before
// it fires: item.plan_steps is re-run through runProgram() with those
// overrides applied, so e.g. changing resolve_playback's room re-resolves
// a real speaker rather than just editing display text. Approving with no
// overrides body behaves exactly as before — the originally resolved
// pending_action runs unchanged.
app.post('/api/items/:id/approve', async (req, reply) => {
  const item = getItem(req.params.id)
  if (!item) return reply.code(404).send({ error: 'Not found' })
  if (item.status !== 'awaiting_approval' || !item.pending_action) {
    return reply.code(409).send({ error: 'Item has no pending action to approve' })
  }

  const overrides = req.body?.overrides
  let pending_action = item.pending_action
  let plan_steps
  let tags

  if (overrides && item.plan_steps?.length) {
    try {
      const resolved = await runProgram(item.plan_steps, { house: item.house, overrides })
      if (resolved.status !== 'awaiting_approval') {
        return reply.code(422).send({ error: 'Edited inputs no longer resolve to an action' })
      }
      ;({ pending_action, plan_steps, tags } = resolved)
    } catch (err) {
      return reply.code(422).send({ error: err.message })
    }
  }

  try {
    const { status, action_result } = await executeAction(pending_action)
    // executed_action persists the exact { tool, input } that actually ran
    // (unlike pending_action, which is cleared here) — it's what makes the
    // item favouritable afterwards. Only set on success: an item whose
    // action failed never actually did anything, so it has nothing to
    // replay.
    return withFormFields(updateItem(item.id, { status, action_result, pending_action: null, executed_action: pending_action, plan_steps, tags }))
  } catch (err) {
    app.log.error({ err, itemId: item.id }, 'Approved action failed')
    return withFormFields(updateItem(item.id, { status: 'failed', action_result: 'Action failed.', pending_action: null }))
  }
})

// POST /api/items/:id/veto — decline a proposed action
app.post('/api/items/:id/veto', async (req, reply) => {
  const item = getItem(req.params.id)
  if (!item) return reply.code(404).send({ error: 'Not found' })
  if (item.status !== 'awaiting_approval' || !item.pending_action) {
    return reply.code(409).send({ error: 'Item has no pending action to veto' })
  }

  return withFormFields(updateItem(item.id, { status: 'vetoed', action_result: 'Cancelled.', pending_action: null }))
})

// POST /api/items/:id/favourite — save a completed item's executed action
// as a replayable favourite. Only items that actually ran an acting-tool
// call (status 'acted', with executed_action recorded on approval) qualify
// — terminal items (triaged/reminder/urgent) never had a tool call to
// replay, and a vetoed/failed item never executed one either.
//
// label defaults to the item's action_result, but a tool can override
// that via favouriteLabel() in TOOL_REGISTRY (see getFavouriteLabel() in
// claude.js) when its result string bakes in a value the form lets you
// re-tune each replay — control_light's brightness, say — which would
// otherwise freeze a label that goes stale the first time it's run
// differently.
app.post('/api/items/:id/favourite', async (req, reply) => {
  const item = getItem(req.params.id)
  if (!item) return reply.code(404).send({ error: 'Not found' })
  if (item.status !== 'acted' || !item.executed_action) {
    return reply.code(409).send({ error: 'Item has no executed action to favourite' })
  }
  const favourite = createFavourite({
    label: getFavouriteLabel(item.executed_action.tool, item.executed_action.input, item.action_result),
    tool: item.executed_action.tool,
    input: item.executed_action.input,
    tags: item.tags,
    plan_steps: item.plan_steps,
    house: item.house,
  })
  return reply.code(201).send(withFormFields(favourite))
})

// GET /api/favourites — list saved favourites
app.get('/api/favourites', async () => listFavourites().map(withFormFields))

// DELETE /api/favourites/:id — remove a favourite
app.delete('/api/favourites/:id', async (req, reply) => {
  if (!getFavourite(req.params.id)) return reply.code(404).send({ error: 'Not found' })
  deleteFavourite(req.params.id)
  return { ok: true }
})

// POST /api/favourites/:id/run — replay a favourite's saved program. With
// no body (or a favourite saved before plan_steps existed), this replays
// the exact frozen { tool, input } call recorded at favourite time — no
// re-planning, no re-resolution, and no new approval step: the human
// already approved this exact resolved action once, when it was first
// favourited. An optional { overrides: { stepId: { field: value } } } body
// instead re-runs the favourite's saved plan_steps through runProgram()
// with those fields edited — e.g. a different track/room — re-resolving
// for real (a fresh Spotify/speaker lookup) rather than only ever
// replaying frozen values; approval is still skipped, same reasoning as
// the frozen path. Either way, creates a new item so the replay shows up
// in the inbox like any other capture (audit trail, consistent with
// everything else the app does), resolved directly to acted/failed rather
// than passing through pending/awaiting_approval.
app.post('/api/favourites/:id/run', async (req, reply) => {
  const favourite = getFavourite(req.params.id)
  if (!favourite) return reply.code(404).send({ error: 'Not found' })

  const overrides = req.body?.overrides
  let tool = favourite.tool
  let input = favourite.input
  let tags = favourite.tags

  if (overrides && favourite.plan_steps?.length) {
    try {
      const resolved = await runProgram(favourite.plan_steps, { house: favourite.house, overrides })
      if (resolved.status !== 'awaiting_approval') {
        return reply.code(422).send({ error: 'Edited inputs no longer resolve to an action' })
      }
      ;({ tool, input } = resolved.pending_action)
      tags = resolved.tags
    } catch (err) {
      return reply.code(422).send({ error: err.message })
    }
  }

  const item = createItem(favourite.label)
  try {
    const { status, action_result } = await executeAction({ tool, input })
    return withFormFields(updateItem(item.id, {
      status,
      action_result,
      tags,
      executed_action: { tool, input },
      plan_steps: favourite.plan_steps,
    }))
  } catch (err) {
    app.log.error({ err, favouriteId: favourite.id }, 'Favourite replay failed')
    return withFormFields(updateItem(item.id, { status: 'failed', action_result: 'Replay failed.' }))
  }
})

// GET /api/version — backend/config revisions and enabled integrations,
// for debugging and confirming a deploy landed
app.get('/api/version', async () => ({
  backend: BACKEND_VERSION,
  config: getConfigVersion(),
  integrations: { linear: LINEAR_ENABLED, satellite: SATELLITES_ENABLED, spotify: SPOTIFY_ENABLED },
}))

// GET /api/satellites — configured houses and their live capabilities,
// for the UI (an unreachable satellite just reports reachable: false).
// Always reads the current houses file, regardless of SATELLITES_ENABLED
// (a startup snapshot) — this endpoint should reflect hand-edits to the
// file immediately, not just after a restart.
app.get('/api/satellites', async () => listSatellites(getHouses()))

// GET /api/items — list all items, optional ?status= filter
app.get('/api/items', async (req) => {
  const { status } = req.query ?? {}
  return listItems(status ? { status } : {}).map(withFormFields)
})

// GET /api/items/:id — get single item (used for polling)
app.get('/api/items/:id', async (req, reply) => {
  const item = getItem(req.params.id)
  if (!item) return reply.code(404).send({ error: 'Not found' })
  return withFormFields(item)
})

// PATCH /api/items/:id — manual status update
app.patch('/api/items/:id', async (req, reply) => {
  const item = getItem(req.params.id)
  if (!item) return reply.code(404).send({ error: 'Not found' })
  const { status, tags, action_result } = req.body ?? {}
  return withFormFields(updateItem(req.params.id, { status, tags, action_result }))
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
