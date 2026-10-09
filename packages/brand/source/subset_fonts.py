#!/usr/bin/env python3
"""Build the shipped Noto Sans WOFF2 subsets from the upstream static TTFs.

Needs fontTools and brotli (`pip install fonttools brotli`). Run with `python3 -I`.
Download the unhinted static TTFs first (see fonts/README.md for the exact URLs):

    python3 -I source/subset_fonts.py --src /path/to/noto-ttf

D-DIN Condensed is NOT processed here: its OFL carries the Reserved Font Name
"D-DIN Condensed", so a subset would have to be renamed. The upstream WOFF2 files
are shipped byte-for-byte instead.
"""
from __future__ import annotations
import argparse
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'fonts/noto-sans'
FACES = ('NotoSans-Regular', 'NotoSans-Bold', 'NotoSans-Italic')

# Latin + Latin-1 + Latin Extended-A, general punctuation (dashes, thin and narrow
# no-break spaces, bullets, primes, per-mille), super/subscript digits, currency,
# letterlike symbols (degree Celsius, ohm, numero) and the status-UI extras:
# degree, middle dot, micro (both U+00B5 and Greek mu), minus, multiplication,
# plus-minus and Greek capital delta. Noto Sans has no arrow glyphs (U+2190-21FF);
# the range is kept so a future upstream release with arrows is picked up, and
# browsers fall back to a system font for them until then.
UNICODES = (
    'U+0000-00FF,U+0100-017F,U+0192,U+0218-021B,U+02BB-02BC,U+02C6-02C7,'
    'U+02D8-02DD,U+0300-0308,U+030A-030C,U+0327-0328,U+0394,U+03A9,U+03BC,'
    'U+2000-206F,U+2070-209F,U+20A0-20C0,U+2100-214F,U+2190-21FF,U+2212-2215,'
    'U+FEFF,U+FFFD'
)


def build(src: Path) -> None:
    from fontTools import subset

    OUT.mkdir(parents=True, exist_ok=True)
    for face in FACES:
        source = src / f'{face}.ttf'
        if not source.is_file():
            raise FileNotFoundError(f'missing upstream font {source}')
        target = OUT / f'{face}.woff2'
        subset.main([
            str(source),
            f'--unicodes={UNICODES}',
            '--layout-features=*',
            '--name-IDs=*',
            '--name-languages=*',
            '--notdef-outline',
            '--flavor=woff2',
            f'--output-file={target}',
        ])
        print(f'{target.relative_to(ROOT)}: {target.stat().st_size} bytes')


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--src', type=Path, required=True, help='Directory holding the upstream static TTFs.')
    args = parser.parse_args()
    try:
        build(args.src)
    except (OSError, ImportError) as error:
        parser.exit(1, f'Font subset failed: {error}\n')


if __name__ == '__main__':
    main()
