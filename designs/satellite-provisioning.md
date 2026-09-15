# Satellite provisioning: cloud-init for a Pi

Status: design only — no file written yet, no hardware provisioned. Picks
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

## What would live in it

Sketch, not yet written — mirrors `infra/cloud-init.yaml.tpl` section for
section:

- `packages` / `package_update` / `package_upgrade` — same idea as the
  Hetzner template's `runcmd` apt bootstrap, but for whisper.cpp build
  deps (`build-essential`, `cmake`) and audio tooling (`alsa-utils`) on
  top of what Hetzner needs.
- `write_files` — the `unattended-upgrades` config from
  `designs/satellite-hardware.md`'s "OS maintenance" section, written
  directly instead of run as a manual `dpkg-reconfigure` step.
- `runcmd` — Tailscale install/join (identical to the Hetzner template's
  block, same `--snat-subnet-routes=false` reasoning doesn't apply here
  since a satellite isn't forwarding subnet routes, but plain `tailscale
  up --authkey=...` still applies), whisper.cpp clone+build, GPIO/button
  service enablement once that script exists.
- House-id: per `designs/satellites.md`'s House attribution section, this
  is where `HOUSE_ID` would get baked in once at provisioning, matching
  how the satellite process already expects it as an env var.

## Open questions

- Where the templated `user-data` file would live/get generated from
  (a `.tpl` alongside `infra/cloud-init.yaml.tpl`, with its own fill-in
  mechanism, since there's no Terraform/console step to do the filling
  here — unlike Hetzner, nothing runs `envsubst`-equivalent for you).
- Whether Tailscale's authkey should be one-time/ephemeral per satellite
  (matches "permanent kit, provisioned once" from Running modes in
  `designs/satellites.md`) or reusable — not decided.
- Nothing here has been tried against real hardware; this is still one
  step behind `designs/satellite-hardware.md`, which itself has ordered
  no hardware yet either.
