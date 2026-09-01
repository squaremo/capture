// Runtime deployment config — replaces what used to be a Vite build-time
// constant (see designs/satellites.md's House attribution). Fetched once
// at startup, before anything else wires up. On the general deployment
// (nginx, no such route) this 404s and resolves to {} — no default
// house, relative /api — i.e. today's existing behaviour, unchanged. A
// satellite serving this frontend implements /config.json for real.
export async function loadConfig() {
  try {
    const res = await fetch('/config.json')
    if (!res.ok) return {}
    return await res.json()
  } catch {
    return {}
  }
}
