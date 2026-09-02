// Real IKEA Dirigera control, via the `dirigera` npm client. Unlike
// services/sonos.js (still a stub — no hardware to test against), this
// talks to an actual hub: pairing is a one-time step done by hand (see
// README.md), and DIRIGERA_ACCESS_TOKEN configures this at runtime.
// See designs/matter-lighting.md for the design this implements.

import { createDirigeraClient } from 'dirigera'

const accessToken = process.env.DIRIGERA_ACCESS_TOKEN
const gatewayIP = process.env.DIRIGERA_HOST || undefined

export function isConfigured() {
  return Boolean(accessToken)
}

// Created lazily (not at import time) so a satellite with no Dirigera
// configured never attempts mDNS discovery or a connection at all.
let clientPromise = null
function getClient() {
  if (!accessToken) throw new Error('Dirigera not configured (DIRIGERA_ACCESS_TOKEN unset)')
  clientPromise ??= createDirigeraClient({ accessToken, gatewayIP })
  return clientPromise
}

// Free-text room resolution happens here, not in the LLM plan — same
// "resolve locally" principle as Sonos room/speaker matching. Dirigera
// already models rooms natively, so this matches against its own room
// names rather than a hand-maintained device config.
async function resolveRoom(client, roomText) {
  const rooms = await client.rooms.list()
  const needle = roomText.trim().toLowerCase()

  const exact = rooms.find(r => r.name.toLowerCase() === needle)
  if (exact) return exact

  const partial = rooms.filter(
    r => r.name.toLowerCase().includes(needle) || needle.includes(r.name.toLowerCase())
  )
  if (partial.length === 1) return partial[0]
  if (partial.length > 1) {
    throw new Error(`"${roomText}" matches multiple rooms: ${partial.map(r => r.name).join(', ')}`)
  }
  throw new Error(`No room matching "${roomText}" (known rooms: ${rooms.map(r => r.name).join(', ') || 'none'})`)
}

// action: 'on' | 'off' | 'set_brightness'. Affects every light in the
// matched room (rooms.setAttributes with deviceType: 'light' is a group
// operation — no need to iterate individual devices).
//
// isOn and lightLevel are independent Dirigera attributes, and the
// client's own docs warn some attributes can't be combined in one
// setAttributes call — so set_brightness does isOn:true and lightLevel
// as two calls, never one. A brightness set on lights that are off
// wouldn't otherwise be visible.
export async function setLight({ room, action, brightness }) {
  const client = await getClient()
  const match = await resolveRoom(client, room)

  if (action === 'on' || action === 'off') {
    await client.rooms.setAttributes({ id: match.id, deviceType: 'light', attributes: { isOn: action === 'on' } })
    return { room: match.name, action }
  }

  if (action === 'set_brightness') {
    if (!Number.isFinite(brightness) || brightness < 1 || brightness > 100) {
      throw new Error(`brightness must be between 1 and 100, got ${brightness}`)
    }
    await client.rooms.setAttributes({ id: match.id, deviceType: 'light', attributes: { isOn: true } })
    await client.rooms.setAttributes({ id: match.id, deviceType: 'light', attributes: { lightLevel: brightness } })
    return { room: match.name, action, brightness }
  }

  throw new Error(`Unknown light action: "${action}"`)
}
