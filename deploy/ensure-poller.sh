#!/usr/bin/env bash
# Idempotent poller supervisor — no root needed. Driven by the labot user's crontab:
#   @reboot      → start on boot
#   * * * * *    → restart within ~60s if it ever dies
# If the poller is already running, this is a no-op.
pgrep -f 'poll[.]mjs' >/dev/null 2>&1 && exit 0
D=/srv/labot/labot-runtime
cd "$D" || exit 1
setsid /usr/bin/node --env-file="$D/.env" "$D/src/poll.mjs" >>"$D/poll.log" 2>&1 </dev/null &
