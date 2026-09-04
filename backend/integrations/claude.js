import Anthropic from '@anthropic-ai/sdk'
import { resolveEnv } from '../secrets.js'
import { createLinearTask, searchLinearIssues } from './linear.js'
import { resolveSpeaker, commitPlayback, resolveLight, commitLight, getHouses } from './satellite.js'
import { searchTrack } from './spotify.js'

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

const spotifyClientId = await resolveEnv('SPOTIFY_CLIENT_ID')
const spotifyClientSecret = await resolveEnv('SPOTIFY_CLIENT_SECRET')
export const SPOTIFY_ENABLED = Boolean(spotifyClientId && spotifyClientSecret)

// Scopes catalog search to the household's own Spotify market — plain
// config, not a secret, so read directly rather than through resolveEnv.
// See spotify.js's searchTrack() for why this matters for playback, not
// just search relevance.
const spotifyMarket = process.env.SPOTIFY_MARKET

// resolve_playback needs both a house to reach (SATELLITES_ENABLED) and a
// way to search the catalog (SPOTIFY_ENABLED) — offering the tool with
// only one configured would let Claude propose device-control that can
// never actually resolve. See designs/satellites.md.
const PLAYBACK_ENABLED = SATELLITES_ENABLED && SPOTIFY_ENABLED

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

if (PLAYBACK_ENABLED) {
  TOOL_REGISTRY.resolve_playback = {
    kind: 'readonly',
    // resolvesHouse marks a readonly tool that dispatches to a satellite
    // and takes a target_house arg — runProgram uses it below to apply
    // "default to the capture's house of origin, never guessed by
    // Claude" to every such tool generically, rather than special-casing
    // tool names one at a time. The acting tool that follows it always
    // gets target_house forwarded from this step's output instead of
    // defaulting independently.
    resolvesHouse: true,
    label: 'Finding matching track and speaker',
    // Track and speaker are independent lookups, run concurrently: the
    // track comes straight from Spotify (a plain cloud catalog read, no
    // local-network dependency), the speaker from the satellite's own
    // device list (which does). See designs/satellites.md.
    execute: async ({ target_house, room, title, artist, album }) => {
      const [track, { speaker }] = await Promise.all([
        searchTrack({ clientId: spotifyClientId, clientSecret: spotifyClientSecret, title, artist, album, market: spotifyMarket }),
        resolveSpeaker({ houses: getHouses(), house: target_house, room }),
      ])
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
    // A live template, not a frozen snapshot: this is recomputed from
    // the favourite's *current* input every time it changes (see
    // getFavouriteLabel() below and POST /api/favourites/:id/run), so
    // editing the track/room via the form and running it makes this the
    // new label too — it always names whatever the favourite would
    // replay right now, never a stale first-run value.
    favouriteLabel: ({ track, speaker }) => `${speaker.name}: "${track.title}"${track.artist ? ` by ${track.artist}` : ''}`,
  }
}

if (SATELLITES_ENABLED) {
  TOOL_REGISTRY.resolve_light = {
    kind: 'readonly',
    resolvesHouse: true,
    label: 'Finding matching room',
    // Room matching (and action/brightness/color validation) is a local,
    // no-catalog-dependency lookup against the satellite's own Dirigera
    // hub — unlike resolve_playback there's no separate central-side
    // lookup to run concurrently. See designs/matter-lighting.md.
    execute: async ({ target_house, room, action, brightness, color }) => {
      const resolved = await resolveLight({ houses: getHouses(), house: target_house, room, action, brightness, color })
      return { target_house, ...resolved }
    },
  }
  TOOL_REGISTRY.control_light = {
    kind: 'acting',
    // Shows the *resolved* room, not the raw request — same reasoning as
    // control_playback above.
    describe: ({ room, action, brightness, color, target_house }) => {
      const verb = lightVerb(action, brightness, color)
      return `Proposed: ${verb} lights in "${room.name}"${target_house ? ` (${target_house})` : ''}`
    },
    execute: async ({ target_house, room, action, brightness, color }) => {
      const result = await commitLight({ houses: getHouses(), house: target_house, room, action, brightness, color })
      const verb = lightVerb(result.action, result.brightness, result.color, { past: true })
      return `Lights ${verb} in "${result.room.name}"`
    },
    // Same live-template reasoning as control_playback's favouriteLabel
    // above — recomputed from current input, not frozen at favourite
    // time, so it tracks whatever level/colour this would actually
    // replay at.
    favouriteLabel: ({ room, action, brightness, color }) => {
      const state = action === 'off' ? 'off' : action === 'on' ? 'on' : lightState(brightness, color)
      return `${room.name} lights (${state})`
    },
  }
}

// Shared between control_light's describe()/execute()/favouriteLabel so
// "off"/"on"/"dim to X% and change colour to Y" (or their past-tense
// forms for the actually-executed result) aren't three separately-
// maintained chains. A 'set' action carries brightness and/or color —
// whichever the capture actually specified — so the phrasing joins
// whichever of the two are present rather than assuming exactly one.
function lightVerb(action, brightness, color, { past = false } = {}) {
  if (action === 'off') return past ? 'turned off' : 'turn off'
  if (action === 'on') return past ? 'turned on' : 'turn on'
  const parts = []
  if (brightness != null) parts.push(`${past ? 'dimmed' : 'dim'} to ${brightness}%`)
  if (color != null) parts.push(`${past ? 'changed' : 'change'} colour to ${color}`)
  return parts.join(' and ')
}

// The compact "(...)" form for favouriteLabel — same brightness/color
// join as lightVerb, without the verb.
function lightState(brightness, color) {
  const parts = []
  if (brightness != null) parts.push(`${brightness}%`)
  if (color != null) parts.push(color)
  return parts.join(', ')
}

// A tool can define favouriteLabel(input) to render its label as a live
// template instead of freezing action_result verbatim at favourite-create
// time. What makes this different from just using action_result: it's
// re-evaluated against the favourite's *current* input every time that
// input changes — POST /api/favourites/:id/run persists whatever
// tool/input actually ran (edited via the form or not) back onto the
// favourite and regenerates its label from favouriteLabel(input), so the
// button always names what running it *now* would do, not a snapshot from
// whenever it was first favourited. create_linear_task doesn't define one
// — action_result (the fallback) already says exactly what happened, and
// there's no template needed to keep a title in sync with itself.
export function getFavouriteLabel(tool, input, fallback) {
  return TOOL_REGISTRY[tool]?.favouriteLabel?.(input) ?? fallback
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
- create_linear_task (acting — only proposes; a human must approve before anything is actually created): args { title, description?, tags }. Real project/engineering work that should be tracked in Linear (e.g. "fix the login bug", "add dark mode").` : ''}${PLAYBACK_ENABLED ? `
- resolve_playback (read-only — runs automatically, no approval needed): args { title, artist?, album?, room, target_house? }. Looks up the actual matching track and speaker for a Sonos playback request — never guess a specific speaker name or track yourself, this does the matching. room is free text like "living room" or "bedroom", passed through as written. target_house should only be set when the capture text unambiguously names one of these houses: ${houseNames.join(', ')}. Leave it unset otherwise — the app fills in the house the capture came from. Outputs: { target_house, track: { title, artist, album, image, matchConfidence }, speaker: { name, confidence } }.
- control_playback (acting — proposes the exact resolved track and speaker; a human must approve before anything plays): args { target_house, track, speaker, tags }. Always follows resolve_playback in the same plan, referencing its whole output rather than re-stating anything: target_house: "\${s1.target_house}", track: "\${s1.track}", speaker: "\${s1.speaker}" (using whichever step id you gave resolve_playback). Never call control_playback without a resolve_playback step earlier in the same plan.` : ''}${SATELLITES_ENABLED ? `
- resolve_light (read-only — runs automatically, no approval needed): args { room, action, brightness?, color?, target_house? }. Looks up the actual matching room for a light-control request via the house's Matter hub — never guess a specific room name yourself, this does the matching. room is free text like "living room", passed through as written. action is "on", "off", or "set" (with brightness — 1-100 — and/or color — a 6-digit hex string — whichever the capture actually specifies, never both unless both are actually asked for: "set the living room lights to green" -> action "set", color "#00ff00" (no brightness); "dim the living room to 20%" -> action "set", brightness 20 (no color); "dim the living room to 20% and make it red" -> action "set", brightness 20, color "#ff0000". For color, figure out the hex value yourself from the named colour, same as you would for any other colour question — room matching is the only thing that gets resolved locally). target_house follows the same rule as resolve_playback's. Outputs: { target_house, room: { name, confidence }, action, brightness, color }.
- control_light (acting — proposes the exact resolved room; a human must approve before anything happens): args { target_house, room, action, brightness, color, tags }. Always follows resolve_light in the same plan, referencing its whole output: target_house: "\${s1.target_house}", room: "\${s1.room}", action: "\${s1.action}", brightness: "\${s1.brightness}", color: "\${s1.color}" (using whichever step id you gave resolve_light). Never call control_light without a resolve_light step earlier in the same plan.` : ''}

action_result is a short natural-language description of what was done, e.g. "Saved to inbox", "Reminder set: 'Call dentist' — Tomorrow, 9:00am", "Flagged as urgent". Not needed for create_linear_task, control_playback, or control_light — their descriptions are generated automatically. tags is an array of 1–3 lowercase tags.

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
  let response
  try {
    response = await client.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 1024,
      system: buildSystemPrompt(),
      tools: [buildProposePlanTool()],
      tool_choice: { type: 'tool', name: 'propose_plan' },
      messages: [{ role: 'user', content: text }],
    })
  } catch (err) {
    throw new Error(`Claude API error: ${err.message}`)
  }

  const toolUse = response.content.find(b => b.type === 'tool_use')
  const steps = toolUse?.input?.steps
  if (!Array.isArray(steps) || steps.length === 0) {
    throw new Error('Claude proposed an empty plan')
  }

  return runProgram(steps, { house, onStep })
}

// Interprets a plan to its terminal/acting conclusion — shared by a
// freshly-proposed plan (processCapture, above) and by replaying one
// that already ran before (approving an edited pending_action, or
// running a favourite with edited inputs — see server.js). Either way
// it's the same "program": an ordered list of steps, each a tool plus
// literal args (optionally referencing an earlier step's output via
// "${stepId.field}"), that always resolves to the same one terminal or
// acting step.
//
// `overrides`, keyed by step id then arg name, lets a caller substitute
// edited values for a step's literal args before they're resolved —
// this is what turns a frozen favourite/proposal into an editable form:
// the human's edits flow through exactly the same readonly-then-acting
// pipeline as the original plan, so e.g. changing resolve_playback's
// room re-runs the real speaker lookup rather than just patching text.
//
// Returns the resolved outcome plus `plan_steps`: the literal steps
// actually reached, in order (skipped branches omitted, refs left
// untouched) — a replayable, editable record of "the program", not just
// its resolved output. Persisted on items/favourites for this purpose.
export async function runProgram(steps, { house, onStep, overrides } = {}) {
  const bindings = {}
  const executedSteps = []

  for (const step of steps) {
    if (!conditionHolds(step, bindings)) continue

    const def = TOOL_REGISTRY[step.tool]
    if (!def) throw new Error(`Plan referenced unknown tool: ${step.tool}`)

    const rawArgs = { ...step.args, ...overrides?.[step.id] }
    const args = resolveArgs(rawArgs, bindings)
    executedSteps.push({ ...step, args: rawArgs })

    // Any resolvesHouse tool (resolve_playback, resolve_light) defaults
    // target_house to the capture's house of origin when the text didn't
    // unambiguously name one — never guessed by Claude. The acting step
    // that follows it always gets target_house forwarded from that
    // output rather than defaulting independently.
    if (def.resolvesHouse && !args.target_house) {
      args.target_house = house ?? null
    }

    if (def.kind === 'terminal') {
      const { action_result = 'Saved to inbox.', tags = [] } = args
      return { status: def.status, tags, action_result, plan_steps: executedSteps }
    }

    if (def.kind === 'acting') {
      const { tags = [], ...input } = args
      return {
        status: 'awaiting_approval',
        tags,
        action_result: def.describe(input),
        pending_action: { tool: step.tool, input },
        plan_steps: executedSteps,
      }
    }

    // readonly: run it now, bind its output for later steps to reference
    try {
      bindings[step.id] = await def.execute(args)
    } catch (err) {
      throw new Error(`resolving "${def.label ?? step.tool}" failed: ${err.message}`)
    }
    onStep?.({ label: def.label ?? step.tool })
  }

  throw new Error('Plan finished without reaching a terminal or acting step')
}

// Extracts the editable "form" for a program: the literal (non-templated)
// arguments of its readonly/acting steps, in order. A "${stepId.field}"
// reference is skipped — there's nothing meaningful to type into a value
// that's computed from an earlier step — and terminal classification
// steps (save_to_inbox etc.) are skipped entirely, since they're not
// parameterizing an action. `tags` is bookkeeping, not a form field.
const REF_ONLY_RE = /^\$\{[^.}]+\.[^}]+\}$/

export function getFormFields(steps) {
  const fields = []
  for (const step of steps ?? []) {
    const def = TOOL_REGISTRY[step.tool]
    if (!def || def.kind === 'terminal') continue
    for (const [field, value] of Object.entries(step.args ?? {})) {
      if (field === 'tags' || value == null || typeof value === 'object') continue
      if (typeof value === 'string' && REF_ONLY_RE.test(value)) continue
      fields.push({ step: step.id, tool: step.tool, field, value, label: humanizeField(field), type: fieldType(field, value) })
    }
  }
  return fields
}

function humanizeField(field) {
  return field.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}

function fieldType(field, value) {
  if (typeof value === 'boolean') return 'checkbox'
  if (typeof value === 'number') return 'number'
  if (field === 'color' && /^#[0-9a-f]{6}$/i.test(value)) return 'color'
  if (field === 'description' || (typeof value === 'string' && value.length > 60)) return 'textarea'
  return 'text'
}

// Runs a previously-proposed action after the human has approved it.
export async function executeAction({ tool, input }) {
  const def = TOOL_REGISTRY[tool]
  if (!def || def.kind !== 'acting') throw new Error(`Unknown action tool: ${tool}`)
  const action_result = await def.execute(input)
  return { status: 'acted', action_result }
}
