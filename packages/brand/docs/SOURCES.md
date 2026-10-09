# Sources and provenance

Accessed for this pack on 9 October 2026. Branch URLs can change; icon and product
file blob hashes are recorded so an agent can distinguish this snapshot from later
upstream changes. No live decoder execution or trademark search was performed.

## Product

- Repository: https://github.com/Coriou/WaveKit
- Product context: https://github.com/Coriou/WaveKit/blob/main/.kiro/steering/product.md
- Product file Git blob: `43bac806a9bb4bf423181b331b7ab6355646acfc`
- This is the source of the eight category groupings and nine documented integrations.
- The original signal path and Inter Display lineage came from the owner-supplied
  `wavekit-mark.svg`, `wavekit-logo.svg` and earlier logo-kit README in this conversation.

## Icon research and source

- Tabler project and drawing grid: https://github.com/tabler/tabler-icons
- Tabler icon catalogue: https://tabler.io/icons
- Tabler license: https://github.com/tabler/tabler-icons/blob/main/LICENSE
- License Git blob: `3e82379dab3fe93d9ee22251949604ed63ddea39`
- Lucide alternative considered: https://lucide.dev/guide/
- Lucide icon design guide: https://lucide.dev/contribute/icons/
- Lucide licensing (not used in the shipped icons): https://lucide.dev/license

Individual Tabler SVG origins and Git blobs are listed in `ICONOGRAPHY.md` and
`source/geometry.json`. The files in this pack do not depend on those URLs at runtime.

## Typography

- Owner-supplied R48 specification: `travail-eneal/minisite-commercial-pilote/deployment/release-r48/public/styles.css`
  and `app/login-assets/login.css`, as quoted in the conversation. The actual private
  CSS file was not re-fetched for this task; sizes and fallback metrics use that quote.
- D-DIN font repository and source credits: https://github.com/amcchord/datto-d-din
- Noto project: https://notofonts.github.io/
- Noto legacy repository / migration notice: https://github.com/notofonts/noto-fonts
- SIL OFL, using fonts in logos and artwork: https://openfontlicense.org/how-to-use-ofl-fonts
- SIL OFL, webfonts and reserved names: https://openfontlicense.org/webfonts-and-reserved-font-names

The fixed artwork in this kit uses outlined Inter Display SemiBold and Noto Sans
Condensed Bold; body text in the outlined boards uses Noto Sans. The live D-DIN / Noto
pairing is specified in the CSS; its WOFF2 files and their provenance are listed in
`fonts/README.md` (fetched 9 October 2026).

## Accessibility references

- W3C, minimum text contrast: https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html
- W3C, non-text contrast: https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html

Colour ratios in `ACCESSIBILITY.md` are calculated from this pack's actual sRGB tokens,
not read from the generated concept images. They are not an application-wide audit.
