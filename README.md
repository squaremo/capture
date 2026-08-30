# capture

A self-hosted, privacy-first quick-capture app. Accessible only over Tailscale.

## How deployment works

The server is created manually (no Terraform) and configures itself on first boot via cloud-init. After that, updates reach it without any further server access:

| Piece | Trigger | What it does |
|---|---|---|
| **Build** / **Build Frontend** | Push to `main` (`backend/**` / `frontend/**`) | Builds a Docker image, pushes it to GHCR as `:latest` and `:sha-<commit>` |
| **Watchtower** (on the server) | Polls every 5 min | Pulls a new `backend`/`nginx` image when GHCR's `:latest` digest changes, restarts that container |
| **capture-sync timer** (on the server) | Every 5 min | `git pull` in `/opt/capture/app`, then `docker compose up -d` — picks up `docker-compose.yml`/`nginx.conf` changes Watchtower can't see |
| **Rollback** | Manual (`workflow_dispatch`) | Re-points GHCR's `:latest` tag at an older `:sha-<commit>` build; Watchtower picks it up on its next poll |

So: push to `main`, wait a few minutes, the server updates itself.

## Bootstrapping a server from scratch

See [`infra/BOOTSTRAP.md`](infra/BOOTSTRAP.md) for the full ordered checklist (Tailscale, 1Password, Hetzner, verification). Short version: create the server in the Hetzner Console, paste [`infra/cloud-init.yaml.tpl`](infra/cloud-init.yaml.tpl) as its user-data with the placeholders filled in, wait ~2 minutes, open `https://<server_name>.<tailnet>.ts.net`.

## Optional integrations

`create_linear_task` lets Claude create real Linear issues for capture text that reads as project/engineering work. It's on whenever `LINEAR_API_KEY` and `LINEAR_TEAM_ID` resolve to real values (both required) — delete or comment out those two lines in [`infra/production.env`](infra/production.env) to turn it off.

Any env var in `infra/production.env` can be a literal value instead of an `op://...` reference if you'd rather not use 1Password for it — `resolveEnv()` (`backend/secrets.js`) passes non-`op://` values through unchanged. Just don't commit a real secret as a literal, since this file is in the (public) repo.

## Rolling back

Find the git SHA to roll back to (`git log --oneline`), then **Actions → Rollback → Run workflow**, pass the SHA. Watchtower applies it within a few minutes — no server access needed.

## Teardown

Delete the server directly in the Hetzner Cloud Console. Tailscale devices don't cost anything left orphaned, but you can remove the stale entry at `tailscale.com/admin/machines` whenever convenient.
