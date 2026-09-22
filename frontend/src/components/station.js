import { createCaptureInput } from './capture.js'
import {
  escHtml, renderForm, collectFormOverrides,
  parseChecklist, renderChecklist, renderShoppingList,
} from './item.js'
import { handleListAction } from './lists.js'
import { icon } from './icons.js'
import { createCapabilities } from './capabilities.js'
import { speak } from '../speech.js'

// The station is a one-thing-at-a-time shell for a wall-mounted panel —
// see TODO.md / CLAUDE.md's Station flow entry. main.js mounts this
// instead of the phone/laptop layout (.layout/.capture/.inbox/.favourites)
// when config.isStation is true; the handlers below are the same ones the
// phone/laptop path already wires up (approve/veto/replay/submit), so all
// of the actual API/plan logic in main.js is untouched — this file is
// purely presentation and local interaction state.
// The two statuses that are a list rather than a captured intention —
// they never resolve away, so they're what the Lists tab lists.
const LIST_STATUSES = ['shopping_list', 'checklist']

// Tool name -> a short, human phrase for the review pane's "what will
// happen" line. Falls back to the raw tool name (underscores replaced)
// for anything added later, so a new acting tool never renders blank.
const TOOL_LABELS = {
  create_linear_task: 'will create a linear issue',
  control_playback: 'will control playback',
  control_light: 'will control lights',
}

export function createStationShell({ onSubmit, onApprove, onVeto, onReplay, onFavourite, onListTextChange, defaultHouse, voiceMode, localActivity } = {}) {
  let tab = 'capture'      // 'capture' | 'favourites' | 'lists' | 'controls'
  let mode = 'idle'        // 'idle' | 'thinking' | 'review'
  let active = null        // the item 'thinking'/'review' is about
  let asideView = null     // null (controls) | 'list' | 'compose' — see the aside below
  let asideItem = null     // the list/composition the aside is showing
  let items = []           // last known items, for the Lists tab and open lists
  let waiting = []         // set-aside items, FIFO
  let failure = null       // persists until retried
  let flashTimer = null

  // ── Top bar: house switcher (left) + set-aside badge (right). The
  // wordmark/info/vpn badge, and now the read-aloud toggle, stay on the
  // shared `header` main.js appends before this element — see main.js's
  // headerBadges (the toggle sits beside the station status dot there) —
  // this is just the station-specific status row. ──
  const topbar = document.createElement('div')
  topbar.className = 'station-topbar'

  const waitingBadge = document.createElement('button')
  waitingBadge.type = 'button'
  waitingBadge.className = 'station-waiting-badge'
  waitingBadge.hidden = true
  waitingBadge.addEventListener('click', () => {
    const next = waiting.shift()
    renderWaitingBadge()
    if (next) {
      setTab('capture')
      setMode('review', next)
    }
  })
  topbar.append(waitingBadge)

  function renderWaitingBadge() {
    waitingBadge.hidden = waiting.length === 0
    waitingBadge.textContent = `${waiting.length} waiting`
  }

  // ── Capture tab: idle / thinking / review panes + the idle-only aside ──
  const paneIdle = document.createElement('div')
  paneIdle.className = 'station-pane station-pane--idle'

  // hideHouseChooser: true — see STATIONS_AND_CONTROLS.md §4 and
  // capture.js's own comment. The header's stations band (main.js) is
  // where "is some other house not answering" now lives; this panel has
  // nothing to choose, only somewhere to check. setHouses() below still
  // runs (via main.js's loadSatellites()) so a capture here still gets
  // tagged with this station's own house — the flag only hides the row.
  const captureInput = createCaptureInput({
    onSubmit: (text, house) => onSubmit?.(text, house),
    defaultHouse,
    hideHouseChooser: true,
    voiceMode,
  })
  paneIdle.append(captureInput.el)

  const paneThinking = document.createElement('div')
  paneThinking.className = 'station-pane station-pane--thinking'
  paneThinking.hidden = true

  const paneReview = document.createElement('div')
  paneReview.className = 'station-pane station-pane--review'
  paneReview.hidden = true
  paneReview.addEventListener('click', (e) => {
    if (e.target.closest('[data-action="speak"]')) speak(active?.action_result)
  })

  // One open list: the shared .checklist markup out of item.js, so a list
  // looks and ticks the same here as in the phone's inbox; only the pane
  // around it is station-specific. Two of these exist — one in home's
  // aside (a list a capture recalled, read beside a capture field that
  // stays live) and one in the Lists tab (whichever list is picked) —
  // rendering the same items, never both on screen at once.
  // onClose: omit for no close button (the Lists tab just picks another).
  function createListPane({ onClose } = {}) {
    const el = document.createElement('div')
    el.className = 'station-pane station-pane--list'
    let item = null

    function render() {
      if (!item) { el.innerHTML = ''; return }
      const isShopping = item.status === 'shopping_list'
      const parsed = parseChecklist(item.text)
      el.innerHTML = `
        <div class="station-pane-top">
          <span class="station-pane-label" data-role="think">${isShopping ? 'shopping list' : 'checklist'}</span>
          ${onClose ? '<button type="button" class="station-pane-link" data-action="close-list">close</button>' : ''}
        </div>
        <div class="station-heading-row">
          <span class="station-heading-icon">${icon(isShopping ? 'shopping-cart' : 'list-checks', 30)}</span>
          <h1 class="station-heading">${escHtml(listTitle(item, parsed))}</h1>
        </div>
        ${isShopping ? renderShoppingList(item.id, parsed) : renderChecklist(item.id, parsed)}
        ${isShopping
          ? `<form class="station-list-add" data-action="add-row">
              <input type="text" name="label" class="station-list-add-input" placeholder="add to the list" autocomplete="off">
              <button type="submit" class="btn-submit">add</button>
            </form>`
          : ''}
      `
    }

    // The pane has no .item wrapper to read an id off, unlike the inbox —
    // the open list *is* `item`, so the id comes from there.
    function context() {
      return {
        findItem: (id) => items.find(i => i.id === id) ?? (item?.id === id ? item : null),
        rerenderItem: () => render(),
        onTextChange: (id, text) => onListTextChange?.(id, text),
      }
    }

    el.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action]')
      if (!btn || !item) return
      if (btn.dataset.action === 'close-list') {
        onClose?.()
        return
      }
      handleListAction({
        action: btn.dataset.action,
        id: item.id,
        index: parseInt(btn.dataset.index, 10),
        ...context(),
      })
    })

    el.addEventListener('submit', (e) => {
      const form = e.target.closest('[data-action="add-row"]')
      if (!form || !item) return
      e.preventDefault()
      const input = form.querySelector('input[name="label"]')
      handleListAction({
        action: 'add-shopping-item',
        id: item.id,
        label: input.value,
        ...context(),
      })
      // Cleared optimistically: the row appears when main.js's PATCH comes
      // back through setItems(), and in the shop you carry on typing the
      // next thing rather than waiting to see this one land.
      input.value = ''
      input.focus()
    })

    return {
      el,
      get item() { return item },
      show(next) { item = next; render() },
      // An open list is a view onto an item main.js re-fetches after a
      // removal or an append — pick the fresh copy up rather than leaving
      // the pre-PATCH text on a wall-mounted screen nobody is looking at.
      // Gone altogether (deleted elsewhere) shows nothing rather than a
      // stale copy.
      refresh() {
        if (!item) return
        item = items.find(i => i.id === item.id) ?? null
        render()
      },
    }
  }

  function listTitle(item, parsed = parseChecklist(item.text)) {
    return parsed.title || (item.status === 'shopping_list' ? 'Shopping list' : 'Checklist')
  }

  const asideList = createListPane({ onClose: () => setAside(null) })
  const paneList = asideList.el
  paneList.hidden = true

  // A composition (see compose in claude.js) is the deliverable itself,
  // not a status to flash and dismiss — it gets the aside to itself, like
  // an open list, rather than being squeezed through the header's flash
  // strip like every other resolved item's action_result. It stays up
  // until closed or replaced; nothing waits on it being dismissed.
  const paneCompose = document.createElement('div')
  paneCompose.className = 'station-pane station-pane--compose'
  paneCompose.hidden = true
  paneCompose.addEventListener('click', (e) => {
    if (e.target.closest('[data-action="speak"]')) { speak(asideItem?.action_result); return }
    const favBtn = e.target.closest('[data-action="favourite"]')
    if (favBtn) { onFavourite?.(favBtn.dataset.id); return }
    if (e.target.closest('[data-action="close-compose"]')) setAside(null)
  })

  function renderCompose() {
    if (!asideItem) return
    const isFavouritable = asideItem.status === 'acted' && Boolean(asideItem.executed_action)
    paneCompose.innerHTML = `
      <div class="station-pane-top">
        <span class="station-pane-label" data-role="done">composed</span>
        <button type="button" class="station-pane-link" data-action="close-compose">done</button>
      </div>
      <p class="station-compose-text">${escHtml(asideItem.action_result)}</p>
      <div class="station-compose-actions">
        <button type="button" class="btn-speak station-speak" data-action="speak" title="Read this out" aria-label="Read this out">${icon('volume-2', 24)}</button>
        ${isFavouritable
          ? `<button type="button" class="btn-favourite" data-action="favourite" data-id="${asideItem.id}" title="Save as favourite" aria-label="Save as favourite">☆</button>`
          : ''}
      </div>
    `
  }

  // ── Lists tab: two panels, same flow as home — an index of every list
  // (left in landscape, top in portrait) and the picked one open beside
  // or under it. Lists are things you recall rather than compose, so they
  // get a tab of their own; one a capture recalls still opens in home's
  // aside instead, next to the capture field it came from. ──
  const listsTab = document.createElement('div')
  listsTab.className = 'station-tabpanel station-tabpanel--lists'
  listsTab.hidden = true

  const listsIndex = document.createElement('div')
  listsIndex.className = 'station-lists-index'
  listsIndex.addEventListener('click', (e) => {
    const row = e.target.closest('[data-id]')
    if (row) pickList(row.dataset.id)
  })

  const tabList = createListPane()
  tabList.el.classList.add('station-lists-open')
  listsTab.append(listsIndex, tabList.el)

  function renderLists() {
    const lists = items.filter(i => LIST_STATUSES.includes(i.status))
    // Nothing picked yet (or the picked one is gone): default to the
    // first, so the tab never opens onto an empty half.
    if (!tabList.item || !lists.some(i => i.id === tabList.item.id)) tabList.show(lists[0] ?? null)
    else tabList.refresh()
    listsIndex.innerHTML = lists.length
      ? `<ul class="station-lists-rows">
          ${lists.map(i => {
            const parsed = parseChecklist(i.text)
            const shopping = i.status === 'shopping_list'
            return `<li>
              <button type="button" class="station-lists-row${i.id === tabList.item?.id ? ' station-lists-row--open' : ''}" data-id="${i.id}">
                ${icon(shopping ? 'shopping-cart' : 'list-checks', 24)}
                <span class="station-lists-name">${escHtml(listTitle(i, parsed))}</span>
                <span class="station-lists-count">${parsed.items.length}</span>
              </button>
            </li>`
          }).join('')}
        </ul>`
      : `<div class="station-empty">No lists yet</div>`
  }

  function pickList(id) {
    const item = items.find(i => i.id === id)
    if (!item) return
    tabList.show(item)
    renderLists()
  }

  // main.js's route for a capture that made or recalled a list: it opens
  // on home, in the aside, next to the capture field it came from — not
  // in the Lists tab, which is for going and finding one.
  function openList(id) {
    const item = items.find(i => i.id === id)
    if (!item) return
    setTab('capture')
    setMode('list', item)
  }

  // The ancillary screen: whatever space the idle layout leaves over —
  // beside the capture field in landscape, under it in portrait.
  // It shows an open list or composition when there is one (asideView),
  // and the Controls panel (now-playing, lights) otherwise, so the
  // commonest direct controls are in view without a tab tap. No orientation logic
  // here: it's a flex: 1 sibling, so flow alone puts it wherever there's
  // room, and it's a CSS size container, so its contents pick a layout
  // from the space it actually got (see styles.css's .station-aside).
  // localActivity.el is one element (one poll loop, one source of
  // truth), so it moves between here and the Controls tab — see
  // placeLocalActivity() — rather than being rendered twice.
  const aside = document.createElement('div')
  aside.className = 'station-aside'
  aside.append(paneList, paneCompose)

  const stationCapture = document.createElement('div')
  stationCapture.className = 'station-capture'
  stationCapture.append(paneIdle, paneThinking, paneReview, aside)

  const reviewActions = document.createElement('div')
  reviewActions.className = 'station-review-actions'
  reviewActions.hidden = true
  reviewActions.innerHTML = `
    <button type="button" class="btn-approve station-approve" data-action="approve">${icon('check', 30)}approve <span class="station-key-hint">&crarr;</span></button>
    <button type="button" class="btn-veto station-veto" data-action="veto">${icon('x', 26)}veto</button>
    <button type="button" class="btn-veto station-later" data-action="later">later <span class="station-key-hint">esc</span></button>
  `
  reviewActions.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]')
    if (!btn || !active) return
    if (btn.dataset.action === 'approve') doApprove()
    if (btn.dataset.action === 'veto') doVeto()
    if (btn.dataset.action === 'later') doSetAside()
  })

  const captureTab = document.createElement('div')
  captureTab.className = 'station-tabpanel station-tabpanel--capture'
  captureTab.append(stationCapture, reviewActions)

  // ── Favourites tab: full list, tap-to-replay grid ──
  const favTab = document.createElement('div')
  favTab.className = 'station-tabpanel station-tabpanel--favourites'
  favTab.hidden = true
  favTab.addEventListener('click', (e) => {
    const tile = e.target.closest('[data-id]')
    if (tile && e.target.closest('[data-action="run"]')) onReplay?.(tile.dataset.id)
  })

  function renderFavGrid(list) {
    favTab.innerHTML = list.length
      ? `<ul class="station-grid">${list.map(fav => `
          <li class="station-tile" data-id="${fav.id}">
            <button type="button" class="station-tile-btn" data-action="run" title="Run again, exactly as before">${escHtml(fav.label)}</button>
          </li>`).join('')}</ul>`
      : `<div class="station-empty">No favourites saved yet</div>`
  }

  // ── Controls tab: all the local device controls (Music/Lights) plus
  // what this house can do — the same panel home's aside shows, see
  // localActivity.js (variant: 'rich') for what actually lives inside
  // localActivity.el. On a general (non-satellite) deployment
  // localActivity still exists (main.js always creates it) but its GET
  // /api/status 404s immediately, so the tab renders empty rather than
  // being hidden outright — one less conditional to keep in sync with a
  // state that can only be known async. ──
  const controlsTab = document.createElement('div')
  controlsTab.className = 'station-tabpanel station-tabpanel--controls'
  controlsTab.hidden = true
  if (localActivity) controlsTab.append(localActivity.el)
  // localActivity.el hides *itself* (see localActivity.js) once it knows
  // there's nothing to show — no activity, or no satellite serving this
  // page at all. This sibling only shows when that happens (CSS, keyed
  // off .local-activity[hidden]) rather than the tab going blank.
  const controlsEmpty = document.createElement('div')
  controlsEmpty.className = 'station-empty station-controls-empty'
  controlsEmpty.textContent = 'Nothing to control right now'
  controlsTab.append(controlsEmpty)

  // "What this house can do" — reference material, not live status (see
  // STATIONS_AND_CONTROLS.md §3), so it renders on demand rather than
  // owning its own poll: once whenever integrations info arrives
  // (setIntegrations, from main.js's GET /api/version), and again on
  // every localActivity poll tick so device/room counts stay current.
  const capabilities = createCapabilities()
  controlsTab.append(capabilities.el)
  let integrations = null
  function renderCapabilities() {
    capabilities.render({ integrations, localStatus: localActivity?.getLastStatus() })
  }
  localActivity?.onStatus(renderCapabilities)

  // ── Bottom tabs ──
  // The internal tab name stays 'capture' (setTab('capture') etc., wired
  // throughout this file) — only the tab's own label reads "home": the
  // panel rests here rather than one thing it does.
  // No record-of-actions tab: a wall panel is for doing things, and the
  // audit trail is still on the phone/laptop inbox (and in git).
  const TAB_ICONS = { capture: 'house', favourites: 'star', lists: 'list-checks', controls: 'sliders-horizontal' }
  const TAB_LABELS = { capture: 'home', favourites: 'favourites', lists: 'lists', controls: 'controls' }
  const tabsBar = document.createElement('div')
  tabsBar.className = 'station-tabs'
  const tabButtons = {}
  for (const name of ['capture', 'favourites', 'lists', 'controls']) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'station-tab'
    btn.dataset.tab = name
    btn.innerHTML = `${icon(TAB_ICONS[name], 26)}<span>${TAB_LABELS[name]}</span>`
    btn.addEventListener('click', () => setTab(name))
    tabsBar.append(btn)
    tabButtons[name] = btn
  }

  // The Controls tab wins when it's the one showing; otherwise the panel
  // sits in the idle screen's aside. Inserted before controlsEmpty so its
  // `.local-activity[hidden] + .station-controls-empty` rule still holds.
  function placeLocalActivity() {
    if (!localActivity) return
    if (tab === 'controls') controlsTab.insertBefore(localActivity.el, controlsEmpty)
    else aside.append(localActivity.el)
  }

  function setTab(name) {
    tab = name
    placeLocalActivity()
    captureTab.hidden = name !== 'capture'
    favTab.hidden = name !== 'favourites'
    listsTab.hidden = name !== 'lists'
    controlsTab.hidden = name !== 'controls'
    for (const [n, btn] of Object.entries(tabButtons)) {
      btn.classList.toggle('station-tab--active', n === name)
    }
    syncReviewActionsVisibility()
    if (name === 'capture') focusInput()
  }

  function syncReviewActionsVisibility() {
    reviewActions.hidden = !(tab === 'capture' && mode === 'review')
  }

  // ── Flash / failure bars, above the tabs ──
  const flashEl = document.createElement('div')
  flashEl.className = 'station-flash'
  flashEl.hidden = true

  // Mirrors item.js's isFavouritable check for the ☆ on a resolved item's
  // result strip — only an 'acted' item with an executed_action has a
  // { tool, input } to freeze into a favourite. A composition never reaches
  // here at all — settleStationItem (main.js) routes it to the 'compose'
  // pane below instead, the same way it routes an awaiting_approval item
  // to 'review' rather than a flash.
  let flashItem = null
  function setFlash(item) {
    clearTimeout(flashTimer)
    flashItem = item
    if (!item) {
      flashEl.hidden = true
      return
    }
    const isFavouritable = item.status === 'acted' && Boolean(item.executed_action)
    flashEl.innerHTML = `
      <span class="station-flash-check">&#10003;</span>
      <span class="station-flash-text">${escHtml(item.action_result)}</span>
      <button type="button" class="btn-speak station-flash-speak" data-action="speak" title="Read this out" aria-label="Read this out">${icon('volume-2', 22)}</button>
      ${isFavouritable
        ? `<button type="button" class="btn-favourite station-flash-favourite" data-action="favourite" data-id="${item.id}" title="Save as favourite" aria-label="Save as favourite">☆</button>`
        : ''}
    `
    flashEl.hidden = false
    // A favouritable flash stays up until starred (or replaced by the next
    // flash/capture) instead of auto-hiding after 3s — tapping a star on a
    // wall panel needs longer than a glance affords.
    if (!isFavouritable) {
      flashTimer = setTimeout(() => { flashEl.hidden = true }, 3000)
    }
  }

  flashEl.addEventListener('click', (e) => {
    if (e.target.closest('[data-action="speak"]')) {
      speak(flashItem?.action_result)
      return
    }
    const btn = e.target.closest('[data-action="favourite"]')
    if (!btn) return
    onFavourite?.(btn.dataset.id)
  })

  // Called after a successful POST .../favourite — swaps the star to a
  // filled, disabled state (same treatment as inbox.js's markFavourited),
  // wherever it's showing: the flash strip for an ordinary resolved item,
  // or the compose pane for a composition (see setMode's 'compose' case).
  // The flash also gets to auto-hide now that it's done its job; the
  // compose pane stays up until "done" is tapped.
  function markFavourited(itemId) {
    for (const container of [flashEl, paneCompose]) {
      const btn = container.querySelector(`[data-action="favourite"][data-id="${itemId}"]`)
      if (!btn) continue
      btn.textContent = '★'
      btn.disabled = true
      btn.title = 'Saved as favourite'
    }
    flashTimer = setTimeout(() => { flashEl.hidden = true }, 3000)
  }

  const failureEl = document.createElement('div')
  failureEl.className = 'station-failure'
  failureEl.hidden = true
  failureEl.addEventListener('click', (e) => {
    if (!e.target.closest('[data-action="retry"]') || !failure) return
    const text = failure.text
    setFailure(null)
    onSubmit?.(text)
  })

  function setFailure(item) {
    failure = item
    if (!item) {
      failureEl.hidden = true
      return
    }
    failureEl.innerHTML = `
      <span class="station-failure-label">failed</span>
      <span class="station-failure-text">${escHtml(item.action_result ?? item.text)}</span>
      <button type="button" class="station-failure-retry" data-action="retry">retry</button>
    `
    failureEl.hidden = false
  }

  // ── Modes ──
  function renderThinking() {
    const steps = active?.plan_progress ?? []
    paneThinking.innerHTML = `
      <div class="station-pane-top">
        <span class="station-pane-label" data-role="think">thinking</span>
      </div>
      <div class="station-scan-rule"><span class="station-scan-fill"></span></div>
      <h1 class="station-heading">${escHtml(active?.text ?? '')}</h1>
      <ul class="station-steps">
        ${steps.map(s => `<li class="station-step station-step--done"><span class="station-step-check">&#10003;</span>${escHtml(s.label)}</li>`).join('')}
        <li class="station-step station-step--pending">&middot; Almost there&hellip;</li>
      </ul>
    `
  }

  function renderReview() {
    const item = active
    const fields = item?.form_fields ?? []
    const toolLabel = TOOL_LABELS[item?.pending_action?.tool]
      ?? (item?.pending_action?.tool ? item.pending_action.tool.replace(/_/g, ' ') : '')
    paneReview.innerHTML = `
      <div class="station-pane-top">
        <span class="station-pane-label" data-role="need">needs you</span>
        <span class="station-pane-hint">start typing to set aside</span>
      </div>
      <h1 class="station-heading">${escHtml(item?.text ?? '')}</h1>
      ${item?.action_result
        ? `<div class="station-review-quote">
            <span class="station-review-quote-text">${escHtml(item.action_result)}</span>
            <button type="button" class="btn-speak station-speak" data-action="speak" title="Read this out" aria-label="Read this out">${icon('volume-2', 24)}</button>
          </div>`
        : ''}
      ${toolLabel
        ? `<div class="station-review-meta">${escHtml(toolLabel)}${item?.house ? ` &middot; ${escHtml(item.house)}` : ''}</div>`
        : ''}
      ${fields.length ? renderForm(fields) : ''}
    `
  }

  // What the aside shows: an open list, a composition, or (null) the
  // Controls panel — which CSS hides whenever a pane is showing instead.
  function setAside(view, item = null) {
    asideView = view
    asideItem = view ? item : null
    paneList.hidden = view !== 'list'
    paneCompose.hidden = view !== 'compose'
    if (view === 'list') asideList.show(item)
    else asideList.show(null)
    if (view === 'compose') renderCompose()
  }

  function setMode(newMode, data) {
    // 'list' and 'compose' aren't screens of their own: they open in the
    // aside and leave the station idle, capture field ready. main.js still
    // routes them through here.
    if (newMode === 'list' || newMode === 'compose') {
      setAside(newMode, data)
      newMode = 'idle'
    }
    mode = newMode
    // Idle only: thinking/review take the full width. Whatever the aside
    // held comes back with idle, until it's closed or replaced.
    aside.hidden = newMode !== 'idle'
    if (newMode === 'idle') {
      active = null
      paneIdle.hidden = false
      paneThinking.hidden = true
      paneReview.hidden = true
      focusInput()
    } else if (newMode === 'thinking') {
      active = data?.item ?? active
      paneIdle.hidden = true
      paneThinking.hidden = false
      paneReview.hidden = true
      renderThinking()
    } else if (newMode === 'review') {
      active = data
      paneIdle.hidden = true
      paneThinking.hidden = true
      paneReview.hidden = false
      renderReview()
    }
    syncReviewActionsVisibility()
  }

  function doApprove() {
    if (!active) return
    onApprove?.(active.id, collectFormOverrides(paneReview))
  }

  function doVeto() {
    if (!active) return
    onVeto?.(active.id)
  }

  function doSetAside() {
    if (!active) return
    waiting.push(active)
    renderWaitingBadge()
    setMode('idle')
  }

  // Set-aside: Enter approves, Escape sets aside and stays idle, any other
  // printable key sets aside and starts a new capture with that keystroke.
  // Guarded to the review pane's background — a field inside an action
  // form (see renderForm() above) needs its own keystrokes untouched.
  document.addEventListener('keydown', (e) => {
    if (tab !== 'capture' || mode !== 'review' || !active) return
    if (e.target instanceof HTMLElement && ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return
    if (e.key === 'Enter') {
      e.preventDefault()
      doApprove()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      doSetAside()
    } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault()
      const char = e.key
      doSetAside()
      const ta = captureInput.el.querySelector('textarea')
      if (ta) {
        ta.value = char
        ta.focus()
        ta.selectionStart = ta.selectionEnd = ta.value.length
      }
    }
  })

  function focusInput() {
    if (tab !== 'capture') return
    captureInput.el.querySelector('textarea')?.focus()
  }

  // ── Assemble ──
  const body = document.createElement('div')
  body.className = 'station-body'
  body.append(captureTab, favTab, listsTab, controlsTab)

  const el = document.createElement('div')
  el.className = 'station'
  el.append(topbar, body, flashEl, failureEl, tabsBar)

  // The system cursor is hidden on the station (theme.css) — a touch
  // leaves no mark otherwise, and a wall panel gets tapped by more than
  // one person. A brief dot where you actually touched replaces it.
  // Touch only: a mouse (dev tools, testing over a remote desktop) still
  // has its own pointer to look at.
  el.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch') return
    const dot = document.createElement('div')
    dot.className = 'station-tap-ripple'
    dot.style.left = `${e.clientX}px`
    dot.style.top = `${e.clientY}px`
    dot.addEventListener('animationend', () => dot.remove())
    document.body.append(dot)
  })

  setTab('capture')
  setMode('idle')

  // Everything the station knows about items arrives here (main.js calls
  // it on every add, update and poll), so this is where the Lists tab and
  // the aside's open list get refreshed too.
  function setItems(next) {
    items = next
    renderLists()
    if (asideView === 'list') asideList.refresh()
  }

  return {
    el,
    setMode,
    openList,
    setWaiting(list) { waiting = [...list]; renderWaitingBadge() },
    setFlash,
    markFavourited,
    setFailure,
    setFavourites(list) { renderFavGrid(list) },
    setItems,
    setHouses: captureInput.setHouses,
    setIntegrations(data) { integrations = data; renderCapabilities() },
    focusInput,
    // Nothing on screen that a reload would lose: back at the empty
    // capture field, no retry bar. Set-aside items don't count — they're
    // rebuilt from the server's awaiting_approval items on load anyway —
    // and nor does an open list/composition in the aside: it's left up
    // rather than dismissed now, and a reload only happens once the panel
    // has gone dark (stationUpdate.js), so nobody is reading it.
    isAtRest() {
      return mode === 'idle' && !failure && !captureInput.el.querySelector('textarea')?.value
    },
  }
}
