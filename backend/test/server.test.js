import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'

const { mockProcessCapture, mockExecuteAction } = vi.hoisted(() => ({
  mockProcessCapture: vi.fn(),
  mockExecuteAction: vi.fn(),
}))

vi.mock('../integrations/claude.js', () => ({
  processCapture: mockProcessCapture,
  executeAction: mockExecuteAction,
  LINEAR_ENABLED: true,
  SATELLITES_ENABLED: false,
}))

import { app } from '../server.js'

beforeEach(() => {
  mockProcessCapture.mockClear()
  mockExecuteAction.mockClear()
  mockProcessCapture.mockResolvedValue({ status: 'triaged', tags: [], action_result: 'Saved to inbox.' })
  delete process.env.TAILSCALE_SUBNET
})

// Waits for POST /api/capture's background processCapture().then() to land.
async function createResolvedItem(text) {
  const post = await app.inject({ method: 'POST', url: '/api/capture', payload: { text } })
  await new Promise(r => setTimeout(r, 20))
  return post.json()
}

afterAll(() => app.close())

describe('POST /api/capture', () => {
  it('400 on missing text', async () => {
    const reply = await app.inject({ method: 'POST', url: '/api/capture', payload: {} })
    expect(reply.statusCode).toBe(400)
  })

  it('400 on empty string', async () => {
    const reply = await app.inject({ method: 'POST', url: '/api/capture', payload: { text: '   ' } })
    expect(reply.statusCode).toBe(400)
  })

  it('201 with pending item returned immediately', async () => {
    mockProcessCapture.mockReturnValue(new Promise(() => {})) // never resolves
    const reply = await app.inject({ method: 'POST', url: '/api/capture', payload: { text: 'buy milk' } })
    expect(reply.statusCode).toBe(201)
    const item = reply.json()
    expect(item.status).toBe('pending')
    expect(item.text).toBe('buy milk')
    expect(item.id).toBeTruthy()
  })

  it('background processing resolves the item', async () => {
    let resolve
    mockProcessCapture.mockReturnValue(new Promise(r => { resolve = r }))

    const reply = await app.inject({ method: 'POST', url: '/api/capture', payload: { text: 'call dentist tomorrow' } })
    const item = reply.json()

    resolve({ status: 'reminder', tags: ['health'], action_result: 'Reminder set.' })
    await new Promise(r => setTimeout(r, 20))

    const poll = await app.inject({ method: 'GET', url: `/api/items/${item.id}` })
    expect(poll.json().status).toBe('reminder')
  })
})

describe('GET /api/version', () => {
  it('reports backend/config versions and enabled integrations', async () => {
    const reply = await app.inject({ method: 'GET', url: '/api/version' })
    expect(reply.statusCode).toBe(200)
    expect(reply.json()).toEqual({
      backend: 'dev',
      config: null,
      integrations: { linear: true, satellite: false },
    })
  })
})

describe('GET /api/items', () => {
  it('returns an array', async () => {
    const reply = await app.inject({ method: 'GET', url: '/api/items' })
    expect(reply.statusCode).toBe(200)
    expect(Array.isArray(reply.json())).toBe(true)
  })

  it('filters by ?status=', async () => {
    const reply = await app.inject({ method: 'GET', url: '/api/items?status=pending' })
    expect(reply.statusCode).toBe(200)
    const items = reply.json()
    expect(items.every(i => i.status === 'pending')).toBe(true)
  })
})

describe('GET /api/items/:id', () => {
  it('404 for unknown id', async () => {
    const reply = await app.inject({ method: 'GET', url: '/api/items/nonexistent-id' })
    expect(reply.statusCode).toBe(404)
  })

  it('returns the item for a known id', async () => {
    const post = await app.inject({ method: 'POST', url: '/api/capture', payload: { text: 'get by id test' } })
    const created = post.json()
    const reply = await app.inject({ method: 'GET', url: `/api/items/${created.id}` })
    expect(reply.statusCode).toBe(200)
    expect(reply.json().id).toBe(created.id)
  })
})

describe('PATCH /api/items/:id', () => {
  it('404 for unknown id', async () => {
    const reply = await app.inject({ method: 'PATCH', url: '/api/items/nonexistent-id', payload: { status: 'triaged' } })
    expect(reply.statusCode).toBe(404)
  })

  it('updates only the provided fields', async () => {
    const post = await app.inject({ method: 'POST', url: '/api/capture', payload: { text: 'patch test item' } })
    const created = post.json()

    const reply = await app.inject({
      method: 'PATCH',
      url: `/api/items/${created.id}`,
      payload: { status: 'acted', action_result: 'Done!' },
    })
    expect(reply.statusCode).toBe(200)
    const updated = reply.json()
    expect(updated.status).toBe('acted')
    expect(updated.action_result).toBe('Done!')
    expect(updated.text).toBe('patch test item')
  })
})

describe('POST /api/items/:id/approve', () => {
  it('404 for unknown id', async () => {
    const reply = await app.inject({ method: 'POST', url: '/api/items/nonexistent-id/approve' })
    expect(reply.statusCode).toBe(404)
  })

  it('409 when item has no pending action', async () => {
    const created = await createResolvedItem('no action item')
    const reply = await app.inject({ method: 'POST', url: `/api/items/${created.id}/approve` })
    expect(reply.statusCode).toBe(409)
  })

  it('executes the pending action and updates the item', async () => {
    mockProcessCapture.mockResolvedValue({
      status: 'awaiting_approval',
      tags: ['work'],
      action_result: 'Proposed: create Linear task "Fix bug"',
      pending_action: { tool: 'create_linear_task', input: { title: 'Fix bug' } },
    })
    const created = await createResolvedItem('fix the bug')

    mockExecuteAction.mockResolvedValue({ status: 'acted', action_result: 'Linear task created: "Fix bug" — https://linear.app/x/1' })
    const reply = await app.inject({ method: 'POST', url: `/api/items/${created.id}/approve` })

    expect(mockExecuteAction).toHaveBeenCalledWith({ tool: 'create_linear_task', input: { title: 'Fix bug' } })
    expect(reply.statusCode).toBe(200)
    const updated = reply.json()
    expect(updated.status).toBe('acted')
    expect(updated.action_result).toBe('Linear task created: "Fix bug" — https://linear.app/x/1')
    expect(updated.pending_action).toBeNull()
  })

  it('marks the item failed if the action throws', async () => {
    mockProcessCapture.mockResolvedValue({
      status: 'awaiting_approval',
      tags: [],
      action_result: 'Proposed: create Linear task "Fix bug"',
      pending_action: { tool: 'create_linear_task', input: { title: 'Fix bug' } },
    })
    const created = await createResolvedItem('fix the bug')

    mockExecuteAction.mockRejectedValue(new Error('Linear API error: 401'))
    const reply = await app.inject({ method: 'POST', url: `/api/items/${created.id}/approve` })

    expect(reply.statusCode).toBe(200)
    const updated = reply.json()
    expect(updated.status).toBe('failed')
    expect(updated.pending_action).toBeNull()
  })
})

describe('POST /api/items/:id/veto', () => {
  it('404 for unknown id', async () => {
    const reply = await app.inject({ method: 'POST', url: '/api/items/nonexistent-id/veto' })
    expect(reply.statusCode).toBe(404)
  })

  it('409 when item has no pending action', async () => {
    const created = await createResolvedItem('no action item')
    const reply = await app.inject({ method: 'POST', url: `/api/items/${created.id}/veto` })
    expect(reply.statusCode).toBe(409)
  })

  it('cancels a pending action without executing it', async () => {
    mockProcessCapture.mockResolvedValue({
      status: 'awaiting_approval',
      tags: [],
      action_result: 'Proposed: create Linear task "Fix bug"',
      pending_action: { tool: 'create_linear_task', input: { title: 'Fix bug' } },
    })
    const created = await createResolvedItem('fix the bug')

    const reply = await app.inject({ method: 'POST', url: `/api/items/${created.id}/veto` })

    expect(mockExecuteAction).not.toHaveBeenCalled()
    expect(reply.statusCode).toBe(200)
    const updated = reply.json()
    expect(updated.status).toBe('vetoed')
    expect(updated.pending_action).toBeNull()
  })
})

describe('Tailscale allowlist', () => {
  it('allows all requests when TAILSCALE_SUBNET is not set', async () => {
    const reply = await app.inject({ method: 'GET', url: '/api/items', remoteAddress: '1.2.3.4' })
    expect(reply.statusCode).toBe(200)
  })

  it('blocks requests from outside the subnet', async () => {
    process.env.TAILSCALE_SUBNET = '100.64.0.0/10'
    const reply = await app.inject({ method: 'GET', url: '/api/items', remoteAddress: '192.168.1.100' })
    expect(reply.statusCode).toBe(403)
  })

  it('allows requests from within the subnet', async () => {
    process.env.TAILSCALE_SUBNET = '100.64.0.0/10'
    const reply = await app.inject({ method: 'GET', url: '/api/items', remoteAddress: '100.64.0.1' })
    expect(reply.statusCode).toBe(200)
  })
})
