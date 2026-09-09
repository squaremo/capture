// "What this house can do" — the foot of the station's Controls tab (see
// STATIONS_AND_CONTROLS.md §3). Reference material ("read once, or when
// something you tried didn't work"), not live status — this renders once
// per call rather than owning its own poll loop, fed by whatever the
// caller already has: GET /api/version's integrations (central backend)
// and the satellite's own GET /api/status (device/room counts), which
// localActivity.js is already polling for the Music/Lights sections above
// it — no reason for a second fetch loop asking the same question.
export function createCapabilities() {
  const el = document.createElement('div')
  el.className = 'controls-capabilities'

  function render({ integrations, localStatus } = {}) {
    const rows = []

    const caps = localStatus?.capabilities ?? []
    if (caps.includes('dirigera')) {
      rows.push({ name: 'Dirigera', detail: `Lights · ${localStatus.deviceCount ?? 0} devices` })
    }
    if (caps.includes('sonos')) {
      const rooms = localStatus.rooms?.length ?? localStatus.playersFound ?? 0
      rows.push({ name: 'Sonos', detail: `Speakers · ${rooms} rooms` })
    }
    if (integrations?.linear) {
      rows.push({ name: 'Linear', detail: `Issues · ${integrations.linearTeamName ?? 'configured'}` })
    }
    // Always available — checklists/shopping lists are a frontend/backend
    // feature, not an external integration with something to be
    // "connected" to.
    rows.push({ name: 'Lists', detail: 'Shopping · checklists' })

    el.innerHTML = `
      <div class="controls-section-head">
        <span class="controls-section-title">What this house can do</span>
        <span class="controls-section-meta">${rows.length} connected</span>
      </div>
      <div class="controls-capabilities-grid">
        ${rows.map(r => `
          <div class="controls-capability-row">
            <span class="controls-capability-dot"></span>
            <span class="controls-capability-name">${escHtml(r.name)}</span>
            <span class="controls-capability-detail">${escHtml(r.detail)}</span>
          </div>
        `).join('')}
      </div>
    `
  }

  return { el, render }
}

function escHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}
