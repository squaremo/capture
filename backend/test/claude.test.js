import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockCreate } = vi.hoisted(() => ({ mockCreate: vi.fn() }))

vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn(() => ({ messages: { create: mockCreate } })),
}))

import { processCapture } from '../integrations/claude.js'

beforeEach(() => {
  mockCreate.mockClear()
})

function respondWithTool(name, input) {
  mockCreate.mockResolvedValue({
    content: [{ type: 'tool_use', name, input }],
  })
}

describe('processCapture', () => {
  it('maps save_to_inbox → triaged', async () => {
    respondWithTool('save_to_inbox', { action_result: 'Saved to inbox.', tags: ['work'] })
    const result = await processCapture('buy milk')
    expect(result).toEqual({ status: 'triaged', tags: ['work'], action_result: 'Saved to inbox.' })
  })

  it('maps create_reminder → reminder', async () => {
    respondWithTool('create_reminder', { action_result: 'Reminder set.', tags: ['health'] })
    const result = await processCapture('call dentist tomorrow')
    expect(result.status).toBe('reminder')
    expect(result.tags).toEqual(['health'])
  })

  it('maps flag_urgent → urgent', async () => {
    respondWithTool('flag_urgent', { action_result: 'Flagged as urgent.', tags: ['urgent'] })
    const result = await processCapture('server is down!')
    expect(result.status).toBe('urgent')
  })

  it('falls back to triaged with defaults when no tool_use in response', async () => {
    mockCreate.mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] })
    const result = await processCapture('random text')
    expect(result).toEqual({ status: 'triaged', tags: [], action_result: 'Saved to inbox.' })
  })

  it('handles missing tags in tool input gracefully', async () => {
    respondWithTool('save_to_inbox', { action_result: 'Saved.' })
    const result = await processCapture('test')
    expect(result.tags).toEqual([])
  })

  it('propagates API errors as thrown exceptions', async () => {
    mockCreate.mockRejectedValue(new Error('API unavailable'))
    await expect(processCapture('test')).rejects.toThrow('API unavailable')
  })
})
