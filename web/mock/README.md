# Mock API

Serves the canvas's mock data over the core's real routes so the web app runs without a receiver.
Start it with `pnpm --filter @wavekit/web mock`, then `pnpm --filter @wavekit/web dev`.

- API and `/ws` on `127.0.0.1:3101` (`WAVEKIT_MOCK_PORT`, `WAVEKIT_MOCK_HOST`); synthetic live
  audio on port + 1 (`WAVEKIT_MOCK_AUDIO_PORT`, advertised as `WAVEKIT_MOCK_AUDIO_ORIGIN`,
  default `http://localhost:3102`) at `/stream.wav` and `/stream`.
- Legacy core: `GET /api/access/bootstrap` is not mounted (404).
- `/stream` sends the core's `X-Audio-Format` / `X-Sample-Rate` / `X-Channels` headers and exposes
  them to `fetch()` (`Access-Control-Expose-Headers`), as the app's Web Audio player reads them.
- Spectrum subscriptions honour `backfillMs` like the core (WG1): up to 64 recent frames of the
  current epoch, oldest first, `backfill: true`, counted in the ack's `backfillFrames`.
- `data.ts` holds the canvas data (signals, band plan, decoders, messages, identify plans),
  `spectrum.ts` the frame synthesis, `audio.ts` the audio server, `server.ts` the routes and
  `buildMockServer()` (used by `web/tests/mock`).
