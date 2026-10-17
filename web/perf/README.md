# Perf bench

`pnpm --filter @wavekit/web perf` builds the web app, serves it with `vite preview` against the mock
under load (`WAVEKIT_MOCK_LOAD=10`, `WAVEKIT_MOCK_ADSB_RATE=5`: about 340 aircraft at 5 updates per
second each, 140 vessels, ten times the decoder messages), and drives it in Chromium through
playwright-core with the CPU slowed 4× (a phone). It exits 1 when a result is over a budget in
`budgets.json`. Needs `@wavekit/shared` and `@wavekit/api-types` built (`pnpm run build` at the root
does it) and a Chromium: `PLAYWRIGHT_CHROMIUM_PATH`, else `/opt/pw-browsers`, else playwright-core's
own lookup.

Each scenario loads the app fresh, opens its view and drawer, waits 3 s, then measures for 8 s:

| Column | What                                                                                |
| ------ | ----------------------------------------------------------------------------------- |
| fps    | `requestAnimationFrame` callbacks per second                                        |
| p95    | 95th percentile of the time between two frames                                      |
| missed | share of frame gaps over 1.5 vsync                                                  |
| busy   | main thread busy with tasks (CDP `TaskDuration`), share of wall time                |
| script | main thread in JavaScript (CDP `ScriptDuration`): the app's own cost, without paint |
| long   | long tasks (over 50 ms) per second of window                                        |

The leak run cycles every view, drawer, Settings and the palette (`--cycles`, default 8, after two
warm-up cycles), forces a GC after each one and checks the heap's growth per cycle, DOM nodes and
event listeners.

Options: `--no-build`, `--only=spectrum,messages,leak`, `--measure=ms`, `--warm=ms`, `--cycles=n`,
`--throttle=x`, `--out=report.json`, `--profile=dir` (one `.cpuprofile` per scenario, for DevTools),
`--headed`.

## Reading the numbers

- The map has no fps budget: headless Chromium draws WebGL with SwiftShader on the CPU, about one
  frame a second for MapLibre here, which says nothing about a device with a GPU. Its budget is on
  `script`, the JavaScript the map and its data cost.
- Budgets were set on this bench's runs of 2026-10-17 with headroom for its noise (a few fps, ±5
  points of busy): a breach means a real regression, not a slower day. Re-run before believing one
  result.
- The spectrum draws in a worker on an OffscreenCanvas; its GPU and worker time do not show in the
  main-thread columns.

## Measured 2026-10-17 (after the fixes of that day)

| Scenario          | fps | busy | script | Before the fixes      |
| ----------------- | --- | ---- | ------ | --------------------- |
| spectrum          | 58  | 16 % | 6 %    | same                  |
| spectrum+activity | 52  | 40 % | 12 %   | 53 fps, 64–72 % busy  |
| spectrum+scanner  | 56  | 20 % | 6 %    | same                  |
| messages          | 42  | 62 % | 13 %   | 23 fps, 85–100 % busy |

Leak run: heap +0.1 MB per cycle, DOM nodes and listeners flat. Long sessions (3 min on the spectrum, 3 min on the loaded map, GC between samples) kept a flat heap;
the only growth was V8's compiled code and the browser's bounded performance-entry buffers.
