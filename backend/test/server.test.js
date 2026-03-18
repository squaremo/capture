import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'

const { mockProcessCapture } = vi.hoisted(() => ({
  mockProcessCapture: vi.fn(),
}))

vi.mock('../integrations/claude.js', () => ({
  processCapture: mockProcessCapture,
}))

import { app } from '../server.js'

beforeEach(() => {
  mockProcessCapture.mockClear()
  mockProcessCapture.mockResolvedValue({ status: 'triaged', tags: [], action_result: 'Saved to inbox.' })
  delete process.env.TAILSCALE_SUBNET
})

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
