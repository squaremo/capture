# satellite

Local control node for one house. See `../designs/satellites.md` for the
design this implements.

`services/sonos.js` talks to real Sonos hardware via
[`sonos-discovery`](https://github.com/jishi/node-sonos-discovery) — SSDP
discovery and UPnP transport control against whatever's actually on this
house's LAN. It needs to run somewhere with genuine local-network
presence (SSDP multicast doesn't cross Tailscale) — which the satellite
already has, since it's meant to run at the house, not centrally. Track
catalog search isn't this satellite's job at all — it runs on the central
backend against Spotify's Web API (see below).

Dependency note: `sonos-discovery` is pulled straight from its GitHub tag
(`v1.8.0`), not the npm registry — the published `sonos-discovery`
package on npm is from 2019 and predates a Node 20 compatibility fix the
maintainer only ever tagged on GitHub. `node-sonos-http-api` (a much
better-known project built on the same library) does the same thing for
the same reason.

## Protocol

`GET /api/status` — `{ house, capabilities, ready, playersFound, rooms }`.
`house` and `capabilities` are used by the hub to verify it reached the
right satellite and that it supports what's about to be asked of it (see
`designs/satellites.md`); `ready`/`playersFound`/`rooms` reflect Sonos
discovery on this house's LAN — `rooms` is the live list of discovered
speaker names, matched against in `/api/search`'s `room` field.

Playback is a deliberate two-call **search, then play** protocol — not
one call that both resolves and commits — so a caller (the hub) can show
a human exactly what's about to happen and only actually play *that*,
never a fresh re-interpretation of the same free text.

Track catalog search happens on the central backend, directly against
Spotify's Web API (client-credentials — see `../designs/satellites.md`),
not here — unlike speaker resolution, it has no local-network dependency.
This satellite only resolves the **speaker**: matching free-text `room`
against this house's actual device list is this satellite's job, not the
caller's (never ask an LLM to guess at data it hasn't seen).

`POST /api/search` — body `{ room? }`. Doesn't play anything or change
state. On success:

    {
      "speaker": { "name": "Living Room", "requested": "living room", "confidence": "exact" | "approximate" | "default" }
    }

`confidence` is honest about how sure the match is — `exact` when the
query matched precisely, `approximate` when it took fuzzy matching to
resolve, `default` when `room` was omitted and the first discovered
speaker was used. If `room` doesn't match any discovered speaker closely
enough, the request fails outright (`422 { "error": "No speaker matching
\"...\"" }`) rather than guessing.

`POST /api/play` — body `{ track, speaker }`: `track` is whatever the hub
resolved via Spotify; `speaker` is exactly the object a prior
`/api/search` returned. Both are passed back verbatim — no free text
accepted here and no re-matching happens, so this can't land on a
different result than what was already resolved. Issues a real Sonos
`SetAVTransportURI` + `Play` against the named speaker. Response is the
same shape plus `"playing": true`.

`POST /api/pause` — body `{ speaker }`. Needs a speaker now — there's no
single "the system" to pause once there's real, possibly-multiple
hardware behind this.

`services/dirigera.js` talks to a real IKEA Dirigera hub via the
`dirigera` npm client — real, not a stub, same as Sonos above. Same
search-then-commit split: `POST /api/lights/resolve` (body
`{ room, action, brightness? }`, matches free text against Dirigera's
own room names, validates `action`/`brightness`, changes nothing) then
`POST /api/lights` (body `{ room, action, brightness? }` — `room` is
exactly the resolved object a prior `/api/lights/resolve` returned, not
free text). `action` is `"on"`, `"off"`, or `"set_brightness"`
(`brightness` 1-100). See `../designs/matter-lighting.md` and the
Dirigera setup section below.

Speaker matching is real, against Sonos's own discovered room names via
`sonos-discovery`. There's no track-search stub left to swap out here —
that moved to the central backend against Spotify's Web API, so this
protocol only ever handles `track` as an opaque, already-resolved object.

Playing a track through Sonos this way requires Spotify to already be
linked as a music service in the Sonos app (same as for normal use) —
`play()` reads Sonos's own service id for Spotify live off the discovered
system, but the "account serial number" piece of the protocol
(`SPOTIFY_ACCOUNT_SN` env var, defaults to `1`) is an
empirically-determined per-household value with no way to discover it
automatically. Confirmed working end to end (real discovery, real
speaker, real audio) against a fixed placeholder track before the
backend's Spotify search existed — `play()` only depends on `track.id`,
so a real resolved id is a drop-in — with the default `1` on at least one
real household; if playback ever fails elsewhere, this is the first
thing to try adjusting. See the comments in `services/sonos.js` and Open
questions in `designs/satellites.md`.

## Serving the real frontend

`/` serves the actual capture frontend (`../frontend/dist`) — the same
build used everywhere else, not a satellite-specific one. Build it first:

    cd frontend
    npm install
    npm run build

The satellite hands it runtime config via `GET /config.json`
(`{ defaultHouse, backendUrl }`), generated fresh per request from this
process's own env vars — see House attribution in `designs/satellites.md`
for why this replaced an earlier frontend build-time constant.
`BACKEND_URL` is required for the served frontend to actually work
(capture, inbox — anything that isn't Sonos-specific): without it, those
calls fall back to a relative `/api`, which 404s here, since the frontend
is no longer same-origin with the central backend once a satellite is
the one serving it. Use **`https://`** — unlike the backend→satellite
dispatch traffic (`/api/play` etc.), which is deliberately plain
`http://` because it goes tailnet-to-process directly (see Hub →
satellite dispatch in the design doc), this is *browser*-facing traffic
that goes through nginx, the one thing in this stack that terminates
real TLS. Point it at the backend's normal nginx-fronted address, not
its raw process port. `FRONTEND_DIST_PATH` overrides where the build is
read from if it's not at the default sibling-directory location.

If no build is found at startup, `/` falls back to the bespoke manual
test page instead (also always available at `/test` regardless) — so
this still boots usefully for Sonos-only testing without a frontend
checkout nearby.

## Dirigera setup (light control)

One-time pairing, done by hand, once per satellite:

    npx dirigera authenticate

Press the action button on the bottom of the hub within 60s of running
that. If it times out, mDNS discovery probably isn't reaching the hub
(common on client-isolated Wi-Fi, or with a VPN active) — pass the hub's
IP directly instead:

    npx dirigera authenticate --gateway-IP <hub IP>

Either way it prints an access token. Without it set, `control_light`
requests routed to this satellite fail with "no Dirigera capability
configured" — same as an unconfigured house does for Sonos.

## Run

    cd satellite
    npm install
    BACKEND_URL=https://<backend-host> HOUSE_ID=home npm start

Open `http://localhost:4000`. `HOUSE_ID` is required — it's what a real
deployment would bake in at provisioning (see "Running modes" in the
design doc); on a laptop, just set it to whichever house you're currently
standing in and stop the process when you leave. `BACKEND_URL` is needed
for the real frontend to work (see above); `SPOTIFY_ACCOUNT_SN` is
optional, see Protocol above.

Config can also come from a `.env` file in this directory (copy
`.env.example`) instead of inline env vars — `npm start`/`npm run dev`
pick it up automatically via Node's `--env-file-if-exists`, no dotenv
dependency needed. It's gitignored, same as the backend's `.env`; never
commit it, since it ends up holding the Dirigera access token above.

    HOUSE_ID=home
    BACKEND_URL=https://<backend-host>
    DIRIGERA_ACCESS_TOKEN=...
    DIRIGERA_HOST=...

Since discovery is real, this only finds speakers if you actually run it
on the same network as your Sonos system — a satellite started on this
sandbox, in CI, or on a machine off that LAN will report `playersFound: 0`
and `/api/search` will always fail with "No speaker matching" until it's
run somewhere that can actually see them. Same for Dirigera: `/api/lights`
only works run somewhere with real access to the hub.
