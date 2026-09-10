#!/usr/bin/env bash
# Smoke test: start the dev server, hit every route, report status codes.
set -u
cd "$(dirname "$0")/.."

PORT="${PORT:-3210}"
export PORT

cleanup() {
  kill "$SERVER_PID" 2>/dev/null
}
trap cleanup EXIT

npm run dev -- -p "$PORT" > /tmp/nextdev.log 2>&1 &
SERVER_PID=$!

# Wait for the server to be ready.
for _ in $(seq 1 60); do
  if curl -s -o /dev/null "http://localhost:$PORT/"; then
    break
  fi
  sleep 1
done

check() {
  local path="$1"
  local expected="${2:-200}"
  local code
  code=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:$PORT$path")
  if [ "$code" = "$expected" ]; then
    echo "OK   $path -> $code"
  else
    echo "FAIL $path -> $code (expected $expected)"
  fi
}

check "/"
check "/search?q=Freya"
check "/video/freya-reign-quick-pegging-before-dinner"
check "/creator/freya-reign"
check "/creators"
check "/video/does-not-exist" 404
check "/creator/does-not-exist" 404