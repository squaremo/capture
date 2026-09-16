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
  - nodejs
  - npm
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

  # Autologin on the console — nobody's ever going to type a login at
  # this box, it needs to reach the kiosk with zero interaction after
  # power-on.
  - path: /etc/systemd/system/getty@tty1.service.d/autologin.conf
    content: |
      [Service]
      ExecStart=
      ExecStart=-/sbin/agetty --autologin admin --noclear %I $TERM

  # Launched by the profile hook below once admin's shell starts on
  # tty1. Points at this same box's own satellite process (see
  # Satellite-served frontend in designs/satellites.md — it already
  # serves the frontend build locally, no separate hosting needed).
  # --kiosk fullscreens with no chrome/tabs/address bar; the update
  # check is disabled since Watchtower-style auto-update doesn't apply
  # to a browser binary and there's no need for it to ever phone out.
  - path: /opt/capture-satellite/kiosk.sh
    permissions: "0755"
    content: |
      #!/bin/sh
      exec cage -- chromium-browser \
        --kiosk \
        --noerrdialogs \
        --disable-infobars \
        --check-for-update-interval=31536000 \
        --app=http://localhost:4000/?station

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

  # ── Kiosk display ────────────────────────────────────────────────────
  - systemctl enable --now seatd
  - systemctl daemon-reload
  - systemctl restart getty@tty1

  # whisper.cpp build/install and the GPIO button service are not added
  # here yet — see Open questions in designs/satellite-hardware.md.
