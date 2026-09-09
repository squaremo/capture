# Dropping SQLite: items and favourites become git-tracked files

Status: **implemented** (`backend/store.js`, replacing `backend/db.js`;
`better-sqlite3` dropped, `js-yaml` added). Supersedes most of
`designs/obsidian.md` — see "What this means for the Obsidian design,"
below.

Written against a stale schema snapshot — by the time of implementation,
`main` had already grown **checklists** and a **shopping list**
(`save_checklist`/`find_checklist`/`recall_checklist`/
`add_to_shopping_list` in `claude.js`), both landing after this doc's
first draft. Two consequences, folded into the implementation rather
than reopening the design: `items` frontmatter also carries `text`
(rewritable — a checklist/shopping-list item's own body *is* its
markdown task list) and `recalled_checklist_id`/`shopping_list_id`
(both nullable strings, same shape as `pending_action`/`executed_action`
elsewhere). Every write function (`createItem`, `updateItem`,
`createFavourite`, `updateFavourite`, `deleteFavourite`) is `async` —
committing is real I/O, so `server.js`'s route handlers and `claude.js`'s
`add_to_shopping_list`/`runProgram`'s `onStep` callback now `await` them,
which they didn't need to when writes were synchronous SQLite calls.

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
status: pending | triaged | reminder | urgent | awaiting_approval | acted | vetoed | failed | checklist | shopping_list
tags: [tag1, tag2]
house: living-room-house | null
created_at: 2026-09-08T14:23:17.000Z
action_result: "Reminder set: 'Call dentist' — Tomorrow, 9:00am"
pending_action: { tool: create_linear_task, input: {...} } | null
executed_action: { tool: control_light, input: {...} } | null
plan_progress: [{ label: "Checking Linear for duplicates" }]
plan_steps: [{ id: s1, tool: resolve_light, args: {...} }, ...]
recalled_checklist_id: null
shopping_list_id: null
---
Call the dentist tomorrow morning
```

(`checklist`/`shopping_list` and `recalled_checklist_id`/
`shopping_list_id` are the two fields this doc didn't originally know
about — see the note at the top. `note`/`write_note`, discussed earlier
in the conversation this doc grew out of, is *not* implemented here —
it stayed a `designs/obsidian.md` idea, not something `store.js` or
`claude.js` ended up with a tool for.)

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
`updateFavourite`, `deleteFavourite`. `server.js`'s import path changes,
plus `await` added at each write call site (`getItem`/`listItems`/
`getFavourite`/`listFavourites` stay synchronous — pure reads, no git
involved — so those call sites are genuinely untouched).

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

**Clone-if-missing, added after implementation**: `store.js` still never
runs `git init` — a from-scratch local-only repo stays a deliberate
manual step — but a *genuinely fresh* `DATA_PATH` (a new server, or a
wiped volume) with a remote already configured gets cloned automatically
rather than silently starting a second, disconnected local history.
Only fires when `DATA_PATH` doesn't already contain a `.git` and is
otherwise empty (or doesn't exist yet); a non-empty directory that
predates git being configured is left alone — ambiguous enough that
guessing would be worse than staying local-only until sorted out by
hand. A failed clone (bad token, network) logs and falls back to
local-only rather than blocking startup, matching every other optional
integration's degrade-gracefully pattern. **Deliberately not** paired
with pull-on-every-restart: nothing else currently writes to this
remote (single writer — only the backend ever commits/pushes), so a
restart-time pull would almost always be a no-op today while
reintroducing the same reconciliation/conflict complexity the rest of
this design went out of its way to avoid (see `designs/obsidian.md`'s
abandoned two-way-sync detour). Revisit only if a second writer to the
same remote actually shows up. Manually verified against a real seeded
local remote: cloning picks up existing history immediately (`listItems()`
returns the seeded item right after clone), a subsequent local commit
lands cleanly on top, and a push failure (tested by pushing into a
non-bare checked-out remote) is caught and logged without blocking the
write that triggered it.

**`cloneIfMissing()`'s directory scan is the only place anything here
looks at `DATA_PATH`'s top level at all** — `listItems`/`listFavourites`
are already scoped to the `items/`/`favourites/` subdirectories, so they
never could see a stray top-level file regardless. That one scan
explicitly excludes `README.md` (there to explain the repo to anyone
browsing it directly, not app content) from what counts as "real
content blocking a clone," rather than leaving that as an accident of
`listItems`/`listFavourites` happening not to look there. **Known
residual gap, deliberately not solved here**: excluding it from the
*eligibility check* doesn't make the actual `git clone` succeed if the
file is physically present — git itself refuses any non-empty target
directory regardless of why it's non-empty, so a real README sitting in
`DATA_PATH` still makes the clone attempt fail today (caught, logged,
falls back to local-only — no crash, just no history picked up). An
earlier attempt at this held the file in memory across the clone and
restored it after, which would close that gap — reverted twice as more
than what was actually wanted, so it's not reintroduced here.

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

**Resolved**: yes, wanted. Not `save_to_obsidian` back from the dead as
a `needsApproval` tool with its own storage, though — just a fourth
plain classification alongside `save_to_inbox`/`create_reminder`/
`flag_urgent`, in current `TOOL_REGISTRY` terms (`kind: 'final'`,
`needsApproval` omitted/false — see `claude.js`, which renamed the
`terminal`/`acting` vocabulary this doc originally used to `final`/
`needsApproval` by the time of implementation):

```
write_note — kind: 'final', status: 'note'
  args: { action_result, tags }
```

Not implemented alongside this storage change — noted here as the
resolved design, still open as actual work (would sit next to
`save_checklist` et al. in `claude.js`'s `TOOL_REGISTRY`, and needs its
own line in `buildSystemPrompt()`).

The boundary this draws, in the words it was described with: `write_note`
is for taking in some words to come back to later — a thought, an idea,
a piece of information worth keeping in its own right. `save_to_inbox`
narrows to match: a task or short actionable item to triage, not prose
you'd want to reread. Both produce an ordinary file under `items/`, same
as everything else — the only difference is `status: 'note'` vs.
`status: 'triaged'` (and whatever system-prompt wording actually gets
Claude to draw that line correctly in practice, worth iterating on once
there's real capture text to test against — same caveat every
classification boundary in this app has had).

`designs/obsidian.md` stands as the historical record of the sync-layer
research (Syncthing/`obsidian-git`/`obsidian-headless`), still useful if
you want to point Obsidian at `DATA_PATH` (or just its `note`-status
items) yourself later — not an active design either way.

## Config

```
DATA_PATH=/data   (was DB_PATH — now a directory, git repo root, not a single file)
GIT_REMOTE_URL=https://github.com/<owner>/<repo>.git   (or gitlab.com — either works identically)
GIT_REMOTE_TOKEN=op://Capture/git-notes/token          (a fine-grained PAT, through secrets.js exactly like LINEAR_API_KEY)
```

**Push remote: resolved.** A PAT on a dedicated bot account (GitHub or
GitLab — host doesn't matter, either works the same way), not the user's
own account — the same "narrow and independently revocable" secret class
`LINEAR_API_KEY` already is, and exactly what disqualified
`obsidian-headless` earlier in this whole discussion (a whole-account
credential with no way to scope or revoke it). A fine-grained GitHub PAT
scoped to just this one repo with only Contents read/write, or a
GitLab project access token with the equivalent scope, both fit. Both
config values above are optional and independent of whether local
commits happen at all — `store.js` distinguishes `GIT_ENABLED` (is
`DATA_PATH` already a git repo — local commits) from `GIT_PUSH_ENABLED`
(that, *and* both these values set — push each commit too). Neither
config value set just means the repo stays local to the VM, still with
full commit history.

One detail worth building in rather than leaving to chance: don't run
`git remote add` with the token baked into the URL (that writes it into
`.git/config` in plaintext, sitting on disk indefinitely). Pass the
token-bearing URL directly to each `git push <url> HEAD:main` call
instead — it only exists in that one process's argument list for the
few hundred milliseconds the push takes, never persisted to a config
file.

## Testing

Implemented as designed: `backend/test/setup.js` points `DATA_PATH` at a
fresh `fs.mkdtempSync` directory per test file (matching vitest's default
per-file isolation, the same granularity `DB_PATH=:memory:` gave before),
cleaned up via `afterAll`. Deliberately a plain directory, not a git
repo, so `GIT_ENABLED` is false and the whole suite never shells out to
the real `git` binary — verified separately, manually, against a real
`git init`-ed temp directory (real commits, real messages, `created_at`
round-tripping as a string not a `Date` — see the `YAML_OPTS` note in
the File format section above) rather than as part of the automated
suite, since that's really an infra/integration concern, not unit
coverage.

`backend/test/db.test.js` is now `store.test.js`, rewritten against the
new module (same coverage, plus a `recalled_checklist_id`/
`shopping_list_id` round-trip and a concurrent-update-serialization
case); the `db.js`-touching parts of `server.test.js` and `claude.test.js`
now import `store.js` and `await` what's newly async. All 187 tests
pass.

## Open questions

- ~~**Does a distinct "this is a real note" marker still matter**~~ —
  resolved: yes, a fourth classification, `write_note` (`status: 'note'`).
  Design resolved above; **not yet actually implemented** in
  `claude.js`'s `TOOL_REGISTRY`/system prompt — separate from this
  storage change. The exact system-prompt wording that draws the
  `write_note`/`save_to_inbox` line well in practice still needs tuning
  against real captures, once it exists.
- ~~**`DATA_PATH` naming**~~ — implemented as proposed.
- ~~**Git author identity**~~ — implemented: `GIT_AUTHOR_NAME`/
  `GIT_AUTHOR_EMAIL` env vars, defaulting to `capture`/`capture@localhost`.
- **Per-write commit granularity** — implemented as proposed (one commit
  per meaningful write, no squashing) — still worth revisiting once
  there's a real commit log from real use to judge whether that's noisy
  in practice, but not blocking.
- ~~**Push remote**~~ — resolved and implemented: a PAT on a dedicated
  bot account (GitHub or GitLab), not the user's own account, passed
  directly in the push URL rather than persisted to `.git/config`. See
  Config, above.
