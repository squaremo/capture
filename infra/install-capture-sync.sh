#!/bin/sh
# Installs the capture-sync systemd timer, which periodically pulls
# the app checkout and reconciles the compose stack (config/service
# changes that Watchtower, which only watches image content, won't
# pick up on its own).
#
# Only needed on servers built before this timer was added to
# infra/cloud-init.yaml.tpl — new servers get it automatically at
# first boot.
#
# Usage: install-capture-sync.sh [app-dir] [data-dir]
#   app-dir  — repo checkout to pull/reconcile (default: /opt/capture/app)
#   data-dir — where config-version is written (default: /opt/capture/data)
# A satellite/station box with a non-standard layout (e.g.
# /opt/capture-satellite) should pass its real paths explicitly.
set -e

APP_DIR="${1:-/opt/capture/app}"
DATA_DIR="${2:-/opt/capture/data}"

cat > /etc/systemd/system/capture-sync.service << EOF
[Unit]
Description=Pull latest capture repo config and reconcile compose stack
After=network-online.target docker.service
Requires=docker.service

[Service]
Type=oneshot
WorkingDirectory=${APP_DIR}
ExecStart=/usr/bin/git pull --ff-only
ExecStart=/bin/sh -c 'git rev-parse HEAD > ${DATA_DIR}/config-version'
ExecStart=/usr/bin/docker compose up -d --remove-orphans
EOF

cat > /etc/systemd/system/capture-sync.timer << 'EOF'
[Unit]
Description=Periodically sync capture deploy config from git

[Timer]
OnBootSec=5min
OnUnitActiveSec=5min

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now capture-sync.timer
echo "capture-sync.timer installed and started (app: ${APP_DIR}, data: ${DATA_DIR})"
