import { icon } from './components/icons.js'

// Read-aloud — either the browser's built-in SpeechSynthesis, or (on a
// satellite with the separate `tts` service running — see
// satellite/services/tts.js and tts/README.md) a local Piper voice via
// POST /api/speak. Same shape as capture's other browser-native voice
// feature (SpeechRecognition, used for capture input) had before
// whisper-stream: one engine, picked once at startup from runtime
// config, same call sites either way. 'local' isn't just a privacy
// nicety here the way whisper-stream's mic mode is — Chromium's Linux
// build (what the kiosk runs) typically ships with no speechSynthesis
// voices installed at all, so 'browser' can be silently non-functional
// on a station specifically. See designs/satellite-hardware.md's
// playback section.
const KEY = 'capture:speech'

// 'browser' (default) or 'local' — set once at startup via
// configureSpeech(), the same way api.js's configureApi() sets its own
// module-level BASE from runtime config (see config.js).
let SPEECH_MODE = 'browser'

export function configureSpeech({ speechMode } = {}) {
  SPEECH_MODE = speechMode === 'local' ? 'local' : 'browser'
}

export function isSpeechSupported() {
  if (SPEECH_MODE === 'local') return true // POST /api/speak needs no browser API at all
  return typeof window !== 'undefined' && 'speechSynthesis' in window
}

export function isSpeechEnabled() {
  try {
    return localStorage.getItem(KEY) === '1'
  } catch {
    return false
  }
}

export function setSpeechEnabled(enabled) {
  try {
    localStorage.setItem(KEY, enabled ? '1' : '0')
  } catch {
    // Storage unavailable — the toggle still works for the rest of this
    // page load, it just won't be remembered next visit.
  }
}

// One shared <audio> element for 'local' mode, reused across calls
// rather than a fresh one per speak() — created lazily so this module
// has no effect at import time on a deployment that never uses 'local'.
let audioEl = null
function getAudioEl() {
  audioEl ??= new Audio()
  return audioEl
}

// Always speaks, regardless of the default-on/off setting — this is the
// per-item "say it" button's job: hear this one result on demand, whether
// or not auto-speak is turned on. Cancels/stops whatever's mid-sentence
// first, so a repeat tap or a fresh result never queues up behind an old
// one — true of both engines, just a different API each way.
export function speak(text) {
  if (!text) return
  if (SPEECH_MODE === 'local') {
    speakLocal(text)
    return
  }
  if (!isSpeechSupported()) return
  window.speechSynthesis.cancel()
  window.speechSynthesis.speak(new SpeechSynthesisUtterance(text))
}

// Relative fetch — same origin as this page, since 'local' mode only
// ever gets selected when a satellite is the one serving the frontend
// (see the module doc comment), same reasoning as capture.js's
// whisper-stream POST /api/transcribe.
async function speakLocal(text) {
  const el = getAudioEl()
  el.pause()
  try {
    const res = await fetch('/api/speak', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    })
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      throw new Error(data.error || `speak failed: ${res.status}`)
    }
    const blob = await res.blob()
    const url = URL.createObjectURL(blob)
    el.src = url
    el.onended = el.onerror = () => URL.revokeObjectURL(url)
    await el.play()
  } catch (err) {
    console.error('Local speech failed:', err)
  }
}

// The default-on path: called at each point a result becomes available,
// speaks only if the global toggle is on.
export function speakIfEnabled(text) {
  if (isSpeechEnabled()) speak(text)
}

// An icon on/off button — one shared factory for the header (phone/laptop)
// and the station topbar, both of which want the same big, thumbable
// control rather than a text row: this is a toggle reached for often, not
// a once-a-month setting like theme. Sizing/hit-area is the caller's CSS
// (via the classes it adds alongside 'speech-toggle-btn'), since a header
// badge and a wall-panel topbar icon want different touch targets.
export function createSpeechToggleButton(size = 22) {
  const supported = isSpeechSupported()
  const el = document.createElement('button')
  el.type = 'button'
  el.className = 'speech-toggle-btn'
  el.disabled = !supported

  function sync() {
    const on = isSpeechEnabled()
    el.innerHTML = icon(on ? 'volume-2' : 'volume-x', size)
    el.classList.toggle('speech-toggle-btn--on', on)
    el.setAttribute('aria-pressed', String(on))
    el.title = supported
      ? `Read results aloud: ${on ? 'on' : 'off'}`
      : 'Read results aloud: not supported in this browser'
    el.setAttribute('aria-label', el.title)
  }

  el.addEventListener('click', () => {
    setSpeechEnabled(!isSpeechEnabled())
    sync()
  })

  sync()
  return { el, sync }
}
