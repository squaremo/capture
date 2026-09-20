// The actual whisper.cpp pipeline, factored out of server.js so it can be
// unit-invoked/tested on its own. Two external processes, not npm
// packages — see the Dockerfile for how they get onto the image:
// ffmpeg transcodes whatever MediaRecorder produced (webm/opus in
// Chromium) into the 16kHz mono s16le WAV whisper.cpp's CLI expects, then
// the whisper.cpp binary transcribes that WAV and we read its stdout
// back. Unverified against real Pi hardware yet (see designs/
// satellite-hardware.md's Open questions) — this is the software side of
// the pipeline, written and buildable, not yet confirmed against a live
// mic capture.

import { spawn } from 'child_process'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

const FFMPEG_BIN = process.env.FFMPEG_BIN_PATH ?? 'ffmpeg'
const WHISPER_BIN = process.env.WHISPER_BIN_PATH ?? 'whisper-cli'
const WHISPER_MODEL_PATH = process.env.WHISPER_MODEL_PATH ?? '/app/models/ggml-tiny.en.bin'
// English-only `tiny` is the design's starting point — see the "Local
// whisper" RAM/CPU discussion: base is roughly 2x tiny's footprint on a
// Pi 4 2GB that's already running a Chromium kiosk. Swap the baked-in
// model file (see the Dockerfile) to try a bigger one.
const WHISPER_LANG = process.env.WHISPER_LANG ?? 'en'

// audioBuffer: raw bytes of whatever the browser's MediaRecorder produced
// (webm/opus from Chromium) — see frontend/src/components/capture.js's
// whisper-stream mode. Returns the transcript as a trimmed string, or
// throws on any pipeline failure (ffmpeg bad input, whisper.cpp missing
// model, empty result) — server.js turns that into a 422.
export async function transcribe(audioBuffer) {
  if (!audioBuffer?.length) {
    throw new Error('no audio received')
  }

  const dir = await mkdtemp(join(tmpdir(), 'capture-whisper-'))
  const inPath = join(dir, 'in')
  const wavPath = join(dir, 'out.wav')
  try {
    await writeFile(inPath, audioBuffer)
    await run(FFMPEG_BIN, ['-y', '-i', inPath, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wavPath])

    // -nt: no timestamps — we only want the words. -otxt/-of would write a
    // sibling .txt file instead; stdout is simpler to consume directly and
    // needs no extra cleanup.
    const { stdout } = await run(WHISPER_BIN, [
      '-m', WHISPER_MODEL_PATH,
      '-f', wavPath,
      '-l', WHISPER_LANG,
      '-nt',
    ])
    const text = stdout.trim()
    if (!text) throw new Error('whisper.cpp produced no transcript')
    return text
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

function run(bin, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args)
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stderr += d })
    child.on('error', (err) => {
      reject(new Error(`${bin} failed to start: ${err.message}`))
    })
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr })
      else reject(new Error(`${bin} exited ${code}: ${stderr.trim() || stdout.trim()}`))
    })
  })
}
