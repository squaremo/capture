// Theme switching. The theme is applied by an inline script in index.html
// before first paint (so there's no flash); this module only handles
// changing it and rendering the control.
//
// Density is separate on purpose: a theme is taste, density is hardware.
// The station sets data-density="station" from the ?station query param
// (see index.html) or from runtime config — never from a stored preference,
// because it describes the screen, not the person.
//
// Just two themes — meadow (dark) and daylight (light) — so this is a
// light/dark toggle, not a picker. theme.css still has the roles/tokens
// machinery for more, but only these two ship.
import { icon } from './components/icons.js'

const KEY = 'capture:theme'

export function currentTheme() {
  return document.documentElement.dataset.theme === 'daylight' ? 'daylight' : 'meadow'
}

export function setTheme(id) {
  if (id !== 'meadow' && id !== 'daylight') return
  document.documentElement.dataset.theme = id
  try {
    localStorage.setItem(KEY, id)
  } catch {
    // Storage unavailable — the theme still applies for this session.
  }
}

// A light/dark icon toggle, beside the mute button in the header (see
// main.js) — same "reached for often, big thumb target" reasoning as
// speech.js's createSpeechToggleButton, which this mirrors.
export function createThemeToggle(size = 20) {
  const el = document.createElement('button')
  el.type = 'button'
  el.className = 'theme-toggle-btn'

  function sync() {
    const dark = currentTheme() === 'meadow'
    el.innerHTML = icon(dark ? 'moon' : 'sun', size)
    el.setAttribute('aria-pressed', String(!dark))
    el.title = dark ? 'Switch to daylight (light) theme' : 'Switch to meadow (dark) theme'
    el.setAttribute('aria-label', el.title)
  }

  el.addEventListener('click', () => {
    setTheme(currentTheme() === 'meadow' ? 'daylight' : 'meadow')
    sync()
  })

  sync()
  return { el, sync }
}
