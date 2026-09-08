import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll } from 'vitest'

// A fresh temp directory per test file (vitest's default isolation gives
// each file its own module instance, so store.js re-reads this at import
// time) — deliberately a plain directory, not a git repo, so store.js's
// GIT_ENABLED check is false and no test here ever touches the real git
// binary. See designs/file-backed-storage.md's Testing section.
const dataPath = mkdtempSync(join(tmpdir(), 'capture-test-'))
process.env.DATA_PATH = dataPath

afterAll(() => rmSync(dataPath, { recursive: true, force: true }))
