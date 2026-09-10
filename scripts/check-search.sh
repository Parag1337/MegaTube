#!/usr/bin/env bash
set -u
cd "$(dirname "$0")/.."
PORT="${PORT:-3212}"
export PORT
npm run dev -- -p "$PORT" > /tmp/nextdev.log 2>&1 &
SERVER_PID=$!
cleanup() { kill "$SERVER_PID" 2>/dev/null; }
trap cleanup EXIT
for _ in $(seq 1 60); do curl -s -o /dev/null "http://localhost:$PORT/" && break; sleep 1; done

echo "== search Freya =="
curl -s "http://localhost:$PORT/search?q=Freya" | grep -o 'Search results[^<]*' | head -2
curl -s "http://localhost:$PORT/search?q=Freya" | grep -oE '[0-9]+ results?' | head -2
echo "== search crystal =="
curl -s "http://localhost:$PORT/search?q=crystal" | grep -oE '[0-9]+ results?' | head -2
echo "== search by creator name (Reign) =="
curl -s "http://localhost:$PORT/search?q=Reign" | grep -oE '[0-9]+ results?' | head -2
echo "== search by mega filename fragment =="
curl -s "http://localhost:$PORT/search?q=pegging" | grep -oE '[0-9]+ results?' | head -2
echo "== empty search =="
curl -s "http://localhost:$PORT/search?q=" | grep -o 'Type something[^<]*' | head -1