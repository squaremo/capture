import { createItemEl, updateItemEl } from './item.js'

// "Needs attention": still processing, classified but no action decided
// yet, or an acting tool proposed something waiting on approve/veto.
// "Resolved": an action was taken, declined, or failed — audit trail.
const NEEDS_ATTENTION = ['pending', 'triaged', 'reminder', 'urgent', 'awaiting_approval']
const RESOLVED = ['acted', 'vetoed', 'failed']

export function createInbox({ onApprove, onVeto } = {}) {
  const section = document.createElement('section')
  section.className = 'inbox'

  const needsAttention = createGroup('needs attention', 'attention')
  const resolved = createGroup('resolved', 'resolved')
  section.append(needsAttention.el, resolved.el)

  let items = []

  function groupFor(status) {
    return RESOLVED.includes(status) ? resolved : needsAttention
  }

  function render() {
    needsAttention.list.innerHTML = ''
    resolved.list.innerHTML = ''
    items.forEach(item => groupFor(item.status).list.appendChild(createItemEl(item)))
  }

  section.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]')
    if (!btn) return
    const id = btn.closest('.item')?.dataset.id
    if (!id) return
    if (btn.dataset.action === 'approve') onApprove?.(id)
    if (btn.dataset.action === 'veto') onVeto?.(id)
  })

  return {
    el: section,

    addItem(item) {
      items.unshift(item)
      groupFor(item.status).list.prepend(createItemEl(item))
    },

    updateItem(updated) {
      const idx = items.findIndex(i => i.id === updated.id)
      if (idx === -1) return
      const movedGroup = groupFor(items[idx].status) !== groupFor(updated.status)
      items[idx] = updated
      if (movedGroup) {
        render() // crossed from needs-attention to resolved (or back) — relocate it
        return
      }
      const el = section.querySelector(`[data-id="${updated.id}"]`)
      if (el) updateItemEl(el, updated)
      else render()
    },

    setItems(newItems) {
      items = newItems
      render()
    },

    get itemCount() { return items.length },
    get pendingCount() { return items.filter(i => NEEDS_ATTENTION.includes(i.status)).length },
  }
}

function createGroup(title, modifier) {
  const el = document.createElement('div')
  el.className = `inbox-group inbox-group--${modifier}`
  const heading = document.createElement('h2')
  heading.className = 'inbox-group-title'
  heading.textContent = title
  const list = document.createElement('ul')
  list.className = 'item-list'
  el.append(heading, list)
  return { el, list }
}
