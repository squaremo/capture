#!/usr/bin/env bash
set -euo pipefail

# Renders cloud-init-satellite.yaml.tpl and writes user-data + meta-data
# onto a Raspberry Pi OS SD card's boot partition (bootfs), so cloud-init
# provisions the satellite on first boot. See
# ../designs/satellite-provisioning.md for the design this implements.
#
# Usage:
#   HOUSE_ID=home \
#   ADMIN_SSH_PUBLIC_KEY="ssh-ed25519 AAAA..." \
#   TAILSCALE_AUTH_KEY="tskey-auth-..." \
#   BACKEND_URL="https://capture.<tailnet>.ts.net" \
#   ./provision-satellite-sd.sh [--force] [bootfs-mount-point-or-device]
#
# Raspberry Pi Imager's own "Edit Settings" step, on a cloud-init-capable
# image, writes its OWN user-data/network-config/meta-data directly
# (hostname, a default user, timezone/keyboard, Wi-Fi) rather than the
# older firstrun.sh mechanism — so a user-data may already exist here
# before this script ever runs. If it does, this script MERGES into it
# rather than overwriting it: Imager's hostname wins by default (HOUSE_ID
# is only needed as a fallback when there's no existing user-data at
# all) — but an explicitly-passed HOUSE_ID overrides it, if you want a
# different hostname than whatever Imager set. And if Imager already
# created a default user, this script's own `users:`
# block is dropped in favour of reusing that account for the kiosk
# session (ADMIN_SSH_PUBLIC_KEY isn't needed in that case either — the
# existing user-data already carries a key) — see the note on `users:`
# in cloud-init-satellite.yaml.tpl. Needs python3 with PyYAML
# (`pip3 install pyyaml`) to do this merge; --force skips merging
# entirely and overwrites user-data outright, network-config/meta-data
# are never touched either way.
#
# The target arg can be:
#   - a directory: an already-mounted boot partition (e.g. auto-mounted
#     at /Volumes/bootfs on macOS, or /media/<user>/bootfs on Linux) —
#     used directly, nothing is mounted/unmounted.
#   - a block device (e.g. /dev/sdb1, /dev/disk4s1): mounted with
#     udisksctl (Linux) or diskutil (macOS), written to, then unmounted.
#   - omitted: looks for a bootfs/BOOTFS partition already mounted under
#     the usual auto-mount locations.
#
# Doesn't format or partition anything — the SD card must already have
# Raspberry Pi OS (Bookworm or later) flashed onto it.

: "${TAILSCALE_AUTH_KEY:?set TAILSCALE_AUTH_KEY}"
: "${BACKEND_URL:?set BACKEND_URL}"
REPO_URL="${REPO_URL:-https://github.com/squaremo/capture.git}"

command -v envsubst >/dev/null || {
  echo "envsubst not found (part of gettext) — install it first." >&2
  exit 1
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE="$SCRIPT_DIR/cloud-init-satellite.yaml.tpl"

find_mounted_bootfs() {
  for candidate in /media/*/bootfs /media/*/BOOTFS /Volumes/bootfs /Volumes/BOOTFS; do
    [ -d "$candidate" ] && { echo "$candidate"; return 0; }
  done
  return 1
}

mount_device() {
  local device="$1"
  if [ "$(uname)" = "Darwin" ]; then
    diskutil mount "$device" >&2
    diskutil info "$device" | awk -F': *' '/Mount Point/ {print $2}'
  else
    udisksctl mount -b "$device" --no-user-interaction >&2
    lsblk -no MOUNTPOINT "$device"
  fi
}

unmount_device() {
  local mount_point="$1"
  if [ "$(uname)" = "Darwin" ]; then
    diskutil unmount "$mount_point" >&2
  else
    udisksctl unmount -p "$mount_point" >&2 || umount "$mount_point"
  fi
}

FORCE=""
ARGS=()
for arg in "$@"; do
  if [ "$arg" = "--force" ]; then
    FORCE=1
  else
    ARGS+=("$arg")
  fi
done

TARGET="${ARGS[0]:-}"
MOUNTED_BY_US=""
BOOT_MOUNT=""

if [ -n "$TARGET" ] && [ -b "$TARGET" ]; then
  echo "Mounting $TARGET ..."
  BOOT_MOUNT="$(mount_device "$TARGET")"
  MOUNTED_BY_US="$BOOT_MOUNT"
elif [ -n "$TARGET" ]; then
  BOOT_MOUNT="$TARGET"
else
  BOOT_MOUNT="$(find_mounted_bootfs)" || {
    echo "Couldn't find a mounted bootfs partition. Insert the SD card, or pass its mount point/device explicitly:" >&2
    echo "  $0 /path/to/bootfs" >&2
    echo "  $0 /dev/sdb1" >&2
    exit 1
  }
fi

[ -d "$BOOT_MOUNT" ] || { echo "Not a directory: $BOOT_MOUNT" >&2; exit 1; }
[ -w "$BOOT_MOUNT" ] || { echo "Not writable: $BOOT_MOUNT (sudo? wrong card?)" >&2; exit 1; }

EXISTING="$BOOT_MOUNT/user-data"
MERGE=""
if [ -s "$EXISTING" ] && [ -z "$FORCE" ]; then
  MERGE=1
fi

# HOUSE_ID/ADMIN_USER/ADMIN_SSH_PUBLIC_KEY only matter for the
# no-existing-user-data (or --force) path — pinned down below once we
# know whether we're merging. USER_HOUSE_ID keeps track of whether the
# caller explicitly asked for a hostname, so that request can still win
# over whatever's already in an existing user-data (see below).
USER_HOUSE_ID="${HOUSE_ID:-}"
EFFECTIVE_HOUSE_ID="${HOUSE_ID:-}"
EFFECTIVE_ADMIN_USER="${ADMIN_USER:-admin}"
DROP_USERS_BLOCK=""
FORCE_HOSTNAME=""

if [ -n "$MERGE" ]; then
  command -v python3 >/dev/null && python3 -c "import yaml" 2>/dev/null || {
    echo "$EXISTING already has content (probably from Raspberry Pi Imager's" >&2
    echo "own Edit Settings step) and merging it needs python3 with PyYAML" >&2
    echo "(pip3 install pyyaml), which isn't available here." >&2
    echo "Either install that, or re-run with --force to overwrite $EXISTING" >&2
    echo "outright (discarding whatever's in it):" >&2
    echo "  $0 --force ${TARGET:-}" >&2
    exit 1
  }

  # Peek the existing file for a hostname and a default user, so this
  # run's HOUSE_ID/ADMIN_USER follow what's already there instead of
  # fighting it.
  eval "$(python3 - "$EXISTING" <<'PYEOF'
import sys, yaml
with open(sys.argv[1]) as f:
    text = f.read()
if text.lstrip().startswith("#cloud-config"):
    text = text.split("\n", 1)[1] if "\n" in text else ""
doc = yaml.safe_load(text) or {}
hostname = doc.get("hostname")
user_name = None
if isinstance(doc.get("user"), dict):
    user_name = doc["user"].get("name")
elif isinstance(doc.get("users"), list) and doc["users"]:
    first = doc["users"][0]
    if isinstance(first, dict):
        user_name = first.get("name")
if hostname:
    print("EFFECTIVE_HOUSE_ID=%r" % hostname)
if user_name:
    print("EFFECTIVE_ADMIN_USER=%r" % user_name)
    print("DROP_USERS_BLOCK=1")
PYEOF
)"

  if [ -n "$USER_HOUSE_ID" ]; then
    if [ "$USER_HOUSE_ID" != "$EFFECTIVE_HOUSE_ID" ]; then
      echo "NOTE: overriding existing user-data's hostname ($EFFECTIVE_HOUSE_ID) with the HOUSE_ID you passed ($USER_HOUSE_ID)." >&2
    fi
    EFFECTIVE_HOUSE_ID="$USER_HOUSE_ID"
    FORCE_HOSTNAME=1
  fi
fi

: "${EFFECTIVE_HOUSE_ID:?set HOUSE_ID (no existing user-data to read a hostname from)}"

if [ -z "$DROP_USERS_BLOCK" ]; then
  : "${ADMIN_SSH_PUBLIC_KEY:?set ADMIN_SSH_PUBLIC_KEY}"
else
  # Not used by the template in this case (users: block is dropped
  # before merging) but envsubst still needs *something* bound.
  ADMIN_SSH_PUBLIC_KEY="${ADMIN_SSH_PUBLIC_KEY:-unused}"
fi

HOUSE_ID="$EFFECTIVE_HOUSE_ID"
ADMIN_USER="$EFFECTIVE_ADMIN_USER"
export HOUSE_ID ADMIN_USER ADMIN_SSH_PUBLIC_KEY TAILSCALE_AUTH_KEY BACKEND_URL REPO_URL

RENDERED="$(mktemp)"
trap 'rm -f "$RENDERED"' EXIT

envsubst '$HOUSE_ID $ADMIN_USER $ADMIN_SSH_PUBLIC_KEY $TAILSCALE_AUTH_KEY $BACKEND_URL $REPO_URL' \
  < "$TEMPLATE" > "$RENDERED"

if [ -n "$MERGE" ]; then
  python3 - "$EXISTING" "$RENDERED" "$DROP_USERS_BLOCK" "$FORCE_HOSTNAME" > "$EXISTING.new" <<'PYEOF'
import sys, yaml

def load(path):
    with open(path) as f:
        text = f.read()
    if text.lstrip().startswith("#cloud-config"):
        text = text.split("\n", 1)[1] if "\n" in text else ""
    return yaml.safe_load(text) or {}

existing_path, rendered_path, drop_users, force_hostname = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
existing = load(existing_path)
ours = load(rendered_path)

if drop_users:
    ours.pop("users", None)

merged = dict(existing)
for key, value in ours.items():
    if key not in merged:
        merged[key] = value
    elif key == "hostname":
        # existing wins by default, UNLESS the caller explicitly asked
        # for a different HOUSE_ID (see the NOTE printed above) — then
        # theirs does.
        if force_hostname:
            merged[key] = value
    elif isinstance(merged[key], list) and isinstance(value, list):
        merged[key] = merged[key] + value
    elif isinstance(merged[key], dict) and isinstance(value, dict):
        merged[key] = {**value, **merged[key]}
    # else: existing scalar wins (e.g. package_update/package_upgrade,
    # ssh_pwauth) — nothing in `ours` currently collides on a scalar
    # other than hostname, handled above.

def str_presenter(dumper, data):
    style = "|" if "\n" in data else None
    return dumper.represent_scalar("tag:yaml.org,2002:str", data, style=style)

yaml.add_representer(str, str_presenter)
sys.stdout.write("#cloud-config\n")
yaml.dump(merged, sys.stdout, default_flow_style=False, sort_keys=False)
PYEOF
  mv "$EXISTING.new" "$EXISTING"
  echo "Merged into existing $EXISTING (kept its hostname/default user, added this project's packages/write_files/runcmd)."
else
  mv "$RENDERED" "$EXISTING"
  trap - EXIT
  echo "Wrote $EXISTING"
fi

[ -e "$BOOT_MOUNT/meta-data" ] || : > "$BOOT_MOUNT/meta-data"

if [ -n "$MOUNTED_BY_US" ]; then
  unmount_device "$MOUNTED_BY_US"
  echo "Unmounted. Safe to remove the card."
else
  echo "Now safely eject $BOOT_MOUNT before removing the card."
fi

echo "Boot the Pi to run cloud-init."
