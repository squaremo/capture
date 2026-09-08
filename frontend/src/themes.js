// Theme switching. The theme is applied by an inline script in index.html
// before first paint (so there's no flash); this module only handles
// changing it and rendering the control.
//
// Density is separate on purpose: a theme is taste, density is hardware.
// The station sets data-density="station" from the ?station query param
// (see index.html) or from runtime config — never from a stored preference,
// because it describes the screen, not the person.

const KEY = 'capture:theme'

export const THEMES = [
  { id: 'meadow',   label: 'meadow' },
  { id: 'daylight', label: 'daylight' },
  { id: 'ember',    label: 'ember' },
  { id: 'dusk',     label: 'dusk' },
  { id: 'original', label: 'original' },
]

export function currentTheme() {
  return document.documentElement.dataset.theme ?? 'meadow'
}

export function setTheme(id) {
  if (!THEMES.some(t => t.id === id)) return
  document.documentElement.dataset.theme = id
  try {
    localStorage.setItem(KEY, id)
  } catch {
    // Storage unavailable — the theme still applies for this session.
  }
}

// A row of swatches for the info panel. Deliberately not in the header:
// changing theme is a once-a-month act, and the header is for status.
export function createThemePicker() {
  const el = document.createElement('div')
  el.className = 'theme-picker'

  const heading = document.createElement('div')
  heading.className = 'theme-picker-heading'
  heading.textContent = 'theme'

  const row = document.createElement('div')
  row.className = 'theme-picker-row'

  const buttons = THEMES.map(({ id, label }) => {
    const btn = document.createElement('button')
    btn.className = 'theme-swatch'
    btn.dataset.theme = id
    btn.type = 'button'
    btn.title = label
    btn.setAttribute('aria-label', `Use the ${label} theme`)
    btn.addEventListener('click', () => {
      setTheme(id)
      sync()
    })
    row.append(btn)
    return btn
  })

  function sync() {
    const active = currentTheme()
    buttons.forEach((btn) => {
      const on = btn.dataset.theme === active
      btn.classList.toggle('theme-swatch--active', on)
      btn.setAttribute('aria-pressed', String(on))
    })
  }

  sync()
  el.append(heading, row)
  return { el, sync }
}
