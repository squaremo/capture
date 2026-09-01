# Satellites: local control per house

Status: hub-side dispatch (`resolve_playback`/`control_playback` in `claude.js`, `backend/integrations/satellite.js`) and the satellite controller (`satellite/`) are implemented and tested. Room/speaker matching and Sonos transport control (`satellite/services/sonos.js`) are real — discovery and playback via `sonos-discovery` against actual hardware — and confirmed working against a real Sonos system: discovery found the real speakers, and search + play produced real audio, including the previously-unverified `x-sonos-spotify` URI/DIDL construction. Track search is still a stub, always resolving to one fixed, known-good Spotify track rather than searching a real catalog (see Open questions). The frontend's house chooser (`capture.js`) is implemented — sticky by default, or defaulting to a house set via runtime config, with a "here" indicator when one's set (see House attribution). That runtime-config mechanism (`/config.json`, `BACKEND_URL`) supersedes an earlier `DEFAULT_HOUSE` build-time-constant version and is design-only, not yet built — as is the satellite actually serving the frontend at all (still serves a bespoke manual test page today) and the local now-playing panel that depends on it (see Satellite-served frontend & local device controls).

## Problem

Some actions need to reach devices the central backend can't get to directly —
Sonos (local UPnP, not exposed by Spotify's or Sonos's cloud APIs for
arbitrary playback), and home automation generally (Zigbee/Matter hubs,
IR, etc). These only work from something on the same local network as the
devices.

## Shape

One **satellite** per house: a small box (Pi or similar, eventually), joined
to the tailnet, with two responsibilities:

- **Frontend** — runs its own instance of the existing PWA, for local/kiosk
  use at that house.
- **Controller** — a small local API that speaks whatever the house needs
  locally (UPnP to Sonos, Zigbee/Matter, etc), which the central backend
  calls into to execute actions.

The **central backend stays exactly where it is** (Hetzner) — one place,
unchanged. Satellites don't replace it, they extend its reach.

## House attribution

The satellite's local frontend talks **directly to the central backend**,
same as every other frontend instance (phone, laptop) — no proxy hop
through the satellite. A proxy would give network-derived (harder to get
wrong) house attribution, but was rejected: it's an extra moving part, it
couples "capture works" to "satellite is up," and it breaks the existing
"every frontend just calls the backend" pattern for a benefit that's mostly
moot given this app already has no auth layer beyond tailnet membership.

Instead, each satellite's frontend build carries a house-id (baked in at
provisioning), sent as an ordinary field on the capture request — same
trust level as everything else in this single-user, Tailscale-only system.

Answers what was an open question here (distinct build per satellite, or
the same build parameterized): the **same** frontend build for everyone.
A house chooser (`capture.js`) sends `house` on every capture:

- **No default house** (the general frontend — phone, laptop): the
  chooser is plain and **sticky** — remembers your last pick via
  `localStorage`, defaults to none.
- **Default house set** (a satellite serving its own instance of this
  frontend): pre-selects it and shows a small "this is where you are"
  dot — a visibly different, stronger signal than a remembered
  preference. You can still override for one capture (e.g. controlling a
  different house from this kiosk), but the override doesn't persist —
  the default wins again next load, since it describes where the box
  physically is, not a choice that should drift.

The chooser is hidden entirely (both modes) when `GET /api/satellites`
reports no configured houses — most deployments have none, and a picker
with nothing to pick is just noise.

**Where this value comes from — runtime config, not a build-time
constant.** An earlier version of this baked the default house into the
frontend bundle itself at build time (a `DEFAULT_HOUSE` Vite `define`,
same mechanism as `__GIT_SHA__`, taken as a Docker build `ARG`). That's
the wrong shape once a satellite is the thing actually serving this
frontend to its own local kiosk (see Satellite-served frontend, below):
it would mean a distinct, separately-built image per house just to
change one string, when the satellite process already receives exactly
this kind of thing as an ordinary runtime env var (`HOUSE_ID`, already
used for its own `/api/status`). Build-time baking is right for
something that genuinely identifies *the build* (`GIT_SHA`); a default
house identifies *the deployment*, which should be one build configured
differently per place it runs — the standard build-once/configure-per-
environment split.

So instead: the frontend fetches `GET /config.json` once at startup,
before wiring up anything else. On the general deployment (nginx serving
static files, no such route configured) this 404s, and the frontend
treats that as `{}` — no default house, relative `/api` — i.e. today's
existing behaviour, unchanged, with no nginx or build changes needed. A
satellite serving the frontend implements `/config.json` for real,
generated per-request from its own env vars: `{ defaultHouse: HOUSE_ID,
backendUrl: BACKEND_URL }` (`backendUrl` is new — see below). `capture.js`
takes the resolved default house as a plain argument from this config
rather than reading a `__DEFAULT_HOUSE__` global, and `vite.config.js`/
`frontend/Dockerfile` drop the `DEFAULT_HOUSE` build machinery entirely
(`GIT_SHA` stays, since that one *is* build identity).

## Satellite-served frontend & local device controls

**Not yet implemented** — design only, below.

The satellite serves the same frontend build as everyone else (per
House attribution) at `/`, replacing what's currently a bespoke manual
test page (`satellite/public/index.html`) with the real capture UI,
locally, at that house. `BACKEND_URL` (new env var, alongside `HOUSE_ID`)
is what lets it keep the "frontend talks directly to the central
backend, no proxy" rule intact even though the satellite is now the one
serving the page: `/config.json` hands the frontend an explicit,
absolute backend origin for capture/inbox calls, so those never
accidentally route through the satellite itself — only the satellite's
*own* endpoints (below) are ever same-origin relative fetches.

That distinction is what makes a **local now-playing panel** possible
without reopening the proxy question: the frontend, when served by a
satellite, also polls that satellite's *own* `/api/status` (already
exists, relative fetch — naturally reaches the satellite because it's
the one serving the page, and is simply absent/inert on the general
deployment) and shows a small transport UI — what's playing, on which
speaker, play/pause — sourced from real local device state rather than
anything routed centrally. Pressing pause there calls the satellite's
own `/api/pause` directly.

This deliberately **bypasses the capture → Claude → approval pipeline**
— and that's correct, not a gap in it. Approval exists to gate an LLM's
interpretation of free text before it does something in the world (see
Safety, above); a human standing at the satellite pressing a literal
pause button is direct manual control, no interpretation involved — the
same trust level as walking up to the physical speaker or using the
Sonos app. The two paths (LLM-proposed, always gated; local-manual,
never gated) stay cleanly separate because they go through genuinely
different endpoints, not a shared one with a bypass flag.

`getStatus()` in `satellite/services/sonos.js` doesn't currently track
"what's playing" — `play()`/`pause()` are one-shot calls against real
hardware with no remembered state (see Open questions in the Sonos
integration work). A real now-playing panel needs that gap closed one
way or another: either query the Sonos player's own live transport state
(`sonos-discovery`'s `Player` tracks this via UPnP eventing already, per
its GENA subscriptions — unexplored so far) or have the satellite
remember the last thing it was told to play, accepting that could drift
from ground truth if changed via the Sonos app directly.

One more thing this reopens: Running Modes has the satellite bind only
to its Tailscale interface, reasoning that "the only thing that's ever
supposed to call it is the backend." Once the satellite also serves a
UI meant to be used locally, that binding is doing double duty — it's
also now what decides who can load the page at all. That still holds
under this app's existing model (no public exposure, no auth beyond
tailnet membership — see CLAUDE.md) as long as whatever's actually
displaying the local UI (a kiosk screen, a phone on-site) is itself a
tailnet member, same as every other frontend instance today. Worth
confirming that's the intended setup before building this, rather than
discovering it's not once the kiosk device can't reach it.

## Room / house targeting

Reuses the existing Claude tool-calling pattern (`save_to_inbox`,
`create_reminder`, etc in `backend/integrations/claude.js`), but as
**two** chained steps rather than one tool, per the reasoning in Safety
below — a `readonly` step that resolves, then the `acting` step that
proposes exactly what got resolved:

- `resolve_playback` (`readonly`) — takes the rich query (`title`/
  `artist`/`album`, extracted from the capture text by Claude one-shot,
  the same way it already extracts `title`/`description` for
  `create_linear_task`), plus `room` (free text, "living room") and
  `target_house`. Runs automatically, calling out to the satellite to
  actually resolve `room` and the track — never the LLM's job to guess
  against data it hasn't seen. Outputs `{ target_house, track, speaker }`.
- `control_playback` (`acting`) — always follows `resolve_playback` in
  the same plan, referencing its whole output by reference
  (`"track": "${s1.track}"`, etc — the interpreter's existing
  `${stepId.field}` mechanism already supports a whole nested object as a
  single arg value, not just string interpolation) rather than
  re-stating anything. Takes no free text of its own.
- `target_house` — only populated (on `resolve_playback`) when the
  capture text unambiguously names one of a known set of house aliases
  (an enum, not free text matching). No match → defaults to the house the
  capture originated from (satellite-of-origin, when known); this
  defaulting happens once, on `resolve_playback`, and flows through to
  `control_playback` by reference rather than being reapplied.

## Safety: approval always required, on the resolved particulars

Device-control actions always go through the existing `awaiting_approval`
flow (`kind: 'acting'` in `TOOL_REGISTRY`, `claude.js`) — propose, then wait for
`POST /api/items/:id/approve` — same as `create_linear_task`, with no
same-house exception. Satellite-of-origin only saves you from having to
*say* which house you mean; it isn't confirmation that the action should
run. So there's one rule, not a same-house/cross-house branch: never fire
blind, regardless of target.

Ambiguous house match (two named, or an unclear alias) falls back to
asking rather than guessing, same as before.

**What gets approved is the resolved match, not the raw request.** An
earlier version of this ran track search and speaker matching *inside*
`control_playback.execute()` — after approval — so a human approved "play
'Silver Machine' in bedroom" without knowing what track or speaker that
would actually resolve to; a plausible-but-wrong match had no gate to
catch it. Splitting resolution into its own `readonly` step
(`resolve_playback`) that runs *before* the acting step is proposed fixes
this: `describe()` builds the proposal text from the resolved
`track`/`speaker`, so the human sees "play 'Silver Machine' by Hawkwind
on Bedroom" — the literal thing about to happen — not the free text that
produced it. And because `control_playback.execute()` only ever commits
that already-resolved object (never re-searches, see Hub → satellite
dispatch), what's approved is guaranteed to be what plays, not a fresh
interpretation that could land somewhere else. A `resolve_playback`
failure (no matching speaker, satellite unreachable, ...) fails the whole
capture immediately rather than proposing something that would only fail
later — a bad match not caught by the (now much stronger) approval gate
means the resolution failed loudly before it ever reached a human.

## Hub → satellite dispatch

Plain HTTP from the central backend to the satellite's MagicDNS hostname
(`http://satellite-home.<tailnet>.ts.net`) — not HTTPS, and not MCP.

Not HTTPS: Tailscale already encrypts this at the WireGuard layer, so TLS
on top would be redundant — same reasoning that already lets the backend
itself skip TLS internally. Only nginx terminates real TLS in this stack,
and only because it's browser-facing (padlock, PWA installability), which
doesn't apply to satellite traffic since nothing but the backend ever
calls it. (A real cert is available cheaply if ever needed — `tailscale
cert` mints one per-device, same mechanism nginx already uses — but
there's no confidentiality gain here to justify the added
issuance/renewal upkeep.)

Not MCP: it earns its keep when a client needs to discover an unknown set
of tools across many servers at runtime; here the backend already has to
wrap every satellite call in its own safety logic (room resolution,
approval gating), so a discovery protocol wouldn't remove any of that —
it'd just sit on top of it. Revisit only if satellites end up
numerous/varied enough that hand-maintaining "what can each one do" stops
scaling.

Which houses exist and where is a house-id → satellite-address map, still
hand-maintained rather than auto-discovered — but **not** committed
config. It lives in a local JSON file on the backend server, outside git,
in the same already-mounted `/data` volume `DB_PATH` already uses
(`SATELLITE_HOUSES_PATH`, defaulting next to the backend code for local
dev). `backend/integrations/satellite.js`'s `getHouses()` re-reads it on
every call rather than caching, so editing the file takes effect on the
next request — no git commit, no `capture-sync` wait, no restart.

Rejected: committing the address map (via `SATELLITE_HOUSES` as deployed
env-var config, the first version of this). Works fine for permanent kit
with a stable Tailscale hostname, but is real friction for the
laptop-bootstrap running mode (below) where you're pointing at a satellite
that comes and goes — every address change became a git push and a
five-minute wait. Also rejected: satellite self-registration on startup
(a `POST` announcing "I'm house X, here's my address"). It would remove
even the manual file edit, but costs a registry that has to survive a
backend restart (so, persisted state, not free) and doesn't remove the
need for a live reachability check at dispatch time anyway — Tailscale
MagicDNS hostnames are stable per-device across restarts, so in practice
the file only needs hand-editing once per new device, not once per
session, which didn't justify that cost. Nothing here rules out adding
self-registration later as a convenience that writes into this same file,
if it turns out to be worth it.

Whether the `control_playback` tool exists at all (`SATELLITES_ENABLED`)
is still decided once at backend startup, from whether the file had any
houses in it at boot — so going from zero houses to a first house needs a
restart (matches how enabling Linear needs one), but every other edit
(repointing or adding to an already-nonempty file) doesn't. That split
exists on purpose, not just as a shortcut: always offering the tool even
when zero houses are configured would let Claude propose device-control
for ordinary captures that happen to mention a song, with no way to ever
act on it — worth a restart to avoid.

Before trusting any of that, the hub confirms the satellite it reached
actually **is** the house the config says — `/api/status`'s `house` field
(already `HOUSE_ID` on the satellite side, needed nothing new there) is
checked against the config key that was used to look up its address. A
mismatch (stale/mistyped `satellites.json` entry, or a satellite started
with the wrong `HOUSE_ID`) fails the same way an unreachable satellite
does — never dispatches to whichever house happens to answer — but is
reported as a distinct `houseMismatch` in `GET /api/satellites`/the UI
rather than folded into "unreachable," since it's a different thing to go
fix (a config typo, not a down satellite).

What a given satellite can currently *do* is queried live:
`GET /api/status` includes a `capabilities` list (e.g. `["sonos"]`) — pulled
by the hub before/at dispatch time, not pushed by the satellite on startup.
Pull avoids the hub having to track liveness (is this satellite still up,
when did we last hear from it) — an unreachable satellite (laptop not
currently running, say) just fails the request, no stale registration to
clean up. Capabilities are service names for now, not per-verb granularity,
since there's only one local service; doesn't need to feed Claude's tool
schema dynamically either — the tool definitions in `claude.js` stay
static, capabilities are only used to validate at dispatch time (fail
explicitly — "the lake house doesn't have Sonos configured" — rather than
firing blind into a 404).

The house/capability/name checks (`verifySatellite()` in
`backend/integrations/satellite.js`) run **twice**, independently, once
per call below — not once for the whole flow — since approval can land a
while after proposal and either the address or the satellite's state
could have changed in between:

1. **Resolve** (`resolve_playback`, runs automatically as part of
   planning): resolve `target_house` (explicit) or the capture's origin
   house → look up its address in the house table (unknown → fail, never
   guess) → verify the satellite there reports the same house name and
   supports the requested capability → `POST /api/search` with the rich
   query → propose the exact resolved `track`/`speaker` for approval
   (never the raw request — see Safety, above).
2. **Commit** (`control_playback.execute()`, only on `POST /approve`):
   the same house/name/capability verification again → `POST /api/play`
   with exactly the already-resolved `track`/`speaker`, no re-search. A
   house/satellite that became unavailable between propose and approve
   fails cleanly here rather than silently playing on whatever answers.

## Running modes

The satellite is just a Node process (frontend + controller) — what
changes between modes is deployment, not code:

- **Permanent kit** (eventual): a Pi or similar, always on, joined to the
  tailnet permanently, house-id baked in once at provisioning. This is the
  target state — physical fixedness is what makes satellite-of-origin a
  reliable default for "which house did you mean," even though it's never
  the thing that authorises an action (see Safety, above).
- **Bootstrap / laptop**: same process, run directly (`npm run satellite`
  or similar) on a laptop as a stand-in until permanent kit exists. This
  breaks the fixedness assumption a laptop can be at home when started and
  at the office an hour later, still claiming to be "home," which would
  make its house-of-origin default wrong (though approval still catches a
  wrong target before anything fires). Treat it as **manually armed**
  anyway: start it on arrival, stop it on leaving, rather than leaving it
  running unattended. A laptop-hosted satellite is a deliberate, temporary
  stand-in, not the intended long-term shape.

The satellite process binds to its host's Tailscale interface specifically
(detected via the same 100.64.0.0/10 CGNAT-range check the backend already
uses for its own allowlist), not `0.0.0.0` — the only thing that's ever
supposed to call it is the backend, over Tailscale, so there's no reason
for the controller API to be reachable from the LAN or any other interface
on the box. Falls back to `127.0.0.1` (not `0.0.0.0`) when no Tailscale
interface is up, e.g. local dev without Tailscale running — still
restrictive by default, never "listen everywhere." `HOST` overrides it
explicitly if that's ever genuinely needed.

## Open questions

- Provisioning story for a new satellite (how house-id and local device
  config get onto the box) — likely follows the same cloud-init pattern
  used for the main server, not yet written.
- The satellite doesn't serve the real frontend at all yet — only its own
  bespoke manual test page (`satellite/public/index.html`). Serving the
  actual frontend build, the `/config.json` runtime-config endpoint
  (`defaultHouse`, `backendUrl`), the frontend-side changes to consume it
  (dropping `__DEFAULT_HOUSE__`, making `api.js`'s base URL come from
  config instead of always being relative), and the local now-playing
  panel are all designed (see House attribution and Satellite-served
  frontend & local device controls) but not yet implemented.
- Satellite-side room/speaker matching and device control
  (`satellite/services/sonos.js`, documented in `satellite/README.md`'s
  Protocol section) are real, via
  [`sonos-discovery`](https://github.com/jishi/node-sonos-discovery) — an
  actively maintained, promise-based SSDP/UPnP client (not the abandoned
  `sonos`/`node-sonos` npm package), pulled from its GitHub tag rather
  than npm's stale 2019 publish. Speaker matching (exact → substring →
  bounded edit-distance, refusing to guess wildly and failing the request
  rather than the LLM's plan) now runs against the live discovered room
  list instead of a hardcoded one. `play()`/`pause()` issue real
  `SetAVTransportURI`/`Play`/`Pause` UPnP calls against the matched
  speaker. **Verified against real hardware**: run on a laptop on the
  home LAN, discovery found the actual speakers (e.g. "Living Room"),
  and a search + play round-trip produced real audio.
- Track search is still a stub: `searchTrack()` always resolves to one
  fixed, known-good, actually-playable Spotify track
  (`matchConfidence: "placeholder"`) rather than querying a real catalog
  — deliberately ignoring the requested title/artist/album rather than
  fabricating a plausible-looking match for them, so the approval text a
  human sees is never a promise the satellite can't keep. `search`/`play`
  were already split into separate calls (`/api/search` resolves without
  committing, `/api/play` commits an already-resolved result verbatim)
  specifically so the hub can show a human the *exact* resolved match
  before anything plays — see Safety, above; that split is what makes it
  safe for the fake match to be this blunt. TODO: swap in a real catalog
  search (Spotify's Web API, Client Credentials auth) behind
  `searchTrack()` — the protocol shape is designed to survive that swap
  unchanged.
- Playing that placeholder Spotify track through Sonos uses the
  `x-sonos-spotify:` URI + DIDL-Lite metadata scheme in
  `spotifyPlayable()` — an undocumented protocol, adapted from
  `node-sonos-http-api`'s `spotifyDef.js` (the reference
  reverse-engineering of it) rather than guessed from scratch. **Verified
  against real hardware**: the guessed default `SPOTIFY_ACCOUNT_SN=1`
  worked first try and produced real audio on a real speaker — so this
  household at least needs no override, though the env var stays
  available since the reference implementation treats this value as
  genuinely per-household. Swapping the fixed placeholder id for a real
  Spotify Web API search result should be a drop-in change to
  `searchTrack()`, since `spotifyPlayable()` only depends on `track.id`.
