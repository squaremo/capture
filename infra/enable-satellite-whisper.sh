#!/bin/sh
# Turns on the whisper-stream voice-input mode on an already-bootstrapped
# satellite — run this once, over SSH, after cloud-init has already set
# the box up (see BOOTSTRAP.md/provision-satellite-sd.sh). Not part of
# first-boot provisioning itself, same treatment DIRIGERA_ACCESS_TOKEN
# gets in cloud-init-satellite.yaml.tpl: turning this on is an opt-in
# step a person decides on, not something to assume at image-build time.
#
# Two separate files need a line added, for two separate reasons — see
# docker-compose.satellite.yml's `whisper` service comment:
#   - /opt/capture-satellite/.env         (the `satellite` container's own
#                                           app config — WHISPER_URL)
#   - /opt/capture-satellite/app/.env     (Compose's own project .env, read
#                                           by the `docker compose` CLI
#                                           itself, not by any container —
#                                           COMPOSE_PROFILES=whisper)
# Idempotent: safe to re-run, only appends a line if it's not already
# present in some form (grep -q on the key), never blind-appends a
# duplicate. Then reconciles the compose stack immediately, under the
# same flock capture-satellite.service/capture-satellite-sync.timer use,
# so this doesn't have to wait for the 5-minute sync timer to notice.
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

add_line_if_missing "$APP_ENV" WHISPER_URL "http://127.0.0.1:5001"

# COMPOSE_PROFILES is comma-separated and could already carry other
# profiles later — grep -q on a bare "whisper" substring would also match
# "not-whisper", and anchoring "whisper" between (^|,) and (,|$) doesn't
# actually work when it's the *first* entry (no comma precedes it, and a
# mid-pattern ^ only matches genuine start-of-line, not "wherever .*
# stopped consuming") — so this pads both sides with a comma first and
# matches ",whisper," against that, the simplest correct way to check
# comma-separated membership.
touch "$COMPOSE_ENV"
current=$(grep '^COMPOSE_PROFILES=' "$COMPOSE_ENV" | tail -1 | cut -d= -f2-)
if [ -n "$current" ] && echo ",${current}," | grep -q ',whisper,'; then
  echo "whisper profile already enabled in $COMPOSE_ENV — leaving it as-is:"
  grep '^COMPOSE_PROFILES=' "$COMPOSE_ENV"
elif grep -q '^COMPOSE_PROFILES=' "$COMPOSE_ENV"; then
  sed -i -E "s/^COMPOSE_PROFILES=(.*)$/COMPOSE_PROFILES=\1,whisper/" "$COMPOSE_ENV"
  echo "Appended whisper to existing COMPOSE_PROFILES in $COMPOSE_ENV"
else
  echo "COMPOSE_PROFILES=whisper" >> "$COMPOSE_ENV"
  echo "Added COMPOSE_PROFILES=whisper to $COMPOSE_ENV"
fi

echo "Reconciling compose stack..."
cd "$COMPOSE_DIR"
flock "$LOCK" docker compose -f docker-compose.satellite.yml up -d --remove-orphans

echo
echo "Done. Check the whisper service came up:"
echo "  docker compose -f $COMPOSE_DIR/docker-compose.satellite.yml logs whisper"
echo "  curl http://127.0.0.1:5001/health"
