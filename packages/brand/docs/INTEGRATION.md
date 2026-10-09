# Integration

## Static HTML and repository documentation

Copy the pack's assets under your chosen static path. Use concrete colour variants
for external SVG images; `currentColor` does not cross an `<img>` boundary.

```html
<!-- Dark hero; intrinsic dimensions reserve the correct aspect ratio. -->
<img
	src="/brand/logos/wavekit-lockup-on-dark.svg"
	width="680"
	height="215"
	style="width:400px;max-width:100%;height:auto"
	alt="WaveKit — MAKE SENSE OF THE SPECTRUM"
/>

<!-- Light navigation, no baseline. -->
<img
	src="/brand/logos/wavekit-wordmark-on-light.svg"
	width="680"
	height="164"
	style="width:180px;max-width:100%;height:auto"
	alt="WaveKit"
/>

<!-- A category icon already has a visible label. -->
<a href="/aircraft">
	<img src="/brand/icons/on-light/aircraft.svg" width="24" height="24" alt="" />
	<span>Aircraft</span>
</a>
```

When app theme is controlled by the app, select the matching file from the app theme,
not just the OS preference. In markdown, use a local banner path such as:

```md
![WaveKit — MAKE SENSE OF THE SPECTRUM](./brand/templates/repository-banner-1280x640.svg)
```

Keep technical documentation as live text, not paragraphs baked into images. The
category mappings are in `icons/categories.json`; do not infer supported modes from
an icon's visual shape.

## Sprite

`icons/categories.symbols.svg` is a symbol library, not a picture for `<img>`.
For maximum control, insert its symbols once in a hidden inline SVG, then reference
one from a named consuming element:

```html
<svg width="24" height="24" role="img" aria-label="Aircraft" focusable="false">
	<use href="#wk-aircraft"></use>
</svg>
```

The symbol IDs are `wk-aircraft`, `wk-marine`, `wk-aviation-data`, `wk-voice`,
`wk-paging`, `wk-aprs`, `wk-sensors`, `wk-mesh`. Do not insert duplicate symbol
libraries into the same document. Individual SVGs and React components use no IDs.

## Fonts and CSS

Use `tokens/brand.css` and `tokens/typography.css`; the WOFF2 fonts they load are in
`fonts/` (see `fonts/README.md`). All production SVGs remain font-independent.
The fallback metrics come from the supplied R48 specification and need target-device
checking. The CSS is opt-in through `wk-*` classes. Themes follow the OS preference
unless `data-wavekit-theme="light"` or `"dark"` pins one; dark-first surfaces should
pin `dark`.

## Favicons, app and PWA icons

```html
<link rel="icon" href="/brand/marks/favicon.svg" type="image/svg+xml" />
<link rel="icon" href="/brand/exports/favicon.ico" sizes="any" />
<link rel="apple-touch-icon" href="/brand/exports/wavekit-app-180.png" />
<link rel="manifest" href="/brand/templates/site.webmanifest" />
```

Adjust `/brand/` and the manifest's `start_url` to your deployment. The opaque square
master avoids baking a rounded mask into assets that a platform will mask itself.
The rounded SVG is for explicit in-page badge presentation. The maskable version
has a reduced symbol footprint inside its safe area and a full-bleed background;
use it only for the `maskable` manifest purpose. Test platform cropping, store export
requirements and your real manifest separately. These are graphical source assets,
not an installed native app icon catalog or platform approval.

## Social and editorial

`templates/social-card-1200x630.svg`, `social-square-1080x1080.svg`,
`repository-banner-1280x640.svg`, `editorial-cover-1600x900.svg` are full vector
compositions. PNG counterparts are in `exports/`. They contain no made-up domain,
no product metrics and no axis labels. Use these PNGs for destinations that expect
raster uploads. Platform crop behaviour must be checked in the destination.

## Email

Use a hosted PNG derivative in email, not an embedded board or an SVG-as-raster
wrapper. A compact signature example is supplied as `templates/email-signature.html`.
Replace the hosting path with your real asset URL; no public domain is assumed.
Test that image blocking and text-only presentation still leave a readable brand name.

## Terminal

The repository uses an Ink/React terminal dashboard according to its product document.
SVG graphics and browser React components do not render in a terminal. Use “WaveKit”,
readable text labels and a restrained ANSI palette there; keep graphical branding in
README, web docs, releases and any graphical frontend. Do not paste private-use icon
font glyphs and assume users have a matching terminal font installed.

## Print

Use the one-colour or high-contrast vector files. Strokes are editable; request an
outline expansion only when the print provider needs it. The pack is sRGB, not a
press-specific CMYK conversion. Request target-process proofs rather than assuming
identical mint reproduction on screen, uncoated stock and fabric.
