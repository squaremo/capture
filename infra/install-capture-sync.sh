#!/bin/sh
# Installs the capture-sync systemd timer, which periodically pulls
# /opt/capture/app and reconciles the compose stack (config/service
# changes that Watchtower, which only watches image content, won't
# pick up on its own).
#
# Only needed on servers built before this timer was added to
# infra/cloud-init.yaml.tpl — new servers get it automatically at
# first boot.
set -e

cat > /etc/systemd/system/capture-sync.service << 'EOF'
[Unit]
Description=Pull latest capture repo config and reconcile compose stack
After=network-online.target docker.service
Requires=docker.service

[Service]
Type=oneshot
WorkingDirectory=/opt/capture/app
ExecStart=/usr/bin/git pull --ff-only
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
echo "capture-sync.timer installed and started"
