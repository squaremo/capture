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
    created_at   TEXT NOT NULL
  )
`)

function newId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
}

function parseItem(row) {
  return { ...row, tags: JSON.parse(row.tags) }
}

export function createItem(text) {
  const id = newId()
  const created_at = new Date().toISOString()
  db.prepare(
    'INSERT INTO items (id, text, status, tags, action_result, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(id, text, 'pending', '[]', null, created_at)
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

export function updateItem(id, { status, tags, action_result }) {
  const fields = []
  const values = []
  if (status !== undefined)        { fields.push('status = ?');        values.push(status) }
  if (tags !== undefined)          { fields.push('tags = ?');           values.push(JSON.stringify(tags)) }
  if (action_result !== undefined) { fields.push('action_result = ?'); values.push(action_result) }
  if (!fields.length) return getItem(id)
  values.push(id)
  db.prepare(`UPDATE items SET ${fields.join(', ')} WHERE id = ?`).run(...values)
  return getItem(id)
}
