# Satellites: local control per house

Status: design sketch, not yet implemented.

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

## Room / house targeting

Reuses the existing Claude tool-calling pattern (`save_to_inbox`,
`create_reminder`, etc in `backend/integrations/claude.js`) with a new
acting tool for device control. It takes:

- `room` — free text ("living room"), resolved locally by the target
  satellite's own device config (which Sonos speaker, which light group).
- `target_house` — only populated when the capture text unambiguously
  names one of a known set of house aliases (an enum, not free text
  matching). No match → defaults to the house the capture originated from
  (satellite-of-origin, when known).

## Safety: approval always required

Device-control actions always go through the existing `awaiting_approval`
flow (`ACTING_TOOLS` in `claude.js`) — propose, then wait for
`POST /api/items/:id/approve` — same as `create_linear_task`, with no
same-house exception. Satellite-of-origin only saves you from having to
*say* which house you mean; it isn't confirmation that the action should
run. So there's one rule, not a same-house/cross-house branch: never fire
blind, regardless of target.

Ambiguous house match (two named, or an unclear alias) falls back to
asking rather than guessing, same as before.

## Hub → satellite dispatch

Plain HTTPS from the central backend to the satellite's MagicDNS hostname
(`https://satellite-home.<tailnet>.ts.net`), not MCP. MCP earns its keep
when a client needs to discover an unknown set of tools across many
servers at runtime; here the backend already has to wrap every satellite
call in its own safety logic (room resolution, same-house-vs-approval
gating), so a discovery protocol wouldn't remove any of that — it'd just
sit on top of it. Revisit only if satellites end up numerous/varied enough
that hand-maintaining "what can each one do" stops scaling.

Which houses exist and where is static config on the backend (a house-id →
satellite-address table, same shape as other deployed config) — not
auto-discovered. What a given satellite can currently *do* is queried live:
`GET /api/status` includes a `capabilities` list (e.g. `["sonos"]`) — pulled
by the hub before/at dispatch time, not pushed by the satellite on startup.
Pull avoids the hub having to track liveness (is this satellite still up,
when did we last hear from it) — an unreachable satellite (laptop not
currently running, say) just fails the request, no stale registration to
clean up. Capabilities are service names for now, not per-verb granularity,
since there's only one local service; doesn't need to feed Claude's tool
schema dynamically either — the tool definition in `claude.js` stays
static, capabilities are only used to validate at dispatch time (fail
explicitly — "the lake house doesn't have Sonos configured" — rather than
firing blind into a 404).

Dispatch flow once a capture resolves to an acting tool call:

1. Resolve `target_house` (explicit) or the capture's origin house.
2. Look up its address in the house table; unknown house → fail, never guess.
3. Check the satellite's advertised capabilities support the requested
   action; unsupported → fail with an explanation.
4. Propose the action (`awaiting_approval`); call it (`executeAction`, as
   `create_linear_task` does today) only once approved via `POST /approve`.
   Origin house or not, no exception.

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

## Open questions

- Whether the satellite frontend is a distinct build/config or the same
  build with house-id supplied at deploy time.
- Provisioning story for a new satellite (how house-id and local device
  config get onto the box) — likely follows the same cloud-init pattern
  used for the main server, not yet written.
- First concrete integration to build against: Sonos, given where this
  design started.
