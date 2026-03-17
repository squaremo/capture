# Testing plan

## Framework

**Vitest** — the project uses `"type": "module"` (native ESM), and Vitest works with
that out of the box. Jest requires extra transform config for ESM.

---

## Test layers

### 1. Unit tests — `db.js`

Run against an in-memory SQLite DB (`':memory:'`) so tests are fast and leave no
files on disk.

- `createItem` generates a valid ID, stores text, returns `pending` status with empty tags
- `getItem` returns `null` for an unknown ID
- `listItems` filters by status correctly and orders newest-first
- `updateItem` only changes the fields that are provided; tags round-trip correctly
  as an array (stored as JSON, returned as array)

### 2. Unit tests — `integrations/claude.js`

Mock `@anthropic-ai/sdk` so no real API calls are made.

- Each tool name maps to the right status:
  - `save_to_inbox` → `triaged`
  - `create_reminder` → `reminder`
  - `flag_urgent` → `urgent`
- `tags` and `action_result` are extracted from tool input
- Missing/empty tool input falls back gracefully (empty tags, default action_result)
- API errors propagate as thrown exceptions (so server.js can catch and set `failed`)

### 3. Integration tests — `server.js` routes

Spin up Fastify in test mode with an in-memory DB and a mocked Claude integration.
Tests cover the full HTTP layer including validation and error responses.

**POST /api/capture**
- 400 on missing `text`
- 400 on empty string
- 201 with a `pending` item returned immediately
- Background Claude processing resolves the item (poll `GET /api/items/:id` to verify)

**GET /api/items**
- Returns all items
- Filters correctly with `?status=pending`, `?status=triaged`, etc.

**GET /api/items/:id**
- Returns the item for a known ID
- 404 for an unknown ID

**PATCH /api/items/:id**
- Updates only the provided fields
- 404 for an unknown ID

**Tailscale allowlist**
- When `TAILSCALE_SUBNET` is set, requests from outside the subnet get 403
- Requests from within the subnet pass through

---

## CI workflow — `test.yml`

New GitHub Actions workflow that runs on every push to every branch:

```
on:
  push:
    branches: ['**']
    paths:
      - 'backend/**'
      - '.github/workflows/test.yml'
```

Steps:
1. Checkout
2. Set up Node 22
3. `npm ci` (installs dev deps)
4. `npm test`

The existing `build.yml` stays separate (runs on `main` only). Once tests are
wired up we can optionally make `build.yml` depend on `test.yml` passing, but
that's not required immediately.

---

## What's not covered (yet)

- **Frontend**: the current `frontend/index.html` is a single-file prototype with
  no build step, so there's nothing to unit test there. Once the frontend is
  connected to the backend, Playwright or Cypress end-to-end tests would be the
  natural next step.
- **Deploy smoke test**: a post-deploy health check hitting `GET /api/items` via
  Tailscale would be useful but is out of scope for this plan.
