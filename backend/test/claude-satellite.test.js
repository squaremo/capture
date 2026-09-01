import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockCreate, mockResolvePlayback, mockCommitPlayback, mockGetHouses } = vi.hoisted(() => ({
  mockCreate: vi.fn(),
  mockResolvePlayback: vi.fn(),
  mockCommitPlayback: vi.fn(),
  mockGetHouses: vi.fn(),
}))

vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn(() => ({ messages: { create: mockCreate } })),
}))

vi.mock('../integrations/satellite.js', () => ({
  resolvePlayback: mockResolvePlayback,
  commitPlayback: mockCommitPlayback,
  getHouses: mockGetHouses,
}))

// SATELLITES_ENABLED is decided at module load time from getHouses(), so
// this must be set before importing claude.js. This file exists separately
// from claude.test.js so the two module-load configurations don't collide.
mockGetHouses.mockReturnValue({ home: 'http://localhost:4000' })

const { processCapture, executeAction } = await import('../integrations/claude.js')

const resolved = {
  track: { id: 'trk_abc123', title: 'Silver Machine', artist: 'Hawkwind', album: null, matchConfidence: 'exact' },
  speaker: { name: 'Living Room', requested: 'living room', confidence: 'exact' },
}

beforeEach(() => {
  mockCreate.mockClear()
  mockResolvePlayback.mockClear()
  mockCommitPlayback.mockClear()
  mockGetHouses.mockClear()
  mockGetHouses.mockReturnValue({ home: 'http://localhost:4000' })
  mockResolvePlayback.mockResolvedValue(resolved)
})

function respondWithPlan(steps) {
  mockCreate.mockResolvedValue({ content: [{ type: 'tool_use', name: 'propose_plan', input: { steps } }] })
}

// The two-step shape every real plan uses: resolve_playback (readonly)
// runs automatically and its whole output is referenced by control_playback
// (acting) via ${s1.field} — exactly how the interpreter is meant to chain
// a readonly step into an acting one.
function playbackPlan(resolveArgs, overrides = {}) {
  return [
    { id: 's1', tool: 'resolve_playback', args: resolveArgs },
    {
      id: 's2',
      tool: 'control_playback',
      args: { target_house: '${s1.target_house}', track: '${s1.track}', speaker: '${s1.speaker}', tags: [], ...overrides },
    },
  ]
}

describe('processCapture with satellites enabled', () => {
  it('offers resolve_playback and control_playback as tools', async () => {
    respondWithPlan([{ id: 's1', tool: 'save_to_inbox', args: { action_result: 'ok', tags: [] } }])
    await processCapture('anything')
    const toolNames = mockCreate.mock.calls[0][0].tools[0].input_schema.properties.steps.items.properties.tool.enum
    expect(toolNames).toContain('resolve_playback')
    expect(toolNames).toContain('control_playback')
  })

  it('resolves before proposing, and the proposal shows the resolved particulars', async () => {
    respondWithPlan(playbackPlan({ title: 'Silver Machine', artist: 'Hawkwind', room: 'living room' }))

    const result = await processCapture("play 'Silver Machine' by Hawkwind in the living room")

    expect(mockResolvePlayback).toHaveBeenCalledWith({
      houses: { home: 'http://localhost:4000' },
      house: null, // no target_house in the plan and no capture origin passed -> defaults to null
      room: 'living room',
      title: 'Silver Machine',
      artist: 'Hawkwind',
      album: undefined,
    })
    expect(mockCommitPlayback).not.toHaveBeenCalled()
    expect(result).toEqual({
      status: 'awaiting_approval',
      tags: [],
      // The exact resolved track/speaker, not the raw request text.
      action_result: 'Proposed: play "Silver Machine" by Hawkwind on Living Room',
      pending_action: {
        tool: 'control_playback',
        input: { target_house: null, track: resolved.track, speaker: resolved.speaker },
      },
    })
  })

  it('defaults target_house on resolve_playback to the capture origin when the text names no house', async () => {
    respondWithPlan(playbackPlan({ title: 'Oxygene', room: 'living room' }))

    const result = await processCapture('play Oxygene in the living room', { house: 'home' })

    expect(mockResolvePlayback).toHaveBeenCalledWith(expect.objectContaining({ house: 'home' }))
    expect(result.pending_action.input.target_house).toBe('home')
    expect(result.action_result).toContain('(home)')
  })

  it('keeps an explicitly named target_house on resolve_playback over the capture origin', async () => {
    respondWithPlan(playbackPlan({ title: 'Oxygene', room: 'living room', target_house: 'lake' }))

    const result = await processCapture('play Oxygene in the lake house living room', { house: 'home' })

    expect(mockResolvePlayback).toHaveBeenCalledWith(expect.objectContaining({ house: 'lake' }))
    expect(result.pending_action.input.target_house).toBe('lake')
  })

  it('propagates a resolve_playback failure (e.g. no matching speaker) as a thrown error', async () => {
    mockResolvePlayback.mockRejectedValue(new Error('No speaker matching "garage"'))
    respondWithPlan(playbackPlan({ title: 'x', room: 'garage' }))

    await expect(processCapture('play x in the garage')).rejects.toThrow('No speaker matching')
  })

  it('reflects a house added to getHouses() since startup, without re-importing', async () => {
    // SATELLITES_ENABLED was decided at import time from the original
    // mock (just "home") — this only checks the *house name list* fed
    // into the prompt is re-read per call, not the enabled/disabled gate.
    mockGetHouses.mockReturnValue({ home: 'http://localhost:4000', lake: 'http://localhost:4001' })
    respondWithPlan([{ id: 's1', tool: 'save_to_inbox', args: { action_result: 'ok', tags: [] } }])

    await processCapture('anything')

    const prompt = mockCreate.mock.calls[0][0].system
    expect(prompt).toContain('home, lake')
  })
})

describe('executeAction with satellites enabled', () => {
  it('commits exactly the resolved track/speaker and returns status acted', async () => {
    mockCommitPlayback.mockResolvedValue({ playing: true, ...resolved })

    const result = await executeAction({
      tool: 'control_playback',
      input: { target_house: 'home', track: resolved.track, speaker: resolved.speaker },
    })

    expect(mockGetHouses).toHaveBeenCalled()
    expect(mockCommitPlayback).toHaveBeenCalledWith({
      houses: { home: 'http://localhost:4000' },
      house: 'home',
      track: resolved.track,
      speaker: resolved.speaker,
    })
    expect(result).toEqual({
      status: 'acted',
      action_result: 'Played "Silver Machine" by Hawkwind on Living Room',
    })
  })

  it('propagates satellite errors as thrown exceptions', async () => {
    mockCommitPlayback.mockRejectedValue(new Error('Unknown house: "lake"'))
    await expect(
      executeAction({ tool: 'control_playback', input: { target_house: 'lake', track: resolved.track, speaker: resolved.speaker } })
    ).rejects.toThrow('Unknown house')
  })
})
