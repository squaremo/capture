# Bootstrap a satellite (station)

The satellite counterpart to [`BOOTSTRAP.md`](BOOTSTRAP.md): an ordered
checklist for bringing up a new Pi station, from a blank SD card to an
optional-extras-enabled box. Each step points at where the detail lives
rather than repeating it. Assumes the central (Hetzner) box is already up.

## 1. Flash the SD card

Raspberry Pi Imager → Raspberry Pi OS (Bookworm or later). Its **Edit
Settings** step (hostname, user + SSH key, Wi-Fi, timezone) is fine to
use — the next step merges into what it writes rather than overwriting it.
See `designs/satellite-provisioning.md`'s "Merging into Imager's own
user-data".

## 2. Write the cloud-init config onto it

With the card's boot partition mounted:

```sh
HOUSE_ID=home \
TAILSCALE_AUTH_KEY="tskey-auth-..." \
BACKEND_URL="https://<server>.<tailnet>.ts.net" \
ADMIN_SSH_PUBLIC_KEY="ssh-ed25519 AAAA..." \
  infra/provision-satellite-sd.sh
```

`ADMIN_SSH_PUBLIC_KEY` isn't needed if Imager already created a user with
a key. See the header of `provision-satellite-sd.sh` for every option
(`MACHINE_HOSTNAME`, `DISABLE_BLUETOOTH`, `DISABLE_HDMI`, `--force`).

## 3. First boot and smoke test

Put the card in, power on, give cloud-init several minutes (it reboots
once, after the audio HAT driver install). Then SSH in and work through
[`satellite-smoke-test.md`](satellite-smoke-test.md) in order.

## 4. Register the house on the central box

So the backend can dispatch to it — on the Hetzner box, add the house to
`/opt/capture/data/satellites.json` (re-read on every request, no restart):

```json
{ "home": "http://<machine-hostname>.<tailnet>.ts.net" }
```

The key must match the satellite's `HOUSE_ID` — the backend checks it
against the satellite's own `/api/status`. See `designs/satellites.md`.

## 5. Optional extras

Each is independent; do any, all, or none. All run on the Pi as root, and
all survive the 5-minute `capture-satellite-sync` reconcile.

### Lights (Dirigera)

Pair once (see `satellite/README.md`'s "Dirigera setup"), put the token in
`/opt/capture-satellite/.env` as `DIRIGERA_ACCESS_TOKEN=` (and
`DIRIGERA_HOST=` if discovery can't find the hub), then recreate the
satellite container so it picks the token up (under the same lock the
sync timer uses):

```sh
cd /opt/capture-satellite/app
sudo flock /var/lock/capture-satellite-compose.lock \
  docker compose -f docker-compose.satellite.yml up -d --force-recreate satellite
```

### Local voice input (whisper)

```sh
sudo /opt/capture-satellite/app/infra/enable-satellite-whisper.sh
```

See `whisper/README.md`.

### Local speech output (tts)

```sh
sudo /opt/capture-satellite/app/infra/enable-satellite-tts.sh
```

See `tts/README.md`.

### Telemetry (Beszel)

Charts this Pi's CPU, memory, disk, network, SoC temperature and
per-container stats on the central box. See `designs/telemetry.md`.

1. Open `https://<server>.<tailnet>.ts.net:8090`. (First time ever: create
   the admin account straight away — the first visitor gets to.)
2. **Add system** and fill the dialog in fully — it's submitting it that
   registers the token with the hub; copying the values and closing it
   leaves the agent rejected with "Invalid token":
   - **Name** — the house id, or whatever you want on the dashboard.
   - **Host / IP** — this Pi's tailnet hostname. Required by the form but
     unused: the agent dials out to the hub, and its SSH listener is off.
   - **Port** — leave the default (45876); unused for the same reason.
3. Copy the **public key** and **token** it shows (they don't change
   between opening the dialog and submitting; reopen the system's edit
   dialog if you lose the token), then on the Pi:
   ```sh
   sudo /opt/capture-satellite/app/infra/enable-satellite-telemetry.sh \
     https://<server>.<tailnet>.ts.net:8090 "ssh-ed25519 AAAA..." <token>
   ```
4. The system should go green in the hub within a few seconds. If not:
   `docker compose -f /opt/capture-satellite/app/docker-compose.satellite.yml logs beszel-agent`.
