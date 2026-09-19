# whisper

Local speech-to-text for the `whisper-stream` voice-input mode — see
`../designs/satellite-hardware.md`'s "Voice input: three modes". A
standalone service, deliberately **not** part of the `satellite` image:
a satellite with no mic hardware, or one that just hasn't opted in yet,
should never pull whisper.cpp, ffmpeg, or the model file. `satellite/
services/whisper.js` is a thin HTTP client to this service, gated by
`WHISPER_URL` — unset, the satellite behaves exactly as it does today
(the browser's Web Speech API mic button, `webspeech` mode).

## Protocol

`POST /transcribe` — body is the raw audio bytes (`Content-Type:
audio/webm`, whatever the browser's `MediaRecorder` produced). On
success:

    { "text": "call the dentist tomorrow morning" }

On failure (bad/empty audio, ffmpeg or whisper.cpp erroring): `422 {
"error": "..." }`.

`GET /health` — `{ "ok": true }`, for a Compose healthcheck or manual
poke.

## Pipeline

Two external processes chained by `transcribe.js`, neither an npm
package — see the Dockerfile for how they get onto the image:

1. **ffmpeg** transcodes whatever arrived (webm/opus from Chromium) into
   the 16kHz mono 16-bit PCM WAV whisper.cpp's CLI expects.
2. **whisper.cpp**'s `whisper-cli` binary transcribes that WAV against
   the baked-in `tiny.en` model (`/app/models/ggml-tiny.en.bin`) and we
   read the transcript back off its stdout.

`tiny.en` (English-only) is the starting model — see the RAM/CPU
discussion in `../designs/satellite-hardware.md`: `base` is roughly 2x
`tiny`'s footprint on a Pi 4 2GB that's already running a Chromium
kiosk. Swap `WHISPER_MODEL_PATH`/the Dockerfile's downloaded model to try
a bigger one; no code change needed.

**Unverified against real Pi hardware yet** — written and buildable, not
yet confirmed against a live mic capture. See Open questions in
`../designs/satellite-hardware.md`.

## Run

### Via Docker (how a satellite actually runs this)

Not started by default — `../docker-compose.satellite.yml`'s `whisper`
entry is behind a Compose profile. On a real, already-bootstrapped
satellite, `../infra/enable-satellite-whisper.sh` does the whole thing in
one step (writes `WHISPER_URL` into the satellite's own `.env`, enables
the `whisper` Compose profile, reconciles the stack) — run it once, over
SSH, as root:

    sudo /opt/capture-satellite/app/infra/enable-satellite-whisper.sh

That's a deliberate opt-in step, not baked into first-boot provisioning
— see the script's own header comment for why (same treatment Dirigera
pairing gets). Doing it by hand instead is just the two things that
script automates:

    docker compose -f docker-compose.satellite.yml --profile whisper up -d

Or add `COMPOSE_PROFILES=whisper` to the satellite box's own compose
project `.env` (`/opt/capture-satellite/app/.env` — not the same file as
the `satellite` container's own `/opt/capture-satellite/.env`, see the
Compose file's comment) so `capture-satellite-sync.timer`'s regular
`docker compose up` picks it up without a one-off manual flag. Either
way, set the `satellite` service's own `WHISPER_URL` (see
`../satellite/.env.example`) — both
containers share the host network namespace
(`network_mode: host`), so the default `http://127.0.0.1:5001` just
works with no further config.

### Locally, for dev

Needs `ffmpeg` and a built `whisper-cli` (see the Dockerfile's build
stage for how) on `PATH`, or `FFMPEG_BIN_PATH`/`WHISPER_BIN_PATH` pointed
at them, plus a model file (`WHISPER_MODEL_PATH`):

    cd whisper
    npm install
    cp .env.example .env   # fill in WHISPER_BIN_PATH/WHISPER_MODEL_PATH
    npm start

Listens on `127.0.0.1:5001` by default — deliberately localhost-only,
tighter than the satellite's own Tailscale-address default, since
nothing outside the same box should ever reach this directly.
