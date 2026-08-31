import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockCreate, mockCreateLinearTask, mockSearchLinearIssues } = vi.hoisted(() => ({
  mockCreate: vi.fn(),
  mockCreateLinearTask: vi.fn(),
  mockSearchLinearIssues: vi.fn(),
}))

vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn(() => ({ messages: { create: mockCreate } })),
}))

vi.mock('../integrations/linear.js', () => ({
  createLinearTask: mockCreateLinearTask,
  searchLinearIssues: mockSearchLinearIssues,
}))

// LINEAR_ENABLED is decided at module load time, so these must be set
// before importing claude.js. This file exists separately from
// claude.test.js so the two module-load configurations don't collide.
process.env.LINEAR_API_KEY = 'test-linear-key'
process.env.LINEAR_TEAM_ID = 'test-team-id'

const { processCapture, executeAction } = await import('../integrations/claude.js')

beforeEach(() => {
  mockCreate.mockClear()
  mockCreateLinearTask.mockClear()
  mockSearchLinearIssues.mockClear()
})

function respondWithPlan(steps) {
  mockCreate.mockResolvedValue({ content: [{ type: 'tool_use', name: 'propose_plan', input: { steps } }] })
}

describe('processCapture with Linear enabled', () => {
  it('offers search_linear_issues and create_linear_task as tools', async () => {
    respondWithPlan([{ id: 's1', tool: 'save_to_inbox', args: { action_result: 'ok', tags: [] } }])
    await processCapture('anything')
    const toolNames = mockCreate.mock.calls[0][0].tools[0].input_schema.properties.steps.items.properties.tool.enum
    expect(toolNames).toContain('search_linear_issues')
    expect(toolNames).toContain('create_linear_task')
  })

  it('proposes the task without creating it, awaiting approval', async () => {
    respondWithPlan([
      { id: 's1', tool: 'create_linear_task', args: { title: 'Fix bug', description: 'details', tags: ['work'] } },
    ])

    const result = await processCapture('fix the login bug')

    expect(mockCreateLinearTask).not.toHaveBeenCalled()
    expect(result).toEqual({
      status: 'awaiting_approval',
      tags: ['work'],
      action_result: 'Proposed: create Linear task "Fix bug"',
      pending_action: { tool: 'create_linear_task', input: { title: 'Fix bug', description: 'details' } },
    })
  })

  it('runs a read-only search step, then branches to create_linear_task when no duplicate is found', async () => {
    mockSearchLinearIssues.mockResolvedValue({ duplicate_found: false, matching_issue: null })
    respondWithPlan([
      { id: 's1', tool: 'search_linear_issues', args: { query: 'login bug' } },
      { id: 's2', tool: 'save_to_inbox', args: { action_result: 'dup' }, if: '${s1.duplicate_found}' },
      { id: 's3', tool: 'create_linear_task', args: { title: 'Fix bug', tags: ['work'] }, unless: '${s1.duplicate_found}' },
    ])

    const result = await processCapture('fix the login bug')

    expect(mockSearchLinearIssues).toHaveBeenCalledWith({ apiKey: 'test-linear-key', teamId: 'test-team-id', query: 'login bug' })
    expect(result.status).toBe('awaiting_approval')
    expect(result.pending_action).toEqual({ tool: 'create_linear_task', input: { title: 'Fix bug' } })
  })

  it('branches to a terminal step and interpolates the matched issue when a duplicate is found', async () => {
    mockSearchLinearIssues.mockResolvedValue({
      duplicate_found: true,
      matching_issue: { title: 'Login bug', url: 'https://linear.app/x/issue/1' },
    })
    respondWithPlan([
      { id: 's1', tool: 'search_linear_issues', args: { query: 'login bug' } },
      {
        id: 's2',
        tool: 'save_to_inbox',
        args: { action_result: 'Already tracked: ${s1.matching_issue.title} — ${s1.matching_issue.url}', tags: ['work'] },
        if: '${s1.duplicate_found}',
      },
      { id: 's3', tool: 'create_linear_task', args: { title: 'Fix bug', tags: ['work'] }, unless: '${s1.duplicate_found}' },
    ])

    const result = await processCapture('fix the login bug')

    expect(mockCreateLinearTask).not.toHaveBeenCalled()
    expect(result).toEqual({
      status: 'triaged',
      tags: ['work'],
      action_result: 'Already tracked: Login bug — https://linear.app/x/issue/1',
    })
  })
})

describe('executeAction', () => {
  it('runs the proposed Linear task creation and returns status acted', async () => {
    mockCreateLinearTask.mockResolvedValue({ url: 'https://linear.app/x/issue/1', title: 'Fix bug' })

    const result = await executeAction({ tool: 'create_linear_task', input: { title: 'Fix bug', description: 'details' } })

    expect(mockCreateLinearTask).toHaveBeenCalledWith({
      apiKey: 'test-linear-key',
      teamId: 'test-team-id',
      title: 'Fix bug',
      description: 'details',
    })
    expect(result).toEqual({
      status: 'acted',
      action_result: 'Linear task created: "Fix bug" — https://linear.app/x/issue/1',
    })
  })

  it('propagates Linear API errors as thrown exceptions', async () => {
    mockCreateLinearTask.mockRejectedValue(new Error('Linear API error: 401'))
    await expect(executeAction({ tool: 'create_linear_task', input: { title: 'x' } })).rejects.toThrow('Linear API error: 401')
  })

  it('throws for an unknown tool', async () => {
    await expect(executeAction({ tool: 'nonexistent', input: {} })).rejects.toThrow('Unknown action tool')
  })

  it('throws for a non-acting tool', async () => {
    await expect(executeAction({ tool: 'search_linear_issues', input: {} })).rejects.toThrow('Unknown action tool')
  })
})
