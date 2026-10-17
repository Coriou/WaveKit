# Mock API

Serves the canvas's mock data over the core's real routes so the web app runs without a receiver.
Start it with `pnpm --filter @wavekit/web mock`, then `pnpm --filter @wavekit/web dev`.

- API and `/ws` on `127.0.0.1:3101` (`WAVEKIT_MOCK_PORT`, `WAVEKIT_MOCK_HOST`); synthetic live
  audio on port + 1 (`WAVEKIT_MOCK_AUDIO_PORT`, advertised as `WAVEKIT_MOCK_AUDIO_ORIGIN`,
  default `http://localhost:3102`) at `/stream.wav` and `/stream`.
- Legacy core: `GET /api/access/bootstrap` is not mounted (404).
- `/stream` sends the core's `X-Audio-Format` / `X-Sample-Rate` / `X-Channels` headers and, like a
  legacy core since WG7, `Access-Control-Allow-Origin: *` on every answer and a 204 preflight on the
  stream paths: the page fetches it cross-origin directly. While live audio is stopped the connection
  is dropped, as the core's audio server is then not listening.
- Matched against a real core (lot C7): frames cover only the usable 80 % of the capture (`binCount`
  below the bins asked for, track edges on the summary bin grid), error bodies are the core's
  (`{ error, code, message, correlationId }`, `VALIDATION_ERROR` with `details`, route 404
  `NOT_FOUND`), identify answers `starting` and sends `waiting-for-signal` before the job turns
  `running`, and `dataRate` is KiB/s.
- Spectrum subscriptions honour `backfillMs` like the core (WG1): up to 64 recent frames of the
  current epoch, oldest first, `backfill: true`, counted in the ack's `backfillFrames`.
- `data.ts` holds the canvas data (signals, band plan, decoders, messages, identify plans),
  `spectrum.ts` the frame synthesis, `audio.ts` the audio server, `server.ts` the routes and
  `buildMockServer()` (used by `web/tests/mock`).
- Receiver controls live in `receiver.ts` (registered from one marked block in `server.ts`): the tuner
  setting routes and `PATCH /api/tuner/:id/config` with the core's validation codes and messages,
  `GET /api/receiver-capabilities[/:id]` for an RTL-SDR with an R820T (29-step gain table, rate
  presets, 15 controls) and `GET /api/tuner-relay` (port 1234, exclusive). Writes emit
  `tuner:command-sent` then `tuner:state-changed`; a new sample rate bumps the spectrum epoch (the
  synthetic frames keep their 2.4 MS/s span). `WAVEKIT_MOCK_RELAY_CLIENT=1` starts with an SDR++
  client holding the tuner (`TUNER_CONTROL_EXTERNAL` until the panel takes control back).
