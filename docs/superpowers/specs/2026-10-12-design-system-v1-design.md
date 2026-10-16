# Design system v1 (WaveKit UI kit) — design

- **Date:** 2026-10-12
- **Status:** approved by the owner (2026-10-16). Plan: [2026-10-16-design-system-v1.md](../plans/2026-10-16-design-system-v1.md)
- **Branch:** `design/web-dashboard`
- **Sub-project:** A of three. A = design system v1 (this spec), B = Pi pages adopt the kit,
  C = web app foundation (stack, performance architecture, mock data server, canvas ↔ app
  mapping). Order agreed with the owner: A, then B, then C. B and C get their own specs.
- **Context:** [docs/web/DESIGN.md](../../web/DESIGN.md), [docs/web/THEME-TOKENS.md](../../web/THEME-TOKENS.md),
  [packages/brand/AGENTS.md](../../../packages/brand/AGENTS.md), the design canvas
  (https://claude.ai/artifact/Mr2W34vvZxc8tGFCdMvZHE, snapshot in `docs/web/canvas/`).

## 1. Goal

One WaveKit UI kit, canonical in `packages/brand`, that the design canvas, the Pi pages and the
future web app all load, so the three cannot drift. It normalises what the 19 canvas boards drew
independently (tokens, scales, component recipes, focus rules) and builds the performance rules
into the recipes.

The canvas stays the design source and a working board after the build starts (owner,
2026-10-12): new features and explorations start there, then get promoted into the kit and the
app. The kit is what makes that loop cheap.

## 2. Findings that drive the design

From a full inventory of `docs/web/canvas/*.dc.html` (2026-10-12):

- The 19-line token block is byte-identical in all boards; everything else drifts.
- Almost all component styling is inline; state colours are JS-built strings. Five boards define
  real classes (`.wk-sc`, `.wk-s`, `.wk-pl`, `.wk-r`, Immersive), with copied rules that drift
  (`.wk-seg`, `.wk-chipb`, `.wk-field`, `.wk-box`, `.wk-ghost`, `.wk-row`, `.wk-amb`, `.wk-out`).
- Chips: heights 28 / 30 / 32 / 36, font 12 / 12.5 / 13, outlined in Activity and filled
  elsewhere. Segmented "selected": `--wk-sel` (Scanner, ScanPlanner), `--wk-fill` (Settings,
  Listen, Receiver), accent fill (Tuner, against THEME-TOKENS §5.1). Six toast variants, seven
  menu variants, outline buttons in seven heights, selected-row alpha .08–.13.
- 21 font sizes, 13 control heights, radius one-offs (1.5, 3, 5, 7, 9, 10, 14, 15, 18), four
  easing curves, seven shadows, two monospace stacks.
- `.wk-scroll` used in Recordings but never defined there; reduced-motion handling missing in
  Activity, Map, Listen, Palette, Receiver and Messages; no focus rule in Identify,
  SettingsPhone, TunedGallery; Activity's search uses an accent border while editing.
- Performance: blurred dropdowns (24 px) nested in blurred drawers (26 px), about nine blurred
  surfaces on Map, blurred overlays on the live Spectrum plot, full-height blurred drawers over
  the waterfall, infinite pulse animations, the Listen meter animating `width`.

The canvas runtime appends every board's `<helmet>` to `document.head`, and a board imported
with `<dc-import>` injects its helmet into the importing page. Verified 2026-10-12 in the
headless harness: a styles-only board imported by another board applies its classes there.

## 3. Structure and single source

### 3.1 Files in `packages/brand/tokens/`

| File | Role |
| --- | --- |
| `ui.css` | **Source.** Hand-written, three cascade layers: `@layer wk-tokens, wk-base, wk-recipes;` |
| `ui.json` | Generated from `ui.css` by `source/build_ui.py`: every token per theme × ground × accent, plus the scales. Read by the validator and, in C, by the Tailwind/shadcn mapping. Never hand-edited. |
| `brand.css`, `typography.css`, `tokens.json` | Unchanged. `ui.css` does not contain `@font-face`; the app and the Pi pages load `typography.css`. |

- **`wk-tokens`:** today's token block moved byte for byte (values unchanged, including the
  `--wk-grp-*` band group hues, approved by the owner 2026-10-12), plus the new scale tokens
  (section 4). Theming stays on `data-wk-theme` / `data-wk-accent` / `data-wk-ground` on one
  element, as in THEME-TOKENS §2.
- **`wk-base`:** focus and selection rules (§5.1, kit-wide), `::selection`, caret, scrollbars,
  button reset, `.wk-sr`, the shared keyframes, `prefers-reduced-motion`.
- **`wk-recipes`:** the component classes (section 5).

Layers let the app's own CSS override a recipe without specificity fights; on the canvas inline
styles still win, as today.

### 3.2 Validator (`source/validate.py`)

New checks, run by `pnpm --filter @wavekit/brand validate`:

1. `ui.json` equals what `build_ui.py` generates from `ui.css`.
2. Contrast for every theme × ground × accent, turning THEME-TOKENS §6 into assertions: text
   tokens on their grounds and surfaces (4.5:1 for `--wk-text` … `--wk-text-4`, `--wk-text-5`
   documented as decorative), `--wk-focus` ≥ 3:1, accent text on `--wk-sel`, on-accent on accent,
   amber and danger text on Paper.
3. No colour literal (hex, `rgb(`, `hsl(`) in `wk-base` or `wk-recipes`; colours come from tokens.
4. No new colour beyond the moved token block (new colours need owner approval; status colours
   stay out per `packages/brand/AGENTS.md`).

### 3.3 The canvas

- **`Kit.dc.html`:** a styles-only board. Its helmet holds the canvas `@font-face` rules (blob
  URLs) and `ui.css` verbatim between `/* wk-ui begin */` and `/* wk-ui end */`. It renders an
  empty hidden element.
- **Every board** imports it once (`<dc-import name="Kit">`, first child of the root) and no
  longer carries its own token block, `@font-face`, `--wka-*` block or copied component rules.
  Board-specific rules (layout, plot, Map) stay in the board.
- **`scripts/web-canvas-kit.mjs`:** writes the kit section of a Kit board from `ui.css`;
  `--check` exits non-zero on drift. Takes the board path as an argument (the scratch copy or
  `docs/web/canvas/Kit.dc.html`).
- **Drift test:** `tests/unit/repo/web-canvas-kit.test.ts` fails when
  `docs/web/canvas/Kit.dc.html` does not contain the current `ui.css` verbatim, in either
  direction (a canvas edit that skipped the brand file, or a brand edit not synced to the canvas).
- **`Components.dc.html`:** the specimen board and the canvas ↔ app inventory (section 7).

### 3.4 The explore → promote loop

1. New designs and features are explored on the canvas first. A board may try a variant in a
   local `<style>` marked `/* wk-explore: <what> */` or inline.
2. Once the owner approves it, the rule moves into `ui.css`, Kit is re-synced with the script and
   the board drops its local rule.
3. `grep -l "wk-explore" docs/web/canvas` lists open explorations; the drift test catches a kit
   that moved on one side only.
4. In C, the app component listed in the inventory picks the change up from `ui.css`.

### 3.5 Docs

- THEME-TOKENS.md keeps the rationale and decision history and points to `ui.css` for values.
- New `packages/brand/docs/ui-kit.md`: recipe reference (class, sizes, states, the boards and
  later the app components that use it) and the explore → promote loop.
- DESIGN.md: decision log, the loop under "How we work", next session = B.

## 4. Foundations

### 4.1 Type

- Families: `--wk-font-ui` (Noto Sans, system-ui, sans-serif), `--wk-font-head` (D-DIN
  Condensed, Noto Sans, sans-serif), `--wk-font-mono` (ui-monospace, 'SF Mono', 'JetBrains Mono',
  Menlo, monospace; replaces the two stacks).
- Weights: 400 and 700 only.
- Sizes (`--wk-fs-*`):

| Token | px | Use |
| --- | --- | --- |
| `2xs` | 11 | tags, plot labels, counts |
| `xs` | 12 | meta, hints, section labels |
| `sm` | 12.5 | controls: chips, buttons, segments, tooltips |
| `md` | 13 | rows, body, menus, toasts |
| `lg` | 14 | fields, drawer body |
| `xl` | 16 | sub-headings |
| `2xl` | 20 | sheet / Settings headings |
| `3xl` | 22 | drawer h2 |
| `display-1` | 26 | frequency readouts |
| `display-2` | 32 | gallery titles, large readouts |

- Snaps: 10, 10.5, 11.5 → 11; 13.5 → 13 (rows, menus, toasts) or 14 (fields, drawer body);
  14.5 → 14; 15 → 16; 17, 18, 19 → 16 or 20 by role; 24 → 22 or 26 by role. The Palette input
  (17) becomes 16.
- Letter-spacing: `.1em` uppercase labels, `.02em` headings; `.04`, `.06`, `.08`, `.09` go.

### 4.2 Space

`--wk-sp-*`: 2, 4, 6, 8, 10, 12, 16, 20, 24. Gaps of 1, 3, 5, 7 and 9 snap to the nearest step.
Asymmetric control paddings are expressed in the recipes, not as extra steps.

### 4.3 Control heights

| Token | px | Use |
| --- | --- | --- |
| `--wk-h-xs` | 24 | inline remove / dismiss |
| `--wk-h-sm` | 28 | dense toolbars, inner segments, tokens |
| `--wk-h-md` | 32 | default chip, button |
| `--wk-h-lg` | 36 | drawer actions, primary, menu items, select, stepper |
| `--wk-h-touch` | 44 | search shells, island rail, suggestion options, phone controls, toasts |

26, 30, 34, 38, 40, 42, 46 snap. The island header (56) and dock (64) are island dimensions, not
control heights.

### 4.4 Radius

`--wk-r-1` 2 (tracks), `--wk-r-2` 4 (tags, tokens, inner segments, kbd), `--wk-r-3` 6 (controls,
tooltips), `--wk-r-4` 8 (rows, field shells), `--wk-r-5` 12 (islands, drawers, menus, popovers,
toasts), `--wk-r-pill` 999px, round 50 %. Menus and popovers at 10 become 12; other one-offs go.

### 4.5 Motion

- Durations: `--wk-dur-1` 120 ms (hover, tooltip), `--wk-dur-2` 150 ms (state colour),
  `--wk-dur-3` 200 ms (knob, small moves), `--wk-dur-4` 260 ms (drawers, panes, card layout),
  `--wk-dur-flash` 800 ms (one-shot row flash). The Settings jump-to highlight keeps its §5.1 timing
  (hold 0.6 s, fade 0.6 s) as `--wk-dur-jump` 600 ms.
- Easings: `--wk-ease-out` cubic-bezier(.16,1,.3,1), `--wk-ease-inout` cubic-bezier(.2,.8,.2,1),
  `--wk-ease-spring` cubic-bezier(.34,1.32,.64,1) (tuned-card snap only). Plain `ease` goes.
- Keyframes: one `wk-pulse` (opacity 1 → .35) and one `wk-spin` replace `wkpulse`,
  `wk-hold-pulse`, `wkspin`, `wk-id-spin`; one `wk-ping` (scale + fade ring) replaces
  `wk-pl-pulse` and `wk-disc-new`; `wk-rise` covers `wkrise` / `wktoast` / `wk-id-in` / `wk-pane`.
- `@media (prefers-reduced-motion: reduce)` in `wk-base` sets every transition and animation
  duration to near zero kit-wide; continuous indicators show their static state.

### 4.6 Elevation

| Token | Use | Replaces |
| --- | --- | --- |
| `--wk-e1` | islands | `--wk-shadow` |
| `--wk-e2` | menus, toasts, tooltips, popovers | `--wk-shadow-pop`, `-tip`, `-drawer` |
| `--wk-e3` | drawers, sheets | `--wk-shadow-lg`, `-xl` |
| `--wk-e4` | dragging, lifted card | `--wk-shadow-lift` |

Each level includes the inset top highlight (`--wk-glass-hi`) on dark grounds and none on Paper
(already the Paper rule). The old shadow tokens stay as aliases until the board migration ends,
then are removed.

### 4.7 Materials and the glass budget

Three materials:

| Material | Fill | Blur | Used by |
| --- | --- | --- | --- |
| glass | `--wk-glass` / `--wk-glass-panel` | 24 px + `--wk-glass-fx`, dark only | small floating islands: Tuner, Receiver, Listen, dock, status, floating tuned card, Spectrum overlay chips, Map islands |
| solid | `--wk-glass-strong` / `--wk-fill-glass` (about 92 %) | none | drawers, menus, toasts, tooltips, popovers, suggestion lists |
| surface | `--wk-surface` | none | attached panes, sheets, docked tuned card |

Rules:

1. Blur only on the glass material, one radius (24).
2. Never blur inside a blurred element.
3. Paper has no `backdrop-filter` at all (its islands are 96 % opaque).
4. Drawers are solid (owner, 2026-10-12): a full-height blurred drawer over the waterfall re-blurs
   a large region every frame.
5. Infinite animations animate only `opacity` or `transform`; meters use `transform: scaleX`.
6. In the app (C), offscreen or hidden continuous animations pause.

## 5. Component recipes

Every recipe follows THEME-TOKENS §5.1 (focus, selection, hover). State is passed with `aria-*`
or `data-*` attributes (`aria-pressed`, `aria-selected`, `aria-checked`, `data-state`,
`data-size`, `data-variant`), not JS-built colour strings.

| Recipe | Canonical | Board changes |
| --- | --- | --- |
| `.wk-chip` | h32, padding 0 10 (0 10 0 8 with icon, icon 15 / stroke 1.9), r6, 12.5/700. Off `--wk-chip`; on `--wk-sel` + accent text; hover ink .09 (off only). Count 11/400. `data-tick` (tick .35 → 1). `data-size="sm"` h28 | Activity outlined chips → filled; Scanner 36 and Tuned 28 snap; Activity pinned-column pill tabs → chips with `role=tab` |
| `.wk-token` | h28, padding 0 2 0 10, r4, acc .14, accent 12.5/700, remove 24×24 r4 with 12 px ✕ at stroke 2.4 | none (already identical) |
| `.wk-switch` | track 36×20 r10, `--wk-track` / accent; knob 16 `--wk-knob`; `--wk-dur-3` `--wk-ease-out`. Hit box 48×36; `data-size="row"` 52×44 | Tuned's 34 px track fixed; the four `sw()` helpers go |
| `.wk-seg` | container padding 3, gap 2, r6, `--wk-well`, line .08; buttons h28 r4 12.5/700 (`data-size="lg"`: h36, 13); selected `--wk-sel` + accent; `.is-wide` grid | Settings, Listen, Receiver drop `--wk-fill` selected; Tuner demod drops its accent fill and underline mark (owner approved); Receiver sample-rate grid becomes a `.wk-seg` grid |
| `.wk-btn` | variants `primary` (accent, on-accent, hover brightness 1.08), `amber`, `tonal` (acc .12), `danger` (danger .16), `outline` (line .18, hover `--wk-chip`), `ghost` (hover acc .08). Sizes sm 28 / md 32 / lg 36; padding 0 12 (0 14 at lg; 0 12 0 10 with icon) | outline heights 7 → 3; ghost hover unified; Map save 42 → lg |
| `.wk-icon-btn` | 24 / 28 / 32 / 36 / 44, r6, icon 12 / 14 / 16 / 16 / 18, ghost behaviour. Close = 36 | Messages and Map close 32 → 36; Map zoom r8 → r6, glyphs → icons |
| `.wk-play` | round, 32 in rows, 40 in players, accent, inner-shape focus ring | Decode 34, Map 36 snap |
| `.wk-island` | glass material, r12, line .14, `--wk-e1`. Header h56, padding 0 12 0 16. Expanded panel same material with `--wk-glass-panel` | Map's blur 16 / 22 / 24 mix collapses |
| `.wk-drawer` | solid material, r12, line .14, `--wk-e3`, no blur; root 14 Noto; h2 D-DIN 22/700/.02em; close 36 | Activity and Recordings `--wk-glass` → solid; Scanner, Settings lose blur |
| `.wk-pane` | surface material, r 12 0 0 12, `--wk-e3`, concave corners, resize grip `.wk-grip` | moves from Immersive's helmet into the kit; the `!important` overrides go |
| `.wk-row` | r8, padding 10 6 10 10, gap 12; `.wk-tile` 32 r6 `--wk-fill`, icon 16 / stroke 1.9; hover acc .04; selected acc .11; keyboard cursor per §5.1; `data-fresh` flash acc .11 over `--wk-dur-flash`; `data-size="dense"` min-h 36 padding 0 8 (Map, Tuned) | Activity gains hover; Settings 34 and Palette 30 tiles → 32; selected alpha unified |
| `.wk-field` | search shell min-h44, padding 5 6 5 14, r8, `--wk-well-glass`, line .18 → .26 hover → .3 focus; input 14. Inline field h32 r6 transparent → line .18 hover. Placeholder `--wka-hint` | Activity's accent editing border and 46 / 14.5 sizes go; Scanner `.wk-box` / ScanPlanner `.wk-box` (.14) unify at .18 |
| `.wk-select`, `.wk-stepper` | h36 r6 `--wk-well-glass`, line .18; stepper buttons 36×36; phone `data-size="touch"` 44 | Settings only today |
| `.wk-menu`, `.wk-option` | solid material, r12, padding 6, `--wk-e2`; item h36 13 r6, hover / active acc .10; suggestion option `data-size="touch"` h44; footer hint 12 `--wka-hint` | seven menu variants → one; nested blur gone |
| `.wk-toast` | h44, padding 0 6 0 16, r12, `--wk-fill-glass`, `--wk-e2`, no blur, 13, check icon 16; Undo = `.wk-btn` tonal sm. `data-inline` variant: no shadow | six variants → one |
| `.wk-tip` | padding 6 10, r6, solid material, line .14, `--wk-e2`, 12.5 text, delay 400 ms, offset 8, `.wk-kbd` inside | Tuned and ScanPlanner snap; icon-only buttons use it instead of `title=` |
| `.wk-slider` | track 4 r2 `--wk-line-solid`, accent fill; knob 16 (`data-size="seek"` 12); invisible native range on top | Settings' native slider moves to it |
| `.wk-meter` | level fill via `transform: scaleX`; squelch handle and hatched zone as today | Listen stops animating `width` |
| `.wk-tag` | h18, padding 0 6, r4, 11/700; variants neutral (`--wk-chip`), accent (acc .12), outline (line .18), amber; `data-size="md"` h22 12/700; `.wk-count` pill h18 accent / on-accent | outline .22 → .18; h16 / h20 tags snap |
| `.wk-label` | D-DIN 12/400/.1em uppercase text-3; `data-strong` 13/700; `.wk-h2` 22/700/.02em, `.wk-h3` 20/700/.02em | ScanPlanner Noto h2 → D-DIN; odd letter-spacings go |
| `.wk-kbd` | 11, r4, padding 1 5, line .18, text-3, min 18×18 | four variants → one |
| `.wk-scroll`, `.wk-hscroll` | thin, thumb acc .18 / hidden | Recordings' missing rule fixed; Palette's webkit bar goes |
| Base | `:focus-visible` outline 1.5 `--wk-focus` offset 2 (buttons, `[tabindex]`, inputs, selects); `.wk-ring-inner`; `[data-wk-region]:focus-visible` top edge; `::selection` acc .28; caret accent; button reset (`font: inherit; border: 0; padding: 0; background: none; color: inherit; cursor: pointer`); `.wk-sr` | Identify, SettingsPhone, TunedGallery gain focus styling; the five scoped copies go |

The Components board shows each canonical recipe beside today's variants; the owner can overrule
any single pick there (step 3 in section 6) before boards migrate.

## 6. Migration plan (outline for writing-plans)

Each step ends green before the next starts.

1. **Kit source.** `ui.css` (token block moved, scales, base, recipes), `source/build_ui.py`,
   `ui.json`, validator checks. Brand validate passes.
2. **Canvas plumbing.** `Kit.dc.html` (scratch copy), `scripts/web-canvas-kit.mjs`, the drift
   test.
3. **Components board and owner checkpoint.** Specimens of every recipe in every state, dark
   (True black + Mono, Ink + phosphor) and Paper, beside the current variants, plus the
   inventory table. Publish Kit + Components; the owner reviews. Picks the owner overrules are
   changed in `ui.css` and re-synced. **No board migrates before this checkpoint.**
4. **Board migration.** Teammates get disjoint board batches, a shared brief (this spec plus the
   recipe reference) and their own harness copy and port. Per board: import Kit; remove the token
   block, `@font-face`, `--wka-*`, copied rules and local helpers (`sw`, `segc`, colour-string
   builders replaced by attributes); swap rendered components for recipe classes; apply the snaps.
   Layout, plot and Map drawing stay as they are. Suggested batches: (a) Scanner, ScanPlanner,
   Identify; (b) Settings, SettingsPhone, Palette; (c) Activity, Recordings, Messages, Decode,
   Json; (d) Tuner, Receiver, Listen, Tuned, TunedGallery; (e) Spectrum, Map; then Immersive alone,
   integrating everything.
5. **Publish and record.** All boards in one Artifact publish; snapshot into `docs/web/canvas/`;
   THEME-TOKENS pointer, `ui-kit.md`, DESIGN.md (decisions, the loop, next session = B), sticky.
   Remove the old shadow aliases once no board uses them.

## 7. Components board (inventory)

- One section per recipe: every size, variant and state (rest, hover, focus-visible, pressed /
  selected, disabled), rendered in three scopes side by side (dark True black + Mono, dark Ink +
  phosphor, Paper + Mono).
- A "today" strip under each recipe with the board variants it replaces (labelled by board), so
  the owner sees what changes.
- An inventory table: recipe → boards that use it → app component (column empty until C).
- Foundations sections: type scale, space, heights, radius, motion (live demos honouring reduced
  motion), elevation and materials over a mock waterfall strip.

## 8. Verification

- **Visual parity:** harness screenshots of every board before and after migration, dark and
  Paper, at the board's preview size (Immersive also with each drawer open). Any change outside
  the approved snaps is a defect.
- **Performance budget** (a harness script, `perf-budget.js`, on Immersive in default view, with
  a drawer open, and with drawer + pane):
  - at most 6 elements with a computed `backdrop-filter` other than `none`;
  - zero blurred elements with a blurred ancestor;
  - zero blur on `.wk-drawer`, `.wk-menu`, `.wk-toast`, `.wk-tip` and anything under
    `[data-wk-theme="light"]`;
  - no running infinite animation whose keyframes touch a property other than `opacity` or
    `transform`;
  - the kit section of `Kit.dc.html` at most 30 KB unminified.
- **Accessibility:** validator contrast checks; keyboard pass over the Components board (every
  interactive specimen shows focus-visible); reduced-motion rendering of the Components board.
- **Repo checks:** `pnpm --filter @wavekit/brand validate`, the drift test,
  `pnpm run typecheck`, `pnpm run lint`.

## 9. Out of scope

- Pi pages (`packages/sdr-host/ui`) adopting the kit: sub-project B.
- The web app, Tailwind/shadcn mapping, app components, WebGL plot, mock data server:
  sub-project C.
- New colours (none added; status colours stay out).
- Redesigning boards: only the snaps and recipe changes listed here.

## 10. Owner decisions recorded this session (2026-10-12)

- Order A → B → C.
- Scanner Follow hits: on by default for voice, including Airband AM.
- Band group hues `--wk-grp-*`: approved as drawn; part of the kit's token layer.
- Normalise by harmonising: canonical recipe per component, owner picks on the Components board.
- Approach: one kit canonical in `packages/brand`, mirrored by a Kit board, glass budget built in.
- Drawers become solid (no blur).
- The recipe picks in section 5, including Tuner demod losing its accent-filled selection.
- The canvas stays a working board in sync with the app (explore → promote loop).

## 11. Risks

- Board migration is large (about 1.4 MB of boards): mitigated by disjoint teammate batches and
  per-board parity shots.
- Immersive embeds most boards: migrated last, in one integration pass.
- The canvas runtime injects helmets on mount: verification always renders with every board
  fresh (harness rule).
- Two board instances share module scope (Activity drawer + pane): unaffected by styles, but
  migration must keep Activity's module-level store intact.
