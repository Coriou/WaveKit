---
version: 1
slug: "ui-index-html"
primary_target: "ui/index.html"
related_targets: []
---

# Pi receiver status page

Scope: `ui/` — the read-only operator page served by the SDR-host API at `/`.
Mode: Operate. Phone beside the Pi and laptop beside WaveKit, equally.
Job: answer "is IQ really flowing?" in one glance, then why not, without SSH.
Constraints: read-only; no build step; offline; Pi 3 must serve it for almost nothing; stale/unavailable are first-class states; never colour-only state.

## Direction contract

THESIS: The Pi as a bench instrument — one graticule screen plotting measured upstream flow against the expected rate, readouts silk-screened around it. Refuses the equal-card metrics wall.
OWN-WORLD: Graphite or lab-grey bezel by system theme; screen always dark with fine graticule; one amber trace, dashed expected line; small-caps legends; tabular readouts; lamps with words; silkscreen rules, no cards, no shadows.
STORY: Operator sees flow, its rate and freshness; then reads the chain (dongle→rtl_tcp→rtlmux→clients), active vs latched power, host readouts, setup.
FIRST VIEWPORT: Nameplate with host and live/stale lamp; full-width screen, top-left verdict and rate; chain row beneath; power annunciators next.
FORM: Impeccable's pick, Bench Instrument Front Panel; seed 239cf643. Signature: touch/hover marker reading time and rate off real samples; gaps stay blank.
FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
