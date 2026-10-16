# WaveKit UI kit (design system v1)

`tokens/ui.css` is the one source for WaveKit's interface: the themed tokens, the scales and the
component recipes. The design canvas (its `Kit` board), the Pi pages and the web app all load
it, so the three cannot drift. `tokens/ui.json` is generated from it
(`python3 -I source/build_ui.py`) and holds every token resolved per scope.

Spec: `docs/superpowers/specs/2026-10-12-design-system-v1-design.md` (on `design/web-dashboard`).
Token rationale and contrast history: `docs/web/THEME-TOKENS.md`.

## Using it

Load `tokens/typography.css` (fonts) and `tokens/ui.css`, then set the scope on one element:

```html
<div data-wk-theme="dark" data-wk-ground="black" data-wk-accent="mono">…</div>
```

- `data-wk-theme`: `dark` or `light`. Light is always on the `paper` ground.
- `data-wk-ground` (dark only): `ink`, `graphite` or `black`.
- `data-wk-accent`: `phosphor`, `ice`, `violet`, `coral` or `mono`.

The file has three cascade layers, `wk-tokens`, `wk-base` and `wk-recipes`, so an app's own
unlayered CSS overrides a recipe without specificity fights.

State goes in attributes, never in JS-built colour strings: `aria-pressed`, `aria-checked`,
`aria-selected`, `aria-current`, `data-size`, `data-variant`, `data-tone`.

## Foundations

| Scale | Tokens |
| --- | --- |
| Type families | `--wk-font-ui` (Noto Sans), `--wk-font-head` (D-DIN Condensed), `--wk-font-mono` |
| Type sizes | `--wk-fs-2xs` 11 · `xs` 12 · `sm` 12.5 · `md` 13 · `lg` 14 · `xl` 16 · `2xl` 20 · `3xl` 22 · `display-1` 26 · `display-2` 32 |
| Space | `--wk-sp-1` … `--wk-sp-9`: 2, 4, 6, 8, 10, 12, 16, 20, 24 |
| Control heights | `--wk-h-xs` 24 · `sm` 28 · `md` 32 · `lg` 36 · `touch` 44 |
| Radius | `--wk-r-1` 2 · `r-2` 4 · `r-3` 6 · `r-4` 8 · `r-5` 12 · `r-pill` |
| Motion | `--wk-dur-1` 120 ms · `dur-2` 150 · `dur-3` 200 · `dur-4` 260 · `dur-jump` 600 · `dur-flash` 800; `--wk-ease-out`, `--wk-ease-inout`, `--wk-ease-spring` (tuned-card snap only) |
| Elevation | `--wk-e1` islands · `e2` menus, toasts, tooltips · `e3` drawers, sheets, panes · `e4` dragging |
| Lines | `--wk-line-08`, `-14`, `-18`, `-26`, `-30` (hairline alphas) |

Weights are 400 and 700 only. Labels use `.1em` uppercase; headings `.02em`.

## Materials and the glass budget

| Material | Recipe | Blur |
| --- | --- | --- |
| glass | `.wk-island` (Tuner, Receiver, Listen, dock, status, floating tuned card, overlay chips) | `--wk-blur` (24 px), dark grounds only |
| solid | `.wk-drawer`, `.wk-menu`, `.wk-toast`, `.wk-tip` | none |
| surface | `.wk-pane`, sheets, docked tuned card | none |

Rules: blur only on glass; never blur inside a blurred element; no `backdrop-filter` on Paper
(`--wk-blur` resolves to `none` there); infinite animations touch only `opacity` and
`transform`; meters and sliders scale with `transform: scaleX(var(--wk-level))`.

## Recipes

| Class | Sizes and variants | States |
| --- | --- | --- |
| `.wk-chip` | h32; `data-size="sm"` h28; leading icon 15 px; `data-tick`; `.wk-count` inside | off, hover, on (`aria-pressed`/`aria-checked`/`aria-selected="true"`), disabled |
| `.wk-token` | h28 search filter with a 24 px remove button | hover on remove |
| `.wk-switch` | track 36 × 20, hit box 48 × 36; `data-size="row"` 52 × 44 | `aria-checked`, disabled |
| `.wk-seg` | buttons h28; `data-size="lg"` h36; `.is-wide` (equal columns), `.is-grid` (`--wk-seg-cols`) | `aria-checked`/`aria-pressed` on the button |
| `.wk-btn` | `data-variant` primary, amber, tonal, danger, outline, ghost; `data-size` sm 28, md 32, lg 36 | hover, focus-visible, disabled |
| `.wk-icon-btn` | 32; `data-size` xs 24, sm 28, lg 36, touch 44; `data-close` = 36 | hover, `aria-pressed` |
| `.wk-play` | 32; `data-size="lg"` 40; rings its shape on focus | hover |
| `.wk-island`, `.wk-island-head` | `data-expanded` (panel glass), `data-tone="amber"`; header h56 | |
| `.wk-drawer`, `.wk-pane`, `.wk-grip` | solid drawer, surface pane attached to its left | grip hover and focus |
| `.wk-row`, `.wk-tile` | `data-size="dense"` (min h36); tile 32 with a 16 px icon | hover, `aria-selected`/`aria-current`, `data-kb-cursor`, `data-fresh` |
| `.wk-field` | search shell, min h44, input 14 px | hover, focus-within |
| `.wk-input` | inline field h32 | hover, focus |
| `.wk-select`, `.wk-stepper` | h36; `data-size="touch"` 44 | hover |
| `.wk-menu`, `.wk-option`, `.wk-menu-sep`, `.wk-menu-foot` | option h36; `data-size="touch"` 44 | hover, `data-active`, `aria-selected`, `aria-checked` |
| `.wk-toast` | h44; `data-inline` (no shadow, no entrance) | |
| `.wk-tip` | 12.5 px, `.wk-kbd` inside | shown after 400 ms, offset 8 |
| `.wk-slider` | `.wk-slider-track`, `-fill`, `-knob`, a transparent native range on top; `data-size="seek"` | `--wk-value` 0–1, focus rings the knob |
| `.wk-meter`, `.wk-meter-fill` | `data-tone="amber"` | `--wk-level` 0–1 |
| `.wk-tag` | h18; `data-size="md"` h22; `data-variant` accent, outline, amber | |
| `.wk-count` | pill h18 | |
| `.wk-label`, `.wk-h2`, `.wk-h3`, `.wk-kbd` | `.wk-label[data-strong]` | |
| `.wk-live`, `.wk-spinner` | `data-tone` amber, danger | pulse and spin stop under reduced motion |
| `.wk-scroll`, `.wk-hscroll` | thin thumb; hidden bar | |
| `.wk-jump` | Settings jump-to highlight | |
| `.wk-sr` | visually hidden text | |

Base rules (`wk-base`): keyboard focus is `outline: 1.5px solid var(--wk-focus)` with a 2 px
offset, on `:focus-visible` only; `.wk-ring-inner` rings an inner shape; a focused region
(`[data-wk-region]`) shows a top edge; selection is accent .28; the caret is the accent; buttons
are reset; reduced motion stops every animation and transition.

## Changing the kit: explore, then promote

1. Explore new designs on the canvas first. A board may try a variant in a local `<style>`
   marked `/* wk-explore: <what> */`, or inline.
2. Once the owner approves it, move the rule into `tokens/ui.css`, run
   `python3 -I source/build_ui.py`, then sync the canvas Kit board with
   `node scripts/web-canvas-kit.mjs docs/web/canvas/Kit.dc.html` and republish it.
3. `grep -l "wk-explore" docs/web/canvas` lists the open explorations. The drift test
   (`tests/unit/repo/web-canvas-kit.test.ts`) fails when `ui.css` and the Kit board disagree.

New colours need the owner's approval: the validator pins the token block's colours by hash.
