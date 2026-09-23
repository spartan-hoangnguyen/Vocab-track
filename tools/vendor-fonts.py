#!/usr/bin/env python3
"""Vendor the three Google Fonts into fonts/, latin + latin-ext + vietnamese only.

Google serves one @font-face per subset (42 of them). The dashboard only ever
renders Latin and Vietnamese text — Korean falls back to a system font, because
none of these three families has Hangul — so the other subsets are dead weight.
"""
import pathlib, re, urllib.request

URL = ('https://fonts.googleapis.com/css2?'
       'family=Fraunces:opsz,wght@9..144,400;9..144,600'
       '&family=Inter:wght@400;500;600'
       '&family=Nunito:wght@600;700;800&display=swap')
UA = ('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
      '(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36')
KEEP = {'latin', 'latin-ext', 'vietnamese'}
OUT = pathlib.Path.home() / 'work/Vocab-track/fonts'


def get(url):
    return urllib.request.urlopen(
        urllib.request.Request(url, headers={'User-Agent': UA})).read()


css = get(URL).decode()
OUT.mkdir(exist_ok=True)
blocks, seen = [], {}

# Each block is preceded by a /* subset */ comment, which is the only place the
# subset name appears — the URLs are opaque hashes.
for subset, body in re.findall(r'/\*\s*([\w-]+)\s*\*/\s*(@font-face\s*\{.*?\})', css, re.S):
    if subset not in KEEP:
        continue
    family = re.search(r"font-family:\s*'([^']+)'", body).group(1)
    src = re.search(r'url\((https://[^)]+\.woff2)\)', body).group(1)
    name = f'{family.lower()}-{subset}.woff2'
    if name not in seen:                       # Fraunces repeats per axis block
        (OUT / name).write_bytes(get(src))
        seen[name] = True
        print(f'  {name:32} {(OUT / name).stat().st_size // 1024:>4} KB')
    blocks.append(f'/* {subset} */\n' + body.replace(src, name))

(OUT / 'fonts.css').write_text(
    '/* Vendored from Google Fonts so the dashboard loads no third-party\n'
    '   request and works offline. Fraunces, Inter and Nunito are all under\n'
    '   the SIL Open Font License 1.1 — see fonts/OFL.txt.\n'
    '   Regenerate with tools/vendor-fonts.py. */\n\n'
    + '\n\n'.join(blocks) + '\n')
print(f'\n{len(seen)} files, fonts.css has {len(blocks)} @font-face rules')
