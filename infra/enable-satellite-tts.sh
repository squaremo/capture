#!/bin/sh
# Turns on local speech playback (Piper) on an already-bootstrapped
# satellite — the mirror image of enable-satellite-whisper.sh for the
# opposite direction (text in, audio out instead of audio in, text out).
# Run this once, over SSH, after cloud-init has already set the box up
# (see BOOTSTRAP.md/provision-satellite-sd.sh). Not part of first-boot
# provisioning itself, same treatment DIRIGERA_ACCESS_TOKEN gets.
#
# Two separate files need a line added, for two separate reasons — see
# docker-compose.satellite.yml's `tts` service comment:
#   - /opt/capture-satellite/.env         (the `satellite` container's own
#                                           app config — TTS_URL)
#   - /opt/capture-satellite/app/.env     (Compose's own project .env, read
#                                           by the `docker compose` CLI
#                                           itself, not by any container —
#                                           COMPOSE_PROFILES=tts)
# Idempotent: safe to re-run, only appends a line if it's not already
# present in some form. Preserves an existing whisper profile if one's
# already enabled (COMPOSE_PROFILES=whisper,tts), rather than clobbering
# it — running this and enable-satellite-whisper.sh in either order
# ends up at the same place. Then reconciles the compose stack
# immediately, under the same flock capture-satellite.service/
# capture-satellite-sync.timer use, so this doesn't have to wait for the
# 5-minute sync timer to notice.
set -e

APP_ENV=/opt/capture-satellite/.env
COMPOSE_ENV=/opt/capture-satellite/app/.env
COMPOSE_DIR=/opt/capture-satellite/app
LOCK=/var/lock/capture-satellite-compose.lock

if [ "$(id -u)" -ne 0 ]; then
  echo "Run as root (sudo) — writes to $APP_ENV and $COMPOSE_ENV." >&2
  exit 1
fi

add_line_if_missing() {
  file="$1"
  key="$2"
  value="$3"
  touch "$file"
  if grep -q "^${key}=" "$file"; then
    echo "$key already set in $file — leaving it as-is:"
    grep "^${key}=" "$file"
  else
    echo "${key}=${value}" >> "$file"
    echo "Added ${key}=${value} to $file"
  fi
}

add_line_if_missing "$APP_ENV" TTS_URL "http://127.0.0.1:5002"

# COMPOSE_PROFILES is comma-separated and could already carry the
# `whisper` profile (or others later) — see
# enable-satellite-whisper.sh's comment for why membership is checked
# by padding both sides with a comma rather than a fragile anchored
# regex.
touch "$COMPOSE_ENV"
current=$(grep '^COMPOSE_PROFILES=' "$COMPOSE_ENV" | tail -1 | cut -d= -f2-)
if [ -n "$current" ] && echo ",${current}," | grep -q ',tts,'; then
  echo "tts profile already enabled in $COMPOSE_ENV — leaving it as-is:"
  grep '^COMPOSE_PROFILES=' "$COMPOSE_ENV"
elif grep -q '^COMPOSE_PROFILES=' "$COMPOSE_ENV"; then
  sed -i -E "s/^COMPOSE_PROFILES=(.*)$/COMPOSE_PROFILES=\1,tts/" "$COMPOSE_ENV"
  echo "Appended tts to existing COMPOSE_PROFILES in $COMPOSE_ENV"
else
  echo "COMPOSE_PROFILES=tts" >> "$COMPOSE_ENV"
  echo "Added COMPOSE_PROFILES=tts to $COMPOSE_ENV"
fi

echo "Reconciling compose stack..."
cd "$COMPOSE_DIR"
flock "$LOCK" docker compose -f docker-compose.satellite.yml up -d --remove-orphans

echo
echo "Done. Check the tts service came up:"
echo "  docker compose -f $COMPOSE_DIR/docker-compose.satellite.yml logs tts"
echo "  curl http://127.0.0.1:5002/health"
echo "  curl http://127.0.0.1:5002/voices"
