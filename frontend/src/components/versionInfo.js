// __GIT_SHA__ is a build-time constant (see vite.config.js) — the commit
// this frontend bundle was built from.
/* global __GIT_SHA__ */

export function createVersionInfo() {
  const el = document.createElement('footer')
  el.className = 'meta'
  return {
    el,

    // data is the GET /api/version response: { backend, config, integrations }
    render(data) {
      const parts = [
        `backend ${short(data.backend)}`,
        `config ${short(data.config)}`,
        `frontend ${short(__GIT_SHA__)}`,
      ]
      const enabled = Object.entries(data.integrations ?? {})
        .filter(([, on]) => on)
        .map(([name]) => name)
      if (enabled.length) parts.push(`integrations: ${enabled.join(', ')}`)
      el.textContent = parts.join(' · ')
    },
  }
}

function short(sha) {
  return sha ? sha.slice(0, 7) : 'unknown'
}
