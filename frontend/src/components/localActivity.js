import { icon } from './icons.js'

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
// Pausing/resuming/skipping/adjusting volume (Sonos) or toggling/dimming/
// colouring a room (lights) here calls the satellite's own /api/pause,
// /api/resume, /api/next, /api/previous, /api/volume, or /api/lights
// directly, bypassing the capture/Claude/approval pipeline entirely and
// deliberately — see designs/satellites.md's
// Satellite-served frontend & local device controls: a human pressing a
// button or dragging a slider here is direct manual control, the same
// trust level as walking up to the speaker or the light switch, not an
// LLM's interpretation of free text that needs gating. /api/lights is the
// same endpoint the hub calls to commit an *approved* control_light plan
// step — safe to share, since in both cases it only ever commits an
// already-specific room/action, never resolves free text itself; the
// approval gate (where one applies) lives entirely upstream of this call.
const POLL_MS = 4000

// variant: 'compact' (default) is the existing plain-row treatment, used
// on the phone/laptop idle rail. 'rich' is the station's Controls tab —
// see STATIONS_AND_CONTROLS.md §5 — a full Music block plus a Lights
// grid with real states (on/off/unreachable+retry). Both variants share
// one poll loop/one set of direct-control POSTs; only render() branches,
// so there's exactly one source of truth for what's actually playing or
// lit, never two components that could disagree.
export function createLocalActivity({ variant = 'compact' } = {}) {
  const el = document.createElement('section')
  el.className = variant === 'rich' ? 'local-activity local-activity--rich' : 'local-activity'
  el.hidden = true

  let stopped = false
  let lastStatus = null
  let onStatus = null

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
      const status = await res.json()
      lastStatus = status
      render(status)
      onStatus?.(status)
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

  function renderSonosRow({ speaker, track, nextTrack, playing, volume }) {
    const row = document.createElement('div')
    row.className = 'local-activity-row'

    // Wrapped in its own column so a "next" line stacks under the title
    // instead of stretching the row horizontally — the badge/buttons
    // that follow stay a fixed size regardless of how long either gets.
    const info = document.createElement('span')
    info.className = 'local-activity-info'

    const label = document.createElement('span')
    label.className = 'local-activity-label'
    label.textContent = track
      ? `${track.title}${track.artist ? ` — ${track.artist}` : ''} · ${speaker}`
      : speaker
    info.appendChild(label)

    // "Now and next" — only ever present once something's actually queued
    // up behind the current track (see sonos.js's getStatus()), so a
    // single-track play or an empty queue just shows nothing here.
    if (nextTrack) {
      const next = document.createElement('span')
      next.className = 'local-activity-next'
      next.textContent = `Next: ${nextTrack.title}${nextTrack.artist ? ` — ${nextTrack.artist}` : ''}`
      info.appendChild(next)
    }

    row.appendChild(info)

    const badge = document.createElement('span')
    badge.className = `local-activity-badge${playing ? ' local-activity-badge--playing' : ''}`
    badge.textContent = track ? (playing ? 'playing' : 'paused') : 'idle'
    row.appendChild(badge)

    // No track loaded (nothing has ever been played here, or this
    // satellite just started) — nothing for a toggle to do, since
    // /api/resume needs a track already loaded and /api/play needs a
    // resolved one this panel doesn't have. Volume is still real and
    // still worth offering below.
    if (track) {
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
    }

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

  function renderCompact(status) {
    const activity = status.activity ?? []
    const lights = status.lights ?? []
    el.innerHTML = ''
    el.hidden = activity.length === 0 && lights.length === 0
    if (el.hidden) return

    activity.forEach(renderSonosRow)
    lights.forEach(renderLightRow)
  }

  // ── Rich (station Controls tab) ──────────────────────────────────
  // Music is "hero"-sized: one speaker at a time, the one this station's
  // own room is grouped to if it's playing anything, otherwise the first
  // with a track loaded, otherwise the first discovered at all (so the
  // block still shows *a* room name rather than nothing).
  function pickSpeaker(activity, house) {
    if (!activity.length) return null
    return activity.find(a => a.speaker.toLowerCase() === house?.toLowerCase() && a.track)
      ?? activity.find(a => a.track)
      ?? activity[0]
  }

  function renderMusic(activity, house) {
    const section = document.createElement('div')
    section.className = 'controls-section'
    const speaker = pickSpeaker(activity, house)
    section.innerHTML = `
      <div class="controls-section-head">
        <span class="controls-section-title">Music</span>
        <span class="controls-section-meta">${speaker ? escHtml(speaker.speaker) : ''}</span>
      </div>
    `
    if (!speaker || !speaker.track) {
      const empty = document.createElement('div')
      empty.className = 'controls-empty'
      empty.textContent = 'Nothing playing in here'
      section.appendChild(empty)
      el.appendChild(section)
      return
    }
    const { track, nextTrack, playing, volume, speaker: name } = speaker
    const body = document.createElement('div')
    body.className = 'controls-music-body'
    body.innerHTML = `
      <div class="controls-music-info">
        <div class="controls-music-title">${escHtml(track.title)}</div>
        <div class="controls-music-artist">${escHtml([track.artist, track.album].filter(Boolean).join(' · '))}</div>
        ${nextTrack ? `<div class="controls-music-next">Next: ${escHtml(nextTrack.title)}${nextTrack.artist ? ` — ${escHtml(nextTrack.artist)}` : ''}</div>` : ''}
      </div>
      <div class="controls-music-transport">
        <button type="button" class="controls-transport-btn" data-action="prev" aria-label="Previous track">${icon('skip-back', 20)}</button>
        <button type="button" class="controls-transport-btn controls-transport-btn--play" data-action="toggle" aria-label="${playing ? 'Pause' : 'Play'}">${icon(playing ? 'pause' : 'play', 22)}</button>
        <button type="button" class="controls-transport-btn" data-action="next" aria-label="Next track">${icon('skip-forward', 20)}</button>
        ${typeof volume === 'number' ? `
          <input type="range" class="controls-volume" min="0" max="100" value="${volume}" aria-label="${escHtml(name)} volume">
          <span class="controls-volume-pct">${volume}%</span>
        ` : ''}
      </div>
    `
    body.querySelector('[data-action="toggle"]')?.addEventListener('click', (e) => {
      e.currentTarget.disabled = true
      postAndRefresh(playing ? '/api/pause' : '/api/resume', { speaker: { name } })
    })
    body.querySelector('[data-action="prev"]')?.addEventListener('click', (e) => {
      e.currentTarget.disabled = true
      postAndRefresh('/api/previous', { speaker: { name } })
    })
    body.querySelector('[data-action="next"]')?.addEventListener('click', (e) => {
      e.currentTarget.disabled = true
      postAndRefresh('/api/next', { speaker: { name } })
    })
    body.querySelector('.controls-volume')?.addEventListener('change', (e) => {
      postAndRefresh('/api/volume', { speaker: { name }, level: Number(e.target.value) })
    })
    section.appendChild(body)
    el.appendChild(section)
  }

  function lightCellState(light) {
    if (!light.reachable) return 'unreachable'
    return light.isOn ? 'on' : 'off'
  }

  function renderLightCell(light) {
    const state = lightCellState(light)
    const statusText = state === 'unreachable' ? 'Unreachable' : state === 'on' ? `On · ${light.brightness ?? 0}%` : 'Off'
    const cell = document.createElement('div')
    cell.className = 'controls-light-cell'
    cell.innerHTML = `
      <div class="controls-light-top">
        <span class="controls-light-icon">${icon('lightbulb', 20)}</span>
        <span class="controls-light-name">${escHtml(light.room.name)}</span>
        <span class="controls-light-status" data-state="${state}">${statusText}</span>
      </div>
      <div class="controls-light-row">
        <button type="button" class="controls-light-btn" data-state="${state}">${state === 'unreachable' ? 'Retry' : state === 'on' ? 'On' : 'Off'}</button>
        <input type="range" class="controls-light-slider" min="1" max="100"
          value="${light.brightness ?? 40}" data-state="${state}"
          ${state === 'unreachable' ? 'disabled' : ''}>
        <span class="controls-light-pct">${state === 'unreachable' ? '—' : `${light.brightness ?? 0}%`}</span>
      </div>
    `
    cell.querySelector('.controls-light-btn').addEventListener('click', () => {
      if (state === 'unreachable') {
        // The mesh connection, not the command, is what's broken — a
        // fresh status read is the real "try again," not a POST fired
        // at a device that isn't answering.
        fetchAndRender()
        return
      }
      postAndRefresh('/api/lights', { room: light.room, action: light.isOn ? 'off' : 'on' })
    })
    // Dragging turns the light on — nobody drags to 60% wanting the room
    // dark — and a light sitting at 0% jumps to 40% rather than staying
    // imperceptibly dim once "on" actually takes effect.
    cell.querySelector('.controls-light-slider').addEventListener('change', (e) => {
      const level = Number(e.target.value)
      postAndRefresh('/api/lights', { room: light.room, action: 'set', brightness: light.isOn ? level : Math.max(level, 40) })
    })
    return cell
  }

  function renderLights(lights) {
    const section = document.createElement('div')
    section.className = 'controls-section'
    const onCount = lights.filter(l => l.reachable && l.isOn).length
    const downCount = lights.filter(l => !l.reachable).length
    const meta = [`${onCount} of ${lights.length} on`, downCount ? `${downCount} unreachable` : null].filter(Boolean).join(' · ')
    section.innerHTML = `
      <div class="controls-section-head">
        <span class="controls-section-title">Lights</span>
        <span class="controls-section-meta">${escHtml(meta)}</span>
      </div>
    `
    const grid = document.createElement('div')
    grid.className = 'controls-lights-grid'
    lights.forEach(l => grid.appendChild(renderLightCell(l)))
    section.appendChild(grid)
    el.appendChild(section)
  }

  function renderRich(status, house) {
    el.innerHTML = ''
    const activity = status.activity ?? []
    const lights = status.lights ?? []
    el.hidden = false
    renderMusic(activity, house)
    if (lights.length) renderLights(lights)
  }

  let house = null
  function render(status) {
    if (variant === 'rich') renderRich(status, house)
    else renderCompact(status)
  }

  fetchAndRender()
  schedule()

  return {
    el,
    // Station-only — matches Music's "this station's own room" pick.
    setHouse(h) { house = h },
    // Fired on every successful poll — the Controls tab's capabilities
    // footer (see capabilities.js) reads device/room counts off this
    // rather than keeping its own duplicate fetch loop.
    onStatus(fn) { onStatus = fn },
    getLastStatus: () => lastStatus,
  }
}

function escHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}
