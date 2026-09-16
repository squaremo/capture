#cloud-config
# For a satellite Pi (see designs/satellite-provisioning.md and
# designs/satellites.md) — provisioned via files dropped on the boot
# partition (bootfs), not pasted into a console like infra/cloud-init.yaml.tpl.
hostname: ${HOUSE_ID}
manage_etc_hosts: true

# Same reasoning as infra/cloud-init.yaml.tpl: key-based admin access only,
# no root password, no root SSH.
users:
  - name: admin
    groups: sudo
    shell: /bin/bash
    sudo: "ALL=(ALL) NOPASSWD:ALL"
    ssh_authorized_keys:
      - ${ADMIN_SSH_PUBLIC_KEY}

packages:
  - ca-certificates
  - curl
  - gnupg
  - git
  - jq
  - nodejs
  - npm
  - unattended-upgrades
  - apt-listchanges
  # whisper.cpp build deps (build-essential, cmake) and audio tooling
  # (alsa-utils) are deliberately left out here — the whisper.cpp
  # service's own shape isn't decided yet (see Open questions in
  # designs/satellite-hardware.md). Add them once that's written, rather
  # than guessing at what it needs now.
  #
  # Also missing: the display stack (a compositor + Chromium kiosk +
  # autologin) that Station actually needs to show anything on the
  # touchscreen — see "Display stack: minimal, not headless" in
  # designs/satellite-hardware.md. This template currently provisions
  # the satellite process only, not what puts it on screen.

package_update: true
package_upgrade: true

write_files:
  # See "OS maintenance: unattended-upgrades" in
  # designs/satellite-hardware.md — same config, written directly instead
  # of the manual dpkg-reconfigure step, since nobody's at this box to
  # answer the debconf prompt.
  - path: /etc/apt/apt.conf.d/20auto-upgrades
    content: |
      APT::Periodic::Update-Package-Lists "1";
      APT::Periodic::Unattended-Upgrade "1";

  - path: /etc/apt/apt.conf.d/50unattended-upgrades
    content: |
      Unattended-Upgrade::Origins-Pattern {
          "origin=Raspbian,codename=${distro_codename},label=Raspbian";
          "origin=Raspberry Pi Foundation,codename=${distro_codename},label=Raspberry Pi Foundation";
      };
      Unattended-Upgrade::Remove-Unused-Dependencies "true";
      Unattended-Upgrade::Automatic-Reboot "true";
      Unattended-Upgrade::Automatic-Reboot-Time "04:00";

  # The satellite process's own config — no 1Password/op:// here, unlike
  # the backend's .env.secret: satellite/secrets.js doesn't exist, the
  # satellite only ever takes plain env vars (see satellite/.env.example).
  # DIRIGERA_* is deliberately left out — that pairing is a one-time
  # manual step (`npx dirigera authenticate`) done after first boot, not
  # something to script here.
  - path: /opt/capture-satellite/.env
    permissions: "0600"
    content: |
      HOUSE_ID=${HOUSE_ID}
      BACKEND_URL=${BACKEND_URL}

  - path: /etc/systemd/system/capture-satellite.service
    content: |
      [Unit]
      Description=Capture satellite (local device control + kiosk frontend)
      After=network-online.target
      Wants=network-online.target

      [Service]
      Type=simple
      WorkingDirectory=/opt/capture-satellite/app/satellite
      EnvironmentFile=/opt/capture-satellite/.env
      ExecStart=/usr/bin/npm start
      Restart=on-failure
      RestartSec=10

      [Install]
      WantedBy=multi-user.target

runcmd:
  # ── Tailscale ────────────────────────────────────────────────────────
  - curl -fsSL https://tailscale.com/install.sh | sh
  - tailscale up --authkey="${TAILSCALE_AUTH_KEY}" --hostname="${HOUSE_ID}"
  - until tailscale status --json | jq -e '.Self.Online == true' > /dev/null 2>&1; do sleep 2; done

  # ── Clone repo and build ────────────────────────────────────────────
  - mkdir -p /opt/capture-satellite
  - git clone "${REPO_URL}" /opt/capture-satellite/app
  - cd /opt/capture-satellite/app/satellite && npm install
  - cd /opt/capture-satellite/app/frontend && npm install && npm run build
  - systemctl enable --now capture-satellite.service

  # whisper.cpp build/install and the GPIO button service are not added
  # here yet — see Open questions in designs/satellite-hardware.md.
