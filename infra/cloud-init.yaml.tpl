#cloud-config
hostname: ${server_name}
manage_etc_hosts: true

packages:
  - ca-certificates
  - curl
  - gnupg
  - git
  - jq

package_update: true
package_upgrade: true

write_files:
  - path: /opt/capture/.env
    permissions: "0600"
    content: |
      ANTHROPIC_API_KEY=${anthropic_api_key}
      DB_PATH=/data/capture.db
      PORT=3000
      HOST=0.0.0.0
      TAILSCALE_SUBNET=100.64.0.0/10

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
      EnvironmentFile=/opt/capture/.env
      ExecStart=/usr/bin/docker compose up
      ExecStop=/usr/bin/docker compose down
      Restart=on-failure
      RestartSec=10

      [Install]
      WantedBy=multi-user.target

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
  - tailscale up --authkey="${tailscale_auth_key}" --hostname="${server_name}"
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
  - systemctl enable --now capture.service
