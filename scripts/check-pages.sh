#!/usr/bin/env bash
set -u
cd "$(dirname "$0")/.."
PORT="${PORT:-3211}"
export PORT

npm run dev -- -p "$PORT" > /tmp/nextdev.log 2>&1 &
SERVER_PID=$!
cleanup() { kill "$SERVER_PID" 2>/dev/null; }
trap cleanup EXIT
for _ in $(seq 1 60); do curl -s -o /dev/null "http://localhost:$PORT/" && break; sleep 1; done

echo "== homepage thumbnails (img srcs) =="
curl -s "http://localhost:$PORT/" | grep -o 'src="/thumbs/[^"]*"' | head -6
echo "== homepage titles =="
curl -s "http://localhost:$PORT/" | grep -o 'line-clamp-2[^>]*>[^<]*' | head -4 | sed 's/line-clamp-2[^>]*>//'
echo "== homepage iframes (should be none until hover) =="
curl -s "http://localhost:$PORT/" | grep -c 'mega.nz/embed'
echo "== video page player iframe =="
curl -s "http://localhost:$PORT/video/freya-reign-quick-pegging-before-dinner" | grep -o 'src="https://mega.nz/embed/[^"]*"' | head -2
echo "== search count =="
curl -s "http://localhost:$PORT/search?q=Freya" | grep -o '4 result' | head -1