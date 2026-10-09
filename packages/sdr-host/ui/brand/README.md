# Vendored WaveKit brand files

The Pi pages have no build step and load nothing from the network, so the brand
files they use are copied here unchanged from `packages/brand` (`@wavekit/brand`
v1.0.0, copied 9 October 2026). To re-sync, copy the same files again and update
the hashes below; never edit them here.

| File                           | Copied from `packages/brand/`            |
| ------------------------------ | ---------------------------------------- |
| `wavekit-wordmark-on-dark.svg` | `logos/wavekit-wordmark-on-dark.svg`     |
| `favicon.svg`                  | `marks/favicon.svg`                      |
| `D-DINCondensed.woff2`         | `fonts/d-din/D-DINCondensed.woff2`       |
| `D-DINCondensed-Bold.woff2`    | `fonts/d-din/D-DINCondensed-Bold.woff2`  |
| `NotoSans-Regular.woff2`       | `fonts/noto-sans/NotoSans-Regular.woff2` |
| `OFL-D-DIN.txt`                | `fonts/d-din/OFL.txt`                    |
| `OFL-Noto-Sans.txt`            | `fonts/noto-sans/OFL.txt`                |
| `FONTLOG-D-DIN.txt`            | `fonts/d-din/FONTLOG.txt`                |

Both font families are under the SIL Open Font License 1.1; the licences travel
with the fonts (with D-DIN's upstream font log). D-DIN reserves its font names, so its files are upstream and
unmodified. The Noto Sans file is the brand package's Latin subset.

Only the faces the pages use are vendored: D-DIN Condensed 400/700 for labels
and headings, Noto Sans 400 for body text and live numbers (D-DIN has no
tabular figures). Brand rule kept here: the wordmark is the vector artwork,
never retyped, and is shown at 120 CSS px or wider; the baseline lockup is not
used because these headers are narrower than its 320 px minimum.

SHA-256:

```
f3cc7670cc6b928f5170c2626eec61a88db9a1a45ebe9d8cc97c6041fed000c1  wavekit-wordmark-on-dark.svg
8b08c4fea346531727780895897a3244c8c99c4ac5115437f6efb3f0cabdab0f  favicon.svg
662bb4d950dbe9772c180362867645a5100ee98599495354d006d84063dd1f96  D-DINCondensed.woff2
ba78aaedb4ff282c63c1aa5e35a5fcfff69b1a349bba6dc7c040631069b4bc29  D-DINCondensed-Bold.woff2
7b09d0b77d091d47beab880e36771f08cc1ae41fe081f6a49a6147299dea004e  NotoSans-Regular.woff2
59e505e11e6da3ac3020eb6b4163f4d0382524183db660bf52a08234c764b2e5  OFL-D-DIN.txt
cee9892f9f0cc8fe882c9e9537ee6a89621d86ee7ceaf70b02e2b2b1c25c061a  OFL-Noto-Sans.txt
e1e2e114db6aed0269e7f907bc0b2bd0da18c05b6339a8f712d3645d5d7e043f  FONTLOG-D-DIN.txt
```
