// Shows what a satellite serving this page has actually done, sourced
// from its own GET /api/status — a plain relative fetch, deliberately
// not going through api.js's configurable backend base, since this is
// asking whoever is serving *this page* right now, not the central
// backend. That's what makes it reach the satellite when it's the one
// serving the page, and stay permanently inert on the general
// deployment, which has no such route (a 404 there stops polling for
// good — it's a structural fact about that deployment, not a transient
// hiccup worth retrying).
//
// Pausing/resuming/adjusting volume (Sonos) or toggling/dimming/colouring
// a room (lights) here calls the satellite's own /api/pause, /api/resume,
// /api/volume, or /api/lights directly, bypassing the capture/Claude/
// approval pipeline entirely and deliberately — see designs/satellites.md's
// Satellite-served frontend & local device controls: a human pressing a
// button or dragging a slider here is direct manual control, the same
// trust level as walking up to the speaker or the light switch, not an
// LLM's interpretation of free text that needs gating. /api/lights is the
// same endpoint the hub calls to commit an *approved* control_light plan
// step — safe to share, since in both cases it only ever commits an
// already-specific room/action, never resolves free text itself; the
// approval gate (where one applies) lives entirely upstream of this call.
const POLL_MS = 4000

export function createLocalActivity() {
  const el = document.createElement('section')
  el.className = 'local-activity'
  el.hidden = true

  let stopped = false

  async function fetchAndRender() {
    if (stopped) return
    try {
      const res = await fetch('/api/status')
      if (res.status === 404) {
        stopped = true
        el.hidden = true
        return
      }
      if (!res.ok) return // transient — leave the panel as it was
      render(await res.json())
    } catch {
      // Network hiccup, or nothing at this origin at all — leave as-is.
    }
  }

  function schedule() {
    if (stopped) return
    setTimeout(async () => {
      await fetchAndRender()
      schedule()
    }, POLL_MS)
  }

  // Shared by every control below: fire the request, then always refresh
  // from the satellite regardless of outcome — whatever actually happened
  // is what the next render should reflect, never a locally-guessed state.
  async function postAndRefresh(url, body) {
    try {
      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
    } catch {
      // Network hiccup — the refresh below still shows real state.
    }
    fetchAndRender()
  }

  function renderSonosRow({ speaker, track, playing, volume }) {
    const row = document.createElement('div')
    row.className = 'local-activity-row'

    const label = document.createElement('span')
    label.className = 'local-activity-label'
    label.textContent = track
      ? `${track.title}${track.artist ? ` — ${track.artist}` : ''} · ${speaker}`
      : speaker
    row.appendChild(label)

    const badge = document.createElement('span')
    badge.className = `local-activity-badge${playing ? ' local-activity-badge--playing' : ''}`
    badge.textContent = playing ? 'playing' : 'paused'
    row.appendChild(badge)

    // One toggle button either way — /api/resume, not /api/play, is
    // what continues a paused speaker: /api/play always reloads the
    // track from the start (a fresh setAVTransport), so re-using it
    // here would restart rather than resume.
    const toggleBtn = document.createElement('button')
    toggleBtn.className = 'btn-local-pause'
    toggleBtn.textContent = playing ? 'pause' : 'play'
    toggleBtn.addEventListener('click', () => {
      toggleBtn.disabled = true
      postAndRefresh(playing ? '/api/pause' : '/api/resume', { speaker: { name: speaker } })
    })
    row.appendChild(toggleBtn)

    // volume is live ground truth from the player itself (see
    // sonos.js's getStatus()), null only if the speaker somehow
    // vanished between polls.
    if (typeof volume === 'number') {
      const volumeControl = document.createElement('input')
      volumeControl.type = 'range'
      volumeControl.className = 'local-activity-volume'
      volumeControl.min = '0'
      volumeControl.max = '100'
      volumeControl.value = String(volume)
      volumeControl.setAttribute('aria-label', `${speaker} volume`)
      // 'change' (fires on release), not 'input' (fires continuously
      // while dragging) — one request per adjustment, not per pixel.
      volumeControl.addEventListener('change', () => {
        postAndRefresh('/api/volume', { speaker: { name: speaker }, level: Number(volumeControl.value) })
      })
      row.appendChild(volumeControl)
    }

    el.appendChild(row)
  }

  // room-level light state — see dirigera.js's getStatus() for why this
  // is real ground truth (unlike Sonos's activity map) and why it's
  // grouped per room rather than per bulb.
  function renderLightRow({ room, isOn, brightness, color }) {
    const row = document.createElement('div')
    row.className = 'local-activity-row'

    const label = document.createElement('span')
    label.className = 'local-activity-label'
    label.textContent = room.name
    row.appendChild(label)

    const badge = document.createElement('span')
    badge.className = `local-activity-badge${isOn ? ' local-activity-badge--playing' : ''}`
    badge.textContent = isOn ? 'on' : 'off'
    row.appendChild(badge)

    const toggleBtn = document.createElement('button')
    toggleBtn.className = 'btn-local-pause'
    toggleBtn.textContent = isOn ? 'off' : 'on'
    toggleBtn.addEventListener('click', () => {
      toggleBtn.disabled = true
      postAndRefresh('/api/lights', { room, action: isOn ? 'off' : 'on' })
    })
    row.appendChild(toggleBtn)

    // brightness/color are only present when Dirigera actually reported
    // them (a real light in the room) — see getStatus()'s doc comment.
    if (typeof brightness === 'number') {
      const brightnessControl = document.createElement('input')
      brightnessControl.type = 'range'
      brightnessControl.className = 'local-activity-volume'
      brightnessControl.min = '1'
      brightnessControl.max = '100'
      brightnessControl.value = String(brightness)
      brightnessControl.setAttribute('aria-label', `${room.name} brightness`)
      brightnessControl.addEventListener('change', () => {
        postAndRefresh('/api/lights', { room, action: 'set', brightness: Number(brightnessControl.value) })
      })
      row.appendChild(brightnessControl)
    }

    if (color) {
      const colorControl = document.createElement('input')
      colorControl.type = 'color'
      colorControl.className = 'local-activity-color'
      colorControl.value = color
      colorControl.setAttribute('aria-label', `${room.name} colour`)
      colorControl.addEventListener('change', () => {
        postAndRefresh('/api/lights', { room, action: 'set', color: colorControl.value })
      })
      row.appendChild(colorControl)
    }

    el.appendChild(row)
  }

  function render(status) {
    const activity = status.activity ?? []
    const lights = status.lights ?? []
    el.innerHTML = ''
    el.hidden = activity.length === 0 && lights.length === 0
    if (el.hidden) return

    activity.forEach(renderSonosRow)
    lights.forEach(renderLightRow)
  }

  fetchAndRender()
  schedule()

  return { el }
}
