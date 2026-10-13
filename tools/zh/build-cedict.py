#!/usr/bin/env python3
"""Build data/zh/cedict.json, a trimmed CC-CEDICT keyed on Simplified headwords.

The zh dictionary (lang/zh/dictionary.js) fetches this file once and reads a
word's pinyin and senses from it, so there is no lookup API to depend on.

Shape: { "学生": [["xuésheng", ["student", "schoolchild"]]], "行": [[…], […]] }
One [pinyin, senses] pair per reading, in CEDICT's order, so a word with
several readings (行 háng / xíng) keeps every one.

Trimmed to stay small (README records the size):
  * Simplified headwords only; the Traditional column is dropped.
  * Headwords of up to 6 characters, the most the zh pack offers a lookup for.
  * Pinyin with tone marks, syllables joined (xue2 sheng5 -> xuésheng), which
    is how a learner's dictionary prints a word.
  * Up to 3 senses per reading, after dropping the ones a card cannot use:
    variant-of and see-also cross references, "used in …", and classifier
    lines (CL:…). A reading left with none is dropped.
  * Inline references lose their bracketed pinyin and Traditional half:
    无|无[wu2] -> 无, 得[de2] -> 得.

Source: https://www.mdbg.net/chinese/dictionary?page=cc-cedict, CC BY-SA 4.0,
so data/zh/cedict.json is CC BY-SA 4.0 as well (see data/LICENSE).
Cache is /tmp/vocab-track-cedict; delete it to re-download.
"""

import gzip
import json
import pathlib
import re
import urllib.request

REPO = pathlib.Path(__file__).resolve().parent.parent.parent
OUT = REPO / 'data' / 'zh' / 'cedict.json'
WORK = pathlib.Path('/tmp/vocab-track-cedict')
SRC = WORK / 'cedict.txt.gz'
SOURCE = 'https://www.mdbg.net/chinese/export/cedict/cedict_1_0_ts_utf-8_mdbg.txt.gz'
MAX_SENSES = 3
MAX_CHARS = 6

LINE = re.compile(r'^(\S+) (\S+) \[([^\]]*)\] /(.*)/$')
# Senses that point elsewhere rather than say what the word means.
USELESS = re.compile(r'^(?:(?:old |unofficial |archaic |erroneous )?variant of |'
                     r'see (?:also )?|used in |CL:|also written |abbr\. for )', re.I)
REF_PAIR = re.compile(r'[^\s\[\]|/,;()"]+\|([^\s\[\]|/,;()"]+)\[[^\]]*\]')
REF_ONE = re.compile(r'([^\s\[\]|/,;()"]+)\[[^\]]*\]')

MARKS = {'a': 'āáǎà', 'e': 'ēéěè', 'i': 'īíǐì', 'o': 'ōóǒò', 'u': 'ūúǔù', 'ü': 'ǖǘǚǜ'}


def syllable(raw):
    """One numbered syllable to tone marks: hao3 -> hǎo, lv4 -> lǜ, ma5 -> ma."""
    m = re.fullmatch(r'([A-Za-züÜ:]+)([1-5])', raw)
    if not m:
        # Not a syllable (punctuation, a letter like "A" in A型): as it is,
        # minus CEDICT's u: spelling of ü.
        return raw.replace('u:', 'ü').replace('U:', 'Ü')
    body, tone = m.group(1).replace('u:', 'ü').replace('v', 'ü').replace('U:', 'Ü').replace('V', 'Ü'), int(m.group(2))
    if tone == 5:
        return body
    lower = body.lower()
    # The standard placement: a or e if present, the o of ou, else the last vowel.
    if 'a' in lower:
        at = lower.index('a')
    elif 'e' in lower:
        at = lower.index('e')
    elif 'ou' in lower:
        at = lower.index('o')
    else:
        at = max(lower.rfind(v) for v in 'iouü')
        if at < 0:
            return body  # r5 and other vowelless syllables carry no mark
    mark = MARKS[lower[at]][tone - 1]
    if body[at].isupper():
        mark = mark.upper()
    return body[:at] + mark + body[at + 1:]


def pinyin(numbered):
    """'xue2 sheng5' -> 'xuésheng'. Syllables join; a comma or dot keeps a space after it."""
    out = ''.join(syllable(s) for s in numbered.split())
    return out.replace(',', ', ').replace('·', ' · ').strip()


def senses(raw):
    out = []
    for sense in raw.split('/'):
        sense = sense.strip()
        # Tested before the references are stripped: CL:個|个[ge4] would
        # otherwise collapse to a bare 个 and pass as a sense.
        if sense and not USELESS.match(sense):
            out.append(REF_ONE.sub(r'\1', REF_PAIR.sub(r'\1', sense)))
        if len(out) == MAX_SENSES:
            break
    return out


def build(lines):
    table = {}
    for line in lines:
        m = LINE.match(line.strip())
        if not m:
            continue
        _, simp, numbered, defs = m.groups()
        # lang/zh/index.js isCandidate stops at 6 characters, so a longer
        # headword can never be looked up. The one lossless cut.
        if len(simp) > MAX_CHARS:
            continue
        kept = senses(defs)
        if not kept:
            continue
        py = pinyin(numbered)
        readings = table.setdefault(simp, [])
        same = next((r for r in readings if r[0] == py), None)
        if same:
            # Two lines, one reading (Traditional variants share a Simplified
            # form): one entry, senses merged up to the cap.
            same[1].extend(s for s in kept if s not in same[1])
            del same[1][MAX_SENSES:]
        else:
            readings.append([py, kept])
    return table


def fetch():
    if not SRC.exists():
        WORK.mkdir(parents=True, exist_ok=True)
        with urllib.request.urlopen(SOURCE, timeout=120) as res:
            SRC.write_bytes(res.read())
    return gzip.decompress(SRC.read_bytes()).decode('utf-8').splitlines()


def selftest():
    assert pinyin('xue2 sheng5') == 'xuésheng'
    assert pinyin('lv4') == 'lǜ' and pinyin('lu:4') == 'lǜ' and pinyin('nu:3 ren2') == 'nǚrén'
    assert pinyin('hao3') == 'hǎo' and pinyin('gou3') == 'gǒu' and pinyin('xiu1') == 'xiū'
    assert pinyin('gui4') == 'guì' and pinyin('lüe4') == 'lüè'
    assert pinyin('Bei3 jing1') == 'Běijīng' and pinyin('er2') == 'ér' and pinyin('r5') == 'r'
    assert pinyin('A A zhi4') == 'AAzhì'
    assert senses('to finish/variant of 瞭|了[liao3]/used with 得[de2] or 不[bu4]/CL:個|个[ge4]') == \
        ['to finish', 'used with 得 or 不']
    got = build(['學生 学生 [xue2 sheng5] /student/schoolchild/',
                 '行 行 [hang2] /row; line/',
                 '行 行 [xing2] /to walk/all right; OK!/',
                 '行 行 [heng2] /used in 道行[dao4 heng2]/',
                 '中華人民共和國 中华人民共和国 [Zhong1 hua2 Ren2 min2 Gong4 he2 guo2] /PRC/'])
    assert got == {'学生': [['xuésheng', ['student', 'schoolchild']]],
                   '行': [['háng', ['row; line']], ['xíng', ['to walk', 'all right; OK!']]]}, got


def main():
    selftest()
    table = build(fetch())
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(table, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    print(f'{OUT.relative_to(REPO)}: {len(table)} headwords, '
          f'{sum(len(r) for r in table.values())} readings, {OUT.stat().st_size / 1e6:.1f}MB')
    print('  学生', table.get('学生'))
    print('  行', table.get('行'))


if __name__ == '__main__':
    main()
