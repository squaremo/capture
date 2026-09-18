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

# Same reasoning as infra/cloud-init.yaml.tpl: key-based admin access only,
# no root password, no root SSH. This `users:` block is dropped entirely
# by provision-satellite-sd.sh's merge step when a user-data already
# defines a default user (e.g. via Raspberry Pi Imager's own "Edit
# Settings") — running both would mean two different mechanisms defining
# possibly-conflicting attributes for the same or a different account.
# ADMIN_USER names whichever account actually ends up owning the kiosk
# session either way (see the other ${ADMIN_USER} references below) —
# "admin" when this block runs for real, or Imager's existing username
# when it's dropped in favour of reusing that account.
users:
  - name: ${ADMIN_USER}
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

  # Type=oneshot + up -d, not Type=simple + a foreground `up` (what an
  # earlier version of this did) — that kept a permanent `docker
  # compose up` process alive for systemd to supervise, which then
  # raced the capture-satellite-sync.timer's own `up -d` firing 5
  # minutes later (OnBootSec=5min lands right in the middle of first
  # boot's initial pull/start). Two concurrent Compose invocations both
  # pulling/extracting on the same project hammered a real Pi's SD card
  # hard enough to make SSH itself unusable (60%+ iowait observed).
  # Doesn't need the foreground process anyway — every service in
  # docker-compose.satellite.yml already has restart: unless-stopped,
  # so Docker itself handles crash-restart with no systemd involvement.
  - path: /etc/systemd/system/capture-satellite.service
    content: |
      [Unit]
      Description=Capture satellite (Docker Compose stack)
      After=network-online.target docker.service
      Wants=network-online.target
      Requires=docker.service

      [Service]
      Type=oneshot
      RemainAfterExit=yes
      WorkingDirectory=/opt/capture-satellite/app
      ExecStart=/usr/bin/flock /var/lock/capture-satellite-compose.lock /usr/bin/docker compose -f docker-compose.satellite.yml up -d
      ExecStop=/usr/bin/flock /var/lock/capture-satellite-compose.lock /usr/bin/docker compose -f docker-compose.satellite.yml down

      [Install]
      WantedBy=multi-user.target

  # Same role as capture-sync.timer on the Hetzner box: catches
  # docker-compose.satellite.yml/nginx.conf changes that Watchtower can't
  # see (it only reacts to new *images*, not compose/config edits).
  #
  # flock around the compose invocation (here and in
  # capture-satellite.service, above) rather than relying on timing —
  # OnBootSec=5min mostly keeps this clear of that service's own first
  # `up -d`, but "mostly" isn't good enough after two concurrent Compose
  # invocations pulling/extracting on the same project were caught
  # hammering a real Pi's SD card into 60%+ iowait. flock makes it
  # structurally impossible regardless of how long a pull takes,
  # rather than just narrowing the window.
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
      ExecStart=/usr/bin/flock /var/lock/capture-satellite-compose.lock /usr/bin/docker compose -f docker-compose.satellite.yml up -d --remove-orphans

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
      ExecStart=-/sbin/agetty --autologin ${ADMIN_USER} --noclear %I $TERM

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

  # ${ADMIN_USER}'s login shell runs this once, only on the physical
  # console (not over SSH, and not if a compositor is somehow already
  # running) — starts the kiosk automatically after the autologin above,
  # with no display/session manager in between.
  - path: /home/${ADMIN_USER}/.bash_profile
    owner: ${ADMIN_USER}:${ADMIN_USER}
    content: |
      if [ -z "$WAYLAND_DISPLAY" ] && [ "$(tty)" = "/dev/tty1" ]; then
        exec /opt/capture-satellite/kiosk.sh
      fi

runcmd:
  # Belt-and-suspenders: the users: block above already sets these
  # groups when it runs for real, but this also covers the merged case
  # where that block was dropped in favour of an account Imager already
  # created, which won't have them otherwise.
  - usermod -aG video,render,input ${ADMIN_USER}

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
  #
  # MUST cd into the cloned directory first — install.sh calls its own
  # install_module "./" "wm8960-soundcard", and that "./" resolves
  # against whatever directory the script is *run from*, not the
  # script's own location. runcmd commands execute with cwd=/, so
  # `bash /opt/wm8960-audio-hat/install.sh` on its own made "./" mean
  # "/" — the script's `cp -a ./* /usr/src/wm8960-soundcard-1.0/` then
  # copied the entire root filesystem's top-level contents into that
  # directory. Hit exactly this on real hardware: /usr/src ballooned to
  # 23G (on a 29G root partition), filling the disk completely and
  # taking every other service down with it (docker pulls, SSH, all of
  # it) once there was zero space left. `cd` first, always.
  - git clone https://github.com/waveshareteam/WM8960-Audio-HAT /opt/wm8960-audio-hat
  - cd /opt/wm8960-audio-hat && bash install.sh

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
