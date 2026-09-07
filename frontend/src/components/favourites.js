import { escHtml, renderForm, collectFormOverrides, relativeTime } from './item.js'

// The sidebar of saved favourites (see GET /api/favourites) — each one a
// saved program (see plan_steps/form_fields on the backend) that replays
// with no re-approval, the human having already approved this exact action
// once, at favourite time. Clicking the label always replays it exactly as
// last run — no form, no detour — since that's the common case even for a
// favourite that *has* editable inputs. A favourite with editable inputs
// (form_fields) additionally gets an edit button that opens them inline,
// prefilled with the values it was last run with, and only replays once
// "run" is confirmed there — this is what lets a favourite mean "the
// program", not just "the frozen call", without making every replay pay
// for that flexibility. Hidden entirely when there are none, same pattern
// as the house chooser hiding when there are no satellites.
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
    if (e.target.closest('[data-action="edit"]')) {
      const form = li.querySelector('.favourite-form')
      // Toggles the inline form open/closed — same toggle the cancel
      // button uses. Only rendered when the favourite has form_fields.
      if (form) form.hidden = !form.hidden
      return
    }
    if (e.target.closest('[data-action="run"]')) return onRun?.(id)
  })

  function render(favourites) {
    list.innerHTML = favourites.map(fav => {
      const fields = fav.form_fields ?? []
      return `
        <li class="favourite-item" data-id="${fav.id}">
          <div class="favourite-row">
            <button class="favourite-run" data-action="run" title="Run again, exactly as before">${escHtml(fav.label)}</button>
            ${fields.length
              ? `<button class="favourite-edit" data-action="edit" title="Edit before running" aria-label="Edit before running">&#9998;</button>`
              : ''}
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

// The station's right-rail variant (idle mode, landscape only — see
// station.js): five rows instead of the full list, and a run count/time
// alongside the label rather than an inline dropdown per row. Tapping the
// pencil doesn't open a form under that one row — it replaces the whole
// rail with a single editor, since there's no room for a second column
// beside it on the panel. Reuses the same `.action-form`/renderForm()
// fields and the same onRun(id, overrides) replay path as the sidebar —
// this is a layout difference, not a new capability. There is no "save
// without running" here: the backend has no such endpoint, and running
// with edited inputs is already what persists them as the new defaults
// (see updateFavourite() in db.js) — so the editor only offers run-now
// and cancel, not a separate save.
export function createFavouritesRail({ onRun, onOpenAll, onEdit } = {}) {
  const aside = document.createElement('aside')
  aside.className = 'favourites station-rail'

  let favourites = []
  let editingId = null

  function render(list) {
    favourites = list
    if (editingId && !favourites.some(f => f.id === editingId)) editingId = null
    editingId ? renderEditor() : renderList()
  }

  function renderList() {
    const recent = favourites.slice(0, 5)
    aside.innerHTML = `
      <div class="station-rail-head">
        <span class="station-rail-heading">recent</span>
        <button type="button" class="station-rail-link" data-action="open-all">all ${favourites.length} saved</button>
      </div>
      <ul class="station-rail-list">
        ${recent.map(fav => `
          <li class="station-rail-row" data-id="${fav.id}">
            <button type="button" class="favourite-run station-rail-run" data-action="run" title="Run again, exactly as before">${escHtml(fav.label)}</button>
            <span class="station-rail-time">${relativeTime(fav.created_at)}</span>
            ${(fav.form_fields ?? []).length
              ? `<button type="button" class="favourite-edit" data-action="edit" title="Edit before running" aria-label="Edit before running">&#9998;</button>`
              : ''}
          </li>
        `).join('')}
      </ul>
    `
  }

  function renderEditor() {
    const fav = favourites.find(f => f.id === editingId)
    if (!fav) {
      editingId = null
      return renderList()
    }
    aside.innerHTML = `
      <div class="station-rail-head">
        <span class="station-rail-heading" data-role="act">editing</span>
      </div>
      <div class="station-rail-editor-title">${escHtml(fav.label)}</div>
      <div class="station-rail-editor-fields">${renderForm(fav.form_fields ?? [])}</div>
      <div class="station-rail-editor-actions">
        <button type="button" class="btn-approve" data-action="confirm">run now</button>
        <button type="button" class="btn-veto" data-action="cancel">&times;</button>
      </div>
    `
  }

  aside.addEventListener('click', (e) => {
    if (e.target.closest('[data-action="open-all"]')) return onOpenAll?.()
    const row = e.target.closest('[data-id]')
    const id = row?.dataset.id ?? editingId
    if (e.target.closest('[data-action="edit"]')) {
      editingId = id
      onEdit?.(id)
      return renderEditor()
    }
    if (e.target.closest('[data-action="cancel"]')) {
      editingId = null
      onEdit?.(null)
      return renderList()
    }
    if (e.target.closest('[data-action="confirm"]')) return onRun?.(id, collectFormOverrides(aside))
    if (e.target.closest('[data-action="run"]')) return onRun?.(id)
  })

  function setRunning(running) {
    aside.querySelectorAll('.station-rail-run, [data-action="confirm"]').forEach(btn => { btn.disabled = running })
  }

  return { el: aside, render, setRunning }
}
