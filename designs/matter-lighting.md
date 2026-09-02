# Matter lighting: local control via Dirigera

Status: implemented — `satellite/services/dirigera.js`, `POST /api/lights`
on the satellite, `controlLight()` in `backend/integrations/satellite.js`,
and the `control_light` tool in `TOOL_REGISTRY`. Not yet verified against
a real hub (needs pairing on an actual satellite box — see
`satellite/README.md`). Builds directly on
`designs/satellites.md` — read that first. Hub → satellite dispatch,
capability-checked routing, room-as-free-text resolved locally, and
"approval always required, no same-house exception" all carry over
unchanged; this doc only covers what's specific to lighting.

## Problem

The wishlist item is home automation control via "a Matter hub (IKEA
Dirigera)" — concretely, captures like "dim lights in living room to
20%" or "turn off the bedroom lights" should reach real devices. Like
Sonos, the hub is on a house's local network and isn't reachable from the
central backend on Hetzner directly — it needs the satellite already
running in that house (`designs/satellites.md`'s whole reason for
existing).

## Approach: Dirigera's own local API, not raw Matter

Two ways a satellite could reach Matter devices:

- **Dirigera's local REST API** — HTTPS on port 8443, bearer-token auth.
  As of a 2025 firmware update Dirigera is itself a certified Matter
  bridge/controller, so every device it knows about — IKEA gear and any
  third-party Matter device paired *through* it — shows up through this
  one proprietary API. An unofficial but well-maintained Node/TypeScript
  client (`dirigera` on npm) wraps it.
- **Speak Matter directly** — the satellite becomes its own Matter
  controller (via `matter.js`, the project-chip TypeScript implementation,
  or a sidecar like `python-matter-server`), commissioning devices onto
  its own fabric and bypassing IKEA's API entirely.

Going with the first. It's a straightforward REST client — same shape as
the existing Sonos integration — versus taking on commissioning flows,
fabric/session state, and operational discovery ourselves. The only
reason to prefer raw Matter is hub-agnosticism: it'd work with any Matter
controller, not just Dirigera. That's not a real requirement yet (one
house, one hub, named explicitly in the wishlist) — revisit only if a
second hub brand shows up, or if depending on IKEA's local API stops
being acceptable for some other reason.

## Shape

A new `satellite/services/dirigera.js`, same role as
`satellite/services/sonos.js` — a small local module wrapping the vendor
client, called by the satellite's Fastify server. `'dirigera'` joins
`CAPABILITIES` in `satellite/server.js` when a token is configured, so
the hub's existing capability check (`status.capabilities?.includes(...)`
in `backend/integrations/satellite.js`) already works unchanged for the
new service — a house without Dirigera configured fails explicitly at
dispatch time, same as a house without Sonos does today.

## Pairing and token storage

One-time pairing: press the hub's physical action button within 60s
while running the `dirigera` package's token-generation flow, which
mints a long-lived bearer token — no ongoing OAuth after that. This
happens once per satellite, by hand, at setup time (parallels the manual
`satellites.json` edit already required to add a new house).

The token is satellite-local config, same trust tier as `HOUSE_ID` and
`PORT` — not central config, not git. Satellite processes are already
configured entirely through environment variables, so `DIRIGERA_ACCESS_TOKEN`
follows that existing pattern directly rather than introducing a new
local-file config format just for this. Hub discovery defaults to mDNS;
`DIRIGERA_HOST` overrides it if mDNS doesn't reach the hub (e.g. VLAN
boundary), same escape hatch `HOST` already provides for the satellite's
own bind address.

## Room and device targeting

"Living room" arrives as free text, same principle as Sonos's `room` arg
in `designs/satellites.md`: Claude passes it through as written, doesn't
guess a specific device, and the satellite resolves it locally.

Unlike Sonos, this doesn't need a hand-maintained device-name config file
(the open TODO for Sonos speaker matching). Dirigera already models rooms
natively, and its own client exposes room-scoped group operations
(`rooms.setAttributes({ id, deviceType: 'light', attributes })`) — so
`dirigera.js` lists rooms, fuzzy-matches the free-text room arg against
Dirigera's own room names, and applies the action to every light in that
room in one call, rather than iterating individual devices client-side.

## New acting tool: `control_light`

Registered in `TOOL_REGISTRY` (`backend/integrations/claude.js`) the same
way `control_playback` is — inside the `SATELLITES_ENABLED` block, since
it dispatches through the same houses/satellite mechanism and the
per-house capability check is what actually gates whether a given house
can serve it:

```
control_light — kind: 'acting'
  args: { room, action: 'on' | 'off' | 'set_brightness', brightness?, target_house?, tags }
```

Claude extracts `action`/`brightness` from the capture text the same
one-shot way it already extracts `title`/`artist`/`album` for
`control_playback` — "dim ... to 20%" → `{ action: 'set_brightness',
brightness: 20 }`; "turn off the lights" → `{ action: 'off' }`. No
back-and-forth needed; a bad extraction is caught at approval, same as
everything else.

`target_house` resolution (explicit named house vs. capture's house of
origin) is identical to `control_playback` — implemented by generalizing
the tool-name-specific check `processCapture()` had for `control_playback`
into a `usesHouse: true` flag any `TOOL_REGISTRY` entry can set, checked
generically. Adding a second satellite-dispatching tool was the trigger
to make that generic rather than duplicating the special case.

One Dirigera-specific wrinkle, handled inside `dirigera.js` rather than
exposed to the plan: `isOn` and `lightLevel` are independent attributes,
so setting brightness on a light that's off doesn't visibly do anything
until it's also turned on — and Dirigera's own client docs warn some
attributes can't be combined in a single `setAttributes` call, so
`set_brightness` issues two calls (`isOn: true`, then `lightLevel`)
rather than one. The tool's single `set_brightness` verb hides both of
these — the interpreter and Claude never see two steps. Same "vendor
quirks are the satellite's problem, not the LLM's" reasoning already
applied to Sonos track search and speaker matching.

## Safety

No exception here either: `control_light` is `kind: 'acting'`, so it
always resolves to `awaiting_approval` and only actually runs on
`POST /api/items/:id/approve` — same as `create_linear_task` and
`control_playback`. Dimming a light is lower-stakes than either of those,
which raises a real question (below) about whether per-action approval
is worth the friction here — but the existing rule is "one rule, not a
per-tool exception," so this design doesn't special-case it without a
deliberate decision to do so.

## Dispatch

`backend/integrations/satellite.js` gets a `controlLight()` alongside
`controlPlayback()`, following the exact same sequence: resolve house →
address, fetch `/api/status`, confirm the satellite's reported house
matches, confirm `'dirigera'` is in its capabilities, then `POST` the
action. The satellite exposes it as `POST /api/lights` with body
`{ room, action, brightness }`, alongside the existing `/api/play` and
`/api/pause`.

## Open questions

- **Mixed initial states** — resolved: `set_brightness` always turns the
  whole room's lights on and sets them all to the given level (the
  `rooms.setAttributes` group call has no per-device conditional), rather
  than only touching lights already on.
- **Non-IKEA Matter devices bridged through Dirigera** — assumed to
  behave identically for brightness through Dirigera's normalized API,
  not verified without real hardware.
- **Other device types** — Dirigera also exposes blinds, outlets, air
  purifiers, sensors. Out of scope here, but `control_light`'s args
  shape (`action`, room-scoped target) should extend to a more general
  `control_device` later without a redesign, rather than growing
  parallel one-off tools per device type.
- **Colour / colour temperature** — not needed for "dim," deferred.
- **Approval friction for low-stakes actions** — flagged above; worth a
  deliberate call later rather than a silent exception now.
