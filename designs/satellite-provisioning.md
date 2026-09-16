# Satellite provisioning: cloud-init for a Pi

Status: template + write script done (`infra/cloud-init-satellite.yaml.tpl`,
`infra/provision-satellite-sd.sh`), not yet run against real hardware — no
Pi has been flashed or booted with this. Picks
up the "Provisioning story for a new satellite" open question in
`designs/satellite-hardware.md`, specifically the first-boot config step
(package installs, `unattended-upgrades`, Tailscale join, ...), mirroring
`infra/cloud-init.yaml.tpl`'s role for the main Hetzner server.

## It doesn't paste into anything — there's no console

The Hetzner flow works because the Hetzner Cloud Console has a "user
data" field you paste `infra/cloud-init.yaml.tpl` into at VM creation
time; cloud-init on the image reads that as its config on first boot.
There's no equivalent console for a Pi — you write an SD card yourself,
there's no provider dashboard in the loop.

Raspberry Pi Imager's own advanced options (⚙️, or Ctrl+Shift+X) look
similar — hostname, SSH key, username/password, Wi-Fi — but they are
**not** cloud-init. They're a Pi-Imager-specific mechanism that only
Raspberry Pi OS's first-boot scripts understand (it writes a
`userconf.txt`/`firstrun.sh` under the hood, unrelated to `#cloud-config`
syntax). Nothing on Raspberry Pi OS actually parses a `cloud-init.yaml`
file.

## The real option: it's already there, on Raspberry Pi OS itself

Corrected from an earlier draft of this file, which assumed Ubuntu Server
for Raspberry Pi was required: **Raspberry Pi OS has shipped real
cloud-init since the Bookworm release (Oct 2023)**, using the same
NoCloud datasource Ubuntu uses. No OS switch needed — stays on the plain
Raspberry Pi OS Lite pick from `designs/satellite-hardware.md`.
Mechanically, minimal steps:

1. Flash Raspberry Pi OS Lite (64-bit) with Raspberry Pi Imager — skip
   its own advanced-options customisation entirely (hostname/SSH/Wi-Fi
   toggles). cloud-init below replaces all of that, so there's nothing
   for Imager's own mechanism to do.
2. After flashing, mount the boot partition (shows up as `bootfs` on any
   machine) and drop a `user-data` file there — same `#cloud-config` YAML
   shape as `infra/cloud-init.yaml.tpl` (users/ssh keys, packages,
   `write_files`, `runcmd`).
3. An empty `meta-data` file alongside it — the NoCloud datasource expects
   one to exist even if blank.
4. Boot over ethernet (simplest — no Wi-Fi creds needed in the file). If
   ethernet isn't available at the install site, add a `network-config`
   file (netplan-style YAML) alongside `user-data` for Wi-Fi instead.

cloud-init runs on first boot exactly like it does on the Hetzner box —
same syntax, same `write_files`/`packages`/`runcmd` structure — just
delivered via files dropped on disk instead of pasted into a console
field. This lets this file's eventual `.yaml`/`.tpl` be a close sibling of
`infra/cloud-init.yaml.tpl` rather than a from-scratch mechanism.

## What's in it

`infra/cloud-init-satellite.yaml.tpl` — mirrors
`infra/cloud-init.yaml.tpl` section for section:

- `packages`/`package_update`/`package_upgrade` — `nodejs`/`npm` to run
  the satellite process, plus `unattended-upgrades`/`apt-listchanges`.
  whisper.cpp build deps (`build-essential`, `cmake`) and audio tooling
  (`alsa-utils`) are deliberately **not** in it yet — left out until the
  whisper.cpp service's own shape is decided (see Open questions in
  `designs/satellite-hardware.md`), rather than guessed at now.
- `write_files` — the `unattended-upgrades` config from
  `designs/satellite-hardware.md`'s "OS maintenance" section, written
  directly instead of the manual `dpkg-reconfigure` step (nobody's at
  this box to answer the debconf prompt); the satellite's own
  `/opt/capture-satellite/.env` (`HOUSE_ID`, `BACKEND_URL` — **no**
  `op://`/1Password anything, since `satellite/` has no `secrets.js`
  equivalent, only plain env vars per `satellite/.env.example`); a
  `capture-satellite.service` systemd unit running `npm start` in the
  cloned repo's `satellite/` directory.
- `runcmd` — Tailscale install/join (`tailscale up --authkey=...`, no
  `--snat-subnet-routes=false` here — that flag exists on the Hetzner box
  specifically to stop it masquerading *forwarded* traffic into a Docker
  bridge network; a satellite isn't forwarding subnet routes for anyone),
  clone the repo, `npm install` in `satellite/` and build the frontend,
  enable the service. whisper.cpp build and the GPIO button service are
  left as a comment, not yet added, for the same reason as above.
- Deliberately **not** included: `DIRIGERA_ACCESS_TOKEN`/`DIRIGERA_HOST`
  — that pairing (`npx dirigera authenticate`) is a one-time manual step
  done after first boot per `satellite/README.md`, not something to
  script into first-boot config.
- Display stack: `cage`/`seatd`/`chromium-browser` packages, `admin`
  added to `video`/`render`/`input` groups, a `getty@tty1` autologin
  drop-in, and `/opt/capture-satellite/kiosk.sh` (launched from
  `admin`'s `.bash_profile`, tty1 only) running `cage -- chromium-browser
  --kiosk --app=http://localhost:4000/?station` — see "Display stack:
  minimal, not headless" in `designs/satellite-hardware.md`.

`infra/provision-satellite-sd.sh` renders that template with `envsubst`
(explicitly scoped to just the template's own variables, so it doesn't
touch cloud-init/apt's own `${distro_codename}` syntax inside the
`unattended-upgrades` block) and writes `user-data` + an empty
`meta-data` onto the boot partition. It accepts either an already-mounted
directory (the common case — both macOS and most Linux desktops
auto-mount a card reader's boot partition on insert) or a raw block
device, which it mounts itself (`diskutil`/`udisksctl`) and unmounts
after writing. Required inputs: `HOUSE_ID`, `ADMIN_SSH_PUBLIC_KEY`,
`TAILSCALE_AUTH_KEY`, `BACKEND_URL` — no 1Password token, confirming the
"just two things" correction above; there simply isn't a third secret to
provide.

## Open questions

- Whether Tailscale's authkey should be one-time/ephemeral per satellite
  (matches "permanent kit, provisioned once" from Running modes in
  `designs/satellites.md`) or reusable — not decided.
- Nothing here has been tried against real hardware yet — no card has
  been written with this or booted; this is still one step behind
  `designs/satellite-hardware.md`, which itself has ordered no hardware.
- whisper.cpp and the GPIO button service aren't in the template — once
  their shape is decided, they get added to `runcmd`/`write_files` here.
- Display stack (cage + chromium-browser + tty1 autologin) is now in the
  template — see "Display stack: minimal, not headless" in
  `designs/satellite-hardware.md` — but unverified against real hardware,
  same caveat as everything else here.
