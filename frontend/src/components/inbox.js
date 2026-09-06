import {
  createItemEl, updateItemEl, collectFormOverrides, parseChecklist,
  toggleLocalChecklistItem, clearLocalChecked,
  toggleLocalShoppingItem, clearLocalShoppingChecked, removeCheckedShoppingItems,
} from './item.js'

// "Needs attention": still processing, classified but no action decided
// yet, or an acting tool proposed something waiting on approve/veto.
// "Resolved": an action was taken, declined, or failed — audit trail.
// "Checklists": items that never resolve away — they sit here permanently
// to be recalled and ticked off/reset, not triaged into either group above.
// "Shopping list": same idea, but there's only ever one — see item.js.
const NEEDS_ATTENTION = ['pending', 'triaged', 'reminder', 'urgent', 'awaiting_approval']
const RESOLVED = ['acted', 'vetoed', 'failed']

export function createInbox({ onApprove, onVeto, onFavourite, onShoppingListChange, onShoppingListUpdated } = {}) {
  const section = document.createElement('section')
  section.className = 'inbox'

  const shoppingList = createGroup('shopping list', 'shopping')
  shoppingList.el.hidden = true // shown only once the shopping list exists
  const checklists = createGroup('checklists', 'checklists')
  checklists.el.hidden = true // shown only once a first checklist item exists
  const needsAttention = createGroup('needs attention', 'attention')
  const resolved = createGroup('resolved', 'resolved')
  section.append(shoppingList.el, checklists.el, needsAttention.el, resolved.el)

  let items = []

  function groupFor(status) {
    if (status === 'shopping_list') return shoppingList
    if (status === 'checklist') return checklists
    return RESOLVED.includes(status) ? resolved : needsAttention
  }

  function render() {
    shoppingList.list.innerHTML = ''
    checklists.list.innerHTML = ''
    needsAttention.list.innerHTML = ''
    resolved.list.innerHTML = ''
    shoppingList.el.hidden = !items.some(i => i.status === 'shopping_list')
    checklists.el.hidden = !items.some(i => i.status === 'checklist')
    items.forEach(item => groupFor(item.status).list.appendChild(createItemEl(item)))
  }

  // Toggling/resetting a checklist never leaves the browser — no server
  // call, no callback out to main.js — since ticked state lives only in
  // this device's localStorage (see item.js). Re-rendering the one item's
  // DOM is enough: renderChecklist() reads local storage fresh each time.
  function rerenderItem(id) {
    const item = items.find(i => i.id === id)
    const el = section.querySelector(`[data-id="${id}"]`)
    if (item && el) updateItemEl(el, item)
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
    if (btn.dataset.action === 'toggle-checklist') {
      const item = items.find(i => i.id === id)
      if (item) {
        toggleLocalChecklistItem(id, parseInt(btn.dataset.index, 10), parseChecklist(item.text).items.length)
        rerenderItem(id)
      }
    }
    if (btn.dataset.action === 'reset-checklist') {
      clearLocalChecked(id)
      rerenderItem(id)
    }
    if (btn.dataset.action === 'toggle-shopping-item') {
      const item = items.find(i => i.id === id)
      if (item) {
        toggleLocalShoppingItem(id, parseInt(btn.dataset.index, 10), parseChecklist(item.text).items.length)
        rerenderItem(id)
      }
    }
    // "done shopping": local marks (this device's checked boxes) become a
    // real removal — computes the item's text with those lines dropped and
    // hands it up to main.js, which owns the PATCH (inbox.js has no fetch
    // of its own). Local marks are meaningless once the removal commits —
    // the indices they were keyed against no longer match anything — so
    // they're cleared here rather than left to go stale.
    if (btn.dataset.action === 'remove-shopping-checked') {
      const item = items.find(i => i.id === id)
      if (item) {
        const text = removeCheckedShoppingItems(id, item.text)
        clearLocalShoppingChecked(id)
        onShoppingListChange?.(id, text)
      }
    }
  })

  return {
    el: section,

    addItem(item) {
      items.unshift(item)
      if (item.status === 'shopping_list') shoppingList.el.hidden = false
      if (item.status === 'checklist') checklists.el.hidden = false
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
      } else {
        const el = section.querySelector(`[data-id="${matchId}"]`)
        if (el) {
          el.dataset.id = updated.id
          updateItemEl(el, updated)
        } else {
          render()
        }
      }
      // A resolved recall_checklist sets this to the *other*, already-
      // existing checklist item it named (see recall_checklist in
      // claude.js) — clearing that item's local ticks and re-rendering it
      // is this device's half of "recalling a checklist resets it": the
      // server never touched that item at all.
      if (updated.recalled_checklist_id) {
        clearLocalChecked(updated.recalled_checklist_id)
        rerenderItem(updated.recalled_checklist_id)
      }
      // A resolved add_to_shopping_list that folded into an *existing*
      // shopping-list item (rather than becoming one itself) names that
      // other item here — unlike recall_checklist, its text really did
      // change server-side, so there's nothing local to just re-render:
      // main.js needs to re-fetch it and feed the fresh copy back in.
      if (updated.shopping_list_id) {
        onShoppingListUpdated?.(updated.shopping_list_id)
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
