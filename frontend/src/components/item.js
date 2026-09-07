// One map from status to a *role*, not a colour — see theme.css. The
// role name is the whole point: 'awaiting_approval' is amber because it is
// waiting on you, not because amber looked right, so a theme change can
// move every waiting-on-you signal at once without touching this file.
const STATUS_LABELS = {
  pending:           { label: 'pending',   role: 'think' },
  triaged:           { label: 'triaged',   role: 'think' },
  reminder:          { label: 'reminder',  role: 'need' },
  urgent:            { label: 'urgent',    role: 'fail' },
  awaiting_approval: { label: 'review',    role: 'need' },
  acted:             { label: 'acted',     role: 'done' },
  vetoed:            { label: 'vetoed',    role: 'muted' },
  failed:            { label: 'failed',    role: 'fail' },
  checklist:         { label: 'checklist', role: 'think' },
  shopping_list:     { label: 'shopping list', role: 'think' },
}

// Roles resolve to CSS variables at render time. 'muted' is deliberately
// not a signal: a vetoed item is finished business, so it stays ink.
const ROLE_VARS = {
  act:   'var(--sig-act)',
  need:  'var(--sig-need)',
  done:  'var(--sig-done)',
  think: 'var(--sig-think)',
  fail:  'var(--sig-fail)',
  muted: 'var(--text-dim)',
}

// A checklist item's text IS a markdown task list (see save_checklist in
// backend/integrations/claude.js) — an optional title line followed by
// "- [ ] thing" lines. That's what makes it "just a special format of
// note": the text is plain markdown a human could read or edit directly.
// But which boxes are *ticked* is deliberately NOT part of this text — it
// lives only in this browser's localStorage (see makeLocalTicks() below),
// keyed by item id. Sharing tick state through the server would let two
// devices (or two people) using the same checklist at once stomp on each
// other's ticks through one shared field; keeping it local avoids that
// entirely, at the cost of it not following you to another device.
//
// A shopping-list item (add_to_shopping_list) reuses this exact same text
// format — the parser doesn't care what status it's attached to — but is
// checklists' mirror image: built up incrementally rather than all at once,
// and "checking off" an item removes it from the shared server text (see
// renderShoppingList()/inbox.js's remove-shopping-checked handling) instead
// of just ticking a locally-persisted box, since additions and removals on
// a shopping list need to show up on every device straight away. The boxes
// this renders are only ever a per-device, pre-commit "about to remove
// these" mark — see makeLocalTicks() below.
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

export function buildChecklistMarkdown(title, items) {
  const heading = title ? `${title}\n` : ''
  return heading + items.map(text => `- [ ] ${text}`).join('\n')
}

// A small per-device tick store, keyed by item id and sized/padded to the
// item's current item count — if the list's items changed (or nothing's
// been ticked yet on this device), missing entries default to unchecked
// rather than throwing. Wrapped in try/catch: localStorage can throw in
// some contexts (private browsing, storage disabled), and the list should
// still render — just always unchecked — rather than break. Shared by
// checklists (where a tick IS the persisted state, cleared on recall) and
// the shopping list (where a tick is only a transient "about to remove"
// mark, cleared the moment it's actually committed — see inbox.js).
function makeLocalTicks(prefix) {
  function load(itemId, count) {
    try {
      const raw = localStorage.getItem(prefix + itemId)
      const saved = raw ? JSON.parse(raw) : []
      return Array.from({ length: count }, (_, i) => Boolean(saved[i]))
    } catch {
      return Array(count).fill(false)
    }
  }
  function save(itemId, checked) {
    try {
      localStorage.setItem(prefix + itemId, JSON.stringify(checked))
    } catch {
      // Storage unavailable — the tick just won't survive a refresh this time.
    }
  }
  function toggle(itemId, index, count) {
    const checked = load(itemId, count)
    checked[index] = !checked[index]
    save(itemId, checked)
  }
  function clear(itemId) {
    try {
      localStorage.removeItem(prefix + itemId)
    } catch {
      // Storage unavailable — nothing to clear.
    }
  }
  return { load, save, toggle, clear }
}

const checklistTicks = makeLocalTicks('capture:checklist:')
const shoppingTicks = makeLocalTicks('capture:shopping:')

// Flips one item's ticked state for this device. Called on checkbox click —
// see inbox.js's click handler, which re-renders the item immediately after.
export function toggleLocalChecklistItem(itemId, index, itemCount) {
  checklistTicks.toggle(itemId, index, itemCount)
}

// Clears this device's ticks for a checklist — used by both the "reset"
// button and by recall_checklist's effect (see inbox.js's updateItem(),
// which calls this when a newly-resolved item carries
// recalled_checklist_id naming this checklist).
export function clearLocalChecked(itemId) {
  checklistTicks.clear(itemId)
}

// Same idea for the shopping list, but the tick here is only ever a
// transient "about to remove" mark, not the persisted state itself — see
// renderShoppingList() below.
export function toggleLocalShoppingItem(itemId, index, itemCount) {
  shoppingTicks.toggle(itemId, index, itemCount)
}

export function clearLocalShoppingChecked(itemId) {
  shoppingTicks.clear(itemId)
}

// The new text for a shopping-list item once its currently-checked items
// are removed — reused by inbox.js, which owns the actual PATCH call.
export function removeCheckedShoppingItems(itemId, text) {
  const { title, items } = parseChecklist(text)
  const checked = shoppingTicks.load(itemId, items.length)
  const remaining = items.filter((_, i) => !checked[i])
  return buildChecklistMarkdown(title, remaining)
}

// The new text for a shopping-list item with one more line on it —
// the other half of the pair above, for the station's add row (see
// handleListAction() in lists.js). Ticks are per-device and keyed by
// index, so appending at the end leaves every existing mark pointing at
// the line it was made against.
export function appendShoppingItem(text, label) {
  const { title, items } = parseChecklist(text)
  return buildChecklistMarkdown(title, [...items, label.trim()])
}

export function createItemEl(item) {
  const el = document.createElement('li')
  el.className = `item item--${item.status}`
  el.dataset.id = item.id
  el.dataset.role = STATUS_LABELS[item.status]?.role ?? 'muted'
  el.innerHTML = renderItem(item)
  return el
}

export function updateItemEl(el, item) {
  el.className = `item item--${item.status}`
  el.dataset.role = STATUS_LABELS[item.status]?.role ?? 'muted'
  el.innerHTML = renderItem(item)
}

function renderItem(item) {
  const { label, role } = STATUS_LABELS[item.status] ?? STATUS_LABELS.pending
  const color = ROLE_VARS[role] ?? ROLE_VARS.muted
  const isPending = item.status === 'pending'
  const isAwaitingApproval = item.status === 'awaiting_approval'
  const isChecklist = item.status === 'checklist'
  const isShoppingList = item.status === 'shopping_list'
  // Only an item that actually executed an acting-tool call (status
  // 'acted', with executed_action recorded on approval) has a { tool, input }
  // to freeze into a favourite — a terminal item (triaged/reminder/urgent)
  // never had a tool call at all, and a vetoed/failed item never ran one.
  const isFavouritable = item.status === 'acted' && Boolean(item.executed_action)
  const steps = item.plan_progress ?? []
  const formFields = item.form_fields ?? []
  const checklist = isChecklist ? parseChecklist(item.text) : null
  const shoppingList = isShoppingList ? parseChecklist(item.text) : null

  return `
    <div class="item-body">
      <span class="item-text">${escHtml(
        isChecklist ? (checklist.title || 'Checklist')
        : isShoppingList ? (shoppingList.title || 'Shopping list')
        : item.text
      )}</span>
      <span class="item-status" data-role="${role}">${label}</span>
    </div>
    ${steps.length
      ? `<ul class="item-steps">${steps.map(s => `<li><span class="item-step-check">✓</span>${escHtml(s.label)}</li>`).join('')}</ul>`
      : ''}
    ${isChecklist ? renderChecklist(item.id, checklist) : ''}
    ${isShoppingList ? renderShoppingList(item.id, shoppingList) : ''}
    ${!isChecklist && !isShoppingList && isPending
      ? `<div class="item-shimmer"></div>`
      : !isChecklist && !isShoppingList && item.action_result
        ? `<div class="item-result" data-role="${role}">

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
// localStorage — see checklistTicks above.
export function renderChecklist(itemId, { items }) {
  const checked = checklistTicks.load(itemId, items.length)
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

// The shopping list's mirror image of renderChecklist(): items accumulate
// here across many captures (add_to_shopping_list), so there's no fixed
// count to track "done" against. A checked box here isn't persisted state —
// it's a per-device "about to remove" mark (shoppingTicks, cleared the
// moment it's actually committed); "done shopping" is what turns marks into
// a real removal, PATCHing the checked lines out of the item's shared text
// (see inbox.js's remove-shopping-checked handling) so every device sees
// the same list a moment later.
export function renderShoppingList(itemId, { items }) {
  if (!items.length) {
    return `<p class="checklist-empty">Nothing on the list</p>`
  }
  const checked = shoppingTicks.load(itemId, items.length)
  const checkedCount = checked.filter(Boolean).length
  return `
    <ul class="checklist">
      ${items.map((text, i) => `
        <li class="checklist-item${checked[i] ? ' checklist-item--checked' : ''}">
          <label>
            <input type="checkbox" data-action="toggle-shopping-item" data-index="${i}" ${checked[i] ? 'checked' : ''}>
            <span>${escHtml(text)}</span>
          </label>
        </li>
      `).join('')}
    </ul>
    <div class="checklist-footer">
      <span class="checklist-count">${checkedCount} to remove</span>
      <button class="btn-checklist-done" data-action="remove-shopping-checked" ${checkedCount === 0 ? 'disabled' : ''}>done shopping</button>
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

// The control follows what the value looks like, not the field name —
// dragging a light's brightness should look like dragging a speaker's
// volume, since they're the same gesture on the same kind of value.
// brightness arrives as a bare 0-100 number today, not a "35%" string, so
// it's matched by field name too; a real percent/Kelvin *string* (from a
// tool that formats its own values, or once the backend sends a type per
// field — see getFormFields() in claude.js) is matched on sight either way.
const PERCENT_RE = /^\d+%$/
const KELVIN_RE = /^\d+k$/i

function sniffSlider(f) {
  const str = String(f.value)
  if (PERCENT_RE.test(str) || (f.field === 'brightness' && typeof f.value === 'number')) {
    return { min: 0, max: 100, step: 1, numeric: parseInt(str, 10), suffix: '%' }
  }
  if (KELVIN_RE.test(str)) {
    return { min: 1800, max: 4000, step: 100, numeric: parseInt(str, 10), suffix: 'K' }
  }
  return null
}

function renderField(f) {
  const value = escHtml(String(f.value))
  const slider = f.type !== 'color' && f.type !== 'textarea' ? sniffSlider(f) : null

  if (slider) {
    return `
      <div class="action-form-field">
        <div class="action-form-label-row">
          <span class="action-form-label">${escHtml(f.label)}</span>
          <span class="action-form-value">${slider.numeric}${slider.suffix}</span>
        </div>
        <input type="range" min="${slider.min}" max="${slider.max}" step="${slider.step}"
          data-step="${escHtml(f.step)}" data-field="${escHtml(f.field)}" value="${slider.numeric}">
      </div>
    `
  }

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

export function relativeTime(ts) {
  const diff = Date.now() - new Date(ts).getTime()
  const s = Math.floor(diff / 1000)
  if (s < 60) return 'just now'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}
