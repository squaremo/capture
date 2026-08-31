import './styles.css'
import { createCaptureInput } from './components/capture.js'
import { createInbox } from './components/inbox.js'
import { createVersionInfo } from './components/versionInfo.js'
import { postCapture, getItems, approveItem, vetoItem, getVersion } from './api.js'

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
const inFlight = new Set() // item ids currently being approved/vetoed

const inbox = createInbox({
  onApprove: (id) => handleDecision(id, approveItem),
  onVeto: (id) => handleDecision(id, vetoItem),
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

// ── Stats footer ──────────────────────────────────────────
const stats = document.createElement('footer')
stats.className = 'stats'

function updateStats() {
  stats.textContent = `${inbox.itemCount} items · ${inbox.pendingCount} pending`
}

// ── Capture input ─────────────────────────────────────────
const captureInput = createCaptureInput({
  onSubmit: async (text) => {
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
      const saved = await postCapture(text)
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
      const res = await fetch(`/api/items/${id}`)
      if (!res.ok) return pollForResolution(id, attempts + 1, lastProgress)
      const item = await res.json()
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

// ── Assemble ──────────────────────────────────────────────
app.append(header, captureInput, inbox.el, stats, versionInfo.footerEl)
loadItems()
loadVersion()
