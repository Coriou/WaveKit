# WaveKit brand instructions for agents

Scope: brand composition and implementation. These instructions do not authorize
public releases, domain purchases, licensing changes or deployment. The brand owner
imported this kit into the WaveKit monorepo as `@wavekit/brand` (`packages/brand/`);
edits here are ordinary repository changes, under the rules below and the repo's own
review process. See `README.md` for the package layout.

## Authority

1. A new explicit instruction from the brand owner.
2. This file and `brand.config.json` for invariant decisions.
3. `docs/` and `README.md` for application rules and asset selection.
4. `source/geometry.json` and the supplied SVG masters for geometry.
5. `previews/` (the three guideline boards) for visual examples; `exports/` holds
   derived rasters that `source/export.py` regenerates from the SVG masters.

The previous generated raster boards are concept material, not a specification.
Never trace those images, scrape their letters, reproduce their errors or invent
new paths when a supplied SVG exists.

## Non-negotiables

- Write the name **WaveKit** in prose. The integrated logo reads **wavekit**.
- The signal-w replaces the first w. Do not append a second w or spell “WaveWaveKit”.
- Official baseline, including casing: **MAKE SENSE OF THE SPECTRUM**. No period.
- Use a supplied baseline lockup at widths of 320 CSS px or more. Below that,
  use the plain wordmark; below 120 px, use the mark. Use the small mark at 16–23 px.
- Lockups are vector artwork. Do not retype, re-kern, recolour individual letters,
  stretch, squish, round the signal terminals or change the logo stroke width.
- `on-light` uses forest + ink. `on-dark` uses phosphor + paper. Do not put pale mint
  text or informative mint icon strokes on the paper background.
- Category icons come only from this pack. For expansion, use the same Tabler-based
  24 × 24 / 2-unit / round-cap system and request design review for a new pictogram.
- Category names: Aircraft, Marine, Aviation data, Voice, Paging, APRS, Sensors, Mesh.
  Executable names belong in technical docs, not under the brand pictograms.
- Do not label APRS “Satellites”; do not put VDL2 under Marine; do not put P25/DMR under
  Paging. See `icons/categories.json` for the signal-to-category mapping.
- Do not resurrect “REAL SIGNALS. REAL POSSIBILITIES.”, “SIGNALS INTO INSIGHT”,
  “SIGNAL INTO INSIGHT”, “ANALYZE / CAPTURE / DECODE / BUILD”, or the ANALYSE spelling.
  Do not add replacement marketing slogans as filler.
- Spectrum art is decorative. Do not add pretend axes, units, frequencies, protocol
  annotations, throughput values or simulated live status. Real plots require real data.
- Do not use `wavekit.org` or another domain not confirmed by the owner.

## Typography and accessibility

Live headings: D-DIN Condensed, 400 / 700. Live body/UI: Noto Sans, 400 / 700 / italic.
Use `tokens/typography.css`; the fonts ship in `fonts/` with their OFL licences. The logo's Inter-derived lettering
and its Noto Sans Condensed baseline are fixed outlines, not extra live font families.
Do not replace them with D-DIN or an installed system font.

Preserve readable text sizes, the natural baseline width and adequate clearspace.
Use HTML labels next to icons. For decorative SVGs, hide them from assistive technology;
for meaningful ones, provide an accessible name. `currentColor` only inherits when
SVG is inline, not through an `<img>` boundary. Do not inline duplicate SVG IDs.

## Composing a new surface

Choose a supplied variant; preserve its aspect ratio; add at least ¼ of the visible
logo height as clearspace on each side; use the colour tokens; add only relevant
category icons; and keep explanatory prose in live text. Never use a screenshot of
the board as a production logo. The boards are compositions, not web page templates.

For a website or app, test the real component at 1×, 2×, light, dark, keyboard focus,
zoomed text, and the smallest intended layout. Do not declare an app accessible or
platform-approved based on the brand pack alone.

## Verification

Run `python3 -I source/validate.py` (`pnpm --filter @wavekit/brand validate`). After
SVG edits, also run `--render` with CairoSVG and Pillow installed. Core logo, mark and
icon masters come from `source/geometry.json` via `source/build.py`; change the
geometry and rebuild rather than hand-editing those SVGs, and keep `react/geometry.ts`
and `react/icon-nodes.ts` in step (the validator fails on drift). Regenerate derived
PNGs with `source/export.py` instead of editing them. `tokens/brand.css` is the colour
source; mirror changes in `tokens/tokens.json` and keep the validator's contrast checks
passing. Do not add status colours (success / warning / error) without brand review.
Keep `licenses/TABLER-MIT.txt` with distributed icon derivatives and each font's
`OFL.txt` beside it. Do not subset or modify D-DIN Condensed without renaming it
(Reserved Font Name). Do not silently relicense WaveKit brand assets.
