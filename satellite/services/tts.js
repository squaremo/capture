// Thin HTTP client for the separate, optional `tts` service (see
// ../../tts/server.js and docker-compose.satellite.yml's `tts` entry) —
// this satellite never runs Piper itself, mirrors services/whisper.js's
// shape for the opposite direction (text in, audio out). Set TTS_URL
// once the tts service is running (default http://127.0.0.1:5002 under
// docker-compose, since both containers share the host network
// namespace) to enable local speech playback. See designs/
// satellite-hardware.md's playback design.

const TTS_URL = process.env.TTS_URL || null

export function isConfigured() {
  return Boolean(TTS_URL)
}

// text: what to speak. voice: optional, one of the ids GET /voices on
// the tts service lists — omitted, that service picks its own default
// (PIPER_VOICE). Returns a Buffer of WAV audio, or throws (network
// failure, or the tts service's own pipeline error) — the caller
// (POST /api/speak) turns that into a 422.
export async function synthesize(text, voice) {
  if (!isConfigured()) {
    throw new Error('tts not configured on this satellite (TTS_URL unset)')
  }
  let res
  try {
    res = await fetch(`${TTS_URL}/synthesize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, voice }),
    })
  } catch (err) {
    throw new Error(`could not reach tts service at ${TTS_URL}: ${err.message}`)
  }
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    throw new Error(data.error || `tts service returned ${res.status}`)
  }
  return Buffer.from(await res.arrayBuffer())
}
