# Dropping SQLite: items and favourites become git-tracked files

Status: scoped, not yet implemented. Supersedes most of
`designs/obsidian.md` — see "What this means for the Obsidian design,"
below.

## Problem / motivation

Grew out of a simple principle stated directly: anything textual —
notes, favourites, shopping lists, checklists — belongs in git, where
it's human-readable, editable, diffable, and recoverable by construction
once pushed anywhere. Audit trail was going to be "SQLite, or even just a
log file" — but once content moves to files with one commit per
meaningful write, the git log *is* that audit trail for free, so there's
no reason left to keep SQLite around at all. Explicit instruction: no
concern for losing what's already in the deployed database — this is a
clean cutover, not a migration.

## Scope

`items` and `favourites` — the app's only two SQLite tables — both
become one markdown file per row, in a single git repo. `backend/db.js`
and the `better-sqlite3` dependency are removed entirely. Nothing else
changes: `server.js`'s routes, request/response JSON shapes, and the
whole frontend are untouched, because the replacement module exports the
same function names with the same signatures `db.js` does today.

No migration path for existing production data — per instruction, the
current `capture.db` on the VM just stops being read; delete it on
cutover rather than writing a one-time importer nobody asked for.

## Directory layout

```
DATA_PATH/            (git repo root — was DB_PATH, now a directory not a file)
├── .git/
├── items/
│   └── <id>.md
└── favourites/
    └── <id>.md
```

Same `<id>` scheme already in `db.js`'s `newId()`
(`${Date.now()}-${random}`) — filename-safe as-is, no change needed.

## File format

YAML frontmatter for every structured field the SQLite columns held,
markdown body for the one field that's actually prose.

**`items/<id>.md`**:

```markdown
---
status: pending | triaged | reminder | urgent | awaiting_approval | acted | vetoed | failed
tags: [tag1, tag2]
house: living-room-house | null
created_at: 2026-09-08T14:23:17.000Z
action_result: "Reminder set: 'Call dentist' — Tomorrow, 9:00am"
pending_action: { tool: create_linear_task, input: {...} } | null
executed_action: { tool: control_light, input: {...} } | null
plan_progress: [{ label: "Checking Linear for duplicates" }]
plan_steps: [{ id: s1, tool: resolve_light, args: {...} }, ...]
---
Call the dentist tomorrow morning
```

**`favourites/<id>.md`**:

```markdown
---
label: "Bedroom: \"Silver Machine\" by Hawkwind"
tool: control_playback
input: { speaker: {...}, track: {...} }
tags: [music]
plan_steps: [...]
house: living-room-house | null
created_at: 2026-09-08T14:23:17.000Z
---
```

(No meaningful body for a favourite — it's a saved program, not prose —
but keeping it a `.md` file with frontmatter, same as items, means the
whole `DATA_PATH` tree is uniformly readable/browsable as one thing,
including in an editor or Obsidian if you point one at it later.)

This is a direct field-for-field carry-over from the SQLite schema —
nothing about the data model changes, only the serialization. The same
`JSON.stringify`/`JSON.parse` calls `db.js` already does for `tags`,
`pending_action`, etc. become YAML's native nested-object support
instead — arguably a wash in code, a real improvement in that the file
is now readable without a query.

## Store module: same shape as `db.js`, different guts

New module (`backend/store.js`, replacing `backend/db.js`), exporting
exactly what `db.js` exports today: `createItem`, `getItem`, `listItems`,
`updateItem`, `createFavourite`, `getFavourite`, `listFavourites`,
`updateFavourite`, `deleteFavourite`. `server.js`'s one import line
changes path; nothing else in it does.

- `createItem(text, house)` — writes `items/<id>.md` with fresh
  frontmatter (`status: 'pending'`, etc.) and `text` as the body; commits.
- `getItem(id)` — reads and parses `items/<id>.md`.
- `listItems({ status })` — reads every file in `items/`, parses
  frontmatter, filters/sorts in JS (`created_at` descending, optionally
  by `status`). No index, no query planner — for a personal single-user
  app measured in hundreds of items, not the tens of thousands where a
  full directory scan would start to matter. Worth revisiting only if
  that assumption stops holding.
- `updateItem(id, {...})` — read, merge the provided fields (`undefined`
  keys left alone, same "only touch what's passed" behaviour `db.js`
  already has), write back, commit.
- `createFavourite`/`getFavourite`/`listFavourites`/`updateFavourite` —
  same shape, under `favourites/`.
- `deleteFavourite(id)` — `fs.unlink` + commit (a deletion is still a
  real, auditable event — the commit records what was removed and when,
  rather than the file just silently vanishing from disk).

## Git mechanics: one commit per meaningful write, synchronous, no periodic job

Same philosophy the (now superseded) Obsidian design converged on: every
call that changes a file commits it immediately, in the same function
call — `git add <path>` + `git commit -m <message>`, via `child_process`
directly (no new dependency needed for two subcommands) rather than a
library like `simple-git`. Commit message drawn from context — e.g. the
new `action_result`, or `"favourite deleted: <label>"` — so the log reads
as an actual history of what happened, not "update," repeated.

A single capture can generate several small commits over its lifetime
(created pending → a `plan_progress` tick per readonly step → resolved to
its final status) — that's the audit trail working as intended, not
noise to squash. `git push`, if a remote is configured, same optional
knob as the superseded Obsidian design had — the whole thing works with
a purely local repo too.

## Concurrency

SQLite gave atomic single-writer safety for free; plain file writes
don't. The realistic risk here is low (single Node process, single
user), but a genuine one exists: two near-simultaneous updates to the
*same* item (e.g. a `plan_progress` tick landing while `/approve` is
resolving) could read-modify-write out of order and lose one of them.
Cheap mitigation worth building in from the start rather than treating as
an open question: a small in-process per-id write queue (a
`Map<id, Promise>` that chains writes to the same file through the
existing promise before starting the next one) — a few lines, and it
recovers exactly the guarantee SQLite's own locking gave away for free.

## What this means for the Obsidian design

`designs/obsidian.md` scoped a dedicated `save_to_obsidian` acting tool
that wrote into its own `OBSIDIAN_VAULT_PATH` directory, specifically for
captures worth keeping as durable notes. Once *every* item is already a
git-tracked markdown file in `DATA_PATH/items/`, that tool has nothing
left to do that isn't already happening — there's no second destination
to route a capture to. The "classification boundary" question that doc
left open (when should Claude reach for Obsidian vs. plain inbox) mostly
evaporates along with it: every capture is a file regardless of which
classification tool (`save_to_inbox`/`create_reminder`/`flag_urgent`/etc.)
resolved it, so "is this worth keeping as a note" becomes a browsing/
organizing question you answer by how you view `DATA_PATH` afterward
(a tag, a folder convention, an Obsidian search), not a capture-time
decision.

**This is a call to confirm, not one made unilaterally here**: if you
still want a distinct "this is real note content, not just triage" first-
class marker at capture time — a tag, a frontmatter field, a subfolder —
say so and it can be layered on top cheaply (e.g. a status value or a
tag the classification prompt already knows to reach for). Absent that,
the simplest reading is that `save_to_obsidian` as a separate tool is now
dead, and `designs/obsidian.md` stands only as the historical record of
how the sync-layer research (Syncthing/`obsidian-git`/`obsidian-headless`)
went, kept for reference if you want to point Obsidian at `DATA_PATH`
yourself later.

## Config

```
DATA_PATH=/data   (was DB_PATH — now a directory, git repo root, not a single file)
```

Everything downstream of that — whether/where to push, git author
identity — same optional, your-own-call framing already settled for the
Obsidian design: works with zero remote configured, and if you do want
one, that's a deploy key/PAT through `secrets.js` exactly like
`LINEAR_API_KEY`.

## Testing

`backend/test/setup.js` currently sets `DB_PATH=:memory:` for instant,
disposable per-test-run isolation. The file-backed equivalent: point
`DATA_PATH` at a fresh temp directory (`fs.mkdtemp`) per test run,
cleaned up after. `git commit` only makes sense (and should only run) if
`DATA_PATH` is actually inside an initialized git repo — the store module
should check for `.git` and skip the commit step silently if it's not
there, so most tests can point at a plain (non-git) temp directory and
never touch the real `git` binary at all; a dedicated test specifically
covering commit behaviour can `git init` its own temp dir.

`backend/test/db.test.js` and the `db.js`-touching parts of
`server.test.js` need rewriting against the new store module — same
scope of test coverage, different setup/teardown, not a design question.

## Open questions

- **Does a distinct "this is a real note" marker still matter** — see
  "What this means for the Obsidian design," above. Needs your call.
- **`DATA_PATH` naming** — proposed above, not confirmed.
- **Git author identity** for commits (name/email) — a config default,
  not yet chosen.
- **Per-write commit granularity** — proposed as "commit every meaningful
  write, no squashing," worth confirming that's not too noisy once
  there's a real commit log to look at.
- **Push remote** — same open, your-own-call question the Obsidian design
  left open; now app-wide rather than notes-specific.
