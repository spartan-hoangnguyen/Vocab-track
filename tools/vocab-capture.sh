#!/bin/bash
# Queue the selected text for Vocab-track. Called by the macOS Quick Action,
# so it runs in whatever app you were reading in — Kindle, Preview, Mail,
# Notes, Slack.
#
# Appends and exits. It deliberately does not talk to Chrome: Chrome may not be
# running, and waiting on it would stall the app you are reading in. The
# dashboard drains this queue when you next open it.
set -u

DIR="$HOME/Library/Application Support/vocab-track"
QUEUE="$DIR/queue.jsonl"
mkdir -p "$DIR"

# The selection arrives on stdin from Automator's "Run Shell Script" (input:
# to stdin), or as arguments if wired up as arguments instead.
if [ "$#" -gt 0 ]; then
  TEXT="$*"
else
  TEXT="$(cat)"
fi

APP="$(osascript -e 'tell application "System Events" to get name of first application process whose frontmost is true' 2>/dev/null || echo '')"

# One line, written in one write() so a second capture cannot interleave with
# this one. python3 rather than printf: it has to be valid JSON, and a
# selection can contain quotes, backslashes and newlines.
SAVED="$(TEXT="$TEXT" APP="$APP" QUEUE="$QUEUE" python3 - <<'PY'
import json, os, time
text = os.environ.get('TEXT', '').strip()
if not text:
    print('')
else:
    line = json.dumps({'text': text[:400], 'app': os.environ.get('APP', ''),
                       'ts': int(time.time() * 1000)}, ensure_ascii=False)
    with open(os.environ['QUEUE'], 'a', encoding='utf-8') as handle:
        handle.write(line + '\n')
    print(text.split()[0][:40] if text.split() else '')
PY
)"

# The capture is silent otherwise, and a save you cannot see is a save you do
# not trust.
if [ -n "$SAVED" ]; then
  # The word is passed as an argument, never interpolated into the script text.
  # osascript parses -e as AppleScript, so a selection beginning with a double
  # quote would close the string literal and have the rest evaluated as code.
  osascript -e 'on run {msg}
display notification msg with title "Saved to Vocab-track"
end run' "$SAVED" >/dev/null 2>&1
else
  osascript -e 'display notification "Nothing was selected" with title "Vocab-track"' >/dev/null 2>&1
fi
