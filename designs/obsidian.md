# Obsidian notes: git as the record, Syncthing as live delivery

Status: scoped, not yet implemented. Continues the wishlist's "Push to
external services: tasks and calendar items into things like Proton
Calendar, Linear, possibly Obsidian" (`TODO.md`).

## Problem

Some captures aren't a task or a reminder — they're a fact, a link, a
longer note worth keeping around and organizing later, the kind of thing
that belongs in an actual notes tool rather than this app's own inbox.
Obsidian is that tool already in use outside capture. The goal: a capture
that reads as "keep this" lands in the real vault, on whatever devices
already open it, without capture becoming a second place notes live —
and, since notes get edited after the fact, an edit made in Obsidian
should make its way back too, not just flow one way from capture outward.

## Centralized, not satellite

Decided already (see conversation this doc grew out of): the backend —
the one thing in this whole system that's always on — should be the
thing that writes the note, the same way it's the only thing that ever
touches the SQLite DB or `satellites.json`. The alternative considered
and rejected was running Obsidian's desktop app open on some tailnet
device with the community "Local REST API" plugin installed, and having
the backend call it over HTTPS — rejected because it makes a `POST
/api/capture` succeed or fail depending on whether a particular laptop's
GUI happens to be open, which is exactly the kind of satellite-shaped
dependency capture already avoids for its core inbox (see
`designs/satellites.md`'s reasoning for *why* device control needs a
satellite at all — a local network the backend can't otherwise reach —
which doesn't apply here at all; a vault has no local-network-only state
to resolve, so there's no satellite-shaped reason to route through one).

## Approach: two layers doing two different jobs

- **Git** is the durable record: every note that ever passed through this
  channel, in order, with real history, reachable from anywhere via
  `git clone`/GitHub's web UI regardless of whether any Obsidian device
  is online. This is what makes the whole thing trustworthy — the vault
  copies are just views onto it.
- **Syncthing** is live delivery into an actual open vault: it replicates
  the git working tree's files (not `.git/` itself — see below) out to
  wherever Obsidian is running, bidirectionally, so an edit made there
  flows back too.

They don't know about each other. Syncthing just replicates whatever
files sit in a directory; git just records whatever's in that directory
when something commits. One working directory on the VM serves both
roles — there's no need for a separate bare repo plus a distinct
checkout, and no need for `save_to_obsidian`'s own code to know git
exists at all (see "Who runs git" below).

## Sync layer: Syncthing for delivery — `obsidian-git` and `obsidian-headless` both ruled out as the whole mechanism

Three real options surfaced during research (see the earlier conversation
turns on how Obsidian syncing works) for *how a note gets into a live
vault*:

- **`obsidian-headless`** (official, `obsidianmd/obsidian-headless` on
  GitHub) — `ob sync --continuous` runs Obsidian Sync from the command
  line, no GUI. Would have been the "correct" long-term answer: first-
  party, end-to-end encrypted, proper per-file version history. **Ruled
  out, checked directly against its own README rather than assumed**: the
  only supported auth is `ob login`, email/password (`--email`/`--password`
  flags) plus MFA against your real Obsidian account — no app password,
  scoped API token, or service-account option exists at all. Every other
  secret this app stores (`ANTHROPIC_API_KEY`, `LINEAR_API_KEY`) is
  narrow and independently revocable; a stolen scoped key only exposes
  what it can reach. An Obsidian account password is the whole account —
  every vault, every device — with no way to scope or revoke it short of
  changing your master password. Not a fit for this app's secret-handling
  model regardless of the beta status, which was the weaker objection.
- **`obsidian-git`** (community plugin) — wraps the vault, or a subfolder
  of it, in an ordinary git repo and does `add`/`commit`/`push`/`pull`
  against a remote, on an interval, at startup, or a hotkey, *from inside
  Obsidian itself*. **Disqualified, checked directly against the plugin's
  own docs rather than assumed**: neither iOS nor Android lets an app
  shell out to real git, so on mobile the plugin runs `isomorphic-git` (a
  JS reimplementation) instead, and its own README says outright — "The
  Git implementation on mobile is **very unstable**! I would not
  recommend using this plugin on mobile." — with no SSH auth,
  memory-limited repo size, no rebase, no submodules, and open issues
  reporting crashes/hangs on iPhone pull specifically. That's a platform
  limitation the maintainer states plainly, not a risk to test later.
  (Earlier drafts of this doc over-reached by treating this as
  disqualifying *because capture's own UI is phone-first* — that's not
  the same claim as how you actually use Obsidian day to day, which
  wasn't checked before writing "ruled out." The actual disqualifier
  stands regardless: the plugin's own maintainer doesn't recommend it on
  mobile, full stop.)
- **Syncthing** — self-hosted, P2P, free, mature, no account/credential
  to store at all (device pairing is a one-time local handshake, same
  trust tier as the Dirigera pairing token in `designs/matter-lighting.md`).
  Runs as a genuine persistent background service on desktop and Android;
  worth knowing there's no official iOS app — only a third-party wrapper
  (Möbius Sync) bound by the same "no app can run continuously in the
  background" iOS restriction that limits `obsidian-git`'s pulls there.
  That's a platform ceiling any third-party sync app hits on iOS, not a
  defect specific to Syncthing, and it doesn't carry `obsidian-git`'s
  actual instability/crash problems — worst case on iPhone is "syncs
  promptly when opened" rather than "may crash or hang."

**Decided: Syncthing, doing a narrower job than originally scoped.**
Once git owns the durable record and the audit trail, Syncthing's
remaining job is just best-effort mirroring of an already-versioned
directory into a live vault — its lack of vault-aware merging barely
matters, because merging isn't what it's being asked to do here; see
"Who reconciles conflicts" below for where that job actually sits. Revisit
`obsidian-headless` only if it ever adds a scoped, revocable auth option.

Shape: a `syncthing` service added to `docker-compose.yml` (own image,
own volume for its config/keys — not `/opt/capture/data`, which is
Postgres-adjacent territory that shouldn't gain a second consumer),
sharing a bind-mounted folder with the `backend` container the same way
`backend` already shares `/opt/capture/data`. Configured **send &
receive** (Syncthing's default), not send-only, since edits made in
Obsidian need to flow back. One-time manual pairing with the device(s)
that actually run Obsidian, same operational shape as the Dirigera token
mint or the `satellites.json` edit — not something `capture-sync` or
Watchtower need to know about. A `.stignore` entry excludes `.git/` from
what Syncthing replicates — it has no reason to touch git's internal
object store, and a sync landing mid-write inside `.git/` is a real
corruption risk for a directory Syncthing doesn't understand at all.

## Who runs git, and when

Simplest split: **`save_to_obsidian`'s `execute()` never calls git at
all** — it just writes a file (`fs.writeFile`, one new file per capture;
see below). A separate, small periodic job — same shape as
`capture-sync.timer`, a systemd timer rather than anything inside the
Node process — runs every few minutes against that same directory:
stage everything, commit if there's a diff, push to a remote. This one
job is what makes edits durable in git whether they came from the
backend's own write or from an edit made in Obsidian and delivered back
by Syncthing — it doesn't need to tell those two sources apart, it just
snapshots whatever's currently on disk.

This is a meaningful simplification over having the backend do its own
`git commit`/`git push` synchronously per capture: one code path for git
operations instead of two, and the Node process never needs push
credentials for a git remote at all — only the timer's systemd unit does
(a deploy key or PAT, scoped to this one repo, same tier of secret as
everything else `secrets.js` already handles). The cost is latency: a
captured note isn't durably committed until the next periodic run, not
the instant `POST /api/capture` returns. That's an acceptable trade for
personal notes — nothing here is time-critical the way, say, approving a
Linear task or a Sonos command is — and matches how `capture-sync`
already treats "eventually reconciled every N minutes" as fine for
config, not just for this.

## Who reconciles conflicts

Two independent devices editing the *same file* inside the same sync
window is a Syncthing-level event, not a git-level one — by the time the
periodic job runs `git add`, Syncthing has already either merged nothing
(files are opaque bytes to it) or produced a `.sync-conflict-<device>-
<timestamp>.md` copy alongside the original. Git's job here is only to
record that faithfully as history, not to arbitrate it. One-file-per-
capture (see below) makes the realistic version of this collision rare —
the backend's own capture files aren't things a human is mid-edit on at
the moment they're written — whereas the daily-note-append shape
considered earlier would have made "the backend appends to today's note
while you're actively editing today's note" a routine collision instead
of an edge case. That's the deciding reason for the note-shape call
below, not just tidiness.

## Tool shape: `save_to_obsidian`

No resolve step needed — unlike `resolve_playback`/`resolve_light`,
there's no per-house local state to look up first; the vault is one
global destination, not something to match against free text. A single
`acting` tool, registered in `TOOL_REGISTRY` the same way
`create_linear_task` is:

```
save_to_obsidian — kind: 'acting'
  args: { content, tags }
  describe: (input) => `Proposed: save note to Obsidian`
  execute: async ({ content, tags }) => { ...write one file... ; return "Saved to Obsidian: <path>" }
```

**Decided: one file per capture, not a daily-note append** — "kind of
like a memory," each capture a standalone, addressable thing rather than
a line appended to a running log. Beyond the conflict-avoidance reasoning
above, it's a better fit for that framing on its own terms: a memory is a
discrete unit, not a fragment of a bigger document you'd need to open and
scroll to find it in.

Proposed default (not yet confirmed, but a reasonable starting point):
filename `Capture/<timestamp>-<item id>.md` — the item's own SQLite row
id guarantees uniqueness without inventing a slugification scheme for
arbitrary capture text, and ties the note back to its source record for
free. YAML frontmatter (`created`, `tags`) rather than inline `#tags` —
fits the "addressable memory object" framing, and makes tags queryable
via Obsidian's own search/Dataview the way nothing else in this app's
tags currently are. Body is the capture's content as Claude resolved it.
All of this is a starting proposal, not locked in the way the sync layer
and note-shape decisions above are.

## Config

Following `SATELLITE_HOUSES_PATH`'s pattern for the path itself — not a
secret:

```
OBSIDIAN_VAULT_PATH=/data/obsidian   (the git working tree; mounted into the same volume backend already uses, or a new one)
```

`OBSIDIAN_ENABLED = Boolean(process.env.OBSIDIAN_VAULT_PATH)`, checked
directly rather than through `resolveEnv()` since it's not a secret —
same as `SPOTIFY_MARKET`. Tool only offered to Claude when enabled, same
as every other optional integration. The git remote's push credential
(a deploy key or PAT, scoped to one repo) lives with the periodic timer's
systemd unit, not in `production.env` or `.env.secret` at all — the Node
process has no reason to hold it if it never runs git itself (see "Who
runs git," above).

## When Claude should reach for this vs `save_to_inbox`

Not yet settled, and worth getting right before writing the system
prompt — a boundary that's too loose floods the vault with routine
triage items; too strict and the tool never fires. Rough cut: durable
reference material (a fact, a link, something to look back on) goes to
Obsidian; short-lived triage/task-shaped captures stay in the app's own
inbox, same as today. This is the one part of this scope most worth
a second pass once there's real capture text to test it against, rather
than guessing from first principles.

## Favouriting

Falls out of the existing machinery for free (any `acting` tool gets a
☆ once it resolves to `acted`), but it's a weaker fit here than for
`control_playback`/`control_light`: replaying "the same note" isn't an
obviously useful shortcut the way replaying "the same song" is. Not
worth designing for specifically — leave it available, don't build
toward it.

## Open questions

- **Filename/frontmatter scheme** — proposed above (`Capture/<timestamp>-
  <item id>.md`, YAML frontmatter for tags), not confirmed.
- **Git remote** — GitHub (private repo) vs. self-hosted (Gitea, or a
  bare repo on the VM itself pushed to from the working tree). GitHub
  reintroduces a third party holding your notes, the same tension
  Obsidian Sync's relay has; self-hosted avoids that at the cost of one
  more service to run. Not decided.
- **Periodic job interval** — `capture-sync` uses 5 minutes; no reason
  yet to pick differently here, but not confirmed.
- **Classification boundary** (Obsidian vs inbox) — see above, needs
  real captures to test against.
- **Conflict frequency in practice** — reasoned about above, not
  stress-tested against real concurrent edits.
