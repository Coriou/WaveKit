# WaveKit theme tokens (v1)

Semantic colour tokens for the web dashboard: dark (the original look), light (a light shell
over a plot that stays dark) and five accents (phosphor, ice, violet, coral, mono). Every
canvas board carries the same token block; the boards in [canvas/](canvas/) are the reference.
Decided 2026-10-11 (see the decision log in [DESIGN.md](DESIGN.md)). For the dev handoff this
becomes the Tailwind/shadcn theme in `packages/brand`.

## 1. Principles

- **Dark + phosphor is the default and looks exactly as before.** Every dark token value is
  the literal it replaces.
- **Light is its own shell, not an inversion.** Islands, drawers, dock, menus and cards
  become near-opaque white glass (92 to 98 %) with a crisp white top highlight, neutral ink
  hairlines and soft green-ink shadows. Text is a green-tinted ink ramp.
- **The plot stays a dark instrument screen in both themes.** Spectrum, waterfall, their
  axis, band row, discovery row, signal tags, zoom pill and hover readout all stay dark. Do it
  with a *forced-dark scope* (section 2.3), not with special tokens.
- **Amber (`not live`) and red (danger) never change with the accent.** Light mode has darker
  variants so text passes 4.5:1.
- **Neutrals are WaveKit's green-tinted ink in every accent.** Only `--wk-accent*` and, in dark
  mode, the hairline tint (`--wk-line-rgb`) follow the accent.

## 2. Mechanism

Helmet styles are global (the runtime appends each board's `<helmet>` children to
`document.head`), CSS custom properties inherit through embedded boards, and `var()` works
everywhere a colour goes in this runtime: inline `style="…"`, JS-built style strings bound with
`{{…}}`, gradients, `box-shadow`, `backdrop-filter`, and SVG presentation attributes
(`stroke="var(--wk-accent)"` resolves; verified in headless Chromium with the canvas runtime).
`rgba(var(--wk-accent-rgb),.14)` works because the `-rgb` tokens hold `r,g,b` triplets.
The one place `var()` does **not** work is `<canvas>` 2D drawing (section 5.6).

### 2.1 Helmet: token block first, as its own `<style>`

```html
<helmet>
<style>
/* wk-tokens v1 · copy verbatim, never edit per board */
… the 11 lines of tokens.css, unchanged …
</style>
<style>
@font-face{…}                       ← the board's existing style, converted
body{margin:0;background:#0b1512}   ← keep this literal: body = the plot colour
…
</style>
</helmet>
```

Copy the token block byte for byte. Every board injects its own copy; identical copies are
harmless, a stale copy in one board could override the others (whichever mounts later wins), so
never hand-edit the block in a board. Change the token block and re-sync all boards with
`a sync script over every board`.

`body{background:#0b1512}` stays literal on purpose: outside the root there is no theme scope,
and a standalone island over the dark plot colour is the realistic context in both themes.

### 2.2 Board root, tweaks and `renderVals`

Root element (the first element after `</helmet>`):

```html
<div data-wk-theme="{{wkTheme}}" data-wk-accent="{{wkAccent}}" style="…">
```

Both attributes always go on the same element; the accent rules match the pair.

`data-props` (first two entries, in a "Theme" section):

```json
"theme":{"editor":"enum","options":["dark","light"],"default":"dark","section":"Theme"},
"accent":{"editor":"enum","options":["phosphor","ice","violet","coral","mono"],"default":"phosphor","section":"Theme"},
```

Top of the main `return {` in `renderVals()`:

```js
// theme scope: Immersive passes its theme and accent; standalone, the board's own tweaks
wkTheme: this.props.theme === 'light' ? 'light' : 'dark', wkAccent: this.props.accent || 'phosphor',
```

A board that embeds other boards passes the scope down on every `dc-import`
(Messages → Decode, Decode → Json, SettingsPhone → Settings, TunedGallery → Tuned, …):

```html
<dc-import name="Decode" theme="{{wkTheme}}" accent="{{wkAccent}}" … ></dc-import>
```

Immersive already passes `theme`/`accent` to all twelve imports, resolves its own
`theme` tweak (`dark | light | system`, system follows `prefers-color-scheme`) and lets
Settings override it: `onSet('theme', 'dark'|'light'|'system')` and
`onSet('accent', 'phosphor'|…)` store the pick in Immersive's state (a later tweak change wins
again). Settings › Display should call exactly those keys.

### 2.3 Forced-dark scopes and nested scopes

Any element can open a new scope; descendants resolve tokens from the nearest one.

- **Plot / instrument surfaces** put a literal dark theme on their root and keep the accent:
  `data-wk-theme="dark" data-wk-accent="{{wkAccent}}"`. Spectrum does this on its root, so its
  whole subtree resolves dark tokens (text, hairlines, glass of the signal tags) in either theme,
  and still follows the accent. Use the same for Map's map canvas area, and for any other
  "screen" (waterfall thumbnails, the band ruler only if you decide it is an instrument; by
  default it follows the theme).
- **Shell controls floating on a plot** reopen the shell scope:
  `data-wk-theme="{{wkTheme}}" data-wk-accent="{{wkAccent}}"`. Spectrum does this for the
  "Scan this range" pill and its confirmation toast: they are controls, not annotations.
  Rule of thumb: annotations of the signal stay dark, things you act on follow the theme.

## 3. Tokens

All values exact. Light values are for `[data-wk-theme="light"]`.

### 3.1 Surfaces and glass

| Token | Dark | Light | Use |
|---|---|---|---|
| `--wk-plot-bg` | `#0b1512` | `#0b1512` | Plot, waterfall, axis strip, Immersive root, standalone strip roots. Never changes. |
| `--wk-bg` | `#0b1512` | `#e9eeeb` | Page / full-page board background (gallery pages, Messages gallery). |
| `--wk-surface` | `#111c19` | `#ffffff` | Solid panel (Tuned `panel` variant, stat cells, sticky header base, focus-ring gap). |
| `--wk-fill` | `#192b24` | `#e2e9e5` | Neutral fill: chips, hover (`.wk-ghost:hover`), selected segment, info boxes. |
| `--wk-fill-glass` | `rgba(25,43,36,.92)` | `rgba(240,244,242,.96)` | Translucent fill: toasts, small status pills on glass. |
| `--wk-well` | `#0b1512` | `rgba(22,50,42,.07)` | Recessed well inside a panel: segmented-control tracks, meters, strips, hollow tick fill, hatch gaps. |
| `--wk-well-glass` | `rgba(11,21,18,.6)` | `rgba(22,50,42,.055)` | Softer well: inputs, the Tuned "now" block, mode group. |
| `--wk-glass` | `rgba(17,28,25,.5)` | `rgba(248,250,249,.92)` | Island glass: Tuner, Receiver, Listen bars, dock, band strip, floating card. |
| `--wk-glass-panel` | `rgba(17,28,25,.66)` | `rgba(248,250,249,.95)` | Expanded panels, drawers, feeds. |
| `--wk-glass-strong` | `rgba(17,28,25,.92)` | `rgba(250,252,251,.98)` | Menus, tooltips, popovers, sticky overlays. |
| `--wk-glass-fx` | `saturate(170%)` | `saturate(140%) brightness(1.08)` | `backdrop-filter: blur(22px) var(--wk-glass-fx)` (keep the blur radius literal). |
| `--wk-glass-hi` | `rgba(255,255,255,.08)` | `rgba(255,255,255,.9)` | Top highlight: `box-shadow: inset 0 1px 0 var(--wk-glass-hi), var(--wk-shadow)`. |

### 3.2 Shadows

| Token | Dark | Light |
|---|---|---|
| `--wk-shadow` | `0 12px 32px rgba(0,0,0,.35)` | `0 1px 2px rgba(10,34,26,.10),0 10px 28px rgba(10,34,26,.22)` |
| `--wk-shadow-pop` | `0 12px 32px rgba(0,0,0,.4)` | `0 1px 2px rgba(10,34,26,.10),0 12px 32px rgba(10,34,26,.24)` |
| `--wk-shadow-tip` | `0 8px 24px rgba(0,0,0,.4)` | `0 1px 2px rgba(10,34,26,.10),0 8px 20px rgba(10,34,26,.2)` |
| `--wk-shadow-lg` | `0 16px 40px rgba(0,0,0,.4)` | `0 1px 3px rgba(10,34,26,.10),0 16px 40px rgba(10,34,26,.24)` |
| `--wk-shadow-drawer` | `0 16px 40px rgba(0,0,0,.5)` | `0 1px 3px rgba(10,34,26,.10),0 16px 40px rgba(10,34,26,.28)` |
| `--wk-shadow-xl` | `0 18px 48px rgba(0,0,0,.45)` | `0 2px 4px rgba(10,34,26,.10),0 18px 48px rgba(10,34,26,.28)` |
| `--wk-shadow-lift` | `0 28px 64px rgba(0,0,0,.55)` | `0 2px 6px rgba(10,34,26,.12),0 28px 64px rgba(10,34,26,.34)` |

Tiny shadows (blur ≤ 2 px, e.g. a knob's `0 1px 2px rgba(0,0,0,.35)`) stay literal.

### 3.3 Text, ink and lines

| Token | Dark | Light | Use |
|---|---|---|---|
| `--wk-text` | `#f4f7f5` | `#12201b` | Primary text, values. |
| `--wk-text-soft` | `#d9e4de` | `#22332d` | Body copy one step down (menu items, quotes, notes). |
| `--wk-text-2` | `#b9cac1` | `#33463e` | Secondary text, idle button labels. |
| `--wk-text-3` | `#8ba598` | `#44574f` | Labels, eyebrows, meta, icons. |
| `--wk-text-4` | `#758b81` | `#4e6158` | Quietest readable text (still ≥ 4.5:1 on glass). |
| `--wk-text-5` | `#52645d` | `#8a9b93` | Disabled / decorative only (leading zeros, hints like "↑↓ choose"); not for content. |
| `--wk-ink-rgb` | `244,247,245` | `18,32,27` | Tints of the text colour: brackets, hover cursor line, "tuned now" outlines. |
| `--wk-ink-2-rgb` | `185,202,193` | `51,70,62` | Hatches (excluded ranges), "heard" ticks. |
| `--wk-ink-3-rgb` | `139,165,152` | `68,87,79` | Muted bars, closed meter fill. |
| `--wk-knob` | `#f4f7f5` | `#ffffff` | Switch and slider knobs. |
| `--wk-line-rgb` | accent rgb (`123,236,199`) | `22,50,42` (neutral ink) | Hairlines: `rgba(var(--wk-line-rgb),.14)`. |
| `--wk-line-solid` | `#22362f` | `#d3dcd8` | Solid separators: slider rails, grid gaps between stat cells. |
| `--wk-track` | `#2c443b` | `#77897f` | Off switch track, inactive meter bars, inactive dots. Light value is 3:1 against glass. |

### 3.4 Accent, amber, danger

| Token | Dark | Light |
|---|---|---|
| `--wk-accent` | per accent (3.5) | per accent |
| `--wk-accent-rgb` | per accent | per accent |
| `--wk-on-accent` | `#111c19` | `#ffffff` |
| `--wk-amber` | `#f2b84b` | `#7a4f00` |
| `--wk-amber-rgb` (tints) | `242,184,75` | `201,138,18` |
| `--wk-amber-soft` (text on amber glass) | `#f7dca4` | `#5c3f00` |
| `--wk-amber-muted` | `#d4bd8a` | `#6e5520` |
| `--wk-amber-glass` | `rgba(48,37,12,.62)` | `rgba(255,246,222,.94)` |
| `--wk-amber-fill` | `#2a2414` | `#fbecc8` |
| `--wk-on-amber` | `#1a1406` | `#ffffff` |
| `--wk-danger` | `#ff7a6b` | `#b3301f` |
| `--wk-danger-rgb` (tints) | `255,122,107` | `214,64,48` |
| `--wk-danger-soft` (text) | `#ff9d92` | `#9e2a1b` |

Note `--wk-amber-rgb` and `--wk-danger-rgb` are brighter than the light text colours on purpose,
so `rgba(var(--wk-amber-rgb),.14)` reads as amber, not brown.

### 3.5 Accents (`data-wk-accent`)

| Accent | Dark `--wk-accent` / rgb | Light `--wk-accent` / rgb | Dark `--wk-line-rgb` |
|---|---|---|---|
| `phosphor` (default) | `#7becc7` / `123,236,199` | `#086a50` / `8,106,80` | `123,236,199` |
| `ice` | `#8fd0ff` / `143,208,255` | `#0a5fa6` / `10,95,166` | `143,208,255` |
| `violet` | `#c4a6ff` / `196,166,255` | `#6941c6` / `105,65,198` | `196,166,255` |
| `coral` | `#ffa0c8` / `255,160,200` | `#ad2470` / `173,36,112` | `255,160,200` |
| `mono` | `#e6ece9` / `230,236,233` | `#1d2b26` / `29,43,38` | `200,212,206` |

"Coral" is pushed toward rose on purpose: a true coral (orange-pink) is indistinguishable from
the danger red `#ff7a6b`. Light mode hairlines are neutral ink for every accent.

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
| `#0b1512` | by context, never blind: root of a page board → `var(--wk-bg)`; root of a plot or strip board, Immersive root → `var(--wk-plot-bg)`; segmented-control track / meter / well inside a panel → `var(--wk-well)`; text on an accent fill → `var(--wk-on-accent)`; `body{…}` in the helmet → keep literal | |
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
| `#8ec5ff` `#c9a8ff` `#f2a14b` `#e8d16a` `#9fd8ff` | **keep literal** | Data-vis categories and the altitude ramp in Map; they live on the dark map canvas (forced-dark scope). |
| `#08110e` `#0f1c18` | **keep literal** | Map canvas sea/land; same reason. |

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
| `rgba(142,197,255,a)` `rgba(201,168,255,a)` | keep literal (Map data colours) |

Helmet CSS converts the same way (`outline:2px solid var(--wk-accent)`,
`.wk-ghost:hover{background:var(--wk-fill);color:var(--wk-text)}` …).

## 5. Rules

1. **No colour literals** outside: the helmet `body{}` rule, tiny knob shadows, canvas
   drawing code (5.6) and the Map data-vis / map-canvas colours listed above.
2. **Hairline or tint?** If it draws an edge (border, ring, 1 px divider), it is a line:
   `--wk-line-rgb`. If it fills or marks a state, it is the accent: `--wk-accent-rgb`. In dark
   both are identical, so a wrong call only shows in light mode (an accent-tinted edge).
3. **Selected states** keep the existing recipe: border `rgba(var(--wk-accent-rgb),.55)`,
   background `rgba(var(--wk-accent-rgb),.12)`, text `var(--wk-accent)`. Idle: border
   `rgba(var(--wk-line-rgb),.18)`, text `var(--wk-text-2)`. Primary: background
   `var(--wk-accent)`, text `var(--wk-on-accent)`.
4. **Amber and red** are state colours: never use the accent for "paused / not live / caution"
   or for errors, and never use amber/red as decoration.
5. **Glass recipe** for any floating surface:
   `background: var(--wk-glass|-panel|-strong); border: 1px solid rgba(var(--wk-line-rgb),.14);
   box-shadow: inset 0 1px 0 var(--wk-glass-hi), var(--wk-shadow…);
   backdrop-filter: blur(22px) var(--wk-glass-fx)`. Paused/amber variant: `var(--wk-amber-glass)`
   with `rgba(var(--wk-amber-rgb),.14)` edge.
6. **Canvas** cannot read `var()`. Inside a forced-dark scope (Spectrum, Map) keep neutral
   canvas literals; for accent strokes resolve once per accent change, as Spectrum does:
   ```js
   accentRgb() {
   	const k = this.props.accent || 'phosphor';
   	if (this.accKey !== k || !this.accRgb) {
   		const v = this.boxEl ? getComputedStyle(this.boxEl).getPropertyValue('--wk-accent-rgb').trim() : '';
   		this.accRgb = v || '123,236,199'; this.accKey = v ? k : null;
   	}
   	return this.accRgb;
   }
   // c.strokeStyle = 'rgb(' + this.accentRgb() + ')'
   ```
   Waterfall palettes (`phosphor | amber | mono`) are a separate user setting and stay literal.
7. **SVG**: `stroke="var(--wk-…)"`, `fill="var(--wk-…)"` and `currentColor` all work.
8. **`color-scheme`** is set by the scope (dark / light), so native controls and scrollbars
   match. Range inputs in the boards are `opacity: 0`, so this is not visible there.
9. **Contrast**: content text uses `--wk-text` to `--wk-text-4` only; `--wk-text-5` is for
   disabled or decorative glyphs.

## 6. Contrast results

Backgrounds: dark island = `rgba(17,28,25,.5)` over the plot ≈ `#0e1916`, dark panel ≈ `#0f1a17`,
fill `#192b24`. Light island = `rgba(248,250,249,.92)` over the dark plot (worst case, nothing
bright behind) ≈ `#e5e8e7`, light panel ≈ `#ecefed`, fill `#e2e9e5`. Ratios are island / panel / fill.

| Token | Dark | Ratios | Light | Ratios |
|---|---|---|---|---|
| text | `#f4f7f5` | 16.8 / 16.5 / 13.8 | `#12201b` | 13.6 / 14.5 / 13.6 |
| text-soft | `#d9e4de` | 13.9 / 13.6 / 11.4 | `#22332d` | 10.8 / 11.5 / 10.8 |
| text-2 | `#b9cac1` | 10.6 / 10.4 / 8.7 | `#33463e` | 8.2 / 8.7 / 8.2 |
| text-3 | `#8ba598` | 6.8 / 6.7 / 5.6 | `#44574f` | 6.3 / 6.7 / 6.3 |
| text-4 | `#758b81` | 5.0 / 4.9 / 4.1 ¹ | `#4e6158` | 5.4 / 5.7 / 5.4 |
| text-5 (decorative) | `#52645d` | 2.9 / 2.8 / 2.4 | `#8a9b93` | 2.4 / 2.5 / 2.4 |
| track (UI, 3:1) | `#2c443b` | 1.7 ² | `#77897f` | 3.0 / 3.2 (knob on track 3.7) |
| phosphor | `#7becc7` | 12.6 / 12.4 / 10.4 | `#086a50` | 5.3 / 5.7 / 5.3 |
| ice | `#8fd0ff` | 10.9 / 10.7 / 8.9 | `#0a5fa6` | 5.3 / 5.7 / 5.3 |
| violet | `#c4a6ff` | 8.8 / 8.7 / 7.3 | `#6941c6` | 5.4 / 5.7 / 5.4 |
| coral | `#ffa0c8` | 9.6 / 9.4 / 7.9 | `#ad2470` | 5.2 / 5.6 / 5.2 |
| mono | `#e6ece9` | 15.1 / 14.9 / 12.4 | `#1d2b26` | 11.9 / 12.7 / 11.9 |
| amber | `#f2b84b` | 10.1 / 9.9 / 8.3 | `#7a4f00` | 5.8 / 6.2 / 5.8 |
| danger | `#ff7a6b` | 7.1 / 7.0 / 5.8 | `#b3301f` | 5.1 / 5.4 / 5.1 |

On-accent text (label on a filled accent button): dark `#111c19` on phosphor 12.2, ice 10.5,
violet 8.5, coral 9.2, mono 14.6; light `#ffffff` on phosphor 6.6, ice 6.6, violet 6.6,
coral 6.4, mono 14.7. Amber soft on amber glass: 12.4 dark, 7.9 light. Accents on the dark plot
(Spectrum in either theme): 9.1 to 15.5.

Distance from amber and red (CIEDE2000, dark / light; ≥ 20 is clearly different at a glance):
phosphor 38/35 from amber, 61/55 from red; ice 49/46, 48/45; violet 54/54, 35/41;
coral 45/44, **21/26** (the tightest; why coral is rose); mono 28/31, 35/41.

¹ Dark text-4 on the solid fill is 4.1:1; unchanged from the current design (dark must not
move). Avoid text-4 on `--wk-fill` in new work.
² Dark switch tracks are unchanged from the current design; the knob against the track is 11:1,
so the state stays visible. Light mode meets 3:1 for the track itself.
