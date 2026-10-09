# Typography

## Separate the fixed logo from the live type system

The live type system follows the supplied OBJECTIF HABITEMPS 2031 / R48 reference:

| Role                                             | Family                    | Weights                       |
| ------------------------------------------------ | ------------------------- | ----------------------------- |
| Editorial display, titles, numbers, short labels | D-DIN Condensed           | 400, 700                      |
| Body, documentation, forms and UI                | Noto Sans                 | 400, 700, 400 italic          |
| Terminal output                                  | User's terminal monospace | Do not force a graphical font |

The **logo is a drawing**. Its lowercase `avekit` lettering is Inter Display SemiBold
with optical placement and tracking, matching the original selected logo's lineage.
The official baseline is a compact **Noto Sans Condensed Bold** drawing. This fixed
baseline uses 36-unit type with 1.2-unit tracking (about 0.033 em), then is converted
to paths. These two lettering sources are not extra webfonts to load. The baseline
is not a D-DIN sample and must not be recreated with whichever font happens to exist.

The overview board uses Noto Sans to label the two live type roles. The words
“D-DIN Condensed” on it are a family-name label, not a specimen rendered in that font.
For actual editable D-DIN display text, use the CSS and original font described below.

## Source fonts, do not substitute them inside the logo

The vector artwork has no font dependency. The live fonts ship as WOFF2 in `fonts/`
(sources, licences and the Noto subset are documented in `fonts/README.md`).
The supplied CSS uses the original family names with `font-display: fallback`.
It does not fetch fonts from a CDN. If a font file is not deployed, the live text
uses the fallback stack; do not judge final D-DIN appearance from that fallback.

D-DIN Condensed has proportional digits and no `tnum` feature. Set live-updating
numbers (frequencies, counters, rates) in Noto Sans with `.wk-numeric`, which has
tabular figures, so values do not jitter as they change. Neither family has arrow
glyphs (U+2190 block); arrows fall back to a system font.

The font faces required are D-DIN Condensed Regular/Bold and Noto Sans
Regular/Bold/Italic. Do not request Noto 600 without adding the actual font; this
pack uses 700 for emphasis rather than relying on a synthetic semibold.

## Reading settings

Body: 18 px / 1.62, a 64 ch reading measure. Compact UI: 16 px / 1.45; supporting
interface labels should normally stay at 14 px or more. Editorial display can be
condensed and tight, but paragraphs must not be condensed. Headings wrap with
`balance`; prose uses `pretty`, normal kerning and optional language-aware hyphenation.

The CSS provides a fluid display scale and an optional 22 px / 1.56 reading mode.
Use Noto Sans for input values and long navigation labels where condensed display
type would compromise readability. Do not copy very tight poster line heights onto
multiline forms or body content.

## Metric fallbacks from the supplied R48 specification

| Family                | Local base   | Size adjust | Ascent | Descent | Line gap |
| --------------------- | ------------ | ----------: | -----: | ------: | -------: |
| D-DIN Condensed Repli | Arial Narrow |       77.1% | 107.8% |   21.9% |    11.2% |
| Noto Sans Repli       | Arial        |      104.5% | 102.3% |     28% |       0% |

These are carried over from the owner's supplied R48 specification. They have not
been remeasured across every operating system or local Arial version and do not
guarantee zero layout shift. Test the actual target stack. D-DIN's missing U+202F
is handled by allowing the Noto family to supply it; the D-DIN fallback face excludes
that code point explicitly in the CSS.

Preload only faces used immediately above the fold. The package `README.md` shows
the two main preloads; adjust the paths to your deployment.

## Licensing and modified font files

Keep the upstream license beside any font files you add. D-DIN Condensed is shipped
as the upstream WOFF2, unmodified, because its OFL reserves the name "D-DIN Condensed".
Noto Sans has no Reserved Font Name, so the shipped files are subsets that keep the
family name. Before making further subsets, converted builds or other changes,
review the actual OFL and Reserved Font Name conditions. For modified
versions requiring renaming, change the font's internal names as well as the CSS
family; changing a CSS alias alone is not sufficient. Do not treat a webfont format
conversion as a blanket statement about license compliance. See `docs/SOURCES.md`.
