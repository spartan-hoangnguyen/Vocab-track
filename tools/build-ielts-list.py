#!/usr/bin/env python3
"""Build data/ielts-c1-c2.json, an importable file of C1/C2 vocabulary.

Word list: the Octanove Vocabulary Profile C1/C2 (Open Language Profiles),
CC BY-SA 4.0 — a CEFR-graded list, which is what "C1 and C2 band" means.
Definitions, IPA, audio and examples: dictionary.cambridge.org, fetched one
page at a time, the same source the extension uses when you click a word.
Vietnamese gloss: the same translate endpoint lookup.js uses.

Parsing is NOT done here. Each batch of cached pages is handed to headless
Chrome running tools/ielts-parse.html, which calls the extension's own
VT.parseCambridge and VT.newEntry — so an imported entry has exactly the
shape a clicked one does, and Cambridge markup is understood in one place.

Resumable: already-crawled words are read back out of the JSONL cache, so
re-running after a stall costs nothing. Roughly 25 minutes for ~1900 words.
"""

import base64
import concurrent.futures
import csv
import functools
import http.server
import io
import json
import os
import pathlib
import re
import shutil
import socketserver
import subprocess
import sys
import threading
import time
import urllib.parse
import urllib.request

REPO = pathlib.Path(__file__).resolve().parent.parent
OUT = REPO / 'data' / 'ielts-c1-c2.json'
WORK = pathlib.Path(os.environ.get('IELTS_WORK', '/tmp/vocab-track-ielts'))
CACHE = WORK / 'entries.jsonl'
LIST_URL = ('https://raw.githubusercontent.com/openlanguageprofiles/olp-en-cefrj'
            '/master/octanove-vocabulary-profile-c1c2-1.0.csv')
CAMBRIDGE = 'https://dictionary.cambridge.org/dictionary/english/'
CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
PORT = 8477
BATCH = 50
# A browser User-Agent is load-bearing: Cambridge answers curl's default with
# 520. Same request with this header returns 200.
UA = ('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
      '(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36')
# A Cambridge entry page is ~330KB, so a word costs seconds, not milliseconds.
# Four workers keeps the whole crawl around an hour while still asking for
# barely more than one page a second. Be a good guest.
WORKERS = 4
PAUSE = 0.25
NEW_PER_DAY = 20        # how fast the imported backlog becomes due


def get(url, timeout=25):
    req = urllib.request.Request(url, headers={'User-Agent': UA,
                                               'Accept-Language': 'en-US,en;q=0.9'})
    with urllib.request.urlopen(req, timeout=timeout) as res:
        return res.read().decode('utf-8', 'replace'), res.url


def wordlist():
    """The C1/C2 headwords the extension can actually key on, lower band wins."""
    raw, _ = get(LIST_URL)
    levels = {}
    for row in csv.DictReader(io.StringIO(raw)):
        word = (row['headword'] or '').strip()
        # "favorably/favourably" is one entry holding both spellings. Take the
        # British one: Cambridge is a British dictionary, so that is the side
        # with the UK pronunciation and the audio.
        if '/' in word:
            word = word.split('/')[-1].strip()
        # Phrasal entries ("bulk up", "pertain to") and anything with an
        # apostrophe or a digit are rejected by VT.isLookupCandidate, so the
        # extension could never highlight or match them.
        if not re.fullmatch(r'[a-z]+(-[a-z]+)*', word) or not 2 <= len(word) <= 40:
            continue
        level = row['CEFR'].strip().upper()
        if level not in ('C1', 'C2'):
            continue
        # A word listed at both bands (different parts of speech) is learned
        # once, at the earlier one.
        if levels.get(word) != 'C1':
            levels[word] = level
    return sorted(levels.items())


def vietnamese(word):
    url = ('https://translate.googleapis.com/translate_a/single'
           '?client=dict-chrome-ex&sl=en&tl=vi&dt=t&q=' + urllib.parse.quote(word))
    try:
        body, _ = get(url, timeout=12)
        vi = json.loads(body)[0][0][0]
        # The endpoint echoes the input back when it has no translation, which
        # would put an English word on the Vietnamese side of a review card.
        return None if vi.strip().lower() == word.lower() else vi
    except Exception:
        return None


def cambridge(word, into):
    """Cache the Cambridge page for `word`; return its filename or None."""
    try:
        html, final = get(CAMBRIDGE + urllib.parse.quote(word))
    except Exception as err:
        print(f'  ! {word}: {err}', flush=True)
        return None
    # Cambridge never 404s: an unknown word 302s to the dictionary index, and
    # a known inflection 302s to a real entry. Only the bare index means
    # not-found. (Same test as lookup.js.)
    if urllib.parse.urlparse(final).path == '/dictionary/english/':
        return None
    name = f'{word}.html'
    (into / name).write_text(html, encoding='utf-8')
    return name


def fetch(pair, pages):
    """Everything one word needs from the network, in one unit of work."""
    word, level = pair
    name = cambridge(word, pages)
    time.sleep(PAUSE)
    return {'word': word, 'level': level,
            'file': f'pages/{name}' if name else None,
            'vi': vietnamese(word),
            'url': CAMBRIDGE + urllib.parse.quote(word)}


class Quiet(http.server.SimpleHTTPRequestHandler):
    # Chrome asks for a dozen files per batch; logging each one buries the
    # progress line, which is the only thing worth watching for half an hour.
    def log_message(self, *args):
        pass


def serve(directory):
    handler = functools.partial(Quiet, directory=str(directory))
    # Set on the class, not the instance: TCPServer binds inside __init__, so
    # an instance attribute would arrive after the bind that needs it — and a
    # previous run's socket sits in TIME_WAIT for a minute.
    socketserver.TCPServer.allow_reuse_address = True
    httpd = socketserver.TCPServer(('127.0.0.1', PORT), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd


def parse_batch(n):
    """Hand one batch to headless Chrome and read the entries back."""
    dom = subprocess.run(
        [CHROME, '--headless', '--disable-gpu', '--virtual-time-budget=60000',
         '--dump-dom', f'http://127.0.0.1:{PORT}/ielts-parse.html?batch={n}'],
        capture_output=True, text=True, timeout=300).stdout
    body = re.search(r'<pre id="out">(.*?)</pre>', dom, re.S)
    if not body:
        raise RuntimeError('chrome returned no output for batch ' + str(n))
    payload = body.group(1).strip()
    if payload.startswith('ERR') or payload == 'running':
        raise RuntimeError(f'batch {n}: {payload[:400]}')
    return json.loads(base64.b64decode(payload))


def crawl(words):
    WORK.mkdir(parents=True, exist_ok=True)
    # The cache lives in /tmp and a reboot takes it, but the generated file
    # holds exactly the same entries — so seed from it rather than spend forty
    # minutes re-fetching pages that are already parsed. This is also how
    # re-running the script re-staggers an old file's due dates in a second.
    if not CACHE.exists() and OUT.exists():
        built = json.loads(OUT.read_text(encoding='utf-8'))['words'].values()
        with CACHE.open('w') as fh:
            for entry in built:
                fh.write(json.dumps(entry, ensure_ascii=False) + '\n')
        print(f'seeded the cache from {OUT.name}: {len(list(built))} words', flush=True)
    done = set()
    if CACHE.exists():
        with CACHE.open() as fh:
            done = {json.loads(line)['word'] for line in fh if line.strip()}
    todo = [(w, lv) for w, lv in words if w not in done]
    print(f'{len(words)} words, {len(done)} cached, {len(todo)} to fetch', flush=True)
    if not todo:
        return

    shutil.copy(REPO / 'lib.js', WORK / 'lib.js')
    shutil.copy(REPO / 'tools' / 'ielts-parse.html', WORK / 'ielts-parse.html')
    pages = WORK / 'pages'
    httpd = serve(WORK)
    try:
        for start in range(0, len(todo), BATCH):
            chunk = todo[start:start + BATCH]
            shutil.rmtree(pages, ignore_errors=True)
            pages.mkdir()
            with concurrent.futures.ThreadPoolExecutor(WORKERS) as pool:
                items = list(pool.map(lambda pair: fetch(pair, pages), chunk))
            n = start // BATCH
            (WORK / f'batch-{n}.json').write_text(json.dumps(items), encoding='utf-8')
            entries = parse_batch(n)
            with CACHE.open('a') as fh:
                for entry in entries:
                    fh.write(json.dumps(entry, ensure_ascii=False) + '\n')
            got = sum(1 for e in entries if e.get('def'))
            print(f'batch {n}: {len(entries)} words, {got} with a definition '
                  f'({start + len(chunk)}/{len(todo)})', flush=True)
    finally:
        httpd.shutdown()
        shutil.rmtree(pages, ignore_errors=True)


def assemble(words):
    order = {word: i for i, (word, _) in enumerate(words)}
    entries = []
    with CACHE.open() as fh:
        for line in fh:
            if line.strip():
                entries.append(json.loads(line))
    # A card with neither a definition nor a translation cannot ask you
    # anything — the review card has nothing to put on its prompt side.
    entries = [e for e in entries if e.get('def') or e.get('vi')]
    entries.sort(key=lambda e: (e['level'], order.get(e['word'], 1 << 30)))

    day = 24 * 60 * 60 * 1000
    now = int(time.time() * 1000)
    words_out = {}
    for i, entry in enumerate(entries):
        # Everything due at once would open a review session two thousand
        # cards long. Staggered, the file behaves like a course: NEW_PER_DAY
        # new words a day, C1 before C2, and the SRS takes over from there.
        entry['due'] = now + (i // NEW_PER_DAY) * day
        entry['added'] = now
        words_out[entry['word']] = entry

    payload = {
        'exported': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
        'folders': {
            'ielts-c1': {'id': 'ielts-c1', 'name': 'IELTS C1', 'color': 'sky',
                         'icon': '\U0001F393', 'auto': False, 'added': now,
                         'desc': 'Advanced band. Octanove C1 list.'},
            'ielts-c2': {'id': 'ielts-c2', 'name': 'IELTS C2', 'color': 'clay',
                         'icon': '\U0001F9ED', 'auto': False, 'added': now,
                         'desc': 'Proficient band. Octanove C2 list.'},
        },
        'words': words_out,
    }
    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text(json.dumps(payload, ensure_ascii=False, indent=1), encoding='utf-8')

    c1 = sum(1 for e in entries if e['level'] == 'C1')
    with_def = sum(1 for e in entries if e.get('def'))
    with_vi = sum(1 for e in entries if e.get('vi'))
    with_ctx = sum(1 for e in entries if e.get('context'))
    print(f'\n{OUT.relative_to(REPO)}: {len(entries)} words '
          f'({c1} C1, {len(entries) - c1} C2), {OUT.stat().st_size // 1024}KB')
    print(f'  definition {with_def}  translation {with_vi}  example {with_ctx}')
    print(f'  {NEW_PER_DAY} become due per day, so the last is due in '
          f'{len(entries) // NEW_PER_DAY} days')


if __name__ == '__main__':
    words = wordlist()
    if '--list-only' in sys.argv:
        print(len(words), words[:5])
    else:
        crawl(words)
        assemble(words)
