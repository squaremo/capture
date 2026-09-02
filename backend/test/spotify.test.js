import { describe, it, expect, vi, beforeEach } from 'vitest'
import { searchTrack } from '../integrations/spotify.js'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

beforeEach(() => {
  mockFetch.mockClear()
})

function jsonResponse(body, ok = true, status = 200) {
  return { ok, status, json: async () => body }
}

function tokenResponse(accessToken = 'test-access-token', expiresIn = 3600) {
  return jsonResponse({ access_token: accessToken, expires_in: expiresIn })
}

function searchResponse(tracks) {
  return jsonResponse({ tracks: { items: tracks } })
}

const spotifyTrack = {
  id: 'spotify-track-id',
  name: 'Silver Machine',
  artists: [{ name: 'Hawkwind' }],
  album: { name: 'Space Ritual' },
}

describe('searchTrack', () => {
  it('requests a client-credentials token with Basic auth, then searches', async () => {
    mockFetch.mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(searchResponse([spotifyTrack]))

    await searchTrack({ clientId: 'client-a', clientSecret: 'secret-a', title: 'Silver Machine' })

    const [tokenUrl, tokenOptions] = mockFetch.mock.calls[0]
    expect(tokenUrl).toBe('https://accounts.spotify.com/api/token')
    expect(tokenOptions.headers.Authorization).toBe(`Basic ${Buffer.from('client-a:secret-a').toString('base64')}`)
    expect(tokenOptions.body).toBe('grant_type=client_credentials')

    const [searchUrl, searchOptions] = mockFetch.mock.calls[1]
    expect(searchUrl.toString()).toContain('https://api.spotify.com/v1/search')
    expect(searchOptions.headers.Authorization).toBe('Bearer test-access-token')
  })

  it('builds the query from title/artist/album', async () => {
    mockFetch.mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(searchResponse([spotifyTrack]))

    await searchTrack({ clientId: 'client-b', clientSecret: 'secret-b', title: 'Silver Machine', artist: 'Hawkwind', album: 'Space Ritual' })

    const [searchUrl] = mockFetch.mock.calls[1]
    expect(searchUrl.searchParams.get('q')).toBe('Silver Machine artist:Hawkwind album:Space Ritual')
    expect(searchUrl.searchParams.get('type')).toBe('track')
  })

  it('scopes the search to a market when given one', async () => {
    mockFetch.mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(searchResponse([spotifyTrack]))

    await searchTrack({ clientId: 'client-m', clientSecret: 'secret-m', title: 'Silver Machine', market: 'GB' })

    const [searchUrl] = mockFetch.mock.calls[1]
    expect(searchUrl.searchParams.get('market')).toBe('GB')
  })

  it('omits the market param when none is given, rather than sending an empty one', async () => {
    mockFetch.mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(searchResponse([spotifyTrack]))

    await searchTrack({ clientId: 'client-n', clientSecret: 'secret-n', title: 'Silver Machine' })

    const [searchUrl] = mockFetch.mock.calls[1]
    expect(searchUrl.searchParams.has('market')).toBe(false)
  })

  it('returns the top match in this app\'s track shape', async () => {
    mockFetch.mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(searchResponse([spotifyTrack]))

    const result = await searchTrack({ clientId: 'client-c', clientSecret: 'secret-c', title: 'Silver Machine', artist: 'Hawkwind' })

    expect(result).toEqual({
      id: 'spotify-track-id',
      title: 'Silver Machine',
      artist: 'Hawkwind',
      album: 'Space Ritual',
      matchConfidence: 'exact',
    })
  })

  it('reports approximate confidence when no artist was given to narrow the query', async () => {
    mockFetch.mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(searchResponse([spotifyTrack]))

    const result = await searchTrack({ clientId: 'client-d', clientSecret: 'secret-d', title: 'Silver Machine' })

    expect(result.matchConfidence).toBe('approximate')
  })

  it('reuses a cached token instead of requesting a new one per search', async () => {
    mockFetch
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(searchResponse([spotifyTrack]))
      .mockResolvedValueOnce(searchResponse([spotifyTrack]))

    await searchTrack({ clientId: 'client-e', clientSecret: 'secret-e', title: 'a' })
    await searchTrack({ clientId: 'client-e', clientSecret: 'secret-e', title: 'b' })

    expect(mockFetch).toHaveBeenCalledTimes(3) // one token request, two searches
  })

  it('throws when no track matches', async () => {
    mockFetch.mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(searchResponse([]))

    await expect(searchTrack({ clientId: 'client-f', clientSecret: 'secret-f', title: 'nothing like this exists' })).rejects.toThrow(
      'No Spotify track matching'
    )
  })

  it('throws on a failed token request', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({}, false, 401))

    await expect(searchTrack({ clientId: 'client-g', clientSecret: 'bad-secret', title: 'x' })).rejects.toThrow(
      'Spotify token request failed: 401'
    )
  })

  it('throws on a failed search request', async () => {
    mockFetch.mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(jsonResponse({}, false, 500))

    await expect(searchTrack({ clientId: 'client-h', clientSecret: 'secret-h', title: 'x' })).rejects.toThrow('Spotify search failed: 500')
  })
})
