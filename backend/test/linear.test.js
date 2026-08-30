import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createLinearTask } from '../integrations/linear.js'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

beforeEach(() => {
  mockFetch.mockClear()
})

function jsonResponse(body, ok = true, status = 200) {
  return { ok, status, json: async () => body }
}

describe('createLinearTask', () => {
  it('sends the API key raw (no Bearer prefix) and returns the created issue', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({ data: { issueCreate: { success: true, issue: { url: 'https://linear.app/x/issue/1', title: 'Fix bug' } } } })
    )

    const issue = await createLinearTask({ apiKey: 'lin_api_test', teamId: 'team-1', title: 'Fix bug' })

    expect(issue).toEqual({ url: 'https://linear.app/x/issue/1', title: 'Fix bug' })
    const [, options] = mockFetch.mock.calls[0]
    expect(options.headers.Authorization).toBe('lin_api_test')
  })

  it('throws on a non-ok HTTP response', async () => {
    mockFetch.mockResolvedValue(jsonResponse({}, false, 401))
    await expect(createLinearTask({ apiKey: 'x', teamId: 'y', title: 'z' })).rejects.toThrow('401')
  })

  it('throws on GraphQL errors', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ errors: [{ message: 'bad teamId' }] }))
    await expect(createLinearTask({ apiKey: 'x', teamId: 'y', title: 'z' })).rejects.toThrow('bad teamId')
  })

  it('throws when issueCreate reports success: false', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ data: { issueCreate: { success: false, issue: null } } }))
    await expect(createLinearTask({ apiKey: 'x', teamId: 'y', title: 'z' })).rejects.toThrow('failed')
  })
})
