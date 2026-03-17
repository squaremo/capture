import Anthropic from '@anthropic-ai/sdk'

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

const SYSTEM_PROMPT = `You are the intent processor for a personal quick-capture app. The user has just captured a thought, note, task, or reminder.

Your job is to classify and act on it by calling exactly one tool:
- save_to_inbox: a general note or task to triage later
- create_reminder: something time-sensitive that should become a calendar event or reminder
- flag_urgent: something that needs immediate attention

Always include a short, natural-language action_result string describing what you did (e.g. "Saved to inbox", "Reminder set: 'Call dentist' — Tomorrow, 9:00am", "Flagged as urgent").

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

const TOOL_TO_STATUS = {
  save_to_inbox: 'triaged',
  create_reminder: 'reminder',
  flag_urgent: 'urgent',
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

  const { action_result, tags } = toolUse.input
  const status = TOOL_TO_STATUS[toolUse.name] ?? 'triaged'
  return { status, tags: tags ?? [], action_result }
}
