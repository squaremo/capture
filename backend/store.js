import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import yaml from 'js-yaml'
import { resolveEnv } from './secrets.js'

const execFileAsync = promisify(execFile)

const __dirname = dirname(fileURLToPath(import.meta.url))
const DATA_PATH = process.env.DATA_PATH ?? join(__dirname, 'data')
const ITEMS_DIR = join(DATA_PATH, 'items')
const FAVOURITES_DIR = join(DATA_PATH, 'favourites')

for (const dir of [ITEMS_DIR, FAVOURITES_DIR]) mkdirSync(dir, { recursive: true })

// See designs/file-backed-storage.md. Local commits happen whenever
// DATA_PATH is already a git repo — this module never runs `git init`
// itself; bootstrapping the repo (a one-time `git init` in DATA_PATH, plus
// `git config user.name`/`user.email` if you want something other than
// the defaults below) is an operational step, same tier as creating
// /opt/capture/data itself. That also means most tests can point
// DATA_PATH at a plain temp directory and never touch the real `git`
// binary at all — see test/setup.js.
const GIT_ENABLED = existsSync(join(DATA_PATH, '.git'))

const GIT_REMOTE_URL = process.env.GIT_REMOTE_URL
const GIT_REMOTE_TOKEN = await resolveEnv('GIT_REMOTE_TOKEN')
const GIT_PUSH_ENABLED = GIT_ENABLED && Boolean(GIT_REMOTE_URL && GIT_REMOTE_TOKEN)

const GIT_AUTHOR_NAME = process.env.GIT_AUTHOR_NAME ?? 'capture'
const GIT_AUTHOR_EMAIL = process.env.GIT_AUTHOR_EMAIL ?? 'capture@localhost'

async function git(args) {
  return execFileAsync('git', args, {
    cwd: DATA_PATH,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME, GIT_AUTHOR_EMAIL,
      GIT_COMMITTER_NAME: GIT_AUTHOR_NAME, GIT_COMMITTER_EMAIL: GIT_AUTHOR_EMAIL,
    },
  })
}

// Embeds the token directly in the push URL argument rather than ever
// running `git remote add` — that would write the token into
// .git/config in plaintext, sitting on disk indefinitely. This way it
// only exists in one process's argument list for the moment the push
// takes. See designs/file-backed-storage.md's Config section.
function remoteWithToken() {
  return GIT_REMOTE_URL.replace(/^https:\/\//, `https://${GIT_REMOTE_TOKEN}@`)
}

// Stages and commits one file's current on-disk state (the caller has
// already written or deleted it) — one commit per meaningful write, no
// batching, so the commit log itself is the audit trail. A commit
// failure is real (it means the write silently isn't in that trail) and
// propagates; a push failure isn't — the note is already safely
// committed locally the instant `git commit` returns, and a remote
// being briefly unreachable shouldn't fail the request that triggered
// the write, so that's only logged.
async function stageAndCommit(relPath, message, { deleted = false } = {}) {
  if (!GIT_ENABLED) return
  await git([deleted ? 'rm' : 'add', relPath])
  try {
    await git(['commit', '-m', message])
  } catch (err) {
    // Nothing actually changed (e.g. an update that wrote identical
    // content) — not a real error, just nothing to record this time.
    if (!/nothing to commit/.test(err.stdout ?? '')) throw err
    return
  }
  if (GIT_PUSH_ENABLED) {
    try {
      await git(['push', remoteWithToken(), 'HEAD:main'])
    } catch (err) {
      console.error('git push failed (commit is safe locally):', err.message)
    }
  }
}

function newId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
}

// Short, one-line git commit subjects — long capture text gets folded to
// one line and cut, matching normal git-log-readability convention.
function truncate(text, max = 72) {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine
}

function relItemPath(id) { return join('items', `${id}.md`) }
function relFavouritePath(id) { return join('favourites', `${id}.md`) }
function itemPath(id) { return join(ITEMS_DIR, `${id}.md`) }
function favouritePath(id) { return join(FAVOURITES_DIR, `${id}.md`) }

// One markdown file per row: YAML frontmatter for every structured field,
// body for the one field that's actually prose (an item's captured
// text — favourites have no body, just frontmatter). JSON_SCHEMA is used
// for both dump and load rather than js-yaml's default (permissive) core
// schema — the default schema auto-detects ISO-8601-looking strings as
// YAML timestamps and loads them back as JS Date objects instead of
// strings, which would silently break created_at (e.g. listItems' sort
// calls .localeCompare() on it, which Date objects don't have). Content
// here is really just "JSON with YAML syntax," so the strict JSON-
// compatible schema is the correct, predictable choice, not a workaround.
const YAML_OPTS = { schema: yaml.JSON_SCHEMA }
const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/

function readNote(path) {
  if (!existsSync(path)) return null
  const raw = readFileSync(path, 'utf8')
  const match = raw.match(FRONTMATTER_RE)
  if (!match) throw new Error(`Malformed note file (missing frontmatter): ${path}`)
  return { frontmatter: yaml.load(match[1], YAML_OPTS) ?? {}, body: match[2].replace(/\n$/, '') }
}

function writeNote(path, frontmatter, body = '') {
  writeFileSync(path, `---\n${yaml.dump(frontmatter, YAML_OPTS)}---\n${body}\n`)
}

// A small in-process write queue, keyed by id: recovers the atomic-
// single-writer guarantee SQLite gave for free. Without it, two
// near-simultaneous updates to the same item (e.g. a plan_progress tick
// landing while /approve is resolving) could read-modify-write out of
// order and silently lose one of them.
const writeQueues = new Map()

function serialize(id, fn) {
  const prev = writeQueues.get(id) ?? Promise.resolve()
  const result = prev.then(fn, fn)
  writeQueues.set(id, result.then(() => {}, () => {}))
  return result
}

// ── Items ─────────────────────────────────────────────────

const ITEM_UPDATE_KEYS = [
  'status', 'tags', 'action_result', 'pending_action', 'plan_progress',
  'executed_action', 'plan_steps', 'text', 'recalled_checklist_id', 'shopping_list_id',
]

export async function createItem(text, house = null) {
  const id = newId()
  const created_at = new Date().toISOString()
  const frontmatter = {
    status: 'pending', tags: [], action_result: null, pending_action: null,
    plan_progress: [], house, executed_action: null, plan_steps: [],
    recalled_checklist_id: null, shopping_list_id: null, created_at,
  }
  writeNote(itemPath(id), frontmatter, text)
  await stageAndCommit(relItemPath(id), `Capture: ${truncate(text)}`)
  return getItem(id)
}

export function getItem(id) {
  const note = readNote(itemPath(id))
  return note ? { id, ...note.frontmatter, text: note.body } : null
}

export function listItems({ status } = {}) {
  const items = readdirSync(ITEMS_DIR)
    .filter(f => f.endsWith('.md'))
    .map(f => getItem(f.slice(0, -3)))
    .filter(Boolean)
  const filtered = status ? items.filter(i => i.status === status) : items
  return filtered.sort((a, b) => b.created_at.localeCompare(a.created_at))
}

export async function updateItem(id, fields = {}) {
  const provided = ITEM_UPDATE_KEYS.filter(k => fields[k] !== undefined)
  if (!provided.length) return getItem(id)
  return serialize(id, async () => {
    const existing = getItem(id)
    if (!existing) return null
    const { id: _id, text, ...frontmatter } = existing
    let body = text
    for (const key of provided) {
      if (key === 'text') body = fields.text
      else frontmatter[key] = fields[key]
    }
    writeNote(itemPath(id), frontmatter, body)
    await stageAndCommit(relItemPath(id), fields.action_result ?? `Updated: ${truncate(body)}`)
    return getItem(id)
  })
}

// ── Favourites ────────────────────────────────────────────
// A favourite freezes one already-executed { tool, input } call (see
// executed_action above) under a label, for one-click replay with no
// re-planning and no re-approval — see POST /api/favourites/:id/run.

const FAVOURITE_UPDATE_KEYS = ['label', 'tool', 'input', 'tags', 'plan_steps']

export async function createFavourite({ label, tool, input, tags = [], plan_steps = null, house = null }) {
  const id = newId()
  const created_at = new Date().toISOString()
  const frontmatter = { label, tool, input, tags, plan_steps: plan_steps ?? [], house, created_at }
  writeNote(favouritePath(id), frontmatter)
  await stageAndCommit(relFavouritePath(id), `Favourite: ${label}`)
  return getFavourite(id)
}

export function getFavourite(id) {
  const note = readNote(favouritePath(id))
  return note ? { id, ...note.frontmatter } : null
}

export function listFavourites() {
  return readdirSync(FAVOURITES_DIR)
    .filter(f => f.endsWith('.md'))
    .map(f => getFavourite(f.slice(0, -3)))
    .filter(Boolean)
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
}

export async function updateFavourite(id, fields = {}) {
  const provided = FAVOURITE_UPDATE_KEYS.filter(k => fields[k] !== undefined)
  if (!provided.length) return getFavourite(id)
  return serialize(id, async () => {
    const existing = getFavourite(id)
    if (!existing) return null
    const { id: _id, ...frontmatter } = existing
    for (const key of provided) frontmatter[key] = fields[key]
    writeNote(favouritePath(id), frontmatter)
    await stageAndCommit(relFavouritePath(id), `Favourite updated: ${frontmatter.label}`)
    return getFavourite(id)
  })
}

export async function deleteFavourite(id) {
  return serialize(id, async () => {
    const favourite = getFavourite(id)
    if (!favourite) return
    if (GIT_ENABLED) {
      await stageAndCommit(relFavouritePath(id), `Favourite deleted: ${favourite.label}`, { deleted: true })
    } else {
      unlinkSync(favouritePath(id))
    }
  })
}
