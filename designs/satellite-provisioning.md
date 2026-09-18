# Satellite provisioning: cloud-init for a Pi

Status: template + write script done (`infra/cloud-init-satellite.yaml.tpl`,
`infra/provision-satellite-sd.sh`), now deploying via Docker + Watchtower
(see "Docker + Watchtower deployment" below) instead of the original
direct `npm install`+systemd-unit approach, for the same self-updating
story the Hetzner box already has. First real boot attempted — caught
and fixed a real bug (see "Real-boot finding: write_files ordering"
below); otherwise still unconfirmed end to end. Picks
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
similar — hostname, SSH key, username/password, Wi-Fi. Older guidance
here said these were a separate, non-cloud-init `firstrun.sh` mechanism —
**that's only true on pre-cloud-init images.** On an actual cloud-init-
capable Raspberry Pi OS build, current Imager versions write Imager's
own settings *as real cloud-init files* — `user-data` (hostname, a
default user, timezone/keyboard) and a separate `network-config` (Wi-Fi)
— straight onto the boot partition, not `firstrun.sh` at all. Found by
running into it directly: a card someone had already run Edit Settings
on turned up with `user-data`/`meta-data`/`network-config` already
present, no `firstrun.sh`, no `systemd.run=` in `cmdline.txt`. So a
`user-data` may already exist here before this script ever runs — see
"Merging into Imager's own user-data" below for how the write script
handles that.

## The real option: it's already there, on Raspberry Pi OS itself

Corrected from an earlier draft of this file, which assumed Ubuntu Server
for Raspberry Pi was required: **Raspberry Pi OS has shipped real
cloud-init since the Bookworm release (Oct 2023)**, using the same
NoCloud datasource Ubuntu uses, and continues to on Trixie (Debian 13,
Oct 2025) — which is the actual OS in use for this box, not Bookworm.
No OS switch needed — stays on the plain Raspberry Pi OS Lite pick from
`designs/satellite-hardware.md`. Mechanically, minimal steps:

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
`infra/cloud-init.yaml.tpl` section for section, now including the same
Docker install block (identical `runcmd` steps: keyring, apt repo,
`docker-ce`/`docker-compose-plugin`, `systemctl enable --now docker`):

- `packages`/`package_update`/`package_upgrade` — no `nodejs`/`npm`
  anymore (the satellite process runs from the `capture-satellite` GHCR
  image now, not a local `npm start`); `unattended-upgrades`/
  `apt-listchanges`; the display-stack packages below. whisper.cpp build
  deps (`build-essential`, `cmake`) and audio tooling (`alsa-utils`) are
  deliberately **not** in it yet — left out until the whisper.cpp
  service's own shape is decided (see Open questions in
  `designs/satellite-hardware.md`), rather than guessed at now.
- `write_files` — the `unattended-upgrades` config from
  `designs/satellite-hardware.md`'s "OS maintenance" section; the
  satellite container's `/opt/capture-satellite/.env` (`HOUSE_ID`,
  `BACKEND_URL` — **no** `op://`/1Password anything, since `satellite/`
  has no `secrets.js` equivalent, only plain env vars per
  `satellite/.env.example`); `capture-satellite.service`
  (`docker compose -f docker-compose.satellite.yml up`, mirroring the
  hub's `capture.service`) and `capture-satellite-sync.service`/`.timer`
  (`git pull` + `docker compose up -d --remove-orphans` every 5 minutes,
  mirroring the hub's `capture-sync` — catches compose/nginx-config
  changes Watchtower can't see, since it only reacts to new *images*).
- `runcmd` — Tailscale install/join (`tailscale up --authkey=...`, still
  no `--snat-subnet-routes=false`: that flag exists on the Hetzner box
  specifically to stop it masquerading *forwarded* traffic into a Docker
  *bridge* network, and both satellite containers run with
  `network_mode: host` — there's no bridge for it to matter to); a TLS
  cert minted via `tailscale cert`, reading this box's own MagicDNS name
  back from `tailscale status --json` rather than taking it as a separate
  script input (needs "HTTPS Certificates" enabled in the tailnet's DNS
  settings, same as the hub); clone the repo and start
  `capture-satellite.service`/`capture-satellite-sync.timer`. whisper.cpp
  build and the GPIO button service are left as a comment, not yet added,
  for the same reason as above.
- Deliberately **not** included: `DIRIGERA_ACCESS_TOKEN`/`DIRIGERA_HOST`
  — that pairing (`npx dirigera authenticate`) is a one-time manual step
  done after first boot per `satellite/README.md`, not something to
  script into first-boot config.
- Display stack: `cage`/`seatd`/`chromium-browser` packages, `admin`
  added to `video`/`render`/`input` groups, a `getty@tty1` autologin
  drop-in, and `/opt/capture-satellite/kiosk.sh` (launched from
  `admin`'s `.bash_profile`, tty1 only) running `cage -- chromium-browser
  --kiosk --app=http://localhost/?station` — see "Display stack: minimal,
  not headless" in `designs/satellite-hardware.md`. Points at nginx's
  plain-HTTP `localhost` server block (`satellite/nginx.conf`) rather
  than the satellite container's own port 4000 directly, now that the
  container split (below) means the satellite process no longer serves
  the frontend build itself.

`infra/provision-satellite-sd.sh` renders that template with `envsubst`
(explicitly scoped to just the template's own variables, so it doesn't
touch cloud-init/apt's own `${distro_codename}` syntax inside the
`unattended-upgrades` block) and writes `user-data` + an empty
`meta-data` onto the boot partition. It accepts either an already-mounted
directory (the common case — both macOS and most Linux desktops
auto-mount a card reader's boot partition on insert) or a raw block
device, which it mounts itself (`diskutil`/`udisksctl`) and unmounts
after writing. `network-config` and any existing `meta-data` are never
touched. `TAILSCALE_AUTH_KEY`/`BACKEND_URL` are always required; whether
`HOUSE_ID`/`ADMIN_SSH_PUBLIC_KEY` are needed depends on whether it's
merging (see below) — no 1Password token either way, confirming the
"just two things" correction above.

## Merging into Imager's own user-data

Discovered while actually provisioning a card: a `user-data` written by
Raspberry Pi Imager's Edit Settings (see the correction above) may
already be sitting on the boot partition before this script ever runs —
and it carries real content worth keeping (a default user with an SSH
key, `timezone`/`keyboard`, `avahi-daemon`, an `Acquire::Check-Date
"false"` apt workaround for a Pi's often-wrong first-boot clock,
`systemctl enable --now ssh`). Blindly overwriting it, which is what an
earlier version of this script did unconditionally, would silently
discard all of that.

So the script now **merges** rather than overwrites, when a non-empty
`user-data` already exists (needs `python3` with PyYAML —
`pip3 install pyyaml` — to actually do the merge; falls back to refusing
outright and pointing at `--force` if that's missing):

- **Existing hostname wins by default, but an explicit `MACHINE_HOSTNAME`
  overrides it — and `HOUSE_ID` is a separate thing entirely.** Both
  become optional here — read back from the existing file instead, so
  the Linux hostname, Tailscale hostname, and the eventual MagicDNS name
  all end up as one consistent value instead of two competing ones. But
  `MACHINE_HOSTNAME`/`HOUSE_ID` aren't actually the same variable, even
  though they default to the same value: `MACHINE_HOSTNAME` is the
  Linux/Tailscale hostname (`cloud-init-satellite.yaml.tpl`'s `hostname:`
  and `tailscale up --hostname=`); `HOUSE_ID` is only the satellite
  process's own house identity (`/opt/capture-satellite/.env`'s
  `HOUSE_ID=` — what the frontend's house chooser and `GET /api/status`
  show, per House attribution in `designs/satellites.md`). Passing
  `HOUSE_ID` alone renames the satellite's app-level identity without
  touching its actual machine/Tailscale hostname (a printed `NOTE:` says
  when `MACHINE_HOSTNAME` overrode Imager's, which only happens if you
  explicitly set that one too).
- **Existing default user wins, this template's own `users:` block is
  dropped.** Running both a `users:` list entry (this template) and a
  singular `user:` block or its own `users:` list (Imager's) for
  possibly-conflicting attributes of the same, or a different, account
  is genuinely ambiguous in cloud-init — so rather than try to reconcile
  field-by-field, the merge just picks the existing account and skips
  creating a second one. `ADMIN_SSH_PUBLIC_KEY` becomes optional in this
  case too, for the same reason.
  `cloud-init-satellite.yaml.tpl` had to be changed to make this
  possible: the account name used throughout (autologin, the kiosk
  `.bash_profile`, `usermod -aG video,render,input`) is now `${ADMIN_USER}`
  rather than a hardcoded `admin`, defaulting to `admin` when there's no
  existing user to reuse, or set to the discovered name when there is.
- **Everything else concatenates or shallow-merges**: `packages`,
  `write_files`, and `runcmd` are list-appended (existing's entries
  first, then this template's); dict-valued keys like `apt` merge
  key-by-key with the existing side winning on overlap. Nothing in this
  template currently collides with Imager's file on a plain scalar other
  than `hostname`, already handled above.
- `--force` skips merging entirely and overwrites `user-data` outright
  (the old unconditional behaviour) — for when there's deliberately
  nothing in the existing file worth keeping.

Verified locally against a fixture shaped like a real Imager-written
file (hostname/default-user/timezone/keyboard/apt/ssh-enable, as pasted
during this same conversation) — merge, fresh-provision, and `--force`
paths all produce the expected `user-data`, including a round-trip check
that YAML's line-folding on long `runcmd` strings (e.g. the Docker apt
repo line) reparses back to the exact original single-line command. Not
yet verified against an actual card/real boot, same caveat as everything
else here.

## Docker + Watchtower deployment

Decision, following a design discussion: deploy the satellite the same
way as the Hetzner hub — GHCR images, Watchtower polling and
auto-restarting on a new image, `capture-sync`-style config reconciliation
— rather than the original `npm install` + hand-rolled systemd unit this
file described above. Same self-update story, same operational model,
one thing not to have to remember differently between the hub and every
satellite.

**Two containers, not one**, mirroring the hub's own `backend`+`nginx`
split rather than one process doing everything:

- **`satellite`** — the API/controller only (`satellite/server.js`), no
  static file serving. Runs with `network_mode: host`, for two
  independent reasons: SSDP discovery (`sonos-discovery`) is UDP
  multicast, which doesn't reliably cross Docker's default bridge/NAT —
  host networking is the standard fix, same reasoning as running
  Home Assistant with host networking for SSDP/mDNS/UPnP; and the
  process's own bind-to-Tailscale-interface logic (see Running modes in
  `designs/satellites.md`) needs to actually see the host's `tailscale0`
  interface, which a bridge-networked container wouldn't — Tailscale
  itself runs on the host, not containerized, same as the hub.
- **`nginx`** — serves the built `frontend/dist`, terminates TLS (same
  role as the hub's nginx), and reverse-proxies `/api/*` and
  `/config.json` to the satellite container. `/config.json` can't be a
  static file either way — it's generated per-request from the
  satellite's own env vars (`defaultHouse`/`backendUrl`) — so it has to
  be proxied regardless of whether the split happens. Also on
  `network_mode: host` (listening on 80/443, `proxy_pass
  http://127.0.0.1:4000` for the proxied paths) — since the satellite
  container is host-networked, that's the only way for nginx to reach it
  without a shared Docker bridge network in between.

Splitting also **removes** the satellite process's own
`TLS_CERT_PATH`/`TLS_KEY_PATH` env vars (`satellite/README.md`'s HTTPS
section — its way of terminating HTTPS itself, with no nginx involved):
redundant once nginx does it, one less cert-renewal thing for the
satellite process to worry about, and consistent with the hub where
nginx (not the backend) is the one thing that terminates real TLS.

**Implemented:**

- `satellite/Dockerfile` — API/controller image only, no frontend build
  baked in.
- `satellite/nginx.conf` — mounted over the *existing* `capture-frontend`
  GHCR image's default config (same image the hub already builds via
  `frontend/Dockerfile`/`build-frontend.yml` — no separate frontend image
  needed for a satellite, just a different mounted nginx config, same
  trick the hub's own `docker-compose.yml` already uses for its
  `nginx.conf`). Proxies `/api/`/`/config.json` to `127.0.0.1:4000`
  (loopback, not Docker DNS, since both containers are host-networked).
  Adds a third server block specifically for `Host: localhost` on plain
  `:80`, so the on-box kiosk (see Display stack, above) never has to
  contend with the self-signed cert (minted for this box's Tailscale
  name, not `localhost`) throwing a cert-mismatch interstitial with no
  one there to click through it — browsers already treat `localhost` as
  a secure context regardless of TLS, so voice capture is unaffected.
  Any other `Host:` on `:80` still gets redirected to HTTPS, same as the
  hub's `nginx.conf`.
- `docker-compose.satellite.yml` (repo root, alongside the hub's
  `docker-compose.yml`) — `satellite` + `nginx` (both `network_mode:
  host`) + `watchtower` (identical config to the hub's).
- `.github/workflows/build-satellite.yml` — new workflow, pushing
  `ghcr.io/squaremo/capture-satellite`. Built for `linux/amd64,
  linux/arm64` (via QEMU + Buildx) — arm64 for the Pi, amd64 kept for the
  laptop-bootstrap running mode in `designs/satellites.md` so the same
  tag works either way.
- `build-frontend.yml` gained the same `linux/amd64,linux/arm64`
  platforms, since `capture-frontend` is now the image both the hub *and*
  every satellite's nginx container run.
- `infra/cloud-init-satellite.yaml.tpl` updated to install Docker
  (identical block to `infra/cloud-init.yaml.tpl`) instead of
  `nodejs`/`npm`, and to run `capture-satellite.service`/
  `capture-satellite-sync.timer` (mirroring the hub's `capture.service`/
  `capture-sync.timer`) instead of a bare `npm start` unit. Also now
  mints its own TLS cert via `tailscale cert`, reading this box's MagicDNS
  name back from `tailscale status --json` rather than needing it as a
  separate script input.

None of this has been built or run — no image has been pushed, no
compose stack started, no Pi has pulled any of it yet.

Considered and rejected: one container doing both (serving the frontend
build itself via `@fastify/static`, as it already does today outside
Docker). Simpler to deploy — one image, one Watchtower target — but it
means the API process's own restart/rebuild cadence is coupled to the
frontend build's, and it doesn't get the TLS-termination or
static-serving separation the hub already has. Splitting costs one more
moving part (the nginx↔satellite proxy wiring, both needing host
networking to find each other) in exchange for matching the hub's shape
and decoupling frontend/API update cycles — worth it for consistency
across the two places this app runs, so this is the chosen shape, not
just a documented alternative.

## Real-boot finding: write_files ordering

First real boot (against the actual `capture-station-1` card) surfaced
a genuine bug, not a hardware-specific quirk: `cloud-init status --long`
reported `write_files` failing four times with `OSError('Unknown user
or group: "getpwnam(): name not found: \'mikeb\'"')`.

Cause: cloud-init's default module order runs `write_files` **before**
the `users`/`user` module — so the `.bash_profile` entry's
`owner: ${ADMIN_USER}:${ADMIN_USER}` tried to `chown` to an account that
didn't exist yet at that point in the boot sequence. This wasn't
specific to reusing Imager's `mikeb` — it would have failed exactly the
same way creating a fresh `admin` account too; merging just happened to
be what actually got booted first.

Not as bad as it sounds, and worth understanding why: cloud-init catches
each module's failure independently and keeps going to the next one
(confirmed by SSH access working at all — `users-groups` ran fine
afterward, later in the sequence). **Corrected against what was checked
on the real box, though**: this doc first guessed that `write_files`
sets a file's content before applying ownership, so the file would
still land, just `root`-owned — checking on the actual booted box
showed the file didn't exist at all. So this Pi OS/cloud-init version
validates the `owner:` field *before* writing anything, meaning the
whole write aborted, not just the ownership step — a real distinction
worth having gotten right the first time rather than assumed.

Fixed in `cloud-init-satellite.yaml.tpl`: that entry now writes
`root:root` (no `owner:` at all) and a new first `runcmd` line chowns
it afterward, once the account genuinely exists — `runcmd` runs safely
after `users-groups` in cloud-init's module order. (Superseded slightly
by the next section below — it's `${KIOSK_USER}` that owns this file
now, not `${ADMIN_USER}`.)

## Real design fix: a dedicated kiosk account, not the SSH login

Prompted by a direct question while debugging the above: why should the
account that auto-launches an unattended browser on the physical
console be the *same* account used for personal SSH/admin access?
It shouldn't, for reasons that go beyond the write_files bug above:

- bash sources `~/.bash_profile` on every interactive SSH login too,
  not just a physical console login — sharing one account here means
  editing your own dotfiles risks breaking the kiosk launch, and vice
  versa, two unrelated concerns tangled in one file.
- The kiosk session had no reason to inherit sudo or SSH-key access —
  a dedicated, unprivileged account is strictly less to worry about if
  the browser it runs were ever compromised.

So `cloud-init-satellite.yaml.tpl`'s `users:` list now has two entries
instead of one:

- `${ADMIN_USER}` — SSH/admin only (`sudo`, the SSH key), exactly as
  before, still dropped by the merge script in favour of reusing an
  existing default user (Imager's `mikeb`, say) when there is one.
- `${KIOSK_USER}` (default `kiosk`) — the tty1 autologin account, with
  the group memberships `cage` needs (`video`/`render`/`input`), no
  sudo, no SSH key, `lock_passwd: true`. **Always created fresh**, whether
  merging or not — unlike the admin entry, there's no existing account
  to reuse here, since Imager has no concept of "the kiosk account."

That last point needed a real fix in `provision-satellite-sd.sh`'s
merge step, not just the template: it used to drop the *entire*
`users:` key when reusing an existing default user, which would have
thrown away the newly-added kiosk entry too. It now filters the
rendered `users:` list by name, removing only the admin entry
(`DROP_ADMIN_USER`, renamed from `DROP_USERS_BLOCK`) and always keeping
the kiosk one — verified locally: merging into a fixture shaped like
the real `mikeb` file produces a `user:` block unchanged and a
`users:` list containing only `kiosk`, while the fresh-provision path
produces both `admin` and `kiosk` together.

## Real-boot finding: concurrent docker compose invocations

First real boot surfaced a genuine bug: SSH sessions became "terribly
slow" — `top` showed 60%+ iowait and a load average over 7 on a 4-core
box, with a `cp` process stuck in `D` state (blocked on disk). `ps aux`
showed the actual cause: **two `docker compose up` processes running
against the same project at once** — `capture-satellite.service`'s own
long-lived foreground `up`, and `capture-satellite-sync.service`'s
`up -d --remove-orphans` (its `OnBootSec=5min` timer landing right in
the middle of the first one still pulling/starting containers). Both
doing pull/extract/start work simultaneously on the same SD card is
exactly what hammers it into unusability.

Same pattern exists in the Hetzner hub's own `infra/cloud-init.yaml.tpl`
(`capture.service` + `capture-sync.timer`, identical shape) — this
project mirrored it deliberately. It likely races there too; it just
doesn't visibly hurt on the hub's real disk the way it does on a Pi's
SD card, so it never surfaced as a problem worth noticing.

Fixed two ways for the satellite, not just one:

1. **`capture-satellite.service` no longer needs to run in the
   foreground at all.** Every service in `docker-compose.satellite.yml`
   already has `restart: unless-stopped` — Docker itself handles
   crash-restart with no systemd supervision needed. Changed to
   `Type=oneshot`/`RemainAfterExit=yes`/`up -d` (brings the stack up
   once, exits, no permanent process to race against) instead of
   `Type=simple`/a foreground `up` kept alive by `Restart=on-failure`.
2. **`flock` around both services' compose invocations**, against a
   shared `/var/lock/capture-satellite-compose.lock` — belt-and-
   suspenders on top of (1): the oneshot fix narrows the race window to
   "however long the first `up -d` takes," but doesn't structurally
   rule it out if a pull genuinely takes longer than 5 minutes. `flock`
   makes concurrent invocations impossible regardless of timing, rather
   than just less likely.

Not backported to the hub's `capture.service`/`capture-sync.timer` —
out of scope for this satellite-focused work, and the hub hasn't
actually shown symptoms — but worth doing at some point for the same
reason, on general principle rather than an observed failure there.

## Real finding: the satellite image has never actually built

Tracked down while debugging why `capture-satellite.service` failed
outright with `denied`/`No such image` pulling
`ghcr.io/squaremo/capture-satellite` — first guessed as a GHCR
visibility setting (new packages pushed via a workflow's
`GITHUB_TOKEN` default to private), confirmed *wrong* by actually
checking: `ghcr.io/token` anonymous-pull requests succeeded for
`capture-frontend` but were denied for `capture-satellite` — consistent
with either "private" or "doesn't exist." Checking the actual
`build-satellite.yml` run history settled it: **it has failed on every
run since it was created — one run total, and that one failed** — the
image was never pushed at all, denied or not.

Real cause, from the build log: `npm install --omit=dev` fails inside
`satellite/Dockerfile`'s `node:22-alpine` with `npm error syscall spawn
git` / `ENOENT`. `satellite/package.json`'s `sonos-discovery` dependency
is GitHub-sourced (`github:jishi/node-sonos-discovery#v1.8.0` — see
`satellite/README.md` for why: the npm-published version predates a
Node 20 compatibility fix only ever tagged on GitHub), so npm needs
`git` on the image to fetch it at install time — and `node:22-alpine`
doesn't ship `git`. Fixed with one line in `satellite/Dockerfile`
(`RUN apk add --no-cache git`, before `npm install`). Neither
`frontend/Dockerfile` nor `backend/Dockerfile` have any git-sourced
dependency, so this was specific to the satellite image, not a class of
bug across all three.

Worth being honest about the sequence here: this bug predates, and is
unrelated to, both the write_files/module-ordering fix and the compose
race fix above — it means every "should be running now" assumption made
about the satellite container in this whole design doc, from the very
first Docker-deployment commit onward, was never actually true. The
box's Sonos/Dirigera capability and the frontend it's meant to serve
have not been running at all — only `nginx` (an existing, working image)
and `watchtower` were ever real; `capture-satellite.service` failing to
pull is what surfaced this, several boots and fixes later than it
should have been caught.

## Real finding: install.sh's relative path filled the disk

Once the image finally pulled, `capture-satellite.service` failed
again — this time with a containerd write error. `df -h` showed why:
the 29G root partition was **100% full, 0 available**. `du` narrowed it
to one directory: `/usr/src/wm8960-soundcard-1.0` alone was 23G, and
inside it sat `proc/`, `boot/`, `etc/`, `opt/` — top-level root
directory names, not driver source.

Cause: the WM8960 install script calls `install_module "./"
"wm8960-soundcard"`, which does `cp -a $src/* /usr/src/$mod-$ver/` with
`$src="./"`. That `./` resolves against whatever directory the script
is *run from*, not the script's own location — and this project's
`runcmd` ran it as `bash /opt/wm8960-audio-hat/install.sh` with no `cd`
first. `runcmd` commands execute with cwd `/`, so `./` meant `/`, and
the script copied the entire root filesystem's top-level contents into
its own module source directory. Filling the disk took down everything
downstream of it — Docker pulls, SSH responsiveness, all of it — as a
single shared symptom that took three separate diagnostic rounds to
trace back to one cause.

Fixed in `cloud-init-satellite.yaml.tpl`: `cd /opt/wm8960-audio-hat &&
bash install.sh` as one `runcmd` line, not a bare
`bash /opt/wm8960-audio-hat/install.sh`. Immediate relief on the
already-booted box was `rm -rf /usr/src/wm8960-soundcard-1.0` (after
`dkms remove wm8960-soundcard/1.0 --all` if it had registered) to
reclaim the space — a reflash would also have picked up the fix, but
cost far more than deleting one directory and retrying.

## Real finding: cage needs XDG_RUNTIME_DIR set explicitly

Once the disk was cleared and the kiosk account existed, `getty@tty1`
was still failing — `systemctl status` showed `start-limit-hit`,
`agetty` exiting almost instantly and repeatedly, fast enough to trip
systemd's restart rate limit. Running `kiosk.sh` by hand as the kiosk
user (`sudo -u kiosk /opt/capture-satellite/kiosk.sh`) surfaced the
actual error immediately instead of it vanishing into an unwatched
console: `cage.c: XDG_RUNTIME_DIR is not set in the environment`.

Cause: `cage` requires `XDG_RUNTIME_DIR`, normally set up by
`pam_systemd`/`logind` as part of establishing a full login session —
but a bare console `agetty --autologin` doesn't reliably trigger that
the way a graphical or systemd-managed session would. Without it,
`cage` exits immediately, which ends the whole login session, which
makes `agetty` exit too, which systemd immediately restarts — looping
fast enough to hit `start-limit-hit` and give up entirely, rather than
sitting at a visibly broken kiosk.

Fixed in `kiosk.sh` itself rather than relying on session-manager
plumbing: exports `XDG_RUNTIME_DIR=/run/user/$(id -u)` and creates that
directory (`mkdir -p`, `chmod 700`) before `exec`ing into `cage` — the
standard fix for `cage` on exactly this kind of minimal console-login
setup, not something specific to this project's template.

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
