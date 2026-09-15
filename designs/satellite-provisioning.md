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

## The real option: Ubuntu Server for Raspberry Pi

Ubuntu's Raspberry Pi images (not Raspberry Pi OS) ship real cloud-init
with a **NoCloud** datasource: on first boot it looks for `user-data` and
`meta-data` files sitting in the boot partition itself. Mechanically:

1. Flash Ubuntu Server (64-bit) for Raspberry Pi with Raspberry Pi Imager
   (or `dd`/balenaEtcher) — this is a different OS choice from the
   Raspberry Pi OS Lite pick mentioned earlier in
   `designs/satellite-hardware.md`, not an addition to it.
2. Before first boot, mount the boot partition (it shows up as a normal
   FAT partition on any machine) and drop/edit `user-data` there — same
   `#cloud-config` YAML shape as `infra/cloud-init.yaml.tpl`.
3. Boot the Pi. cloud-init runs on first boot exactly like it does on the
   Hetzner box: same syntax, same `write_files`/`packages`/`runcmd`
   structure, just delivered via a file on disk instead of a pasted
   console field.

This would let this file's eventual `.yaml.tpl` be a close sibling of
`infra/cloud-init.yaml.tpl` — same templating approach (values filled in
before being written to the boot partition instead of pasted into a
web form) — rather than a from-scratch Pi-specific mechanism.

Ubuntu Server for Pi vs. Raspberry Pi OS is otherwise a wash for this
project's needs (Docker, Tailscale, and whisper.cpp all run fine on
either) — cloud-init support is the actual deciding factor if reusing
the existing template shape matters more than staying on the
Pi-Foundation-blessed image.

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

- Whether to actually switch off Raspberry Pi OS Lite for this, given
  `designs/satellite-hardware.md`'s parts list didn't consider it — no
  hardware conflict either way, it's a pure OS/first-boot-tooling choice.
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
