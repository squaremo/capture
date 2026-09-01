# satellite

Local control node for one house. See `../designs/satellites.md` for the
design this implements.

`services/sonos.js` talks to real Sonos hardware via
[`sonos-discovery`](https://github.com/jishi/node-sonos-discovery) — SSDP
discovery and UPnP transport control against whatever's actually on this
house's LAN. It needs to run somewhere with genuine local-network
presence (SSDP multicast doesn't cross Tailscale) — which the satellite
already has, since it's meant to run at the house, not centrally. Track
search is still a stub (see below and Open questions in
`designs/satellites.md`).

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
never a fresh re-interpretation of the same free text. Real systems shape
this the same way (Spotify: search returns a track URI, you play the
URI — you don't re-search at play time).

`POST /api/search` — body `{ title, artist?, album?, room }`. `title` is
required; the rest are optional. This is a **rich query**, not one opaque
track string, and `room` is free text ("bedroom") — matching either
against a real catalog/device list is this satellite's job, not the
caller's (never ask an LLM to guess at data it hasn't seen). Doesn't play
anything or change state. On success:

    {
      "track":   { "id": "trk_...", "title", "artist", "album", "matchConfidence": "exact" | "approximate" },
      "speaker": { "name": "Living Room", "requested": "living room", "confidence": "exact" | "approximate" | "default" }
    }

`matchConfidence`/`confidence` are honest about how sure the match is —
`exact` when the query matched precisely, `approximate` when it took
fuzzy matching to resolve (a real search integration would set these from
actual search-relevance/similarity scores), `default` when `room` was
omitted and the first configured speaker was used. If `room` doesn't
match any configured speaker closely enough, the request fails outright
(`422 { "error": "No speaker matching \"...\"" }`) rather than guessing.

`POST /api/play` — body `{ track, speaker }`: exactly the object a prior
`/api/search` returned, passed back verbatim. No free text accepted here
and no re-matching happens — this can't land on a different result than
what `/api/search` already resolved. Issues a real Sonos `SetAVTransportURI`
+ `Play` against the named speaker. Response is the same shape plus
`"playing": true`.

`POST /api/pause` — body `{ speaker }`. Needs a speaker now — there's no
single "the system" to pause once there's real, possibly-multiple
hardware behind this.

Speaker matching is real (against Sonos's own discovered room names, via
`sonos-discovery`). Track search is still a stub: `searchTrack()` always
returns the same one known-good, actually-playable Spotify track
(`matchConfidence: "placeholder"`) regardless of what title/artist/album
was asked for — deliberately, so the approval text a human sees is never
a promise the satellite can't keep. Swapping in a real catalog search is
a tracked TODO in the design doc; this protocol shape is meant to survive
that swap unchanged.

Playing that placeholder track for real requires Spotify to already be
linked as a music service in the Sonos app (same as for normal use) —
`play()` reads Sonos's own service id for Spotify live off the discovered
system, but the "account serial number" piece of the protocol
(`SPOTIFY_ACCOUNT_SN` env var, defaults to `1`) is an
empirically-determined per-household value with no way to discover it
automatically. Confirmed working end to end (real discovery, real
speaker, real audio) with the default `1` on at least one real household
— but if playback ever fails elsewhere, this is the first thing to try
adjusting. See the comments in `services/sonos.js` and Open questions in
`designs/satellites.md`.

## Run

    cd satellite
    npm install
    HOUSE_ID=home npm start

Open `http://localhost:4000`. `HOUSE_ID` is required — it's what a real
deployment would bake in at provisioning (see "Running modes" in the
design doc); on a laptop, just set it to whichever house you're currently
standing in and stop the process when you leave. `SPOTIFY_ACCOUNT_SN` is
optional, see Protocol above.

Since discovery is real, this only finds speakers if you actually run it
on the same network as your Sonos system — a satellite started on this
sandbox, in CI, or on a machine off that LAN will report `playersFound: 0`
and `/api/search` will always fail with "No speaker matching" until it's
run somewhere that can actually see them.
