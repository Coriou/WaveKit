# Pi pages adopt the UI kit — design

- **Date:** 2026-10-17
- **Status:** draft for owner review (defaults from the phase B handoff applied)
- **Sub-project:** B of three in [design system v1](2026-10-12-design-system-v1-design.md)
  (§1 goal, §9 scope). A = the kit, B = this, C = the web app.
- **Pages:** `packages/sdr-host/ui/` — the status page (`index.html`, `app.css`, `app.js`) and
  the first-boot setup page (`boot.html`, `boot.css`, `boot.js`). Design record:
  `packages/sdr-host/DESIGN.md`; product rules: `packages/sdr-host/PRODUCT.md`.

## 1. Goal

The two pages the Pi serves load `packages/brand/tokens/ui.css` and use its tokens and recipes,
so the canvas, the web app and the Pi cannot drift. No redesign: same content, same reading
order, same states (stale, missing, unmeasurable), same aria, same still-page geometry rules.

## 2. Constraints

- No build step, no network: `ui.css` is **copied** into `ui/brand/ui.css` with its SHA-256 in
  `ui/brand/README.md`, like the fonts. A unit test fails when the copy differs from
  `packages/brand/tokens/ui.css`.
- Both servers (`src/api/routes/ui.ts` on 8080, `scripts/pi-boot-status.py` on 80) serve it,
  and the image builder copies it (`BOOT_ASSETS`). The CSP is unchanged (`style-src 'self'`).
- Pi 3 rendering budget: no `backdrop-filter`, no infinite animation except on `opacity` or
  `transform`. The kit's glass recipe (`.wk-island`) is therefore not used.
- Dark only: `data-wk-theme="dark"` on `<html>`, default (phosphor) accent, default (ink) ground,
  no theme switcher, no Paper.

## 3. Token mapping

Every Pi colour already had a kit twin with the same value, except the two graticule alphas.

| Pi token (removed)   | Value               | Kit token               | Kit value          | Note                              |
| -------------------- | ------------------- | ----------------------- | ------------------ | --------------------------------- |
| `--ink`              | `#111c19`           | `--wk-surface`          | `#111c19`          | page field (a pane-like surface)  |
| `--well`             | `#0b1512`           | `--wk-well`             | `#0b1512`          | the screen                        |
| `--surface`          | `#192b24`           | `--wk-fill`             | `#192b24`          | the one raised tone               |
| `--rule`             | `#2c443b`           | `--wk-track`            | `#2c443b`          | unlit bars, pending step bar      |
| `--rule-strong`      | `#8ba598`           | `--wk-text-3`           | `#8ba598`          | dashed expected-rate line         |
| `--paper`            | `#f4f7f5`           | `--wk-text`             | `#f4f7f5`          |                                   |
| `--paper-2`          | `#b9cac1`           | `--wk-text-2`           | `#b9cac1`          |                                   |
| `--paper-3`          | `#8ba598`           | `--wk-text-3`           | `#8ba598`          |                                   |
| `--phosphor`, `--ok` | `#7becc7`           | `--wk-accent`           | `#7becc7`          |                                   |
| `--warn`             | `#f2b84b`           | `--wk-amber`            | `#f2b84b`          |                                   |
| `--fault`            | `#ff7a6b`           | `--wk-danger`           | `#ff7a6b`          |                                   |
| `--lamp-off`         | `#52645d`           | `--wk-text-5`           | `#52645d`          | hollow lamp ring only, never text |
| `--grat`             | phosphor at .07     | `--wk-line-08`          | accent line at .08 | +.01 alpha                        |
| `--grat-major`       | phosphor at .16     | `--wk-line-14`          | accent line at .14 | −.02 alpha                        |
| `--display`          | D-DIN, Repli, Noto  | `--wk-font-head`        | D-DIN, Noto        | Repli kept, see §5                |
| `--body`             | Noto, Repli, system | `--wk-font-ui`          | Noto, system-ui    | Repli kept, see §5                |
| `--mono`             | ui-monospace stack  | `--wk-font-mono`        | ui-monospace stack |                                   |
| `--space-1`…`-5`     | 4, 8, 12, 16, 24    | `--wk-sp-2, 4, 6, 7, 9` | same               |                                   |
| radii 12 / 8 / 2     |                     | `--wk-r-5 / r-4 / r-1`  |                    |                                   |

Type snaps follow design system §4.1 (15 → 16, 17 → 16, 28 → 26; letter-spacing `.1em` for
uppercase labels and `.02em` for headings; `.06`/`.08` go):

| Role                                             | Before               | After                                                              |
| ------------------------------------------------ | -------------------- | ------------------------------------------------------------------ |
| Verdict                                          | D-DIN 700 32 / 28    | `--wk-fs-display-2` / `--wk-fs-display-1`, `.02em`                 |
| Nameplate page name                              | D-DIN 700 20 `.06em` | `--wk-fs-2xl`, `.1em`                                              |
| Section legend                                   | D-DIN 700 15 paper-2 | `.wk-label[data-strong]` (13, `.1em`, text-3)                      |
| Contact word                                     | D-DIN 700 15         | `.wk-label[data-strong]`, state colour                             |
| Channel and row names                            | D-DIN 400 15 `.06em` | `--wk-fs-lg` (14), `.1em`, text-2                                  |
| Diagnostics group title, scope axis              | D-DIN 400 13         | `.wk-label` (12, `.1em`, text-3)                                   |
| Step name                                        | D-DIN 700 17 / 15    | `--wk-fs-xl` / `--wk-fs-lg`, `.1em`                                |
| Body, row values, client address and rate        | Noto 16 / 15         | `--wk-fs-xl` (16)                                                  |
| Setup note                                       | Noto 15              | `--wk-fs-xl` (16)                                                  |
| Verdict detail                                   | Noto 15              | `--wk-fs-lg` (14): at 16 the copy overflows its two reserved lines |
| Channel value                                    | Noto 17              | `--wk-fs-xl` (16)                                                  |
| Body-sm (rate lines, host, facts, clock caption) | Noto 14              | `--wk-fs-lg`                                                       |
| Caption (sub-lines, notes, readout)              | Noto 13              | `--wk-fs-md`                                                       |
| Plot labels                                      | Noto 12              | `--wk-fs-xs`                                                       |
| Rate unit, setup clock                           | 20                   | `--wk-fs-2xl`                                                      |
| Endpoint address                                 | mono 14              | `--wk-font-mono`, `--wk-fs-lg`                                     |
| Rate figure                                      | Noto 40              | stays local (`--pi-fs-rate: 40px`), see §5                         |

## 4. Kit recipes that replace local rules

| Local rule (deleted)                                 | Kit replacement                                                                                        |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `:root` colour, font and space tokens                | `[data-wk-theme]` tokens                                                                               |
| `body` font, colour, smoothing; `color-scheme`       | `wk-base` on `[data-wk-theme]`                                                                         |
| `::selection` (phosphor fill, ink text)              | `wk-base` selection (accent at .28)                                                                    |
| `:focus-visible` 2 px phosphor, offset 3             | `wk-base` focus: 1.5 px `--wk-focus`, offset 2 (scope keeps 6)                                         |
| `prefers-reduced-motion` block                       | `wk-base` reduced-motion rule                                                                          |
| `.visually-hidden`                                   | `.wk-sr`                                                                                               |
| `.legend`                                            | `.wk-label[data-strong]`                                                                               |
| `.diag-group__title`, `.scope__axis` type            | `.wk-label`                                                                                            |
| `.endpoint__url` / `.endpoint__copy` surfaces, hover | `.wk-field` shell with a `.wk-btn[data-variant="tonal"]`                                               |
| `.meter`, `.meter__fill`                             | `.wk-meter`, `.wk-meter-fill` driven by `--wk-level` (6 px tall, accent fill when ok; was 4 px text-2) |
| `.scope__readout` surface                            | `.wk-tip` (adds the kit's hairline and `--wk-e2` shadow)                                               |
| `.boot-open a` (phosphor face, hover hex)            | `.wk-btn[data-variant="primary"][data-size="lg"]`, 44 px tall                                          |
| `@keyframes blink`, `@keyframes running`             | kit `wk-pulse` (opacity only)                                                                          |

## 5. What stays Pi-specific, and why

- **Instrument parts:** verdict (and its dot), rate figure and its fixed boxes, scope (channels,
  graticule, traces, wash, expected and start lines, lane, cursor), step track and clock. They
  are the Pi's signature and have no kit recipe; they use kit tokens only.
- **Rate figure size (40 px):** read at arm's length from a phone beside the Pi; the kit's
  largest step is 32. Kept as one local token.
- **Lamps:** a hollow ring when dark, unknown or stale, filled when lit. `.wk-live` is a filled
  pulsing dot and cannot say "unknown" or "stale". Lamps keep their geometry and borrow
  `wk-pulse` for connecting/reconnecting.
- **Rows (`dl`):** a fixed name column, a glyph column and two reserved lines. `.wk-row` is a
  hoverable list item; these rows are not interactive, so a hover tint would mislead.
- **Client rows, sparkline, Wi-Fi bars, diagnostics subgrid:** layout specific to the page.
- **Metric-matched fallbacks:** the Pi scope sets `--wk-font-head` and `--wk-font-ui` to the
  kit's families plus the brand's Repli faces (`typography.css` defines the same stacks), so
  the still-page rule holds while the woff2 loads. Same faces, one extra fallback each.
- **Page layout constants:** the 1180/720 px panels, the 360 px side column, fixed name columns
  in `rem`, and section gaps of 32, 40 and 48 px (the kit's space scale stops at 24 for
  controls; these are page rhythm).
- **No glass:** the screen is a recessed well (`--wk-well`), not an island; `.wk-island` blurs.

## 6. Fonts

Kit buttons and strong labels use weight 700. D-DIN Bold was already vendored; Noto Sans Bold
(`fonts/noto-sans/NotoSans-Bold.woff2`, 37 kB) is added to `ui/brand/` so the buttons do not fall
back to regular under `font-synthesis: none`. It is downloaded only when a bold Noto glyph is
drawn (the Copy and Open buttons), never preloaded.

## 7. Verification

- Drift test: `ui/brand/ui.css` hash equals `packages/brand/tokens/ui.css`, and the README hash
  table covers it (`packages/sdr-host/tests/unit/operator-page-assets.test.ts`).
- Asset tests: every file a page or stylesheet references is served by both servers and copied
  by the image builder.
- Before/after screenshots at 390 and 1280 px (healthy, fault, stale, contact lost; setup
  running, failed, contact lost, complete) with a WCAG AA contrast pass over every visible text
  node and a keyboard focus check.
- `tests/unit/utils/pi-boot-page.test.ts`, sdr-host tests, typecheck, lint.
