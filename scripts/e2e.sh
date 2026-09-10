#!/usr/bin/env bash
# Start the dev server, run Playwright e2e tests, then stop the server.
set -u
cd "$(dirname "$0")/.."
PORT="${PORT:-3213}"
export PORT
export E2E_BASE_URL="http://localhost:$PORT"

npm run dev -- -p "$PORT" > /tmp/nextdev.log 2>&1 &
SERVER_PID=$!
cleanup() { kill "$SERVER_PID" 2>/dev/null; }
trap cleanup EXIT

for _ in $(seq 1 90); do
  if curl -s -o /dev/null "http://localhost:$PORT/"; then break; fi
  sleep 1
done

npx playwright test "$@"