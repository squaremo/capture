import { escHtml } from './item.js'

// The sidebar of saved favourites — each one a frozen, previously-executed
// tool call (see GET /api/favourites) that replays exactly as recorded, no
// re-planning and no re-approval. Hidden entirely when there are none, same
// pattern as the house chooser hiding when there are no satellites.
export function createFavouritesSidebar({ onRun, onDelete } = {}) {
  const aside = document.createElement('aside')
  aside.className = 'favourites'
  aside.hidden = true

  const heading = document.createElement('h2')
  heading.className = 'favourites-title'
  heading.textContent = 'favourites'

  const list = document.createElement('ul')
  list.className = 'favourites-list'

  aside.append(heading, list)

  aside.addEventListener('click', (e) => {
    const li = e.target.closest('[data-id]')
    if (!li) return
    const id = li.dataset.id
    if (e.target.closest('[data-action="delete"]')) return onDelete?.(id)
    if (e.target.closest('[data-action="run"]')) return onRun?.(id)
  })

  function render(favourites) {
    list.innerHTML = favourites.map(fav => `
      <li class="favourite-item" data-id="${fav.id}">
        <button class="favourite-run" data-action="run" title="Run again">${escHtml(fav.label)}</button>
        <button class="favourite-delete" data-action="delete" title="Remove from favourites" aria-label="Remove from favourites">&times;</button>
      </li>
    `).join('')
    aside.hidden = favourites.length === 0
  }

  // Disables one favourite's run button while its replay is in flight, so a
  // second click can't fire the same acting tool twice (e.g. two Linear
  // tasks from one favourite) before the first request lands.
  function setRunning(id, running) {
    const btn = list.querySelector(`[data-id="${id}"] .favourite-run`)
    if (btn) btn.disabled = running
  }

  return { el: aside, render, setRunning }
}
