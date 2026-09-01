const STATUS_LABELS = {
  pending:           { label: 'pending',  color: 'var(--text-dim)' },
  triaged:           { label: 'triaged',  color: 'var(--blue)' },
  reminder:          { label: 'reminder', color: 'var(--amber)' },
  urgent:            { label: 'urgent',   color: 'var(--red)' },
  awaiting_approval: { label: 'review',   color: 'var(--amber)' },
  acted:             { label: 'acted',    color: 'var(--accent)' },
  vetoed:            { label: 'vetoed',   color: 'var(--text-dim)' },
  failed:            { label: 'failed',   color: 'var(--red)' },
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
  // Only an item that actually executed an acting-tool call (status
  // 'acted', with executed_action recorded on approval) has a { tool, input }
  // to freeze into a favourite — a terminal item (triaged/reminder/urgent)
  // never had a tool call at all, and a vetoed/failed item never ran one.
  const isFavouritable = item.status === 'acted' && Boolean(item.executed_action)
  const steps = item.plan_progress ?? []

  return `
    <div class="item-body">
      <span class="item-text">${escHtml(item.text)}</span>
      <span class="item-status" style="color:${color}">${label}</span>
    </div>
    ${steps.length
      ? `<ul class="item-steps">${steps.map(s => `<li><span class="item-step-check">✓</span>${escHtml(s.label)}</li>`).join('')}</ul>`
      : ''}
    ${isPending
      ? `<div class="item-shimmer"></div>`
      : item.action_result
        ? `<div class="item-result" style="border-color:${color}">
            <span class="item-result-text">${escHtml(item.action_result)}</span>
            ${isFavouritable
              ? `<button class="btn-favourite" data-action="favourite" title="Save as favourite" aria-label="Save as favourite">☆</button>`
              : ''}
          </div>`
        : ''}
    ${isAwaitingApproval
      ? `<div class="item-approval">
          <button class="btn-approve" data-action="approve">approve</button>
          <button class="btn-veto" data-action="veto">veto</button>
        </div>`
      : ''}
    <time class="item-time">${relativeTime(item.created_at)}</time>
  `
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
