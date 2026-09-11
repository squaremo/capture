import { icon } from './components/icons.js'

// Read-aloud via the browser's built-in SpeechSynthesis — no server
// involvement, same shape as capture's other browser-native voice feature
// (SpeechRecognition, used for capture input). Speaking-by-default is a
// per-device preference, not a person's: a wall station wants it, a phone
// in a meeting doesn't. So it's stored the same way theme/checklist ticks
// are — localStorage, per this browser, not synced anywhere.
const KEY = 'capture:speech'

export function isSpeechSupported() {
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

// Always speaks, regardless of the default-on/off setting — this is the
// per-item "say it" button's job: hear this one result on demand, whether
// or not auto-speak is turned on. Cancels whatever's mid-sentence first,
// so a repeat tap or a fresh result never queues up behind an old one.
export function speak(text) {
  if (!text || !isSpeechSupported()) return
  window.speechSynthesis.cancel()
  window.speechSynthesis.speak(new SpeechSynthesisUtterance(text))
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
