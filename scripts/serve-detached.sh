#!/usr/bin/env bash
# Build the UI and run the demo server detached (for UI checks on another machine).
#   scripts/serve-detached.sh [port]     prints READY http://localhost:<port> when it answers
#   scripts/serve-detached.sh stop
set -euo pipefail
cd "$(dirname "$0")/.."
PIDFILE=.strikebench/serve.pid
mkdir -p .strikebench
if [ -f "$PIDFILE" ]; then
  kill "$(cat "$PIDFILE")" 2>/dev/null || true # error-ok: the old server may already be gone
  rm -f "$PIDFILE"
fi
if [ "${1:-}" = "stop" ]; then
  echo "stopped"
  exit 0
fi
PORT="${1:-4599}"
npm run -s build >/dev/null
nohup node apps/server/src/bin.ts --demo --no-open --port "$PORT" --static apps/web/dist >.strikebench/serve.log 2>&1 &
echo $! >"$PIDFILE"
for _ in $(seq 1 50); do
  if curl -fsS "http://localhost:$PORT/api/status" >/dev/null 2>&1; then
    echo "READY http://localhost:$PORT"
    exit 0
  fi
  sleep 0.2
done
echo "server did not answer on port $PORT" >&2
cat .strikebench/serve.log >&2
exit 1
