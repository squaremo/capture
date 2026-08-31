# todo

- [ ] Add real PWA icons — `vite-plugin-pwa` manifest currently references `/icons/192.png` and `/icons/512.png`, which don't exist
- [ ] Implement Google Calendar integration for reminder-type captures
- [ ] Frontend e2e tests (Playwright/Cypress) — now that the frontend actually talks to the backend, this is unblocked
- [ ] Deploy smoke test — a post-deploy health check hitting `GET /api/items` over Tailscale, to confirm a rollout actually landed
- [ ] Revisit Terraform/IaC for server provisioning once the app itself is further along (tried and abandoned once already — see git history around the `claude/*-RKHeR` branches for what went wrong)
- [x] Create the 1Password items referenced in `infra/production.env` (anthropic api_key, linear api_key + team_id), then set `OP_SERVICE_ACCOUNT_TOKEN` on the server (`/opt/capture/.env.secret`) to turn everything on — confirmed working end-to-end, first real Linear ticket created via the app
- [x] UI bug: items resolving to an action stayed stuck showing pending. Two real causes found in `frontend/src/main.js`'s `pollForResolution`: a single non-ok fetch response permanently stopped the poll loop (rather than retrying — likely hit often given how frequently this app's containers restart), and the ~25s total polling budget was tight enough for a real network round-trip to exceed it. Widened the budget to a few minutes and made it retry through transient failures instead of giving up on the first one.
- [x] `TOL-4` — inbox split into "needs attention" (pending/triaged/reminder/urgent/awaiting_approval) and "resolved" (acted/vetoed/failed) sections, always both visible instead of tab-switching. Verified in a browser — see the screenshots sent alongside this.
- [x] `TOL-1` — backend, config, and frontend versions shown in a footer in the UI, sourced from `GET /api/version` (backend/frontend versions baked in at Docker build time; config version written by `capture-sync` on each sync, since deployed config follows its own git-pull path rather than an image build).
- [x] `TOL-6` — `GET /api/version` also reports which integrations are enabled (currently just `linear`), shown alongside the version info in the same UI footer.

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
  - [x] Implemented for single-tool-call captures: `create_linear_task` now proposes (`awaiting_approval`) rather than executing immediately; `POST /api/items/:id/approve`/`/veto` decide. Any future acting tool gets this by being added to `ACTING_TOOLS` in `backend/integrations/claude.js`. Not yet handled: multi-step plans (a *series* of tool calls) — today's `tool_choice: any` only ever picks one.
- **Integrations tab in the UI** — a tab showing which integrations are currently enabled (e.g. Linear on/off based on whether it's configured).
  - [x] Minimal version implemented (`TOL-6`): enabled integrations shown in the version footer, not a dedicated tab. A fuller tab (with per-integration detail/config links) is still open if wanted later.
