# Satellite hardware: kiosk box and voice capture

Status: design only — no hardware ordered, no code written. This covers
the physical form permanent satellite kit should take (see Running modes
in `designs/satellites.md`, which leaves "how house-id and local device
config get onto the box" as an open provisioning question) and the
voice-input design that goes with it. Captured now so there's a plan to
build against once hardware arrives.

## Wishlist

Small, repeatable, cheap. Kiosk-mode UI, ≤10" screen, push-to-talk with a
physical button, a speaker for reading results aloud, a case tying it
together.

## Pi kiosk over Android tablet

Considered a cheap Android tablet running the PWA under a kiosk browser
(e.g. Fully Kiosk Browser) instead. Rejected: a tablet has no clean path
to a physical push-to-talk button (would mean a bolted-on Bluetooth macro
button plus a Tasker-style automation layer, or a wired USB-OTG HID
button) and no clean path to local, on-device transcription either —
both are native fits for a Pi, which also lets the box run the exact same
PWA build as every other frontend instance (Chromium in kiosk mode)
rather than a second, Android-specific app.

## Parts list

| Part | Pick | Why |
|---|---|---|
| Compute | Raspberry Pi 4 (2GB) | Enough for Chromium kiosk + a small local Whisper model. Pi 5 was considered and rejected specifically for this build — see the audio jack note below. |
| Screen | Official Raspberry Pi Touch Display 2, 5" (DSI) | Clean cabling, long-term official driver support. A budget HDMI touchscreen (e.g. SunFounder 5" 800×480) is a cheaper fallback with bulkier cabling. |
| Mic | Plain USB microphone capsule | Plug-and-play; see the ReSpeaker rejection below for why this isn't a mic HAT. |
| Speaker | Small USB- or battery-powered speaker into the Pi 4's 3.5mm jack | Pi 4 has an analog audio jack; **Pi 5 dropped it entirely** (no 3.5mm jack, no composite), so this pick is what pins the compute choice to Pi 4 rather than 5. |
| Physical PTT button | Standalone arcade/momentary push-button, wired to a free GPIO pin + GND, panel-mounted through the case | See below — deliberately not the HAT's onboard button. |
| Case | SmartiPi Touch 2 | Purpose-built for a Pi + official touch display. Panel-mounting the button means drilling one hole per unit — needs a repeatable jig/template if this gets built more than once. |
| microSD | 32GB | |

Rough total: $135–165 per unit, fully repeatable (same SD image, same
case, same drill template).

### Rejected: ReSpeaker 2-Mic Pi HAT

Attractive at first glance — it bundles a mic array, a physical user
button, and audio out on one board that stacks straight onto the GPIO
header. Rejected because its onboard button sits on the HAT itself, which
ends up sandwiched behind the screen/case once assembled — not reachable
from outside. Decoupling instead: a plain USB mic (no beamforming needed,
since push-to-talk already means near-field — you're pressing a button
right next to it) and the Pi 4's own 3.5mm jack for audio out. Both
changes together leave the entire 40-pin header free, which is what makes
wiring a standalone, externally-mounted button straightforward instead of
fighting for header space.

## Voice input: three modes

The existing voice button (`voiceBtn` in `frontend/src/components/
capture.js`) is a custom-built button — not a browser built-in widget —
that currently wires up exactly one mode: click-to-toggle the Web Speech
API (`SpeechRecognition`/`webkitSpeechRecognition`), which streams audio
through Chrome's cloud speech service and fills the textarea with the
result. It does not auto-submit — capture/⌘↵ is still the only thing that
calls `POST /api/capture`. That "always lands in the textarea for human
review" behavior is the one rule that has to hold across every mode below,
including the two new ones.

| Mode | Trigger | Where it runs | Transcription |
|---|---|---|---|
| `webspeech` (existing) | Click to start, click to stop | Entirely in-page | Browser's built-in Web Speech API, cloud-processed |
| `whisper-stream` (new) | Hold to record, release to stop | In-page, on-screen button | `MediaRecorder` captures while held; on release, the page itself POSTs the audio to a local `whisper.cpp` HTTP endpoint and gets the transcript back synchronously in the response |
| `whisper-gpio` (new) | Hold the physical button, release to stop | Outside the browser entirely | A background script (the `station/wakeword.py`-shaped piece, not yet written) watches the GPIO pin directly, records for the duration held, and calls the same local `whisper.cpp` endpoint |

`webspeech` stays exactly as it is — it's the right tradeoff for laptop
dev, where convenience beats privacy and there's no satellite hardware
involved anyway. The other two are satellite-only and share one local
`whisper.cpp` service; they differ only in what triggers the recording.

### The bridge `whisper-gpio` needs that `whisper-stream` doesn't

`whisper-stream` needs no special plumbing: the page itself made the
request, so the transcript comes back as an ordinary HTTP response and
fills the textarea like `webspeech`'s `onresult` does.

`whisper-gpio` is different — the GPIO script is a separate OS process,
not the page, so it can't touch the DOM to fill the textarea itself. Fix:
the local `whisper.cpp` wrapper service also hosts a small SSE endpoint
(one-directional is enough — the page never needs to push anything back
over it) that the kiosk page subscribes to once on load. When the GPIO
script's transcription request finishes, the service pushes the resulting
text down that channel to whichever tab is listening, and the page fills
the textarea the same way the other two modes do. Audio never leaves the
device either way; the SSE channel only ever carries final text, to the
one browser tab sitting on the same box.

The physical button is also expected to wake the display if it's been
blanked to save the screen. That's an OS-level action (`vcgencmd`/DPMS),
so it lives in the GPIO script alongside the recording logic, not in the
page — the same reasoning that puts recording there: a native process can
do things a sandboxed kiosk tab can't reliably do to itself.

### Mode selection

Not yet decided in detail, but the natural fit is a runtime config flag
alongside `defaultHouse`/`backendUrl` in `GET /config.json` (see House
attribution in `designs/satellites.md`) — a satellite build reports
itself as `whisper-stream`(+`whisper-gpio`), everything else defaults to
`webspeech`. Keeps the same build-once/configure-per-deployment split
already used for house identity.

## Open questions

- Exact shape of the local `whisper.cpp` service — a small wrapper this
  project writes, or `whisper.cpp`'s own bundled `server` example reused
  as-is (it already speaks plain HTTP; would need the SSE push endpoint
  added or fronted separately for `whisper-gpio`).
- Model size/quantization for real-time performance on a Pi 4 — `tiny` or
  `base` English-only is the expectation for a few seconds of
  push-to-talk speech, not yet benchmarked against real hardware.
- Provisioning: how the satellite is told which voice-input mode(s) it
  supports, and how the physical-button GPIO pin assignment and case
  drill template are documented for repeat builds.
- No hardware has been ordered yet, so none of the above is verified
  against anything real.
