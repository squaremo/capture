# todo

- [ ] Add real PWA icons — `vite-plugin-pwa` manifest currently references `/icons/192.png` and `/icons/512.png`, which don't exist
- [ ] Implement Google Calendar integration for reminder-type captures
- [ ] Frontend e2e tests (Playwright/Cypress) — now that the frontend actually talks to the backend, this is unblocked
- [ ] Deploy smoke test — a post-deploy health check hitting `GET /api/items` over Tailscale, to confirm a rollout actually landed
- [ ] Revisit Terraform/IaC for server provisioning once the app itself is further along (tried and abandoned once already — see git history around the `claude/*-RKHeR` branches for what went wrong)
