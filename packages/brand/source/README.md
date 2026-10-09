# Frozen vector source

`geometry.json` stores the original signal trace, fixed lettering outlines, baseline
outlines, per-icon construction, palette and decorative spectrum paths. It contains
no font file, encoded bitmap or network dependency.

Run from any directory:

```sh
python3 -I packages/brand/source/build.py --out /tmp/wavekit-core
```

This reassembles **46 core SVGs**: 12 wordmark/lockup variants, ten regular/small mark
variants, and eight pictograms in three treatments. It uses only the Python standard
library. It refuses to overwrite the kit root. The source logo geometry is frozen;
this script is not a typesetting engine and does not regenerate a font. After an
approved geometry change, build to a temporary directory, review the diff, then copy
the files over the masters in `logos/`, `marks/` and `icons/`, and update
`react/geometry.ts` / `react/icon-nodes.ts` to match.

The three boards (`previews/`), app treatments, baseline-only assets and social/editorial templates
are supplied as self-contained editable SVG compositions. Edit those files directly
when creating new layouts. Their text is outlined for reliable rendering; rewrite
editable content as live HTML using the typography rules for websites.

`validate.py` checks the distribution without modifying it:

```sh
python3 source/validate.py
python3 source/validate.py --render
```

The optional render pass requires CairoSVG and Pillow installed separately. It renders
all standalone SVGs, checks nonempty output and transparent-master bounds, and skips
the symbol library as a standalone image, and compares every file in `exports/` with
a fresh render. The standard pass also rebuilds the 46 core SVGs into a temporary
directory and requires them to be byte-identical to the masters, checks the React
geometry and tokens against their sources, recomputes theme contrast, and checks
font layout and licences.

`export.py` regenerates `exports/` (PNG and ICO) from the SVG masters with CairoSVG
and Pillow; `export.py --check` compares without writing. `subset_fonts.py` rebuilds
the Noto Sans WOFF2 subsets from the upstream TTFs (fontTools + brotli).

The validator detects structural and selected rendering issues, not artistic quality
or complete accessibility.
