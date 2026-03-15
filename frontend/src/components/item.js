const STATUS_LABELS = {
  pending:  { label: 'pending',  color: 'var(--text-dim)' },
  triaged:  { label: 'triaged',  color: 'var(--blue)' },
  reminder: { label: 'reminder', color: 'var(--amber)' },
  urgent:   { label: 'urgent',   color: 'var(--red)' },
  acted:    { label: 'acted',    color: 'var(--accent)' },
  failed:   { label: 'failed',   color: 'var(--red)' },
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

  return `
    <div class="item-body">
      <span class="item-text">${escHtml(item.text)}</span>
      <span class="item-status" style="color:${color}">${label}</span>
    </div>
    ${isPending
      ? `<div class="item-shimmer"></div>`
      : item.action_result
        ? `<div class="item-result" style="border-color:${color}">${escHtml(item.action_result)}</div>`
        : ''}
    <time class="item-time">${relativeTime(item.created_at)}</time>
  `
}

function escHtml(str) {
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
