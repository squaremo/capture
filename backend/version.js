import { readFileSync } from 'fs'

// Baked into the image at build time (see Dockerfile ARG/ENV and
// .github/workflows/build.yml) — unset locally, so 'dev' is what you see
// running the backend outside Docker.
export const BACKEND_VERSION = process.env.GIT_SHA ?? 'dev'

// Deployed config (docker-compose.yml, infra/production.env) follows a
// separate path from the image build — capture-sync.timer pulls it
// straight from git — so its version can't be baked in at build time.
// capture-sync writes the commit it last synced to here, into the same
// volume the backend already uses for its database (see DB_PATH/'/data').
const CONFIG_VERSION_PATH = process.env.CONFIG_VERSION_PATH ?? '/data/config-version'

// Null when nothing has been synced yet (e.g. brand-new server, before
// capture-sync's first run) or when running outside that deploy setup.
export function getConfigVersion() {
  try {
    return readFileSync(CONFIG_VERSION_PATH, 'utf8').trim() || null
  } catch {
    return null
  }
}
