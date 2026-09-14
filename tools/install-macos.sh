#!/bin/bash
# Wire the macOS side of Vocab-track: a Quick Action that queues the selected
# word from any app, and the native messaging host the dashboard drains it with.
#
# Safe to re-run. Undo with tools/uninstall-macos.sh.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOST_NAME="com.vocab_track.capture"
SERVICE="$HOME/Library/Services/Save to Vocab-track.workflow"
HOSTS_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"

# An unpacked extension's id is derived from the absolute path of its folder:
# the first 16 bytes of its SHA-256, each nibble mapped 0-f to a-p. Computing
# it beats asking, and moving the repo changes it — which is why re-running
# this script is the fix if the dashboard ever says the host is missing.
EXT_ID="$(REPO="$REPO" python3 -c '
import hashlib, os
digest = hashlib.sha256(os.environ["REPO"].encode()).hexdigest()[:32]
print("".join(chr(ord("a") + int(c, 16)) for c in digest))')"

echo "repo:      $REPO"
echo "extension: $EXT_ID"

# --- 1. the native messaging host -------------------------------------------
mkdir -p "$HOSTS_DIR"
cat > "$HOSTS_DIR/$HOST_NAME.json" <<JSON
{
  "name": "$HOST_NAME",
  "description": "Vocab-track capture queue",
  "path": "$REPO/tools/vocab-host.py",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$EXT_ID/"]
}
JSON
chmod +x "$REPO/tools/vocab-host.py" "$REPO/tools/vocab-capture.sh"
echo "installed: $HOSTS_DIR/$HOST_NAME.json"

# --- 2. the Quick Action ------------------------------------------------------
rm -rf "$SERVICE"
mkdir -p "$SERVICE/Contents"

cat > "$SERVICE/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>NSServices</key>
  <array>
    <dict>
      <key>NSMenuItem</key>
      <dict><key>default</key><string>Save to Vocab-track</string></dict>
      <key>NSMessage</key><string>runWorkflowAsService</string>
      <key>NSSendTypes</key>
      <array><string>NSStringPboardType</string></array>
    </dict>
  </array>
</dict>
PLIST
echo '</plist>' >> "$SERVICE/Contents/Info.plist"

# The workflow is one "Run Shell Script" action taking the selection on stdin
# (inputMethod 0) and producing nothing (serviceOutputTypeIdentifier nothing),
# so the app you are reading in is never asked to replace your selection.
cat > "$SERVICE/Contents/document.wflow" <<WFLOW
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>AMApplicationBuild</key><string>521</string>
  <key>AMApplicationVersion</key><string>2.10</string>
  <key>AMDocumentVersion</key><string>2</string>
  <key>actions</key>
  <array>
    <dict>
      <key>action</key>
      <dict>
        <key>AMAccepts</key>
        <dict>
          <key>Container</key><string>List</string>
          <key>Optional</key><true/>
          <key>Types</key><array><string>com.apple.cocoa.string</string></array>
        </dict>
        <key>AMActionVersion</key><string>2.0.3</string>
        <key>AMApplication</key><array><string>Automator</string></array>
        <key>AMParameterProperties</key>
        <dict>
          <key>COMMAND_STRING</key><dict/>
          <key>CheckedForUserDefaultShell</key><dict/>
          <key>inputMethod</key><dict/>
          <key>shell</key><dict/>
          <key>source</key><dict/>
        </dict>
        <key>AMProvides</key>
        <dict>
          <key>Container</key><string>List</string>
          <key>Types</key><array><string>com.apple.cocoa.string</string></array>
        </dict>
        <key>ActionBundlePath</key><string>/System/Library/Automator/Run Shell Script.action</string>
        <key>ActionName</key><string>Run Shell Script</string>
        <key>ActionParameters</key>
        <dict>
          <key>COMMAND_STRING</key><string>exec "$REPO/tools/vocab-capture.sh"</string>
          <key>CheckedForUserDefaultShell</key><true/>
          <key>inputMethod</key><integer>0</integer>
          <key>shell</key><string>/bin/bash</string>
          <key>source</key><string></string>
        </dict>
        <key>BundleIdentifier</key><string>com.apple.RunShellScript</string>
        <key>CFBundleVersion</key><string>2.0.3</string>
        <key>CanShowSelectedItemsWhenRun</key><false/>
        <key>CanShowWhenRun</key><true/>
        <key>Category</key><array><string>AMCategoryUtilities</string></array>
        <key>Class Name</key><string>RunShellScriptAction</string>
        <key>InputUUID</key><string>3A1B0E5C-0001-4E7A-9E00-VOCABTRACK01</string>
        <key>Keywords</key><array><string>Shell</string><string>Script</string></array>
        <key>OutputUUID</key><string>3A1B0E5C-0002-4E7A-9E00-VOCABTRACK02</string>
        <key>UUID</key><string>3A1B0E5C-0003-4E7A-9E00-VOCABTRACK03</string>
        <key>UnlocalizedApplications</key><array><string>Automator</string></array>
        <key>arguments</key><dict/>
        <key>isViewVisible</key><integer>1</integer>
        <key>location</key><string>309.000000:253.000000</string>
        <key>nibPath</key><string>/System/Library/Automator/Run Shell Script.action/Contents/Resources/Base.lproj/main.nib</string>
      </dict>
      <key>isViewVisible</key><integer>1</integer>
    </dict>
  </array>
  <key>connectors</key><dict/>
  <key>workflowMetaData</key>
  <dict>
    <key>serviceInputTypeIdentifier</key><string>com.apple.Automator.text</string>
    <key>serviceOutputTypeIdentifier</key><string>com.apple.Automator.nothing</string>
    <key>serviceApplicationBundleID</key><string></string>
    <key>serviceProcessesInput</key><integer>0</integer>
    <key>presentationMode</key><integer>11</integer>
    <key>workflowTypeIdentifier</key><string>com.apple.Automator.servicesMenu</string>
  </dict>
</dict>
</plist>
WFLOW

plutil -lint "$SERVICE/Contents/Info.plist" >/dev/null
plutil -lint "$SERVICE/Contents/document.wflow" >/dev/null
echo "installed: $SERVICE"

# --- 3. make macOS notice it --------------------------------------------------
/System/Library/CoreServices/pbs -flush 2>/dev/null || true

# The real proof is that it RUNS, not that it parses: this drives the workflow
# exactly as the Services menu will, then removes the word it queued.
if printf 'installationcheck' | automator -i - "$SERVICE" >/dev/null 2>&1; then
  echo "verified:  the Quick Action runs and queues a word"
  python3 - <<'CLEAN'
import os
queue = os.path.expanduser('~/Library/Application Support/vocab-track/queue.jsonl')
if os.path.exists(queue):
    with open(queue, encoding='utf-8') as handle:
        keep = [line for line in handle if 'installationcheck' not in line]
    with open(queue, 'w', encoding='utf-8') as handle:
        handle.writelines(keep)
CLEAN
else
  echo "WARNING: the Quick Action did not run. Open it in Automator to see why."
fi

# Separate question: whether macOS has re-scanned ~/Library/Services yet, which
# is what puts it in the Services menu and in System Settings. The rescan is
# asynchronous and after a reinstall regularly takes ten seconds or more, so
# not seeing it immediately means nothing is wrong.
registered=no
for _ in $(seq 1 20); do
  if /System/Library/CoreServices/pbs -dump_pboard 2>/dev/null | grep -q "Save to Vocab-track"; then
    registered=yes
    break
  fi
  sleep 1
done
if [ "$registered" = yes ]; then
  echo "listed:    macOS has it in the Services menu"
else
  echo "note:      macOS has not re-scanned Services yet. It usually appears"
  echo "           within a minute; a log out and back in always forces it."
fi

cat <<'NEXT'

Last step, which has to be done by hand — macOS does not let a script assign
a global hotkey:

  System Settings -> Keyboard -> Keyboard Shortcuts... -> Services -> Text
  tick "Save to Vocab-track" and click its right-hand side to set a key.

Then: select a word in any app, press the key. A notification confirms it.
The words appear in the dashboard next time you open it.
NEXT
