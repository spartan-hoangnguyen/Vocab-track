#!/usr/bin/env python3
"""Chrome native messaging host for Vocab-track.

The only job: hand the dashboard whatever vocab-capture.sh has queued from
other Mac apps, and clear the queue. Chrome starts this on demand and it exits
immediately after one exchange, so there is no daemon and no open port.

Protocol: a 4-byte little-endian length, then that many bytes of UTF-8 JSON,
in both directions.
"""

import json
import os
import struct
import sys
import time

QUEUE = os.path.expanduser('~/Library/Application Support/vocab-track/queue.jsonl')
# A selection can be a whole paragraph; past this it is not a vocabulary lookup.
MAX_SELECTION = 400
MAX_ITEMS = 200


def read_message():
    header = sys.stdin.buffer.read(4)
    if len(header) < 4:
        return None
    length = struct.unpack('<I', header)[0]
    return json.loads(sys.stdin.buffer.read(length).decode('utf-8'))


def write_message(payload):
    data = json.dumps(payload).encode('utf-8')
    sys.stdout.buffer.write(struct.pack('<I', len(data)))
    sys.stdout.buffer.write(data)
    sys.stdout.buffer.flush()


def drain():
    """Take the queue away before reading it.

    Rename first, then read: a capture that lands while we are reading goes
    into a fresh file rather than being truncated away unread.
    """
    if not os.path.exists(QUEUE):
        return []
    taken = f'{QUEUE}.{os.getpid()}.{int(time.time())}'
    try:
        os.rename(QUEUE, taken)
    except OSError:
        return []

    items = []
    try:
        with open(taken, encoding='utf-8') as handle:
            for line in handle:
                line = line.strip()
                if not line:
                    continue
                try:
                    item = json.loads(line)
                except ValueError:
                    continue
                text = str(item.get('text', ''))[:MAX_SELECTION]
                if not text.strip():
                    continue
                items.append({
                    'text': text,
                    'app': str(item.get('app', ''))[:80],
                    'ts': item.get('ts'),
                })
    finally:
        try:
            os.remove(taken)
        except OSError:
            pass
    return items[-MAX_ITEMS:]


def main():
    message = read_message()
    if message is None:
        return
    if message.get('cmd') == 'drain':
        write_message({'ok': True, 'items': drain()})
    elif message.get('cmd') == 'ping':
        write_message({'ok': True, 'queue': QUEUE,
                       'pending': sum(1 for _ in open(QUEUE, encoding='utf-8'))
                       if os.path.exists(QUEUE) else 0})
    else:
        write_message({'ok': False, 'error': 'unknown command'})


if __name__ == '__main__':
    main()
