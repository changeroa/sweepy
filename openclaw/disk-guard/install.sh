#!/bin/sh
set -eu
: "${DISCORD_TO:?set DISCORD_TO to the Discord user or channel id that receives reports}"
: "${DISCORD_ACCOUNT:?set DISCORD_ACCOUNT to the OpenClaw Discord account id}"
AGENT="${OPENCLAW_AGENT:-iyen}"
DIR=$(cd "$(dirname "$0")" && pwd)

exec openclaw cron add \
  --name disk-guard \
  --display-name "디스크 감시 (Void)" \
  --declaration-key disk-guard-v1 \
  --description "Void guard가 low/critical일 때만 정리 후보를 보고(적용은 승인 후)" \
  --every 1h \
  --trigger-script "$DIR/trigger.js" \
  --agent "$AGENT" \
  --session isolated \
  --message "$(cat "$DIR/message.md")" \
  --timeout-seconds 600 \
  --announce --channel discord --to "$DISCORD_TO" --account "$DISCORD_ACCOUNT"
