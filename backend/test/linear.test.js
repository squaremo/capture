import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createLinearTask, searchLinearIssues } from '../integrations/linear.js'

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

  it('surfaces the GraphQL error message even on a non-ok HTTP response', async () => {
    // Linear returns a 400 with a body describing what was wrong with the
    // query/variables — throwing on res.status alone (as this used to)
    // discarded that message and left only an opaque "400".
    mockFetch.mockResolvedValue(jsonResponse({ errors: [{ message: 'Variable "$teamId" of type "String!" used in position expecting type "ID!"' }] }, false, 400))
    await expect(createLinearTask({ apiKey: 'x', teamId: 'y', title: 'z' })).rejects.toThrow('expecting type "ID!"')
  })
})

describe('searchLinearIssues', () => {
  it('declares teamId as ID, not String, since that is the filter comparator type', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ data: { issues: { nodes: [] } } }))
    await searchLinearIssues({ apiKey: 'x', teamId: 'team-1', query: 'login bug' })
    const [, options] = mockFetch.mock.calls[0]
    const { query } = JSON.parse(options.body)
    expect(query).toContain('$teamId: ID!')
  })

  it('returns duplicate_found: false with no matching_issue when nothing matches', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ data: { issues: { nodes: [] } } }))
    const result = await searchLinearIssues({ apiKey: 'x', teamId: 'team-1', query: 'login bug' })
    expect(result).toEqual({ duplicate_found: false, matching_issue: null })
  })

  it('returns duplicate_found: true with the matching issue', async () => {
    const issue = { title: 'Login bug', url: 'https://linear.app/x/issue/1' }
    mockFetch.mockResolvedValue(jsonResponse({ data: { issues: { nodes: [issue] } } }))
    const result = await searchLinearIssues({ apiKey: 'x', teamId: 'team-1', query: 'login bug' })
    expect(result).toEqual({ duplicate_found: true, matching_issue: issue })
  })
})
