# satellite

Local control node for one house. See `../designs/satellites.md` for the
design this implements.

This is currently a standalone vertical slice — UI → satellite →
local service — proving the wiring end to end, ahead of the central
backend calling into it. `services/sonos.js` is a stub standing in for
real Sonos UPnP control until there's hardware to test against; it exposes
the same shape a real implementation would, so it can be swapped in later
without changing `server.js`'s controller API.

## Protocol

`GET /api/status` — `{ house, capabilities, playing, track, speaker }`.
`house` and `capabilities` are used by the hub to verify it reached the
right satellite and that it supports what's about to be asked of it (see
`designs/satellites.md`); `playing`/`track`/`speaker` mirror the last
`/api/play` result.

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
resolve, `default` when `room` was omitted and the first configured
speaker was used. If `room` doesn't match any configured speaker closely
enough, the request fails outright (`422 { "error": "No speaker matching
\"...\"" }`) rather than guessing.

`POST /api/play` — body `{ track, speaker }`: `track` is whatever the hub
resolved via Spotify; `speaker` is exactly the object a prior
`/api/search` returned. Both are passed back verbatim — no free text
accepted here and no re-matching happens, so this can't land on a
different result than what was already resolved. Response is the same
shape plus `"playing": true`.

`POST /api/pause` — no body.

Today's speaker list is a stub (`services/sonos.js`) — a fixed name list
rather than anything discovered from real hardware. Real Sonos device
discovery is a tracked TODO in the design doc; this protocol shape is
meant to survive that swap unchanged.

## Run

    cd satellite
    npm install
    HOUSE_ID=home npm start

Open `http://localhost:4000`. `HOUSE_ID` is the only config for now —
it's what a real deployment would bake in at provisioning (see "Running
modes" in the design doc); on a laptop, just set it to whichever house
you're currently standing in and stop the process when you leave.
