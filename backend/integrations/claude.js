import Anthropic from '@anthropic-ai/sdk'
import { resolveEnv } from '../secrets.js'
import { createLinearTask, searchLinearIssues } from './linear.js'
import { resolvePlayback, commitPlayback, getHouses } from './satellite.js'

const client = new Anthropic({ apiKey: await resolveEnv('ANTHROPIC_API_KEY') })

const linearApiKey = await resolveEnv('LINEAR_API_KEY')
const linearTeamId = await resolveEnv('LINEAR_TEAM_ID')
export const LINEAR_ENABLED = Boolean(linearApiKey && linearTeamId)

// Whether the control_playback tool exists at all is decided once, here,
// at startup — from whether any houses were configured at boot. Repointing
// or adding to an already-nonempty houses file takes effect live (see
// getHouses() in satellite.js); going from zero houses to a first one
// needs a restart, same as enabling Linear does. That's deliberate: always
// offering the tool even with zero houses configured would let Claude
// propose device-control for ordinary captures that happen to mention a
// song, with nothing to actually act on it — see designs/satellites.md.
export const SATELLITES_ENABLED = Object.keys(getHouses()).length > 0

// Every tool the plan can call. `kind` decides how the interpreter treats a step:
// - terminal: ends the plan immediately with a resolved status (no external effect)
// - acting: ends the plan immediately as a proposal — nothing runs until a human
//   approves it via POST /api/items/:id/approve, which calls `execute` directly
// - readonly: has real (non-mutating) external effects; runs automatically and
//   its output is bound to the step's id for later steps to reference
const TOOL_REGISTRY = {
  save_to_inbox: { kind: 'terminal', status: 'triaged' },
  create_reminder: { kind: 'terminal', status: 'reminder' },
  flag_urgent: { kind: 'terminal', status: 'urgent' },
}

if (LINEAR_ENABLED) {
  TOOL_REGISTRY.search_linear_issues = {
    kind: 'readonly',
    label: 'Checking Linear for duplicates',
    execute: ({ query }) => searchLinearIssues({ apiKey: linearApiKey, teamId: linearTeamId, query }),
  }
  TOOL_REGISTRY.create_linear_task = {
    kind: 'acting',
    describe: ({ title }) => `Proposed: create Linear task "${title}"`,
    execute: async ({ title, description }) => {
      const issue = await createLinearTask({ apiKey: linearApiKey, teamId: linearTeamId, title, description })
      return `Linear task created: "${issue.title}" — ${issue.url}`
    },
  }
}

if (SATELLITES_ENABLED) {
  TOOL_REGISTRY.resolve_playback = {
    kind: 'readonly',
    label: 'Finding matching track and speaker',
    execute: async ({ target_house, room, title, artist, album }) => {
      const { track, speaker } = await resolvePlayback({ houses: getHouses(), house: target_house, room, title, artist, album })
      return { target_house, track, speaker }
    },
  }
  TOOL_REGISTRY.control_playback = {
    kind: 'acting',
    // Shows the *resolved* track/speaker, not the raw request — a human
    // approves exactly what's about to play, not a guess that gets
    // (re-)interpreted after the fact. See designs/satellites.md.
    describe: ({ track, speaker, target_house }) =>
      `Proposed: play "${track.title}"${track.artist ? ` by ${track.artist}` : ''} on ${speaker.name}${target_house ? ` (${target_house})` : ''}`,
    execute: async ({ target_house, track, speaker }) => {
      const result = await commitPlayback({ houses: getHouses(), house: target_house, track, speaker })
      return `Played "${result.track.title}"${result.track.artist ? ` by ${result.track.artist}` : ''} on ${result.speaker.name}`
    },
  }
}

// control_playback's valid target_house names can change without a
// restart (see getHouses() in satellite.js), so this is rebuilt fresh on
// every capture rather than being a static const.
function buildSystemPrompt() {
  const houseNames = Object.keys(getHouses())
  return `You are the intent processor for a personal quick-capture app. The user has just captured a thought, note, task, or reminder.

Resolve it by calling propose_plan with an ordered list of steps. Available tools:

- save_to_inbox (terminal — ends the plan): args { action_result, tags }. A general note or task to triage later.
- create_reminder (terminal): args { action_result, tags }. Something time-sensitive that should become a calendar event or reminder.
- flag_urgent (terminal): args { action_result, tags }. Something that needs immediate attention.${LINEAR_ENABLED ? `
- search_linear_issues (read-only — runs automatically, no approval needed): args { query }. Searches existing Linear issues for a similar title. Outputs: { duplicate_found: boolean, matching_issue: { title, url } | null }.
- create_linear_task (acting — only proposes; a human must approve before anything is actually created): args { title, description?, tags }. Real project/engineering work that should be tracked in Linear (e.g. "fix the login bug", "add dark mode").` : ''}${SATELLITES_ENABLED ? `
- resolve_playback (read-only — runs automatically, no approval needed): args { title, artist?, album?, room, target_house? }. Looks up the actual matching track and speaker for a Sonos playback request — never guess a specific speaker name or track yourself, this does the matching. room is free text like "living room" or "bedroom", passed through as written. target_house should only be set when the capture text unambiguously names one of these houses: ${houseNames.join(', ')}. Leave it unset otherwise — the app fills in the house the capture came from. Outputs: { target_house, track: { title, artist, album, matchConfidence }, speaker: { name, confidence } }.
- control_playback (acting — proposes the exact resolved track and speaker; a human must approve before anything plays): args { target_house, track, speaker, tags }. Always follows resolve_playback in the same plan, referencing its whole output rather than re-stating anything: target_house: "\${s1.target_house}", track: "\${s1.track}", speaker: "\${s1.speaker}" (using whichever step id you gave resolve_playback). Never call control_playback without a resolve_playback step earlier in the same plan.` : ''}

action_result is a short natural-language description of what was done, e.g. "Saved to inbox", "Reminder set: 'Call dentist' — Tomorrow, 9:00am", "Flagged as urgent". Not needed for create_linear_task or control_playback — their descriptions are generated automatically. tags is an array of 1–3 lowercase tags.

Steps run in the order given. A read-only step's output is not shown to you before you finish planning — you only see it by referencing it later, so cover both outcomes of a boolean output using "if"/"unless" on separate steps rather than guessing which one will happen.

Reference an earlier step's output as \${stepId.field} — either as a whole argument value (which can be an entire object, e.g. "track": "\${s1.track}") or interpolated inside a string, e.g. "action_result": "Already tracked: \${s1.matching_issue.title} — \${s1.matching_issue.url}".

The plan finishes at the first terminal or acting step it reaches — nothing after it runs, so only one acting step will ever actually execute even if different branches each propose one.${LINEAR_ENABLED ? ` For a capture that might duplicate existing Linear work: search_linear_issues first, then "if" duplicate_found go to a terminal step referencing the match, "unless" duplicate_found go to create_linear_task.` : ''}`
}

function buildProposePlanTool() {
  return {
    name: 'propose_plan',
    description: 'Propose an ordered plan of tool-call steps that resolves this capture.',
    input_schema: {
      type: 'object',
      properties: {
        steps: {
          type: 'array',
          minItems: 1,
          maxItems: 8,
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Unique short id for this step, e.g. "s1".' },
              tool: { type: 'string', enum: Object.keys(TOOL_REGISTRY) },
              args: { type: 'object', description: 'Arguments for the tool. Use "${stepId.field}" to reference an earlier step\'s output.' },
              if: { type: 'string', description: 'Only run this step if this earlier boolean output is true, e.g. "${s1.duplicate_found}".' },
              unless: { type: 'string', description: 'Only run this step if this earlier boolean output is false.' },
            },
            required: ['id', 'tool', 'args'],
          },
        },
      },
      required: ['steps'],
    },
  }
}

// Looks up a (possibly nested) field on an earlier step's bound output, e.g.
// path "matching_issue.title" against bindings.s1 = { matching_issue: { title } }.
function lookupRef(stepId, path, bindings) {
  if (!(stepId in bindings)) throw new Error(`Plan referenced unknown step: ${stepId}`)
  let value = bindings[stepId]
  for (const key of path.split('.')) {
    if (value == null || !(key in value)) throw new Error(`Plan referenced unknown field: ${stepId}.${path}`)
    value = value[key]
  }
  return value
}

const REF_RE = /\$\{([^.}]+)\.([^}]+)\}/g

function resolveValue(value, bindings) {
  if (typeof value !== 'string') return value
  const whole = value.match(/^\$\{([^.}]+)\.([^}]+)\}$/)
  if (whole) return lookupRef(whole[1], whole[2], bindings)
  return value.replace(REF_RE, (_, stepId, path) => String(lookupRef(stepId, path, bindings)))
}

function resolveArgs(args, bindings) {
  return Object.fromEntries(Object.entries(args ?? {}).map(([k, v]) => [k, resolveValue(v, bindings)]))
}

function conditionHolds(step, bindings) {
  if (step.if) return Boolean(resolveValue(step.if, bindings))
  if (step.unless) return !resolveValue(step.unless, bindings)
  return true
}

export async function processCapture(text, { onStep, house } = {}) {
  const response = await client.messages.create({
    model: 'claude-opus-4-6',
    max_tokens: 1024,
    system: buildSystemPrompt(),
    tools: [buildProposePlanTool()],
    tool_choice: { type: 'tool', name: 'propose_plan' },
    messages: [{ role: 'user', content: text }],
  })

  const toolUse = response.content.find(b => b.type === 'tool_use')
  const steps = toolUse?.input?.steps
  if (!Array.isArray(steps) || steps.length === 0) {
    throw new Error('Claude proposed an empty plan')
  }

  const bindings = {}
  for (const step of steps) {
    if (!conditionHolds(step, bindings)) continue

    const def = TOOL_REGISTRY[step.tool]
    if (!def) throw new Error(`Plan referenced unknown tool: ${step.tool}`)
    const args = resolveArgs(step.args, bindings)

    // resolve_playback defaults to the house the capture came from when
    // the text didn't unambiguously name one — never guessed by Claude.
    // control_playback always gets target_house forwarded from
    // resolve_playback's output rather than defaulting independently.
    if (step.tool === 'resolve_playback' && !args.target_house) {
      args.target_house = house ?? null
    }

    if (def.kind === 'terminal') {
      const { action_result = 'Saved to inbox.', tags = [] } = args
      return { status: def.status, tags, action_result }
    }

    if (def.kind === 'acting') {
      const { tags = [], ...input } = args
      return {
        status: 'awaiting_approval',
        tags,
        action_result: def.describe(input),
        pending_action: { tool: step.tool, input },
      }
    }

    // readonly: run it now, bind its output for later steps to reference
    bindings[step.id] = await def.execute(args)
    onStep?.({ label: def.label ?? step.tool })
  }

  throw new Error('Plan finished without reaching a terminal or acting step')
}

// Runs a previously-proposed action after the human has approved it.
export async function executeAction({ tool, input }) {
  const def = TOOL_REGISTRY[tool]
  if (!def || def.kind !== 'acting') throw new Error(`Unknown action tool: ${tool}`)
  const action_result = await def.execute(input)
  return { status: 'acted', action_result }
}
