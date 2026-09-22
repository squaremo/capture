#!/bin/sh
# Turns on system telemetry (the Beszel agent) on an already-bootstrapped
# satellite — run this once, over SSH, after cloud-init has set the box up.
# Same opt-in shape as enable-satellite-whisper.sh, for the same reason:
# it needs credentials only the hub can issue, which don't exist at
# image-build time.
#
# Get the three values from the Beszel hub UI
# (https://<hub>.<tailnet>.ts.net:8090 → "Add system"): the public key and
# token it shows. HUB_URL is that same https://...:8090 origin.
#
#   sudo ./enable-satellite-telemetry.sh \
#     https://capture.<tailnet>.ts.net:8090 "ssh-ed25519 AAAA..." <token>
#
# Unlike the whisper script, this one owns its env file outright
# (/opt/capture-satellite/beszel-agent.env — see docker-compose.satellite.yml's
# `beszel-agent` comment for why it's separate from the satellite's .env), so
# it rewrites it wholesale rather than appending: re-running with fresh
# values is how you rotate them. COMPOSE_PROFILES is shared, so that part
# is append-if-missing, exactly as enable-satellite-whisper.sh does it.
set -e

AGENT_ENV=/opt/capture-satellite/beszel-agent.env
COMPOSE_ENV=/opt/capture-satellite/app/.env
COMPOSE_DIR=/opt/capture-satellite/app
LOCK=/var/lock/capture-satellite-compose.lock

if [ "$(id -u)" -ne 0 ]; then
  echo "Run as root (sudo) — writes to $AGENT_ENV and $COMPOSE_ENV." >&2
  exit 1
fi

if [ $# -ne 3 ]; then
  echo "Usage: $0 <hub-url> <public-key> <token>" >&2
  echo "  e.g. $0 https://capture.<tailnet>.ts.net:8090 \"ssh-ed25519 AAAA...\" <token>" >&2
  exit 1
fi

case "$1" in
  https://*) ;;
  *) echo "Hub URL must be https:// (nginx on the hub terminates TLS on :8090)." >&2; exit 1 ;;
esac

umask 077
cat > "$AGENT_ENV" <<ENV
HUB_URL=$1
KEY=$2
TOKEN=$3
ENV
chmod 600 "$AGENT_ENV"
echo "Wrote $AGENT_ENV"

# See enable-satellite-whisper.sh for why membership is checked against
# ",${current}," rather than a bare substring or an anchored pattern.
touch "$COMPOSE_ENV"
current=$(grep '^COMPOSE_PROFILES=' "$COMPOSE_ENV" | tail -1 | cut -d= -f2-)
if [ -n "$current" ] && echo ",${current}," | grep -q ',telemetry,'; then
  echo "telemetry profile already enabled in $COMPOSE_ENV — leaving it as-is:"
  grep '^COMPOSE_PROFILES=' "$COMPOSE_ENV"
elif grep -q '^COMPOSE_PROFILES=' "$COMPOSE_ENV"; then
  sed -i -E "s/^COMPOSE_PROFILES=(.*)$/COMPOSE_PROFILES=\1,telemetry/" "$COMPOSE_ENV"
  echo "Appended telemetry to existing COMPOSE_PROFILES in $COMPOSE_ENV"
else
  echo "COMPOSE_PROFILES=telemetry" >> "$COMPOSE_ENV"
  echo "Added COMPOSE_PROFILES=telemetry to $COMPOSE_ENV"
fi

echo "Reconciling compose stack..."
cd "$COMPOSE_DIR"
# --force-recreate on just this service so rotated credentials take effect
# (Compose doesn't notice an env_file's *contents* changing).
flock "$LOCK" docker compose -f docker-compose.satellite.yml up -d --remove-orphans
flock "$LOCK" docker compose -f docker-compose.satellite.yml up -d --force-recreate --no-deps beszel-agent

echo
echo "Done. Check the agent connected (the system should go green in the hub UI):"
echo "  docker compose -f $COMPOSE_DIR/docker-compose.satellite.yml logs beszel-agent"
