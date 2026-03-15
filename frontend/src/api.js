const BASE = '/api'

export async function postCapture(text) {
  const res = await fetch(`${BASE}/capture`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  })
  if (!res.ok) throw new Error(`capture failed: ${res.status}`)
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
