// The Piper pipeline, factored out of server.js so it can be
// unit-invoked/tested on its own — mirrors whisper/transcribe.js's
// shape for the opposite direction. One external process, not an npm
// package (see the Dockerfile for how it gets onto the image): Piper
// itself, fed text on stdin, writing a WAV file we read back. Unverified
// against real Pi hardware yet (see designs/satellite-hardware.md's Open
// questions) — this is the software side of the pipeline, written and
// buildable, not yet confirmed against a real playback.

import { spawn } from 'child_process'
import { mkdtemp, readdir, readFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

const PIPER_BIN = process.env.PIPER_BIN_PATH ?? 'piper'
const MODELS_DIR = process.env.PIPER_MODELS_DIR ?? '/app/models'
// The image bakes in a curated handful of voices (see the Dockerfile's
// PIPER_VOICES build arg), not just one — this picks the default among
// them at runtime, overridable per-request (see synthesize()'s `voice`
// param and POST /synthesize in server.js) without a rebuild.
const DEFAULT_VOICE = process.env.PIPER_VOICE ?? 'en_GB-alan-medium'

// Every voice baked into the image is a <name>.onnx + <name>.onnx.json
// pair sitting side by side in MODELS_DIR — this is what GET /voices
// (server.js) reports, and what a bad `voice` param gets checked
// against rather than being handed straight to Piper and failing
// opaquely.
export async function listVoices() {
  let entries
  try {
    entries = await readdir(MODELS_DIR)
  } catch {
    return []
  }
  return entries.filter((f) => f.endsWith('.onnx')).map((f) => f.slice(0, -'.onnx'.length)).sort()
}

// text: the string to speak (an item's action_result, typically a
// sentence or two — see frontend/src/speech.js). voice: an id from
// listVoices(), defaulting to PIPER_VOICE/DEFAULT_VOICE. Returns a
// Buffer of WAV audio, or throws on any pipeline failure (unknown
// voice, empty text, Piper erroring) — server.js turns that into a 422.
export async function synthesize(text, voice = DEFAULT_VOICE) {
  const trimmed = (text ?? '').trim()
  if (!trimmed) {
    throw new Error('no text to synthesize')
  }

  const available = await listVoices()
  if (available.length > 0 && !available.includes(voice)) {
    throw new Error(`unknown voice "${voice}" — available: ${available.join(', ')}`)
  }
  const modelPath = join(MODELS_DIR, `${voice}.onnx`)

  const dir = await mkdtemp(join(tmpdir(), 'capture-tts-'))
  const outPath = join(dir, 'out.wav')
  try {
    await run(PIPER_BIN, ['--model', modelPath, '--output_file', outPath], trimmed)
    return await readFile(outPath)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

function run(bin, args, stdinText) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args)
    let stderr = ''
    child.stderr.on('data', (d) => { stderr += d })
    child.on('error', (err) => {
      reject(new Error(`${bin} failed to start: ${err.message}`))
    })
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${bin} exited ${code}: ${stderr.trim()}`))
    })
    child.stdin.write(stdinText)
    child.stdin.end()
  })
}
