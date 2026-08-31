#cloud-config
hostname: ${server_name}
manage_etc_hosts: true

# A non-root admin user for SSH — root SSH login is unusable without a key
# on file anyway, and this way there's never a root password involved:
# access is entirely key-based, and sudo needs no password once you're in.
users:
  - name: admin
    groups: sudo
    shell: /bin/bash
    sudo: "ALL=(ALL) NOPASSWD:ALL"
    ssh_authorized_keys:
      - ${admin_ssh_public_key}

packages:
  - ca-certificates
  - curl
  - gnupg
  - git
  - jq

package_update: true
package_upgrade: true

write_files:
  # The only secret written to the server directly. Everything else the
  # app needs lives in 1Password and is referenced via op:// values
  # committed in infra/production.env, delivered by git pull like any
  # other config change — see capture-sync.timer below.
  - path: /opt/capture/.env.secret
    permissions: "0600"
    content: |
      OP_SERVICE_ACCOUNT_TOKEN=${op_service_account_token}

  - path: /etc/systemd/system/capture.service
    content: |
      [Unit]
      Description=Capture app
      After=network-online.target docker.service
      Wants=network-online.target
      Requires=docker.service

      [Service]
      Type=simple
      WorkingDirectory=/opt/capture/app
      EnvironmentFile=/opt/capture/.env.secret
      ExecStart=/usr/bin/docker compose up
      ExecStop=/usr/bin/docker compose down
      Restart=on-failure
      RestartSec=10

      [Install]
      WantedBy=multi-user.target

  - path: /etc/systemd/system/capture-sync.service
    content: |
      [Unit]
      Description=Pull latest capture repo config and reconcile compose stack
      After=network-online.target docker.service
      Requires=docker.service

      [Service]
      Type=oneshot
      WorkingDirectory=/opt/capture/app
      ExecStart=/usr/bin/git pull --ff-only
      ExecStart=/bin/sh -c 'git rev-parse HEAD > /opt/capture/data/config-version'
      ExecStart=/usr/bin/docker compose up -d --remove-orphans

  - path: /etc/systemd/system/capture-sync.timer
    content: |
      [Unit]
      Description=Periodically sync capture deploy config from git

      [Timer]
      OnBootSec=5min
      OnUnitActiveSec=5min

      [Install]
      WantedBy=timers.target

runcmd:
  # ── Docker ──────────────────────────────────────────────────────────────────
  - install -m 0755 -d /etc/apt/keyrings
  - curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  - chmod a+r /etc/apt/keyrings/docker.asc
  - echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" > /etc/apt/sources.list.d/docker.list
  - apt-get update -qq
  - apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
  - systemctl enable --now docker

  # ── Tailscale ────────────────────────────────────────────────────────────────
  - curl -fsSL https://tailscale.com/install.sh | sh
  # --snat-subnet-routes=false: without it, tailscaled masquerades any
  # traffic it forwards to a local destination — including a peer's
  # request into the Docker bridge network — replacing the real client
  # IP with the bridge gateway address before the app ever sees it,
  # which breaks the Tailscale-subnet allowlist check in server.js.
  - tailscale up --authkey="${tailscale_auth_key}" --hostname="${server_name}" --snat-subnet-routes=false
  # Wait for Tailscale to be fully up and get its IP
  - until tailscale status --json | jq -e '.Self.Online == true' > /dev/null 2>&1; do sleep 2; done

  # ── TLS certificate via Tailscale ────────────────────────────────────────────
  # Requires HTTPS certificates enabled in your tailnet settings:
  # tailscale.com/admin/dns → Enable HTTPS Certificates
  - mkdir -p /etc/tailscale/certs
  - tailscale cert --cert-file=/etc/tailscale/certs/app.crt --key-file=/etc/tailscale/certs/app.key "${tailscale_fqdn}"

  # ── Clone repo and start app ─────────────────────────────────────────────────
  - mkdir -p /opt/capture
  - git clone "${repo_url}" /opt/capture/app
  - mkdir -p /opt/capture/data
  # So GET /api/version reports the real config revision from the first
  # boot, instead of "unknown" until capture-sync's first run (up to 5min).
  - git -C /opt/capture/app rev-parse HEAD > /opt/capture/data/config-version
  - systemctl enable --now capture.service
  - systemctl enable --now capture-sync.timer
