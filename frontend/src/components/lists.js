import {
  parseChecklist,
  toggleLocalChecklistItem, clearLocalChecked,
  toggleLocalShoppingItem, clearLocalShoppingChecked,
  removeCheckedShoppingItems, appendShoppingItem,
} from './item.js'

// The list actions, shared by the phone/laptop inbox (inbox.js) and the
// station's list pane (station.js). Both surfaces render the same markup
// out of item.js and use the same data-action names, so keeping the
// handling here is what stops the two drifting — the station pane is a
// different container around identical rows, not a second implementation.
//
// Neither caller owns a fetch. A tick is local (localStorage, per device);
// a removal or an append computes the item's new text and hands it up to
// main.js, which owns the PATCH — exactly as inbox.js did before this was
// extracted from it.
//
// Returns true when the action was a list one and has been dealt with, so
// a caller's click listener can fall through to its own actions.
export function handleListAction({ action, id, index, label, findItem, rerenderItem, onTextChange }) {
  switch (action) {
    case 'toggle-checklist': {
      const item = findItem?.(id)
      if (!item) return true
      toggleLocalChecklistItem(id, index, parseChecklist(item.text).items.length)
      rerenderItem?.(id)
      return true
    }

    case 'reset-checklist':
      clearLocalChecked(id)
      rerenderItem?.(id)
      return true

    case 'toggle-shopping-item': {
      const item = findItem?.(id)
      if (!item) return true
      toggleLocalShoppingItem(id, index, parseChecklist(item.text).items.length)
      rerenderItem?.(id)
      return true
    }

    // "done shopping": this device's marks become a real removal. Local
    // marks are meaningless once it commits — the indices they were keyed
    // against no longer match anything — so they're cleared here rather
    // than left to go stale.
    case 'remove-shopping-checked': {
      const item = findItem?.(id)
      if (!item) return true
      const text = removeCheckedShoppingItems(id, item.text)
      clearLocalShoppingChecked(id)
      onTextChange?.(id, text)
      return true
    }

    // The add row on the station's list pane. Same shape as the removal
    // above — a local edit committed straight to the shared text — rather
    // than a capture round trip through Claude: appending is not a
    // decision anyone needs to approve, and the pane already knows which
    // list you are looking at, which is the only thing a capture would
    // have had to work out.
    case 'add-shopping-item': {
      const item = findItem?.(id)
      if (!item || !label?.trim()) return true
      onTextChange?.(id, appendShoppingItem(item.text, label))
      return true
    }

    default:
      return false
  }
}
