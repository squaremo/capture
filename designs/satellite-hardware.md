# Satellite hardware: kiosk box and voice capture

Status: hardware in hand (a Pi 4B, a WM8960 audio HAT — see the Parts
list correction below), not yet booted. This covers
the physical form permanent satellite kit should take (see Running modes
in `designs/satellites.md`, which leaves "how house-id and local device
config get onto the box" as an open provisioning question) and the
voice-input design that goes with it — targeting the Station shell
(`station.js`, see the Station entry in `CLAUDE.md`), which is what a
kiosk box actually runs today, not the plain phone/laptop inbox layout.
Captured now so there's a plan to build against once hardware arrives.

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
| Screen | Official Raspberry Pi Touch Display 2, **7"** (DSI, portrait-native 720×1280) | Clean cabling, long-term official driver support. A budget HDMI touchscreen (e.g. SunFounder 5" 800×480) is a cheaper fallback with bulkier cabling. Corrected from an earlier "5"" here — the unit actually in hand is the 7" model; see "Touch Display 2 setup" below for what it took to get both video and touch working. |
| Mic/Speaker | ~~Plain USB microphone capsule~~ / ~~Pi 4's 3.5mm jack~~ — **superseded**: a WM8960-codec audio HAT (Waveshare), now actually in hand | Combines mic array + speaker output on one board via I2S, driven by an out-of-tree DKMS module (see "WM8960 audio HAT" below) rather than USB/analog-jack. This specific board has a pass-through header exposing the full 40-pin GPIO, unlike the generic WM8960 boards a first search turned up — confirmed by hand, not assumed — so it doesn't reopen the ReSpeaker rejection's GPIO-header problem below after all. |
| Physical PTT button | Standalone arcade/momentary push-button, wired to a free GPIO pin + GND, panel-mounted through the case | Still viable via the WM8960 HAT's pass-through header, above. |
| Case | SmartiPi Touch 2 | Purpose-built for a Pi + official touch display. Panel-mounting the button means drilling one hole per unit — needs a repeatable jig/template if this gets built more than once. |
| microSD | 32GB | |

Rough total: $135–165 per unit, fully repeatable (same SD image, same
case, same drill template).

## WM8960 audio HAT

The WM8960 codec isn't in the mainline Pi kernel, so getting it working
means a DKMS-built out-of-tree kernel module rather than just a
`dtoverlay` line — DKMS specifically so it survives future kernel
upgrades from `unattended-upgrades` (see "OS maintenance" below),
rebuilding itself automatically rather than breaking on the next one.
Wired into `infra/cloud-init-satellite.yaml.tpl`: clone the **official**
[`waveshareteam/WM8960-Audio-HAT`](https://github.com/waveshareteam/WM8960-Audio-HAT)
repo and run its `install.sh` — confirmed non-interactive, doesn't
reboot itself (a `power_state: {mode: reboot}` at the end of the
cloud-config handles that instead — never call `reboot` directly inside
`runcmd`, cloud-init would never reach the remaining steps), installs
its own build deps (`raspberrypi-kernel-headers`/`dkms`/`i2c-tools`/
`libasound2-plugins` — the headers package specifically because it
tracks whatever kernel is actually running, which is what lets DKMS's
own auto-rebuild-on-upgrade keep working later too), and writes
`dtparam=i2c_arm=on`/`i2s=on` + `dtoverlay=i2s-mmap`/`wm8960-soundcard`
into `/boot/firmware/config.txt` itself (the correct path on Trixie's
boot layout).

**Corrected from an earlier version of this doc, which pointed at a
stale `jozolab/WM8960-Audio-HAT-bookworm` fork and called this a known,
unresolved kernel-6.12 risk** — that was true of the fork, and of the
open upstream issues it was based on
([waveshareteam/WM8960-Audio-HAT#68](https://github.com/waveshareteam/WM8960-Audio-HAT/issues/68),
[#63](https://github.com/waveshareteam/WM8960-Audio-HAT/issues/63)), but
**the official repo has since actually fixed it**: "Modified the
install script to support new 6.12 kernel" (PR #79, merged 2025-08-18),
with 6.18.x support following (#84, 2026-06-30) — well past Trixie's
6.12 LTS. Should work now, but this project hasn't run it against real
hardware yet, so verify after boot rather than assume:

```
dkms status               # should list wm8960-soundcard as installed
aplay -l && arecord -l    # should list the card
dmesg | grep -i wm8960    # if it didn't load
```

A build failure here doesn't block anything else in the cloud-config (a
failing `runcmd` step doesn't stop the ones after it, and the reboot
still happens). If it still doesn't build, the fallback is the
originally-planned plain USB mic + the Pi 4's 3.5mm jack from the
superseded Parts list row above — worth keeping in mind rather than
sinking more time into a kernel
incompatibility this project doesn't control.

This specific board **does** have a pass-through header exposing the
full 40-pin GPIO (confirmed by hand, not assumed from a generic WM8960
HAT search, which turned up boards without one) — so unlike the
ReSpeaker rejection below, it doesn't block the physical PTT button's
GPIO wiring.

## Touch Display 2 setup

Confirmed working on real hardware after three separate, independent
issues — video, then touch detection, then a boot-timing race — each
needing its own fix, wired into `infra/cloud-init-satellite.yaml.tpl`'s
"Touch Display 2 (7")" `runcmd` section and `fix-goodix-touch.service`:

1. **Video worked out of the box** (the default `vc4-kms-v3d` overlay's
   generic DSI panel probing was enough for the `ili9881c-dsi` panel
   driver to bind), but **touch did nothing at all** — no touch device
   anywhere in `/proc/bus/input/devices`. Needed an explicit
   `dtoverlay=vc4-kms-dsi-ili9881-7inch` in `/boot/firmware/config.txt`
   — the specific panel overlay, not just the generic KMS one, is what
   actually instantiates the bundled Goodix touch controller in the
   device tree at all.
2. Even with that overlay, touch device registration was still flaky
   depending on when in the boot sequence it was checked. Root cause
   found in `dmesg`: `Goodix-TS 10-005d: I2C communication failure: -5`
   — the kernel's `goodix_ts` driver probes before the chip is actually
   ready to answer on I2C after a *software* reboot specifically (not a
   full power cycle), fails once, and never retries on its own. This is
   a documented issue against this exact display, not something
   specific to this project. Fix: `fix-goodix-touch.service`, a oneshot
   unit that does `rmmod goodix_ts` (`-` prefixed so a failure there —
   e.g. the module never loaded — doesn't block what follows) then
   `modprobe goodix_ts`, forcing a fresh probe once the system's further
   along and the chip has settled. Confirmed on real hardware: the
   device (`10-005d Goodix Capacitive TouchScreen`) registers cleanly
   after this reload, having failed silently before it.
3. **The panel is portrait-native** (720×1280) — landscape needed a
   `panel_orientation` value on the `video=` kernel cmdline parameter in
   `/boot/firmware/cmdline.txt`, Bookworm/Trixie's Wayland-era
   replacement for the old `display_rotate=` setting. Specifically a
   DRM-level property, which matters here: `cage` is a KMS/DRM-native
   Wayland compositor, so it respects this correctly, unlike legacy
   console-only rotation tricks that don't affect apps drawing straight
   to DRM. `left_side_up` vs. `right_side_up` depends on which way the
   panel is physically mounted — confirmed correct for this build, but
   worth flipping on a second unit if it comes up rotated the wrong way.

## Display stack: minimal, not headless

Correction to earlier guidance in this conversation (and implicitly to
`designs/satellite-provisioning.md`, which describes the OS pick as
"headless"): that's right for a voice-only/no-screen satellite (Sonos or
Dirigera control alone), but this box has a touchscreen specifically so
the Station shell (`station.js`) can render on it, and Station is a
browser UI — Raspberry Pi OS **Lite** has no display server or browser at
all, so nothing paints to the screen as configured so far.

Fix is not switching to the full Desktop image — that pulls in a login
manager, taskbar, and file manager, none of which a wall-mounted kiosk
wants — but three minimal pieces layered on top of Lite, the standard
Raspberry-Pi-documented kiosk pattern:

1. A minimal Wayland compositor — `labwc` is the current
   Foundation-recommended lightweight pick (no panel, no desktop, just
   enough to run one fullscreen client) — the actual OS in use is
   Raspberry Pi OS **Trixie** (Debian 13, released Oct 2025), not
   Bookworm as earlier drafts of this doc assumed; `labwc` is current on
   both. An earlier version of this build used `cage` instead — see
   "Switched cage → labwc" below for why that changed.
2. Chromium, launched `--kiosk --app=http://localhost:<port>/?station`
   against this same box's own satellite process (see Satellite-served
   frontend in `designs/satellites.md` — no separate hosting needed,
   it's already serving the frontend build locally).
3. Console autologin + autostart, so the compositor + Chromium launch
   with no keyboard interaction ever needed after boot.

Added to `infra/cloud-init-satellite.yaml.tpl`: `labwc`/`seatd`/
`chromium` packages, a `getty@tty1` autologin drop-in, `kiosk.sh`
(launched from the kiosk account's `.bash_profile` on tty1 only,
exports `XDG_RUNTIME_DIR` and execs `labwc`), and a
`~/.config/labwc/autostart` script that launches Chromium against this
same box's own satellite process, in a respawn loop for resilience.

**Corrected against real hardware**: earlier guidance here said
`chromium-browser` was confirmed to exist on Trixie — true as a package
name, but wrong in the way that mattered. It installs as a
transitional/dependency-only package on this repo that doesn't provide
its own binary of that name; the actual client binary is plain
`chromium`. Surfaced as `cage`'s "Failed to spawn client: No such file
or directory" once everything else (XDG_RUNTIME_DIR, seat access) was
already working — a reminder that "the package exists" isn't the same
claim as "the binary you're about to exec exists."

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
| `whisper-stream` (**implemented**) | Hold to record, release to stop | In-page, on-screen button | `MediaRecorder` captures while held (capped at 25s — see below); on release, the page itself POSTs the audio to `POST /api/transcribe` and gets the transcript back synchronously in the response |
| `whisper-gpio` (new) | Hold the physical button, release to stop | Outside the browser entirely | A background script (the `station/wakeword.py`-shaped piece, not yet written) watches the GPIO pin directly, records for the duration held, and calls the same local `whisper.cpp` endpoint |

`webspeech` stays exactly as it is — it's the right tradeoff for laptop
dev, where convenience beats privacy and there's no satellite hardware
involved anyway. The other two are satellite-only.

**`whisper-stream` is implemented** (`createCaptureInput`'s
`setupWhisperStream()` in `frontend/src/components/capture.js`,
`POST /api/transcribe` in `satellite/server.js`) but **not the local
`whisper.cpp` service itself** the way this section originally
described it — that ended up as a separate, optional `whisper/`
directory/image (own `Dockerfile`, own Fastify server) rather than code
baked into the satellite, specifically so a box with no mic hardware, or
one that hasn't opted in, never pulls whisper.cpp/ffmpeg/the model at
all. `satellite/services/whisper.js` is just an HTTP client to it
(`WHISPER_URL`); see `whisper/README.md` and
`infra/enable-satellite-whisper.sh` (the one-command way to turn it on
for an already-bootstrapped box) for the actual shape. `whisper-gpio`
would still share that same service once it exists — only what triggers
the recording differs.

Unverified against real Pi hardware yet either way — written and
buildable, not yet confirmed against a live mic capture or a real
arm64 image build (whisper.cpp is built from source in `whisper/
Dockerfile`'s multi-stage build specifically because no arm64 binary
release exists to just fetch).

The 25s hold cap (`WHISPER_MAX_RECORD_MS` in `capture.js`) comes from
Whisper's own architecture, not a UX guess: the encoder always processes
a fixed 30-second window per call (positional embeddings sized for
exactly that), so anything longer either gets silently truncated or
needs chunking — 25s leaves headroom under that hard limit rather than
capping right at it. Model choice is `tiny.en`, baked into the
`whisper/` image — see the RAM/CPU tradeoff discussion this design
session had: `base` is roughly 2x `tiny`'s footprint on a Pi 4 2GB
that's already running a Chromium kiosk.

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

### Landing a transcript when Station isn't idle

`whisper-stream`'s on-screen button lives inside `paneIdle`'s capture
field (`createCaptureInput`, embedded by `station.js`), which `setMode()`
only shows when `mode === 'idle'` — so that mode never has to think about
Station's other panes; the button simply isn't there otherwise.

`whisper-gpio` doesn't have that luxury: the physical button is live
regardless of what's on screen, and a press can land while Station is
`thinking` (a capture already in flight) or `review` (a previous proposal
waiting on a decision), not just `idle`. Station already solves almost
this exact problem for a different trigger: typing while in `review` sets
the current proposal aside (`doSetAside()` — pushes it onto the `waiting`
FIFO, calls `setMode('idle')`) and starts a fresh capture with that
keystroke (see the `keydown` handler in `station.js`). A `whisper-gpio`
transcript arriving during `review` should do exactly that, with the
whole transcript standing in for the one keystroke, rather than inventing
a second way to interrupt a review.

`thinking` has no equivalent interrupt today — there's nothing yet to set
aside, since the in-flight capture hasn't resolved into an item. Safest
option: queue the transcript (one pending slot is enough — push-to-talk
is a deliberate one-off action, last one wins) and apply it, via the same
`review`/`idle` handling above, once `setMode()` next moves off
`thinking`, rather than clobbering state mid-resolution. `list` mode (a
recalled checklist/shopping list) has nothing to interrupt into either,
so it's handled the same way as `thinking` here.

### Mode selection

**Implemented**, via `GET /config.json`'s `voiceMode` field, alongside
`defaultHouse`/`backendUrl` (see House attribution in
`designs/satellites.md`) — same build-once/configure-per-deployment
split already used for house identity. `satellite/server.js` reports
`voiceMode: 'whisper-stream'` when `WHISPER_URL` is set (i.e. the
separate `whisper` service is configured), `'webspeech'` otherwise;
`createCaptureInput({ voiceMode })` in `capture.js` picks the mode
accordingly. The general/laptop deployment has no `/config.json` at all,
so it always falls back to `webspeech`. `whisper-gpio`, once it exists,
would report `voiceMode: 'whisper-gpio'` (or both, if a satellite ever
wants the on-screen button available too) the same way.

## OS maintenance: unattended-upgrades

A satellite is headless kit with no one watching for OS security updates,
so package upgrades should apply themselves rather than depend on someone
remembering to SSH in and `apt upgrade`. Raspberry Pi OS (Debian-based)
ships this as `unattended-upgrades`:

```bash
sudo apt install unattended-upgrades apt-listchanges -y
sudo dpkg-reconfigure --priority=low unattended-upgrades
```

Worth setting deliberately in `/etc/apt/apt.conf.d/50unattended-upgrades`
for a box with no keyboard/monitor attached:

```
Unattended-Upgrade::Origins-Pattern {
    "origin=Raspbian,codename=${distro_codename},label=Raspbian";
    "origin=Raspberry Pi Foundation,codename=${distro_codename},label=Raspberry Pi Foundation";
};
Unattended-Upgrade::Remove-Unused-Dependencies "true";
Unattended-Upgrade::Automatic-Reboot "true";
Unattended-Upgrade::Automatic-Reboot-Time "04:00";
```

`Automatic-Reboot` matters here specifically because kernel/firmware
updates need a reboot to take effect and there's no one to press a button
for it. This is OS-package scope only — separate from the app's own
Docker images (if the whisper.cpp wrapper/kiosk browser end up
containerised on the box, that's Watchtower's job, same as the Hetzner
box) and from Tailscale's own self-update mechanism.

Candidate for folding into a cloud-init-style first-boot script for this
box later (mirroring `infra/cloud-init.yaml.tpl`'s pattern), once the
provisioning story below is actually written — not done yet, this is
still a manual post-flash step.

## Switched cage → labwc

Investigating TODO #1 below (browser stayed portrait despite the
console being correctly rotated) turned up the actual cause: `cage`
(this OS's packaged version) ignores the DRM `panel_orientation`
property entirely — it only supports *static* rotation passed at its
own startup, not automatic detection, which is exactly the mechanism
`panel_orientation` relies on. `labwc` honours the property at output
init instead, the same way the tty console already does.

That also mattered for TODO #4 (on-screen keyboard): `cage` is
deliberately single-client-only with no `wlr-layer-shell` support at
all, which any Wayland virtual keyboard (`squeekboard`, `wvkbd`) needs
just to exist as an overlay surface in the first place. `labwc`
implements layer-shell. **This does not, by itself, fix TODO #4** —
getting a keyboard to actually render *above* a fullscreen Chromium
kiosk is a separate, still-open upstream problem
([labwc/labwc#2926](https://github.com/labwc/labwc/issues/2926)):
squeekboard/wvkbd are hardcoded to a layer that sits below labwc's
"fullscreen windows" layer, so a fullscreen Chromium still covers them
regardless of compositor. Switching compositors was a necessary step
toward a keyboard, not a complete fix.

Mechanically: `cage`'s whole model was "take one client as a
command-line argument, run only that." `labwc` is a real (if
minimal) window manager with its own autostart mechanism instead —
`kiosk.sh` now just execs `labwc` (still exporting `XDG_RUNTIME_DIR`
first, same requirement as before), and a new
`~/.config/labwc/autostart` script launches Chromium as a background
child. That shape change costs one thing worth calling out: under
`cage`, a Chromium crash ended the whole tty1 login session, which
`getty` then restarted — crude, but a real self-healing mechanism.
Under `labwc`, Chromium is just a background child of a script that
otherwise exits immediately; without deliberately adding one back, a
crash would leave `labwc` running with a blank screen and nothing to
recover it. Fixed with a respawn loop (`while true; do chromium ...;
sleep 2; done &`) in the autostart script itself, rather than losing
that resilience in the compositor switch.

## Live troubleshooting TODOs

Recorded during hands-on debugging of `capture-station-1`:

1. The console/tty text is correctly rotated to landscape, but the
   browser was still rendering portrait. **Still not actually fixed**:
   switching to `labwc` (see "Switched cage → labwc" above) was
   expected to resolve this via automatic `panel_orientation` detection
   at output init, same as the tty console — confirmed on real hardware
   that it does **not**, Chromium still comes up portrait under `labwc`
   too. Next step in progress: an explicit `<output>` transform in
   `labwc`'s own `rc.xml` (rather than relying on automatic detection at
   all) — exact XML syntax not yet confirmed, most reference docs for it
   were unreachable mid-investigation (network egress blocks on
   labwc.github.io, the Debian/Ubuntu/openSUSE manpage mirrors,
   ArchWiki, GitHub Gist, and the Raspberry Pi forum thread that likely
   had a working example) — needs picking back up with better access or
   a different source.
2. Hide the mouse pointer — there's no mouse on a touchscreen kiosk, so
   a visible cursor sitting on screen is pure visual noise. Likely a
   Chromium flag (something in the `--kiosk`/cursor-autohide family) or
   an `labwc`/`wlr` idle-inhibit-adjacent setting; not yet looked into.
3. ~~How to actually check the WM8960 mic works, beyond `dkms
   status`/`aplay -l`/`arecord -l`.~~ **Confirmed working on real
   hardware**: `card 0: wm8960soundcard` shows for both playback and
   capture; recording via `arecord -D plughw:wm8960soundcard,0 -f
   S16_LE -r 44100 -d 5 <file>` then playing back via `aplay -D
   plughw:wm8960soundcard,0 <file>` round-tripped real audio
   successfully (confirmed through headphones plugged into the HAT's
   jack, not yet tried with a separate powered speaker). Full loopback
   test added to `infra/satellite-smoke-test.md` §7.
4. Enable an on-screen keyboard — a touchscreen kiosk needs one for any
   text entry (the capture textarea itself) since there's no physical
   keyboard attached. `labwc` (above) is a necessary step, not a
   complete fix — the layer-ordering problem
   ([labwc/labwc#2926](https://github.com/labwc/labwc/issues/2926))
   that hides squeekboard/wvkbd behind a fullscreen Chromium kiosk is
   still open and unresolved upstream. Not yet attempted.

## Open questions

- ~~Exact shape of the local `whisper.cpp` service~~ **Decided and
  implemented**: a small hand-written wrapper (`whisper/`), not
  `whisper.cpp`'s bundled `server` example — a separate, optional
  image/Compose service from the satellite itself, gated by
  `WHISPER_URL`/a Compose profile so an opted-out box never pulls it.
  The SSE push endpoint `whisper-gpio` will need is still open — not
  added yet, since `whisper-gpio` itself isn't built.
- Model size/quantization for real-time performance on a Pi 4 —
  **decided**: `tiny.en`, baked into the `whisper/` image
  (`WHISPER_MODEL_PATH`), not `base` — see the RAM/CPU tradeoff
  discussion (`base` is roughly 2x `tiny`'s footprint on a Pi 4 2GB
  already running a Chromium kiosk). Still not benchmarked against real
  hardware.
- ~~Provisioning: how the satellite is told which voice-input mode(s) it
  supports~~ **Decided and implemented** for `whisper-stream`: `GET
  /config.json`'s `voiceMode` field (see Mode selection above), and
  `infra/enable-satellite-whisper.sh` for turning the underlying service
  on post-boot. The physical-button GPIO pin assignment and case drill
  template question (for `whisper-gpio`) is still open.
- The `thinking`/`list` queue-and-apply-later behaviour for `whisper-gpio`
  (see Landing a transcript when Station isn't idle) is a proposal, not
  yet validated against how often a physical-button press would actually
  land mid-`thinking` in practice — worth revisiting once there's real
  usage to observe.
- Whether the WM8960 driver actually builds on this box's kernel (6.12,
  via Trixie) — see "WM8960 audio HAT" above. Upstream has since fixed
  the specific 6.12 build failure this project first ran into, but it's
  still unverified by this project against real hardware; check `dkms
  status` after first boot rather than assuming it worked.
- Hardware is now in hand (Pi 4B, WM8960 HAT) but not yet booted, so
  most of the above — this driver included — is still unverified against
  anything real.
