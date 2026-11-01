# Longevity measurements

Measurement-only harnesses for long-running behaviour: state growth, startup cost
against state size, heap over time and WebSocket payload sizes. None of them is a
test and none asserts on time. They use the real store classes on synthetic data
in a temporary directory, and an in-process fake rtl_tcp on port 0 where IQ is
needed. Never point them at a live state directory or a real receiver: copy a
store first when you want numbers from one.

Bundle a harness with esbuild, then run it with Node 24:

```bash
pnpm exec esbuild scripts/longevity/<name>.ts --bundle --platform=node \
  --format=esm --packages=external --outfile=output/longevity/<name>.mjs
node --expose-gc output/longevity/<name>.mjs [flags]
```

| Harness               | What it reports                                                                                                                                                                                                          |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `activity-growth.ts`  | Activity rows per hour and on-disk bytes per row for a traffic profile (`--profile busy\|quiet\|adsb\|paging\|ism`, `--minutes`), hours to the byte cap, reopen time, size of one "Decoded Message" log line             |
| `activity-queries.ts` | EXPLAIN QUERY PLAN, first and median time of the hot Activity reads and the retention seed scan (`--db`), reopen time (`--state-dir`, a copy)                                                                            |
| `reader-stall.ts`     | Facets read and a search burst through the query service in worker mode, with a main-thread stall (`--state-dir` copy, `--stall` ms, `--phase poll\|timers`); needs the query worker bundled next to it (see its header) |
| `facets-index.ts`     | Facets read time (wall and CPU, current and previous algorithm) before and after the `activity_facets` index on a synthetic cap-size store (`--rows`, default 250 000), the index build time and size, plans after       |
| `scanner-state.ts`    | Scanner snapshot size, snapshot write time, `load()` and `restoreInSlices` time and event-loop delay for `--discoveries` × `--obs-per`                                                                                   |
| `memory-soak.ts`      | Heap after GC over time: `--part iq` (fake rtl_tcp → SourceManager → FanoutManager, real time) or `--part tracking` (fake clock, rotating aircraft through the tracker and Activity admission)                           |
| `ws-payloads.ts`      | Bytes and JSON.stringify cost of `aircraft:update` by trail length and `spectrum:frame` by bin count; `aircraft` channel bytes/s per client before and after the 1 Hz publisher (`--aircraft`, `--rate`, `--seconds`)    |

Keep each run short on a shared machine: every harness prints the load average
it saw, so compare numbers taken at a similar load.
