# capture · personal quick-capture app

## what this is

A self-hosted, privacy-first note and task capture tool. Optimised for zero-friction input from phone, laptop, or a dedicated home station. Accessible only over Tailscale (no public internet exposure).

The core idea: get a thought out of your head and into the system in under 5 seconds, then deal with it later — or have the app act on it immediately (e.g. create a calendar reminder).

## current state

**Frontend** (`frontend/index.html`) — polished single-file HTML/CSS/JS prototype:

- Full UI with dark utilitarian aesthetic (monospaced Berkeley Mono + Fraunces serif, acid green accent `#c8f060`)
- Textarea capture input with ⌘↵ keyboard shortcut and voice via Web Speech API
- **Optimistic UI**: item appears instantly in inbox with a `pending` state + shimmer bar, then resolves in-place ~1.5s later with what was done
- Item states: `pending` → `triaged` / `reminder` / `urgent` / `acted` / `failed`
- Each resolved item shows a coloured result strip with a natural-language description of the action taken (e.g. "Calendar event created: 'Call dentist' — Tomorrow, 9:00am")
- Filter tabs: All / Pending / Acted / Done
- Stats footer, grain texture overlay, VPN status badge
- Not yet connected to the backend (still uses in-memory state)

**Backend** (`backend/`) — Fastify + SQLite, deployed and running:

- `POST /api/capture`, `GET /api/items`, `GET /api/items/:id`, `PATCH /api/items/:id`
- Optimistic flow: item saved immediately as `pending`, Claude processes in background and resolves it
- Claude intent detection via tool calling (`save_to_inbox` → `triaged`, `create_reminder` → `reminder`, `flag_urgent` → `urgent`)
- Tailscale IP allowlist middleware (optional via `TAILSCALE_SUBNET` env var)
- Persisted to SQLite (`better-sqlite3`); DB path via `DB_PATH` env var

**Infrastructure** — running on Hetzner:

- Terraform config in `infra/` provisions the VM
- Docker Compose runs backend + nginx reverse proxy with Tailscale TLS certs
- GitHub Actions: `build.yml` builds and pushes image to GHCR on pushes to `main`; `deploy.yml` SSHs in via Tailscale and pulls the new image

## stack

- **Frontend**: single-file HTML prototype → to be converted to a PWA (add manifest + service worker)
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

## next steps (suggested)

1. Implement the test suite (Vitest — see `TESTING.md` for the plan)
2. Connect frontend to backend API (replace in-memory state)
3. Add `manifest.json` and `sw.js` to make it installable as a PWA
4. Implement Google Calendar integration for reminder-type captures

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
- **Commit and push before handing back** — leave the branch in a state that can be reviewed and merged

## wishlist

- **Context / tag view** — Claude auto-tags items during processing (e.g. `#shopping`, `#health`, `#work`). A context switcher in the inbox lets you filter to all items with a given tag across all statuses. Useful for e.g. seeing everything to pick up at the shop in one view. Questions to resolve: can an item have multiple tags? Should Claude proactively suggest consolidating related items ("you have 4 #shopping items — want a list?")?

## design reference

Colour palette:
- `--bg: #0d0d0d`
- `--accent: #c8f060` (acid green)
- `--text: #e8e8e0`
- `--amber: #f5c842` (reminders)
- `--red: #ff6b6b` (urgent)
- `--blue: #7eb8f7` (notes)

Fonts: Berkeley Mono (body/UI), Fraunces italic (logo)
