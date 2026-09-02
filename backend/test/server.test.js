import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'

const { mockProcessCapture, mockExecuteAction, mockRunProgram, mockGetFormFields, mockListSatellites, mockGetHouses } = vi.hoisted(() => ({
  mockProcessCapture: vi.fn(),
  mockExecuteAction: vi.fn(),
  mockRunProgram: vi.fn(),
  mockGetFormFields: vi.fn(),
  mockListSatellites: vi.fn(),
  mockGetHouses: vi.fn(),
}))

vi.mock('../integrations/claude.js', () => ({
  processCapture: mockProcessCapture,
  executeAction: mockExecuteAction,
  runProgram: mockRunProgram,
  getFormFields: mockGetFormFields,
  LINEAR_ENABLED: true,
  SATELLITES_ENABLED: false,
  SPOTIFY_ENABLED: false,
}))

vi.mock('../integrations/satellite.js', () => ({
  listSatellites: mockListSatellites,
  getHouses: mockGetHouses,
}))

import { app } from '../server.js'
import { createFavourite } from '../db.js'

beforeEach(() => {
  mockProcessCapture.mockClear()
  mockExecuteAction.mockClear()
  mockRunProgram.mockClear()
  mockGetFormFields.mockClear()
  mockListSatellites.mockClear()
  mockGetHouses.mockClear()
  mockProcessCapture.mockResolvedValue({ status: 'triaged', tags: [], action_result: 'Saved to inbox.' })
  mockGetFormFields.mockReturnValue([]) // most tests don't care about the derived form — opt in per-test
  mockListSatellites.mockResolvedValue([])
  mockGetHouses.mockReturnValue({})
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
      integrations: { linear: true, satellite: false, spotify: false },
    })
  })
})

describe('GET /api/satellites', () => {
  it('returns what listSatellites reports for the current houses file', async () => {
    mockGetHouses.mockReturnValue({ home: 'http://localhost:4000' })
    mockListSatellites.mockResolvedValue([
      { house: 'home', address: 'http://localhost:4000', reachable: true, capabilities: ['sonos'] },
    ])
    const reply = await app.inject({ method: 'GET', url: '/api/satellites' })
    expect(reply.statusCode).toBe(200)
    expect(mockListSatellites).toHaveBeenCalledWith({ home: 'http://localhost:4000' })
    expect(reply.json()).toEqual([
      { house: 'home', address: 'http://localhost:4000', reachable: true, capabilities: ['sonos'] },
    ])
  })

  it('returns an empty array when no houses are configured', async () => {
    const reply = await app.inject({ method: 'GET', url: '/api/satellites' })
    expect(reply.statusCode).toBe(200)
    expect(reply.json()).toEqual([])
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

  it('attaches form_fields derived from the item\'s plan_steps', async () => {
    const fields = [{ step: 's1', tool: 'create_linear_task', field: 'title', value: 'Fix bug', label: 'Title', type: 'text' }]
    mockGetFormFields.mockReturnValue(fields)
    const post = await app.inject({ method: 'POST', url: '/api/capture', payload: { text: 'get by id test' } })
    const reply = await app.inject({ method: 'GET', url: `/api/items/${post.json().id}` })
    expect(reply.json().form_fields).toEqual(fields)
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

  it('re-runs plan_steps with overrides before executing, when a body is given', async () => {
    const planSteps = [{ id: 's1', tool: 'create_linear_task', args: { title: 'Fix bug', tags: ['work'] } }]
    mockProcessCapture.mockResolvedValue({
      status: 'awaiting_approval',
      tags: ['work'],
      action_result: 'Proposed: create Linear task "Fix bug"',
      pending_action: { tool: 'create_linear_task', input: { title: 'Fix bug' } },
      plan_steps: planSteps,
    })
    const created = await createResolvedItem('fix the bug')

    mockRunProgram.mockResolvedValue({
      status: 'awaiting_approval',
      tags: ['work'],
      action_result: 'Proposed: create Linear task "Fix signup bug"',
      pending_action: { tool: 'create_linear_task', input: { title: 'Fix signup bug' } },
      plan_steps: [{ id: 's1', tool: 'create_linear_task', args: { title: 'Fix signup bug', tags: ['work'] } }],
    })
    mockExecuteAction.mockResolvedValue({ status: 'acted', action_result: 'Linear task created: "Fix signup bug" — https://linear.app/x/1' })

    const reply = await app.inject({
      method: 'POST',
      url: `/api/items/${created.id}/approve`,
      payload: { overrides: { s1: { title: 'Fix signup bug' } } },
    })

    expect(mockRunProgram).toHaveBeenCalledWith(planSteps, { house: null, overrides: { s1: { title: 'Fix signup bug' } } })
    expect(mockExecuteAction).toHaveBeenCalledWith({ tool: 'create_linear_task', input: { title: 'Fix signup bug' } })
    expect(reply.statusCode).toBe(200)
    const updated = reply.json()
    expect(updated.action_result).toBe('Linear task created: "Fix signup bug" — https://linear.app/x/1')
    expect(updated.executed_action).toEqual({ tool: 'create_linear_task', input: { title: 'Fix signup bug' } })
  })

  it('422s without executing anything when edited overrides no longer resolve to an action', async () => {
    const planSteps = [{ id: 's1', tool: 'create_linear_task', args: { title: 'Fix bug', tags: [] } }]
    mockProcessCapture.mockResolvedValue({
      status: 'awaiting_approval',
      tags: [],
      action_result: 'Proposed: create Linear task "Fix bug"',
      pending_action: { tool: 'create_linear_task', input: { title: 'Fix bug' } },
      plan_steps: planSteps,
    })
    const created = await createResolvedItem('fix the bug')

    mockRunProgram.mockResolvedValue({ status: 'triaged', tags: [], action_result: 'Saved to inbox.' })

    const reply = await app.inject({
      method: 'POST',
      url: `/api/items/${created.id}/approve`,
      payload: { overrides: { s1: { title: '' } } },
    })

    expect(reply.statusCode).toBe(422)
    expect(mockExecuteAction).not.toHaveBeenCalled()
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

describe('POST /api/items/:id/approve', () => {
  it('records executed_action on success, alongside clearing pending_action', async () => {
    mockProcessCapture.mockResolvedValue({
      status: 'awaiting_approval',
      tags: [],
      action_result: 'Proposed: create Linear task "Fix bug"',
      pending_action: { tool: 'create_linear_task', input: { title: 'Fix bug' } },
    })
    const created = await createResolvedItem('fix the bug')

    mockExecuteAction.mockResolvedValue({ status: 'acted', action_result: 'Linear task created: "Fix bug" — https://linear.app/x/1' })
    const reply = await app.inject({ method: 'POST', url: `/api/items/${created.id}/approve` })

    expect(reply.json().executed_action).toEqual({ tool: 'create_linear_task', input: { title: 'Fix bug' } })
  })

  it('leaves executed_action unset when the action throws', async () => {
    mockProcessCapture.mockResolvedValue({
      status: 'awaiting_approval',
      tags: [],
      action_result: 'Proposed: create Linear task "Fix bug"',
      pending_action: { tool: 'create_linear_task', input: { title: 'Fix bug' } },
    })
    const created = await createResolvedItem('fix the bug')

    mockExecuteAction.mockRejectedValue(new Error('Linear API error: 401'))
    const reply = await app.inject({ method: 'POST', url: `/api/items/${created.id}/approve` })

    expect(reply.json().executed_action).toBeNull()
  })
})

// Approves a pending action end-to-end so the resulting item has an
// executed_action to favourite, matching how a real favourite gets created.
async function createActedItem(text, { tool = 'create_linear_task', input = { title: 'Fix bug' }, action_result = 'Linear task created: "Fix bug" — https://linear.app/x/1' } = {}) {
  mockProcessCapture.mockResolvedValue({
    status: 'awaiting_approval',
    tags: ['work'],
    action_result: `Proposed: create Linear task "${input.title}"`,
    pending_action: { tool, input },
  })
  const created = await createResolvedItem(text)
  mockExecuteAction.mockResolvedValue({ status: 'acted', action_result })
  const approved = await app.inject({ method: 'POST', url: `/api/items/${created.id}/approve` })
  return approved.json()
}

describe('POST /api/items/:id/favourite', () => {
  it('404 for unknown id', async () => {
    const reply = await app.inject({ method: 'POST', url: '/api/items/nonexistent-id/favourite' })
    expect(reply.statusCode).toBe(404)
  })

  it('409 when the item has no executed action', async () => {
    const created = await createResolvedItem('no action item')
    const reply = await app.inject({ method: 'POST', url: `/api/items/${created.id}/favourite` })
    expect(reply.statusCode).toBe(409)
  })

  it('409 for a vetoed item (never executed, only proposed)', async () => {
    mockProcessCapture.mockResolvedValue({
      status: 'awaiting_approval',
      tags: [],
      action_result: 'Proposed: create Linear task "Fix bug"',
      pending_action: { tool: 'create_linear_task', input: { title: 'Fix bug' } },
    })
    const created = await createResolvedItem('fix the bug')
    await app.inject({ method: 'POST', url: `/api/items/${created.id}/veto` })

    const reply = await app.inject({ method: 'POST', url: `/api/items/${created.id}/favourite` })
    expect(reply.statusCode).toBe(409)
  })

  it('creates a favourite from an acted item, using action_result as the label', async () => {
    const acted = await createActedItem('fix the bug')

    const reply = await app.inject({ method: 'POST', url: `/api/items/${acted.id}/favourite` })
    expect(reply.statusCode).toBe(201)
    const fav = reply.json()
    expect(fav.label).toBe('Linear task created: "Fix bug" — https://linear.app/x/1')
    expect(fav.tool).toBe('create_linear_task')
    expect(fav.input).toEqual({ title: 'Fix bug' })
    expect(fav.tags).toEqual(['work'])

    const list = await app.inject({ method: 'GET', url: '/api/favourites' })
    expect(list.json().some(f => f.id === fav.id)).toBe(true)
  })
})

describe('DELETE /api/favourites/:id', () => {
  it('404 for unknown id', async () => {
    const reply = await app.inject({ method: 'DELETE', url: '/api/favourites/nonexistent-id' })
    expect(reply.statusCode).toBe(404)
  })

  it('removes the favourite', async () => {
    const acted = await createActedItem('fix the bug')
    const created = await app.inject({ method: 'POST', url: `/api/items/${acted.id}/favourite` })
    const fav = created.json()

    const reply = await app.inject({ method: 'DELETE', url: `/api/favourites/${fav.id}` })
    expect(reply.statusCode).toBe(200)

    const list = await app.inject({ method: 'GET', url: '/api/favourites' })
    expect(list.json().some(f => f.id === fav.id)).toBe(false)
  })
})

describe('POST /api/favourites/:id/run', () => {
  it('404 for unknown id', async () => {
    const reply = await app.inject({ method: 'POST', url: '/api/favourites/nonexistent-id/run' })
    expect(reply.statusCode).toBe(404)
  })

  it('replays the saved tool call with no re-planning, resolving straight to acted', async () => {
    const acted = await createActedItem('fix the bug')
    const created = await app.inject({ method: 'POST', url: `/api/items/${acted.id}/favourite` })
    const fav = created.json()

    mockProcessCapture.mockClear()
    mockExecuteAction.mockResolvedValue({ status: 'acted', action_result: 'Linear task created: "Fix bug" — https://linear.app/x/2' })

    const reply = await app.inject({ method: 'POST', url: `/api/favourites/${fav.id}/run` })
    expect(reply.statusCode).toBe(200)
    const item = reply.json()
    expect(item.status).toBe('acted')
    expect(item.action_result).toBe('Linear task created: "Fix bug" — https://linear.app/x/2')
    expect(item.tags).toEqual(['work'])
    expect(item.executed_action).toEqual({ tool: 'create_linear_task', input: { title: 'Fix bug' } })
    expect(mockExecuteAction).toHaveBeenCalledWith({ tool: 'create_linear_task', input: { title: 'Fix bug' } })
    expect(mockProcessCapture).not.toHaveBeenCalled() // no re-planning — replay is exact

    // Shows up in the inbox as its own item, for an audit trail.
    const list = await app.inject({ method: 'GET', url: '/api/items' })
    expect(list.json().some(i => i.id === item.id)).toBe(true)
  })

  it('re-resolves via runProgram with overrides when the favourite has a recorded program', async () => {
    const planSteps = [{ id: 's1', tool: 'create_linear_task', args: { title: 'Fix bug', tags: ['work'] } }]
    const fav = createFavourite({
      label: 'Linear task created: "Fix bug" — https://linear.app/x/1',
      tool: 'create_linear_task',
      input: { title: 'Fix bug' },
      tags: ['work'],
      plan_steps: planSteps,
      house: null,
    })

    mockRunProgram.mockResolvedValue({
      status: 'awaiting_approval',
      tags: ['work'],
      action_result: 'Proposed: create Linear task "Fix bug v2"',
      pending_action: { tool: 'create_linear_task', input: { title: 'Fix bug v2' } },
      plan_steps: [{ id: 's1', tool: 'create_linear_task', args: { title: 'Fix bug v2', tags: ['work'] } }],
    })
    mockExecuteAction.mockResolvedValue({ status: 'acted', action_result: 'Linear task created: "Fix bug v2" — https://linear.app/x/3' })

    const reply = await app.inject({
      method: 'POST',
      url: `/api/favourites/${fav.id}/run`,
      payload: { overrides: { s1: { title: 'Fix bug v2' } } },
    })

    expect(mockRunProgram).toHaveBeenCalledWith(planSteps, { house: null, overrides: { s1: { title: 'Fix bug v2' } } })
    expect(mockExecuteAction).toHaveBeenCalledWith({ tool: 'create_linear_task', input: { title: 'Fix bug v2' } })
    expect(reply.statusCode).toBe(200)
    const item = reply.json()
    expect(item.action_result).toBe('Linear task created: "Fix bug v2" — https://linear.app/x/3')
  })

  it('marks the replayed item failed if the action throws, without touching the favourite', async () => {
    const acted = await createActedItem('fix the bug')
    const created = await app.inject({ method: 'POST', url: `/api/items/${acted.id}/favourite` })
    const fav = created.json()

    mockExecuteAction.mockRejectedValue(new Error('Linear API error: 401'))
    const reply = await app.inject({ method: 'POST', url: `/api/favourites/${fav.id}/run` })
    expect(reply.statusCode).toBe(200)
    expect(reply.json().status).toBe('failed')

    const stillThere = await app.inject({ method: 'GET', url: '/api/favourites' })
    expect(stillThere.json().some(f => f.id === fav.id)).toBe(true)
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
