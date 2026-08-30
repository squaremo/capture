# todo

- [ ] Add real PWA icons — `vite-plugin-pwa` manifest currently references `/icons/192.png` and `/icons/512.png`, which don't exist
- [ ] Implement Google Calendar integration for reminder-type captures
- [ ] Frontend e2e tests (Playwright/Cypress) — now that the frontend actually talks to the backend, this is unblocked
- [ ] Deploy smoke test — a post-deploy health check hitting `GET /api/items` over Tailscale, to confirm a rollout actually landed
- [ ] Revisit Terraform/IaC for server provisioning once the app itself is further along (tried and abandoned once already — see git history around the `claude/*-RKHeR` branches for what went wrong)
- [x] Create the 1Password items referenced in `infra/production.env` (anthropic api_key, linear api_key + team_id), then set `OP_SERVICE_ACCOUNT_TOKEN` on the server (`/opt/capture/.env.secret`) to turn everything on — confirmed working end-to-end, first real Linear ticket created via the app
- [ ] UI bug: after a capture resolves (e.g. to `acted` via `create_linear_task`), the frontend still shows it as pending/deciding instead of updating in place — the optimistic-UI polling in `frontend/src/main.js` isn't picking up the resolved state. Not yet diagnosed.

## ideas (freeform)

Unstructured thoughts on where this could go, captured as-is — not scoped or committed to.

- **Physical/kiosk input**: a push-to-talk interface, physical or touchscreen, with the UI running in kiosk mode on a Raspberry Pi.
- **Child and parent modes** — some actions should require parent mode to invoke.
- **Auditing** — actions taken by the app should be logged/auditable.
- **Home automation control**: Spotify, Sonos, a Matter hub (IKEA Dirigera).
- **Push to external services**: tasks and calendar items into things like Proton Calendar, Linear, possibly Obsidian.
- **Drive custom-built apps too**, not just third-party services — these would need to be reachable on the same Tailscale network.
- **Favourites**: named shortcuts (e.g. "play [song]") that just replay a fixed, previously-approved sequence of tool calls when invoked — no new planning/approval step needed each time.
- **Proposed flow**: typed or voice input is processed by the LLM into a plan — a schedule of tool calls plus target location/device — along with prose repeating back what was asked. The prose and a description of the plan are played back to the human, who approves or vetoes before anything executes.
  - Not implemented yet: today's `create_linear_task` (and any future side-effecting tool) executes immediately with no approve/veto step — confirmed live, it just went ahead and created the ticket. Worth deciding whether *every* acting tool needs this, or just some.
- **Integrations tab in the UI** — a tab showing which integrations are currently enabled (e.g. Linear on/off based on whether it's configured).
