import { escHtml } from './item.js'

// The station header's reachability signal — see the design handoff's
// STATIONS_AND_CONTROLS.md §2. Replaces the old info-pill's satellite
// dots with one worst-state summary next to the clock ("Home" when every
// configured house answers, "Home · 1 down" when one doesn't), plus a
// disclosure band naming exactly which. Station-only: the phone/laptop
// header keeps the existing info pill, which still has version/build
// info this component doesn't carry.
export function createStationsIndicator({ label = 'Home' } = {}) {
  let satellites = []
  let thisHouse = null
  let open = false

  const toggle = document.createElement('button')
  toggle.type = 'button'
  toggle.className = 'stations-toggle'
  toggle.setAttribute('aria-haspopup', 'true')
  toggle.setAttribute('aria-expanded', 'false')

  const band = document.createElement('div')
  band.className = 'stations-band'
  band.hidden = true

  function downCount() {
    return satellites.filter(s => !s.reachable).length
  }

  // "No answer" alone if this house has never once answered since the
  // backend last restarted (lastSeenAt is server-local, in-memory state —
  // see satellite.js) — a duration would just be lying about "since when."
  function stateText(s) {
    if (s.house === thisHouse) return 'This panel'
    if (s.houseMismatch) return 'House mismatch'
    if (s.reachable) return 'Reachable'
    return s.lastSeenAt ? `No answer · ${shortAge(s.lastSeenAt)}` : 'No answer'
  }

  function renderToggle() {
    const down = downCount()
    toggle.classList.toggle('stations-toggle--down', down > 0)
    toggle.setAttribute('aria-expanded', String(open))
    toggle.innerHTML = `
      <span class="stations-dot"></span>
      <span class="stations-label">${escHtml(label)}${down > 0 ? ` · ${down} down` : ''}</span>
      <span class="stations-chevron">${chevron()}</span>
    `
  }

  function renderBand() {
    band.innerHTML = satellites.length ? `
      <div class="stations-band-head">
        <span class="stations-band-title">Stations</span>
        <button type="button" class="stations-band-close" data-action="close">Close</button>
      </div>
      <div class="stations-grid">
        ${satellites.map(s => `
          <div class="stations-cell">
            <div class="stations-cell-top">
              <span class="stations-cell-dot" data-role="${cellRole(s)}"></span>
              <span class="stations-cell-name">${escHtml(s.house)}</span>
              ${s.house === thisHouse ? '<span class="stations-here-badge">Here</span>' : ''}
            </div>
            <span class="stations-cell-state" data-role="${cellRole(s)}">${stateText(s)}</span>
          </div>
        `).join('')}
      </div>
    ` : ''
  }

  function cellRole(s) {
    if (s.house === thisHouse) return 'here'
    return s.reachable ? 'up' : 'down'
  }

  function setOpen(next) {
    open = next
    band.hidden = !open
    renderToggle()
  }

  toggle.addEventListener('click', () => setOpen(!open))
  band.addEventListener('click', (e) => {
    if (e.target.closest('[data-action="close"]')) setOpen(false)
  })

  return {
    toggleEl: toggle,
    bandEl: band,
    // house: which configured house this panel itself is — for the
    // "Here"/"This panel" treatment. Set once, from config.defaultHouse.
    setHouse(house) {
      thisHouse = house
      renderBand()
    },
    render(list) {
      satellites = list ?? []
      renderToggle()
      renderBand()
    },
  }
}

function shortAge(ts) {
  const diff = Date.now() - new Date(ts).getTime()
  const m = Math.floor(diff / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  return `${Math.floor(h / 24)}d`
}

function chevron() {
  return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="flex-shrink: 0; opacity: 0.7;"><path d="m6 9 6 6 6-6"></path></svg>'
}

// A plain HH:MM clock — the mockup shows one beside the stations toggle.
// Station-only, like the toggle itself; a wall panel has no other reason
// to show a clock, and updates itself on its own timer rather than
// needing to be told when to refresh.
export function createStationClock() {
  const el = document.createElement('span')
  el.className = 'station-clock'

  function tick() {
    const now = new Date()
    const hh = String(now.getHours()).padStart(2, '0')
    const mm = String(now.getMinutes()).padStart(2, '0')
    el.textContent = `${hh}:${mm}`
  }

  tick()
  const timer = setInterval(tick, 15000)

  return { el, stop: () => clearInterval(timer) }
}
