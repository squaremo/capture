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
#   ./provision-satellite-sd.sh [bootfs-mount-point-or-device]
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

: "${HOUSE_ID:?set HOUSE_ID (also used as hostname)}"
: "${ADMIN_SSH_PUBLIC_KEY:?set ADMIN_SSH_PUBLIC_KEY}"
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

TARGET="${1:-}"
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

export HOUSE_ID ADMIN_SSH_PUBLIC_KEY TAILSCALE_AUTH_KEY BACKEND_URL REPO_URL

envsubst '$HOUSE_ID $ADMIN_SSH_PUBLIC_KEY $TAILSCALE_AUTH_KEY $BACKEND_URL $REPO_URL' \
  < "$TEMPLATE" > "$BOOT_MOUNT/user-data"
: > "$BOOT_MOUNT/meta-data"

echo "Wrote user-data + meta-data to $BOOT_MOUNT"

if [ -n "$MOUNTED_BY_US" ]; then
  unmount_device "$MOUNTED_BY_US"
  echo "Unmounted. Safe to remove the card."
else
  echo "Now safely eject $BOOT_MOUNT before removing the card."
fi

echo "Boot the Pi to run cloud-init."
