# Design System v1 (WaveKit UI kit) Implementation Plan

**Goal:** One WaveKit UI kit, canonical in `packages/brand/tokens/ui.css`, mirrored on the design
canvas by a styles-only `Kit` board, so the canvas, the Pi pages and the future web app cannot
drift.

**Spec:** [`docs/superpowers/specs/2026-10-12-design-system-v1-design.md`](../specs/2026-10-12-design-system-v1-design.md)
(approved by the owner 2026-10-16). Section numbers below (§) refer to it.

**Branch:** `design/web-dashboard`. Merge `origin/main` before starting each task. Commit only your
own paths (`git commit -- <paths>`), push the branch.

## Global constraints

- **No new colours.** The token block moves byte for byte from THEME-TOKENS §7. Any value that is
  not in it needs owner approval. Status colours stay out (`packages/brand/AGENTS.md`).
- **The canvas is the design source.** Boards change on the canvas first, then they are copied into
  `docs/web/canvas/`. Never edit the snapshot by hand.
- **No board migrates before the owner's Components review (Task 5).**
- **Performance budget** (§4.7, §8): blur only on the glass material, never nested, none on Paper,
  drawers solid, infinite animations on `opacity` and `transform` only, kit at most 30 KB.
- **Brand validator** (`pnpm --filter @wavekit/brand validate`) stays green after every task.
  It is standard-library Python (`python3 -I`); keep it so.
- Repo checks before each push: the touched test files, `pnpm run typecheck`, `pnpm run lint`.

## Tasks

### Task 1. Kit source: `packages/brand/tokens/ui.css`

- [ ] Write `ui.css` with `@layer wk-tokens, wk-base, wk-recipes;`.
  - `wk-tokens`: the THEME-TOKENS §7 block verbatim, then the scale tokens of §4 (type, space,
    heights, radius, motion, elevation e1 to e4, glass blur) on `[data-wk-theme]`. Keep the old
    `--wk-shadow*` tokens as aliases until Task 7 ends.
  - `wk-base`: focus and selection (THEME-TOKENS §5.1), `::selection`, caret, thin scrollbars,
    button reset, `.wk-sr`, keyframes `wk-pulse`, `wk-spin`, `wk-ping`, `wk-rise`, and the
    reduced-motion rule.
  - `wk-recipes`: every class of §5. State through `aria-*` and `data-*` attributes.
- [ ] Export it in `packages/brand/package.json` (`./tokens/ui.css`, `./tokens/ui.json`).
- [ ] Size check: at most 30 KB unminified.

### Task 2. `ui.json` and validator checks

- [ ] `source/build_ui.py`: parse `ui.css` and write `tokens/ui.json`. It holds every token
      resolved per theme × ground × accent (dark: ink, graphite, black × five accents; light: paper ×
      five accents), the scales, and the recipe class list. Output is deterministic (sorted keys,
      trailing newline). `--check` exits non-zero when the file on disk differs.
- [ ] `source/validate.py` gains `check_ui` (§3.2):
  1. `ui.json` equals a fresh build.
  2. Contrast per scope, measured on the solid fill and on the island glass composited over the
     plot: `--wk-text` to `--wk-text-4` ≥ 4.5 on the ground and the surface, `--wk-focus` ≥ 3,
     accent on `--wk-sel` ≥ 4.5, on-accent on accent ≥ 4.5, Paper amber and danger on the fill
     ≥ 4.5. Known exceptions from THEME-TOKENS §6 (text-4 on `--wk-fill` for Ink, Graphite and
     Paper) are listed by name, so any new failure still fails.
  3. No colour literal (hex, `rgb(`, `hsl(`) in `wk-base` or `wk-recipes`, except
     `transparent` and `currentColor`.
  4. Every colour in `wk-tokens` is one of the THEME-TOKENS §7 colours.
- [ ] `docs/ui-kit.md`: the recipe reference (class, sizes, states, the boards that use it) and the
      explore → promote loop (§3.4).

### Task 3. Canvas plumbing

- [ ] `scripts/web-canvas-kit.mjs <board>`: writes the text between `/* wk-ui begin */` and
      `/* wk-ui end */` in a Kit board from `ui.css`. `--check` exits non-zero on drift.
- [ ] `docs/web/canvas/Kit.dc.html`: a styles-only board. Its helmet holds the canvas
      `@font-face` rules (blob URLs) and the kit section. It renders one hidden element.
- [ ] `tests/unit/repo/web-canvas-kit.test.ts`: fails when the Kit snapshot does not contain the
      current `ui.css` verbatim.

### Task 4. Components board

- [ ] `Components.dc.html` (§7): one section per recipe, every size, variant and state (rest,
      hover, focus-visible, pressed or selected, disabled), in three scopes side by side (True black +
      Mono, Ink + phosphor, Paper + Mono). Under each recipe, a "Today" strip with the board variants
      it replaces, labelled by board. Foundations sections: type scale, space, heights, radius,
      motion (honouring reduced motion), elevation and materials over a mock waterfall strip. An
      inventory table: recipe → boards → app component (empty until sub-project C).
- [ ] Publish `Kit.dc.html` and `Components.dc.html` to the canvas in one call, in a new
      "Design system" row, and add both to `canvas.json`. No other board changes.
- [ ] Snapshot both into `docs/web/canvas/`.

### Task 5. Owner checkpoint

- [ ] The owner reviews the Components board and overrules picks. Each overruled pick changes in
      `ui.css`, then Kit is re-synced (`node scripts/web-canvas-kit.mjs`), republished and
      snapshotted.

### Task 6. Board migration (after Task 5)

Per board (§6 step 4): import Kit as the first child of the root; drop the token block,
`@font-face`, `--wka-*`, copied rules and colour-string helpers; swap rendered components for
recipe classes with state attributes; apply the snaps. Layout, plot and Map drawing stay.
Batches, each in its own harness copy: (a) Scanner, ScanPlanner, Identify; (b) Settings,
SettingsPhone, Palette; (c) Activity, Recordings, Messages, Decode, Json; (d) Tuner, Receiver,
Listen, Tuned, TunedGallery; (e) Spectrum, Map; then Immersive alone. Before and after shots of
every board, dark and Paper; any change outside the approved snaps is a defect.

### Task 7. Publish and record

- [ ] All boards in one publish; snapshot; `perf-budget.js` on Immersive (default view, a drawer
      open, a drawer and a pane) per §8.
- [ ] Remove the `--wk-shadow*` aliases once no board uses them.
- [ ] THEME-TOKENS becomes rationale plus a pointer to `ui.css`; DESIGN.md decision log, the loop
      under "How we work", next session = sub-project B (Pi pages); CORE-GAPS sticky unchanged.
