export function createCaptureInput({ onSubmit }) {
  const section = document.createElement('section')
  section.className = 'capture'

  const textarea = document.createElement('textarea')
  textarea.placeholder = 'capture a thought…'
  textarea.rows = 3
  textarea.autofocus = true

  const controls = document.createElement('div')
  controls.className = 'capture-controls'

  const voiceBtn = document.createElement('button')
  voiceBtn.className = 'btn-voice'
  voiceBtn.setAttribute('aria-label', 'Voice input')
  voiceBtn.innerHTML = micIcon()

  const submitBtn = document.createElement('button')
  submitBtn.className = 'btn-submit'
  submitBtn.textContent = 'capture'

  controls.append(voiceBtn, submitBtn)
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

  function submit() {
    const text = textarea.value.trim()
    if (!text) return
    onSubmit(text)
    textarea.value = ''
    textarea.focus()
  }

  return section
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
