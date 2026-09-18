#cloud-config
# For a satellite Pi (see designs/satellite-provisioning.md and
# designs/satellites.md) — provisioned via files dropped on the boot
# partition (bootfs), not pasted into a console like infra/cloud-init.yaml.tpl.
#
# Deploys via Docker + Watchtower, same self-update story as the Hetzner
# hub (infra/cloud-init.yaml.tpl) — see "Docker + Watchtower deployment"
# in designs/satellite-provisioning.md for why this replaced an earlier
# direct npm-install-and-run-as-a-systemd-unit version of this file.
hostname: ${MACHINE_HOSTNAME}
manage_etc_hosts: true

# Two separate accounts, deliberately not shared:
#
# ${ADMIN_USER} — key-based SSH/admin access only, same reasoning as
# infra/cloud-init.yaml.tpl (no root password, no root SSH). This entry
# is dropped by provision-satellite-sd.sh's merge step when a user-data
# already defines a default user (e.g. via Raspberry Pi Imager's own
# "Edit Settings") — running both would mean two different mechanisms
# defining possibly-conflicting attributes for the same or a different
# account — reusing that existing account for SSH/admin instead.
#
# ${KIOSK_USER} — runs the unattended tty1 kiosk session only (see
# `write_files`/`runcmd` below), always created fresh regardless of
# merging: no sudo, no SSH key, password locked, so it has no path to
# admin access even if the browser it runs were ever compromised. Kept
# separate from whichever account handles SSH/admin above so that
# account's own shell config (~/.bash_profile etc.) never mixes with
# the kiosk-launch logic — bash sources ~/.bash_profile on every
# interactive SSH login too, not just a physical console login, so
# sharing one account here would mean editing your own dotfiles risks
# breaking the kiosk, and vice versa.
users:
  - name: ${ADMIN_USER}
    groups: sudo
    shell: /bin/bash
    sudo: "ALL=(ALL) NOPASSWD:ALL"
    ssh_authorized_keys:
      - ${ADMIN_SSH_PUBLIC_KEY}
  - name: ${KIOSK_USER}
    # video/render/input: needed for cage (the kiosk Wayland compositor,
    # below) to get GPU/input access directly, with no display/login
    # manager brokering it.
    groups: video,render,input
    shell: /bin/bash
    lock_passwd: true

packages:
  - ca-certificates
  - curl
  - gnupg
  - git
  - jq
  - unattended-upgrades
  - apt-listchanges
  # For arecord -l/aplay -l once the WM8960 driver (below) is in —
  # useful to confirm the card actually shows up before anything tries
  # to use it. install.sh pulls in the codec's own build deps itself
  # (dkms/headers/i2c-tools); this is just the diagnostic tools.
  - alsa-utils
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
  # ${KIOSK_USER} to also be in a `seatd`/`seat` group (name varies by
  # package version) for cage to get a seat, on top of the
  # video/render/input groups above. First thing to check if cage exits
  # immediately with a seat-access error.
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
      ExecStart=-/sbin/agetty --autologin ${KIOSK_USER} --noclear %I $TERM

  # Launched by the profile hook below once ${KIOSK_USER}'s shell starts
  # on tty1. Points at nginx's plain-HTTP :80/localhost server block
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

  # ${KIOSK_USER}'s login shell runs this once, on tty1 only (not over
  # SSH — this account has no SSH key at all — and not if a compositor
  # is somehow already running) — starts the kiosk automatically after
  # the autologin above, with no display/session manager in between.
  # Written root:root (not owner: ${KIOSK_USER}:${KIOSK_USER})
  # deliberately — write_files runs BEFORE the users/user module in
  # cloud-init's default module order, so an owner naming an account
  # that doesn't exist yet fails the write outright (hit exactly this
  # on the first real boot: "Unknown user or group", and the file
  # never landed at all — turns out write_files validates the owner
  # before writing content, not after). root:root, world-readable is
  # fine for a .bash_profile anyway since only read access matters to
  # source it; chown'd to the real account below in runcmd, which runs
  # safely after users exist.
  - path: /home/${KIOSK_USER}/.bash_profile
    content: |
      if [ -z "$WAYLAND_DISPLAY" ] && [ "$(tty)" = "/dev/tty1" ]; then
        exec /opt/capture-satellite/kiosk.sh
      fi

runcmd:
  - chown ${KIOSK_USER}:${KIOSK_USER} /home/${KIOSK_USER}/.bash_profile

  # ── Docker ───────────────────────────────────────────────────────────
  # linux/debian, not linux/ubuntu: Raspberry Pi OS is Debian-based. This
  # copied infra/cloud-init.yaml.tpl's (Ubuntu, Hetzner) URL by mistake —
  # the wrong repo would 404 and Docker would never install.
  - install -m 0755 -d /etc/apt/keyrings
  - curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
  - chmod a+r /etc/apt/keyrings/docker.asc
  - echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian $(. /etc/os-release && echo $VERSION_CODENAME) stable" > /etc/apt/sources.list.d/docker.list
  - apt-get update -qq
  - apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
  - systemctl enable --now docker

  # ── Tailscale ────────────────────────────────────────────────────────
  - curl -fsSL https://tailscale.com/install.sh | sh
  - tailscale up --authkey="${TAILSCALE_AUTH_KEY}" --hostname="${MACHINE_HOSTNAME}"
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

  # ── WM8960 audio HAT driver ──────────────────────────────────────────
  # Out-of-tree (not in the mainline Pi kernel), so this builds a DKMS
  # module rather than just setting a dtoverlay — DKMS means it survives
  # future kernel upgrades from unattended-upgrades, rebuilding itself
  # automatically rather than breaking on the next one, IF it builds at
  # all. Non-interactive, installs its own deps (raspberrypi-kernel-
  # headers/dkms/i2c-tools/libasound2-plugins — raspberrypi-kernel-
  # headers specifically because it tracks whatever kernel is actually
  # running, which is what lets DKMS's own auto-rebuild-on-upgrade
  # keep working later too), writes dtparam=i2c_arm=on/i2s=on +
  # dtoverlay=i2s-mmap/wm8960-soundcard into /boot/firmware/config.txt
  # itself — doesn't reboot itself, hence the power_state below.
  #
  # Uses the official waveshareteam/WM8960-Audio-HAT repo, NOT the
  # jozolab "-bookworm" fork an earlier version of this pointed at —
  # that fork was stale relative to upstream, which has since actually
  # fixed the kernel-6.12 build failure multiple open issues reported
  # (waveshareteam/WM8960-Audio-HAT#68, #63): "Modified the install
  # script to support new 6.12 kernel" (PR #79, merged 2025-08-18), with
  # 6.18.x support following (#84, 2026-06-30) — so this should actually
  # work on Trixie's 6.12 LTS kernel now, unlike when this was first
  # written. Still genuinely unverified against this exact board by this
  # project, though — check after boot rather than assuming:
  #   dkms status               # should list wm8960-soundcard as installed
  #   aplay -l && arecord -l    # should list the card
  #   dmesg | grep -i wm8960    # if it didn't load
  # A failure here doesn't block anything else in this file (cloud-init's
  # runcmd keeps going past a failing step, and the reboot below still
  # happens).
  - git clone https://github.com/waveshareteam/WM8960-Audio-HAT /opt/wm8960-audio-hat
  - bash /opt/wm8960-audio-hat/install.sh

  # whisper.cpp build/install and the GPIO button service are not added
  # here yet — see Open questions in designs/satellite-hardware.md. (The
  # PTT button's GPIO wiring is unaffected by this HAT — it has a
  # pass-through header exposing the full 40-pin GPIO.)

# The WM8960 overlay/module need a reboot to actually load — this runs
# once, after every runcmd step above has finished (never call `reboot`
# directly inside runcmd: cloud-init would never reach the remaining
# steps).
power_state:
  mode: reboot
  message: Rebooting to load the WM8960 audio driver
  timeout: 30
  condition: true
