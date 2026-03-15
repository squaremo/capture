# capture · personal quick-capture app

## what this is

A self-hosted, privacy-first note and task capture tool. Optimised for zero-friction input from phone, laptop, or a dedicated home station. Accessible only over Tailscale (no public internet exposure).

The core idea: get a thought out of your head and into the system in under 5 seconds, then deal with it later — or have the app act on it immediately (e.g. create a calendar reminder).

## current state

Two polished single-file HTML/CSS/JS prototypes exist (v1 and v2). The latest (`frontend/index.html`) includes:

- Full UI with dark utilitarian aesthetic (monospaced Berkeley Mono + Fraunces serif, acid green accent `#c8f060`)
- Textarea capture input with ⌘↵ keyboard shortcut and voice via Web Speech API
- **Optimistic UI**: item appears instantly in inbox with a `pending` state + shimmer bar, then resolves in-place ~1.5s later with what was done
- Item states: `pending` → `triaged` / `reminder` / `urgent` / `acted` / `failed`
- Each resolved item shows a coloured result strip with a natural-language description of the action taken (e.g. "Calendar event created: 'Call dentist' — Tomorrow, 9:00am")
- Filter tabs: All / Pending / Acted / Done
- Stats footer, grain texture overlay, VPN status badge

Nothing is persisted yet. No backend exists yet.

## intended stack

- **Frontend**: the existing HTML prototype, to be converted to a PWA (add manifest + service worker)
- **Backend**: lightweight Node.js (Fastify) or Python (FastAPI) server with SQLite for persistence
- **Calendar integration**: Google Calendar API or CalDAV for acting on detected reminders
- **Voice (home station)**: Raspberry Pi + microphone, local transcription via `whisper.cpp`
- **Access**: Tailscale only — no auth layer needed beyond Tailscale identity; whitelist by Tailscale IP at the server level

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

1. Add `manifest.json` and `sw.js` to make it installable as a PWA
2. Build the Fastify backend with SQLite persistence (POST /capture, GET /items, PATCH /items/:id)
3. Connect frontend to backend API (replace in-memory state)
4. Add Tailscale IP allowlist middleware to the backend
5. Implement Google Calendar integration for reminder-type captures
6. Set up `docker-compose.yml` for easy self-hosting

## architecture decisions

- **Intent detection is server-side via Claude API + tool calling** — not client-side regex. The frontend sends the raw text to the backend, which calls Claude with a set of tools (`save_to_inbox`, `create_reminder`, `flag_urgent`). Claude decides which tool to call and writes the human-readable `action_result` string. This means intent logic is easy to tune via system prompt, not code.
- **Async with optimistic UI** — the capture is saved immediately (pending state), LLM processes in background (~1-2s), item resolves in-place. User never waits on a spinner.
- **Claude API runs on Anthropic's infrastructure** — the VM stays lightweight. Only the backend makes outbound calls to the Claude API. API key never touches the frontend.
- **Web Speech API for mobile/desktop voice** — routes through Google's speech service (Chrome). Acceptable tradeoff for convenience. Home station uses local `whisper.cpp` instead for full privacy.
- **PWA, not native app** — same codebase across phone, laptop, kiosk. Installable to home screen. Voice works on Android Chrome.
- **Tailscale for access control** — no public ports, no login screen. Backend middleware checks that requests originate from a Tailscale IP.

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
