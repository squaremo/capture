import { createCaptureInput } from './capture.js'
import { createFavouritesRail } from './favourites.js'
import { escHtml, renderForm, collectFormOverrides, relativeTime } from './item.js'

// The station is a one-thing-at-a-time shell for a wall-mounted panel —
// see TODO.md / CLAUDE.md's Station flow entry. main.js mounts this
// instead of the phone/laptop layout (.layout/.capture/.inbox/.favourites)
// when config.isStation is true; the handlers below are the same ones the
// phone/laptop path already wires up (approve/veto/replay/submit), so all
// of the actual API/plan logic in main.js is untouched — this file is
// purely presentation and local interaction state.
const RESOLVED_STATUSES = ['acted', 'vetoed', 'failed']

// Tool name -> a short, human phrase for the review pane's "what will
// happen" line. Falls back to the raw tool name (underscores replaced)
// for anything added later, so a new acting tool never renders blank.
const TOOL_LABELS = {
  create_linear_task: 'will create a linear issue',
  control_playback: 'will control playback',
  control_light: 'will control lights',
}

export function createStationShell({ onSubmit, onApprove, onVeto, onReplay, onEditFavourite } = {}) {
  let tab = 'capture'      // 'capture' | 'favourites' | 'earlier'
  let mode = 'idle'        // 'idle' | 'thinking' | 'review'
  let active = null        // the item 'thinking'/'review' is about
  let waiting = []         // set-aside items, FIFO
  let failure = null       // persists until retried
  let flashTimer = null

  // ── Top bar: just the set-aside badge. The wordmark/info/vpn badge
  // stay on the shared `header` main.js appends before this element. ──
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

  // ── Capture tab: idle / thinking / review panes + the idle-only rail ──
  const paneIdle = document.createElement('div')
  paneIdle.className = 'station-pane station-pane--idle'

  const captureInput = createCaptureInput({ onSubmit: (text) => onSubmit?.(text) })
  paneIdle.append(captureInput.el)

  const paneThinking = document.createElement('div')
  paneThinking.className = 'station-pane station-pane--thinking'
  paneThinking.hidden = true

  const paneReview = document.createElement('div')
  paneReview.className = 'station-pane station-pane--review'
  paneReview.hidden = true

  const rail = createFavouritesRail({
    onRun: (id, overrides) => onReplay?.(id, overrides),
    onOpenAll: () => setTab('favourites'),
    onEdit: (id) => onEditFavourite?.(id),
  })

  const stationCapture = document.createElement('div')
  stationCapture.className = 'station-capture'
  stationCapture.append(paneIdle, paneThinking, paneReview, rail.el)

  const reviewActions = document.createElement('div')
  reviewActions.className = 'station-review-actions'
  reviewActions.hidden = true
  reviewActions.innerHTML = `
    <button type="button" class="btn-approve station-approve" data-action="approve">approve <span class="station-key-hint">&crarr;</span></button>
    <button type="button" class="btn-veto station-veto" data-action="veto">veto</button>
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

  // ── Earlier tab: read-only audit trail ──
  const earlierTab = document.createElement('div')
  earlierTab.className = 'station-tabpanel station-tabpanel--earlier'
  earlierTab.hidden = true

  function renderLog(items) {
    const rows = items.filter(i => RESOLVED_STATUSES.includes(i.status))
    earlierTab.innerHTML = rows.length
      ? `<ul class="station-log">${rows.map(i => `
          <li class="station-log-row" data-role="${i.status === 'failed' ? 'fail' : i.status === 'vetoed' ? 'muted' : 'done'}">
            <span class="station-log-status">${i.status}</span>
            <span class="station-log-text">${escHtml(i.text)}</span>
            <time class="station-log-time">${relativeTime(i.created_at)}</time>
          </li>`).join('')}</ul>`
      : `<div class="station-empty">Nothing yet</div>`
  }

  // ── Bottom tabs ──
  const tabsBar = document.createElement('div')
  tabsBar.className = 'station-tabs'
  const tabButtons = {}
  for (const name of ['capture', 'favourites', 'earlier']) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'station-tab'
    btn.dataset.tab = name
    btn.textContent = name
    btn.addEventListener('click', () => setTab(name))
    tabsBar.append(btn)
    tabButtons[name] = btn
  }

  function setTab(name) {
    tab = name
    captureTab.hidden = name !== 'capture'
    favTab.hidden = name !== 'favourites'
    earlierTab.hidden = name !== 'earlier'
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

  function setFlash(text) {
    clearTimeout(flashTimer)
    if (!text) {
      flashEl.hidden = true
      return
    }
    flashEl.innerHTML = `<span class="station-flash-check">&#10003;</span><span class="station-flash-text">${escHtml(text)}</span>`
    flashEl.hidden = false
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
      ${toolLabel
        ? `<div class="station-review-meta">${escHtml(toolLabel)}${item?.house ? ` &middot; ${escHtml(item.house)}` : ''}</div>`
        : ''}
      ${fields.length
        ? renderForm(fields)
        : item?.action_result ? `<div class="station-review-quote">${escHtml(item.action_result)}</div>` : ''}
    `
  }

  function setMode(newMode, data) {
    mode = newMode
    if (newMode === 'idle') {
      active = null
      paneIdle.hidden = false
      paneThinking.hidden = true
      paneReview.hidden = true
      rail.el.hidden = false
      focusInput()
    } else if (newMode === 'thinking') {
      active = data?.item ?? active
      paneIdle.hidden = true
      paneThinking.hidden = false
      paneReview.hidden = true
      rail.el.hidden = true
      renderThinking()
    } else if (newMode === 'review') {
      active = data
      paneIdle.hidden = true
      paneThinking.hidden = true
      paneReview.hidden = false
      rail.el.hidden = true
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
  body.append(captureTab, favTab, earlierTab)

  const el = document.createElement('div')
  el.className = 'station'
  el.append(topbar, body, flashEl, failureEl, tabsBar)

  setTab('capture')
  setMode('idle')

  return {
    el,
    setMode,
    setWaiting(items) { waiting = [...items]; renderWaitingBadge() },
    setFlash,
    setFailure,
    setFavourites(list) { rail.render(list); renderFavGrid(list) },
    setLog: renderLog,
    focusInput,
  }
}
