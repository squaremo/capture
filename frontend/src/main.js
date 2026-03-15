import './styles.css'
import { createCaptureInput } from './components/capture.js'
import { createInbox } from './components/inbox.js'
import { postCapture, getItems } from './api.js'

const app = document.getElementById('app')

// ── Header ────────────────────────────────────────────────
const header = document.createElement('header')
const logo = document.createElement('span')
logo.className = 'logo'
logo.textContent = 'capture'

const vpnBadge = document.createElement('span')
vpnBadge.className = 'vpn-badge'
vpnBadge.textContent = 'tailscale'
header.append(logo, vpnBadge)

// ── Inbox ─────────────────────────────────────────────────
const inbox = createInbox()

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
      // Replace optimistic item with real one
      inbox.updateItem({ ...optimistic, ...saved })
      updateStats()

      // Poll for resolution (backend processes async)
      pollForResolution(saved.id)
    } catch (err) {
      inbox.updateItem({ ...optimistic, status: 'failed', action_result: 'Failed to reach server.' })
      updateStats()
      console.error(err)
    }
  }
})

// ── Poll until item leaves pending state ──────────────────
function pollForResolution(id, attempts = 0) {
  if (attempts > 10) return
  const delay = Math.min(500 * (attempts + 1), 3000)
  setTimeout(async () => {
    try {
      const res = await fetch(`/api/items/${id}`)
      if (!res.ok) return
      const item = await res.json()
      inbox.updateItem(item)
      updateStats()
      if (item.status === 'pending') pollForResolution(id, attempts + 1)
    } catch {
      pollForResolution(id, attempts + 1)
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

// ── Assemble ──────────────────────────────────────────────
app.append(header, captureInput, inbox.el, stats)
loadItems()
