# capture · personal quick-capture app

## what this is

A self-hosted, privacy-first note and task capture tool. Optimised for zero-friction input from phone, laptop, or a dedicated home station. Accessible only over Tailscale (no public internet exposure).

The core idea: get a thought out of your head and into the system in under 5 seconds, then deal with it later — or have the app act on it immediately (e.g. create a calendar reminder).

## current state

**Frontend** (`frontend/`) — Vite-built PWA, deployed and connected to the live backend:

- Modular components: `capture.js` (input), `inbox.js` (list/filters), `item.js` (row rendering)
- `api.js` calls the real backend (`postCapture`, `getItems`, `patchItem`) — no mock/in-memory state
- `vite-plugin-pwa` generates the manifest and service worker at build time (installable to home screen); manifest icons are still placeholders — not yet added
- Dark utilitarian aesthetic (monospaced Berkeley Mono + Fraunces serif, acid green accent `#c8f060`)
- Textarea capture input with ⌘↵ keyboard shortcut and voice via Web Speech API
- **Optimistic UI**: item appears instantly in inbox with a `pending` state + shimmer bar, then resolves in-place ~1.5s later with what was done
- Item states: `pending` → `triaged` / `reminder` / `urgent` / `acted` / `failed`
- Each resolved item shows a coloured result strip with a natural-language description of the action taken (e.g. "Calendar event created: 'Call dentist' — Tomorrow, 9:00am")
- Filter tabs: All / Pending / Acted / Done
- Stats footer, grain texture overlay, VPN status badge

**Backend** (`backend/`) — Fastify + SQLite, deployed and running:

- `POST /api/capture`, `GET /api/items`, `GET /api/items/:id`, `PATCH /api/items/:id`
- Optimistic flow: item saved immediately as `pending`, Claude processes in background and resolves it
- Claude intent detection via tool calling (`save_to_inbox` → `triaged`, `create_reminder` → `reminder`, `flag_urgent` → `urgent`) — these three are pure classification, no external side effect
- **`create_linear_task` → `acted`** — the first tool that actually does something external (creates a real Linear issue via their GraphQL API); only offered to Claude when `LINEAR_API_KEY`/`LINEAR_TEAM_ID` are both set, so it's opt-in
- Tailscale IP allowlist middleware (optional via `TAILSCALE_SUBNET` env var)
- Persisted to SQLite (`better-sqlite3`); DB path via `DB_PATH` env var
- `backend/secrets.js`: any secret env var's value can be a literal, or an `op://vault/item/field` reference resolved at startup via a 1Password Service Account (needs `OP_SERVICE_ACCOUNT_TOKEN`) — falls back to reading the literal value when that token isn't set, so 1Password is optional at the code level
- Deployed config is split: `infra/production.env` (committed — `op://` refs and non-secret values, delivered by `capture-sync.timer`'s git pull) + `/opt/capture/.env.secret` (not in git, written once by cloud-init, holds only `OP_SERVICE_ACCOUNT_TOKEN`) — the server itself only ever receives that one secret directly

**Infrastructure** — running on Hetzner, server created manually (no Terraform — that was tried and abandoned; may revisit later):

- Server provisioned by hand via the Hetzner Cloud Console; configures itself on first boot from `infra/cloud-init.yaml.tpl` pasted in as user-data (Docker, Tailscale join, TLS cert, clone repo, start app, create a non-root `admin` user with SSH key + passwordless sudo — root SSH stays key-less/unusable on purpose)
- SSH access is `ssh admin@<server>.<tailnet>.ts.net` (over Tailscale, no port 22 firewall rule needed) + `sudo -i`; the Hetzner browser Console is fallback-only — it can't reliably paste, so it's unusable for typing real secrets
- Docker Compose runs backend + nginx (serving the built frontend) + Watchtower
- `build.yml` / `build-frontend.yml` push new images to GHCR on changes to `backend/**` / `frontend/**`
- **Watchtower** (in compose) polls GHCR every 5 min and auto-updates `backend`/`nginx` when their image changes — no SSH deploy step
- **`capture-sync` systemd timer** on the server (`infra/install-capture-sync.sh` installs it on existing boxes) pulls `main` and reconciles `docker-compose.yml` every 5 min — catches compose/config changes Watchtower can't see
- `rollback.yml` re-points GHCR's `:latest` at an older `:sha-<commit>` build (manual dispatch) — no server access needed

## stack

- **Frontend**: Vite + `vite-plugin-pwa`, built into a static bundle served by nginx
- **Backend**: Node.js with Fastify + SQLite (`better-sqlite3`)
- **Intent detection**: Claude API with tool calling (server-side)
- **Calendar integration**: Google Calendar API or CalDAV — not yet implemented
- **Voice (home station)**: Raspberry Pi + microphone, local transcription via `whisper.cpp` — not yet implemented
- **Access**: Tailscale only — no auth layer needed beyond Tailscale identity; allowlist by Tailscale IP at the server level
- **Hosting**: Hetzner VM, Docker Compose, nginx, GHCR for images

## repo structure (target)

```
capture/
├── frontend/
│   ├── index.html         # the existing prototype
│   ├── manifest.json      # PWA manifest
│   └── sw.js              # service worker
├── backend/
│   ├── server.js          # Fastify API server
│   ├── db.js              # SQLite setup
│   └── integrations/
│       └── calendar.js    # Google/CalDAV connector
├── station/
│   └── wakeword.py        # Raspberry Pi always-on voice
├── docker-compose.yml
├── .env.example
├── .gitignore
└── README.md
```

## design principles

- **Speed above all**: the capture input must be instant and always focused
- **Privacy**: everything self-hosted, Tailscale-only, no third-party analytics
- **Act or triage**: items either go to inbox for later review, or trigger an immediate action (calendar entry)
- **Cross-device**: works well on mobile browser, desktop browser, and a dedicated kiosk-style home station

## next steps

See `TODO.md` for the current list.

## architecture decisions

- **Intent detection is server-side via Claude API + tool calling** — not client-side regex. The frontend sends the raw text to the backend, which calls Claude with a set of tools (`save_to_inbox`, `create_reminder`, `flag_urgent`). Claude decides which tool to call and writes the human-readable `action_result` string. This means intent logic is easy to tune via system prompt, not code.
- **Async with optimistic UI** — the capture is saved immediately (pending state), LLM processes in background (~1-2s), item resolves in-place. User never waits on a spinner.
- **Claude API runs on Anthropic's infrastructure** — the VM stays lightweight. Only the backend makes outbound calls to the Claude API. API key never touches the frontend.
- **Web Speech API for mobile/desktop voice** — routes through Google's speech service (Chrome). Acceptable tradeoff for convenience. Home station uses local `whisper.cpp` instead for full privacy.
- **PWA, not native app** — same codebase across phone, laptop, kiosk. Installable to home screen. Voice works on Android Chrome.
- **Tailscale for access control** — no public ports, no login screen. Backend middleware checks that requests originate from a Tailscale IP.

## working conventions

- **Always branch from `main`** — each piece of work gets its own branch off `main`, not off another feature branch
- **One thing per branch** — keep branches focused; don't bundle unrelated changes
- **Commit subjects ≤ 50 chars** — so they don't wrap in git log
- **Commit and push before handing back** — leave the branch in a state that can be reviewed and merged
- **End-of-task memory review** — after finishing a piece of work, review what was done and what the user said, and suggest any new things worth adding to this file

## wishlist

- **Context / tag view** — Claude auto-tags items during processing (e.g. `#shopping`, `#health`, `#work`). A context switcher in the inbox lets you filter to all items with a given tag across all statuses. Useful for e.g. seeing everything to pick up at the shop in one view. Questions to resolve: can an item have multiple tags? Should Claude proactively suggest consolidating related items ("you have 4 #shopping items — want a list?")?

## deployment

Server is created manually via the Hetzner Console (cloud-init handles first-boot setup); after that, pushes to `main` reach it automatically via GHCR + Watchtower + the `capture-sync` timer — no SSH, ever. Full setup docs in `README.md`.

## design reference

Colour palette:
- `--bg: #0d0d0d`
- `--accent: #c8f060` (acid green)
- `--text: #e8e8e0`
- `--amber: #f5c842` (reminders)
- `--red: #ff6b6b` (urgent)
- `--blue: #7eb8f7` (notes)

Fonts: Berkeley Mono (body/UI), Fraunces italic (logo)
