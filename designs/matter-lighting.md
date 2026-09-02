# Matter lighting: local control via Dirigera

Status: implemented and verified against real hardware — dimming and
favourite replay both confirmed working against an actual Dirigera hub.
`satellite/services/dirigera.js`, `POST /api/lights/resolve` +
`POST /api/lights` on the satellite, `resolveLight()`/`commitLight()` in
`backend/integrations/satellite.js`, and `resolve_light`/`control_light`
in `TOOL_REGISTRY`. Builds directly on `designs/satellites.md` —
read that first. Hub → satellite dispatch, capability-checked routing,
room-as-free-text resolved locally, and "approval always required, no
same-house exception" all carry over unchanged; this doc only covers
what's specific to lighting.

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
`satellites.json` edit already required to add a new house). If pairing
times out, it's almost always mDNS discovery not reaching the hub
(client-isolated Wi-Fi, a VPN active) rather than the button press —
`npx dirigera authenticate --gateway-IP <hub IP>` sidesteps discovery
entirely.

The token is satellite-local config, same trust tier as `HOUSE_ID` and
`PORT` — not central config, not git. It (and everything else the
satellite needs) can live in a gitignored `.env` file, picked up
automatically via Node's `--env-file-if-exists` — no dotenv dependency,
no new local-file config format. Hub discovery defaults to mDNS;
`DIRIGERA_HOST` overrides it if mDNS doesn't reach the hub, same escape
hatch `HOST` already provides for the satellite's own bind address.

## Resolve, then commit — matching how Sonos playback works

Room resolution here follows the same split Sonos settled on for track/
speaker resolution (`designs/satellites.md`): a `readonly` step resolves
the request against real state and can fail before anything is proposed;
an `acting` step then commits *exactly* what was resolved, never a fresh
re-interpretation of the same free text.

`resolveLight({ room, action, brightness })` in `dirigera.js` fuzzy-
matches the free-text `room` against this house's actual Dirigera room
names (same exact/substring matching `matchRoom()` uses for Sonos
speakers in `services/sonos.js`) and validates `action`/`brightness` —
changes no device state. `commitLight({ room, action, brightness })`
takes the *resolved* room object (not free text) and performs the
device-state change. At the satellite HTTP layer these are
`POST /api/lights/resolve` and `POST /api/lights`, mirroring `/api/search`
+ `/api/play`.

Dirigera already models rooms natively, and its own client exposes
room-scoped group operations (`rooms.setAttributes({ id, deviceType:
'light', attributes })`) — so resolution doesn't need a hand-maintained
device-name config file (the open TODO for Sonos speaker matching), and
commit applies to every light in the matched room in one call rather
than iterating individual devices.

## Two-step tools: `resolve_light` / `control_light`

Registered in `TOOL_REGISTRY` (`backend/integrations/claude.js`) inside
the `SATELLITES_ENABLED` block, mirroring `resolve_playback`/
`control_playback` exactly:

```
resolve_light — kind: 'readonly', resolvesHouse: true
  args: { room, action: 'on' | 'off' | 'set_brightness', brightness?, target_house? }
  output: { target_house, room: { id, name, requested, confidence }, action, brightness }

control_light — kind: 'acting'
  args: { target_house, room, action, brightness, tags }
  (always follows resolve_light in the same plan, referencing its output
  via "${s1.room}" etc — never called standalone)
```

`resolvesHouse` is a small generalization made here: `runProgram()`'s
"default target_house to the capture's house of origin" logic used to
check `step.tool === 'resolve_playback'` by name. Adding a second
house-resolving readonly tool was the trigger to turn that into a flag
any `TOOL_REGISTRY` entry can set, checked generically, rather than
growing a list of hardcoded tool names.

Claude extracts `action`/`brightness` from the capture text the same
one-shot way it extracts `title`/`artist`/`album` for `resolve_playback`
— "dim ... to 20%" → `{ action: 'set_brightness', brightness: 20 }`;
"turn off the lights" → `{ action: 'off' }`. `control_light`'s `describe()`
shows the *resolved* room name (`room.name`), not the raw request text —
a human approves exactly what's about to happen, same reasoning as
`control_playback` showing the resolved track/speaker rather than a
guess that gets re-interpreted after the fact.

One Dirigera-specific wrinkle, handled inside `dirigera.js` rather than
exposed to the plan: `isOn` and `lightLevel` are independent attributes,
so setting brightness on a light that's off doesn't visibly do anything
until it's also turned on — and Dirigera's own client docs warn some
attributes can't be combined in a single `setAttributes` call, so
`commitLight`'s `set_brightness` path issues two calls (`isOn: true`,
then `lightLevel`) rather than one. The tool's single `set_brightness`
verb hides both of these — the interpreter and Claude never see two
steps. Same "vendor quirks are the satellite's problem, not the LLM's"
reasoning already applied to Sonos track search and speaker matching.

## Safety

No exception here either: `control_light` is `kind: 'acting'`, so it
always resolves to `awaiting_approval` and only actually runs on
`POST /api/items/:id/approve` — same as `create_linear_task` and
`control_playback`. Dimming a light is lower-stakes than either of those,
which raises a real question (below) about whether per-action approval
is worth the friction here — but the existing rule is "one rule, not a
per-tool exception," so this design doesn't special-case it without a
deliberate decision to do so. (Favourites, once run, do skip approval —
but only for a previously-approved exact replay, never a fresh request;
see the Favourites entry in `TODO.md`.)

## Open questions

- **Mixed initial states** — resolved: `set_brightness` always turns the
  whole room's lights on and sets them all to the given level (the
  `rooms.setAttributes` group call has no per-device conditional), rather
  than only touching lights already on.
- **Non-IKEA Matter devices bridged through Dirigera** — assumed to
  behave identically for brightness through Dirigera's normalized API,
  not verified without real hardware.
- **Other device types** — Dirigera also exposes blinds, outlets, air
  purifiers, sensors. Out of scope here, but the resolve/commit shape
  should extend to a more general `resolve_device`/`control_device` pair
  later without a redesign, rather than growing parallel one-off tools
  per device type.
- **Colour / colour temperature** — not needed for "dim," deferred.
- **Approval friction for low-stakes actions** — flagged above; worth a
  deliberate call later rather than a silent exception now.
- **Favouriting a light action** — confirmed working against real
  hardware (see Status above). Went through two iterations once real use
  surfaced the problem:
  1. First fix: `control_light`'s `action_result` bakes in the specific
     brightness ("dimmed to 10%"), which the favourite's form then lets
     you replay at a *different* level — freezing that string as the
     label goes stale the moment the form is used. Tried dropping
     `action`/`brightness` from the label, keeping only the room
     ("Living Room lights") — and the same fix for `control_playback`
     (drops the track, keeps the speaker), since its form fields are
     exactly as editable.
  2. That still wasn't right: room is just as editable via the form as
     brightness is (nothing on a resolve step's args is more "stable"
     than anything else — the whole point of "favourite as a form" is
     that any field can be tweaked). The actual fix: make the label a
     **live template** (`favouriteLabel(input)` on a `TOOL_REGISTRY`
     entry) that's re-evaluated from the favourite's *current* input
     every time that input changes, rather than a string frozen once.
     `POST /api/favourites/:id/run` now persists whatever `tool`/`input`/
     `plan_steps` actually ran back onto the favourite itself
     (`updateFavourite()` in `db.js`) and regenerates `label` from them —
     only on success, so a failed edit never becomes the new default.
     `control_light`'s template is `"${room.name} lights (${brightness}%)"`
     (or on/off); `control_playback`'s is `"${speaker.name}: \"${track}\""`.
     The favourite's button therefore always shows what running it *now*
     would do — "just run it" replays the current default, or open the
     form to edit it, and running becomes the new default for next time.
     `create_linear_task` still doesn't define a template: its title is
     the content, with no separate identifying field to build a template
     around — `action_result` (the fallback) already says what happened.
