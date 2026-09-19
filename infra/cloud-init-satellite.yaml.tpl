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
# pwrctl: not a stock group — created below purely so cpufreq's
# governor knobs (cpufreq-permissions.service) have somewhere to be
# handed to that isn't `video`. `video` is the right, conventional
# group for the backlight (systemd's own default udev rules already
# grant it write access there for this exact reason), but CPU
# frequency scaling has nothing to do with display/GPU access — giving
# it to ${KIOSK_USER} via `video` just because that group happens to
# already be there would blur why the account has each permission it
# holds, when every other group on this account maps to one specific,
# documented need.
groups:
  - pwrctl

users:
  - name: ${ADMIN_USER}
    groups: sudo
    shell: /bin/bash
    sudo: "ALL=(ALL) NOPASSWD:ALL"
    ssh_authorized_keys:
      - ${ADMIN_SSH_PUBLIC_KEY}
  - name: ${KIOSK_USER}
    # video/render/input: needed for labwc (the kiosk Wayland compositor,
    # below) to get GPU/input access directly, with no display/login
    # manager brokering it. pwrctl: see the group definition above.
    groups: video,render,input,pwrctl
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
  # Display stack: labwc, not cage — switched after confirming on real
  # hardware that cage (this OS's packaged version) ignores the DRM
  # `panel_orientation` property entirely; it only supports *static*
  # rotation passed at its own startup, not automatic detection. labwc
  # honours `panel_orientation` at output init (same mechanism the tty
  # console already uses correctly), and — unlike cage, which is
  # deliberately single-client-only with no layer-shell support at all —
  # implements wlr-layer-shell, a prerequisite for ever getting an
  # on-screen keyboard (squeekboard/wvkbd) to render above the kiosk at
  # all, even though that specific problem (a keyboard's layer sitting
  # below Chromium's fullscreen layer) is a separate, still-open issue
  # upstream (labwc/labwc#2926) that switching compositors alone doesn't
  # resolve. seatd gives either compositor direct seat/GPU access with
  # no login/display manager needed. See "Display stack: minimal, not
  # headless" in designs/satellite-hardware.md.
  - labwc
  - seatd
  # Real, OS-level screen power-down after the panel's idle for a while —
  # see the backlight.sh write_files entry and its autostart wiring
  # below for why this replaces any in-page "screensaver" approach.
  - swayidle
  # `chromium` here, not `chromium-browser` — confirmed on real
  # hardware that `chromium-browser` is a transitional/dependency-only
  # package on this repo that doesn't provide its own binary of that
  # name; the real binary installs as plain `chromium`. Hit this as
  # cage's "Failed to spawn client: No such file or directory" once
  # everything else (XDG_RUNTIME_DIR, seat access) was already working.
  - chromium
  # NOTE: not yet re-verified against real hardware since the cage->labwc
  # switch — seatd may require ${KIOSK_USER} to also be in a
  # `seatd`/`seat` group beyond video/render/input (name varies by
  # package version) for either compositor to get a seat. First thing to
  # check if labwc exits immediately with a seat-access error.
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
      ExecStart=-/sbin/agetty --autologin ${KIOSK_USER} --noclear %I $TERM

  # Launched by the profile hook below once ${KIOSK_USER}'s shell starts
  # on tty1. Starts labwc itself only — what actually shows Station
  # (Chromium, via nginx's plain-HTTP :80/localhost block) is
  # ${KIOSK_USER}'s labwc autostart script below, since unlike cage
  # (which took its one client as a command-line argument), labwc is a
  # real compositor with its own autostart mechanism instead.
  # XDG_RUNTIME_DIR: labwc (like cage before it) needs it set, and a
  # bare console `agetty --autologin` doesn't reliably get
  # pam_systemd/logind to set it up the way a full graphical/systemd-
  # managed login session would — hit exactly this on real hardware
  # with cage (`cage.c: XDG_RUNTIME_DIR is not set in the environment`,
  # exiting immediately, which then ended the whole login session and
  # made getty@tty1 restart-loop fast enough to trip systemd's
  # start-limit and give up entirely). Only exports the variable here,
  # doesn't try to create the directory itself — /run/user is
  # root-owned (0755), so ${KIOSK_USER} can't mkdir under it (hit this
  # too: "Permission denied", then cage failing again with "Unable to
  # open Wayland socket" against a directory that was never actually
  # created). `loginctl enable-linger ${KIOSK_USER}` in runcmd below is
  # what actually gets logind to create and maintain this directory,
  # with no active session needed to trigger it.
  - path: /opt/capture-satellite/kiosk.sh
    permissions: "0755"
    content: |
      #!/bin/sh
      export XDG_RUNTIME_DIR=/run/user/$(id -u)
      exec labwc

  # Real screen power-down (not a browser-side dimming trick — see
  # designs/satellite-hardware.md's note that blanking has to be an
  # OS-level action, since a sandboxed kiosk tab can't reliably do it to
  # itself) via the standard `bl_power` backlight sysfs knob, which works
  # regardless of compositor/driver. Globs the device rather than
  # hardcoding a name. Confirmed on real hardware (Touch Display 2):
  # backlight actually blanks/wakes via this script, once ${KIOSK_USER}
  # can write to `bl_power` at all — see the udev rule below for that
  # part.
  - path: /opt/capture-satellite/backlight.sh
    permissions: "0755"
    content: |
      #!/bin/sh
      # $1: "on" or "off".
      for f in /sys/class/backlight/*/bl_power; do
        case "$1" in
          off) echo 1 > "$f" ;;
          on)  echo 0 > "$f" ;;
        esac
      done

  # `bl_power` is root-owned by default — ${KIOSK_USER} writing to it
  # directly fails "Permission denied" (confirmed on real hardware).
  # Fix is a udev rule handing the `video` group write access, not
  # sudo: ${KIOSK_USER} deliberately has no sudo/SSH-key path to admin
  # (see the users: comment above) precisely so a compromised Chromium
  # session can't escalate, and it's already in `video` for GPU access
  # — reusing that group for backlight access keeps the same "no path
  # to root" property rather than punching a hole in it.
  - path: /etc/udev/rules.d/90-backlight-video-group.rules
    content: |
      SUBSYSTEM=="backlight", RUN+="/bin/chgrp video /sys/class/backlight/%k/bl_power", RUN+="/bin/chmod g+w /sys/class/backlight/%k/bl_power"

  # Second half of the idle/awake pair, alongside backlight.sh — drops
  # every CPU core to its lowest-power governor while the panel's
  # asleep, restores whatever governor was actually running beforehand
  # (rather than assuming e.g. "ondemand") on wake. Remembers the
  # pre-sleep governor per core in /run (tmpfs, cleared every boot —
  # fine, since "low" always runs before "normal" ever needs to read
  # it).
  - path: /opt/capture-satellite/cpu-power.sh
    permissions: "0755"
    content: |
      #!/bin/sh
      # $1: "low" or "normal".
      mkdir -p /run/capture-satellite
      for gov in /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor; do
        cpu=$(basename "$(dirname "$(dirname "$gov")")")
        saved="/run/capture-satellite/governor.$cpu"
        case "$1" in
          low)
            cat "$gov" > "$saved"
            echo powersave > "$gov"
            ;;
          normal)
            [ -f "$saved" ] && cat "$saved" > "$gov"
            ;;
        esac
      done

  # cpufreq's sysfs knobs are root-owned by default, same problem as
  # `bl_power` above and the same fix in spirit — hand ${KIOSK_USER}
  # group write access rather than any form of sudo. Uses the dedicated
  # `pwrctl` group (see the `groups:`/`users:` entries above), not
  # `video` — CPU frequency scaling has nothing to do with display/GPU
  # access, unlike the backlight, so it gets its own group rather than
  # riding along on one that happens to already be there. A plain
  # oneshot service, not a udev rule: unlike the backlight device,
  # these files exist under /sys/devices/system/cpu regardless of any
  # hotplug event, so there's nothing for a udev rule to trigger on
  # reliably — a service that just runs once at boot, after the
  # cpufreq driver's already loaded, is simpler and matches the pattern
  # fix-goodix-touch.service already uses here for a boot-order-
  # sensitive one-shot fix.
  - path: /etc/systemd/system/cpufreq-permissions.service
    content: |
      [Unit]
      Description=Grant the pwrctl group write access to cpufreq governor knobs
      After=multi-user.target

      [Service]
      Type=oneshot
      ExecStart=/bin/sh -c 'chgrp pwrctl /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor && chmod g+w /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor'

      [Install]
      WantedBy=multi-user.target

  # labwc's own autostart mechanism — run once labwc itself has
  # started, in place of cage's old "take the one client as a command-
  # line argument" model. Backgrounded (`&`) since labwc's autostart
  # runs synchronously and would otherwise block labwc's own startup
  # waiting for a command that's meant to run for the session's whole
  # lifetime. Wrapped in a respawn loop rather than a bare one-shot
  # launch: under cage, a Chromium crash ended the whole login session,
  # which getty then restarted — a crude but real self-healing
  # mechanism. Under labwc, Chromium is just a background child of this
  # script; without the loop, a crash would leave labwc running with a
  # blank screen and nothing to bring the kiosk back.
  - path: /home/${KIOSK_USER}/.config/labwc/autostart
    permissions: "0755"
    content: |
      #!/bin/sh
      (
        while true; do
          chromium \
            --kiosk \
            --noerrdialogs \
            --disable-infobars \
            --check-for-update-interval=31536000 \
            --app=http://localhost/?station
          sleep 2
        done
      ) &

      # Low-power sleep: after 30 seconds with no input at all (touch,
      # mouse, keyboard), power the panel's backlight off and drop every
      # CPU core to its lowest-power governor; undo both the moment any
      # input arrives. swayidle watches labwc's own idle-notify support
      # (labwc is built on wlroots, which implements the same idle
      # protocol swaylock and friends rely on) rather than anything
      # Station's page has to opt into — a touch wakes the panel with no
      # in-page code at all. Confirmed on real hardware: labwc does
      # advertise the idle protocol swayidle needs, and the backlight
      # genuinely blanks/wakes on touch (see the udev rule above for the
      # permission fix that took to get there). The CPU half hasn't been
      # through that same live-verification pass yet — same permission-
      # fix shape as the backlight one (cpufreq-permissions.service,
      # above), but check `cat /sys/devices/system/cpu/cpu0/cpufreq/
      # scaling_governor` actually flips on the next real test.
      # swayidle already runs its timeout/resume commands via `sh -c`,
      # so a plain `;`-joined string is enough — no need to nest a
      # second `sh -c` inside it.
      swayidle -w \
        timeout 30 '/opt/capture-satellite/backlight.sh off; /opt/capture-satellite/cpu-power.sh low' \
        resume '/opt/capture-satellite/backlight.sh on; /opt/capture-satellite/cpu-power.sh normal' &

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
  # source it; chown'd (recursively, covering .config/labwc/autostart
  # too) to the real account below in runcmd, which runs safely after
  # users exist.
  - path: /home/${KIOSK_USER}/.bash_profile
    content: |
      if [ -z "$WAYLAND_DISPLAY" ] && [ "$(tty)" = "/dev/tty1" ]; then
        exec /opt/capture-satellite/kiosk.sh
      fi

  # Touch Display 2's Goodix touch controller has a well-documented
  # boot-timing race (reported against this exact display elsewhere,
  # not specific to this project): on a software reboot, the kernel's
  # goodix_ts driver probes before the chip is actually ready to
  # respond on I2C, fails once with "I2C communication failure: -5",
  # and never retries on its own — confirmed on real hardware
  # (dmesg: `Goodix-TS 10-005d: I2C communication failure: -5`, no
  # touch input device at all until the module is reloaded). Fix is a
  # plain rmmod+modprobe cycle, which forces a fresh probe attempt
  # once the system's further along in boot and the chip has had time
  # to settle — `-` on the rmmod line means a failure there (e.g. the
  # module never loaded in the first place) doesn't stop the modprobe
  # that follows.
  - path: /etc/systemd/system/fix-goodix-touch.service
    content: |
      [Unit]
      Description=Reload Goodix touchscreen driver (works around an I2C probe race on boot)
      After=multi-user.target

      [Service]
      Type=oneshot
      ExecStart=-/sbin/rmmod goodix_ts
      ExecStart=/sbin/modprobe goodix_ts

      [Install]
      WantedBy=multi-user.target

runcmd:
  # Recursive: covers .bash_profile and .config/labwc/autostart (both
  # written root:root above, for the same write_files-runs-before-users
  # reason), and anything else that ends up under this account's home
  # directory later without having to remember a new chown line each
  # time.
  - chown -R ${KIOSK_USER}:${KIOSK_USER} /home/${KIOSK_USER}

  # Gets logind to create and maintain /run/user/<uid> for the kiosk
  # account persistently, with no active login session needed to
  # trigger it — takes effect immediately, not just on next boot. See
  # the XDG_RUNTIME_DIR note on kiosk.sh above for why this is needed
  # at all: a bare console autologin doesn't reliably set this up on
  # its own the way a full session would.
  - loginctl enable-linger ${KIOSK_USER}

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
  - systemctl enable --now fix-goodix-touch.service
  - systemctl enable --now cpufreq-permissions.service

  # Applies the backlight udev rule (write_files, above) immediately —
  # the backlight device already exists by this point in boot, so
  # without this, ${KIOSK_USER} would only get write access to
  # `bl_power` after the *next* reboot re-triggers udev, not this one.
  - udevadm control --reload-rules
  - udevadm trigger --subsystem-match=backlight

  # ── Optional: disable unused radios/outputs to save power ────────────
  # A permanent, config.txt-level cut rather than anything cycled with
  # the idle/awake sleep logic above — Bluetooth and HDMI aren't used at
  # all on this kiosk build (Touch Display 2 over DSI, no BT
  # peripheral), so there's no reason to keep either powered.
  # DISABLE_BLUETOOTH/DISABLE_HDMI default to "1" in
  # provision-satellite-sd.sh, which is what this "${DISABLE_BLUETOOTH}"/
  # "${DISABLE_HDMI}" text actually resolves to for the common case — a
  # satellite that genuinely needs one of these (an HDMI-driven kiosk, a
  # Bluetooth peripheral) should override that script's own
  # DISABLE_BLUETOOTH=0/DISABLE_HDMI=0 rather than editing this file, so
  # this block never has to special-case one satellite's hardware
  # against another's. Confirmed correct dtoverlay/config option names,
  # not yet confirmed these are the *only* things needed for either cut
  # to actually take effect on this exact board/firmware — check
  # `hciconfig`/`rfkill list` and power draw before/after on the next
  # satellite this runs on.
  - if [ "${DISABLE_BLUETOOTH}" = "1" ]; then grep -q "^dtoverlay=disable-bt" /boot/firmware/config.txt || echo "dtoverlay=disable-bt" >> /boot/firmware/config.txt; fi
  - if [ "${DISABLE_HDMI}" = "1" ]; then grep -q "^hdmi_blanking=2" /boot/firmware/config.txt || echo "hdmi_blanking=2" >> /boot/firmware/config.txt; fi

  # ── Touch Display 2 (7") ─────────────────────────────────────────────
  # dtoverlay=vc4-kms-v3d (Raspberry Pi OS's default) drives video on
  # its own, but doesn't know this specific panel — without this line
  # video works (confirmed: the ili9881c-dsi panel driver bound fine
  # regardless) but the bundled Goodix touch controller never gets
  # instantiated at all. Confirmed on real hardware: this line is what
  # actually gets the "Goodix-TS 10-005d" device to exist in the
  # device tree in the first place (before fix-goodix-touch.service,
  # above, ever gets a chance to matter).
  #
  # Panel is portrait-native (720x1280) — panel_orientation on the
  # video= cmdline parameter is Bookworm/Trixie's Wayland-era
  # replacement for the old display_rotate= setting, and specifically a
  # DRM-level property. The tty console honours it correctly (it comes
  # up already rotated); cage did NOT (confirmed on real hardware — this
  # is one of the two reasons this template switched to labwc, see the
  # Display stack packages comment above), so it's labwc that's actually
  # relied on to read this property at output init. left_side_up vs.
  # right_side_up depends on which way the panel is physically mounted —
  # confirmed correct for this build, but flip it if a second unit comes
  # up rotated the wrong way.
  - grep -q "^dtoverlay=vc4-kms-dsi-ili9881-7inch" /boot/firmware/config.txt || echo "dtoverlay=vc4-kms-dsi-ili9881-7inch" >> /boot/firmware/config.txt
  - sed -i 's/$/ video=DSI-1:720x1280M@60D,panel_orientation=left_side_up/' /boot/firmware/cmdline.txt

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
