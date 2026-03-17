# capture

A self-hosted, privacy-first quick-capture app. Accessible only over Tailscale.

## Prerequisites

- Docker + Docker Compose v2 on the host
- A [Hetzner Cloud](https://console.hetzner.cloud) account
- A [Tailscale](https://tailscale.com) account with the machine you're deploying from on your tailnet
- An [Anthropic API key](https://console.anthropic.com)
- Terraform >= 1.10

## Before you deploy

**1. Enable Tailscale HTTPS certificates**

In [tailscale.com/admin/dns](https://tailscale.com/admin/dns), scroll to **HTTPS Certificates** and enable it. This allows the server to get a valid TLS cert for its `*.ts.net` hostname.

**2. Generate a Tailscale auth key**

In [tailscale.com/admin/settings/keys](https://tailscale.com/admin/settings/keys), create a key with:
- Reusable: **off**
- Expiry: **1 day** (used once during bootstrap)
- Tags: none required

**3. Create a Hetzner Object Storage bucket for Terraform state**

In the [Hetzner Console](https://console.hetzner.cloud), go to **Object Storage → Buckets** and create a bucket (any region). Then go to **Object Storage → Credentials** and generate an S3-compatible access key/secret.

**4. Create a Hetzner API token**

In **Hetzner Console → Security → API Tokens**, create a token with **Read & Write** permissions.

## Deploy

```bash
cd infra

# Configure the Terraform state backend
cp backend.hcl.example backend.hcl
# Edit backend.hcl: fill in bucket name, endpoint, access_key, secret_key

terraform init -backend-config=backend.hcl

terraform apply
# You will be prompted for:
#   hcloud_token         — Hetzner API token
#   anthropic_api_key    — Anthropic API key
#   tailscale_auth_key   — Tailscale auth key from step 2
#   tailscale_tailnet    — your tailnet suffix, e.g. "tail1234.ts.net"
#   ssh_public_key       — contents of ~/.ssh/id_ed25519.pub (or similar)
```

Terraform will print the server IP, Tailscale FQDN, and SSH command when done.

The server takes ~2 minutes to finish bootstrapping (cloud-init installs Docker, Tailscale, gets the TLS cert, clones the repo, and starts the app). You can watch progress with:

```bash
ssh root@<server-ip> journalctl -f
```

Once complete, open `https://<server-name>.<tailnet>.ts.net` on any device on your tailnet.

## Updating the app

SSH into the server and pull + restart:

```bash
ssh root@<server-ip>
cd /opt/capture/app
git pull
docker compose up -d --build
```

## Teardown

```bash
cd infra
terraform destroy
```

This removes the Hetzner server, SSH key, and firewall. The Object Storage bucket (Terraform state) is not managed by Terraform and must be deleted manually if no longer needed.
