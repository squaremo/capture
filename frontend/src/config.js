// Runtime deployment config — replaces what used to be a Vite build-time
// constant (see designs/satellites.md's House attribution). Fetched once
// at startup, before anything else wires up. On the general deployment
// (nginx, no such route) this 404s and resolves to {} — no default
// house, relative /api — i.e. today's existing behaviour, unchanged. A
// satellite serving this frontend implements /config.json for real.
export async function loadConfig() {
  const isStation = new URLSearchParams(location.search).has('station')
  try {
    const res = await fetch('/config.json')
    if (!res.ok) return { isStation }
    const data = await res.json()
    // A satellite's real config.json can declare isStation itself once the
    // Pi build sets it (see index.html's own pre-paint ?station read,
    // which stays — it has to run before this fetch resolves); the query
    // param is the fallback for every other deployment.
    return { ...data, isStation: data.isStation ?? isStation }
  } catch {
    return { isStation }
  }
}
