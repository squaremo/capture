import { createItemEl, updateItemEl, collectFormOverrides } from './item.js'

// "Needs attention": still processing, classified but no action decided
// yet, or an acting tool proposed something waiting on approve/veto.
// "Resolved": an action was taken, declined, or failed — audit trail.
const NEEDS_ATTENTION = ['pending', 'triaged', 'reminder', 'urgent', 'awaiting_approval']
const RESOLVED = ['acted', 'vetoed', 'failed']

export function createInbox({ onApprove, onVeto, onFavourite } = {}) {
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
    const itemEl = btn.closest('.item')
    const id = itemEl?.dataset.id
    if (!id) return
    // approve() reads back whatever's currently in the item's form (if it
    // has one) as overrides — a plain click with no edits sends the same
    // resolved inputs the proposal already showed, unchanged.
    if (btn.dataset.action === 'approve') onApprove?.(id, collectFormOverrides(itemEl))
    if (btn.dataset.action === 'veto') onVeto?.(id)
    if (btn.dataset.action === 'favourite') onFavourite?.(id)
  })

  return {
    el: section,

    addItem(item) {
      items.unshift(item)
      groupFor(item.status).list.prepend(createItemEl(item))
    },

    // matchId lets a caller replace an item stored under one id (e.g. a
    // client-side optimistic id) with the server's version, which may have
    // a different id. Defaults to updated.id for the common in-place case.
    updateItem(updated, matchId = updated.id) {
      const idx = items.findIndex(i => i.id === matchId)
      if (idx === -1) return
      const movedGroup = groupFor(items[idx].status) !== groupFor(updated.status)
      items[idx] = updated
      if (movedGroup) {
        render() // crossed from needs-attention to resolved (or back) — relocate it
        return
      }
      const el = section.querySelector(`[data-id="${matchId}"]`)
      if (el) {
        el.dataset.id = updated.id
        updateItemEl(el, updated)
      } else {
        render()
      }
    },

    setItems(newItems) {
      items = newItems
      render()
    },

    // Called after a successful POST .../favourite — swaps that one item's
    // star to a filled, disabled state so a second click can't silently
    // create a duplicate favourite. Doesn't touch the underlying item data
    // (there's no "is this favourited" field on an item — a favourite is
    // its own independent, deletable record), so a fresh render() (e.g. the
    // next setItems()) reverts to a plain clickable star, which is fine:
    // favouriting the same acted item again just adds another favourite.
    markFavourited(itemId) {
      const btn = section.querySelector(`[data-id="${itemId}"] .btn-favourite`)
      if (!btn) return
      btn.textContent = '★'
      btn.disabled = true
      btn.title = 'Saved as favourite'
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
