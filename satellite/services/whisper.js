// Thin HTTP client for the separate, optional `whisper/` service (see
// ../../whisper/server.js and docker-compose.satellite.yml's `whisper`
// entry) — this satellite never runs whisper.cpp/ffmpeg itself, so a
// satellite with no mic hardware, or one that just hasn't opted in yet,
// never pulls any of that. Set WHISPER_URL once the whisper service is
// running (default http://127.0.0.1:5001 under docker-compose, since
// both containers share the host network namespace — see
// docker-compose.satellite.yml) to enable the whisper-stream voice-input
// mode. See designs/satellite-hardware.md's "Voice input: three modes".

const WHISPER_URL = process.env.WHISPER_URL || null

export function isConfigured() {
  return Boolean(WHISPER_URL)
}

// audioBuffer: raw bytes of whatever the browser's MediaRecorder produced
// (webm/opus from Chromium) — see frontend/src/components/capture.js's
// whisper-stream mode. Returns the transcript as a trimmed string, or
// throws (network failure, or the whisper service's own pipeline error)
// — the caller (POST /api/transcribe) turns that into a 422.
export async function transcribe(audioBuffer) {
  if (!isConfigured()) {
    throw new Error('whisper not configured on this satellite (WHISPER_URL unset)')
  }
  let res
  try {
    res = await fetch(`${WHISPER_URL}/transcribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'audio/webm' },
      body: audioBuffer,
    })
  } catch (err) {
    throw new Error(`could not reach whisper service at ${WHISPER_URL}: ${err.message}`)
  }
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(data.error || `whisper service returned ${res.status}`)
  }
  if (!data.text) {
    throw new Error('whisper service produced no transcript')
  }
  return data.text
}
