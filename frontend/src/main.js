import './styles.css'
import { createCaptureInput } from './components/capture.js'
import { createInbox } from './components/inbox.js'
import { createVersionInfo } from './components/versionInfo.js'
import { createFavouritesSidebar } from './components/favourites.js'
import { loadConfig } from './config.js'
import {
  configureApi, postCapture, getItem, getItems, approveItem, vetoItem, getVersion, getSatellites,
  favouriteItem, getFavourites, runFavourite, deleteFavourite,
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

  const app = document.getElementById('app')

  // ── Header ────────────────────────────────────────────────
  const header = document.createElement('header')
  const logo = document.createElement('span')
  logo.className = 'logo'
  logo.textContent = 'capture'

  const vpnBadge = document.createElement('span')
  vpnBadge.className = 'vpn-badge'
  vpnBadge.textContent = 'tailscale'

  const versionInfo = createVersionInfo()

  const headerBadges = document.createElement('div')
  headerBadges.className = 'header-badges'
  headerBadges.append(versionInfo.pillEl, vpnBadge)

  header.append(logo, headerBadges)

  // ── Inbox ─────────────────────────────────────────────────
  const inFlight = new Set() // item ids currently being approved/vetoed/favourited

  const inbox = createInbox({
    onApprove: (id) => handleDecision(id, approveItem),
    onVeto: (id) => handleDecision(id, vetoItem),
    onFavourite: (id) => handleFavourite(id),
  })

  async function handleDecision(id, action) {
    if (inFlight.has(id)) return // ignore repeat clicks while a decision is in flight
    inFlight.add(id)
    try {
      const updated = await action(id)
      inbox.updateItem(updated)
      updateStats()
    } catch (err) {
      console.error(err)
    } finally {
      inFlight.delete(id)
    }
  }

  // ── Favourites ────────────────────────────────────────────
  // A favourite freezes one already-executed tool call (star it once, from a
  // resolved item) for one-click replay later — see GET /api/favourites and
  // backend/server.js. No new planning or approval happens on replay: the
  // human already approved this exact resolved action when it was favourited.
  const favouritesSidebar = createFavouritesSidebar({
    onRun: (id) => handleFavouriteRun(id),
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
    } catch (err) {
      console.error(err)
    } finally {
      inFlight.delete(itemId)
    }
  }

  async function handleFavouriteRun(favouriteId) {
    if (inFlight.has(favouriteId)) return
    inFlight.add(favouriteId)
    favouritesSidebar.setRunning(favouriteId, true)
    try {
      const item = await runFavourite(favouriteId)
      inbox.addItem(item) // shows up in the resolved section, same as any other capture
      updateStats()
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
    onSubmit: async (text, house) => {
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

      try {
        const saved = await postCapture(text, house)
        // Replace optimistic item with the real one — saved.id is the
        // server-assigned id, different from optimistic.id, so the lookup
        // needs to match on the old id while storing/rendering the new one.
        inbox.updateItem(saved, optimistic.id)
        updateStats()

        // Poll for resolution (backend processes async)
        pollForResolution(saved.id)
      } catch (err) {
        inbox.updateItem({ ...optimistic, status: 'failed', action_result: 'Failed to reach server.' }, optimistic.id)
        updateStats()
        console.error(err)
      }
    }
  })

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

  const layout = document.createElement('div')
  layout.className = 'layout'
  layout.append(favouritesSidebar.el, main)

  app.append(header, layout, stats, versionInfo.footerEl)
  loadItems()
  loadVersion()
  loadSatellites()
  loadFavourites()
}
