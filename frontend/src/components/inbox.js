import { createItemEl, updateItemEl } from './item.js'

const FILTERS = ['all', 'pending', 'acted', 'done']

export function createInbox() {
  const section = document.createElement('section')
  section.className = 'inbox'

  const tabs = document.createElement('nav')
  tabs.className = 'filters'
  FILTERS.forEach((f, i) => {
    const btn = document.createElement('button')
    btn.className = 'filter-tab' + (i === 0 ? ' active' : '')
    btn.textContent = f
    btn.dataset.filter = f
    tabs.appendChild(btn)
  })

  const list = document.createElement('ul')
  list.className = 'item-list'

  section.append(tabs, list)

  let activeFilter = 'all'
  let items = []

  tabs.addEventListener('click', (e) => {
    const btn = e.target.closest('.filter-tab')
    if (!btn) return
    tabs.querySelectorAll('.filter-tab').forEach(b => b.classList.remove('active'))
    btn.classList.add('active')
    activeFilter = btn.dataset.filter
    render()
  })

  function visible(item) {
    if (activeFilter === 'all') return true
    if (activeFilter === 'pending') return item.status === 'pending'
    if (activeFilter === 'acted') return ['acted', 'reminder', 'urgent'].includes(item.status)
    if (activeFilter === 'done') return ['triaged', 'acted', 'reminder', 'urgent', 'failed'].includes(item.status)
    return true
  }

  function render() {
    list.innerHTML = ''
    items.filter(visible).forEach(item => list.appendChild(createItemEl(item)))
  }

  return {
    el: section,

    addItem(item) {
      items.unshift(item)
      if (visible(item)) list.prepend(createItemEl(item))
    },

    updateItem(updated) {
      const idx = items.findIndex(i => i.id === updated.id)
      if (idx === -1) return
      items[idx] = updated
      const el = list.querySelector(`[data-id="${updated.id}"]`)
      if (el) updateItemEl(el, updated)
      else render()
    },

    setItems(newItems) {
      items = newItems
      render()
    },

    get itemCount() { return items.length },
    get pendingCount() { return items.filter(i => i.status === 'pending').length },
  }
}
