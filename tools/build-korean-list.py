#!/usr/bin/env python3
"""Build data/ko/starter.json, an importable Korean word list graded 초급/중급/고급.

The Korean counterpart to build-ielts-list.py, and much the smaller job: there
is no krdict key, so there is no dictionary to scrape, no page to parse and no
headless Chrome in this build at all. A Korean card carries a Vietnamese gloss
and nothing else, exactly as one saved from a page does (lang/ko/dictionary.js).
So this reuses build-ielts-list.py's `get`, `vietnamese` and its batching and
staggering constants, and skips `stage`, `serve` and `parse_batch` entirely —
they exist to run VT.parseCambridge over cached HTML, and there is none. The
pacing is its own, and slower; see the warning below.

Source: https://github.com/julienshim/combined_korean_vocabulary_list (MIT),
which merges 국립국어원's 한국어 학습용 어휘 목록 (2003) with the public TOPIK
어휘 목록 (2015). Its `results.tsv` is on the `master` branch; `main` 404s.

The grades are 국립국어원's A/B/C, not TOPIK levels, and the folder names follow
lang/ko/index.js's `levels` for the reason its comment gives: the 초급≈TOPIK 1-2
mapping is unofficial, so the file does not claim it.

The TSV is rougher than its README suggests, and `clean` handles all of it:

  * Homograph numbers on the surface form — 가격03, 가구01. Unstripped, the
    saved key never matches a page, which is the one thing this list is for.
  * 1,532 rows carry no nikl_level (TOPIK-only). Dropped: the A/B/C grade is
    what maps onto the pack's three bands.
  * 332 surface forms collide once the digits go — 가다 as both 동사 and
    보조 용언, 간접적 as both 명사 and 관형사. Folded to the easiest band, the
    way build-phrasal-list.py folds a phrasal verb's senses.
  * Verbs and adjectives are dropped, and that is the interesting one. They
    are listed in dictionary form — 가다, 가깝다 — and lang/ko/index.js strips
    조사, not verb endings, so a page saying 갑니다 would never match the card.
    A word that cannot highlight is the stale-data problem this list exists to
    fix, in a new costume. 3,901 of 5,541 survive.

A WARNING worth the paragraph: this build puts ~3,900 requests through the
same keyless endpoint the extension uses live, from your IP. The first run of
it earned an HTTP 429 that made every lookup in the browser fail for a while —
the list got built and the tool stopped working. Hence the pacing below, which
is half the speed the Cambridge builds run at: they scrape a different host,
this one competes with the extension itself. If you see a 429 anyway, stop and
come back later; the cache keeps everything it already has, and the extension
now backs off for ten minutes rather than joining in (lookup.js GLOSS).

Resumable, like the other two builds: every gloss is appended as it lands, so
a rate-limit partway through ~3,900 calls costs only the batch in flight.
Re-run and it picks up where it stopped — and with the cache full, re-running
only re-staggers the due dates, which takes a second rather than an hour.
Cache is /tmp/vocab-track-korean.
"""

import concurrent.futures
import csv
import importlib.util
import json
import pathlib
import re
import time

HERE = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('ielts', HERE / 'build-ielts-list.py')
ielts = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ielts)

REPO = ielts.REPO
OUT = REPO / 'data' / 'ko' / 'starter.json'
WORK = pathlib.Path('/tmp/vocab-track-korean')
TSV = WORK / 'results.tsv'
CACHE = WORK / 'glosses.jsonl'
SOURCE = ('https://raw.githubusercontent.com/julienshim/'
          'combined_korean_vocabulary_list/master/results.tsv')

# The pack's own scale, in the pack's own order (lang/ko/index.js `levels`), so
# `level` lands on it with no mapping table and the overview's bars work
# untouched. ASCII folder ids because they end up in `data-folder` attributes
# and probe selectors; Hangul names because those are the strings the bars
# already print.
BANDS = {'A': '초급', 'B': '중급', 'C': '고급'}
ORDER = ['초급', '중급', '고급']
FOLDERS = {
    '초급': {'id': 'ko-a', 'color': 'sage', 'icon': '\U0001F331',
             'desc': 'Beginner band. 국립국어원 A grade.'},
    '중급': {'id': 'ko-b', 'color': 'sky', 'icon': '\U0001F33F',
             'desc': 'Intermediate band. 국립국어원 B grade.'},
    '고급': {'id': 'ko-c', 'color': 'clay', 'icon': '\U0001F333',
             'desc': 'Advanced band. 국립국어원 C grade.'},
}
# Half the Cambridge builds' rate, and its own constants rather than theirs:
# those crawl dictionary.cambridge.org, this one competes with the extension
# for the one endpoint that gives a Korean word its only meaning. ~2 req/s.
# ponytail: a guess, not a measurement — the endpoint documents no budget. It
# survived 3,901 words at twice this and still ended in a 429, so the number
# to trust is "slower than that".
WORKERS = 2
PAUSE = 0.5

# 동사 verbs, 형용사 adjectives, 보조 용언 auxiliaries: dictionary forms that
# never reach the surface. See the module docstring.
INFLECTED = {'동사', '형용사', '보조 용언'}
HANGUL = re.compile(r'^[가-힣]+$')

# ponytail: the 조사 list, duplicated from lang/ko/index.js because this is
# Python and that is JavaScript. It is used for one boolean — is the word
# findable in the context — and the alternative is a whole parse page and a
# headless-Chrome round-trip to borrow VT.has. Longest first, as there.
# If lang/ko/index.js's JOSA table grows, this can drift; the selftest below
# is what notices, and a drift costs a few dropped contexts, never a wrong one.
JOSA = (r'에서는|에게서|으로서|으로써|에서도|에게는|에게도|으로는|부터는|까지는'
        r'|에서|에게|한테|께서|으로|부터|까지|보다|처럼|마다|밖에|이랑'
        r'|하고|이나|을|를|이|가|은|는|과|와|에|뿐|도|만|의|로|께|랑|나')
LEADS = re.compile(rf'^(?:{JOSA})(?![가-힣])')


def findable(word, text):
    """Whole-eojeol, the shape lang/ko/index.js's match() tests for.

    Without it a context is stored that the card cannot blank, and the review
    prints its own answer: `금` would take 황금 and `색` would take 색깔.
    """
    return re.search(rf'(?<![가-힣]){re.escape(word)}(?:{JOSA})?(?![가-힣])', text)


def context(word, explanation):
    """A usable phrase out of NIKL's collocation line, or None.

    `explanation` is NOT a definition, whatever the source README says. It is
    the collocation line with the headword elided, written three different
    ways — 가게 → "에 가다", 가방 → "~을 메다", 가까이 → "가까이 다가오다" —
    and sometimes a bare semantic hint instead (가을 → "계절"), which is not a
    phrase and gets no context at all. Clauses are split on ';' and tried in
    order: 가스 → "gas; 가스가 떨어지다" is a hint AND a collocation.
    """
    for clause in (explanation or '').split(';'):
        phrase = clause.strip()
        if not phrase:
            continue
        if '~' in phrase:                      # NIKL's own placeholder
            phrase = phrase.replace('~', word)
        elif word in phrase:                   # already written out in full
            pass
        elif LEADS.match(phrase):              # elided at the front: 가격 + 이 비싸다
            phrase = word + phrase
        else:
            continue                           # a hint, not a collocation
        if findable(word, phrase):
            return phrase
    return None


def key(raw):
    """The saved word: NIKL's homograph number off, and Hangul only."""
    word = re.sub(r'\d+$', '', raw)
    return word if HANGUL.match(word) else None


def source_rows():
    """The TSV, cached on disk — one 1.5MB fetch, and it never changes."""
    WORK.mkdir(parents=True, exist_ok=True)
    if not TSV.exists():
        body, _ = ielts.get(SOURCE, timeout=60)
        TSV.write_text(body, encoding='utf-8')
        print(f'fetched {SOURCE}', flush=True)
    with TSV.open(encoding='utf-8') as fh:
        return list(csv.DictReader(fh, delimiter='\t'))


def clean(rows):
    best = {}
    for i, row in enumerate(rows):
        band = BANDS.get(row['nikl_level'])
        if not band or row['part_of_speech'] in INFLECTED:
            continue
        word = key(row['word'])
        if not word:
            continue
        # Easiest wins: a form listed as both A and C is met first as an A.
        if word in best and ORDER.index(band) >= ORDER.index(best[word]['level']):
            continue
        best[word] = {'word': word, 'level': band, 'pos': row['part_of_speech'] or None,
                      'hanja': row['hanja'] or None,
                      'context': context(word, row['explanation']), 'rank': i}
    # Band first, then the source's own frequency order inside it, so the
    # drip-feed below teaches the commonest words first — ielts.assemble's
    # `order` map, by another name.
    return sorted(best.values(), key=lambda e: (ORDER.index(e['level']), e['rank']))


def crawl(items):
    done = set()
    if CACHE.exists():
        with CACHE.open(encoding='utf-8') as fh:
            done = {json.loads(line)['word'] for line in fh if line.strip()}
    todo = [e for e in items if e['word'] not in done]
    print(f'{len(items)} words, {len(done)} cached, {len(todo)} to translate', flush=True)

    def gloss(item):
        vi = ielts.vietnamese(item['word'], 'ko')
        time.sleep(PAUSE)
        return item['word'], vi

    for start in range(0, len(todo), ielts.BATCH):
        chunk = todo[start:start + ielts.BATCH]
        with concurrent.futures.ThreadPoolExecutor(WORKERS) as pool:
            got = list(pool.map(gloss, chunk))
        # A null gloss is never cached. For the English builds a missing
        # translation is cosmetic next to the Cambridge definition; here the
        # gloss is the whole card, and caching a null would mean that word is
        # silently glossless forever. Not written = retried next run.
        with CACHE.open('a', encoding='utf-8') as fh:
            for word, vi in got:
                if vi:
                    fh.write(json.dumps({'word': word, 'vi': vi}, ensure_ascii=False) + '\n')
        hits = sum(1 for _, vi in got if vi)
        print(f'  {start + len(chunk)}/{len(todo)}  ({hits}/{len(got)} translated)', flush=True)
        # What a rate limit looks like from here: a whole batch of fifty comes
        # back empty. Cheaper than classifying HTTP codes on an endpoint with
        # none documented, and the cache already holds everything up to here.
        if not hits:
            raise SystemExit(f'{start} words in, a whole batch came back empty — almost '
                             'certainly rate-limited. The cache keeps what it has; re-run later.')


def assemble(items):
    vi = {}
    if CACHE.exists():
        with CACHE.open(encoding='utf-8') as fh:
            for line in fh:
                if line.strip():
                    got = json.loads(line)
                    vi[got['word']] = got['vi']
    # A card with no gloss has no meaning to ask for: the typing card cannot
    # use it and the review is a blank. Dropped rather than shipped empty.
    entries = [e for e in items if vi.get(e['word'])]

    day = 24 * 60 * 60 * 1000
    now = int(time.time() * 1000)
    folders, words_out = {}, {}
    for i, e in enumerate(entries):
        meta = FOLDERS[e['level']]
        fid = meta['id']
        folders.setdefault(fid, {
            'id': fid, 'name': e['level'], 'color': meta['color'], 'icon': meta['icon'],
            # Explicit, unlike the English lists, which are only filed as
            # English because script detection happens to agree. It makes the
            # three cards right in a Korean session before the import has
            # finished writing a single word (lib.js folderLang).
            'lang': 'ko', 'auto': False, 'added': now, 'desc': meta['desc']})
        # ponytail: hand-built, and has to be kept in step with VT.newEntry
        # (lib.js:697). A Chrome round-trip for 21 literal keys would mean a
        # parse page for a build that otherwise needs no browser at all.
        words_out[e['word']] = {
            'word': e['word'],
            # Explicit for the same reason, and one the detector would get
            # right anyway — said out loud so the file does not depend on it.
            'lang': 'ko',
            'folders': [fid],
            'level': e['level'],
            'pos': e['pos'],
            # ponytail: 漢字 rides in `gram`, which means Cambridge's grammar
            # code. They render in the same slot beside `pos` (sidepanel.js:32)
            # and "명사 干涉" reads correctly, so it is the right pixel and the
            # wrong name. Give hanja its own field the day anything formats
            # `gram` as a grammar code rather than printing it.
            'gram': e['hanja'],
            'vi': vi[e['word']],
            # NIKL's collocation line with the headword put back, or null.
            # Not a sentence — see README's Known limits.
            'context': e['context'],
            # Everything a dictionary would fill, and there is no dictionary:
            # no krdict key, so these stay null exactly as they do for a word
            # saved from a page (lang/ko/dictionary.js).
            'ipa': None, 'def': None, 'audio': None, 'ipaUs': None, 'audioUs': None,
            'senses': [], 'synonyms': [], 'related': [],
            'sources': [SOURCE],
            'added': now, 'ease': 2.5, 'interval': 0, 'reps': 0,
            # The drip-feed the English lists use, so the file behaves like a
            # course rather than a wall of 3,900 cards due at once.
            'due': now + (i // ielts.NEW_PER_DAY) * day,
        }

    OUT.parent.mkdir(parents=True, exist_ok=True)
    payload = {'exported': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
               'folders': folders, 'words': words_out}
    OUT.write_text(json.dumps(payload, ensure_ascii=False, indent=1), encoding='utf-8')

    counts = {band: sum(1 for e in entries if e['level'] == band) for band in ORDER}
    print(f'\n{OUT.relative_to(REPO)}: {len(entries)} words, {OUT.stat().st_size // 1024}KB')
    print('  ' + '  '.join(f'{k} {v}' for k, v in counts.items()))
    print(f'  collocation {sum(1 for e in entries if e["context"])}  '
          f'hanja {sum(1 for e in entries if e["hanja"])}  '
          f'no gloss, dropped {len(items) - len(entries)}')
    print(f'  last card due in {(len(entries) - 1) // ielts.NEW_PER_DAY} days')


def selftest():
    assert key('가격03') == '가격' and key('가게') == '가게'
    assert key('-가13') is None and key('도쿄(동경)') is None
    assert context('가게', '에 가다') == '가게에 가다'          # elided at the front
    assert context('가방', '~을 메다') == '가방을 메다'          # NIKL's placeholder
    assert context('가까이', '가까이 다가오다') == '가까이 다가오다'   # written out
    assert context('가위', '기구; 로 자르다') == '가위로 자르다'   # second clause wins
    assert context('가을', '계절') is None                     # a hint, not a phrase
    assert context('가구', '책상') is None
    assert context('금', '황금') is None                       # findable() earns its keep
    assert findable('책', '나는 책을 읽다') and not findable('책', '책상이 있다')
    print('selftest ok')


if __name__ == '__main__':
    selftest()
    items = clean(source_rows())
    crawl(items)
    assemble(items)
