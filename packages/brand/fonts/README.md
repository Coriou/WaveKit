# Live fonts

WOFF2 files for the live type system, loaded by `../tokens/typography.css`. The logo,
baseline and board SVGs are outlined and never need these files.

| File                               | Family / face        | Source              | Change                |
| ---------------------------------- | -------------------- | ------------------- | --------------------- |
| `d-din/D-DINCondensed.woff2`       | D-DIN Condensed 400  | upstream v1.00      | none (byte-identical) |
| `d-din/D-DINCondensed-Bold.woff2`  | D-DIN Condensed 700  | upstream v1.10      | none (byte-identical) |
| `noto-sans/NotoSans-Regular.woff2` | Noto Sans 400        | upstream v2.015 TTF | subset, WOFF2         |
| `noto-sans/NotoSans-Bold.woff2`    | Noto Sans 700        | upstream v2.015 TTF | subset, WOFF2         |
| `noto-sans/NotoSans-Italic.woff2`  | Noto Sans 400 italic | upstream v2.015 TTF | subset, WOFF2         |

## Licences

Both families are under the SIL Open Font License 1.1. Each folder carries its licence;
copy it with the fonts whenever you vendor them.

- **D-DIN Condensed**: Copyright 2017 Datto Inc., design Charles Nix (Monotype).
  `d-din/OFL.txt` is the upstream `COPYING.txt`, which reserves the font names "D-DIN",
  "D-DIN Condensed" and "D-DIN Expanded". `d-din/FONTLOG.txt` is the upstream font log.
  Because of the Reserved Font Name, these files are **not** subset or converted: any
  modified version would have to be renamed, internally and in CSS.
- **Noto Sans**: Copyright 2022 The Noto Project Authors. `noto-sans/OFL.txt` is the
  upstream licence. It has no Reserved Font Name, so the subsets keep the "Noto Sans"
  name. All name-table records, including copyright and licence, are retained.

## Sources (fetched 9 October 2026)

- D-DIN: https://github.com/amcchord/datto-d-din, commit
  `e199c8441e758d6e492cd01ef52c3c67ba4bae26` (`D-DINCondensed.woff2`,
  `D-DINCondensed-Bold.woff2`, `COPYING.txt`, `FONTLOG.txt`).
- Noto Sans: unhinted static TTFs from
  `https://notofonts.github.io/latin-greek-cyrillic/fonts/NotoSans/unhinted/ttf/`
  (`NotoSans-Regular.ttf`, `NotoSans-Bold.ttf`, `NotoSans-Italic.ttf`, v2.015);
  licence from https://github.com/notofonts/latin-greek-cyrillic, commit
  `71cf6f3ca9c185d809dd800ce9a9e58e1c16f1b1` (`OFL.txt`).

## Coverage

D-DIN Condensed covers Basic Latin, Latin-1 and ISO 8859-15 (°, ·, µ, –, — included).
It has no U+2212 minus, U+2009 thin space or U+202F narrow no-break space (the CSS
stack falls back to Noto Sans for those), no arrows, and no tabular figures: set
live-updating numbers in Noto Sans with `.wk-numeric`.

The Noto Sans subset (about 36 KB per face) keeps Latin, Latin-1, Latin Extended-A,
general punctuation (dashes, thin/narrow spaces, primes, ‰), super/subscript digits,
currency, letterlike symbols (℃, Ω, №), ° · µ (U+00B5 and U+03BC) − × ± Δ, and all
OpenType layout features (`tnum`, `frac`, `case`, `zero`, …). Noto Sans has no arrow
glyphs at all, so arrows (U+2190 block) render from a system font. The exact ranges
are in `../source/subset_fonts.py`.

## Rebuilding the Noto subset

```sh
python3 -m venv /tmp/wk-fonts && /tmp/wk-fonts/bin/pip install fonttools brotli
# download the three TTFs listed above into /tmp/noto-ttf, then:
/tmp/wk-fonts/bin/python -I packages/brand/source/subset_fonts.py --src /tmp/noto-ttf
python3 -I packages/brand/source/validate.py
```

Changing the face list means updating `../tokens/typography.css` and the
`type.fonts` map in `../tokens/tokens.json` together; the validator checks that every
shipped font is loaded and every loaded font exists.
