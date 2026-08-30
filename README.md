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

## Before you create the server

**1. Enable MagicDNS and HTTPS Certificates**

In [tailscale.com/admin/dns](https://tailscale.com/admin/dns): enable **MagicDNS** first, then **HTTPS Certificates**. Both are required for the server to get a valid TLS cert for its `*.ts.net` hostname — `tailscale cert` fails without them. You need to be an **Owner/Admin** of the tailnet to change these (check `tailscale.com/admin/users`).

**2. Generate a Tailscale auth key**

In [tailscale.com/admin/settings/keys](https://tailscale.com/admin/settings/keys), generate an auth key (non-reusable is fine — it's used once, at first boot).

**3. Set up 1Password secrets**

The server only ever gets one secret directly (below); everything else — `ANTHROPIC_API_KEY`, `LINEAR_API_KEY`, `LINEAR_TEAM_ID` — is read from 1Password at startup via the `op://...` references already committed in [`infra/production.env`](infra/production.env). Create matching items in 1Password (adjust the vault/item/field names in that file instead, if you'd rather use your own), then create a **Service Account** scoped to that vault and copy its token. Needs a 1Password plan that supports Service Accounts.

## Creating the server

In the [Hetzner Cloud Console](https://console.hetzner.cloud):

- Image: **Ubuntu 24.04**
- Firewall: allow inbound **UDP 41641** (Tailscale) only — app traffic arrives over the Tailscale interface, not the public one, so ports 80/443 don't need to be open publicly
- No SSH key needed — cloud-init does the whole setup; use Hetzner's browser **Console** (with the emailed root password) if you ever need emergency access
- In **Cloud config / User data**, paste the contents of [`infra/cloud-init.yaml.tpl`](infra/cloud-init.yaml.tpl) with the placeholders filled in directly in Hetzner's box (so nothing sensitive has to go anywhere else):
  - `${server_name}` → e.g. `capture`
  - `${op_service_account_token}` → the 1Password Service Account token from step 3 above — the only secret typed in at bootstrap
  - `${tailscale_auth_key}` → the auth key from step 2 above
  - `${tailscale_fqdn}` → `<server_name>.<your-tailnet>.ts.net`
  - `${repo_url}` → `https://github.com/squaremo/capture.git`

The server takes ~2 minutes to finish (installs Docker, joins Tailscale, gets a TLS cert, clones the repo, starts the app). Check progress via the Hetzner **Console**:

```bash
cloud-init status
journalctl -u capture -n 50 --no-pager
```

Once complete, open `https://<server_name>.<tailnet>.ts.net` on any Tailscale-connected device.

## Optional integrations

`create_linear_task` lets Claude create real Linear issues for capture text that reads as project/engineering work. It's on whenever `LINEAR_API_KEY` and `LINEAR_TEAM_ID` resolve to real values (both required) — delete or comment out those two lines in [`infra/production.env`](infra/production.env) to turn it off.

Any env var in `infra/production.env` can be a literal value instead of an `op://...` reference if you'd rather not use 1Password for it — `resolveEnv()` (`backend/secrets.js`) passes non-`op://` values through unchanged. Just don't commit a real secret as a literal, since this file is in the (public) repo.

## Rolling back

Find the git SHA to roll back to (`git log --oneline`), then **Actions → Rollback → Run workflow**, pass the SHA. Watchtower applies it within a few minutes — no server access needed.

## Teardown

Delete the server directly in the Hetzner Cloud Console. Tailscale devices don't cost anything left orphaned, but you can remove the stale entry at `tailscale.com/admin/machines` whenever convenient.
