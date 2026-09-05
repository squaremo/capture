import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockCreate } = vi.hoisted(() => ({ mockCreate: vi.fn() }))

vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn(() => ({ messages: { create: mockCreate } })),
}))

import { processCapture, runProgram, getFormFields } from '../integrations/claude.js'
import { createItem, getItem, updateItem } from '../db.js'

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
    const args = { action_result: 'Saved to inbox.', tags: ['work'] }
    respondWithStep('save_to_inbox', args)
    const result = await processCapture('buy milk')
    expect(result).toEqual({
      status: 'triaged',
      tags: ['work'],
      action_result: 'Saved to inbox.',
      plan_steps: [{ id: 's1', tool: 'save_to_inbox', args }],
    })
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

  it('maps save_checklist → checklist, rewriting text to a markdown task list', async () => {
    respondWithStep('save_checklist', {
      title: 'Swimming kit',
      items: ['goggles', 'towel', 'costume'],
      tags: ['swimming'],
    })
    const result = await processCapture('checklist for swimming: goggles, towel, costume')
    expect(result.status).toBe('checklist')
    expect(result.tags).toEqual(['swimming'])
    expect(result.text).toBe('Swimming kit\n- [ ] goggles\n- [ ] towel\n- [ ] costume')
  })

  it('save_checklist omits the title line when none is given', async () => {
    respondWithStep('save_checklist', { items: ['milk', 'eggs'], tags: [] })
    const result = await processCapture('shopping list: milk, eggs')
    expect(result.text).toBe('- [ ] milk\n- [ ] eggs')
  })

  it('"swimming checklist" (find_checklist → recall_checklist) resets the existing checklist in place', async () => {
    const item = createItem('checklist for swimming: goggles, towel')
    updateItem(item.id, { status: 'checklist', text: 'Swimming kit\n- [x] goggles\n- [ ] towel' })

    respondWithPlan([
      { id: 's1', tool: 'find_checklist', args: { query: 'swimming' } },
      { id: 's2', tool: 'recall_checklist', args: { item_id: '${s1.item.id}', title: '${s1.item.title}', tags: [] }, if: '${s1.found}' },
    ])
    const result = await processCapture('swimming checklist')

    expect(result.status).toBe('acted')
    expect(result.action_result).toBe('Reset "Swimming kit" checklist')
    // The existing item was reset in place — this capture didn't spawn a
    // second checklist item alongside it.
    expect(getItem(item.id).text).toBe('Swimming kit\n- [ ] goggles\n- [ ] towel')
  })

  it('find_checklist "unless found" falls back to save_to_inbox when nothing matches', async () => {
    respondWithPlan([
      { id: 's1', tool: 'find_checklist', args: { query: 'unicorn' } },
      { id: 's2', tool: 'save_to_inbox', args: { action_result: 'No matching checklist found.', tags: [] }, unless: '${s1.found}' },
    ])
    const result = await processCapture('unicorn checklist')
    expect(result.status).toBe('triaged')
    expect(result.action_result).toBe('No matching checklist found.')
  })

  it('recall_checklist fails clearly if the target item no longer exists', async () => {
    respondWithStep('recall_checklist', { item_id: 'missing-id', title: 'Ghost list', tags: [] })
    await expect(processCapture('ghost checklist')).rejects.toThrow('no longer exists')
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

  it('stages an API error as a Claude API error, distinct from a resolution failure', async () => {
    mockCreate.mockRejectedValue(new Error('API unavailable'))
    await expect(processCapture('test')).rejects.toThrow('Claude API error: API unavailable')
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

  it('only records the steps actually reached in plan_steps, not skipped branches', async () => {
    respondWithPlan([
      { id: 's1', tool: 'flag_urgent', args: { action_result: 'Urgent!', tags: [] } },
      { id: 's2', tool: 'save_to_inbox', args: { action_result: 'Saved.', tags: [] } },
    ])
    const result = await processCapture('test')
    expect(result.plan_steps).toEqual([{ id: 's1', tool: 'flag_urgent', args: { action_result: 'Urgent!', tags: [] } }])
  })
})

describe('runProgram with overrides', () => {
  it('substitutes an overridden literal arg before resolving the step', async () => {
    const steps = [{ id: 's1', tool: 'save_to_inbox', args: { action_result: 'Saved.', tags: [] } }]
    const result = await runProgram(steps, { overrides: { s1: { action_result: 'Edited.' } } })
    expect(result.action_result).toBe('Edited.')
    expect(result.plan_steps).toEqual([{ id: 's1', tool: 'save_to_inbox', args: { action_result: 'Edited.', tags: [] } }])
  })

  it('behaves exactly like the original plan when no overrides are given', async () => {
    const steps = [{ id: 's1', tool: 'create_reminder', args: { action_result: 'Reminder set.', tags: ['health'] } }]
    const result = await runProgram(steps, {})
    expect(result).toEqual({ status: 'reminder', tags: ['health'], action_result: 'Reminder set.', plan_steps: steps })
  })
})

describe('getFormFields', () => {
  it('skips terminal classification steps entirely (nothing to parameterize)', () => {
    const steps = [{ id: 's1', tool: 'save_to_inbox', args: { action_result: 'Saved.', tags: ['work'] } }]
    expect(getFormFields(steps)).toEqual([])
  })

  it('returns an empty list for no steps', () => {
    expect(getFormFields(undefined)).toEqual([])
    expect(getFormFields([])).toEqual([])
  })
})
