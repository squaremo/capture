// Drives the custom control board from designs/station-hardware.md: the
// white (standby) and red (live-mic) LEDs, and the volume knob — a
// potentiometer digitised by an MCP3008 (SPI0, fixed pins — see that
// doc's §1/§3) rather than an incremental encoder.
//
// Gated the same way services/whisper.js is: this satellite never opens
// a GPIO line or the SPI bus unless both LED pins are actually
// configured, so a box with no control board (or running in plain dev,
// off-Pi) never touches hardware that isn't there.
//
// UNVERIFIED AGAINST REAL HARDWARE, same caveat as the rest of
// designs/satellite-hardware.md until this board is actually built and
// wired up:
//   - `onoff`'s sysfs GPIO interface (/sys/class/gpio) is deprecated on
//     recent kernels in favour of the libgpiod character-device API —
//     it may simply not work on this box's Trixie kernel. If so, swap
//     to a libgpiod-based package (e.g. `node-libgpiod`) rather than
//     fighting onoff; the exported functions below don't need to change,
//     only openLine()'s implementation.
//   - CTRL_MIXER_CONTROL's default ('Speaker') is a guess, not a
//     confirmed WM8960 ALSA control name — run `amixer -c wm8960soundcard
//     scontrols` on the real box and set this explicitly once known
//     (see infra/satellite-smoke-test.md's `alsamixer -c 0` step).

import { execFile } from 'child_process'
import Gpio from 'onoff'
import SpiDevice from 'spi-device'

const LED_WHITE_GPIO = process.env.CTRL_LED_WHITE_GPIO
  ? parseInt(process.env.CTRL_LED_WHITE_GPIO, 10)
  : null
const LED_RED_GPIO = process.env.CTRL_LED_RED_GPIO
  ? parseInt(process.env.CTRL_LED_RED_GPIO, 10)
  : null

// Fixed by the Pi's hardware SPI0 controller, not a free choice — see
// designs/station-hardware.md's Open questions correction. The MCP3008
// sits on CE0.
const SPI_BUS = 0
const SPI_DEVICE = 0
const MCP3008_CHANNEL = 0 // only CH0 is wired, to the pot's wiper

const MIXER_CARD = process.env.CTRL_MIXER_CARD || 'wm8960soundcard'
const MIXER_CONTROL = process.env.CTRL_MIXER_CONTROL || 'Speaker'

const POLL_INTERVAL_MS = 150
const SMOOTHING_ALPHA = 0.2 // exponential moving average, 0–1: higher = more responsive, noisier
const VOLUME_CHANGE_THRESHOLD = 2 // percentage points — avoids spawning amixer on every tiny jitter

let whiteLed = null
let redLed = null
let spi = null
let pollHandle = null
let smoothedReading = null // 0–1023, null until the first sample lands
let lastAppliedVolume = null // 0–100, null until first applied

export function isConfigured() {
  return Number.isInteger(LED_WHITE_GPIO) && Number.isInteger(LED_RED_GPIO)
}

export async function start() {
  if (!isConfigured()) {
    throw new Error('control panel not configured (CTRL_LED_WHITE_GPIO/CTRL_LED_RED_GPIO unset)')
  }

  whiteLed = new Gpio(LED_WHITE_GPIO, 'out')
  redLed = new Gpio(LED_RED_GPIO, 'out')
  whiteLed.writeSync(1) // on as soon as the satellite is up — standby/on indicator

  spi = SpiDevice.open(SPI_BUS, SPI_DEVICE, (err) => {
    if (err) throw err
  })

  pollHandle = setInterval(pollPot, POLL_INTERVAL_MS)
}

export function stop() {
  if (pollHandle) {
    clearInterval(pollHandle)
    pollHandle = null
  }
  whiteLed?.writeSync(0)
  redLed?.writeSync(0)
  whiteLed?.unexport()
  redLed?.unexport()
  whiteLed = null
  redLed = null
  spi?.close()
  spi = null
  smoothedReading = null
  lastAppliedVolume = null
}

// Integration point for whisper-gpio (see designs/satellite-hardware.md's
// Voice input section) once it exists — nothing calls this yet, since
// that script isn't built. Left wired up now rather than added later, so
// the red LED's actual behaviour doesn't need a second pass once it is.
export function setListening(isListening) {
  redLed?.writeSync(isListening ? 1 : 0)
}

export function getVolume() {
  return lastAppliedVolume
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
    if (err) console.error(`control panel: amixer failed (${err.message})`)
  })
}
