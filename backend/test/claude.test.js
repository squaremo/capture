import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockCreate } = vi.hoisted(() => ({ mockCreate: vi.fn() }))

vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn(() => ({ messages: { create: mockCreate } })),
}))

import { processCapture } from '../integrations/claude.js'

beforeEach(() => {
  mockCreate.mockClear()
})

function respondWithPlan(steps) {
  mockCreate.mockResolvedValue({
    content: [{ type: 'tool_use', name: 'propose_plan', input: { steps } }],
  })
}

function respondWithStep(tool, args) {
  respondWithPlan([{ id: 's1', tool, args }])
}

describe('processCapture', () => {
  it('maps save_to_inbox → triaged', async () => {
    respondWithStep('save_to_inbox', { action_result: 'Saved to inbox.', tags: ['work'] })
    const result = await processCapture('buy milk')
    expect(result).toEqual({ status: 'triaged', tags: ['work'], action_result: 'Saved to inbox.' })
  })

  it('maps create_reminder → reminder', async () => {
    respondWithStep('create_reminder', { action_result: 'Reminder set.', tags: ['health'] })
    const result = await processCapture('call dentist tomorrow')
    expect(result.status).toBe('reminder')
    expect(result.tags).toEqual(['health'])
  })

  it('maps flag_urgent → urgent', async () => {
    respondWithStep('flag_urgent', { action_result: 'Flagged as urgent.', tags: ['urgent'] })
    const result = await processCapture('server is down!')
    expect(result.status).toBe('urgent')
  })

  it('throws when the plan has no steps', async () => {
    respondWithPlan([])
    await expect(processCapture('random text')).rejects.toThrow('empty plan')
  })

  it('throws when there is no tool_use in the response', async () => {
    mockCreate.mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] })
    await expect(processCapture('random text')).rejects.toThrow('empty plan')
  })

  it('handles missing tags in tool input gracefully', async () => {
    respondWithStep('save_to_inbox', { action_result: 'Saved.' })
    const result = await processCapture('test')
    expect(result.tags).toEqual([])
  })

  it('propagates API errors as thrown exceptions', async () => {
    mockCreate.mockRejectedValue(new Error('API unavailable'))
    await expect(processCapture('test')).rejects.toThrow('API unavailable')
  })

  it('throws when a step references an unknown tool', async () => {
    respondWithStep('delete_everything', {})
    await expect(processCapture('test')).rejects.toThrow('unknown tool')
  })

  it('throws when a step condition references an unknown step', async () => {
    respondWithPlan([{ id: 's1', tool: 'save_to_inbox', args: {}, if: '${missing.flag}' }])
    await expect(processCapture('test')).rejects.toThrow('unknown step')
  })

  it('takes the first satisfied branch and ignores the rest of the plan', async () => {
    respondWithPlan([
      { id: 's1', tool: 'flag_urgent', args: { action_result: 'Urgent!', tags: ['work'] } },
      { id: 's2', tool: 'save_to_inbox', args: { action_result: 'Saved.', tags: ['work'] } },
    ])
    const result = await processCapture('test')
    expect(result.status).toBe('urgent')
    expect(result.action_result).toBe('Urgent!')
  })
})
