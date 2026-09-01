const STORAGE_KEY = 'captureHouse'

// defaultHouse comes from runtime config (see config.js) — which house
// this deployment "is," empty for the general frontend, set when a
// satellite is the one serving this page.
export function createCaptureInput({ onSubmit, defaultHouse }) {
  const section = document.createElement('section')
  section.className = 'capture'

  const textarea = document.createElement('textarea')
  textarea.placeholder = 'capture a thought…'
  textarea.rows = 3
  textarea.autofocus = true

  const controls = document.createElement('div')
  controls.className = 'capture-controls'

  // ── House chooser ────────────────────────────────────────
  // Hidden until setHouses() is told about at least one configured house
  // (GET /api/satellites) — most deployments have none, and there's no
  // reason to show a picker with nothing to pick.
  const houseRow = document.createElement('div')
  houseRow.className = 'house-row'
  houseRow.hidden = true

  const houseDot = document.createElement('span')
  houseDot.className = 'house-dot'
  houseDot.title = 'this is where you are'
  houseDot.hidden = true

  const houseSelect = document.createElement('select')
  houseSelect.className = 'house-select'
  houseSelect.setAttribute('aria-label', 'House')

  houseRow.append(houseDot, houseSelect)

  const buttonGroup = document.createElement('div')
  buttonGroup.className = 'button-group'

  const voiceBtn = document.createElement('button')
  voiceBtn.className = 'btn-voice'
  voiceBtn.setAttribute('aria-label', 'Voice input')
  voiceBtn.innerHTML = micIcon()

  const submitBtn = document.createElement('button')
  submitBtn.className = 'btn-submit'
  submitBtn.textContent = 'capture'

  buttonGroup.append(voiceBtn, submitBtn)
  controls.append(houseRow, buttonGroup)
  section.append(textarea, controls)

  // ⌘↵ / Ctrl↵ to submit
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      submit()
    }
  })

  submitBtn.addEventListener('click', submit)

  // Voice via Web Speech API
  let recognition = null
  if ('webkitSpeechRecognition' in window || 'SpeechRecognition' in window) {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition
    recognition = new SR()
    recognition.continuous = false
    recognition.interimResults = false
    recognition.lang = 'en-US'

    recognition.onresult = (e) => {
      textarea.value = e.results[0][0].transcript
      voiceBtn.classList.remove('recording')
      textarea.focus()
    }
    recognition.onend = () => voiceBtn.classList.remove('recording')
    recognition.onerror = () => voiceBtn.classList.remove('recording')
  } else {
    voiceBtn.disabled = true
    voiceBtn.title = 'Speech recognition not supported in this browser'
  }

  voiceBtn.addEventListener('click', () => {
    if (!recognition) return
    if (voiceBtn.classList.contains('recording')) {
      recognition.stop()
    } else {
      voiceBtn.classList.add('recording')
      recognition.start()
    }
  })

  houseSelect.addEventListener('change', () => {
    updateHouseDot()
    // Only persist a sticky choice when this deployment has no default —
    // when it does, the default should win again next load (it describes
    // where this box physically is); a change here is just for this capture.
    if (!defaultHouse) {
      try { localStorage.setItem(STORAGE_KEY, houseSelect.value) } catch {}
    }
  })

  function updateHouseDot() {
    houseDot.hidden = !(defaultHouse && houseSelect.value === defaultHouse)
  }

  function submit() {
    const text = textarea.value.trim()
    if (!text) return
    onSubmit(text, houseSelect.value || undefined)
    textarea.value = ''
    textarea.focus()
  }

  // satellites: [{ house, ... }] from GET /api/satellites
  function setHouses(satellites) {
    houseSelect.innerHTML = ''

    const blank = document.createElement('option')
    blank.value = ''
    blank.textContent = '—'
    houseSelect.appendChild(blank)

    satellites.forEach(({ house, reachable, houseMismatch }) => {
      const opt = document.createElement('option')
      opt.value = house
      // Native <select> options can't reliably carry colour or a styled dot
      // across platforms (mobile pickers in particular ignore most CSS), so
      // liveness is a text glyph instead — same three states as the
      // satellite-dot in the info panel (up / mismatch / unreachable).
      const glyph = houseMismatch ? '▲' : reachable ? '●' : '○'
      opt.textContent = `${glyph} ${house}`
      opt.title = houseMismatch ? 'house name mismatch' : reachable ? 'reachable' : 'unreachable'
      houseSelect.appendChild(opt)
    })

    const hasHouses = satellites.length > 0
    houseRow.hidden = !hasHouses
    controls.classList.toggle('capture-controls--with-house', hasHouses)
    if (!hasHouses) return

    const known = new Set(satellites.map(s => s.house))
    let sticky = ''
    try { sticky = localStorage.getItem(STORAGE_KEY) ?? '' } catch { /* ignore */ }

    const initial = defaultHouse && known.has(defaultHouse)
      ? defaultHouse
      : (known.has(sticky) ? sticky : '')

    houseSelect.value = initial
    updateHouseDot()
  }

  return { el: section, setHouses }
}

function micIcon() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
    <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
    <line x1="12" y1="19" x2="12" y2="23"/>
    <line x1="8" y1="23" x2="16" y2="23"/>
  </svg>`
}
