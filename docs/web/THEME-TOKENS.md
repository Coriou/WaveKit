# WaveKit theme tokens (v2)

Semantic colour tokens for the web dashboard, on three axes: **theme** (dark / light), **ground**
(Ink, Graphite, True black for dark; Paper for light) and **accent** (phosphor, ice, violet, coral,
mono). Every canvas board carries the same token block (section 7); the boards in
[canvas/](canvas/) are the reference. v1 decided 2026-10-11 (light shell over a dark plot); v2 the
same evening (grounds, paper light, everything light). See the decision log in
[DESIGN.md](DESIGN.md). For the dev handoff this becomes the Tailwind/shadcn theme in
`packages/brand`.

## 1. Principles

- **Dark + Ink + phosphor is the default and looks exactly as before.** Every value in that
  combination is the literal it replaced in v1.
- **The ground is the whole surface, plot included.** Spectrum, waterfall and Map follow the
  ground like every island. There is no "plot stays dark" rule any more and no "dark plot" option
  in light mode: someone who wants a dark plot picks a dark ground.
- **Ink takes its tint from the accent.** Phosphor gives the green-black of v1; ice navy-black,
  violet aubergine-black, coral plum-black, mono slate. Graphite is a neutral grey and True black
  is pure `#000` with neutral greys, for anyone who wants no tint.
- **Paper is the light theme.** Warm cream ground, warm brown-black ink, warm hairlines, soft
  warm two-layer shadows. Islands are near-opaque sheets lying on the page (96 %), with no white
  top highlight and no grain.
- **Accents keep their names on every ground** and get a value tuned per theme (deeper and less
  saturated on Paper). Any accent works with any ground.
- **Amber (`not live`) and red (danger) never change with the accent**; Paper has darker
  variants so text passes 4.5:1.
- **The waterfall matches the accent by default** ("Match accent"), so trace, fill and waterfall
  never disagree. Amber, Mono and Classic stay as explicit choices (section 5, rule 6).

## 2. Mechanism

Helmet styles are global (the runtime appends each board's `<helmet>` children to
`document.head`), CSS custom properties inherit through embedded boards, and `var()` works
everywhere a colour goes in this runtime: inline `style="…"`, JS-built style strings bound with
`{{…}}`, gradients, `box-shadow`, `backdrop-filter`, and SVG presentation attributes
(`stroke="var(--wk-accent)"` resolves; verified in headless Chromium with the canvas runtime).
`rgba(var(--wk-accent-rgb),.14)` works because the `-rgb` tokens hold `r,g,b` triplets.
The one place `var()` does **not** work is `<canvas>` 2D drawing (section 5, rule 6).

### 2.1 Helmet: token block first, as its own `<style>`

```html
<helmet>
<style>
/* wk-tokens v2 · copy verbatim, never edit per board */
… the 17 lines of section 7, unchanged …
</style>
<style>
@font-face{…}                       ← the board's existing style
body{margin:0}
…
</style>
</helmet>
```

Copy the token block byte for byte. Every board injects its own copy; identical copies are
harmless, a stale copy in one board could override the others (whichever mounts later wins), so
never hand-edit the block in a board. Change the block in one place and re-sync every board with a
script.

Selector layers, in order (later and more specific wins):

1. `[data-wk-theme]`: dark, Ink, phosphor (the v1 dark block).
2. `[data-wk-theme="light"]`: Paper.
3. `[data-wk-theme="dark"][data-wk-accent="…"]`: dark accent and its hairline tint.
4. `[data-wk-theme="light"][data-wk-accent="…"]`: Paper accents.
5. `[data-wk-theme="dark"]:not([data-wk-ground="graphite"]):not([data-wk-ground="black"])[data-wk-accent="…"]`:
   the Ink neutrals tinted by a non-phosphor accent. A missing ground means Ink.
6. `[data-wk-theme="dark"][data-wk-ground="graphite"|"black"][data-wk-accent]`: the neutral grounds,
   including neutral hairlines (`--wk-line-rgb`), which beat the accent's hairline tint.

### 2.2 Board root, tweaks and `renderVals`

Root element (the first element after `</helmet>`):

```html
<div data-wk-theme="{{wkTheme}}" data-wk-accent="{{wkAccent}}" data-wk-ground="{{wkGround}}" style="…">
```

**All three attributes always go on the same element**, on the root and on every nested scope.

`data-props` (first three entries, in a "Theme" section):

```json
"theme":{"editor":"enum","options":["dark","light"],"default":"dark","section":"Theme"},
"accent":{"editor":"enum","options":["phosphor","ice","violet","coral","mono"],"default":"phosphor","section":"Theme"},
"ground":{"editor":"enum","options":["ink","graphite","black"],"default":"ink","section":"Theme"},
```

`ground` is the dark ground; in light the ground is always Paper. Top of the main `return {` in
`renderVals()`:

```js
wkTheme: this.props.theme === 'light' ? 'light' : 'dark', wkAccent: this.props.accent || 'phosphor', wkGround: this.props.theme === 'light' ? 'paper' : (this.props.ground || 'ink'),
```

A board that embeds other boards passes the scope down on every `dc-import`:

```html
<dc-import name="Decode" theme="{{wkTheme}}" accent="{{wkAccent}}" ground="{{wkGround}}" … ></dc-import>
```

Immersive resolves its own tweaks (`theme`: dark | light | system, `accent`, `ground`,
`waterfall`) and lets Settings and ⌘K override them with `onSet('theme' | 'accent' | 'ground' |
'waterfall', value)`, stored in its state (a later tweak change wins again). It passes
`palette="{{waterfall}}"` to Spectrum.

### 2.3 Nested scopes

Any element can open a new scope; descendants resolve tokens from the nearest one. v1's
*forced-dark scope* for the plot and the Map is **withdrawn**: they carry the board scope. Nested
scopes remain for previews: Settings' ground and accent swatches render a small plot + island in
`data-wk-theme="dark" data-wk-ground="graphite" data-wk-accent="{{accent}}"` and so on.

## 3. Tokens

All values exact; section 7 is the source of truth, these tables explain it.

### 3.1 Grounds at a glance

| Ground | Theme | `--wk-plot-bg` = `--wk-bg` = `--wk-well` | `--wk-surface` | `--wk-fill` | Island glass | Hairline (`--wk-line-rgb`) |
|---|---|---|---|---|---|---|
| Ink · phosphor | dark | `#0b1512` | `#111c19` | `#192b24` | surface at .5 | accent |
| Ink · ice | dark | `#0d1319` | `#131a21` | `#1b2833` | surface at .5 | accent |
| Ink · violet | dark | `#141119` | `#1a1820` | `#292432` | surface at .5 | accent |
| Ink · coral | dark | `#181013` | `#20161a` | `#312128` | surface at .5 | accent |
| Ink · mono | dark | `#111314` | `#171a1b` | `#23272a` | surface at .5 | accent |
| Graphite | dark | `#161718` | `#1d1e1f` | `#2a2c2d` | surface at .5 | `226,230,235` |
| True black | dark | `#000000` | `#101010` | `#1b1b1b` | surface at .72 (.82 panel, .95 strong) | `255,255,255` |
| Paper | light | `#f4f0e6` | `#fbf8f1` | `#ebe5d8` | surface at .96 | `74,58,34` |

The tinted Ink families keep the OKLCH lightness and chroma of every v1 Ink neutral and rotate
the hue (ice 245°, violet 300°, coral 352°; mono keeps 30 % of the chroma at 230°). Graphite
is the same lightness ramp, +0.02 L on surfaces, with 12 % chroma at 255°. True black uses
neutral greys; its islands are more opaque so they still separate from the plot.

`--wk-on-accent` equals the ground's surface on dark grounds and `#ffffff` on Paper.

### 3.2 Glass and shadows

Dark grounds share v1's glass effect (`--wk-glass-fx: saturate(170%)`, `--wk-glass-hi:
rgba(255,255,255,.08)`) and shadows (`0 12px 32px rgba(0,0,0,.35)` …, unchanged).

Paper: `--wk-glass-fx: saturate(105%)`, `--wk-glass-hi: rgba(255,255,255,0)` (no top
highlight), glass `rgba(251,248,241,.96)`, panel `.97`, strong `rgba(252,250,245,.985)`, wells
`rgba(74,58,34,.07)` / `.05`. Shadows are warm and soft, a contact shadow plus a short ambient:

| Token | Paper |
|---|---|
| `--wk-shadow` | `0 1px 2px rgba(74,52,24,.08),0 6px 18px rgba(74,52,24,.10)` |
| `--wk-shadow-pop` | `0 1px 2px rgba(74,52,24,.08),0 10px 26px rgba(74,52,24,.12)` |
| `--wk-shadow-tip` | `0 1px 2px rgba(74,52,24,.08),0 6px 16px rgba(74,52,24,.12)` |
| `--wk-shadow-lg` | `0 1px 3px rgba(74,52,24,.08),0 12px 32px rgba(74,52,24,.13)` |
| `--wk-shadow-drawer` | `0 1px 3px rgba(74,52,24,.08),0 14px 36px rgba(74,52,24,.16)` |
| `--wk-shadow-xl` | `0 2px 4px rgba(74,52,24,.08),0 16px 44px rgba(74,52,24,.16)` |
| `--wk-shadow-lift` | `0 2px 6px rgba(74,52,24,.10),0 24px 56px rgba(74,52,24,.20)` |

Tiny shadows (blur ≤ 2 px, e.g. a knob's `0 1px 2px rgba(0,0,0,.35)`) stay literal.

### 3.3 Text, ink and lines

| Token | Ink · phosphor | Graphite | True black | Paper | Use |
|---|---|---|---|---|---|
| `--wk-text` | `#f4f7f5` | `#f6f6f6` | `#f5f5f5` | `#2a241c` | Primary text, values. |
| `--wk-text-soft` | `#d9e4de` | `#e0e1e2` | `#dedede` | `#3a3328` | Body copy one step down. |
| `--wk-text-2` | `#b9cac1` | `#c4c5c7` | `#c2c2c2` | `#4a4235` | Secondary text, idle labels. |
| `--wk-text-3` | `#8ba598` | `#9c9ea0` | `#9c9c9c` | `#5a5143` | Labels, eyebrows, meta, icons. |
| `--wk-text-4` | `#758b81` | `#8a8c8f` | `#878787` | `#72675a` | Quietest readable text. |
| `--wk-text-5` | `#52645d` | `#5e5f61` | `#5e5e5e` | `#a39a89` | Disabled / decorative only. |
| `--wk-ink-rgb` | `244,247,245` | `246,246,246` | `245,245,245` | `42,36,28` | Tints of the text colour. |
| `--wk-ink-2-rgb` | `185,202,193` | `196,197,199` | `194,194,194` | `74,66,53` | Hatches, "heard" ticks. |
| `--wk-ink-3-rgb` | `139,165,152` | `156,158,160` | `156,156,156` | `90,81,67` | Muted bars, closed meters. |
| `--wk-knob` | `#f4f7f5` | `#f6f6f6` | `#f5f5f5` | `#ffffff` | Switch and slider knobs. |
| `--wk-line-solid` | `#22362f` | `#353638` | `#262626` | `#e0d9ca` | Solid separators, rails. |
| `--wk-track` | `#2c443b` | `#424345` | `#363636` | `#8f8573` | Off tracks, inactive meters. |

The tinted Ink families (ice, violet, coral, mono) have their own ramp in section 7, same
lightness as Ink · phosphor.

### 3.4 Accent, amber, danger

| Token | Dark (every dark ground) | Paper |
|---|---|---|
| `--wk-on-accent` | the ground's surface | `#ffffff` |
| `--wk-amber` | `#f2b84b` | `#7a4f00` |
| `--wk-amber-rgb` (tints) | `242,184,75` | `201,138,18` |
| `--wk-amber-soft` (text on amber glass) | `#f7dca4` | `#5c3f00` |
| `--wk-amber-muted` | `#d4bd8a` | `#6e5520` |
| `--wk-amber-glass` | `rgba(48,37,12,.62)` | `rgba(252,241,214,.97)` |
| `--wk-amber-fill` | `#2a2414` | `#f6e7c4` |
| `--wk-on-amber` | `#1a1406` | `#ffffff` |
| `--wk-danger` | `#ff7a6b` | `#a8321e` |
| `--wk-danger-rgb` (tints) | `255,122,107` | `214,64,48` |
| `--wk-danger-soft` (text) | `#ff9d92` | `#93291a` |

`--wk-amber-rgb` and `--wk-danger-rgb` are brighter than the Paper text colours on purpose, so
`rgba(var(--wk-amber-rgb),.14)` reads as amber, not brown.

### 3.5 Accents (`data-wk-accent`)

| Accent | Dark `--wk-accent` / rgb | Paper `--wk-accent` / rgb |
|---|---|---|
| `phosphor` (default) | `#7becc7` / `123,236,199` | `#1d6b52` / `29,107,82` |
| `ice` | `#8fd0ff` / `143,208,255` | `#225f92` / `34,95,146` |
| `violet` | `#c4a6ff` / `196,166,255` | `#5f45a8` / `95,69,168` |
| `coral` | `#ffa0c8` / `255,160,200` | `#9e3370` / `158,51,112` |
| `mono` | `#e6ece9` / `230,236,233` | `#2a241c` / `42,36,28` |

Dark accents are the same on every dark ground (they pass 6.8:1 or better on every dark fill).
On Ink the hairline tint follows the accent (mono uses `200,212,206`); Graphite and True black
use neutral hairlines. "Coral" is pushed toward rose on purpose: a true coral (orange-pink) is
indistinguishable from the danger red.

## 4. Literal → token mapping

### 4.1 Hex (every hex in the boards)

| Literal | Token | Notes |
|---|---|---|
| `#7becc7` | `var(--wk-accent)` | |
| `#f4f7f5` | `var(--wk-text)`; **`var(--wk-knob)`** when it is a knob (`border-radius: 50%; background: #f4f7f5`) | |
| `#e3ece7` `#d9e4de` `#d0dcd5` | `var(--wk-text-soft)` | `#e3ece7` drifts slightly (accepted). |
| `#b9cac1` `#a3b5ab` `#a3b6ad` | `var(--wk-text-2)` | |
| `#8ba598` | `var(--wk-text-3)` | |
| `#758b81` `#6d857a` | `var(--wk-text-4)` | |
| `#52645d` | `var(--wk-text-5)` | |
| `#192b24` | `var(--wk-fill)` | |
| `#16231f` | `var(--wk-fill)` | Scanner tiles. |
| `#22362f` | `var(--wk-line-solid)` | |
| `#2c443b` | `var(--wk-track)` | |
| `#111c19` | `var(--wk-on-accent)` as a text/icon colour on an accent fill (`color:`, `fg`, `Fg` keys); otherwise `var(--wk-surface)` | |
| `#141f1b` `#0e1815` `#111d19` | `var(--wk-surface)` | `#0e1815` is the gap of focus rings (`0 0 0 2px #0e1815, 0 0 0 4px #7becc7`); `#111d19` the sticky-header fade (`linear-gradient(#111d19 78%, rgba(17,29,25,0))` → `linear-gradient(var(--wk-surface) 78%, transparent)`). |
| `#0b1512` | by context, never blind: root of a page board → `var(--wk-bg)`; root of a plot or strip board, Immersive root → `var(--wk-plot-bg)`; segmented-control track / meter / well inside a panel → `var(--wk-well)`; text on an accent fill → `var(--wk-on-accent)`; `body{…}` in the helmet → keep literal (plus the Paper `body:has(…)` rule, rule 1) | |
| `#07100d` | `var(--wk-well)` | Recordings waveform strip. |
| `#12201b` | `var(--wk-line-solid)` | Recordings waveform fixed ticks. |
| `#4d7a6a` | `rgba(var(--wk-accent-rgb),.5)` | Scanner activity bars. |
| `#3d6356` | as a data-bar segment → `var(--wk-track)`; as an illustration stroke → `var(--wk-text-5)` | Settings storage bar, Recordings empty state. |
| `#f2b84b` | `var(--wk-amber)` | |
| `#f7dca4` | `var(--wk-amber-soft)` | |
| `#d4bd8a` `#c9a45e` | `var(--wk-amber-muted)` | |
| `#2a2414` | `var(--wk-amber-fill)` | |
| `#1a1406` `#1a1405` | `var(--wk-on-amber)` | Text on an amber button. |
| `#ff7a6b` | `var(--wk-danger)` | |
| `#ff9d92` `#ffb3aa` `#ffc2bb` | `var(--wk-danger-soft)` | |
| `#8ec5ff` `#c9a8ff` `#f2a14b` `#e8d16a` `#9fd8ff` | **keep literal** | Map data colours (canvas drawing): each ground has its own set in Map's `mapPal()`; see rule 6. |
| `#08110e` `#0f1c18` | **keep literal** | Map canvas sea/land, now one set per ground in `mapPal()`. |

### 4.2 rgba families

| Literal | Token |
|---|---|
| `rgba(123,236,199,a)` as a **hairline**: `border*: 1px solid|dashed`, `inset 0 0 0 1px` rings, 1 px divider `div`s, scrollbar colour, JS keys named `*border*`, `*edge*`, `*line*`, `*ring*` — with a ≤ .28 | `rgba(var(--wk-line-rgb),a)` |
| `rgba(123,236,199,a)` anything else (selected/hover backgrounds, selected borders a ≥ .32, glows, meter fills, heat cells, tags) | `rgba(var(--wk-accent-rgb),a)` |
| `rgba(123,236,199,{{x}})` (templated alpha) | `rgba(var(--wk-accent-rgb),{{x}})` |
| `rgba(17,28,25,a)` | a < .6 → `var(--wk-glass)`; .6 ≤ a < .8 → `var(--wk-glass-panel)`; a ≥ .8 → `var(--wk-glass-strong)` |
| `rgba(25,43,36,a)` | `var(--wk-fill-glass)` |
| `rgba(11,21,18,a)` `rgba(7,15,13,a)` `rgba(7,16,13,a)` `rgba(8,17,14,a)` `rgba(10,19,16,a)` `rgba(14,24,21,a)` `rgba(5,10,8,a)` | a ≥ .8 → `var(--wk-well)`; else `var(--wk-well-glass)` |
| `rgba(17,29,25,0)` | `transparent` |
| `rgba(244,247,245,a)` | `rgba(var(--wk-ink-rgb),a)` |
| `rgba(185,202,193,a)` | `rgba(var(--wk-ink-2-rgb),a)` |
| `rgba(139,165,152,a)` | `rgba(var(--wk-ink-3-rgb),a)` |
| `rgba(82,100,93,a)` | `rgba(var(--wk-ink-3-rgb),.4)` |
| `rgba(242,184,75,a)` | `rgba(var(--wk-amber-rgb),a)` |
| `rgba(48,37,12,a)` | `var(--wk-amber-glass)` |
| `rgba(40,32,14,a)` | `var(--wk-amber-fill)` |
| `rgba(255,122,107,a)` | `rgba(var(--wk-danger-rgb),a)` |
| `inset 0 1px 0 rgba(255,255,255,.08|.1)` | `inset 0 1px 0 var(--wk-glass-hi)` |
| shadows `rgba(0,0,0,a)` | the shadow token whose geometry matches (3.2): `12px 32px .35` → `--wk-shadow`; `12px 32px .4|.45` → `--wk-shadow-pop`; `8px 24px` → `--wk-shadow-tip`; `16px 40px .4` → `--wk-shadow-lg`; `16px 40px .5|.55` → `--wk-shadow-drawer`; `18px 48px *`, `24px 64px *` → `--wk-shadow-xl`; `28px 64px` → `--wk-shadow-lift` |
| `saturate(160%|170%)` in `backdrop-filter` | `var(--wk-glass-fx)` |
| `rgba(142,197,255,a)` `rgba(201,168,255,a)` | keep literal (Map data colours, per ground) |

Helmet CSS converts the same way (`outline:2px solid var(--wk-accent)`,
`.wk-ghost:hover{background:var(--wk-fill);color:var(--wk-text)}` …).

## 5. Rules

1. **No colour literals** outside: the helmet `body{}` rules, tiny knob shadows, canvas
   drawing code (rule 6) and the Map data-vis / map-canvas colours listed above. Every board's
   helmet has `body{margin:0;background:#0b1512}` followed by
   `body:has([data-wk-ground="paper"]:not([data-wk-theme] *)){background:#f4f0e6}`, so a
   standalone board whose root is Paper sits on paper (nested preview scopes do not count).
2. **Hairline or tint?** If it draws an edge (border, ring, 1 px divider), it is a line:
   `--wk-line-rgb`. If it fills or marks a state, it is the accent: `--wk-accent-rgb`. In dark
   both are identical, so a wrong call only shows in light mode (an accent-tinted edge).
3. **Selected states** (v2.1, quiet): background `var(--wk-sel)`, text `var(--wk-accent)`, no
   coloured border. Idle chips and toggles: background `var(--wk-chip)`, text `var(--wk-text-2)`,
   border `transparent` (keep the 1 px so nothing shifts). Primary: background
   `var(--wk-accent)`, text `var(--wk-on-accent)`. See §5.1.
4. **Amber and red** are state colours: never use the accent for "paused / not live / caution"
   or for errors, and never use amber/red as decoration.
5. **Glass recipe** for any floating surface:
   `background: var(--wk-glass|-panel|-strong); border: 1px solid rgba(var(--wk-line-rgb),.14);
   box-shadow: inset 0 1px 0 var(--wk-glass-hi), var(--wk-shadow…);
   backdrop-filter: blur(22px) var(--wk-glass-fx)`. Paused/amber variant: `var(--wk-amber-glass)`
   with `rgba(var(--wk-amber-rgb),.14)` edge.
6. **Canvas** cannot read `var()`. Read the resolved tokens instead, once per
   (theme|ground|accent) key, from an element inside the board's scope:
   ```js
   tokens() {
   	const k = [this.props.theme, this.props.ground, this.props.accent].join('|');
   	if (this.tokKey !== k && this.boxEl) {
   		const cs = getComputedStyle(this.boxEl), v = n => cs.getPropertyValue(n).trim();
   		this.tok = { bg: v('--wk-plot-bg'), acc: v('--wk-accent-rgb'), ink: v('--wk-ink-rgb'), line: v('--wk-line-rgb') };
   		this.tokKey = k;   // cache only once the DOM scope attributes match the props
   	}
   	return this.tok;
   }
   ```
   Spectrum draws its grid with the hairline token, trace and fill with the accent, and the
   outside-capture shading with ink. Map's `mapPal(theme, ground, accent, cs)` returns sea, land,
   coast and data colours per ground (Ink + phosphor returns v1's `MAP.dark` unchanged; Paper is
   a nautical chart: sea `#d9e3e6`, land `#f4f0e6`, a 0.9 px warm-ink coastline over a faint
   shallow-water band). AIS vessels are teal (`#22a8bf` dark, `#00838f` Paper) so they no longer
   sit next to the ice accent. A key change rebuilds the waterfall ramp and repaints its history.

   **Waterfall colours** (`palette`: `match | amber | mono | classic`, default `match`; the v1
   value `phosphor` is read as `match`). Stops come from Spectrum's `rampStops()` (`bg` = plot,
   `acc` = accent, `ink` = text):
   - *Match, dark grounds:* bg → accent hue at low lightness (0.3, 0.5) → accent hue at 0.49 L
     (0.7) → accent (0.86) → ink (1). On Ink + phosphor every stop is within one level of v1's
     phosphor ramp.
   - *Match, Paper (ramp a, the default):* bg → 30 % accent over paper (0.38) → accent (0.72) →
     ink (1). Strong signals are the darkest marks; weak carriers read as pale accent. Ramps b
     (bg → accent → ink) and c (with a warm-grey "pencil" step) stay on the Spectrum board as the
     `paperRamp` tweak for the owner to compare; b shows noise as grain, c makes weak signals look
     disabled.
   - *Amber, Mono, Classic* (blue → cyan → yellow → red heat): fixed stops with a dark and a
     Paper variant each; on Paper they also run light to dark.
   Settings' waterfall strips use the same stops as CSS gradients.
7. **SVG**: `stroke="var(--wk-…)"`, `fill="var(--wk-…)"` and `currentColor` all work.
8. **`color-scheme`** is set by the scope (dark / light), so native controls and scrollbars
   match. Range inputs in the boards are `opacity: 0`, so this is not visible there.
9. **Contrast**: content text uses `--wk-text` to `--wk-text-4` only; `--wk-text-5` is for
   disabled or decorative glyphs.

### 5.1 Focus, selection and highlight (v2.1, 2026-10-11)

The owner found the shell "highlighting elements all the time". One rule per purpose; no
accent ring or accent border anywhere except the primary button and a playing control.

| Purpose | Recipe | Never |
|---|---|---|
| Keyboard focus | `outline:1.5px solid var(--wk-focus);outline-offset:2px` on `:focus-visible` only. `--wk-focus` = ink at .55 (≥3:1 on every ground, WCAG 2.4.7). A control with an inner shape (play button, handle) rings the shape: `box-shadow:0 0 0 2px var(--wk-surface),0 0 0 3.5px var(--wk-focus)` | on mouse click; accent colour; on `:focus` |
| Focused pane or region | `outline:none;box-shadow:inset 0 2px 0 var(--wk-focus)` (a top edge, not a box) | a ring around a whole pane |
| Text field focus | border `rgba(var(--wk-line-rgb),.3)` (JS `s.focus` too) | accent border |
| Selected chip / toggle / step / segment | fill `var(--wk-sel)` + accent text | border of any colour |
| Selected row | fill `rgba(var(--wk-accent-rgb),.11)` | inset ring |
| Keyboard cursor in a list | `inset 0 0 0 1.5px var(--wk-focus)` only while `s.kb` (set by arrow keys, cleared by a click) | after a mouse click |
| Chosen swatch / ground / waterfall | a small check mark (accent disc or inline tick) + accent label | ring around the option |
| Hover | fill only (`var(--wk-chip)`, `var(--wk-fill)` or accent .04–.08); fields may darken their neutral line to .26 | accent border |
| Jump-to highlight (Settings target) | fill `var(--wk-sel)` for 0.6 s, fading over 0.6 s | a box around the row |
| Idle controls (knobs, live cards, storage bar) | neutral line or nothing | accent halo or edge |
| Drag guides (snap ghost, range drag) | dashed accent, only while dragging | after the drag ends |

Tokens (in the base rule of the token block): `--wk-focus:rgba(var(--wk-ink-rgb),.55)`,
`--wk-sel:rgba(var(--wk-accent-rgb),.12)`, `--wk-chip:rgba(var(--wk-ink-rgb),.06)`. They resolve
per scope, so grounds and accents need no extra rules.

## 6. Contrast results

Islands are measured as their glass over the plot (dark .5, True black .72, Paper .96). Ratios
are island / fill.

| Ground | text | text-2 | text-3 | text-4 | text-5 (decorative) |
|---|---|---|---|---|---|
| Ink · phosphor | 16.8 / 13.8 | 10.6 / 8.7 | 6.8 / 5.6 | 5.0 / 4.1 ¹ | 2.9 / 2.4 |
| Ink · ice, violet, coral, mono | 16.8 / 13.9–14.1 | 10.5 / 8.7 | 6.6–6.8 / 5.5 | 4.8–4.9 / 4.0–4.1 ¹ | 2.8 / 2.3 |
| Graphite | 16.1 / 13.0 | 10.1 / 8.1 | 6.5 / 5.2 | 5.2 / 4.2 ¹ | 2.7 / 2.2 |
| True black | 17.9 / 15.8 | 11.0 / 9.7 | 7.1 / 6.3 | 5.4 / 4.8 | 3.0 / 2.7 |
| Paper | 14.5 / 12.2 | 9.3 / 7.9 | 7.4 / 6.2 | 5.2 / 4.4 ¹ | 2.6 / 2.2 |

Accents, island / fill:

| Accent | Ink (own tint) | Graphite | True black | Paper |
|---|---|---|---|---|
| phosphor | 12.6 / 10.4 | 12.1 / 9.8 | 13.7 / 12.0 | 6.0 / 5.1 |
| ice | 10.9 / 9.0 | 10.5 / 8.4 | 11.8 / 10.4 | 6.3 / 5.4 |
| violet | 8.9 / 7.4 | 8.5 / 6.8 | 9.5 / 8.4 | 6.8 / 5.8 |
| coral | 9.6 / 8.1 | 9.2 / 7.4 | 10.4 / 9.1 | 6.3 / 5.3 |
| mono | 15.2 / 12.6 | 14.5 / 11.7 | 16.3 / 14.4 | 14.5 / 12.2 |

Paper amber `#7a4f00` is 5.7:1 and danger `#a8321e` 5.3:1 on the fill. White on a Paper accent
button: 6.4 to 7.2 (mono 15.4). Paper text-4 was lightened from `#655b4b` to `#72675a` during
the board sweep so text-3 and text-4 stay distinguishable (Json keys vs strings).

¹ text-4 on the solid fill is just under 4.5:1 on Ink (unchanged from v1, dark must not move),
Graphite and Paper. Avoid text-4 on `--wk-fill` in new work.

## 7. The token block, verbatim

The source of truth. Every board's first helmet `<style>` is exactly this (17 lines).

```css
/* wk-tokens v2 · copy verbatim, never edit per board */
[data-wk-theme]{color-scheme:dark;--wk-plot-bg:#0b1512;--wk-bg:#0b1512;--wk-surface:#111c19;--wk-fill:#192b24;--wk-fill-glass:rgba(25,43,36,.92);--wk-well:#0b1512;--wk-well-glass:rgba(11,21,18,.6);--wk-glass:rgba(17,28,25,.5);--wk-glass-panel:rgba(17,28,25,.66);--wk-glass-strong:rgba(17,28,25,.92);--wk-glass-fx:saturate(170%);--wk-glass-hi:rgba(255,255,255,.08);--wk-shadow:0 12px 32px rgba(0,0,0,.35);--wk-shadow-pop:0 12px 32px rgba(0,0,0,.4);--wk-shadow-tip:0 8px 24px rgba(0,0,0,.4);--wk-shadow-lg:0 16px 40px rgba(0,0,0,.4);--wk-shadow-drawer:0 16px 40px rgba(0,0,0,.5);--wk-shadow-xl:0 18px 48px rgba(0,0,0,.45);--wk-shadow-lift:0 28px 64px rgba(0,0,0,.55);--wk-text:#f4f7f5;--wk-text-soft:#d9e4de;--wk-text-2:#b9cac1;--wk-text-3:#8ba598;--wk-text-4:#758b81;--wk-text-5:#52645d;--wk-ink-rgb:244,247,245;--wk-ink-2-rgb:185,202,193;--wk-ink-3-rgb:139,165,152;--wk-knob:#f4f7f5;--wk-line-solid:#22362f;--wk-track:#2c443b;--wk-accent:#7becc7;--wk-accent-rgb:123,236,199;--wk-line-rgb:123,236,199;--wk-on-accent:#111c19;--wk-amber:#f2b84b;--wk-amber-rgb:242,184,75;--wk-amber-soft:#f7dca4;--wk-amber-muted:#d4bd8a;--wk-amber-glass:rgba(48,37,12,.62);--wk-amber-fill:#2a2414;--wk-on-amber:#1a1406;--wk-danger:#ff7a6b;--wk-danger-rgb:255,122,107;--wk-danger-soft:#ff9d92;--wk-focus:rgba(var(--wk-ink-rgb),.55);--wk-sel:rgba(var(--wk-accent-rgb),.12);--wk-chip:rgba(var(--wk-ink-rgb),.06)}
[data-wk-theme="light"]{color-scheme:light;--wk-plot-bg:#f4f0e6;--wk-bg:#f4f0e6;--wk-surface:#fbf8f1;--wk-fill:#ebe5d8;--wk-fill-glass:rgba(251,248,241,.96);--wk-well:rgba(74,58,34,.07);--wk-well-glass:rgba(74,58,34,.05);--wk-glass:rgba(251,248,241,.96);--wk-glass-panel:rgba(251,248,241,.97);--wk-glass-strong:rgba(252,250,245,.985);--wk-glass-fx:saturate(105%);--wk-glass-hi:rgba(255,255,255,0);--wk-shadow:0 1px 2px rgba(74,52,24,.08),0 6px 18px rgba(74,52,24,.10);--wk-shadow-pop:0 1px 2px rgba(74,52,24,.08),0 10px 26px rgba(74,52,24,.12);--wk-shadow-tip:0 1px 2px rgba(74,52,24,.08),0 6px 16px rgba(74,52,24,.12);--wk-shadow-lg:0 1px 3px rgba(74,52,24,.08),0 12px 32px rgba(74,52,24,.13);--wk-shadow-drawer:0 1px 3px rgba(74,52,24,.08),0 14px 36px rgba(74,52,24,.16);--wk-shadow-xl:0 2px 4px rgba(74,52,24,.08),0 16px 44px rgba(74,52,24,.16);--wk-shadow-lift:0 2px 6px rgba(74,52,24,.10),0 24px 56px rgba(74,52,24,.20);--wk-text:#2a241c;--wk-text-soft:#3a3328;--wk-text-2:#4a4235;--wk-text-3:#5a5143;--wk-text-4:#72675a;--wk-text-5:#a39a89;--wk-ink-rgb:42,36,28;--wk-ink-2-rgb:74,66,53;--wk-ink-3-rgb:90,81,67;--wk-knob:#ffffff;--wk-line-solid:#e0d9ca;--wk-track:#8f8573;--wk-accent:#1d6b52;--wk-accent-rgb:29,107,82;--wk-line-rgb:74,58,34;--wk-on-accent:#ffffff;--wk-amber:#7a4f00;--wk-amber-rgb:201,138,18;--wk-amber-soft:#5c3f00;--wk-amber-muted:#6e5520;--wk-amber-glass:rgba(252,241,214,.97);--wk-amber-fill:#f6e7c4;--wk-on-amber:#ffffff;--wk-danger:#a8321e;--wk-danger-rgb:214,64,48;--wk-danger-soft:#93291a}
[data-wk-theme="dark"][data-wk-accent="ice"]{--wk-accent:#8fd0ff;--wk-accent-rgb:143,208,255;--wk-line-rgb:143,208,255}
[data-wk-theme="dark"][data-wk-accent="violet"]{--wk-accent:#c4a6ff;--wk-accent-rgb:196,166,255;--wk-line-rgb:196,166,255}
[data-wk-theme="dark"][data-wk-accent="coral"]{--wk-accent:#ffa0c8;--wk-accent-rgb:255,160,200;--wk-line-rgb:255,160,200}
[data-wk-theme="dark"][data-wk-accent="mono"]{--wk-accent:#e6ece9;--wk-accent-rgb:230,236,233;--wk-line-rgb:200,212,206}
[data-wk-theme="light"][data-wk-accent="ice"]{--wk-accent:#225f92;--wk-accent-rgb:34,95,146}
[data-wk-theme="light"][data-wk-accent="violet"]{--wk-accent:#5f45a8;--wk-accent-rgb:95,69,168}
[data-wk-theme="light"][data-wk-accent="coral"]{--wk-accent:#9e3370;--wk-accent-rgb:158,51,112}
[data-wk-theme="light"][data-wk-accent="mono"]{--wk-accent:#2a241c;--wk-accent-rgb:42,36,28}
[data-wk-theme="dark"]:not([data-wk-ground="graphite"]):not([data-wk-ground="black"])[data-wk-accent="ice"]{--wk-plot-bg:#0d1319;--wk-bg:#0d1319;--wk-surface:#131a21;--wk-fill:#1b2833;--wk-fill-glass:rgba(27,40,51,.92);--wk-well:#0d1319;--wk-well-glass:rgba(13,19,25,.6);--wk-glass:rgba(19,26,33,.5);--wk-glass-panel:rgba(19,26,33,.66);--wk-glass-strong:rgba(19,26,33,.92);--wk-text:#f4f6f9;--wk-text-soft:#d9e2ea;--wk-text-2:#bac7d3;--wk-text-3:#8da1b2;--wk-text-4:#778796;--wk-text-5:#54616d;--wk-ink-rgb:244,246,249;--wk-ink-2-rgb:186,199,211;--wk-ink-3-rgb:141,161,178;--wk-knob:#f4f6f9;--wk-line-solid:#25333f;--wk-track:#2f404f;--wk-on-accent:#131a21}
[data-wk-theme="dark"]:not([data-wk-ground="graphite"]):not([data-wk-ground="black"])[data-wk-accent="violet"]{--wk-plot-bg:#141119;--wk-bg:#141119;--wk-surface:#1a1820;--wk-fill:#292432;--wk-fill-glass:rgba(41,36,50,.92);--wk-well:#141119;--wk-well-glass:rgba(20,17,25,.6);--wk-glass:rgba(26,24,32,.5);--wk-glass-panel:rgba(26,24,32,.66);--wk-glass-strong:rgba(26,24,32,.92);--wk-text:#f6f6f9;--wk-text-soft:#e2dfe9;--wk-text-2:#c7c2d2;--wk-text-3:#a199b1;--wk-text-4:#878195;--wk-text-5:#615c6b;--wk-ink-rgb:246,246,249;--wk-ink-2-rgb:199,194,210;--wk-ink-3-rgb:161,153,177;--wk-knob:#f6f6f9;--wk-line-solid:#332e3e;--wk-track:#413a4e;--wk-on-accent:#1a1820}
[data-wk-theme="dark"]:not([data-wk-ground="graphite"]):not([data-wk-ground="black"])[data-wk-accent="coral"]{--wk-plot-bg:#181013;--wk-bg:#181013;--wk-surface:#20161a;--wk-fill:#312128;--wk-fill-glass:rgba(49,33,40,.92);--wk-well:#181013;--wk-well-glass:rgba(24,16,19,.6);--wk-glass:rgba(32,22,26,.5);--wk-glass-panel:rgba(32,22,26,.66);--wk-glass-strong:rgba(32,22,26,.92);--wk-text:#f9f5f6;--wk-text-soft:#e9dde2;--wk-text-2:#d2c0c7;--wk-text-3:#b095a0;--wk-text-4:#947e87;--wk-text-5:#6b5a61;--wk-ink-rgb:249,245,246;--wk-ink-2-rgb:210,192,199;--wk-ink-3-rgb:176,149,160;--wk-knob:#f9f5f6;--wk-line-solid:#3d2b33;--wk-track:#4c3740;--wk-on-accent:#20161a}
[data-wk-theme="dark"]:not([data-wk-ground="graphite"]):not([data-wk-ground="black"])[data-wk-accent="mono"]{--wk-plot-bg:#111314;--wk-bg:#111314;--wk-surface:#171a1b;--wk-fill:#23272a;--wk-fill-glass:rgba(35,39,42,.92);--wk-well:#111314;--wk-well-glass:rgba(17,19,20,.6);--wk-glass:rgba(23,26,27,.5);--wk-glass-panel:rgba(23,26,27,.66);--wk-glass-strong:rgba(23,26,27,.92);--wk-text:#f5f6f7;--wk-text-soft:#dee1e3;--wk-text-2:#c1c6c9;--wk-text-3:#989fa3;--wk-text-4:#808689;--wk-text-5:#5b6063;--wk-ink-rgb:245,246,247;--wk-ink-2-rgb:193,198,201;--wk-ink-3-rgb:152,159,163;--wk-knob:#f5f6f7;--wk-line-solid:#2d3235;--wk-track:#393f42;--wk-on-accent:#171a1b}
[data-wk-theme="dark"][data-wk-ground="graphite"][data-wk-accent]{--wk-plot-bg:#161718;--wk-bg:#161718;--wk-surface:#1d1e1f;--wk-fill:#2a2c2d;--wk-fill-glass:rgba(42,44,45,.92);--wk-well:#161718;--wk-well-glass:rgba(22,23,24,.6);--wk-glass:rgba(29,30,31,.5);--wk-glass-panel:rgba(29,30,31,.66);--wk-glass-strong:rgba(29,30,31,.92);--wk-text:#f6f6f6;--wk-text-soft:#e0e1e2;--wk-text-2:#c4c5c7;--wk-text-3:#9c9ea0;--wk-text-4:#8a8c8f;--wk-text-5:#5e5f61;--wk-ink-rgb:246,246,246;--wk-ink-2-rgb:196,197,199;--wk-ink-3-rgb:156,158,160;--wk-knob:#f6f6f6;--wk-line-solid:#353638;--wk-track:#424345;--wk-on-accent:#1d1e1f;--wk-line-rgb:226,230,235}
[data-wk-theme="dark"][data-wk-ground="black"][data-wk-accent]{--wk-plot-bg:#000000;--wk-bg:#000000;--wk-surface:#101010;--wk-fill:#1b1b1b;--wk-fill-glass:rgba(27,27,27,.92);--wk-well:#000000;--wk-well-glass:rgba(0,0,0,.6);--wk-glass:rgba(16,16,16,.72);--wk-glass-panel:rgba(16,16,16,.82);--wk-glass-strong:rgba(16,16,16,.95);--wk-text:#f5f5f5;--wk-text-soft:#dedede;--wk-text-2:#c2c2c2;--wk-text-3:#9c9c9c;--wk-text-4:#878787;--wk-text-5:#5e5e5e;--wk-ink-rgb:245,245,245;--wk-ink-2-rgb:194,194,194;--wk-ink-3-rgb:156,156,156;--wk-knob:#f5f5f5;--wk-line-solid:#262626;--wk-track:#363636;--wk-on-accent:#101010;--wk-line-rgb:255,255,255}
```
