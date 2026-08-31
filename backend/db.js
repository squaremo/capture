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
    created_at   TEXT NOT NULL
  )
`)
// Migrations for existing databases created before these columns existed.
for (const column of ['pending_action', 'plan_progress']) {
  try {
    db.exec(`ALTER TABLE items ADD COLUMN ${column} TEXT`)
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
  }
}

export function createItem(text) {
  const id = newId()
  const created_at = new Date().toISOString()
  db.prepare(
    'INSERT INTO items (id, text, status, tags, action_result, pending_action, plan_progress, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(id, text, 'pending', '[]', null, null, null, created_at)
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

export function updateItem(id, { status, tags, action_result, pending_action, plan_progress }) {
  const fields = []
  const values = []
  if (status !== undefined)         { fields.push('status = ?');         values.push(status) }
  if (tags !== undefined)           { fields.push('tags = ?');           values.push(JSON.stringify(tags)) }
  if (action_result !== undefined)  { fields.push('action_result = ?');  values.push(action_result) }
  if (pending_action !== undefined) { fields.push('pending_action = ?'); values.push(pending_action ? JSON.stringify(pending_action) : null) }
  if (plan_progress !== undefined)  { fields.push('plan_progress = ?');  values.push(plan_progress ? JSON.stringify(plan_progress) : null) }
  if (!fields.length) return getItem(id)
  values.push(id)
  db.prepare(`UPDATE items SET ${fields.join(', ')} WHERE id = ?`).run(...values)
  return getItem(id)
}
