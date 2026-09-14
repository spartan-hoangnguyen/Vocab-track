#!/bin/bash
# Remove everything tools/install-macos.sh put on the system. Leaves the queue
# file alone; delete it yourself if you want the pending captures gone too.
set -u
rm -rf "$HOME/Library/Services/Save to Vocab-track.workflow"
rm -f "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.vocab_track.capture.json"
/System/Library/CoreServices/pbs -flush 2>/dev/null || true
echo "removed the Quick Action and the native messaging host."
echo "queue left in place: ~/Library/Application Support/vocab-track/queue.jsonl"
