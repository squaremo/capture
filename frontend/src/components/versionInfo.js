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
