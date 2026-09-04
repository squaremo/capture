// Real IKEA Dirigera control, via the `dirigera` npm client. Pairing is
// a one-time step done by hand (see README.md); DIRIGERA_ACCESS_TOKEN
// configures this at runtime. See designs/matter-lighting.md.
//
// Split into resolve/commit, same shape as services/sonos.js's
// matchRoom()/play() — search first (can fail, changes nothing), then
// act on exactly what was resolved, so what a human approved is exactly
// what happens, never a fresh re-match of the same free text.

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

// Fuzzy-matches free text ("living room") against this house's actual
// Dirigera room names — never the LLM's job, see designs/satellites.md.
// Exact match, then substring either direction; anything else — no match,
// or more than one plausible match — fails rather than guessing.
async function matchRoom(client, roomText) {
  const rooms = await client.rooms.list()
  const needle = roomText.trim().toLowerCase()

  const exact = rooms.find(r => r.name.toLowerCase() === needle)
  if (exact) return { id: exact.id, name: exact.name, requested: roomText, confidence: 'exact' }

  const partial = rooms.filter(
    r => r.name.toLowerCase().includes(needle) || needle.includes(r.name.toLowerCase())
  )
  if (partial.length === 1) {
    return { id: partial[0].id, name: partial[0].name, requested: roomText, confidence: 'approximate' }
  }
  if (partial.length > 1) {
    throw new Error(`"${roomText}" matches multiple rooms: ${partial.map(r => r.name).join(', ')}`)
  }
  throw new Error(`No room matching "${roomText}" (known rooms: ${rooms.map(r => r.name).join(', ') || 'none'})`)
}

// Coerces before validating — brightness can arrive as a numeral string
// rather than a JSON number (the propose_plan tool schema's args field
// is untyped, so Claude's output isn't guaranteed to type it as a
// number, and Number.isFinite doesn't coerce strings the way the global
// isFinite does). Returns the coerced number so callers store/forward a
// real number, not whatever string happened to arrive.
function normalizeBrightness(brightness) {
  const level = Number(brightness)
  if (!Number.isFinite(level) || level < 1 || level > 100) {
    throw new Error(`brightness must be between 1 and 100, got ${brightness}`)
  }
  return level
}

// Normalizes/validates a colour as a 6-digit hex string ("#ff8800" or
// "ff8800") — what an HTML <input type="color"> produces natively.
// Colour-name interpretation ("make the living room red") happens in
// Claude's own tool call, not here: unlike a room name, a colour name
// isn't tied to any per-household state the satellite would need to
// look up, so there's nothing to resolve locally — Claude emits the hex
// value directly from its own knowledge, and this just validates shape.
function normalizeColor(color) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(color ?? '').trim())
  if (!m) throw new Error(`color must be a hex string like "#ff8800", got "${color}"`)
  return `#${m[1].toLowerCase()}`
}

// Resolves a room name (and validates action/brightness/color) without
// changing any device state — a bad request fails here, before ever
// reaching approval, rather than at commit time.
export async function resolveLight({ room, action, brightness, color }) {
  const client = await getClient()
  const match = await matchRoom(client, room)
  if (!['on', 'off', 'set_brightness', 'set_color'].includes(action)) {
    throw new Error(`Unknown light action: "${action}"`)
  }
  const level = action === 'set_brightness' ? normalizeBrightness(brightness) : brightness
  const normalizedColor = action === 'set_color' ? normalizeColor(color) : color
  return { room: match, action, brightness: level, color: normalizedColor }
}

// Hex (sRGB, 0-255 per channel) to the hue (0-359) + saturation (0-1)
// pair Dirigera's own API expects (colorHue/colorSaturation) — there's
// no RGB attribute on the device, so this conversion happens here rather
// than pushing hue/saturation math onto whatever's driving the color
// picker or the LLM. Value (brightness) is deliberately dropped — that's
// the separate lightLevel attribute set_brightness already controls, so
// a color change never overrides a level someone set independently.
function hexToHueSaturation(hex) {
  const int = parseInt(hex.slice(1), 16)
  const r = ((int >> 16) & 255) / 255
  const g = ((int >> 8) & 255) / 255
  const b = (int & 255) / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const delta = max - min

  let hue = 0
  if (delta !== 0) {
    if (max === r) hue = 60 * (((g - b) / delta) % 6)
    else if (max === g) hue = 60 * ((b - r) / delta + 2)
    else hue = 60 * ((r - g) / delta + 4)
    if (hue < 0) hue += 360
  }
  const saturation = max === 0 ? 0 : delta / max

  return { colorHue: Math.round(hue), colorSaturation: Math.round(saturation * 100) / 100 }
}

// Commits an already-resolved room/action/brightness (from a prior
// resolveLight() call) — no matching happens here, so this can't land on
// a different room than what was resolved and shown for approval.
// Affects every light in the room (rooms.setAttributes with
// deviceType: 'light' is a group operation — no need to iterate
// individual devices).
//
// isOn and lightLevel are independent Dirigera attributes, and the
// client's own docs warn some attributes can't be combined in one
// setAttributes call — so set_brightness issues two calls (isOn:true,
// then lightLevel), never one. A brightness set on lights that are off
// wouldn't otherwise be visible.
export async function commitLight({ room, action, brightness, color }) {
  const client = await getClient()

  if (action === 'on' || action === 'off') {
    await client.rooms.setAttributes({ id: room.id, deviceType: 'light', attributes: { isOn: action === 'on' } })
    return { room, action }
  }

  if (action === 'set_brightness') {
    await client.rooms.setAttributes({ id: room.id, deviceType: 'light', attributes: { isOn: true } })
    await client.rooms.setAttributes({ id: room.id, deviceType: 'light', attributes: { lightLevel: brightness } })
    return { room, action, brightness }
  }

  if (action === 'set_color') {
    // hue+saturation are set together deliberately — unlike isOn/
    // lightLevel, they're the two halves of one "colour" concept and the
    // client's own setLightColor() wrapper sets them in a single call, so
    // there's no reason to believe they need splitting the way isOn and
    // lightLevel did.
    await client.rooms.setAttributes({ id: room.id, deviceType: 'light', attributes: { isOn: true } })
    await client.rooms.setAttributes({ id: room.id, deviceType: 'light', attributes: hexToHueSaturation(color) })
    return { room, action, color }
  }

  throw new Error(`Unknown light action: "${action}"`)
}
