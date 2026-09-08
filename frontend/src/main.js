import './styles.css'
import { createCaptureInput } from './components/capture.js'
import { createInbox } from './components/inbox.js'
import { createVersionInfo } from './components/versionInfo.js'
import { createFavouritesSidebar } from './components/favourites.js'
import { createLocalActivity } from './components/localActivity.js'
import { createStationShell } from './components/station.js'
import { createThemePicker } from './themes.js'
import { loadConfig } from './config.js'
import {
  configureApi, postCapture, getItem, getItems, approveItem, vetoItem, getVersion, getSatellites,
  favouriteItem, getFavourites, runFavourite, deleteFavourite, patchItem,
} from './api.js'

// Runtime config (see config.js) has to resolve before anything below
// makes an API call or builds the house chooser — configureApi() sets
// where capture/inbox calls actually go, and defaultHouse feeds
// createCaptureInput() directly, no longer a build-time global. Wrapped
// in an async function rather than top-level await — the build target
// (vite-plugin-pwa's default browserslist) doesn't support that at the
// module level.
init()

async function init() {
  const config = await loadConfig()
  configureApi(config)

  // index.html's inline pre-paint script already guessed data-density from
  // the ?station query param, since it has to run before this config fetch
  // resolves — reconcile it here now that a satellite can answer with its
  // own real isStation (see /config.json), which wins over a stray/missing
  // query param either way. Only matters when the two disagree; otherwise
  // this is a no-op and there's no flash.
  if (config.isStation) {
    document.documentElement.dataset.density = 'station'
  } else {
    delete document.documentElement.dataset.density
  }

  const app = document.getElementById('app')

  // ── Header ────────────────────────────────────────────────
  const header = document.createElement('header')
  const logo = document.createElement('span')
  logo.className = 'logo'
  // On the station the wordmark names the panel, not the product — you're
  // standing in front of it, so where it is is the only thing here you
  // might not already know. config.defaultHouse is the room the panel's
  // own satellite is grouped to (see config.js); falls back to the
  // product name when a station has none configured.
  logo.textContent = (config.isStation && config.defaultHouse) || 'capture'

  const vpnBadge = document.createElement('span')
  vpnBadge.className = 'vpn-badge'
  vpnBadge.textContent = 'tailscale'

  const versionInfo = createVersionInfo()

  // Theme lives in the info panel — a rare, deliberate change, not header
  // status. The theme itself is already applied (index.html, pre-paint).
  const themePicker = createThemePicker()
  versionInfo.panelExtrasEl.append(themePicker.el)

  const headerBadges = document.createElement('div')
  headerBadges.className = 'header-badges'
  headerBadges.append(versionInfo.pillEl, vpnBadge)

  header.append(logo, headerBadges)

  // ── Inbox ─────────────────────────────────────────────────
  const inFlight = new Set() // item ids currently being approved/vetoed/favourited

  // Checklist ticking/resetting is handled entirely inside inbox.js —
  // ticked state lives only in this browser's localStorage (see item.js),
  // so there's no server call and nothing for main.js to wire up here. The
  // shopping list needs two real server calls though, since — unlike a
  // checklist's ticks — its state (what's on it) is shared, not per-device:
  // "done shopping" commits a removal (onShoppingListChange), and a capture
  // elsewhere that added to the *existing* list (rather than becoming it)
  // leaves this device's copy of that item stale, needing a refetch
  // (onShoppingListUpdated).
  const inbox = createInbox({
    onApprove: (id, overrides) => handleDecision(id, () => approveItem(id, overrides)),
    onVeto: (id) => handleDecision(id, () => vetoItem(id)),
    onFavourite: (id) => handleFavourite(id),
    onShoppingListChange: (id, text) => handleDecision(id, () => patchItem(id, { text })),
    onShoppingListUpdated: (id) => handleShoppingListUpdated(id),
  })

  async function handleDecision(id, action) {
    if (inFlight.has(id)) return // ignore repeat clicks while a decision is in flight
    inFlight.add(id)
    try {
      const updated = await action()
      inbox.updateItem(updated)
      updateStats()
      if (config.isStation) {
        stationUpdateItem(updated, id)
        settleStationItem(updated)
      }
    } catch (err) {
      console.error(err)
    } finally {
      inFlight.delete(id)
    }
  }

  // ── Local device activity (satellite-served pages only) ────
  // Created here, ahead of station below, since station.js reparents its
  // element into the rail (landscape) at construction time — it has to
  // exist first. See the Now-playing entry in CLAUDE.md's Station section.
  const localActivity = createLocalActivity()

  // ── Station (wall-mounted panel) ───────────────────────────
  // One thing at a time instead of the phone/laptop's always-visible
  // inbox — see station.js and CLAUDE.md's Station flow entry. `inbox`
  // above still exists and is kept up to date in station mode (its
  // element is simply never appended to the page — see Assemble below),
  // so this is purely additive: everything above is untouched, station
  // is just another view onto the same handlers and API calls.
  let stationItems = []

  function stationAddItem(item) {
    stationItems.unshift(item)
    station.setLog(stationItems)
  }

  function stationUpdateItem(updated, matchId = updated.id) {
    const idx = stationItems.findIndex(i => i.id === matchId)
    if (idx === -1) stationItems.unshift(updated)
    else stationItems[idx] = updated
    station.setLog(stationItems)
  }

  // Resolution routes to the review pane when the item is awaiting a
  // decision; anything else returns to idle with a flash (or the
  // persistent failure bar) and is logged in the Earlier tab.
  function settleStationItem(item) {
    if (item.status === 'awaiting_approval') {
      station.setMode('review', item)
      return
    }
    // A capture that made or named a list opens it, rather than flashing a
    // confirmation at an empty field: "what's on the Sainsbury's list" is a
    // recall, and the list itself is the answer. recalled_checklist_id /
    // shopping_list_id name the *other*, already-existing item the capture
    // folded into (see inbox.js's updateItem); failing that, if this item
    // is a list, it is the one to show.
    const listId = item.recalled_checklist_id
      ?? item.shopping_list_id
      ?? (['checklist', 'shopping_list'].includes(item.status) ? item.id : null)
    if (listId) {
      station.openList(listId)
      return
    }
    station.setMode('idle')
    if (item.status === 'failed') station.setFailure(item)
    else if (item.action_result) station.setFlash(item)
  }

  const station = config.isStation ? createStationShell({
    defaultHouse: config.defaultHouse,
    localActivityEl: localActivity.el,
    // The list pane's own edits — "done shopping" and the add row — are
    // the same PATCH the inbox's are (see onShoppingListChange above).
    onListTextChange: (id, text) => handleDecision(id, () => patchItem(id, { text })),
    onSubmit: (text, house) => submitCapture(text, house),
    onApprove: (id, overrides) => handleDecision(id, () => approveItem(id, overrides)),
    onVeto: (id) => handleDecision(id, () => vetoItem(id)),
    onReplay: (id, overrides) => handleFavouriteRun(id, overrides),
    onFavourite: (id) => handleFavourite(id),
  }) : null

  async function handleShoppingListUpdated(id) {
    try {
      inbox.updateItem(await getItem(id))
    } catch (err) {
      console.error(err)
    }
  }

  // ── Favourites ────────────────────────────────────────────
  // A favourite freezes one already-executed tool call (star it once, from a
  // resolved item) for one-click replay later — see GET /api/favourites and
  // backend/server.js. No new planning or approval happens on replay: the
  // human already approved this exact resolved action when it was favourited.
  const favouritesSidebar = createFavouritesSidebar({
    onRun: (id, overrides) => handleFavouriteRun(id, overrides),
    onDelete: (id) => handleFavouriteDelete(id),
  })

  let favourites = []

  async function handleFavourite(itemId) {
    if (inFlight.has(itemId)) return
    inFlight.add(itemId)
    try {
      const favourite = await favouriteItem(itemId)
      favourites.unshift(favourite)
      favouritesSidebar.render(favourites)
      inbox.markFavourited(itemId)
      if (config.isStation) station.markFavourited(itemId)
    } catch (err) {
      console.error(err)
    } finally {
      inFlight.delete(itemId)
    }
  }

  async function handleFavouriteRun(favouriteId, overrides) {
    if (inFlight.has(favouriteId)) return
    inFlight.add(favouriteId)
    favouritesSidebar.setRunning(favouriteId, true)
    try {
      const item = await runFavourite(favouriteId, overrides)
      inbox.addItem(item) // shows up in the resolved section, same as any other capture
      updateStats()
      if (config.isStation) {
        stationAddItem(item)
        settleStationItem(item)
      }
      // A successful run can change the favourite itself now (see
      // POST /api/favourites/:id/run) — its label/input become whatever
      // just ran, so re-fetch rather than leave the sidebar showing the
      // pre-run values until the next page load.
      await loadFavourites()
    } catch (err) {
      console.error(err)
    } finally {
      inFlight.delete(favouriteId)
      favouritesSidebar.setRunning(favouriteId, false)
    }
  }

  async function handleFavouriteDelete(favouriteId) {
    try {
      await deleteFavourite(favouriteId)
      favourites = favourites.filter(f => f.id !== favouriteId)
      favouritesSidebar.render(favourites)
    } catch (err) {
      console.error(err)
    }
  }

  async function loadFavourites() {
    try {
      favourites = await getFavourites()
      favouritesSidebar.render(favourites)
      if (config.isStation) station.setFavourites(favourites)
    } catch {
      // Backend not available yet — leave the sidebar hidden
    }
  }

  // ── Stats footer ──────────────────────────────────────────
  const stats = document.createElement('footer')
  stats.className = 'stats'

  function updateStats() {
    stats.textContent = `${inbox.itemCount} items · ${inbox.pendingCount} pending`
  }

  // ── Capture input ─────────────────────────────────────────
  const captureInput = createCaptureInput({
    defaultHouse: config.defaultHouse,
    onSubmit: (text, house) => submitCapture(text, house),
  })

  // Shared by the phone/laptop capture field above and the station's own
  // (see station.js's createCaptureInput instance) — station calls this
  // with no house, since there's no house chooser on the panel.
  async function submitCapture(text, house) {
    // Optimistic: add pending item immediately
    const optimistic = {
      id: `pending-${Date.now()}`,
      text,
      status: 'pending',
      action_result: null,
      created_at: new Date().toISOString(),
    }
    inbox.addItem(optimistic)
    updateStats()
    if (config.isStation) {
      stationAddItem(optimistic)
      station.setMode('thinking', { item: optimistic })
    }

    try {
      const saved = await postCapture(text, house)
      // Replace optimistic item with the real one — saved.id is the
      // server-assigned id, different from optimistic.id, so the lookup
      // needs to match on the old id while storing/rendering the new one.
      inbox.updateItem(saved, optimistic.id)
      updateStats()
      if (config.isStation) {
        stationUpdateItem(saved, optimistic.id)
        station.setMode('thinking', { item: saved })
      }

      // Poll for resolution (backend processes async)
      pollForResolution(saved.id)
    } catch (err) {
      const failed = { ...optimistic, status: 'failed', action_result: 'Failed to reach server.' }
      inbox.updateItem(failed, optimistic.id)
      updateStats()
      if (config.isStation) {
        stationUpdateItem(failed, optimistic.id)
        station.setFailure(failed)
        station.setMode('idle')
      }
      console.error(err)
    }
  }

  // ── Poll until item leaves pending state ──────────────────
  // A generous budget: ~40 attempts at up to 5s apart is a few minutes total,
  // comfortably covering slow LLM responses. A single failed/non-ok fetch
  // (e.g. the backend restarting mid-poll) retries rather than giving up —
  // previously it stopped polling for good on the first hiccup, which is how
  // an item could end up stuck showing "pending" indefinitely even though it
  // had actually resolved on the server.
  //
  // The attempt count backs off (1s, 2s, 3s...) to tolerate genuinely slow or
  // stalled resolution, but that backoff resets whenever plan_progress grows —
  // a multi-step plan checking things off should keep polling briskly for as
  // long as it's actually making progress, and only ease off once it goes quiet.
  function pollForResolution(id, attempts = 0, lastProgress = 0) {
    if (attempts >= 40) return
    const delay = Math.min(1000 * (attempts + 1), 5000)
    setTimeout(async () => {
      try {
        const item = await getItem(id)
        inbox.updateItem(item)
        updateStats()
        if (config.isStation) {
          stationUpdateItem(item, id)
          if (item.status === 'pending') station.setMode('thinking', { item })
          else settleStationItem(item)
        }
        const progress = item.plan_progress?.length ?? 0
        if (item.status === 'pending') {
          pollForResolution(id, progress > lastProgress ? 0 : attempts + 1, progress)
        }
      } catch {
        pollForResolution(id, attempts + 1, lastProgress)
      }
    }, delay)
  }

  // ── Initial load ──────────────────────────────────────────
  async function loadItems() {
    try {
      const items = await getItems()
      inbox.setItems(items)
      updateStats()
      if (config.isStation) {
        stationItems = items
        station.setLog(stationItems)
        // Anything still awaiting a decision from before a panel reboot
        // is still awaiting_approval server-side (see CLAUDE.md's Station
        // flow open questions) — surfaced as waiting rather than dropped
        // straight into review, so reopening the app is never itself a
        // decision you're forced into.
        station.setWaiting(items.filter(i => i.status === 'awaiting_approval'))
      }
    } catch {
      // Backend not available yet — start with empty inbox
      updateStats()
    }
  }

  // ── Version / integrations info (header pill + footer) ─────
  async function loadVersion() {
    try {
      versionInfo.render(await getVersion())
    } catch {
      // Backend not available yet — leave it blank rather than showing stale info
    }
  }

  // ── Satellites info (header pill + capture house chooser) ──
  async function loadSatellites() {
    try {
      const satellites = await getSatellites()
      versionInfo.renderSatellites(satellites)
      captureInput.setHouses(satellites)
      if (config.isStation) station.setHouses(satellites)
    } catch {
      // Backend not available yet, or no satellites configured — leave blank
    }
  }

  // ── Assemble ──────────────────────────────────────────────
  // The favourites sidebar sits alongside the capture/inbox column — a real
  // side-by-side layout on a wide viewport (see .layout in styles.css), and
  // stacks above it on a narrow one, since this app is phone-first.
  const main = document.createElement('div')
  main.className = 'main-column'
  main.append(captureInput.el, inbox.el)
  // localActivity.el already lives inside station's own tree in station
  // mode (see createStationShell above) — appending it here too would
  // just steal it back, since a DOM node can only have one parent.
  if (!config.isStation) main.prepend(localActivity.el)

  const layout = document.createElement('div')
  layout.className = 'layout'
  layout.append(favouritesSidebar.el, main)

  // The station gets the wall-mounted, one-thing-at-a-time shell instead
  // of the phone/laptop layout — see station.js. `inbox`/`captureInput`/
  // `favouritesSidebar`/`localActivity`/`stats` above still exist and stay
  // updated in station mode (harmless — they're just never appended to
  // the page), so the API calls and decision logic above didn't need
  // restructuring, only the extra `station.*` calls alongside them.
  if (config.isStation) {
    app.append(header, station.el)
  } else {
    app.append(header, layout, stats, versionInfo.footerEl)
  }
  loadItems()
  loadVersion()
  loadSatellites()
  loadFavourites()
}
