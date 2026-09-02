import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { resolveSpeaker, commitPlayback, resolveLight, commitLight, listSatellites, getHouses } from '../integrations/satellite.js'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

beforeEach(() => {
  mockFetch.mockClear()
})

function jsonResponse(body, ok = true, status = 200) {
  return { ok, status, json: async () => body }
}

const houses = { home: 'http://localhost:4000' }

describe('resolveSpeaker', () => {
  it('throws for an unknown house without calling out', async () => {
    await expect(resolveSpeaker({ houses, house: 'lake', room: 'living room' })).rejects.toThrow('Unknown house')
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('throws when the satellite status check is not ok', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({}, false, 503))
    await expect(resolveSpeaker({ houses, house: 'home', room: 'living room' })).rejects.toThrow('503')
  })

  it('throws when the satellite reports a different house than the config expects', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ house: 'lake', capabilities: ['sonos'] }))
    await expect(resolveSpeaker({ houses, house: 'home', room: 'living room' })).rejects.toThrow('mismatch')
  })

  it('throws when the satellite has no sonos capability', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ house: 'home', capabilities: ['lights'] }))
    await expect(resolveSpeaker({ houses, house: 'home', room: 'living room' })).rejects.toThrow('no Sonos capability')
  })

  it('posts the room to /api/search and returns the resolved speaker', async () => {
    const searchResult = {
      speaker: { name: 'Living Room', requested: 'living room', confidence: 'exact' },
    }
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ house: 'home', capabilities: ['sonos'] }))
      .mockResolvedValueOnce(jsonResponse(searchResult))

    const result = await resolveSpeaker({ houses, house: 'home', room: 'living room' })

    expect(result).toEqual(searchResult)
    const [url, options] = mockFetch.mock.calls[1]
    expect(url).toBe('http://localhost:4000/api/search')
    expect(JSON.parse(options.body)).toEqual({ room: 'living room' })
  })

  it('throws with the satellite-reported error when no speaker matches the room', async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ house: 'home', capabilities: ['sonos'] }))
      .mockResolvedValueOnce(jsonResponse({ error: 'No speaker matching "garage"' }, false, 422))

    await expect(
      resolveSpeaker({ houses, house: 'home', room: 'garage' })
    ).rejects.toThrow('No speaker matching')
  })
})

describe('commitPlayback', () => {
  const track = { id: 'trk_abc123', title: 'Silver Machine', artist: 'Hawkwind', album: null, matchConfidence: 'exact' }
  const speaker = { name: 'Living Room', requested: 'living room', confidence: 'exact' }

  it('throws for an unknown house without calling out', async () => {
    await expect(commitPlayback({ houses, house: 'lake', track, speaker })).rejects.toThrow('Unknown house')
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('throws when the satellite reports a different house than the config expects', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ house: 'lake', capabilities: ['sonos'] }))
    await expect(commitPlayback({ houses, house: 'home', track, speaker })).rejects.toThrow('mismatch')
  })

  it('posts exactly the resolved track/speaker to /api/play, not a fresh query', async () => {
    const playResult = { playing: true, track, speaker }
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ house: 'home', capabilities: ['sonos'] }))
      .mockResolvedValueOnce(jsonResponse(playResult))

    const result = await commitPlayback({ houses, house: 'home', track, speaker })

    expect(result).toEqual(playResult)
    const [url, options] = mockFetch.mock.calls[1]
    expect(url).toBe('http://localhost:4000/api/play')
    expect(JSON.parse(options.body)).toEqual({ track, speaker })
  })

  it('throws with the satellite-reported error on a failed play', async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ house: 'home', capabilities: ['sonos'] }))
      .mockResolvedValueOnce(jsonResponse({ error: 'speaker.name is required' }, false, 400))

    await expect(commitPlayback({ houses, house: 'home', track, speaker: {} })).rejects.toThrow('speaker.name is required')
  })
})

describe('resolveLight', () => {
  it('throws for an unknown house without calling out', async () => {
    await expect(resolveLight({ houses, house: 'lake', room: 'living room', action: 'on' })).rejects.toThrow('Unknown house')
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('throws when the satellite reports a different house than the config expects', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ house: 'lake', capabilities: ['dirigera'] }))
    await expect(resolveLight({ houses, house: 'home', room: 'living room', action: 'on' })).rejects.toThrow('mismatch')
  })

  it('throws when the satellite has no dirigera capability', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ house: 'home', capabilities: ['sonos'] }))
    await expect(resolveLight({ houses, house: 'home', room: 'living room', action: 'on' })).rejects.toThrow('no Dirigera capability')
  })

  it('posts the request to /api/lights/resolve and returns the resolved room', async () => {
    const resolveResult = { room: { id: 'room_1', name: 'Living Room', requested: 'living room', confidence: 'exact' }, action: 'set_brightness', brightness: 20 }
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ house: 'home', capabilities: ['dirigera'] }))
      .mockResolvedValueOnce(jsonResponse(resolveResult))

    const result = await resolveLight({ houses, house: 'home', room: 'living room', action: 'set_brightness', brightness: 20 })

    expect(result).toEqual(resolveResult)
    const [url, options] = mockFetch.mock.calls[1]
    expect(url).toBe('http://localhost:4000/api/lights/resolve')
    expect(JSON.parse(options.body)).toEqual({ room: 'living room', action: 'set_brightness', brightness: 20 })
  })

  it('throws with the satellite-reported error when no room matches', async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ house: 'home', capabilities: ['dirigera'] }))
      .mockResolvedValueOnce(jsonResponse({ error: 'No room matching "attic"' }, false, 422))

    await expect(resolveLight({ houses, house: 'home', room: 'attic', action: 'on' })).rejects.toThrow('No room matching')
  })
})

describe('commitLight', () => {
  const room = { id: 'room_1', name: 'Living Room', requested: 'living room', confidence: 'exact' }

  it('throws for an unknown house without calling out', async () => {
    await expect(commitLight({ houses, house: 'lake', room, action: 'on' })).rejects.toThrow('Unknown house')
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('throws when the satellite reports a different house than the config expects', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ house: 'lake', capabilities: ['dirigera'] }))
    await expect(commitLight({ houses, house: 'home', room, action: 'on' })).rejects.toThrow('mismatch')
  })

  it('posts exactly the resolved room to /api/lights, not a fresh query', async () => {
    const commitResult = { room, action: 'set_brightness', brightness: 20 }
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ house: 'home', capabilities: ['dirigera'] }))
      .mockResolvedValueOnce(jsonResponse(commitResult))

    const result = await commitLight({ houses, house: 'home', room, action: 'set_brightness', brightness: 20 })

    expect(result).toEqual(commitResult)
    const [url, options] = mockFetch.mock.calls[1]
    expect(url).toBe('http://localhost:4000/api/lights')
    expect(JSON.parse(options.body)).toEqual({ room, action: 'set_brightness', brightness: 20 })
  })

  it('throws with the satellite-reported error on a failed commit', async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ house: 'home', capabilities: ['dirigera'] }))
      .mockResolvedValueOnce(jsonResponse({ error: 'room (a resolved room object) is required' }, false, 400))

    await expect(commitLight({ houses, house: 'home', room: {}, action: 'on' })).rejects.toThrow('room (a resolved room object) is required')
  })
})

describe('listSatellites', () => {
  it('reports capabilities for a reachable house', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ house: 'home', capabilities: ['sonos'] }))

    const result = await listSatellites({ home: 'http://localhost:4000' })

    expect(result).toEqual([
      { house: 'home', address: 'http://localhost:4000', reachable: true, capabilities: ['sonos'], houseMismatch: false },
    ])
  })

  it('reports unreachable rather than throwing when the fetch fails', async () => {
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'))

    const result = await listSatellites({ home: 'http://localhost:4000' })

    expect(result).toEqual([
      { house: 'home', address: 'http://localhost:4000', reachable: false, capabilities: [], houseMismatch: false },
    ])
  })

  it('reports unreachable on a non-ok status response', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({}, false, 503))

    const result = await listSatellites({ home: 'http://localhost:4000' })

    expect(result[0]).toEqual({ house: 'home', address: 'http://localhost:4000', reachable: false, capabilities: [], houseMismatch: false })
  })

  it('reports houseMismatch: true, distinct from unreachable, when the satellite answers as a different house', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ house: 'lake', capabilities: ['sonos'] }))

    const result = await listSatellites({ home: 'http://localhost:4000' })

    expect(result).toEqual([
      { house: 'home', address: 'http://localhost:4000', reachable: false, capabilities: [], houseMismatch: true },
    ])
  })

  it('reports each configured house independently', async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ house: 'home', capabilities: ['sonos'] }))
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))

    const result = await listSatellites({ home: 'http://localhost:4000', lake: 'http://localhost:4001' })

    expect(result).toEqual([
      { house: 'home', address: 'http://localhost:4000', reachable: true, capabilities: ['sonos'], houseMismatch: false },
      { house: 'lake', address: 'http://localhost:4001', reachable: false, capabilities: [], houseMismatch: false },
    ])
  })

  it('returns an empty array when no houses are configured', async () => {
    expect(await listSatellites({})).toEqual([])
    expect(mockFetch).not.toHaveBeenCalled()
  })
})

describe('getHouses', () => {
  let dir

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'satellites-test-'))
  })

  afterEach(() => {
    delete process.env.SATELLITE_HOUSES_PATH
    rmSync(dir, { recursive: true, force: true })
  })

  it('parses the configured file', () => {
    const path = join(dir, 'satellites.json')
    writeFileSync(path, JSON.stringify({ home: 'http://localhost:4000' }))
    process.env.SATELLITE_HOUSES_PATH = path

    expect(getHouses()).toEqual({ home: 'http://localhost:4000' })
  })

  it('returns an empty object when the file does not exist, rather than throwing', () => {
    process.env.SATELLITE_HOUSES_PATH = join(dir, 'nonexistent.json')
    expect(getHouses()).toEqual({})
  })

  it('returns an empty object for malformed JSON, rather than throwing', () => {
    const path = join(dir, 'satellites.json')
    writeFileSync(path, 'not valid json')
    process.env.SATELLITE_HOUSES_PATH = path

    expect(getHouses()).toEqual({})
  })

  it('re-reads the file on every call — no caching', () => {
    const path = join(dir, 'satellites.json')
    writeFileSync(path, JSON.stringify({ home: 'http://localhost:4000' }))
    process.env.SATELLITE_HOUSES_PATH = path

    expect(getHouses()).toEqual({ home: 'http://localhost:4000' })

    writeFileSync(path, JSON.stringify({ home: 'http://localhost:4000', lake: 'http://localhost:4001' }))
    expect(getHouses()).toEqual({ home: 'http://localhost:4000', lake: 'http://localhost:4001' })
  })
})
