#!/usr/bin/env bash
# 开发机看护：服务端进程死亡时自动重启，并记录退出码（用于诊断静默死亡）
cd "$(dirname "$0")"
LOG=../../.tmp/server-watch.log
while true; do
  echo "[$(date '+%F %T')] starting server" >> "$LOG"
  DG_STATIC_DIR="../web/dist" DG_BOT_DELAY=${DG_BOT_DELAY:-600} node dist/server.cjs >> ../../.tmp/server16.log 2>&1
  code=$?
  echo "[$(date '+%F %T')] server exited code=$code" >> "$LOG"
  sleep 1
done
