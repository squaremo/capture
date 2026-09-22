import { icon } from './icons.js'

const STORAGE_KEY = 'captureHouse'

// Hard cap on a whisper-stream hold — this is a quick-capture tool, not
// dictation, and Whisper's encoder has its own fixed 30s window per call
// regardless; stopping well inside that (rather than anywhere near it)
// means a capture never gets silently truncated. See the "how many
// seconds can the model reasonably deal with" design discussion.
const WHISPER_MAX_RECORD_MS = 25_000

// defaultHouse comes from runtime config (see config.js) — which house
// this deployment "is," empty for the general frontend, set when a
// satellite is the one serving this page.
//
// hideHouseChooser: the station passes this — see STATIONS_AND_CONTROLS.md
// §4. On a wall panel the station is wherever you are standing, so there's
// nothing to choose and the picker just invites "what happens if I pick
// Hall?" (reachability of other houses is the header's stations band, not
// this). The routing this chooser exists for still has to happen though —
// a capture still needs tagging with the right house — so setHouses()
// below keeps computing houseSelect's value exactly as before; this flag
// only ever suppresses *showing* the row.
// voiceMode: 'webspeech' (default) or 'whisper-stream' — from runtime
// config's GET /config.json (see config.js), driven by whether the
// satellite's own WHISPER_URL is set (satellite/server.js). 'webspeech'
// is the only mode on the general/laptop deployment, which has no
// /config.json at all. See designs/satellite-hardware.md's "Voice input:
// three modes" — webspeech is click-to-toggle against the browser's own
// cloud speech engine; whisper-stream is hold-to-record against this
// satellite's local whisper.cpp pipeline, audio never leaving the box.
export function createCaptureInput({ onSubmit, defaultHouse, hideHouseChooser = false, voiceMode = 'webspeech' }) {
  const section = document.createElement('section')
  section.className = 'capture'

  const label = document.createElement('div')
  label.className = 'capture-label'
  label.textContent = 'new capture'

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

  // Clear sits at the far left of the row under the field — away from
  // send, so a thumb reaching for one never lands on the other. Disabled
  // while there's nothing to clear.
  const clearBtn = document.createElement('button')
  clearBtn.className = 'btn-clear'
  clearBtn.setAttribute('aria-label', 'Clear')
  clearBtn.title = 'clear'
  clearBtn.innerHTML = icon('delete', 22)
  clearBtn.disabled = true

  const buttonGroup = document.createElement('div')
  buttonGroup.className = 'button-group'

  const voiceBtn = document.createElement('button')
  voiceBtn.className = 'btn-voice'
  voiceBtn.setAttribute('aria-label', 'Voice input')
  voiceBtn.innerHTML = micIcon()

  const submitBtn = document.createElement('button')
  submitBtn.className = 'btn-submit'
  submitBtn.innerHTML = `${icon('send', 20)}<span>send</span>`

  const hint = document.createElement('span')
  hint.className = 'capture-hint'
  hint.textContent = navigator.platform.includes('Mac') ? '⌘↵' : 'ctrl↵'
  hint.title = 'send'

  buttonGroup.append(hint, voiceBtn, submitBtn)
  controls.append(clearBtn, houseRow, buttonGroup)
  section.append(label, textarea, controls)

  // ⌘↵ / Ctrl↵ to submit
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      submit()
    }
  })

  submitBtn.addEventListener('click', submit)

  textarea.addEventListener('input', updateClear)
  clearBtn.addEventListener('click', () => {
    textarea.value = ''
    updateClear()
    textarea.focus()
  })

  if (voiceMode === 'whisper-stream') setupWhisperStream()
  else setupWebSpeech()

  // Click-to-toggle against the browser's own SpeechRecognition — audio
  // goes to Chrome's cloud speech service, entirely outside this app.
  // The only mode on a non-satellite deployment; see the module doc
  // comment above.
  function setupWebSpeech() {
    let recognition = null
    if ('webkitSpeechRecognition' in window || 'SpeechRecognition' in window) {
      const SR = window.SpeechRecognition || window.webkitSpeechRecognition
      recognition = new SR()
      recognition.continuous = false
      recognition.interimResults = false
      recognition.lang = 'en-US'

      recognition.onresult = (e) => {
        textarea.value = e.results[0][0].transcript
        updateClear()
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
  }

  // Hold-to-record against this satellite's own local whisper.cpp
  // pipeline — POST /api/transcribe (relative: same origin as this page,
  // since whisper-stream only ever gets selected when a satellite is
  // serving the frontend, see the module doc comment). A fresh
  // getUserMedia stream per press, stopped again on release, rather than
  // one held open for the input's whole lifetime — a Pi's mic-active
  // indicator (if the WM8960 HAT ever gets one) shouldn't stay lit
  // between captures. Pointer events, not mouse/touch separately, so one
  // set of handlers covers both the kiosk touchscreen and a mouse during
  // dev testing.
  function setupWhisperStream() {
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
      voiceBtn.disabled = true
      voiceBtn.title = 'Microphone capture not supported in this browser'
      return
    }

    let recorder = null
    let chunks = []
    let stream = null
    let autoStopTimer = null
    let pointerId = null

    voiceBtn.title = 'Hold to record'

    voiceBtn.addEventListener('pointerdown', async (e) => {
      if (recorder) return // already recording (e.g. a second finger)
      e.preventDefault()
      pointerId = e.pointerId
      voiceBtn.setPointerCapture(pointerId)

      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      } catch (err) {
        console.error('Microphone access failed:', err)
        voiceBtn.title = 'Microphone access failed — check permissions'
        return
      }

      chunks = []
      recorder = new MediaRecorder(stream)
      recorder.ondataavailable = (evt) => { if (evt.data.size > 0) chunks.push(evt.data) }
      recorder.onstop = handleStop
      recorder.start()
      voiceBtn.classList.add('recording')
      autoStopTimer = setTimeout(stopRecording, WHISPER_MAX_RECORD_MS)
    })

    voiceBtn.addEventListener('pointerup', stopRecording)
    voiceBtn.addEventListener('pointercancel', stopRecording)

    function stopRecording() {
      if (!recorder) return
      clearTimeout(autoStopTimer)
      if (pointerId !== null) {
        try { voiceBtn.releasePointerCapture(pointerId) } catch { /* already released */ }
        pointerId = null
      }
      recorder.stop()
    }

    async function handleStop() {
      voiceBtn.classList.remove('recording')
      stream.getTracks().forEach((t) => t.stop())
      const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' })
      recorder = null
      chunks = []
      if (blob.size === 0) return // tap with no hold — nothing recorded

      voiceBtn.classList.add('transcribing')
      try {
        const res = await fetch('/api/transcribe', {
          method: 'POST',
          headers: { 'Content-Type': 'audio/webm' },
          body: blob,
        })
        const data = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(data.error || `transcribe failed: ${res.status}`)
        textarea.value = data.text
        updateClear()
        textarea.focus()
      } catch (err) {
        console.error('Transcription failed:', err)
        voiceBtn.title = 'Transcription failed — try again'
      } finally {
        voiceBtn.classList.remove('transcribing')
      }
    }
  }

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

  function updateClear() {
    clearBtn.disabled = textarea.value === ''
  }

  function submit() {
    const text = textarea.value.trim()
    if (!text) return
    onSubmit(text, houseSelect.value || undefined)
    textarea.value = ''
    updateClear()
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
    houseRow.hidden = hideHouseChooser || !hasHouses
    controls.classList.toggle('capture-controls--with-house', hasHouses && !hideHouseChooser)
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
