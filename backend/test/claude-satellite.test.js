import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockCreate, mockControlPlayback } = vi.hoisted(() => ({
  mockCreate: vi.fn(),
  mockControlPlayback: vi.fn(),
}))

vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn(() => ({ messages: { create: mockCreate } })),
}))

vi.mock('../integrations/satellite.js', () => ({
  controlPlayback: mockControlPlayback,
}))

// SATELLITES_ENABLED is decided at module load time, so this must be set
// before importing claude.js. This file exists separately from
// claude.test.js so the two module-load configurations don't collide.
process.env.SATELLITE_HOUSES = JSON.stringify({ home: 'http://localhost:4000' })

const { processCapture, executeAction } = await import('../integrations/claude.js')

beforeEach(() => {
  mockCreate.mockClear()
  mockControlPlayback.mockClear()
})

function respondWithPlan(steps) {
  mockCreate.mockResolvedValue({ content: [{ type: 'tool_use', name: 'propose_plan', input: { steps } }] })
}

describe('processCapture with satellites enabled', () => {
  it('offers control_playback as a tool', async () => {
    respondWithPlan([{ id: 's1', tool: 'save_to_inbox', args: { action_result: 'ok', tags: [] } }])
    await processCapture('anything')
    const toolNames = mockCreate.mock.calls[0][0].tools[0].input_schema.properties.steps.items.properties.tool.enum
    expect(toolNames).toContain('control_playback')
  })

  it('proposes playback without calling the satellite, awaiting approval', async () => {
    respondWithPlan([
      { id: 's1', tool: 'control_playback', args: { title: 'Silver Machine', artist: 'Hawkwind', room: 'living room' } },
    ])

    const result = await processCapture("play 'Silver Machine' by Hawkwind in the living room")

    expect(mockControlPlayback).not.toHaveBeenCalled()
    expect(result).toEqual({
      status: 'awaiting_approval',
      tags: [],
      action_result: 'Proposed: play "Silver Machine" by Hawkwind in living room (house unknown)',
      pending_action: {
        tool: 'control_playback',
        input: { title: 'Silver Machine', artist: 'Hawkwind', room: 'living room', target_house: null },
      },
    })
  })

  it('defaults target_house to the capture origin when the text names no house', async () => {
    respondWithPlan([{ id: 's1', tool: 'control_playback', args: { title: 'Oxygene', room: 'living room' } }])

    const result = await processCapture('play Oxygene in the living room', { house: 'home' })

    expect(result.pending_action.input.target_house).toBe('home')
    expect(result.action_result).toContain('(home)')
  })

  it('keeps an explicitly named target_house over the capture origin', async () => {
    respondWithPlan([
      { id: 's1', tool: 'control_playback', args: { title: 'Oxygene', room: 'living room', target_house: 'lake' } },
    ])

    const result = await processCapture('play Oxygene in the lake house living room', { house: 'home' })

    expect(result.pending_action.input.target_house).toBe('lake')
  })
})

describe('executeAction with satellites enabled', () => {
  it('dispatches to the resolved house and returns status acted', async () => {
    mockControlPlayback.mockResolvedValue({ playing: true, track: 'Silver Machine by Hawkwind', room: 'living room' })

    const result = await executeAction({
      tool: 'control_playback',
      input: { title: 'Silver Machine', artist: 'Hawkwind', room: 'living room', target_house: 'home' },
    })

    expect(mockControlPlayback).toHaveBeenCalledWith({
      houses: { home: 'http://localhost:4000' },
      house: 'home',
      room: 'living room',
      title: 'Silver Machine',
      artist: 'Hawkwind',
      album: undefined,
    })
    expect(result).toEqual({
      status: 'acted',
      action_result: 'Played "Silver Machine by Hawkwind" in living room',
    })
  })

  it('propagates satellite errors as thrown exceptions', async () => {
    mockControlPlayback.mockRejectedValue(new Error('Unknown house: "lake"'))
    await expect(
      executeAction({ tool: 'control_playback', input: { title: 'x', target_house: 'lake' } })
    ).rejects.toThrow('Unknown house')
  })
})
