import { describe, it, expect, vi, beforeEach } from 'vitest'
import { controlPlayback } from '../integrations/satellite.js'

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
