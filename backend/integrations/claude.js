import Anthropic from '@anthropic-ai/sdk'
import { resolveEnv } from '../secrets.js'
import { createLinearTask } from './linear.js'

const client = new Anthropic({ apiKey: await resolveEnv('ANTHROPIC_API_KEY') })

const linearApiKey = await resolveEnv('LINEAR_API_KEY')
const linearTeamId = await resolveEnv('LINEAR_TEAM_ID')
export const LINEAR_ENABLED = Boolean(linearApiKey && linearTeamId)

const SYSTEM_PROMPT = `You are the intent processor for a personal quick-capture app. The user has just captured a thought, note, task, or reminder.

Your job is to classify and act on it by calling exactly one tool:
- save_to_inbox: a general note or task to triage later
- create_reminder: something time-sensitive that should become a calendar event or reminder
- flag_urgent: something that needs immediate attention${LINEAR_ENABLED ? `
- create_linear_task: real project/engineering work that should be tracked in Linear (e.g. "fix the login bug", "add dark mode") — this proposes the task; it isn't created until the human approves it` : ''}

Always include a short, natural-language action_result string describing what you did (e.g. "Saved to inbox", "Reminder set: 'Call dentist' — Tomorrow, 9:00am", "Flagged as urgent"). This is not needed for create_linear_task — a description of the proposal is generated automatically.

Also provide an array of 1–3 lowercase tags (e.g. ["shopping"], ["health", "urgent"], ["work"]).`

const TOOLS = [
  {
    name: 'save_to_inbox',
    description: 'Save a general note, thought, or task to the inbox for later triage.',
    input_schema: {
      type: 'object',
      properties: {
        action_result: { type: 'string', description: 'Short natural-language description of what was done.' },
        tags: { type: 'array', items: { type: 'string' }, description: '1–3 lowercase tags.' },
      },
      required: ['action_result', 'tags'],
    },
  },
  {
    name: 'create_reminder',
    description: 'Create a reminder or calendar event for a time-sensitive capture.',
    input_schema: {
      type: 'object',
      properties: {
        action_result: { type: 'string', description: 'Short natural-language description, e.g. "Reminder set: \'Call dentist\' — Tomorrow, 9:00am"' },
        tags: { type: 'array', items: { type: 'string' }, description: '1–3 lowercase tags.' },
      },
      required: ['action_result', 'tags'],
    },
  },
  {
    name: 'flag_urgent',
    description: 'Flag something as urgent that needs immediate attention.',
    input_schema: {
      type: 'object',
      properties: {
        action_result: { type: 'string', description: 'Short natural-language description of the urgent item.' },
        tags: { type: 'array', items: { type: 'string' }, description: '1–3 lowercase tags.' },
      },
      required: ['action_result', 'tags'],
    },
  },
]

if (LINEAR_ENABLED) {
  TOOLS.push({
    name: 'create_linear_task',
    description: 'Create a task in Linear for real project or engineering work — not a personal note or reminder.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short task title.' },
        description: { type: 'string', description: 'Optional longer description.' },
        tags: { type: 'array', items: { type: 'string' }, description: '1–3 lowercase tags.' },
      },
      required: ['title', 'tags'],
    },
  })
}

const TOOL_TO_STATUS = {
  save_to_inbox: 'triaged',
  create_reminder: 'reminder',
  flag_urgent: 'urgent',
}

// Tools with a real external side effect. Picking one of these doesn't
// run it — processCapture() only records the proposed call, and it's
// executeAction() that actually performs it, once approved.
const ACTING_TOOLS = {
  create_linear_task: {
    describe: ({ title }) => `Proposed: create Linear task "${title}"`,
    execute: async ({ title, description }) => {
      const issue = await createLinearTask({ apiKey: linearApiKey, teamId: linearTeamId, title, description })
      return `Linear task created: "${issue.title}" — ${issue.url}`
    },
  },
}

export async function processCapture(text) {
  const response = await client.messages.create({
    model: 'claude-opus-4-6',
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    tools: TOOLS,
    tool_choice: { type: 'any' },
    messages: [{ role: 'user', content: text }],
  })

  const toolUse = response.content.find(b => b.type === 'tool_use')
  if (!toolUse) {
    return { status: 'triaged', tags: [], action_result: 'Saved to inbox.' }
  }

  const actingTool = ACTING_TOOLS[toolUse.name]
  if (actingTool) {
    const { tags, ...input } = toolUse.input
    return {
      status: 'awaiting_approval',
      tags: tags ?? [],
      action_result: actingTool.describe(input),
      pending_action: { tool: toolUse.name, input },
    }
  }

  const { action_result, tags } = toolUse.input
  const status = TOOL_TO_STATUS[toolUse.name] ?? 'triaged'
  return { status, tags: tags ?? [], action_result }
}

// Runs a previously-proposed action after the human has approved it.
export async function executeAction({ tool, input }) {
  const actingTool = ACTING_TOOLS[tool]
  if (!actingTool) throw new Error(`Unknown action tool: ${tool}`)
  const action_result = await actingTool.execute(input)
  return { status: 'acted', action_result }
}
