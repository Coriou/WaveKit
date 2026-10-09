# Accessibility and legibility

## Contrast of the prescribed colour pairs

Calculated from the fixed sRGB hex values using WCAG relative luminance.
Normal text is checked against 4.5:1. Informative graphics and necessary UI boundaries
are checked against 3:1. Thresholds are applied to unrounded ratios.

| Pair                                | Foreground | Background |   Ratio | Normal text | Informative graphics |
| ----------------------------------- | ---------- | ---------- | ------: | ----------- | -------------------- |
| Paper on ink                        | `#F4F7F5`  | `#111C19`  | 16.17:1 | Pass        | Pass                 |
| Phosphor on ink                     | `#7BECC7`  | `#111C19`  | 12.18:1 | Pass        | Pass                 |
| Forest on paper                     | `#16735C`  | `#F4F7F5`  |  5.35:1 | Pass        | Pass                 |
| Muted on paper                      | `#52645D`  | `#F4F7F5`  |  5.83:1 | Pass        | Pass                 |
| Muted text on dark                  | `#B9CAC1`  | `#111C19`  | 10.20:1 | Pass        | Pass                 |
| White on forest                     | `#FFFFFF`  | `#16735C`  |  5.77:1 | Pass        | Pass                 |
| Forest on white                     | `#16735C`  | `#FFFFFF`  |  5.77:1 | Pass        | Pass                 |
| Phosphor on paper — avoid           | `#7BECC7`  | `#F4F7F5`  |  1.33:1 | Fail        | Fail                 |
| Dark control border on dark surface | `#8BA598`  | `#192B24`  |  5.62:1 | Pass        | Pass                 |

Phosphor is the dark-surface accent. It is **not** a text or informative-icon colour
on paper. Use forest on light backgrounds. The light and dark SVG variants already
make this change. Muted text and control-border tokens are distinct from faint
**decorative** rules: never use `--wk-border-decorative` as the only way to identify an
input or a control boundary. These results do not cover arbitrary photographs,
opacity, gradients or user-chosen colours.

## Practical rules

Keep the baseline lockup at least 320 CSS px wide; switch to the plain wordmark below
that, then to the standalone mark below 120 px. These are conservative brand
recommendations, not universal eyesight guarantees. The application board includes
actual-size specimens for review at its native scale. Do not squeeze the whole board
into a mobile card and expect its labels to remain body-text sized.

Use live HTML text for content, instructions, charts and UI. The outlined board is a
visual reference, not an accessible replacement for the Markdown guidelines. Logo
outlines are supplied with root accessible names. When referenced through `<img>`,
supply `alt` on the image; internal SVG metadata is not a substitute for it.

Use a visible label beside category icons. In icon-only controls, put the accessible
name on the button or link. The React icons are decorative by default; a `label`
turns an icon into a named image. Do not repeat the same name on both the button and
a decorative child. A sprite symbol needs a name on its consuming `<svg>`.

Use the supplied currentColor masters **inline** to inherit CSS colour. An externally
referenced SVG in an `<img>` does not inherit its parent's colour. Choose a fixed
light/dark asset instead. Avoid applying whole-SVG opacity to disabled text without
rechecking contrast. Respect reduced-motion preferences; the supplied spectrum is
static and carries no measured-data claims.

The CSS uses 44 px minimum-height buttons as a practical interaction target, readable
body sizes and a visible focus style. Final keyboard order, focus visibility, labels,
zoom, reflow, screen-reader behaviour and all interaction states must still be tested
in the consuming application. This kit is not a full WCAG conformance audit.

## Primary references

- W3C, Understanding SC 1.4.3, Contrast (Minimum):
  https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html
- W3C, Understanding SC 1.4.11, Non-text Contrast:
  https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html

`source/validate.py` recomputes the semantic theme pairs (text, muted text, accent,
control borders and focus ring on both background and surface, in both themes) on
every run and fails below 4.5:1 for text or 3:1 for boundaries. Sources consulted
9 October 2026.
