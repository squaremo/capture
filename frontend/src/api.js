const BASE = '/api'

export async function postCapture(text, house) {
  const res = await fetch(`${BASE}/capture`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(house ? { text, house } : { text }),
  })
  if (!res.ok) throw new Error(`capture failed: ${res.status}`)
  return res.json()
}

export async function getVersion() {
  const res = await fetch(`${BASE}/version`)
  if (!res.ok) throw new Error(`fetch version failed: ${res.status}`)
  return res.json()
}

export async function getSatellites() {
  const res = await fetch(`${BASE}/satellites`)
  if (!res.ok) throw new Error(`fetch satellites failed: ${res.status}`)
  return res.json()
}

export async function getItems(filter) {
  const url = filter && filter !== 'all'
    ? `${BASE}/items?status=${filter}`
    : `${BASE}/items`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`fetch items failed: ${res.status}`)
  return res.json()
}

export async function patchItem(id, patch) {
  const res = await fetch(`${BASE}/items/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
  if (!res.ok) throw new Error(`patch item failed: ${res.status}`)
  return res.json()
}

export async function approveItem(id) {
  const res = await fetch(`${BASE}/items/${id}/approve`, { method: 'POST' })
  if (!res.ok) throw new Error(`approve item failed: ${res.status}`)
  return res.json()
}

export async function vetoItem(id) {
  const res = await fetch(`${BASE}/items/${id}/veto`, { method: 'POST' })
  if (!res.ok) throw new Error(`veto item failed: ${res.status}`)
  return res.json()
}

export async function favouriteItem(id) {
  const res = await fetch(`${BASE}/items/${id}/favourite`, { method: 'POST' })
  if (!res.ok) throw new Error(`favourite item failed: ${res.status}`)
  return res.json()
}

export async function getFavourites() {
  const res = await fetch(`${BASE}/favourites`)
  if (!res.ok) throw new Error(`fetch favourites failed: ${res.status}`)
  return res.json()
}

export async function runFavourite(id) {
  const res = await fetch(`${BASE}/favourites/${id}/run`, { method: 'POST' })
  if (!res.ok) throw new Error(`run favourite failed: ${res.status}`)
  return res.json()
}

export async function deleteFavourite(id) {
  const res = await fetch(`${BASE}/favourites/${id}`, { method: 'DELETE' })
  if (!res.ok) throw new Error(`delete favourite failed: ${res.status}`)
  return res.json()
}
