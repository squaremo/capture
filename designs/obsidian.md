# Obsidian notes: captures land in a git-tracked directory, full stop

Status: scoped, not yet implemented. Continues the wishlist's "Push to
external services: tasks and calendar items into things like Proton
Calendar, Linear, possibly Obsidian" (`TODO.md`).

## Problem

Some captures aren't a task or a reminder — they're a fact, a link, a
longer note worth keeping around and organizing later, the kind of thing
that belongs in an actual notes tool rather than this app's own inbox.
The goal, scoped down to what capture actually needs to do: write that
note as a plain markdown file into a git-tracked directory, with a real
commit history. Whatever happens to that directory afterward — syncing
it into an Obsidian vault, or anywhere else — is not capture's problem.

## Centralized, not satellite

The backend — the one thing in this whole system that's always on —
writes the note, the same way it's the only thing that ever touches the
SQLite DB or `satellites.json`. The alternative considered and rejected
early on was running Obsidian's desktop app open on some tailnet device
with the community "Local REST API" plugin installed, and having the
backend call it over HTTPS — rejected because it makes a `POST
/api/capture` succeed or fail depending on whether a particular laptop's
GUI happens to be open, exactly the satellite-shaped dependency capture
already avoids elsewhere (see `designs/satellites.md`'s reasoning for
*why* device control needs a satellite at all — a local network the
backend can't otherwise reach — which doesn't apply here; a git
directory has no local-network-only state to resolve).

## Approach: write, commit, done

`save_to_obsidian`'s `execute()`:

1. Writes one markdown file per capture into a configured directory on
   the VM ("kind of like a memory" — a discrete, addressable thing, not
   a line appended to a running log).
2. `git add` + `git commit`, synchronously, in the same call — one clean
   commit per capture, with the actual `action_result` as the message.
   That's a real, meaningful audit trail: every commit is one real event
   capture actually did, nothing else in the history, no batching, no
   "vault sync: 3 files changed" noise.
3. `git push`, if a remote is configured — optional; the whole thing
   works with a purely local repo too, at the cost of that history only
   existing on the VM.

That's the entire scope. No Syncthing service, no periodic reconciliation
job, no two-way anything, no dependency on any Obsidian device or plugin
existing at all — this is now exactly as simple as `create_linear_task`:
one acting tool, one external call, no resolve step (there's no per-house
state to look up; the directory is one global destination).

```
save_to_obsidian — kind: 'acting'
  args: { content, tags }
  describe: (input) => `Proposed: save note to Obsidian`
  execute: async ({ content, tags }) => {
    // write file, git add, git commit (message = action_result), git push if configured
    return `Saved to Obsidian: <path>`
  }
```

## Getting the files into an actual vault is your own concern, not capture's

This was the thing this design went back and forth on for a long
conversation — Syncthing vs. `obsidian-git` vs. `obsidian-headless`,
two-way sync, conflict ownership, read-only vault folders. None of that
needs building or maintaining as part of capture. A git-tracked directory
of markdown files already *is* a valid Obsidian vault — no plugin
required to open one, `git clone` it wherever you want and point Obsidian
at that folder. Keeping it current after that (a manual `git pull`, a
cron job, `obsidian-git`, Syncthing pointed at a local clone, whatever) is
entirely up to you, tuned to how you actually want to use it, and can
change without touching capture at all.

Kept here for reference only, since real research went into it and it's
useful if you want to wire up your own sync later — not part of capture's
design, and none of it should gate building `save_to_obsidian` itself:

- **`obsidian-git`** (community plugin, runs commit/push/pull from inside
  Obsidian) — its own maintainer states plainly it's "very unstable" on
  mobile (no real git on iOS/Android, falls back to a JS reimplementation
  with memory limits, no SSH, documented crashes on pull). Fine on
  desktop if that's where you'd use it.
- **`obsidian-headless`** (official, `obsidianmd/obsidian-headless`) —
  the "correct" first-party answer if you want it synced via Obsidian
  Sync itself, but its only auth is a real account email/password/MFA
  login, no scoped token — a much heavier credential than anything
  capture itself would need to hold, which is exactly why it's not
  capture's job to run this.
- **Syncthing** — mature, self-hosted, no account needed, replicates a
  folder P2P; no official iOS app (a third-party wrapper, Möbius Sync,
  is bound by the same iOS background-execution limits as everything
  else there). Would work well as *your own* mechanism for turning a
  local clone of the git repo into a live, two-way-editable vault, if
  you want that — again, your setup, not capture's.

## Config

```
OBSIDIAN_VAULT_PATH=/data/obsidian   (the git working tree; mounted into the same volume backend already uses, or a new one)
OBSIDIAN_GIT_REMOTE=...              (optional — omit for a local-only repo)
```

`OBSIDIAN_ENABLED = Boolean(process.env.OBSIDIAN_VAULT_PATH)`, checked
directly rather than through `resolveEnv()` since it's not a secret —
same as `SPOTIFY_MARKET`. If a remote is configured, its push credential
(a deploy key or PAT, scoped to one repo) goes through `secrets.js`
exactly like `LINEAR_API_KEY` — the backend already commits and would
push in the same call, so unlike the earlier "periodic job" design there
is no case for keeping this secret out of the Node process.

## Tool shape details

**Decided: one file per capture** — proposed default filename
`Capture/<timestamp>-<item id>.md` (the item's own SQLite row id
guarantees uniqueness without inventing a slugification scheme for
arbitrary capture text, and ties the note back to its source record).
YAML frontmatter (`created`, `tags`) rather than inline `#tags` — fits
the "addressable memory object" framing and is queryable via Obsidian's
own search/Dataview if and when you do point Obsidian at this directory.
Not yet confirmed, just a reasonable starting point.

## When Claude should reach for this vs `save_to_inbox`

Not yet settled, and worth getting right before writing the system
prompt — a boundary that's too loose floods the directory with routine
triage items; too strict and the tool never fires. Rough cut: durable
reference material (a fact, a link, something to look back on) goes to
Obsidian; short-lived triage/task-shaped captures stay in the app's own
inbox, same as today. Worth a second pass once there's real capture text
to test it against, rather than guessing from first principles.

## Favouriting

Falls out of the existing machinery for free (any `acting` tool gets a
☆ once it resolves to `acted`), but it's a weaker fit here than for
`control_playback`/`control_light`: replaying "the same note" isn't an
obviously useful shortcut the way replaying "the same song" is. Not
worth designing for specifically — leave it available, don't build
toward it.

## Out of scope, deliberately

Raised in the same conversation this doc grew out of, worth naming so
they don't get silently folded back in later:

- **Favourites as git-backed files** (rather than SQLite rows) — a real
  idea, applying the same "textual content belongs in git" principle to
  an existing feature, not a new one. Bigger change than this doc covers
  — `getFormFields()`/`runProgram()`/`POST /api/favourites/:id/run` are
  all built around SQLite today. Separate piece of work if wanted.
- **Shopping lists / checklists** — a genuinely new capture concept
  (append-to-a-growing-list, not one-file-per-capture) that doesn't exist
  in any form yet. Would need its own tool (e.g. `add_to_list`) and its
  own design, including the append-collision questions this doc
  deliberately sidestepped by going with one file per capture. Separate
  piece of work if wanted.
- **General backup/disaster-recovery for `/opt/capture/data`** (the
  SQLite DB, `satellites.json`) — a real, currently-unaddressed gap, but
  a distinct concern from this doc: that's about not losing the app's
  own operational/audit data if the VM dies, not about note content.
  Notes are already covered by whatever git remote you choose to push
  to, if any.

## Open questions

- **Filename/frontmatter scheme** — proposed above, not confirmed.
- **Git remote** — push anywhere at all, and if so where (GitHub,
  self-hosted, or none — purely local to the VM). Entirely your call,
  not something capture's design needs to resolve.
- **Classification boundary** (Obsidian vs inbox) — see above, needs
  real captures to test against.
