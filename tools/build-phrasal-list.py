#!/usr/bin/env python3
"""Build data/phrasal-verbs.json, an importable file of common phrasal verbs.

Headwords: tools/phrasal-verbs.txt, a hand-curated list — no open CEFR list of
phrasal verbs exists. Everything else is build-ielts-list.py's pipeline, reused
rather than copied: Cambridge pages, the Vietnamese gloss, and headless Chrome
parsing with the extension's own VT.parseCambridge. The band comes from
Cambridge, so a verb Cambridge has no entry for is dropped.

Resumable, like the IELTS build: the cache is /tmp/vocab-track-phrasal.
"""

import concurrent.futures
import importlib.util
import json
import pathlib
import shutil
import time
import urllib.parse

HERE = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('ielts', HERE / 'build-ielts-list.py')
ielts = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ielts)

REPO = ielts.REPO
OUT = REPO / 'data' / 'phrasal-verbs.json'
LIST = HERE / 'phrasal-verbs.txt'
WORK = pathlib.Path('/tmp/vocab-track-phrasal')
CACHE = WORK / 'entries.jsonl'
LEVELS = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2']
COLORS = {'A1': 'sage', 'A2': 'sage', 'B1': 'sky', 'B2': 'sky', 'C1': 'clay', 'C2': 'clay'}


def fetch(word, pages):
    slug = word.replace(' ', '-')
    url = ielts.CAMBRIDGE + urllib.parse.quote(slug)
    name = None
    try:
        html, final = ielts.get(url)
        # A missing phrase 302s to the index, and a near miss to some other
        # entry ("brace for" -> "brace"). Only the page for this exact phrase
        # describes it.
        if urllib.parse.urlparse(final).path.rstrip('/').endswith('/' + slug):
            name = f'{slug}.html'
            (pages / name).write_text(html, encoding='utf-8')
    except Exception as err:
        print(f'  ! {word}: {err}', flush=True)
    time.sleep(ielts.PAUSE)
    return {'word': word, 'level': None, 'phrasal': True, 'file': f'pages/{name}' if name else None,
            'vi': ielts.vietnamese(word) if name else None, 'url': url}


def crawl(words):
    WORK.mkdir(parents=True, exist_ok=True)
    done = set()
    if CACHE.exists():
        with CACHE.open() as fh:
            done = {json.loads(line)['word'] for line in fh if line.strip()}
    todo = [w for w in words if w not in done]
    print(f'{len(words)} phrasal verbs, {len(done)} cached, {len(todo)} to fetch', flush=True)
    if not todo:
        return
    shutil.copy(REPO / 'lib.js', WORK / 'lib.js')
    shutil.copy(HERE / 'ielts-parse.html', WORK / 'ielts-parse.html')
    pages = WORK / 'pages'
    httpd = ielts.serve(WORK)
    try:
        for start in range(0, len(todo), ielts.BATCH):
            chunk = todo[start:start + ielts.BATCH]
            shutil.rmtree(pages, ignore_errors=True)
            pages.mkdir()
            with concurrent.futures.ThreadPoolExecutor(ielts.WORKERS) as pool:
                items = list(pool.map(lambda w: fetch(w, pages), chunk))
            n = start // ielts.BATCH
            (WORK / f'batch-{n}.json').write_text(json.dumps(items), encoding='utf-8')
            entries = ielts.parse_batch(n)
            with CACHE.open('a') as fh:
                for entry in entries:
                    fh.write(json.dumps(entry, ensure_ascii=False) + '\n')
            got = sum(1 for e in entries if e.get('def'))
            print(f'batch {n}: {got}/{len(entries)} found ({start + len(chunk)}/{len(todo)})', flush=True)
    finally:
        httpd.shutdown()
        shutil.rmtree(pages, ignore_errors=True)


def band(entry):
    """The easiest band any sense is tagged with; the first sense is often untagged."""
    tags = [s.get('level') for s in entry.get('senses', [])] + [entry.get('level')]
    ranks = [LEVELS.index(t) for t in tags if t in LEVELS]
    return LEVELS[min(ranks)] if ranks else None


def assemble(words):
    order = {w: i for i, w in enumerate(words)}
    with CACHE.open() as fh:
        entries = [json.loads(line) for line in fh if line.strip()]
    entries = [e for e in entries if e['word'] in order]
    # Only an entry Cambridge actually has: a bare translation of an invented
    # phrase would teach something that is not English.
    dropped = sorted(e['word'] for e in entries if not e.get('def'))
    entries = [e for e in entries if e.get('def')]
    for e in entries:
        e['level'] = band(e)
    rank = lambda e: LEVELS.index(e['level']) if e['level'] else len(LEVELS)
    entries.sort(key=lambda e: (rank(e), order[e['word']]))

    day = 24 * 60 * 60 * 1000
    now = int(time.time() * 1000)
    folders, words_out = {}, {}
    for i, e in enumerate(entries):
        level = e['level'] or 'other'
        fid = 'phrasal-' + level.lower()
        folders.setdefault(fid, {
            'id': fid, 'name': f'Phrasal {level}' if e['level'] else 'Phrasal · no band',
            'color': COLORS.get(e['level'], 'ochre'), 'icon': '\U0001F517', 'auto': False,
            'added': now, 'desc': 'Common phrasal verbs, band from Cambridge.'})
        e['folders'] = [fid]
        e['due'] = now + (i // ielts.NEW_PER_DAY) * day
        e['added'] = now
        words_out[e['word']] = e

    payload = {'exported': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
               'folders': folders, 'words': words_out}
    OUT.write_text(json.dumps(payload, ensure_ascii=False, indent=1), encoding='utf-8')

    counts = {f['name']: sum(1 for e in entries if e['folders'][0] == fid) for fid, f in folders.items()}
    print(f'\n{OUT.relative_to(REPO)}: {len(entries)} phrasal verbs, {OUT.stat().st_size // 1024}KB')
    print('  ' + '  '.join(f'{k} {v}' for k, v in counts.items()))
    print(f'  translation {sum(1 for e in entries if e.get("vi"))}  '
          f'example {sum(1 for e in entries if e.get("context"))}')
    print(f'  dropped {len(dropped)} (no Cambridge entry): {", ".join(dropped)}')


if __name__ == '__main__':
    words = list(dict.fromkeys(l.strip().lower() for l in LIST.read_text().splitlines() if l.strip()))
    crawl(words)
    assemble(words)
