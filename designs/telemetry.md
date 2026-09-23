# Telemetry: charting satellite health

Status: wired up in compose/nginx, not yet run against real hardware.

## Shape

Off-the-shelf rather than built into capture: **[Beszel](https://github.com/henrygd/beszel)**,
a small hub + agent pair.

- **Hub** — `beszel` service in `docker-compose.yml`, on the central
  (Hetzner) box. Stores history in its own SQLite DB under
  `/opt/capture/beszel` (deliberately *not* inside `/opt/capture/data`,
  which is the item store's git repo) and serves the charts. nginx
  terminates TLS for it on its own port, **:8090**, with the same
  Tailscale cert as the app, and only admits tailnet source addresses.
- **Hub's own agent** — `beszel-agent` service in `docker-compose.yml`,
  so the central box is charted alongside the Pis (CPU, memory, disk,
  network, and per-container stats for backend/nginx/beszel/watchtower).
  Same image, wired the other way round: it listens on a unix socket in
  a directory shared with the hub (`/opt/capture/beszel-socket`) and the
  hub dials it — Beszel's documented same-host setup — so it needs only
  the hub's public key, no token, and opens no TCP port. Opt-in behind
  the `telemetry` profile like the satellite agent.
- **Satellite agent** — `beszel-agent` service in `docker-compose.satellite.yml`,
  opt-in behind the `telemetry` Compose profile like `whisper`/`tts`.
  Dials *out* to the hub over a WebSocket (`wss://<hub>:8090`), so the hub
  never needs to reach the Pi. `DISABLE_SSH=true` stops it also opening
  its default SSH listener on :45876, which under `network_mode: host`
  would face the whole house LAN.

What you get charted per satellite: CPU, load, memory/swap, disk usage
and I/O, network, SoC temperature (`cpu_thermal`, from `/sys`), and per-
container CPU/memory (`satellite`, `nginx`, `whisper`, `tts`, …) via the
read-only Docker socket. Alerts (e.g. temperature over a threshold, box
went offline) are configurable in the hub UI.

Why not the alternatives: Prometheus + node_exporter + Grafana is more
flexible but three services and a pile of config on a small VM for one
or two Pis; building it into capture would mean its own time-series
storage (the markdown store is the wrong shape for that) and our own
charting, for less than Beszel gives for free.

## Setup

(Also step 5 of `infra/BOOTSTRAP-SATELLITE.md`, for a new station.)

(The satellite steps; the hub's own agent is below.)

1. Merge to `main` — `capture-sync` brings up the hub and nginx's new
   :8090 listener on its next run (≤5 min), no SSH needed.
2. Open `https://<server>.<tailnet>.ts.net:8090` and create the admin
   account (the first visitor gets to — fine on a single-user tailnet,
   but do it straight away).
3. **Add system** in the hub UI and submit it — submitting is what
   registers the token (closing without submitting leaves the agent
   rejected with "Invalid token"). Name it after the house; Host is the
   Pi's tailnet hostname and Port the default 45876 — both required by
   the form, neither used, since the agent dials out and has SSH off.
   Copy the public key and token it shows.
4. On the Pi:
   ```sh
   sudo /opt/capture-satellite/app/infra/enable-satellite-telemetry.sh \
     https://<server>.<tailnet>.ts.net:8090 "ssh-ed25519 AAAA..." <token>
   ```
   Writes `/opt/capture-satellite/beszel-agent.env` (0600), turns on the
   `telemetry` profile, and starts the agent. Re-run with new values to
   rotate them.

### The hub itself

Same first two steps, then:

1. **Add system** in the hub UI: Name it after the server, **Host / IP**
   exactly `/beszel_socket/beszel.sock` (the socket path as the hub
   container sees it), Port left as-is. Submit, and copy the public key.
2. On the server (`ssh admin@<server>.<tailnet>.ts.net`):
   ```sh
   sudo /opt/capture/app/infra/enable-hub-telemetry.sh "ssh-ed25519 AAAA..."
   ```
   Writes `/opt/capture/beszel-agent.env` (0600), adds `telemetry` to
   `COMPOSE_PROFILES` in `/opt/capture/app/.env` (which both
   `capture.service` and `capture-sync` read, so it survives reboots and
   syncs), and starts the agent. Re-run with a new key to rotate it.

## Claude token counts and costs

Not in Beszel — it has no custom-metric input (same gap as throttling
below) — so the app records these itself. Each capture's one Claude call
stores its `usage` on the item (`input_tokens`, `output_tokens`, cache
read/write tokens, `model`, and `cost_usd` priced from `PRICING` in
`backend/integrations/claude.js` — update that table if the model
changes). Approvals and favourite replays never call Claude, so this is
the whole bill. `GET /api/usage` sums it for today, this month (UTC) and
all-time; the inbox's stats footer shows this month's tokens and cost.
Items from before this existed have no `usage` and just don't count.

## Gap: throttling / undervoltage

Beszel has no notion of the Pi firmware's throttle flags
(`vcgencmd get_throttled` — undervoltage, ARM frequency capped,
throttled, soft temperature limit, now and since boot), and no way to
ingest a custom metric. Temperature covers the thermal half indirectly;
undervoltage (a weak PSU — the classic cause of flaky Pis) has no
stand-in. See `TODO.md`.
