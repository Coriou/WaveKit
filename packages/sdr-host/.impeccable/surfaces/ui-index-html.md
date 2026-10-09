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

THESIS: The Pi as an instrument screen — one recessed screen leads with the verdict and measured rate, then small multiples on one five-minute time base (sample flow, CPU, memory, SoC temperature, power dips) read by one cursor. Refuses the equal-card metrics wall and the dev key/value dump.
OWN-WORLD: WaveKit brand v1.0 dark theme (ink, paper, phosphor), vendored wordmark, D-DIN Condensed labels and verdicts, Noto Sans body and live numbers; phosphor means live, amber/red are semantic only; rows grouped by space not rules, lamps with words, no shadows, no light theme; nothing moves when data changes, except the client list as clients join or leave.
STORY: Operator sees the verdict and rate, scans the shared-time trends for the cause, then the IQ stream (endpoint to paste, dongle, tuning, clients keeping up, one row each) and this Pi (power as one fact, Wi-Fi bars, storage meter, uptime, setup). Developer detail sits open at the foot of the page in Diagnostics.
FIRST VIEWPORT: Wordmark, page name, host and contact; the screen with verdict, rate and channels; IQ stream beside it on wide screens (1200px and up).
FORM: Impeccable's pick, Bench Instrument Front Panel; seed 239cf643. Signature: touch/hover marker reading time and rate off real samples; gaps stay blank.
FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
