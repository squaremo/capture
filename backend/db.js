import Database from 'better-sqlite3'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DB_PATH = process.env.DB_PATH ?? join(__dirname, 'capture.db')

const db = new Database(DB_PATH)

db.exec(`
  CREATE TABLE IF NOT EXISTS items (
    id           TEXT PRIMARY KEY,
    text         TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'pending',
    tags         TEXT NOT NULL DEFAULT '[]',
    action_result TEXT,
    pending_action TEXT,
    plan_progress TEXT,
    house        TEXT,
    executed_action TEXT,
    plan_steps   TEXT,
    recalled_checklist_id TEXT,
    created_at   TEXT NOT NULL
  )
`)
// Migrations for columns added after the table already existed elsewhere.
for (const column of ['pending_action TEXT', 'plan_progress TEXT', 'house TEXT', 'executed_action TEXT', 'plan_steps TEXT', 'recalled_checklist_id TEXT']) {
  try {
    db.exec(`ALTER TABLE items ADD COLUMN ${column}`)
  } catch (err) {
    if (!/duplicate column name/.test(err.message)) throw err
  }
}

// One row per favourited action. Alongside the frozen { tool, input } call
// (see executed_action above) — used for a plain, no-questions-asked
// replay — a favourite also keeps plan_steps: the literal program
// (readonly + acting steps, with their original args) that produced it, plus
// the house it ran in. That's what lets POST /api/favourites/:id/run take
// edited inputs and re-resolve through the real pipeline (e.g. re-searching
// Spotify for a different track) instead of only ever replaying frozen
// values. See runProgram()/getFormFields() in claude.js.
db.exec(`
  CREATE TABLE IF NOT EXISTS favourites (
    id         TEXT PRIMARY KEY,
    label      TEXT NOT NULL,
    tool       TEXT NOT NULL,
    input      TEXT NOT NULL,
    tags       TEXT NOT NULL DEFAULT '[]',
    plan_steps TEXT,
    house      TEXT,
    created_at TEXT NOT NULL
  )
`)
for (const column of ['plan_steps TEXT', 'house TEXT']) {
  try {
    db.exec(`ALTER TABLE favourites ADD COLUMN ${column}`)
  } catch (err) {
    if (!/duplicate column name/.test(err.message)) throw err
  }
}

function newId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
}

function parseItem(row) {
  return {
    ...row,
    tags: JSON.parse(row.tags),
    pending_action: row.pending_action ? JSON.parse(row.pending_action) : null,
    plan_progress: row.plan_progress ? JSON.parse(row.plan_progress) : [],
    executed_action: row.executed_action ? JSON.parse(row.executed_action) : null,
    plan_steps: row.plan_steps ? JSON.parse(row.plan_steps) : [],
  }
}

export function createItem(text, house = null) {
  const id = newId()
  const created_at = new Date().toISOString()
  db.prepare(
    'INSERT INTO items (id, text, status, tags, action_result, pending_action, plan_progress, house, executed_action, plan_steps, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(id, text, 'pending', '[]', null, null, null, house, null, null, created_at)
  return getItem(id)
}

export function getItem(id) {
  const row = db.prepare('SELECT * FROM items WHERE id = ?').get(id)
  return row ? parseItem(row) : null
}

export function listItems({ status } = {}) {
  const rows = status
    ? db.prepare('SELECT * FROM items WHERE status = ? ORDER BY created_at DESC').all(status)
    : db.prepare('SELECT * FROM items ORDER BY created_at DESC').all()
  return rows.map(parseItem)
}

export function updateItem(id, { status, tags, action_result, pending_action, plan_progress, executed_action, plan_steps, text, recalled_checklist_id }) {
  const fields = []
  const values = []
  if (text !== undefined)           { fields.push('text = ?');           values.push(text) }
  if (status !== undefined)         { fields.push('status = ?');         values.push(status) }
  if (tags !== undefined)           { fields.push('tags = ?');           values.push(JSON.stringify(tags)) }
  if (action_result !== undefined)  { fields.push('action_result = ?');  values.push(action_result) }
  if (pending_action !== undefined) { fields.push('pending_action = ?'); values.push(pending_action ? JSON.stringify(pending_action) : null) }
  if (plan_progress !== undefined)  { fields.push('plan_progress = ?');  values.push(plan_progress ? JSON.stringify(plan_progress) : null) }
  if (executed_action !== undefined) { fields.push('executed_action = ?'); values.push(executed_action ? JSON.stringify(executed_action) : null) }
  if (plan_steps !== undefined)     { fields.push('plan_steps = ?');     values.push(plan_steps ? JSON.stringify(plan_steps) : null) }
  if (recalled_checklist_id !== undefined) { fields.push('recalled_checklist_id = ?'); values.push(recalled_checklist_id) }
  if (!fields.length) return getItem(id)
  values.push(id)
  db.prepare(`UPDATE items SET ${fields.join(', ')} WHERE id = ?`).run(...values)
  return getItem(id)
}

// ── Favourites ────────────────────────────────────────────
// A favourite freezes one already-executed { tool, input } call (see
// executed_action above) under a label, for one-click replay with no
// re-planning and no re-approval — see POST /api/favourites/:id/run.

function parseFavourite(row) {
  return {
    ...row,
    input: JSON.parse(row.input),
    tags: JSON.parse(row.tags),
    plan_steps: row.plan_steps ? JSON.parse(row.plan_steps) : [],
  }
}

export function createFavourite({ label, tool, input, tags = [], plan_steps = null, house = null }) {
  const id = newId()
  const created_at = new Date().toISOString()
  db.prepare(
    'INSERT INTO favourites (id, label, tool, input, tags, plan_steps, house, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(id, label, tool, JSON.stringify(input), JSON.stringify(tags), plan_steps ? JSON.stringify(plan_steps) : null, house, created_at)
  return getFavourite(id)
}

export function getFavourite(id) {
  const row = db.prepare('SELECT * FROM favourites WHERE id = ?').get(id)
  return row ? parseFavourite(row) : null
}

export function listFavourites() {
  return db.prepare('SELECT * FROM favourites ORDER BY created_at DESC').all().map(parseFavourite)
}

// Lets a favourite's defaults track its last real run — see
// POST /api/favourites/:id/run in server.js. A plain "run" persists
// unchanged values (a no-op write); an edited-and-run becomes the new
// default for next time, and label is regenerated from those values
// (getFavouriteLabel() in claude.js) so it never freezes a value the form
// later replays differently.
export function updateFavourite(id, { label, tool, input, tags, plan_steps }) {
  const fields = []
  const values = []
  if (label !== undefined)      { fields.push('label = ?');      values.push(label) }
  if (tool !== undefined)       { fields.push('tool = ?');       values.push(tool) }
  if (input !== undefined)      { fields.push('input = ?');      values.push(JSON.stringify(input)) }
  if (tags !== undefined)       { fields.push('tags = ?');       values.push(JSON.stringify(tags)) }
  if (plan_steps !== undefined) { fields.push('plan_steps = ?'); values.push(plan_steps ? JSON.stringify(plan_steps) : null) }
  if (!fields.length) return getFavourite(id)
  values.push(id)
  db.prepare(`UPDATE favourites SET ${fields.join(', ')} WHERE id = ?`).run(...values)
  return getFavourite(id)
}

export function deleteFavourite(id) {
  db.prepare('DELETE FROM favourites WHERE id = ?').run(id)
}
