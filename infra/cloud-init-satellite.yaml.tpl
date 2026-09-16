#cloud-config
# For a satellite Pi (see designs/satellite-provisioning.md and
# designs/satellites.md) — provisioned via files dropped on the boot
# partition (bootfs), not pasted into a console like infra/cloud-init.yaml.tpl.
#
# Deploys via Docker + Watchtower, same self-update story as the Hetzner
# hub (infra/cloud-init.yaml.tpl) — see "Docker + Watchtower deployment"
# in designs/satellite-provisioning.md for why this replaced an earlier
# direct npm-install-and-run-as-a-systemd-unit version of this file.
hostname: ${HOUSE_ID}
manage_etc_hosts: true

# Same reasoning as infra/cloud-init.yaml.tpl: key-based admin access only,
# no root password, no root SSH.
users:
  - name: admin
    # video/render/input: needed for cage (the kiosk Wayland compositor,
    # below) to get GPU/input access directly, with no display/login
    # manager brokering it.
    groups: sudo,video,render,input
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
  - unattended-upgrades
  - apt-listchanges
  # Display stack: cage is a Wayland compositor built specifically to run
  # one fullscreen client and nothing else — no panel, no window
  # management, no desktop session to configure — the right fit for a
  # kiosk showing exactly one page. seatd gives it direct seat/GPU access
  # with no login/display manager needed. See "Display stack: minimal,
  # not headless" in designs/satellite-hardware.md.
  - cage
  - seatd
  - chromium-browser
  # NOTE: not yet verified against real hardware — seatd may require
  # admin to also be in a `seatd`/`seat` group (name varies by package
  # version) for cage to get a seat, on top of the video/render/input
  # groups above. First thing to check if cage exits immediately with a
  # seat-access error.
  # whisper.cpp build deps (build-essential, cmake) and audio tooling
  # (alsa-utils) are deliberately left out here — the whisper.cpp
  # service's own shape isn't decided yet (see Open questions in
  # designs/satellite-hardware.md). Add them once that's written, rather
  # than guessing at what it needs now.

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

  # The satellite container's own config, passed in as env_file by
  # docker-compose.satellite.yml — no 1Password/op:// here, unlike the
  # backend's .env.secret: satellite/secrets.js doesn't exist, the
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
      Description=Capture satellite (Docker Compose stack)
      After=network-online.target docker.service
      Wants=network-online.target
      Requires=docker.service

      [Service]
      Type=simple
      WorkingDirectory=/opt/capture-satellite/app
      ExecStart=/usr/bin/docker compose -f docker-compose.satellite.yml up
      ExecStop=/usr/bin/docker compose -f docker-compose.satellite.yml down
      Restart=on-failure
      RestartSec=10

      [Install]
      WantedBy=multi-user.target

  # Same role as capture-sync.timer on the Hetzner box: catches
  # docker-compose.satellite.yml/nginx.conf changes that Watchtower can't
  # see (it only reacts to new *images*, not compose/config edits).
  - path: /etc/systemd/system/capture-satellite-sync.service
    content: |
      [Unit]
      Description=Pull latest satellite repo config and reconcile compose stack
      After=network-online.target docker.service
      Requires=docker.service

      [Service]
      Type=oneshot
      WorkingDirectory=/opt/capture-satellite/app
      ExecStart=/usr/bin/git pull --ff-only
      ExecStart=/usr/bin/docker compose -f docker-compose.satellite.yml up -d --remove-orphans

  - path: /etc/systemd/system/capture-satellite-sync.timer
    content: |
      [Unit]
      Description=Periodically sync satellite deploy config from git

      [Timer]
      OnBootSec=5min
      OnUnitActiveSec=5min

      [Install]
      WantedBy=timers.target

  # Autologin on the console — nobody's ever going to type a login at
  # this box, it needs to reach the kiosk with zero interaction after
  # power-on.
  - path: /etc/systemd/system/getty@tty1.service.d/autologin.conf
    content: |
      [Service]
      ExecStart=
      ExecStart=-/sbin/agetty --autologin admin --noclear %I $TERM

  # Launched by the profile hook below once admin's shell starts on
  # tty1. Points at nginx's plain-HTTP :80/localhost server block
  # (satellite/nginx.conf) — not directly at the satellite container's
  # own port 4000, since in the split-container deployment the satellite
  # container no longer serves the frontend build itself, only the API
  # (see "Docker + Watchtower deployment" in
  # designs/satellite-provisioning.md). --kiosk fullscreens with no
  # chrome/tabs/address bar; the update check is disabled since
  # Watchtower-style auto-update doesn't apply to a browser binary and
  # there's no need for it to ever phone out.
  - path: /opt/capture-satellite/kiosk.sh
    permissions: "0755"
    content: |
      #!/bin/sh
      exec cage -- chromium-browser \
        --kiosk \
        --noerrdialogs \
        --disable-infobars \
        --check-for-update-interval=31536000 \
        --app=http://localhost/?station

  # admin's login shell runs this once, only on the physical console
  # (not over SSH, and not if a compositor is somehow already running)
  # — starts the kiosk automatically after the autologin above, with no
  # display/session manager in between.
  - path: /home/admin/.bash_profile
    owner: admin:admin
    content: |
      if [ -z "$WAYLAND_DISPLAY" ] && [ "$(tty)" = "/dev/tty1" ]; then
        exec /opt/capture-satellite/kiosk.sh
      fi

runcmd:
  # ── Docker ───────────────────────────────────────────────────────────
  - install -m 0755 -d /etc/apt/keyrings
  - curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  - chmod a+r /etc/apt/keyrings/docker.asc
  - echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" > /etc/apt/sources.list.d/docker.list
  - apt-get update -qq
  - apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
  - systemctl enable --now docker

  # ── Tailscale ────────────────────────────────────────────────────────
  - curl -fsSL https://tailscale.com/install.sh | sh
  - tailscale up --authkey="${TAILSCALE_AUTH_KEY}" --hostname="${HOUSE_ID}"
  - until tailscale status --json | jq -e '.Self.Online == true' > /dev/null 2>&1; do sleep 2; done

  # ── TLS certificate via Tailscale ───────────────────────────────────
  # Requires HTTPS certificates enabled in your tailnet settings:
  # tailscale.com/admin/dns → Enable HTTPS Certificates. Reads this box's
  # own MagicDNS name back from `tailscale status` rather than taking it
  # as a separate script input — one less thing to supply by hand.
  - mkdir -p /etc/tailscale/certs
  - >-
    tailscale cert
    --cert-file=/etc/tailscale/certs/app.crt
    --key-file=/etc/tailscale/certs/app.key
    "$(tailscale status --json | jq -r '.Self.DNSName | rtrimstr(".")')"

  # ── Clone repo and start the stack ──────────────────────────────────
  - mkdir -p /opt/capture-satellite
  - git clone "${REPO_URL}" /opt/capture-satellite/app
  - systemctl enable --now capture-satellite.service
  - systemctl enable --now capture-satellite-sync.timer

  # ── Kiosk display ────────────────────────────────────────────────────
  - systemctl enable --now seatd
  - systemctl daemon-reload
  - systemctl restart getty@tty1

  # whisper.cpp build/install and the GPIO button service are not added
  # here yet — see Open questions in designs/satellite-hardware.md.
