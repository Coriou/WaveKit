# Canvas board harness

Renders design-canvas boards (`docs/web/canvas/*.dc.html`) headless with the canvas runtime, for
the before/after parity shots and the glass budget of the design system spec (§8). Used for the
board migration onto the UI kit (2026-10-16).

- `shoot.mjs <boardDir> <outDir> Board… [--themes dark,light] [--props JSON] [--click "Name"] [--eval file.js]`:
  full-page shots of each board, dark (True black + Mono) and Paper, with a paused, seeded clock
  so two runs are pixel-identical (Spectrum's trace inside Immersive aside). `--click` presses a
  `role=button` by exact accessible name first (drawers in Immersive); `--eval` prints the result
  of a script evaluated in the page.
- `perf-budget.js`: blurred elements, nested blurs, blurs on solid recipes or under Paper, and
  infinite animations touching anything but `opacity` and `transform`.
- `diff.py before after out [Board…]`: changed-pixel counts, bounding boxes and red diff images.
- `sbs.py out.png scale before after […]`: labelled side-by-side sheets.

Needs: Playwright with Chromium (`PLAYWRIGHT_FROM` = a path whose `node_modules` holds it), Python
with Pillow and NumPy, and the canvas runtime saved as `support.js` next to `shoot.mjs` or named by
`DC_RUNTIME` (it is `artifact-type/dc-runtime.js` of the canvas; it is not committed). Fonts come
from `packages/brand/fonts`.
