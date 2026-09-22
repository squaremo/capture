// Keeps a wall-mounted station on the latest build without anyone having
// to restart Chromium. A kiosk page never navigates, so the browser never
// gets its usual cue to check for a new service worker — left alone it
// runs whatever build it booted with, indefinitely.
//
// So check at the moment nobody can see a reload happen: when the panel
// goes dark. That's swayidle's call (infra/cloud-init-satellite.yaml.tpl —
// backlight off after 30s with no input), which the page can't observe
// directly, but the kiosk is fullscreen so the input swayidle watches is
// the input this page gets; the same 30s of silence here lands on the
// same moment. The check itself is local — reg.update() re-fetches sw.js
// from whatever served this page, i.e. the satellite's own nginx, which
// Watchtower keeps on the latest frontend image.
//
// The service worker is autoUpdate (vite.config.js: skipWaiting +
// clientsClaim), so a new one takes control by itself once installed;
// all that's left here is reloading onto it — and only while the station
// is at rest (isSafeToReload), never mid-capture or mid-review.
const IDLE_MS = 30_000
const INPUT_EVENTS = ['pointerdown', 'keydown', 'input', 'wheel']

export function watchForStationUpdates({ isSafeToReload }) {
  if (!('serviceWorker' in navigator)) return

  // No controller at load means this is the first install, whose
  // clientsClaim() also fires controllerchange — that's not a new build.
  const hadController = !!navigator.serviceWorker.controller
  let updateReady = false
  let idle = false
  let idleTimer = null

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController) return
    updateReady = true
    maybeReload()
  })

  function maybeReload() {
    if (updateReady && idle && isSafeToReload()) location.reload()
  }

  async function onIdle() {
    idle = true
    if (updateReady) return maybeReload()
    try {
      const reg = await navigator.serviceWorker.getRegistration()
      await reg?.update()
    } catch {
      // Offline or nginx mid-restart — try again next time the panel sleeps.
    }
  }

  function onInput() {
    idle = false
    clearTimeout(idleTimer)
    idleTimer = setTimeout(onIdle, IDLE_MS)
  }

  INPUT_EVENTS.forEach((type) => document.addEventListener(type, onInput, { capture: true, passive: true }))
  onInput()
}
