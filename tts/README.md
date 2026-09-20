# tts

Local speech synthesis (playback) — the mirror image of `../whisper/`
(text in, audio out instead of audio in, text out). A standalone
service, deliberately **not** part of the `satellite` image, same
reasoning as `whisper/`: a satellite that hasn't opted in should never
pull Piper or any voice model. `satellite/services/tts.js` is a thin
HTTP client to this service, gated by `TTS_URL` — unset, `speech.js`
falls back to the browser's own `speechSynthesis` (which, on the Linux
Chromium a kiosk actually runs, typically has no voices installed at
all — see `designs/satellite-hardware.md`'s playback section).

## Protocol

`POST /synthesize` — body `{ "text": "...", "voice"?: "..." }`. `voice`
is optional, defaulting to `PIPER_VOICE` (see below); if given, it must
be one of the voices `GET /voices` lists. On success: raw WAV bytes,
`Content-Type: audio/wav`. On failure (empty text, unknown voice, Piper
erroring): `422 { "error": "..." }`.

`GET /voices` — `{ "voices": ["en_GB-alan-medium", ...] }`, whatever's
actually baked into this image (see the Dockerfile's `PIPER_VOICES`
build arg) — lets a caller discover what `voice` will accept without
reading the Dockerfile.

`GET /health` — `{ "ok": true }`.

## Voices: baked in, not built in

Piper ships with no voice at all — every voice is a separate model
(`<name>.onnx` + `<name>.onnx.json`), downloaded from
[`rhasspy/piper-voices`](https://huggingface.co/rhasspy/piper-voices) at
**build** time, not runtime: no network dependency once the image
exists, and no cold-start download delay on a Pi. The Dockerfile's
`PIPER_VOICES` build arg controls *which* voices end up on disk (default:
a curated handful of `en_GB` medium-quality voices —
`en_GB-alan-medium`, `en_GB-cori-medium`,
`en_GB-northern_english_male-medium` — matching the app's own dialect);
`PIPER_VOICE` (an env var, so it's a **runtime** choice, no rebuild
needed) picks which one actually speaks by default, and any request can
override it per-call via `voice` in `POST /synthesize`'s body. Rebuild
with `--build-arg PIPER_VOICES="en_GB-alan-medium en_US-lessac-medium"`
to change what's available at all — e.g. to add a non-GB accent as an
option.

`medium` quality is the sweet spot for a Pi 4 already running a Chromium
kiosk — genuinely natural-sounding, and Piper's inference is small/fast
enough (unlike Whisper's tiny-vs-base RAM/CPU tension) that `medium`
still runs comfortably real-time. See the full voice catalogue at
<https://huggingface.co/rhasspy/piper-voices> for other languages/
speakers/qualities.

**Unverified against real Pi hardware yet** — written and buildable, not
yet confirmed against a live playback, and the exact Piper release
tag/asset names in the Dockerfile are worth double-checking against
<https://github.com/rhasspy/piper/releases> before a first real build.
See Open questions in `../designs/satellite-hardware.md`.

## Run

### Via Docker (how a satellite actually runs this)

Not started by default — `../docker-compose.satellite.yml`'s `tts`
entry is behind a Compose profile. On a real, already-bootstrapped
satellite, `../infra/enable-satellite-tts.sh` does the whole thing in
one step (writes `TTS_URL` into the satellite's own `.env`, enables the
`tts` Compose profile, reconciles the stack):

    sudo /opt/capture-satellite/app/infra/enable-satellite-tts.sh

Doing it by hand instead:

    docker compose -f docker-compose.satellite.yml --profile tts up -d

Or add `COMPOSE_PROFILES=tts` (or `whisper,tts` if both are wanted) to
the satellite box's own compose project `.env`
(`/opt/capture-satellite/app/.env` — see `whisper/README.md`'s note on
why that's a different file from the `satellite` container's own
`/opt/capture-satellite/.env`) so `capture-satellite-sync.timer`'s
regular `docker compose up` picks it up. Either way, set the `satellite`
service's own `TTS_URL` (see `../satellite/.env.example`) — both
containers share the host network namespace (`network_mode: host`), so
the default `http://127.0.0.1:5002` just works.

### Locally, for dev

Needs a `piper` binary (download a release for your platform from
<https://github.com/rhasspy/piper/releases>, or point `PIPER_BIN_PATH`
at one) and at least one voice model pair downloaded into
`PIPER_MODELS_DIR` (default `/app/models`, so for local dev point this
somewhere real — see the Dockerfile's download step for the URL shape):

    cd tts
    npm install
    cp .env.example .env   # fill in PIPER_BIN_PATH/PIPER_MODELS_DIR/PIPER_VOICE
    npm start

Listens on `127.0.0.1:5002` by default — localhost-only, same reasoning
as `whisper/`: nothing outside this box should ever reach it directly.
