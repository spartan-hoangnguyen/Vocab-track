#!/usr/bin/env bash
# Runs test/test.html in headless Chrome and prints the assertion summary.
# Exits non-zero unless every assertion passed.
set -u
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT=8123

python3 -m http.server "$PORT" --directory "$ROOT" >/dev/null 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null' EXIT
sleep 1

# --virtual-time-budget lets async fetches in the test page settle before the dump.
OUT=$("$CHROME" --headless --disable-gpu --virtual-time-budget=10000 \
      --dump-dom "http://localhost:$PORT/test/test.html" 2>/dev/null \
      | sed -n '/<pre id="out">/,/<\/pre>/p' | sed 's/<[^>]*>//g')

echo "$OUT"
echo "$OUT" | grep -qE '^0 failure\(s\)' && exit 0
exit 1
