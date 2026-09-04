import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockCreate, mockResolveSpeaker, mockCommitPlayback, mockResolveLight, mockCommitLight, mockGetHouses, mockSearchTrack } = vi.hoisted(() => ({
  mockCreate: vi.fn(),
  mockResolveSpeaker: vi.fn(),
  mockCommitPlayback: vi.fn(),
  mockResolveLight: vi.fn(),
  mockCommitLight: vi.fn(),
  mockGetHouses: vi.fn(),
  mockSearchTrack: vi.fn(),
}))

vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn(() => ({ messages: { create: mockCreate } })),
}))

vi.mock('../integrations/satellite.js', () => ({
  resolveSpeaker: mockResolveSpeaker,
  commitPlayback: mockCommitPlayback,
  resolveLight: mockResolveLight,
  commitLight: mockCommitLight,
  getHouses: mockGetHouses,
}))

vi.mock('../integrations/spotify.js', () => ({
  searchTrack: mockSearchTrack,
}))

// SATELLITES_ENABLED/SPOTIFY_ENABLED are decided at module load time, from
// getHouses() and these env vars respectively, so both must be set before
// importing claude.js. This file exists separately from claude.test.js so
// the two module-load configurations don't collide.
mockGetHouses.mockReturnValue({ home: 'http://localhost:4000' })
process.env.SPOTIFY_CLIENT_ID = 'test-spotify-client'
process.env.SPOTIFY_CLIENT_SECRET = 'test-spotify-secret'

const { processCapture, executeAction, runProgram, getFormFields, getFavouriteLabel } = await import('../integrations/claude.js')

const track = { id: 'trk_abc123', title: 'Silver Machine', artist: 'Hawkwind', album: null, matchConfidence: 'exact' }
const speaker = { name: 'Living Room', requested: 'living room', confidence: 'exact' }
const resolved = { track, speaker }

const room = { id: 'room_1', name: 'Living Room', requested: 'living room', confidence: 'exact' }

beforeEach(() => {
  mockCreate.mockClear()
  mockResolveSpeaker.mockClear()
  mockCommitPlayback.mockClear()
  mockResolveLight.mockClear()
  mockCommitLight.mockClear()
  mockGetHouses.mockClear()
  mockSearchTrack.mockClear()
  mockGetHouses.mockReturnValue({ home: 'http://localhost:4000' })
  mockResolveSpeaker.mockResolvedValue({ speaker })
  mockSearchTrack.mockResolvedValue(track)
  mockResolveLight.mockResolvedValue({ room, action: 'set_brightness', brightness: 20, color: undefined })
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

// Same two-step shape for lights: resolve_light (readonly) runs
// automatically, control_light (acting) references its whole output.
function lightPlan(resolveArgs, overrides = {}) {
  return [
    { id: 's1', tool: 'resolve_light', args: resolveArgs },
    {
      id: 's2',
      tool: 'control_light',
      args: { target_house: '${s1.target_house}', room: '${s1.room}', action: '${s1.action}', brightness: '${s1.brightness}', color: '${s1.color}', tags: [], ...overrides },
    },
  ]
}

describe('processCapture with satellites and Spotify enabled', () => {
  it('offers resolve_playback and control_playback as tools', async () => {
    respondWithPlan([{ id: 's1', tool: 'save_to_inbox', args: { action_result: 'ok', tags: [] } }])
    await processCapture('anything')
    const toolNames = mockCreate.mock.calls[0][0].tools[0].input_schema.properties.steps.items.properties.tool.enum
    expect(toolNames).toContain('resolve_playback')
    expect(toolNames).toContain('control_playback')
  })

  it('resolves before proposing, and the proposal shows the resolved particulars', async () => {
    const plan = playbackPlan({ title: 'Silver Machine', artist: 'Hawkwind', room: 'living room' })
    respondWithPlan(plan)

    const result = await processCapture("play 'Silver Machine' by Hawkwind in the living room")

    // Track comes straight from Spotify (client-credentials, no
    // local-network dependency); speaker comes from the satellite — the
    // two independent lookups behind resolve_playback. See
    // designs/satellites.md.
    expect(mockSearchTrack).toHaveBeenCalledWith({
      clientId: 'test-spotify-client',
      clientSecret: 'test-spotify-secret',
      title: 'Silver Machine',
      artist: 'Hawkwind',
      album: undefined,
      market: undefined,
    })
    expect(mockResolveSpeaker).toHaveBeenCalledWith({
      houses: { home: 'http://localhost:4000' },
      house: null, // no target_house in the plan and no capture origin passed -> defaults to null
      room: 'living room',
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
      plan_steps: plan,
    })
  })

  it('defaults target_house on resolve_playback to the capture origin when the text names no house', async () => {
    respondWithPlan(playbackPlan({ title: 'Oxygene', room: 'living room' }))

    const result = await processCapture('play Oxygene in the living room', { house: 'home' })

    expect(mockResolveSpeaker).toHaveBeenCalledWith(expect.objectContaining({ house: 'home' }))
    expect(result.pending_action.input.target_house).toBe('home')
    expect(result.action_result).toContain('(home)')
  })

  it('keeps an explicitly named target_house on resolve_playback over the capture origin', async () => {
    respondWithPlan(playbackPlan({ title: 'Oxygene', room: 'living room', target_house: 'lake' }))

    const result = await processCapture('play Oxygene in the lake house living room', { house: 'home' })

    expect(mockResolveSpeaker).toHaveBeenCalledWith(expect.objectContaining({ house: 'lake' }))
    expect(result.pending_action.input.target_house).toBe('lake')
  })

  it('propagates a resolve_playback failure (e.g. no matching speaker), staged as a resolution failure', async () => {
    mockResolveSpeaker.mockRejectedValue(new Error('No speaker matching "garage"'))
    respondWithPlan(playbackPlan({ title: 'x', room: 'garage' }))

    await expect(processCapture('play x in the garage')).rejects.toThrow(
      'resolving "Finding matching track and speaker" failed: No speaker matching "garage"'
    )
  })

  it('propagates a Spotify search failure, staged as a resolution failure', async () => {
    mockSearchTrack.mockRejectedValue(new Error('No Spotify track matching "x"'))
    respondWithPlan(playbackPlan({ title: 'x', room: 'living room' }))

    await expect(processCapture('play x in the living room')).rejects.toThrow(
      'resolving "Finding matching track and speaker" failed: No Spotify track matching "x"'
    )
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

describe('processCapture with lights enabled', () => {
  it('offers resolve_light and control_light as tools', async () => {
    respondWithPlan([{ id: 's1', tool: 'save_to_inbox', args: { action_result: 'ok', tags: [] } }])
    await processCapture('anything')
    const toolNames = mockCreate.mock.calls[0][0].tools[0].input_schema.properties.steps.items.properties.tool.enum
    expect(toolNames).toContain('resolve_light')
    expect(toolNames).toContain('control_light')
  })

  it('resolves before proposing, and the proposal shows the resolved room', async () => {
    const plan = lightPlan({ room: 'living room', action: 'set_brightness', brightness: 20 })
    respondWithPlan(plan)

    const result = await processCapture('dim the living room lights to 20%')

    expect(mockResolveLight).toHaveBeenCalledWith({
      houses: { home: 'http://localhost:4000' },
      house: null,
      room: 'living room',
      action: 'set_brightness',
      brightness: 20,
    })
    expect(mockCommitLight).not.toHaveBeenCalled()
    expect(result).toEqual({
      status: 'awaiting_approval',
      tags: [],
      // The exact resolved room name, not the raw request text.
      action_result: 'Proposed: dim to 20% lights in "Living Room"',
      pending_action: {
        tool: 'control_light',
        input: { target_house: null, room, action: 'set_brightness', brightness: 20 },
      },
      plan_steps: plan,
    })
  })

  it('defaults target_house on resolve_light to the capture origin when the text names no house', async () => {
    respondWithPlan(lightPlan({ room: 'living room', action: 'off' }))
    mockResolveLight.mockResolvedValue({ room, action: 'off', brightness: undefined, color: undefined })

    const result = await processCapture('turn off the living room lights', { house: 'home' })

    expect(mockResolveLight).toHaveBeenCalledWith(expect.objectContaining({ house: 'home' }))
    expect(result.pending_action.input.target_house).toBe('home')
    expect(result.action_result).toContain('(home)')
  })

  it('keeps an explicitly named target_house on resolve_light over the capture origin', async () => {
    respondWithPlan(lightPlan({ room: 'living room', action: 'off', target_house: 'lake' }))
    mockResolveLight.mockResolvedValue({ room, action: 'off', brightness: undefined, color: undefined })

    const result = await processCapture('turn off the lake house living room lights', { house: 'home' })

    expect(mockResolveLight).toHaveBeenCalledWith(expect.objectContaining({ house: 'lake' }))
    expect(result.pending_action.input.target_house).toBe('lake')
  })

  it('propagates a resolve_light failure (e.g. no matching room) as a thrown error', async () => {
    mockResolveLight.mockRejectedValue(new Error('No room matching "attic"'))
    respondWithPlan(lightPlan({ room: 'attic', action: 'on' }))

    await expect(processCapture('turn on the attic lights')).rejects.toThrow('No room matching')
  })

  it('resolves a set_color request, and the proposal shows the resolved colour', async () => {
    mockResolveLight.mockResolvedValue({ room, action: 'set_color', brightness: undefined, color: '#ff0000' })
    const plan = lightPlan({ room: 'living room', action: 'set_color', color: '#ff0000' })
    respondWithPlan(plan)

    const result = await processCapture('make the living room lights red')

    expect(mockResolveLight).toHaveBeenCalledWith({
      houses: { home: 'http://localhost:4000' },
      house: null,
      room: 'living room',
      action: 'set_color',
      color: '#ff0000',
    })
    expect(result.action_result).toBe('Proposed: change colour to #ff0000 lights in "Living Room"')
    expect(result.pending_action.input).toEqual({ target_house: null, room, action: 'set_color', color: '#ff0000' })
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

describe('control_light execution', () => {
  it('commits exactly the resolved room and returns status acted', async () => {
    mockCommitLight.mockResolvedValue({ room, action: 'set_brightness', brightness: 20 })

    const result = await executeAction({
      tool: 'control_light',
      input: { target_house: 'home', room, action: 'set_brightness', brightness: 20 },
    })

    expect(mockGetHouses).toHaveBeenCalled()
    expect(mockCommitLight).toHaveBeenCalledWith({
      houses: { home: 'http://localhost:4000' },
      house: 'home',
      room,
      action: 'set_brightness',
      brightness: 20,
    })
    expect(result).toEqual({
      status: 'acted',
      action_result: 'Lights dimmed to 20% in "Living Room"',
    })
  })

  it('propagates satellite errors as thrown exceptions', async () => {
    mockCommitLight.mockRejectedValue(new Error('No room matching "attic"'))
    await expect(
      executeAction({ tool: 'control_light', input: { target_house: 'home', room: { id: 'x', name: 'Attic' }, action: 'on' } })
    ).rejects.toThrow('No room matching')
  })

  it('commits a set_color request and returns status acted', async () => {
    mockCommitLight.mockResolvedValue({ room, action: 'set_color', color: '#ff0000' })

    const result = await executeAction({
      tool: 'control_light',
      input: { target_house: 'home', room, action: 'set_color', color: '#ff0000' },
    })

    expect(mockCommitLight).toHaveBeenCalledWith({
      houses: { home: 'http://localhost:4000' },
      house: 'home',
      room,
      action: 'set_color',
      color: '#ff0000',
    })
    expect(result).toEqual({
      status: 'acted',
      action_result: 'Lights changed colour to #ff0000 in "Living Room"',
    })
  })
})

describe('getFormFields for a resolved playback program', () => {
  it('exposes resolve_playback\'s literal request fields, not control_playback\'s resolved refs', () => {
    const plan = playbackPlan({ title: 'Silver Machine', artist: 'Hawkwind', room: 'living room' })
    expect(getFormFields(plan)).toEqual([
      { step: 's1', tool: 'resolve_playback', field: 'title', value: 'Silver Machine', label: 'Title', type: 'text' },
      { step: 's1', tool: 'resolve_playback', field: 'artist', value: 'Hawkwind', label: 'Artist', type: 'text' },
      { step: 's1', tool: 'resolve_playback', field: 'room', value: 'living room', label: 'Room', type: 'text' },
    ])
  })
})

describe('getFavouriteLabel', () => {
  it('renders control_light as a live template, not a frozen result string', () => {
    expect(getFavouriteLabel('control_light', { room, action: 'set_brightness', brightness: 10 }, 'Lights dimmed to 10% in "Living Room"'))
      .toBe('Living Room lights (10%)')
    // Same input, different brightness — the label tracks it, which is
    // the whole point: it's recomputed from current input, not frozen.
    expect(getFavouriteLabel('control_light', { room, action: 'set_brightness', brightness: 90 }, 'irrelevant'))
      .toBe('Living Room lights (90%)')
  })

  it('renders control_light\'s colour into the template for set_color', () => {
    expect(getFavouriteLabel('control_light', { room, action: 'set_color', color: '#ff0000' }, 'irrelevant'))
      .toBe('Living Room lights (#ff0000)')
  })

  it('renders control_playback as a live template', () => {
    expect(getFavouriteLabel('control_playback', { track, speaker }, 'Played "Silver Machine" by Hawkwind on Living Room'))
      .toBe('Living Room: "Silver Machine" by Hawkwind')
  })

  it('falls back to the given fallback for a tool with no favouriteLabel (e.g. create_linear_task)', () => {
    expect(getFavouriteLabel('create_linear_task', { title: 'Fix bug' }, 'Linear task created: "Fix bug" — https://linear.app/x/1'))
      .toBe('Linear task created: "Fix bug" — https://linear.app/x/1')
  })
})

describe('getFormFields for a resolved lighting program', () => {
  it('exposes resolve_light\'s literal request fields, not control_light\'s resolved refs', () => {
    const plan = lightPlan({ room: 'living room', action: 'set_brightness', brightness: 20 })
    expect(getFormFields(plan)).toEqual([
      { step: 's1', tool: 'resolve_light', field: 'room', value: 'living room', label: 'Room', type: 'text' },
      { step: 's1', tool: 'resolve_light', field: 'action', value: 'set_brightness', label: 'Action', type: 'text' },
      { step: 's1', tool: 'resolve_light', field: 'brightness', value: 20, label: 'Brightness', type: 'number' },
    ])
  })

  it('gives a set_color request\'s colour field a "color" input type, for a colour-picker form control', () => {
    const plan = lightPlan({ room: 'living room', action: 'set_color', color: '#ff0000' })
    expect(getFormFields(plan)).toEqual([
      { step: 's1', tool: 'resolve_light', field: 'room', value: 'living room', label: 'Room', type: 'text' },
      { step: 's1', tool: 'resolve_light', field: 'action', value: 'set_color', label: 'Action', type: 'text' },
      { step: 's1', tool: 'resolve_light', field: 'color', value: '#ff0000', label: 'Color', type: 'color' },
    ])
  })
})

describe('runProgram with overrides for playback', () => {
  it('re-resolves a fresh track/speaker for an edited room, then proposes control_playback with them', async () => {
    const otherTrack = { id: 'trk_xyz', title: 'Master of the Universe', artist: 'Hawkwind', album: null, matchConfidence: 'exact' }
    const otherSpeaker = { name: 'Bedroom', requested: 'bedroom', confidence: 'exact' }
    mockSearchTrack.mockResolvedValue(otherTrack)
    mockResolveSpeaker.mockResolvedValue({ speaker: otherSpeaker })

    const plan = playbackPlan({ title: 'Silver Machine', artist: 'Hawkwind', room: 'living room' })
    const result = await runProgram(plan, {
      house: 'home',
      overrides: { s1: { title: 'Master of the Universe', room: 'bedroom' } },
    })

    expect(mockSearchTrack).toHaveBeenCalledWith(expect.objectContaining({ title: 'Master of the Universe' }))
    expect(mockResolveSpeaker).toHaveBeenCalledWith(expect.objectContaining({ room: 'bedroom' }))
    expect(result.pending_action).toEqual({
      tool: 'control_playback',
      input: { target_house: 'home', track: otherTrack, speaker: otherSpeaker },
    })
  })
})
