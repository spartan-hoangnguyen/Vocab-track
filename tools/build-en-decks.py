#!/usr/bin/env python3
"""Build the bundled English word lists in data/en/, and data/decks.json.

Five files, all in the backup format the Import button already reads:

  data/en/topics.json        every CEFR-J / Octanove headword, A1-C2, one topic each
  data/en/phrasal.json       the phrasal verbs of tools/phrasal-verbs.txt, by band
  data/en/collocations.json  hand-written collocations, by topic
  data/en/idioms.json        hand-written idioms, by theme
  data/en/academic.json      the New Academic Word List, by band

and data/decks.json, the index the dashboard's Word lists card reads (one row
per folder, every language), so it can list them without loading megabytes.

Sources and licences (see data/LICENSE):
  - CEFR-J Vocabulary Profile 1.5 (Tono Lab, TUFS; free with citation) and the
    Octanove Vocabulary Profile C1/C2 1.0 (CC BY-SA 4.0), via
    openlanguageprofiles/olp-en-cefrj, the lists tools/build-cefr-list.py reads.
  - NAWL 1.2, Browne, Culligan & Phillips (CC BY-SA 4.0).
  - tools/en/*.tsv: ours. topics.tsv files each headword under one topic,
    the rest are written for this project. Curated by hand, so a rebuild is
    deterministic and needs nothing but the network for the gloss.

Nothing from a dictionary is shipped: no definition, IPA or audio. The
dashboard looks those up the first time a word is on screen (fillEntry). The
Vietnamese gloss on a CEFR word is machine translation, cached in WORK.
"""

import concurrent.futures
import csv
import importlib.util
import io
import json
import os
import pathlib
import re
import subprocess
import time

HERE = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('ielts', HERE / 'build-ielts-list.py')
ielts = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ielts)

REPO = ielts.REPO
DATA = REPO / 'data'
CURATED = HERE / 'en'
WORK = pathlib.Path(os.environ.get('EN_DECKS_WORK', '/tmp/vocab-track-en'))
CACHE = WORK / 'glosses.jsonl'

OLP = 'https://raw.githubusercontent.com/openlanguageprofiles/olp-en-cefrj/master'
CEFR_SOURCES = [f'{OLP}/cefrj-vocabulary-profile-1.5.csv',
                f'{OLP}/octanove-vocabulary-profile-c1c2-1.0.csv']
NAWL = 'https://www.newgeneralservicelist.com/s/NAWL_12_alphabetized_description.txt'
ORDER = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2']
WORD = re.compile(r'^[a-z]+(-[a-z]+)*$')
WORKERS = 4
PAUSE = 0.25

# The topic folders. Ids starting t_ are VT.TOPICS (lib.js), kept identical so
# a list word and a word you tagged by hand land in the same folder; the other
# four only the list needs.
# ponytail: names and icons copied from lib.js; the selftest checks they agree.
TOPICS = {
    't_people': ('People & Family', '\U0001F46A'),
    't_home': ('Home & Daily life', '\U0001F3E0'),
    't_shopping': ('Shopping & Clothes', '\U0001F6CD️'),
    't_food': ('Food & Drink', '\U0001F35C'),
    't_body': ('Body & Appearance', '\U0001F9CD'),
    't_health': ('Health', '\U0001FA7A'),
    't_emotions': ('Emotions & Personality', '\U0001F60A'),
    't_sports': ('Sports & Hobbies', '⚽'),
    't_arts': ('Arts & Entertainment', '\U0001F3A8'),
    't_media': ('Media & Communication', '\U0001F4F0'),
    't_technology': ('Technology', '\U0001F4BB'),
    't_science': ('Science', '\U0001F52C'),
    't_nature': ('Nature & Animals', '\U0001F43E'),
    't_environment': ('Environment', '\U0001F331'),
    't_travel': ('Travel & Transport', '✈️'),
    't_city': ('City & Places', '\U0001F3D9️'),
    't_education': ('Education', '\U0001F393'),
    't_work': ('Work & Business', '\U0001F4BC'),
    't_economy': ('Economy & Money', '\U0001F4B0'),
    't_politics': ('Politics & Government', '\U0001F3DB️'),
    't_law': ('Law & Crime', '⚖️'),
    't_society': ('Society & Culture', '\U0001F465'),
    't_time': ('Time & Numbers', '⏰'),
    't_thinking': ('Thinking & Ideas', '\U0001F4AD'),
    't_actions': ('Actions & Movement', '\U0001F3C3'),
    't_describing': ('Describing things', '✨'),
    't_core': ('Core words', '\U0001F9F1'),
}
COLLOCATION_TOPICS = {
    'c_daily': 'Daily life & home', 'c_work': 'Work & study', 'c_people': 'People & feelings',
    'c_society': 'Society & environment', 'c_money': 'Money & business',
    'c_health': 'Health & body', 'c_travel': 'Travel & places', 'c_ideas': 'Opinions & arguments',
}
IDIOM_THEMES = {
    'i_people': 'People & relationships', 'i_feelings': 'Feelings & moods',
    'i_work': 'Work & success', 'i_money': 'Money & business', 'i_time': 'Time & speed',
    'i_talk': 'Talking', 'i_problems': 'Problems & risk', 'i_life': 'Everyday life',
}
# Phrasal verbs and academic words come in bands, a few levels to a folder, so
# a folder is a course of a sensible size rather than six thin ones.
PHRASAL_BANDS = [('en-pv-a', 'A1–A2', ['A1', 'A2']), ('en-pv-b1', 'B1', ['B1']),
                 ('en-pv-b2', 'B2', ['B2']), ('en-pv-c', 'C1–C2', ['C1', 'C2'])]
ACADEMIC_BANDS = [('en-acad-b1', 'up to B1', ['A1', 'A2', 'B1']), ('en-acad-b2', 'B2', ['B2']),
                  ('en-acad-c', 'C1–C2 and specialist', ['C1', 'C2', None])]
COLORS = ['sage', 'sky', 'clay', 'ochre', 'plum']


def fetch(url):
    """Cached on disk: the sources never change between runs."""
    WORK.mkdir(parents=True, exist_ok=True)
    path = WORK / url.rsplit('/', 1)[1]
    if not path.exists():
        # curl, as build-cefr-list.py does: a stock macOS python has no CA bundle.
        path.write_text(subprocess.run(['curl', '-fsSL', url], check=True,
                                       capture_output=True, text=True).stdout, encoding='utf-8')
    return path.read_text(encoding='utf-8')


def cefr_words():
    """{word: (level, pos)}: the easiest level wins, as in build-cefr-list.py,
    and the parts of speech it is listed under at that level are joined."""
    best = {}
    for url in CEFR_SOURCES:
        for row in csv.DictReader(io.StringIO(fetch(url))):
            level = (row.get('CEFR') or '').strip().upper()
            if level not in ORDER:
                continue
            pos = (row.get('pos') or '').strip() or None
            for variant in (row.get('headword') or '').split('/'):
                word = variant.strip().lower()
                if not WORD.match(word):
                    continue
                was = best.get(word)
                if not was or ORDER.index(level) < ORDER.index(was[0]):
                    best[word] = (level, pos)
                elif level == was[0] and pos and pos not in (was[1] or ''):
                    best[word] = (level, f'{was[1]}/{pos}' if was[1] else pos)
    return best


def nawl_words():
    # The file opens with a paragraph and its references; the list is the run of
    # bare lowercase words after them.
    return [line.strip() for line in fetch(NAWL).splitlines() if WORD.match(line.strip())]


def tsv(name, columns):
    with (CURATED / name).open(encoding='utf-8') as fh:
        rows = [line.rstrip('\n').split('\t') for line in fh if line.strip()]
    bad = [r for r in rows if len(r) != columns]
    assert not bad, f'{name}: {len(bad)} rows without {columns} columns, first {bad[0]}'
    return rows


def glosses(words):
    """{word: vi}, machine-translated, cached. A null is never cached, so a word
    that failed is asked again on the next run (build-korean-list.py)."""
    done = {}
    if CACHE.exists():
        with CACHE.open(encoding='utf-8') as fh:
            for line in fh:
                if line.strip():
                    got = json.loads(line)
                    done[got['word']] = got['vi']
    todo = [w for w in dict.fromkeys(words) if w not in done]
    print(f'{len(done)} glosses cached, {len(todo)} to translate', flush=True)

    def gloss(word):
        vi = ielts.vietnamese(word, 'en')
        time.sleep(PAUSE)
        return word, vi

    for start in range(0, len(todo), ielts.BATCH):
        chunk = todo[start:start + ielts.BATCH]
        with concurrent.futures.ThreadPoolExecutor(WORKERS) as pool:
            got = list(pool.map(gloss, chunk))
        with CACHE.open('a', encoding='utf-8') as fh:
            for word, vi in got:
                if vi:
                    fh.write(json.dumps({'word': word, 'vi': vi}, ensure_ascii=False) + '\n')
                    done[word] = vi
        hits = sum(1 for _, vi in got if vi)
        print(f'  {start + len(chunk)}/{len(todo)}  ({hits}/{len(got)} translated)', flush=True)
        # A few dozen words the endpoint only ever echoes back (names, "pc")
        # are left every run, so a short re-run that finds nothing is those,
        # not a rate limit; they ship glossless and the dictionary covers them.
        # ponytail: a size heuristic; record misses if it ever misfires.
        if not hits and len(todo) > 2 * ielts.BATCH:
            raise SystemExit('A whole batch came back empty, almost certainly rate-limited. '
                             'The cache keeps what it has; re-run later.')
    return done


NOW = int(time.time() * 1000)


def entry(word, level, pos, vi, folder, i, context=None):
    # ponytail: hand-built, kept in step with VT.newEntry (lib.js) the way
    # build-korean-list.py's is. Dictionary fields stay empty: fillEntry in
    # dashboard.js asks the dictionary the first time the word is on screen.
    return {
        'word': word, 'lang': 'en', 'folders': [folder], 'level': level, 'pos': pos,
        'gram': None, 'vi': vi, 'context': context,
        'ipa': None, 'def': None, 'audio': None, 'ipaUs': None, 'audioUs': None,
        'senses': [], 'synonyms': [], 'related': [], 'sources': [],
        'added': NOW, 'ease': 2.5, 'interval': 0, 'reps': 0,
        # All due now, a millisecond apart, so review's oldest-first order asks
        # them in the order written here (easiest first) and the daily new-card
        # limit, not the file, sets the pace.
        'due': NOW + i,
    }


def folder(fid, name, icon, color, desc):
    return {'id': fid, 'name': name, 'color': color, 'icon': icon, 'lang': 'en',
            'auto': False, 'added': NOW, 'desc': desc}


def write(name, folders, words):
    path = DATA / 'en' / name
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {'exported': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
               'folders': folders, 'words': words}
    path.write_text(json.dumps(payload, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    print(f'{path.relative_to(REPO)}: {len(words)} words in {len(folders)} folders, '
          f'{path.stat().st_size // 1024}KB')


def by_level(items):
    """Easiest first, then alphabetical: the order the cards are asked in."""
    return sorted(items, key=lambda x: (ORDER.index(x[1]) if x[1] in ORDER else len(ORDER), x[0]))


def build():
    cefr = cefr_words()
    topic_of = dict(tsv('topics.tsv', 2))
    missing = [w for w in cefr if w not in topic_of]
    assert not missing, f'topics.tsv lacks {len(missing)} words, first {missing[:5]}'
    unknown = {t for t in topic_of.values() if t not in TOPICS}
    assert not unknown, f'topics.tsv uses unknown topics {unknown}'

    phrasal = tsv('phrasal.tsv', 2)
    collocations = tsv('collocations.tsv', 5)
    idioms = tsv('idioms.tsv', 5)
    nawl = nawl_words()
    vi = glosses([*cefr, *(p for p, _ in phrasal), *nawl])
    # The endpoint capitalises a sentence's first letter ("a" → "Một"); a gloss
    # is not a sentence.
    vi = {w: g[0].lower() + g[1:] if g[:1].isupper() and g[1:2].islower() else g for w, g in vi.items()}

    # Topics.
    words, folders = {}, {}
    for i, (word, level) in enumerate(by_level((w, lv) for w, (lv, _) in cefr.items())):
        tid = topic_of[word]
        name, icon = TOPICS[tid]
        folders.setdefault(tid, folder(tid, name, icon, COLORS[len(folders) % len(COLORS)],
                                       f'{name}: words from A1 to C2.'))
        words[word] = entry(word, level, cefr[word][1], vi.get(word), tid, i)
    write('topics.json', dict(sorted(folders.items(), key=lambda kv: kv[1]['name'])), words)

    # Phrasal verbs.
    words, folders = {}, {}
    for i, (verb, level) in enumerate(by_level(phrasal)):
        fid, band, _ = next(b for b in PHRASAL_BANDS if level in b[2])
        folders.setdefault(fid, folder(fid, f'Phrasal verbs · {band}', '\U0001F517',
                                       COLORS[len(folders) % len(COLORS)],
                                       f'Common phrasal verbs, {band}.'))
        words[verb] = entry(verb, level, 'phrasal verb', vi.get(verb), fid, i)
    write('phrasal.json', folders, words)

    # Collocations and idioms: our own gloss and example, nothing translated.
    for name, rows, groups, prefix, label, icon, pos in [
            ('collocations.json', collocations, COLLOCATION_TOPICS, 'en-col-', 'Collocations',
             '\U0001F91D', 'collocation'),
            ('idioms.json', idioms, IDIOM_THEMES, 'en-idiom-', 'Idioms', '\U0001F4AC', 'idiom')]:
        words, folders = {}, {}
        rows = sorted(rows, key=lambda r: (ORDER.index(r[2]), r[0]))
        for i, (phrase, group, level, gloss, example) in enumerate(rows):
            if phrase in words:
                continue
            fid = prefix + group.split('_', 1)[1]
            folders.setdefault(fid, folder(fid, f'{label} · {groups[group]}', icon,
                                           COLORS[len(folders) % len(COLORS)],
                                           f'{label} about {groups[group].lower()}, with an example each.'))
            words[phrase] = entry(phrase, level, pos, gloss, fid, i, context=example)
        write(name, dict(sorted(folders.items(), key=lambda kv: kv[1]['name'])), words)

    # Academic words: the level is the CEFR list's, when it has the word.
    words, folders = {}, {}
    rows = by_level((w, cefr.get(w, (None, None))[0]) for w in nawl)
    for i, (word, level) in enumerate(rows):
        fid, band, _ = next(b for b in ACADEMIC_BANDS if level in b[2])
        folders.setdefault(fid, folder(fid, f'Academic · {band}', '\U0001F4DA',
                                       COLORS[len(folders) % len(COLORS)],
                                       f'New Academic Word List, {band}. For IELTS and academic writing.'))
        words[word] = entry(word, level, cefr.get(word, (None, None))[1], vi.get(word), fid, i)
    write('academic.json', folders, words)

    index()


# Each bundled list, with the heading its folders sit under in the Word lists card.
INDEX = [('en/topics.json', 'Topics'), ('en/phrasal.json', 'Phrasal verbs'),
         ('en/collocations.json', 'Collocations'), ('en/idioms.json', 'Idioms'),
         ('en/academic.json', 'Academic'), ('ko/starter.json', 'Levels'),
         ('zh/hsk.json', 'Levels')]


def index():
    rows = []
    for file, group in INDEX:
        data = json.loads((DATA / file).read_text(encoding='utf-8'))
        counts = {}
        for e in data['words'].values():
            for fid in e.get('folders', []):
                counts[fid] = counts.get(fid, 0) + 1
        for fid, f in data['folders'].items():
            rows.append({'file': file, 'folder': fid, 'name': f['name'], 'icon': f.get('icon'),
                         # The older lists predate folder languages; English is the default.
                         'lang': f.get('lang', 'en'), 'desc': f.get('desc', ''),
                         'count': counts.get(fid, 0), 'group': group})
    path = DATA / 'decks.json'
    path.write_text(json.dumps(rows, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')
    print(f'{path.relative_to(REPO)}: {len(rows)} folders')


def selftest():
    lib = (REPO / 'lib.js').read_text(encoding='utf-8')
    for tid, (name, _) in TOPICS.items():
        if tid.startswith('t_') and f"id: '{tid}'" in lib:
            assert f"id: '{tid}', name: '{name}'" in lib, f'{tid} is named differently in lib.js'
    assert by_level([('b', 'B1'), ('a', 'C1'), ('c', 'A1'), ('d', None)]) == \
        [('c', 'A1'), ('b', 'B1'), ('a', 'C1'), ('d', None)]


if __name__ == '__main__':
    import sys
    selftest()
    index() if sys.argv[1:] == ['index'] else build()
