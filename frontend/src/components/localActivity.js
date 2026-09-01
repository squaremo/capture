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
// Pausing here calls the satellite's own /api/pause directly, bypassing
// the capture/Claude/approval pipeline entirely and deliberately — see
// designs/satellites.md's Satellite-served frontend & local device
// controls: a human pressing a button here is direct manual control, the
// same trust level as walking up to the speaker, not an LLM's
// interpretation of free text that needs gating.
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

  function render(status) {
    const activity = status.activity ?? []
    el.innerHTML = ''
    el.hidden = activity.length === 0
    if (activity.length === 0) return

    activity.forEach(({ speaker, track, playing }) => {
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

      if (playing) {
        const pauseBtn = document.createElement('button')
        pauseBtn.className = 'btn-local-pause'
        pauseBtn.textContent = 'pause'
        pauseBtn.addEventListener('click', async () => {
          pauseBtn.disabled = true
          try {
            await fetch('/api/pause', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ speaker: { name: speaker } }),
            })
          } catch {
            // Whatever actually happened, the next poll (or this
            // immediate refresh) reflects real state — no local guess.
          }
          fetchAndRender()
        })
        row.appendChild(pauseBtn)
      }

      el.appendChild(row)
    })
  }

  fetchAndRender()
  schedule()

  return { el }
}
