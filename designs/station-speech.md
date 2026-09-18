# Station speech: local whisper.cpp + Piper, replacing the browser prototype

Status: not yet implemented — a design, written now that real station
hardware exists to target. Builds on `designs/satellites.md` — read that
first, especially Satellite-served frontend & local device controls,
which this follows exactly (a third local capability alongside Sonos and
Dirigera). Today's shipped behaviour (browser `SpeechRecognition` for
capture, browser `SpeechSynthesis` for read-aloud — `frontend/src/
components/capture.js`, `frontend/src/speech.js`) stays as the fallback
everywhere this isn't configured: phone, laptop, and any satellite with
no speech hardware attached. Nothing here changes the capture pipeline,
approval gating, or hub ↔ satellite dispatch.

## Problem

The prototype (see the read-aloud work in recent history, and
`capture.js`'s existing mic button) deliberately used the browser's own
Web Speech API for both directions — zero setup, ships the UI (say-it
button, mute toggle, click-to-toggle mic capture, reused as-is on the
station) before committing to hardware. It's the wrong long-term fit
for the real station specifically, for reasons CLAUDE.md's Voice stack
entry already anticipated:

- `SpeechRecognition` in Chrome routes audio through Google's speech
  service — an acceptable tradeoff for a phone/laptop used out and about
  ("Acceptable tradeoff for convenience," per CLAUDE.md), but wrong for a
  fixed home appliance whose whole premise is self-hosted and
  privacy-first (see CLAUDE.md's "what this is").
- Both `SpeechRecognition` and `SpeechSynthesis` need the station's
  browser tab to actually be a browser tab with those APIs available and
  online — no story for a kiosk with no reliable internet, or for running
  the model of your choice.
- `whisper.cpp` (STT) and `Piper` (TTS) were already the named plan for
  this (CLAUDE.md: "local transcription via whisper.cpp," and the recent
  TODO.md entry naming Piper as its TTS companion) — both run comfortably
  on a Pi 4/5, fully offline, no cloud dependency.

## Shape: speech as a third local satellite capability

Same pattern as Sonos and Dirigera: something only reachable — or only
sensible — on the box physically present at the house. A Matter hub and
Sonos speakers are local because of the network; a microphone and
speaker are local because they're bolted to *this* device. Both fit the
same shape: the satellite exposes narrow, resolved-input/resolved-output
endpoints; a caller on the same origin uses them directly, no free text,
no interpretation happening server-side.

Two new endpoints on the satellite controller (`satellite/server.js`),
backed by a new `satellite/services/speech.js`:

- **`POST /api/transcribe`** — body is recorded audio (raw bytes,
  `audio/webm` from the browser's `MediaRecorder`); response
  `{ text }`. Runs `whisper.cpp` locally against it.
- **`POST /api/speak`** — body `{ text }`; response is synthesized audio
  (WAV bytes, streamed back) for the caller to play. Runs `Piper`
  locally against it.

Both are **pure local I/O helpers, not action tools** — no `awaiting_
approval`, no `TOOL_REGISTRY` entry, nothing added to `claude.js`. They
never talk to the central backend at all, and the central backend never
knows they exist. This is a stronger version of the "direct, ungated
manual control" category `designs/satellites.md` already established for
the Sonos/light panels — even more clearly so here, since neither
endpoint changes any device's state. `/api/transcribe`'s only output is
text that then goes through the *ordinary* `POST /api/capture` flow,
exactly like text a person typed or the browser's own `SpeechRecognition`
produced today — same trust level, same downstream approval gating for
whatever Claude decides to do with it. `/api/speak`'s only input is text
already decided and already on screen (a proposal's `action_result`, a
resolved item's result) — it narrates, it doesn't act.

### Frontend integration — same call sites, a different transport underneath

Both existing hooks stay exactly where they are; only what's underneath
them changes, gated on whether this satellite actually has the hardware:

- **Capture** (`capture.js`'s mic button, and `station.js`'s idle-mode
  field which reuses it): the general (phone/laptop) mic button keeps
  today's **click-to-toggle** exactly as-is — one tap starts recording, a
  second tap stops it, mic live only in between. That's an established
  web-app pattern (a hand holding a phone doesn't want to hold a button
  down too) and there's no reason to disturb it. The **station** is
  different on purpose: it's getting a real push-to-talk button, and a
  physical PTT switch is inherently a *held* control — the pin reads
  high for exactly as long as a finger is on it, not a single press
  event — so the station's own capture (on-screen button and physical
  button alike, see below) uses **genuine hold-to-talk**:
  `pointerdown`/`pointerup` (plus `pointerleave`/`pointercancel`, so
  dragging off the button or a browser interruption can't leave it
  recording silently) instead of `click`, starting/stopping
  `MediaRecorder` on the mic stream exactly as the button goes down/up.
  Either gesture satisfies the same underlying requirement — mic live
  only between an explicit start and stop signal, never before or after
  — so this is an interaction choice, not a privacy one; `capture.js`
  just needs to support both, not pick one. Concretely: `createCaptureInput()`
  gains a `micMode: 'toggle' | 'hold'` option, same shape as the existing
  `hideHouseChooser` flag it already takes for the station's instance —
  `main.js`'s call site (phone/laptop) omits it and keeps toggle;
  `station.js`'s call site passes `micMode: 'hold'`. Whichever mode is
  active, a completed recording `POST`s to `/api/transcribe` and the
  response's `text` fills the textarea the same way `SpeechRecognition`'s
  result does today — **still lands in the field for a glance/edit before
  submit, not an auto-send**, matching today's behaviour and the same
  reasoning: neither engine is perfect, and this app's whole ethos is a
  human still initiates the capture.
- **Read-aloud** (`speech.js`'s `speak()`/`speakIfEnabled()`, called from
  every "say it" button and the auto-speak-on-resolve paths in
  `main.js`): today, `window.speechSynthesis.speak(new
  SpeechSynthesisUtterance(text))`. With a speech-capable satellite:
  `POST /api/speak` with the same text, then play the returned audio via
  an `<audio>` element (or a reused one, to get `.cancel()`-like
  interrupt behaviour by just changing `.src`) instead of calling into
  `speechSynthesis`. Every call site (per-item buttons, the mute toggle,
  auto-speak) is unchanged — `speech.js` picks the transport once, based
  on capability, the same way `speak()` already centralizes "how do we
  actually say this" today.

This keeps the fallback automatic and total: a satellite with no
`WHISPER_MODEL_PATH`/`PIPER_VOICE_PATH` configured, or any non-satellite
deployment (phone, laptop, the general frontend with no `/config.json`
at all), gets exactly today's browser-API behaviour with no code branch
visible to the user — same principle as `localActivity.js` rendering
nothing when a satellite has no Sonos/Dirigera to show.

### Physical push-to-talk button

A wall-mounted panel wants a real button, not just an on-screen tap
target. A browser page has no GPIO access, so the button itself can't be
"wired into the browser" directly — something has to sit between the pin
and the page. Two shapes were weighed:

1. **The button drives the existing on-screen control.** A small watcher
   process on the Pi (`gpiozero`/`RPi.GPIO` in Python, or a Node GPIO
   library) watches the pin's level and tells the *frontend* when it goes
   high/low — the page still does the actual `getUserMedia`/
   `MediaRecorder` capture and `POST`s to `/api/transcribe`, exactly the
   station's hold-to-talk path above. This is a natural fit specifically
   *because* the station uses hold, not toggle: a real PTT switch reports
   held-down/released, which maps directly onto `pointerdown`/`pointerup`
   with nothing to translate — pressed means recording, released means
   not, for as long as each lasts. (A toggle-mode button, if the station
   ever used one, would need the watcher to turn a momentary press into a
   flip; hold sidesteps that entirely.) The button is a second trigger
   for one existing gesture, not a second gesture.
2. **The button drives the satellite directly**, bypassing the browser
   entirely: the watcher records locally itself (`arecord` against the
   Pi's mic) and hands the WAV straight to the local whisper.cpp server.

**Chosen: 1.** It's strictly less new surface — one recording
implementation (the browser's), not two kept in sync, and it's the
smaller change from what the station's own on-screen hold-to-talk
already does. 2 was tempting for sidestepping `getUserMedia`'s
secure-context requirement and surviving a crashed/reloading kiosk tab,
but that's real duplicated machinery (a second audio-capture path, a
second consumer of `/api/transcribe`'s underlying whisper.cpp server)
for a benefit that doesn't clearly matter here — the browser tab *is*
the station; if it's down, nothing about the UI works regardless of how
the mic got captured.

What 1 actually needs, not yet part of this app: a low-latency channel
from the satellite process (which sees the GPIO level) to the page
(which owns the mic and the capture textarea) — the existing polling
(`localActivity.js`'s 4s `/api/status` interval, `pollForResolution`'s
backoff loop) is far too coarse for "start recording the instant the
button goes down." A small WebSocket or SSE connection the frontend
opens to the satellite at station startup, carrying `ptt-down`/`ptt-up`
events as the pin's level changes, is the natural fit — new
infrastructure for this app (everything else is request/response),
scoped narrowly to this one signal rather than becoming a general event
bus. `station.js`'s mic button handler (in `hold` mode) becomes
callable from two places — a real `pointerdown`/`pointerup`, or this
socket message — rather than gaining a parallel code path. Worth a note
for whoever wires the GPIO side: debounce the pin read in the watcher (a
cheap switch's contacts can chatter right at the transition) so a single
physical press/release produces exactly one clean `ptt-down`/`ptt-up`
pair, not a burst of spurious ones.

### Capability discovery — `/config.json`, not `/api/status`

`GET /api/status`'s `capabilities` array (already polled every 4s by
`localActivity.js`) is the wrong home for this: it exists to report
*live device state* (is a speaker playing, is a light on) that can
change moment to moment. Whether this satellite has speech hardware
configured is a **deployment fact**, fixed for the life of the process —
the same category `defaultHouse`/`backendUrl`/`isStation` already are in
`/config.json`, fetched once at startup before anything else wires up
(see `designs/satellites.md`'s House attribution for why that split
exists). So: `/config.json` gains a `speech: { stt: boolean, tts:
boolean }` field, computed the same way `dirigera.isConfigured()` already
is — independently, since a station could have a working microphone but
no speaker wired up yet, or vice versa. `main.js`/`speech.js` read it
once at init, same timing as everything else `loadConfig()` already
decides.

### Where whisper.cpp and Piper actually run

Both as **persistent local server processes**, not spawned fresh per
request. `whisper.cpp` ships a `server` example that loads the model
once and answers HTTP requests against it; Piper has an equivalent thin
HTTP wrapper (or one is trivial to add — it's a single model forward
pass). Spawning the CLI binary per call would reload a multi-hundred-MB
model on every single capture/read-aloud, which is both slow (fighting
the "instant capture" ethos directly) and wasteful on a Pi's limited
RAM/CPU. `satellite/services/speech.js` becomes a thin proxy — much like
`dirigera.js` already is a thin wrapper around the `dirigera` npm client
— forwarding `/api/transcribe`/`/api/speak` to these two local servers
(`http://127.0.0.1:<port>`) rather than doing inference in the Node
process itself.

Supervision (keeping the two model servers themselves alive) is a
provisioning concern, not an app-code one — same territory as the
still-open "provisioning story for a new satellite" question in
`designs/satellites.md`. The natural answer once permanent kit exists is
systemd units alongside whatever runs the satellite process itself
(cloud-init-style, mirroring the central server's own pattern in `infra/
cloud-init.yaml.tpl`); not designed further here.

### Config (local, not secret)

New env vars on the satellite, same tier as `HOUSE_ID`/
`SPOTIFY_ACCOUNT_SN` — local deployment facts, never through
`secrets.js`'s `op://` machinery:

- `WHISPER_SERVER_URL` (e.g. `http://127.0.0.1:8081`) — unset means
  `speech.stt` is `false`.
- `PIPER_SERVER_URL` (e.g. `http://127.0.0.1:8082`) — unset means
  `speech.tts` is `false`.

Model/voice selection (which `.bin`/`.onnx` file) is config *for those
processes*, not the satellite — the satellite only needs to know they're
reachable, not which model they're running.

### One constraint that carries over unchanged

`server.js` already notes that the Web Speech API "requires a secure
context on a non-localhost origin" and is "silently unavailable, not
just degraded" without `TLS_CERT_PATH`/`TLS_KEY_PATH` set. `MediaRecorder`
/`getUserMedia` (what capture switches to) has exactly the same secure-
context requirement — so a station relying on local STT needs that
`tailscale cert`-minted TLS already documented for the browser-API case,
for the identical reason, not a new one.

## What doesn't change

- Hub → satellite dispatch, house attribution, `resolve_*`/`control_*`
  tool shapes, approval gating — none of it. Speech never crosses into
  the central backend; only the text it produces does, at the same trust
  level typed text already has.
- The browser-API prototype isn't deleted — it's the permanent fallback
  for every deployment without this hardware, and stays the *only* path
  for phone/laptop (a Pi's mic/speaker mean nothing to a phone in your
  pocket).
- No new `TOOL_REGISTRY` entry, no new item status, no new approval
  surface.

## Open questions

- **Push-to-talk vs wake-word.** This design keeps push-to-talk (hold to
  record, on the station; toggle on the general frontend — see Capture
  above) rather than an always-listening mic as the trigger everywhere.
  It's the smallest thing that needs no new judgment calls (no
  false-positive wake detection, no always-listening privacy question).
  The original repo-structure sketch in CLAUDE.md names a `station/
  wakeword.py` for "always-on voice" as a future direction; worth
  revisiting once push-to-talk is proven, but deliberately out of scope
  here — a continuously-listening mic is a materially bigger privacy and
  false-trigger surface than a button, and the opposite of the "live
  only between explicit on and off" property this design is built
  around, whichever gesture provides that on/off.
- **Auto-submit on release?** Raised above — not decided here. Today's
  on-screen (toggle) button lands the transcript in the field for a
  glance/edit rather than auto-sending; a held physical button reads as
  a more deliberate "I meant this" than a tap, so auto-submit is at least
  defensible for the station in a way it isn't for a tap — but that's a
  real UX call to make deliberately, not a default to fall into just
  because hold-to-talk was wired up.
- **Auto-stop on silence** while the station's button is held, ending the
  recording on its own if someone trails off before releasing — a
  nice-to-have, not needed to ship hold-to-talk.
- **Barge-in** — interrupting an in-progress `/api/speak` playback if a
  new capture starts while the station is still talking. `speak()`
  already `cancel()`s an in-flight browser utterance on every call
  (per-item vs auto-speak race); the local-audio equivalent (swap the
  `<audio>` element's `src`, or an explicit stop call) needs the same
  treatment, not yet designed in detail.
- **Model/voice provisioning** — where the `.bin`/`.onnx` files
  themselves come from and land on a new Pi is the same open question
  `designs/satellites.md` already has for satellite provisioning
  generally; not solved specially for speech.
- **Audio transcode**, if `MediaRecorder`'s default container (`audio/
  webm`, Opus-encoded) turns out not to be what the chosen `whisper.cpp`
  server build accepts directly (it typically wants 16kHz mono WAV) —
  likely a small `ffmpeg`-backed conversion step inside `speech.js`
  before handing off; not yet confirmed against a real build.
