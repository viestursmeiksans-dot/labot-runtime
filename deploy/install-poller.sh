#!/usr/bin/env bash
# Install (or reinstall) the poller as a systemd service. Run as root: sudo bash install-poller.sh
set -e
UNIT=/srv/labot/labot-runtime/deploy/labot-poller.service
cp "$UNIT" /etc/systemd/system/labot-poller.service
systemctl daemon-reload
systemctl enable labot-poller
# Kill any hand-started poller. The [.] keeps this pattern from matching this script's own
# command line (which contains the literal "poll.mjs" nowhere — but be safe regardless).
pkill -f 'poll[.]mjs' 2>/dev/null || true
sleep 1
systemctl restart labot-poller
sleep 2
systemctl status labot-poller --no-pager || true
echo "--- recent journal ---"
journalctl -u labot-poller -n 8 --no-pager || true
