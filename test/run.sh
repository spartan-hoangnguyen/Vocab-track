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

# The caption probe needs layout, so it gets a window size and its own run.
# It checks one thing the unit tests cannot reach: that caretRangeFromPoint
# still reads text through the user-select:none YouTube puts on its captions.
PROBE=$("$CHROME" --headless --disable-gpu --virtual-time-budget=5000 \
        --window-size=1200,800 --dump-dom "http://localhost:$PORT/test/yt-probe.html" 2>/dev/null \
        | sed -n '/<pre id="out">/,/<\/pre>/p' | sed 's/<[^>]*>//g')

# Layout again, and at two widths: the reader probe renders reader.js's own CSS
# and markup in an iframe and measures where the focal letter actually lands.
READER=$("$CHROME" --headless --disable-gpu --virtual-time-budget=5000 \
         --window-size=1200,900 --dump-dom "http://localhost:$PORT/test/reader-probe.html" 2>/dev/null \
         | sed -n '/<pre id="out">/,/<\/pre>/p' | sed 's/<[^>]*>//g')

# The dashboard probe loads the real dashboard against a stubbed chrome API and
# measures the result, which is the only way to catch layout regressions — a
# view section that ignores [hidden], a control that stretches, a placeholder
# running under the shortcut badge.
DASH=$("$CHROME" --headless --disable-gpu --virtual-time-budget=5000 \
       --window-size=1400,900 --dump-dom "http://localhost:$PORT/test/dashboard-probe.html" 2>/dev/null \
       | sed -n '/<pre id="out">/,/<\/pre>/p' | sed 's/<[^>]*>//g')

echo "$OUT"
echo "$PROBE"
echo "$READER"
echo "$DASH"
echo "$OUT"   | grep -qE '^0 failure\(s\)' || exit 1
echo "$PROBE"  | grep -qE '^0 failure\(s\)' || exit 1
echo "$READER" | grep -qE '^0 failure\(s\)' || exit 1
echo "$DASH"   | grep -qE '^0 failure\(s\)' || exit 1
exit 0
