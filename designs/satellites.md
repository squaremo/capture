# Satellites: local control per house

Status: design sketch, not yet implemented.

## Problem

Some actions need to reach devices the central backend can't get to directly —
Sonos (local UPnP, not exposed by Spotify's or Sonos's cloud APIs for
arbitrary playback), and home automation generally (Zigbee/Matter hubs,
IR, etc). These only work from something on the same local network as the
devices.

## Shape

One **satellite** per house: a small always-on box (Pi or similar), joined
to the tailnet permanently, with two responsibilities:

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

## Safety: same-house vs cross-house

- **Same house as the capture's origin** (or no house named, captured from
  that house's own satellite): executes immediately. Being physically
  present is confirmation enough.
- **A different house, named explicitly**: always goes through the
  existing `awaiting_approval` flow (`ACTING_TOOLS` in `claude.js`) —
  proposes ("play 'X' in the lake house's living room") and waits for
  `POST /api/items/:id/approve` — same UI, same mechanism already built
  for `create_linear_task`. Never fires blind.
- Ambiguous house match (two named, or an unclear alias) also falls back
  to asking rather than guessing.

## Open questions

- Controller API shape (how the backend addresses a satellite — plain
  HTTPS to its MagicDNS hostname is the obvious default) not yet designed.
- Whether the satellite frontend is a distinct build/config or the same
  build with house-id supplied at deploy time.
- Provisioning story for a new satellite (how house-id and local device
  config get onto the box) — likely follows the same cloud-init pattern
  used for the main server, not yet written.
- First concrete integration to build against: Sonos, given where this
  design started.
