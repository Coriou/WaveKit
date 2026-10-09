#!/usr/bin/env python3
"""Regenerate the PNG/ICO convenience exports from the SVG masters.

Needs CairoSVG and Pillow (`pip install cairosvg pillow`; CairoSVG also needs the
system cairo library). Run with `python3 -I`.

    python3 -I source/export.py            # rewrite exports/ from the SVGs
    python3 -I source/export.py --check    # compare without writing

Never edit a file in exports/ by hand: change the SVG master, then re-export.
"""
from __future__ import annotations
import argparse
import io
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

# (export, SVG master, width, height, opaque). Opaque exports are saved as RGB.
LOGOS = [f'{kind}-{tone}' for kind in ('lockup', 'wordmark')
         for tone in ('ink', 'on-dark', 'on-light', 'white')]
EXPORTS: list[tuple[str, str, int, int, bool]] = [
    *[(f'wavekit-{name}@2x.png', f'logos/wavekit-{name}.svg', 1360,
       430 if name.startswith('lockup') else 328, False) for name in LOGOS],
    *[(f'favicon-{n}.png', 'marks/favicon.svg', n, n, False) for n in (16, 32, 48, 64)],
    # The 16 px app icon uses the rounded badge; every other size uses the square master.
    ('wavekit-app-16.png', 'marks/wavekit-app-rounded.svg', 16, 16, False),
    *[(f'wavekit-app-{n}.png', 'marks/wavekit-app-square.svg', n, n, True)
      for n in (24, 32, 48, 64, 180, 192, 256, 512, 1024)],
    *[(f'wavekit-maskable-{n}.png', 'marks/wavekit-app-maskable.svg', n, n, True)
      for n in (192, 512)],
    ('repository-banner-1280x640.png', 'templates/repository-banner-1280x640.svg', 1280, 640, True),
    ('social-card-1200x630.png', 'templates/social-card-1200x630.svg', 1200, 630, True),
    ('social-square-1080x1080.png', 'templates/social-square-1080x1080.svg', 1080, 1080, True),
    ('editorial-cover-1600x900.png', 'templates/editorial-cover-1600x900.svg', 1600, 900, True),
]
ICO_SIZES = (16, 32, 48, 64)


def render(source: str, width: int, height: int, opaque: bool):
    import cairosvg
    from PIL import Image

    png = cairosvg.svg2png(url=str(ROOT / source), output_width=width, output_height=height)
    image = Image.open(io.BytesIO(png))
    return image.convert('RGB' if opaque else 'RGBA')


def same_pixels(a, b) -> bool:
    from PIL import ImageChops

    return a.size == b.size and ImageChops.difference(
        a.convert('RGBA'), b.convert('RGBA')).getbbox() is None


def run(check: bool) -> list[str]:
    from PIL import Image

    issues: list[str] = []
    rendered = {}
    for name, source, width, height, opaque in EXPORTS:
        image = render(source, width, height, opaque)
        rendered[name] = image
        target = ROOT / 'exports' / name
        if check:
            if not target.is_file() or not same_pixels(Image.open(target), image):
                issues.append(f'exports/{name}: differs from {source}; run source/export.py')
        else:
            image.save(target, optimize=True)
    frames = [rendered[f'favicon-{n}.png'] for n in ICO_SIZES]
    ico = ROOT / 'exports/favicon.ico'
    if check:
        if not ico.is_file():
            issues.append('exports/favicon.ico: missing')
        else:
            current = Image.open(ico)
            for frame in frames:
                current.size = frame.size
                current.load()
                if not same_pixels(current, frame):
                    issues.append(f'exports/favicon.ico: {frame.size[0]} px frame differs')
    else:
        largest = frames[-1]
        largest.save(ico, format='ICO', sizes=[f.size for f in frames], append_images=frames[:-1])
    return issues


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--check', action='store_true', help='Compare exports with fresh renders; write nothing.')
    args = parser.parse_args()
    try:
        issues = run(args.check)
    except (OSError, ImportError) as error:
        parser.exit(1, f'Export failed: {error}\n')
    for issue in issues:
        print(issue)
    if args.check:
        print(f'{len(EXPORTS) + 1} exports checked, {len(issues)} differ')
    else:
        print(f'Wrote {len(EXPORTS) + 1} exports to {ROOT / "exports"}')
    raise SystemExit(1 if issues else 0)


if __name__ == '__main__':
    main()
