#!/bin/sh
# Turns on system telemetry (the Beszel agent) for the central box itself —
# the hub's counterpart to enable-satellite-telemetry.sh. Run once, over
# SSH, after the Beszel hub is up and has an admin account (see
# designs/telemetry.md).
#
# Only the hub's public key is needed: this agent listens on a unix socket
# the hub dials (see docker-compose.yml's `beszel-agent`), so there's no
# hub URL or token. Get the key from the hub UI's "Add system" dialog.
#
#   sudo ./enable-hub-telemetry.sh "ssh-ed25519 AAAA..."
#
# Owns /opt/capture/beszel-agent.env outright (rewritten wholesale, so
# re-running rotates the key); COMPOSE_PROFILES in the compose project's
# own .env is shared, so that part is append-if-missing, exactly as the
# satellite scripts do it.
set -e

AGENT_ENV=/opt/capture/beszel-agent.env
COMPOSE_ENV=/opt/capture/app/.env
COMPOSE_DIR=/opt/capture/app

if [ "$(id -u)" -ne 0 ]; then
  echo "Run as root (sudo) — writes to $AGENT_ENV and $COMPOSE_ENV." >&2
  exit 1
fi

if [ $# -ne 1 ]; then
  echo "Usage: $0 <public-key>" >&2
  echo "  e.g. $0 \"ssh-ed25519 AAAA...\"" >&2
  exit 1
fi

umask 077
cat > "$AGENT_ENV" <<ENV
KEY=$1
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
# The hub gets recreated too if this is the first run since its socket
# volume was added; --force-recreate on the agent so a rotated key takes
# effect (Compose doesn't notice an env_file's *contents* changing).
docker compose up -d --remove-orphans
docker compose up -d --force-recreate --no-deps beszel-agent

echo
echo "Done. The hub system's Host/IP must be exactly"
echo "  /beszel_socket/beszel.sock"
echo "The system should go green within a few seconds. If not:"
echo "  docker compose -f $COMPOSE_DIR/docker-compose.yml logs beszel-agent"
