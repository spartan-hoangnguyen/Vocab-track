#!/usr/bin/env python3
"""Render icons/icon-{16,32,48,128}.png from the dashboard's own brand mark.

The mark is .mark in dashboard.css: a rounded square of --ink with a Fraunces
600 "V" in --paper, the letter at half the box. Drawing it here rather than in
an image editor means the toolbar icon cannot drift from the one in the top bar
— change the CSS, re-run this.

Fraunces is inlined as a data: URI on purpose. An @font-face pointing at a file
loads asynchronously, and headless Chrome will happily screenshot a fallback
serif before it arrives, which is a bug you only catch by looking at the PNG.
"""
import base64, pathlib, subprocess, tempfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
INK, PAPER = '#1c1a17', '#faf7f2'
RADIUS, GLYPH = 8 / 30, 0.5          # both taken from .mark at 30px
SIZES = (16, 32, 48, 128)

font = base64.b64encode((ROOT / 'fonts/fraunces-latin.woff2').read_bytes()).decode()
out = ROOT / 'icons'
out.mkdir(exist_ok=True)

for size in SIZES:
    html = f"""<!doctype html><meta charset="utf-8"><style>
@font-face {{ font-family: F; font-weight: 600;
  src: url(data:font/woff2;base64,{font}) format('woff2'); }}
html,body {{ margin:0; background:transparent }}
div {{ width:{size}px; height:{size}px; border-radius:{size * RADIUS:.2f}px;
  background:{INK}; color:{PAPER}; display:grid; place-items:center;
  font:600 {size * GLYPH:.2f}px F, Georgia, serif }}
</style><div>V</div>"""
    with tempfile.NamedTemporaryFile('w', suffix='.html', delete=False) as f:
        f.write(html)
        page = f.name
    subprocess.run([
        CHROME, '--headless=new', '--disable-gpu',
        '--default-background-color=00000000',
        '--virtual-time-budget=4000',
        f'--window-size={size},{size}',
        f'--screenshot={out}/icon-{size}.png', f'file://{page}',
    ], check=True, capture_output=True)
    print(f'  icon-{size}.png  {(out / f"icon-{size}.png").stat().st_size:>6} B')
