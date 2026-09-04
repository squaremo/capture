# Obsidian notes: write-through vault, kept in sync centrally

Status: scoped, not yet implemented. Continues the wishlist's "Push to
external services: tasks and calendar items into things like Proton
Calendar, Linear, possibly Obsidian" (`TODO.md`).

## Problem

Some captures aren't a task or a reminder — they're a fact, a link, a
longer note worth keeping around and organizing later, the kind of thing
that belongs in an actual notes tool rather than this app's own inbox.
Obsidian is that tool already in use outside capture. The goal: a capture
that reads as "keep this" lands in the real vault, on whatever devices
already open it, without capture becoming a second place notes live.

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

## Approach: backend writes plain files; something else syncs them out

Two separable pieces:

1. The backend appends/creates a markdown file in a folder on the VM.
   No Obsidian-specific API involved at all — a vault is just files.
2. Something keeps that folder in sync with the vault your devices
   actually open. Capture doesn't need to know this layer exists beyond
   pointing at the right directory.

Splitting it this way means step 1 never depends on any sync product's
uptime, auth flow, or API shape — `save_to_obsidian`'s `execute()` is a
plain `fs.appendFile`/`fs.writeFile` call, as simple as any tool in
`TOOL_REGISTRY` gets. Step 2 is a deployment/infra concern, closer to
Watchtower or `capture-sync` than to anything in `backend/integrations/`.

## Sync layer: Syncthing over `obsidian-headless`, for now

Two real options surfaced during research (see the earlier conversation
turns on how Obsidian syncing works):

- **`obsidian-headless`** (official, `obsidianmd/obsidian-headless` on
  GitHub) — `ob sync --continuous` runs Obsidian Sync from the command
  line, no GUI. The "correct" long-term answer: first-party, end-to-end
  encrypted, proper per-file version history. Two things hold it back
  for v1: it's in open beta as of this research (Feb–Mar 2026), and
  authentication is `ob login` with email/password/MFA — a real account
  credential, not a scoped API key, which is a heavier secret than
  anything else this app stores (`ANTHROPIC_API_KEY`, `LINEAR_API_KEY`
  are both narrowly-scoped tokens). Whether MFA can be driven
  non-interactively for a one-time headless setup isn't confirmed.
- **Syncthing** — self-hosted, P2P, free, mature, no account/credential
  to store at all (device pairing is a one-time local handshake, same
  trust tier as the Dirigera pairing token in `designs/matter-lighting.md`).
  Fits capture's stated privacy principle more directly than the official
  Sync service does — data never leaves your own devices, whereas Sync's
  relay is a third party in the path even though it's zero-knowledge
  encrypted. Downside: it syncs files, not "vault intent" — no
  Obsidian-aware merge, so two concurrent edits to the same file produce
  a raw conflicted copy rather than a clean merge.

Recommend **Syncthing** for v1: no new secret class to store, no beta
dependency, and the actual write pattern here (single append to a daily
note from one writer — the backend) makes Syncthing's lack of smart
merging a much smaller risk than it would be for a two-way editing
workflow. Revisit `obsidian-headless` once it's out of beta, or sooner if
Obsidian Sync is already the sync mechanism in use for other devices and
running two sync layers side by side feels worse than the tradeoffs
above.

Shape: a `syncthing` service added to `docker-compose.yml` (own image,
own volume for its config/keys — not `/opt/capture/data`, which is
Postgres-adjacent territory that shouldn't gain a second consumer),
sharing a bind-mounted folder with the `backend` container the same way
`backend` already shares `/opt/capture/data`. One-time manual pairing
with the device(s) that actually run Obsidian, same operational shape as
the Dirigera token mint or the `satellites.json` edit — not something
`capture-sync` or Watchtower need to know about.

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
  execute: async ({ content, tags }) => { ...append/write... ; return "Saved to Obsidian: <path or heading>" }
```

Open question folded into this: **one file per capture, or append to a
daily note?** Leaning toward appending to a daily note (`YYYY-MM-DD.md`
under a configured folder, under a `## Capture` heading, one timestamped
bullet per item) — it matches how a lot of Obsidian quick-capture
workflows already work, avoids inventing a filename/slug scheme, and
keeps the vault from accumulating one tiny file per note. Not settled;
worth confirming against how notes actually get used day to day.

## Config

Following `SATELLITE_HOUSES_PATH`'s pattern — a path, not a secret:

```
OBSIDIAN_VAULT_PATH=/data/obsidian   (mounted into the same volume backend already uses, or a new one)
```

`OBSIDIAN_ENABLED = Boolean(process.env.OBSIDIAN_VAULT_PATH)`, checked
directly rather than through `resolveEnv()` since it's not a secret —
same as `SPOTIFY_MARKET`. Tool only offered to Claude when enabled, same
as every other optional integration.

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

- **Sync layer**: Syncthing vs `obsidian-headless`, as above — leaning
  Syncthing, not decided.
- **Note shape**: daily-note append vs one file per capture — leaning
  daily-note append, not decided.
- **Write races**: backend appends to a daily note while Syncthing is
  mid-sync of the same file from a phone edit. Low risk for a pure
  append (rare same-second collision, and Syncthing surfaces a
  `.sync-conflict` file rather than silently losing data) but not
  stress-tested.
- **Classification boundary** (Obsidian vs inbox) — see above, needs
  real captures to test against.
- **Tags**: capture's items already carry a `tags` array (Claude-assigned,
  1–3 lowercase tags) — should these become Obsidian-native `#tags` in
  the note body, YAML frontmatter, or both? Frontmatter would make them
  queryable via Obsidian's own search/Dataview; body tags are simpler
  and match how tags already render everywhere else in this app.
