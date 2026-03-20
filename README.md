# capture

A self-hosted, privacy-first quick-capture app. Accessible only over Tailscale.

## How deployment works

Three GitHub Actions workflows handle the full lifecycle:

| Workflow | Trigger | What it does |
|---|---|---|
| **Bootstrap** | Manual (`workflow_dispatch`) | Provisions the Hetzner server via Terraform, generates an SSH key pair, saves `DEPLOY_HOST` / `DEPLOY_SSH_KEY` / `DEPLOY_USER` as Actions secrets |
| **Build** | Push to `main` (changes to `backend/`) | Builds the Docker image, pushes it to GHCR |
| **Deploy** | After Build succeeds | Connects via Tailscale, SSHs into the server, pulls the new image |

Run **Bootstrap once** to set up the server. After that, pushing to `main` handles builds and deployments automatically.

## Before you run Bootstrap

**1. Enable Tailscale HTTPS certificates**

In [tailscale.com/admin/dns](https://tailscale.com/admin/dns), scroll to **HTTPS Certificates** and enable it. This lets the server get a valid TLS cert for its `*.ts.net` hostname.

**2. Create a Tailscale OAuth client**

In [tailscale.com/admin/settings/oauth](https://tailscale.com/admin/settings/oauth), create a client with **both** `devices:write` and `policy:write` scopes, tagged `tag:ci`.

The ACL (`tagOwners`, member↔member rule, CI SSH rule) is managed by Terraform and applied automatically when Bootstrap runs — no manual ACL editing needed.

**3. Create a Hetzner API token**

In **Hetzner Console → Security → API Tokens**, create a token with **Read & Write** permissions.

**4. Create a Hetzner Object Storage bucket for Terraform state**

In the [Hetzner Console](https://console.hetzner.cloud), go to **Object Storage → Buckets** and create a bucket (any region). Then go to **Object Storage → Credentials** and generate an S3-compatible access key/secret.

**5. Add GitHub Actions secrets**

In your repo → **Settings → Secrets and variables → Actions**, add:

| Secret | Value |
|---|---|
| `HCLOUD_TOKEN` | Hetzner API token (step 3) |
| `ANTHROPIC_API_KEY` | Anthropic API key |
| `TS_AUTH_KEY` | One-time Tailscale auth key — create in [tailscale.com/admin/settings/keys](https://tailscale.com/admin/settings/keys) with Reusable: **off**, Expiry: **1 day** |
| `TS_OAUTH_CLIENT_ID` | Tailscale OAuth client ID (step 2) |
| `TS_OAUTH_SECRET` | Tailscale OAuth client secret (step 2) |
| `TAILSCALE_TAILNET` | Your tailnet name, e.g. `yourname.ts.net` |
| `TF_STATE_BUCKET` | Object Storage bucket name (step 4) |
| `TF_STATE_ENDPOINT` | Object Storage endpoint, e.g. `https://fsn1.your-objectstorage.com` |
| `TF_STATE_ACCESS_KEY` | S3 access key (step 4) |
| `TF_STATE_SECRET_KEY` | S3 secret key (step 4) |

Bootstrap will automatically create `DEPLOY_HOST`, `DEPLOY_SSH_KEY`, and `DEPLOY_USER` when it runs — don't set these manually.

## Bootstrap

Go to **Actions → Bootstrap → Run workflow**. Optionally override:

- `server_name` — Tailscale machine name and hostname (default: `capture`)
- `location` — Hetzner datacenter: `fsn1` `nbg1` `hel1` `ash` `hil` (default: `fsn1`)
- `server_type` — Hetzner server type (default: `cx22`, 2 vCPU / 4 GB RAM, ~€4.35/mo)

The workflow runs Terraform, then saves the three deploy secrets. The server IP and Tailscale FQDN appear in the workflow logs.

The server takes ~2 minutes to finish bootstrapping (cloud-init installs Docker, Tailscale, gets the TLS cert, clones the repo, and starts the app). You can watch progress with:

```bash
ssh root@<server-ip> journalctl -f
```

Once complete, open `https://<server-name>.<tailnet>.ts.net` on any device on your tailnet.

> **Note:** `TS_AUTH_KEY` is consumed on first use. If you ever destroy and reprovision the server, generate a fresh key before re-running Bootstrap.

## Updating the app

Push to `main` — GitHub Actions will build a new image, push it to GHCR, then SSH into the server and run `docker compose pull && up -d`. No manual steps needed.

To roll back, find the `sha-<commit>` image tag in the package registry, then on the server:

```bash
cd /opt/capture/app
BACKEND_IMAGE=ghcr.io/squaremo/capture:sha-<commit> docker compose up -d
```

## Teardown

```bash
cd infra
terraform init -backend-config=backend.hcl
terraform destroy
```

This removes the Hetzner server, SSH key, and firewall. The Object Storage bucket (Terraform state) is not managed by Terraform and must be deleted manually if no longer needed.
