const STATUS_LABELS = {
  pending:           { label: 'pending',   color: 'var(--text-dim)' },
  triaged:           { label: 'triaged',   color: 'var(--blue)' },
  reminder:          { label: 'reminder',  color: 'var(--amber)' },
  urgent:            { label: 'urgent',    color: 'var(--red)' },
  awaiting_approval: { label: 'review',    color: 'var(--amber)' },
  acted:             { label: 'acted',     color: 'var(--accent)' },
  vetoed:            { label: 'vetoed',    color: 'var(--text-dim)' },
  failed:            { label: 'failed',    color: 'var(--red)' },
  checklist:         { label: 'checklist', color: 'var(--blue)' },
}

// A checklist item's text IS a markdown task list (see save_checklist in
// backend/integrations/claude.js) — an optional title line followed by
// "- [ ] thing" lines. That's what makes it "just a special format of
// note": the text is plain markdown a human could read or edit directly.
// But which boxes are *ticked* is deliberately NOT part of this text — it
// lives only in this browser's localStorage (see loadLocalChecked() below),
// keyed by item id. Sharing tick state through the server would let two
// devices (or two people) using the same checklist at once stomp on each
// other's ticks through one shared field; keeping it local avoids that
// entirely, at the cost of it not following you to another device.
const CHECKLIST_LINE_RE = /^-\s*\[([ xX])\]\s*(.*)$/

export function parseChecklist(text) {
  const title = []
  const items = []
  for (const line of (text ?? '').split('\n')) {
    const m = line.match(CHECKLIST_LINE_RE)
    if (m) items.push(m[2])
    else if (line.trim() && items.length === 0) title.push(line.trim())
  }
  return { title: title.join(' '), items }
}

const LOCAL_CHECKLIST_PREFIX = 'capture:checklist:'

// Reads this device's ticked state for a checklist item, sized/padded to
// match its current item count — if the checklist's items changed (or
// nothing's been ticked yet on this device), missing entries default to
// unchecked rather than throwing. Wrapped in try/catch: localStorage can
// throw in some contexts (private browsing, storage disabled), and a
// checklist should still render — just always unchecked — rather than break.
function loadLocalChecked(itemId, count) {
  try {
    const raw = localStorage.getItem(LOCAL_CHECKLIST_PREFIX + itemId)
    const saved = raw ? JSON.parse(raw) : []
    return Array.from({ length: count }, (_, i) => Boolean(saved[i]))
  } catch {
    return Array(count).fill(false)
  }
}

function saveLocalChecked(itemId, checked) {
  try {
    localStorage.setItem(LOCAL_CHECKLIST_PREFIX + itemId, JSON.stringify(checked))
  } catch {
    // Storage unavailable — the tick just won't survive a refresh this time.
  }
}

// Flips one item's ticked state for this device. Called on checkbox click —
// see inbox.js's click handler, which re-renders the item immediately after.
export function toggleLocalChecklistItem(itemId, index, itemCount) {
  const checked = loadLocalChecked(itemId, itemCount)
  checked[index] = !checked[index]
  saveLocalChecked(itemId, checked)
}

// Clears this device's ticks for a checklist — used by both the "reset"
// button and by recall_checklist's effect (see inbox.js's updateItem(),
// which calls this when a newly-resolved item carries
// recalled_checklist_id naming this checklist).
export function clearLocalChecked(itemId) {
  try {
    localStorage.removeItem(LOCAL_CHECKLIST_PREFIX + itemId)
  } catch {
    // Storage unavailable — nothing to clear.
  }
}

export function createItemEl(item) {
  const el = document.createElement('li')
  el.className = `item item--${item.status}`
  el.dataset.id = item.id
  el.innerHTML = renderItem(item)
  return el
}

export function updateItemEl(el, item) {
  el.className = `item item--${item.status}`
  el.innerHTML = renderItem(item)
}

function renderItem(item) {
  const { label, color } = STATUS_LABELS[item.status] ?? STATUS_LABELS.pending
  const isPending = item.status === 'pending'
  const isAwaitingApproval = item.status === 'awaiting_approval'
  const isChecklist = item.status === 'checklist'
  // Only an item that actually executed an acting-tool call (status
  // 'acted', with executed_action recorded on approval) has a { tool, input }
  // to freeze into a favourite — a terminal item (triaged/reminder/urgent)
  // never had a tool call at all, and a vetoed/failed item never ran one.
  const isFavouritable = item.status === 'acted' && Boolean(item.executed_action)
  const steps = item.plan_progress ?? []
  const formFields = item.form_fields ?? []
  const checklist = isChecklist ? parseChecklist(item.text) : null

  return `
    <div class="item-body">
      <span class="item-text">${escHtml(isChecklist ? (checklist.title || 'Checklist') : item.text)}</span>
      <span class="item-status" style="color:${color}">${label}</span>
    </div>
    ${steps.length
      ? `<ul class="item-steps">${steps.map(s => `<li><span class="item-step-check">✓</span>${escHtml(s.label)}</li>`).join('')}</ul>`
      : ''}
    ${isChecklist ? renderChecklist(item.id, checklist) : ''}
    ${!isChecklist && isPending
      ? `<div class="item-shimmer"></div>`
      : !isChecklist && item.action_result
        ? `<div class="item-result" style="border-color:${color}">
            <span class="item-result-text">${escHtml(item.action_result)}</span>
            ${isFavouritable
              ? `<button class="btn-favourite" data-action="favourite" title="Save as favourite" aria-label="Save as favourite">☆</button>`
              : ''}
          </div>`
        : ''}
    ${isAwaitingApproval
      ? `<div class="item-approval">
          ${formFields.length ? renderForm(formFields) : ''}
          <div class="item-approval-actions">
            <button class="btn-approve" data-action="approve">approve</button>
            <button class="btn-veto" data-action="veto">veto</button>
          </div>
        </div>`
      : ''}
    <time class="item-time">${relativeTime(item.created_at)}</time>
  `
}

// A checklist stays around indefinitely to be recalled and ticked off
// again — resetting it (rather than starting a new "run") is the whole
// mechanism for reusing it next time, matching the "just a note" model:
// there's one persistent item, not a template plus a history of runs.
// `items` here is just the list of labels (the shared definition); the
// ticked state overlaid on top of them is this device's own, from
// localStorage — see loadLocalChecked() above.
function renderChecklist(itemId, { items }) {
  const checked = loadLocalChecked(itemId, items.length)
  const checkedCount = checked.filter(Boolean).length
  return `
    <ul class="checklist">
      ${items.map((text, i) => `
        <li class="checklist-item${checked[i] ? ' checklist-item--checked' : ''}">
          <label>
            <input type="checkbox" data-action="toggle-checklist" data-index="${i}" ${checked[i] ? 'checked' : ''}>
            <span>${escHtml(text)}</span>
          </label>
        </li>
      `).join('')}
    </ul>
    <div class="checklist-footer">
      <span class="checklist-count">${checkedCount}/${items.length} done</span>
      <button class="btn-checklist-reset" data-action="reset-checklist">reset</button>
    </div>
  `
}

// Renders the plan's editable inputs (see getFormFields() in claude.js)
// as a small form — this is what turns "approve this exact proposal" into
// "approve, having tweaked what it's about to do". Reused verbatim by the
// favourites sidebar for "run again, with different inputs".
export function renderForm(fields) {
  return `<div class="action-form">${fields.map(renderField).join('')}</div>`
}

function renderField(f) {
  const value = escHtml(String(f.value))
  const inputType = f.type === 'number' ? 'number' : f.type === 'color' ? 'color' : 'text'
  const control = f.type === 'textarea'
    ? `<textarea data-step="${escHtml(f.step)}" data-field="${escHtml(f.field)}" rows="2">${value}</textarea>`
    : `<input type="${inputType}" data-step="${escHtml(f.step)}" data-field="${escHtml(f.field)}" value="${value}">`
  return `
    <label class="action-form-field">
      <span class="action-form-label">${escHtml(f.label)}</span>
      ${control}
    </label>
  `
}

// Reads back whatever's currently in a rendered form's inputs, as the
// { stepId: { field: value } } shape approve()/runFavourite() send as
// `overrides` — undefined (rather than {}) when there's no form at all, so
// a plain approve/run with no edits behaves exactly as if overrides were
// never mentioned.
export function collectFormOverrides(containerEl) {
  const inputs = containerEl.querySelectorAll('.action-form [data-step]')
  if (!inputs.length) return undefined
  const overrides = {}
  inputs.forEach((input) => {
    const { step, field } = input.dataset
    overrides[step] ??= {}
    overrides[step][field] = input.value
  })
  return overrides
}

export function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function relativeTime(ts) {
  const diff = Date.now() - new Date(ts).getTime()
  const s = Math.floor(diff / 1000)
  if (s < 60) return 'just now'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}
