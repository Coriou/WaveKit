# Logo system

## Core files

`wordmark` = integrated signal-w + avekit, no baseline, 680 × 164 viewBox.
`lockup` = the same wordmark + official baseline, 680 × 215 viewBox.

Suffixes: `on-dark`, `on-light`, `ink`, `white`, `currentColor`.
`black` versions are also supplied for literal one-ink black output.
`on-dark`/`on-light` are transparent artwork intended for those backgrounds.

For routine use, pick one of these masters. A detached badge plus another full
wordmark is not necessary: the w is already integrated. The standalone badge is used
where the application needs a separate app/profile icon rather than a duplicate w.

## Geometry

The inherited signal is one cubic Bézier path with a 26-unit stroke on a 256-unit
square. It has flat terminals and rounded joins. Its 30-unit small-size cut is separate.
The integrated mark uses the transform stored in `source/geometry.json` to match the
lettering's visual height and weight. The lettering and baseline are filled paths.
Do not alter a live stroke independently of the mark's scale.

The baseline uses compact bold outlined lettering with modest tracking. It is
centred at its natural width (about 491 units), not forced to span the 680-unit canvas.
No gradient, blur, clipping mask, external font, embedded image or CSS variable is
required by the logo assets.

## Baseline rules and minimum sizes

| Artwork                   | Recommended minimum displayed width |
| ------------------------- | ----------------------------------: |
| Wordmark + baseline       |                          320 CSS px |
| Wordmark alone            |                          120 CSS px |
| Standard standalone mark  |                           24 CSS px |
| Small-cut standalone mark |                           16 CSS px |

These are conservative design recommendations, not a universal guarantee across
all screens or printing processes. At a 320 px lockup width the baseline is about
16.9 px in nominal type size, with about 12.3 px cap height. At a width of 80 px it
would be unreadably small; do not carry over that number from the concept image.
Use the small cut only at 16–23 px; app/favicons have their own supplied files.

## Clearspace

Let H be the **visible height of the complete artwork in use**, including the baseline
when it is present. Keep at least ¼ H of empty space on every side. Apply this outside
the SVG canvas as a conservative implementation; the canvas contains only optical
padding, not the full exclusion area. Do not treat the waveform's full width as a
clearspace unit. Favicon/app-icon canvases are special self-contained cases.

## Do not

Do not add an ordinary w to the integrated wordmark; distort the aspect ratio; change
individual glyph spacing; retype the baseline; recolour letters separately; add
outlines, effects or gradients; use pale mint as small text on paper; or squash the
logo to make a long tagline fit. Hide the baseline and choose the compact asset.

## Print handoff

SVGs use sRGB hexadecimal colours. They are not press-profiled CMYK or spot-colour
art. Give the printer the appropriate vector file and the palette; request a physical
proof for colour-sensitive work. Confirm minimum sizes for the actual process,
especially embroidery, engraving, screen printing or coarse paper. Strokes may be
expanded by the production provider without altering the visible silhouette.
