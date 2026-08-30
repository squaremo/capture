import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockCreate, mockCreateLinearTask } = vi.hoisted(() => ({
  mockCreate: vi.fn(),
  mockCreateLinearTask: vi.fn(),
}))

vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn(() => ({ messages: { create: mockCreate } })),
}))

vi.mock('../integrations/linear.js', () => ({
  createLinearTask: mockCreateLinearTask,
}))

// LINEAR_ENABLED is decided at module load time, so these must be set
// before importing claude.js. This file exists separately from
// claude.test.js so the two module-load configurations don't collide.
process.env.LINEAR_API_KEY = 'test-linear-key'
process.env.LINEAR_TEAM_ID = 'test-team-id'

const { processCapture } = await import('../integrations/claude.js')

beforeEach(() => {
  mockCreate.mockClear()
  mockCreateLinearTask.mockClear()
})

describe('processCapture with Linear enabled', () => {
  it('offers create_linear_task as a tool', async () => {
    mockCreate.mockResolvedValue({ content: [{ type: 'tool_use', name: 'save_to_inbox', input: { action_result: 'ok', tags: [] } }] })
    await processCapture('anything')
    const toolNames = mockCreate.mock.calls[0][0].tools.map(t => t.name)
    expect(toolNames).toContain('create_linear_task')
  })

  it('actually creates the Linear task and returns status acted', async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: 'tool_use', name: 'create_linear_task', input: { title: 'Fix bug', description: 'details', tags: ['work'] } }],
    })
    mockCreateLinearTask.mockResolvedValue({ url: 'https://linear.app/x/issue/1', title: 'Fix bug' })

    const result = await processCapture('fix the login bug')

    expect(mockCreateLinearTask).toHaveBeenCalledWith({
      apiKey: 'test-linear-key',
      teamId: 'test-team-id',
      title: 'Fix bug',
      description: 'details',
    })
    expect(result).toEqual({
      status: 'acted',
      tags: ['work'],
      action_result: 'Linear task created: "Fix bug" — https://linear.app/x/issue/1',
    })
  })

  it('propagates Linear API errors as thrown exceptions', async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: 'tool_use', name: 'create_linear_task', input: { title: 'x', tags: [] } }],
    })
    mockCreateLinearTask.mockRejectedValue(new Error('Linear API error: 401'))
    await expect(processCapture('fix the login bug')).rejects.toThrow('Linear API error: 401')
  })
})
