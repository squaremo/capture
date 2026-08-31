import { describe, it, expect, vi, beforeEach } from 'vitest'
import { controlPlayback, listSatellites } from '../integrations/satellite.js'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

beforeEach(() => {
  mockFetch.mockClear()
})

function jsonResponse(body, ok = true, status = 200) {
  return { ok, status, json: async () => body }
}

const houses = { home: 'http://localhost:4000' }

describe('controlPlayback', () => {
  it('throws for an unknown house without calling out', async () => {
    await expect(controlPlayback({ houses, house: 'lake', title: 'x' })).rejects.toThrow('Unknown house')
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('throws when the satellite status check is not ok', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({}, false, 503))
    await expect(controlPlayback({ houses, house: 'home', title: 'x' })).rejects.toThrow('503')
  })

  it('throws when the satellite has no sonos capability', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ capabilities: ['lights'] }))
    await expect(controlPlayback({ houses, house: 'home', title: 'x' })).rejects.toThrow('no Sonos capability')
  })

  it('posts the rich query and returns the play result', async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ capabilities: ['sonos'] }))
      .mockResolvedValueOnce(jsonResponse({ playing: true, track: 'Silver Machine by Hawkwind', room: 'living room' }))

    const result = await controlPlayback({
      houses,
      house: 'home',
      room: 'living room',
      title: 'Silver Machine',
      artist: 'Hawkwind',
    })

    expect(result).toEqual({ playing: true, track: 'Silver Machine by Hawkwind', room: 'living room' })
    const [url, options] = mockFetch.mock.calls[1]
    expect(url).toBe('http://localhost:4000/api/play')
    expect(JSON.parse(options.body)).toEqual({
      title: 'Silver Machine',
      artist: 'Hawkwind',
      album: undefined,
      room: 'living room',
    })
  })

  it('throws with the satellite-reported error on a failed play', async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ capabilities: ['sonos'] }))
      .mockResolvedValueOnce(jsonResponse({ error: 'title is required' }, false, 400))

    await expect(controlPlayback({ houses, house: 'home', title: '' })).rejects.toThrow('title is required')
  })
})

describe('listSatellites', () => {
  it('reports capabilities for a reachable house', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ house: 'home', capabilities: ['sonos'] }))

    const result = await listSatellites({ home: 'http://localhost:4000' })

    expect(result).toEqual([
      { house: 'home', address: 'http://localhost:4000', reachable: true, capabilities: ['sonos'] },
    ])
  })

  it('reports unreachable rather than throwing when the fetch fails', async () => {
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'))

    const result = await listSatellites({ home: 'http://localhost:4000' })

    expect(result).toEqual([
      { house: 'home', address: 'http://localhost:4000', reachable: false, capabilities: [] },
    ])
  })

  it('reports unreachable on a non-ok status response', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({}, false, 503))

    const result = await listSatellites({ home: 'http://localhost:4000' })

    expect(result[0]).toEqual({ house: 'home', address: 'http://localhost:4000', reachable: false, capabilities: [] })
  })

  it('reports each configured house independently', async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ capabilities: ['sonos'] }))
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))

    const result = await listSatellites({ home: 'http://localhost:4000', lake: 'http://localhost:4001' })

    expect(result).toEqual([
      { house: 'home', address: 'http://localhost:4000', reachable: true, capabilities: ['sonos'] },
      { house: 'lake', address: 'http://localhost:4001', reachable: false, capabilities: [] },
    ])
  })

  it('returns an empty array when no houses are configured', async () => {
    expect(await listSatellites({})).toEqual([])
    expect(mockFetch).not.toHaveBeenCalled()
  })
})
