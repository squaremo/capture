// __GIT_SHA__ is a build-time constant (see vite.config.js) — the commit
// this frontend bundle was built from.
/* global __GIT_SHA__ */

// Backend/config/frontend versions live quietly in a footer line; the same
// data plus enabled integrations is also available from a header pill,
// revealed on tap so the header itself stays uncluttered.
export function createVersionInfo() {
  const footerEl = document.createElement('footer')
  footerEl.className = 'meta'

  const pill = createPill()

  return {
    footerEl,
    pillEl: pill.el,

    // data is the GET /api/version response: { backend, config, integrations }
    render(data) {
      footerEl.textContent = versionLine(data)
      pill.render(data)
    },

    // satellites is the GET /api/satellites response:
    // [{ house, address, reachable, capabilities }]
    renderSatellites(satellites) {
      pill.renderSatellites(satellites)
    },
  }
}

function versionLine(data) {
  return [
    `backend ${short(data.backend)}`,
    `config ${short(data.config)}`,
    `frontend ${short(__GIT_SHA__)}`,
  ].join(' · ')
}

function createPill() {
  const el = document.createElement('div')
  el.className = 'info-pill'

  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'info-pill-btn'
  button.textContent = 'info'
  button.setAttribute('aria-haspopup', 'true')
  button.setAttribute('aria-expanded', 'false')

  const panel = document.createElement('div')
  panel.className = 'info-panel'
  panel.hidden = true

  // Its own persistent node (not rebuilt by render()'s panel.innerHTML = ''),
  // so renderSatellites() and render() can be called independently in
  // either order without clobbering each other's content.
  const satellitesEl = document.createElement('div')
  satellitesEl.className = 'info-satellites'
  satellitesEl.hidden = true

  el.append(button, panel)

  function close() {
    panel.hidden = true
    button.setAttribute('aria-expanded', 'false')
  }

  button.addEventListener('click', (e) => {
    e.stopPropagation()
    const opening = panel.hidden
    panel.hidden = !opening
    button.setAttribute('aria-expanded', String(opening))
  })
  document.addEventListener('click', (e) => { if (!el.contains(e.target)) close() })
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close() })

  return {
    el,
    render(data) {
      panel.innerHTML = ''

      const versions = document.createElement('dl')
      versions.className = 'info-versions'
      addRow(versions, 'backend', short(data.backend))
      addRow(versions, 'config', short(data.config))
      addRow(versions, 'frontend', short(__GIT_SHA__))
      panel.appendChild(versions)

      const entries = Object.entries(data.integrations ?? {})
      const integrations = document.createElement('div')
      integrations.className = 'info-integrations'
      if (entries.length) {
        entries.forEach(([name, on]) => {
          const tag = document.createElement('span')
          tag.className = `integration-tag${on ? ' integration-tag--on' : ''}`
          tag.textContent = name
          integrations.appendChild(tag)
        })
      } else {
        integrations.textContent = 'no optional integrations configured'
      }
      panel.appendChild(integrations)
      panel.appendChild(satellitesEl)
    },

    // satellites: [{ house, address, reachable, capabilities, houseMismatch }]
    renderSatellites(satellites) {
      satellitesEl.innerHTML = ''

      if (!satellites?.length) {
        satellitesEl.hidden = true
        return
      }
      satellitesEl.hidden = false

      const heading = document.createElement('div')
      heading.className = 'info-satellites-heading'
      heading.textContent = 'satellites'
      satellitesEl.appendChild(heading)

      satellites.forEach(({ house, reachable, capabilities, houseMismatch }) => {
        const row = document.createElement('div')
        row.className = 'satellite-row'

        // houseMismatch is a distinct state from reachable — the satellite
        // answered, it's just not who this config entry claims (a
        // satellites.json/HOUSE_ID bug), worth a different signal than
        // "just currently offline" so it's obvious which one to go fix.
        const dot = document.createElement('span')
        dot.className = `satellite-dot${houseMismatch ? ' satellite-dot--mismatch' : reachable ? ' satellite-dot--up' : ''}`
        dot.title = houseMismatch ? 'house name mismatch' : reachable ? 'reachable' : 'unreachable'
        row.appendChild(dot)

        const name = document.createElement('span')
        name.className = 'satellite-name'
        name.textContent = house
        row.appendChild(name)

        if (houseMismatch) {
          const note = document.createElement('span')
          note.className = 'satellite-none'
          note.textContent = 'house mismatch'
          row.appendChild(note)
        } else if (capabilities.length) {
          capabilities.forEach(cap => {
            const tag = document.createElement('span')
            tag.className = 'integration-tag integration-tag--on'
            tag.textContent = cap
            row.appendChild(tag)
          })
        } else if (reachable) {
          const none = document.createElement('span')
          none.className = 'satellite-none'
          none.textContent = 'no capabilities'
          row.appendChild(none)
        }

        satellitesEl.appendChild(row)
      })
    },
  }
}

function addRow(dl, label, value) {
  const dt = document.createElement('dt')
  dt.textContent = label
  const dd = document.createElement('dd')
  dd.textContent = value
  dl.append(dt, dd)
}

function short(sha) {
  return sha ? sha.slice(0, 7) : 'unknown'
}
