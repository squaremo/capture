// Standalone daemon for the custom control board (designs/station-
// hardware.md): the white (standby) and red (live-mic) LEDs, and the
// volume knob — a potentiometer digitised by an MCP3008 over SPI0.
//
// Deliberately NOT part of the Dockerized satellite app
// (../satellite/) — GPIO/SPI access from inside that container would
// need its own device-passthrough plumbing, the exact kind of
// complexity this project already avoids for other host-level hardware
// (the backlight and CPU-governor pieces in
// infra/cloud-init-satellite.yaml.tpl are plain host systemd services
// for the same reason, not Compose services). Runs instead as its own
// systemd unit directly on the Pi — see that file's
// capture-control-panel.service.
//
// Dimming: swayidle's existing timeout/resume hooks (same file, right
// next to backlight.sh) now also signal this process — SIGUSR1 on
// timeout (screen about to blank), SIGUSR2 on resume — so the white LED
// dims while the kiosk display is asleep rather than staying at full
// brightness all night. Implemented as a software-toggled duty cycle
// over the plain GPIO line (no hardware PWM wired up for this), which
// may visibly flicker rather than looking smoothly dim — flagged below;
// if that's a problem once there's a real LED to look at, the fix is
// wiring the white LED to GPIO12 or GPIO13 specifically (the Pi's
// hardware PWM0/PWM1 pins, confirmed free in station-hardware.md's pin
// map) and driving it via the kernel's sysfs PWM interface instead of
// onoff, rather than fighting software PWM further.
//
// UNVERIFIED AGAINST REAL HARDWARE, same caveat as the rest of
// designs/satellite-hardware.md until this board is actually built and
// wired up:
//   - `onoff`'s sysfs GPIO interface (/sys/class/gpio) is deprecated on
//     recent kernels in favour of the libgpiod character-device API —
//     it may simply not work on this box's Trixie kernel. If so, swap
//     to a libgpiod-based package (e.g. `node-libgpiod`) instead of
//     fighting onoff.
//   - CTRL_MIXER_CONTROL's default ('Speaker') is a guess, not a
//     confirmed WM8960 ALSA control name — run `amixer -c wm8960soundcard
//     scontrols` on the real box and set this explicitly once known
//     (see ../infra/satellite-smoke-test.md's `alsamixer -c 0` step).
//   - CTRL_MIC_STATUS_PATH's default (card0/pcm0c) is a guess at which
//     ALSA capture substream is the WM8960's — confirm with `cat
//     /proc/asound/cards` + `ls /proc/asound/card0/` on the real box.
//   - The software-PWM dimming's flicker, noted above.

import { execFile } from 'child_process'
import { readFileSync } from 'fs'
import Gpio from 'onoff'
import SpiDevice from 'spi-device'

const LED_WHITE_GPIO = parseInt(process.env.CTRL_LED_WHITE_GPIO, 10)
const LED_RED_GPIO = parseInt(process.env.CTRL_LED_RED_GPIO, 10)
if (!Number.isInteger(LED_WHITE_GPIO) || !Number.isInteger(LED_RED_GPIO)) {
  console.error('control-panel: CTRL_LED_WHITE_GPIO and CTRL_LED_RED_GPIO must both be set — exiting')
  process.exit(1)
}

// Fixed by the Pi's hardware SPI0 controller, not a free choice — see
// designs/station-hardware.md's Open questions correction. The MCP3008
// sits on CE0.
const SPI_BUS = 0
const SPI_DEVICE = 0
const MCP3008_CHANNEL = 0 // only CH0 is wired, to the pot's wiper

const MIXER_CARD = process.env.CTRL_MIXER_CARD || 'wm8960soundcard'
const MIXER_CONTROL = process.env.CTRL_MIXER_CONTROL || 'Speaker'

// ALSA's own live capture-substream state, not an application-level flag
// — true whenever anything (whisper-gpio once it exists, a manual
// `arecord` test, anything) actually has the mic open, so the red LED
// reflects real hardware state rather than needing every future caller
// to remember to signal it. No inotify equivalent exists for /proc
// pseudo-files, so this is polled on the same interval as the pot
// rather than watched.
const MIC_STATUS_PATH = process.env.CTRL_MIC_STATUS_PATH
  || '/proc/asound/card0/pcm0c/sub0/status'

const POLL_INTERVAL_MS = 150
const SMOOTHING_ALPHA = 0.2 // exponential moving average, 0–1: higher = more responsive, noisier
const VOLUME_CHANGE_THRESHOLD = 2 // percentage points — avoids spawning amixer on every tiny jitter

const DIM_PWM_PERIOD_MS = 20 // ~50Hz software toggle — see flicker caveat above
const DIM_DUTY_FRACTION = 0.15 // how bright "dimmed" is, as a fraction of full brightness

const whiteLed = new Gpio(LED_WHITE_GPIO, 'out')
const redLed = new Gpio(LED_RED_GPIO, 'out')

let spi = null
let smoothedReading = null // 0–1023, null until the first sample lands
let lastAppliedVolume = null // 0–100, null until first applied
let dimmed = false
let dimPwmHandle = null

startWhiteLed()

spi = SpiDevice.open(SPI_BUS, SPI_DEVICE, (err) => {
  if (err) {
    console.error(`control-panel: failed to open SPI bus (${err.message})`)
    process.exit(1)
  }
})
setInterval(() => {
  pollPot()
  pollMic()
}, POLL_INTERVAL_MS)

// Sent by swayidle's timeout/resume hooks (see
// infra/cloud-init-satellite.yaml.tpl) alongside the existing
// backlight.sh/cpu-power.sh calls — this process's own PID is what
// `systemctl kill -s SIGUSR1 capture-control-panel.service` targets.
process.on('SIGUSR1', () => { dimmed = true; startWhiteLed() }) // console going to sleep
process.on('SIGUSR2', () => { dimmed = false; startWhiteLed() }) // console waking up

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    if (dimPwmHandle) clearInterval(dimPwmHandle)
    whiteLed.writeSync(0)
    redLed.writeSync(0)
    whiteLed.unexport()
    redLed.unexport()
    spi?.close()
    process.exit(0)
  })
}

function startWhiteLed() {
  if (dimPwmHandle) {
    clearInterval(dimPwmHandle)
    dimPwmHandle = null
  }
  if (!dimmed) {
    whiteLed.writeSync(1) // full brightness — standby/on indicator
    return
  }
  // Software PWM: on for DIM_DUTY_FRACTION of each period, off the rest.
  // See the flicker caveat in the file header.
  const onMs = Math.round(DIM_PWM_PERIOD_MS * DIM_DUTY_FRACTION)
  whiteLed.writeSync(1)
  dimPwmHandle = setInterval(() => {
    whiteLed.writeSync(1)
    setTimeout(() => whiteLed.writeSync(0), onMs)
  }, DIM_PWM_PERIOD_MS)
}

function pollMic() {
  let status
  try {
    status = readFileSync(MIC_STATUS_PATH, 'utf8')
  } catch {
    return // wrong path for this hardware, or nothing's opened the substream yet — leave the LED as last set
  }
  redLed.writeSync(/state:\s*RUNNING/.test(status) ? 1 : 0)
}

function pollPot() {
  // MCP3008 single-ended read, channel 0: start bit, then the channel
  // select nibble (0b1000 for CH0, single-ended), then a dummy byte to
  // clock out the 10-bit result — see the datasheet's "Serial Communication"
  // timing diagram. Reply's middle byte's low 2 bits + all of the third
  // byte make up the 10-bit reading.
  const message = [{
    sendBuffer: Buffer.from([0x01, (0x08 | MCP3008_CHANNEL) << 4, 0x00]),
    receiveBuffer: Buffer.alloc(3),
    byteLength: 3,
    speedHz: 1350000, // MCP3008's max at 3.3V supply, per datasheet
  }]
  spi.transfer(message, (err, result) => {
    if (err) return // transient SPI error — just skip this sample, next poll retries
    const raw = ((result[0].receiveBuffer[1] & 0x03) << 8) | result[0].receiveBuffer[2]
    smoothedReading = smoothedReading === null
      ? raw
      : smoothedReading + SMOOTHING_ALPHA * (raw - smoothedReading)
    applyVolume(readingToVolume(smoothedReading))
  })
}

// Squared curve, not linear: the pot itself is linear-taper (deliberately
// — see designs/station-hardware.md's Scope section), so the perceptual
// log/audio-taper shaping belongs here in software instead. Squaring a
// 0–1 fraction is a cheap, standard approximation of a log-ish audio
// taper — swap for a proper dB-scaled mapping if this doesn't feel right
// in practice once there's a real knob to turn.
function readingToVolume(reading) {
  const fraction = Math.max(0, Math.min(1, reading / 1023))
  return Math.round(100 * fraction * fraction)
}

function applyVolume(volume) {
  if (lastAppliedVolume !== null && Math.abs(volume - lastAppliedVolume) < VOLUME_CHANGE_THRESHOLD) {
    return
  }
  lastAppliedVolume = volume
  execFile('amixer', ['-c', MIXER_CARD, 'sset', MIXER_CONTROL, `${volume}%`], (err) => {
    if (err) console.error(`control-panel: amixer failed (${err.message})`)
  })
}
