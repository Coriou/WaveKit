# Web app foundation (sub-project C), design

Date: 2026-10-16. Status: in progress. Owner decisions: the Immersive board (direction C) is the
interface the web app implements; order A design system → C web app foundation → B Pi pages
(`docs/web/DESIGN.md`, decision log). Design source: the canvas, snapshot in `docs/web/canvas/`.
Styles: `packages/brand/tokens/ui.css` (design system v1).

## Goal

A real browser app that renders the Immersive shell on the `ui.css` recipes, reads the live core
over its public API, and runs one vertical slice end to end: **spectrum → tune → identify →
inspect → listen**. A mock server serves the canvas's data over the same routes so the front end
can be built and demoed without a receiver. Progress per feature is tracked outside the repo.

## Decisions

1. **Where:** a `web/` workspace (`@wavekit/web`), beside `cli/`. Not under `packages/` because it is
   an app, like the CLI. It is a static bundle; serving it from the core comes later.
2. **Stack:** Vite + React 19 + TypeScript (same strict flags as the repo, `moduleResolution:
   bundler`). No CSS framework: the app imports `ui.css` and uses its recipe classes directly; app
   CSS lives in a `wk-app` layer declared after `wk-recipes`, so recipes stay the defaults and app
   rules are deliberate overrides. The Tailwind/shadcn mapping mentioned in DESIGN.md is dropped:
   it would be a second copy of the recipes to keep in sync. Accessible primitives (menu, dialog,
   tooltip) are written against the recipes when a feature needs them; a headless library is a
   per-feature choice, not a foundation one.
3. **State:** small typed stores read with `useSyncExternalStore` (no state library). One store per
   domain (connection, sources, tuner, live audio, spectrum view, identify, UI shell).
4. **Data layer:** `ApiClient` (fetch, JSON, typed with `@wavekit/api-types`, protected-mode aware:
   bootstrap, cookie credentials, `X-WaveKit-CSRF` on unsafe methods) and `EventsClient` (the `/ws`
   channel socket: subscribe, typed dispatch, reconnect with backoff, resubscribe and REST refetch
   after reconnect, since the core replays nothing). Responses are validated at the boundary with
   Zod only where the shape is not already guaranteed by the shared DTOs.
5. **Spectrum pipeline (performance):** the core sends JSON `spectrum:frame` messages with
   base64 bins (`u8-halfdb-127.5`). A dedicated worker owns its own `/ws` connection subscribed to
   `spectrum` only, decodes base64 into `Uint8Array` rows, keeps the waterfall history, and renders
   spectrum + waterfall with **WebGL2 on an OffscreenCanvas** (R8 texture ring buffer for the
   waterfall, a line/fill pass for the trace, colour ramp as a 256×1 texture rebuilt from the
   theme tokens). The main thread never touches bins: it posts view state (span, zoom, pan, VFO,
   theme ramp, size) and receives a small per-frame summary (axis, floor, tracks) for DOM overlays.
   Fallback when `transferControlToOffscreen` is missing: same renderer on the main thread, worker
   still decodes. Rules from docs/API.md: reset history on `spectrum:profile` and whenever
   `sourceId`, `epoch`, `profile`, `binHz` or `startHz` changes; grey the axis when
   `tuningTrust` is `unverified`.
6. **Mock server:** `web/mock/`, Fastify + `@fastify/websocket`, implementing the slice's real
   routes and messages with the canvas data (the 18 mocked signals at realistic frequencies,
   decoders, sources, band plan): `/api/sources`, `/api/decoders`, `/api/tuner[/:id[/frequency]]`,
   `/api/live-audio/{status,start,stop,config}`, `/api/bandplans/resolved`,
   `/api/scanner/identify` + `scanner:identify` events, `/api/activity` + `activity:subscribe`,
   `/ws` channels and spectrum frames, and a synthetic `/stream.wav`. No access mode (legacy).
   Vite proxies `/api`, `/ws` and `/health` to `WAVEKIT_WEB_API` (default: the mock).
7. **Access:** the slice runs against legacy cores and the mock. Protected mode is handled by the
   clients (bootstrap, cookie, CSRF) but pairing UI comes later; until then a protected core
   without a session shows a "pair this browser" state and the app stays read-only.
8. **Tuning model:** the tuner (`/api/tuner`) holds hardware centre and gain; modulation,
   bandwidth, squelch and the channel offset belong to live audio (`/api/live-audio/config`).
   The app's "tuned frequency" is centre + `offsetHz`; tuning inside the capture window moves the
   offset, outside it recentres the hardware (DESIGN.md spectrum interaction rule).

## Delivery lots

| Lot | Content | Done when |
| --- | --- | --- |
| C1 | Workspace, build, lint/typecheck wiring, theme root, fonts, app shell skeleton | `pnpm --filter @wavekit/web build` and repo checks pass |
| C2 | Mock server | the CLI's routes used by the slice answer with canvas data; tests |
| C3 | Spectrum worker + WebGL2 renderer | 60 fps at 2048 bins on a laptop, decode tests |
| C4 | Immersive shell: islands, dock, drawers (code-split), themes and accents | matches the Immersive board renders |
| C5 | Slice: tune, identify, tuned card, listen | the flow works against the mock and a legacy core |

The inventory's "app component" column (`packages/brand/docs/ui-kit.md`) is filled as components
land.

## Contract notes (core as of main@23388b9)

- `/ws`: send `{"type":"subscribe","channels":[...],"options":{"spectrum":{sourceId,hz,bins,averaging,backfillMs}}}`;
  server messages are `{type, channel, data}`. Spectrum order: `spectrum:profile`, backfill,
  snapshot, live. Bin i: `dBFS = byte/2 − 127.5`, centred at `startHz + (i+0.5)·binHz`. hz 0.5–25,
  bins 128–2048; at most 4 non-default profiles per core.
- Outbound limits: 1 MiB per message, 256 queued messages per client, then the client is cut.
- Live audio is HTTP on its own port: `status.wavUrl` for `<audio>`, `status.httpUrl` raw PCM with
  `X-Audio-Format`, `X-Sample-Rate`; the rate is `effectiveSampleRate`, not a fixed 48 kHz.
- Identify: `POST /api/scanner/identify` → 201 `ScanJob`; progress on WS `scanner:identify`.
- Band lookup is client-side from `GET /api/bandplans/resolved`.
- Activity: `GET /api/activity` page, then `activity:subscribe` with `replayCursor` for a gapless live
  feed; `commitSeq` is a decimal string.
