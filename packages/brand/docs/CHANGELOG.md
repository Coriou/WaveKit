# Changelog

## 1.0.0 — imported as `@wavekit/brand` (9 October 2026)

Artwork, geometry and palette are unchanged from the 1.0.0 kit.

- Moved into the monorepo at `packages/brand/`. Boards now live in `previews/`; the
  duplicate board PNGs, `index.html`, `qa/`, `asset-manifest.json` and
  `CHECKSUMS.sha256` were dropped (the validator now checks content directly).
- Added the live fonts as WOFF2 with their OFL licences: D-DIN Condensed 400/700
  (upstream, unmodified) and Noto Sans 2.015 400/700/italic (Latin subset).
- Made dark a first-class theme: both themes are pinned by `data-wavekit-theme`, and
  with no attribute the page follows `prefers-color-scheme`. Added `--wk-focus-ring`,
  `.wk-panel` and named the kit's existing theme values; `tokens.json` gained `themes`.
- `source/build.py` now reproduces the core masters byte-for-byte; added
  `source/export.py` (PNG/ICO regeneration) and `source/subset_fonts.py`.
- React components follow the repo's TypeScript conventions (`.js` import suffixes).

## 1.0.0 — vector implementation

- Integrated the original signal-w as the first letter of a lowercase wordmark.
- Made MAKE SENSE OF THE SPECTRUM the official baseline, with compact outlined
  typography and both included/omitted variants.
- Created canonical flat colours and introduced forest for readable light-surface use.
- Rebuilt the boards as real vector geometry, not images wrapped in SVG containers.
- Replaced inconsistent generated pictograms with one Tabler-based icon system and
  three documented extensions; added eight category mappings.
- Removed invented chart labels, extra generic slogans and the unconfirmed domain.
- Corrected the old concept's unrealistic 80 px baseline minimum and ambiguous
  clearspace example. Added realistic 320 / 120 / 24 / 16 px guidance.
- Separated fixed logo lettering from the supplied D-DIN / Noto live font specification.
- Added source geometry, tokens, React components, manifests, licenses and QA tools.

The earlier raster explorations remain useful creative history but are not canonical
production assets. No commit or push to the WaveKit repository is part of this release.
