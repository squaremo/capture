import { escHtml, renderForm, collectFormOverrides } from './item.js'

// The sidebar of saved favourites (see GET /api/favourites) — each one a
// saved program (see plan_steps/form_fields on the backend) that replays
// with no re-approval, the human having already approved this exact action
// once, at favourite time. A favourite with no editable inputs (no
// form_fields — e.g. one saved before this existed) runs immediately on
// click, same as always; one with editable inputs opens them inline first,
// prefilled with the values it was last run with, and only replays once
// "run" is confirmed — this is what lets a favourite mean "the program",
// not just "the frozen call". Hidden entirely when there are none, same
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
    if (e.target.closest('[data-action="confirm"]')) return onRun?.(id, collectFormOverrides(li))
    // Explicit escape hatch for an opened form: close it without running
    // or deleting the favourite. Clicking the label a second time also
    // toggles it shut (below), but that's not an obvious affordance on
    // its own — nothing marks the label as "click again to collapse" —
    // so a visible cancel button is the one a person actually finds.
    if (e.target.closest('[data-action="cancel"]')) {
      const form = li.querySelector('.favourite-form')
      if (form) form.hidden = true
      return
    }
    if (e.target.closest('[data-action="run"]')) {
      const form = li.querySelector('.favourite-form')
      // A favourite with edits to make opens its form on first click
      // rather than firing straight away — a second click on the same
      // label closes it again (same toggle the cancel button uses), and
      // the form's own "run" button (data-action="confirm") replays it.
      if (form) { form.hidden = !form.hidden; return }
      return onRun?.(id)
    }
  })

  function render(favourites) {
    list.innerHTML = favourites.map(fav => {
      const fields = fav.form_fields ?? []
      return `
        <li class="favourite-item" data-id="${fav.id}">
          <div class="favourite-row">
            <button class="favourite-run" data-action="run" title="Run again">${escHtml(fav.label)}</button>
            <button class="favourite-delete" data-action="delete" title="Remove from favourites" aria-label="Remove from favourites">&times;</button>
          </div>
          ${fields.length
            ? `<div class="favourite-form" hidden>
                ${renderForm(fields)}
                <div class="favourite-form-actions">
                  <button class="btn-approve favourite-confirm" data-action="confirm">run</button>
                  <button class="btn-veto" data-action="cancel">cancel</button>
                </div>
              </div>`
            : ''}
        </li>
      `
    }).join('')
    aside.hidden = favourites.length === 0
  }

  // Disables one favourite's run button while its replay is in flight, so a
  // second click can't fire the same acting tool twice (e.g. two Linear
  // tasks from one favourite) before the first request lands.
  function setRunning(id, running) {
    const item = list.querySelector(`[data-id="${id}"]`)
    if (!item) return
    item.querySelectorAll('.favourite-run, .favourite-confirm').forEach(btn => { btn.disabled = running })
  }

  return { el: aside, render, setRunning }
}
