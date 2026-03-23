locals {
  tailscale_fqdn = "${var.server_name}.${var.tailscale_tailnet}"
}

# ── Tailscale ACL ──────────────────────────────────────────────────────────────
# Manages the tailnet policy. Replaces the entire ACL file, so this includes
# the default member↔member rule that Tailscale ships with out of the box.

resource "tailscale_acl" "main" {
  acl = jsonencode({
    tagOwners = {
      "tag:ci" = ["autogroup:admin"]
    }
    acls = [
      # Default: members can reach all other members on any port
      { action = "accept", src = ["autogroup:member"], dst = ["autogroup:member:*"] },
      # CI runners may SSH to member devices (needed for deploy workflow)
      { action = "accept", src = ["tag:ci"], dst = ["autogroup:member:22"] },
    ]
  })
}

# ── Tailscale auth key ─────────────────────────────────────────────────────────
# Generated fresh each time Bootstrap runs; passed to cloud-init so the server
# can join the tailnet on first boot. Single-use, expires after 1 hour.

resource "tailscale_tailnet_key" "server" {
  reusable      = false
  ephemeral     = false
  preauthorized = true
  expiry        = 3600

  depends_on = [tailscale_acl.main]
}

# ── SSH key ────────────────────────────────────────────────────────────────────

resource "hcloud_ssh_key" "default" {
  name       = "${var.server_name}-key"
  public_key = var.ssh_public_key
}

# ── Firewall ───────────────────────────────────────────────────────────────────
# The app is Tailscale-only. Public ports: SSH only.
# All app traffic (443) arrives via Tailscale interface, not public internet.

resource "hcloud_firewall" "capture" {
  name = "${var.server_name}-firewall"

  rule {
    direction = "in"
    protocol  = "tcp"
    port      = "22"
    source_ips = ["0.0.0.0/0", "::/0"]
  }

  # Tailscale uses UDP 41641 for direct connections (WireGuard)
  rule {
    direction = "in"
    protocol  = "udp"
    port      = "41641"
    source_ips = ["0.0.0.0/0", "::/0"]
  }
}

# ── Server ─────────────────────────────────────────────────────────────────────

resource "hcloud_server" "capture" {
  name        = var.server_name
  server_type = var.server_type
  image       = "ubuntu-24.04"
  location    = var.location

  ssh_keys     = [hcloud_ssh_key.default.id]
  firewall_ids = [hcloud_firewall.capture.id]

  user_data = templatefile("${path.module}/cloud-init.yaml.tpl", {
    server_name        = var.server_name
    tailscale_auth_key = tailscale_tailnet_key.server.key
    tailscale_fqdn     = local.tailscale_fqdn
    anthropic_api_key  = var.anthropic_api_key
    repo_url           = var.repo_url
  })

  labels = {
    app = "capture"
  }
}
