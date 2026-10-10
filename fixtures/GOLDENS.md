# Fixture golden runs

One row per harness run of `tests/integration/iq-fixture-goldens.test.ts` (plan Task 8, delta E3/E5).
Expected decodes live in `manifest.yaml`. `min_count = max(1, floor(0.8 × count))` from the record run
(ruling QH-6). Payloads hold only `key_fields` values. There are up to 3 per fixture and never a stray decode.
Private `own_*` fixtures keep `payloads: []` (ruling QH-4: radio ids never enter the manifest).

## Images

| tag                    | image id                                                                  | source                                                                                                |
| ---------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `wavekit:local-core`   | `sha256:2f054a0feb526e1bf68b51f0b518446f42c94adf7b81ae286d5d94253fe48d0a` | main 9ff133d (ruling QH-1: no src/Dockerfile change on main since)                                    |
| `wavekit:chan-46fbe76` | `sha256:018a28881091d11de5f7483690c9ba704802439f536a12a3b9fe478ccd92ff31` | feat/core-channelizer 46fbe76, clean detached worktree, amd64 (QH-2); `wavekit-chan 0.1.0 protocol 1` |

## Fixtures (raw path, batch 3)

| id                                                                   | sha256       | decoder     | record count                      | min_count       | payloads (key fields)                   |
| -------------------------------------------------------------------- | ------------ | ----------- | --------------------------------- | --------------- | --------------------------------------- |
| composed_ais_162m_2048k                                              | 9a2c4432135e | ais-catcher | 58 (27 keys)                      | 46              | 338155151/18, 367165450/1, 368007230/24 |
| composed_ais_162m_2400k                                              | 1e137e2d08ef | ais-catcher | 62 (30 keys)                      | 49              | as 2048k                                |
| composed_pocsag_466075k_2048k                                        | 2747fa821c92 | multimon-ng | 5                                 | 4               | 1234567/3, 1122334/0, 2000016/3         |
| composed_aprs_144800k_2048k                                          | 55e76d0dd372 | direwolf    | 8                                 | 6               | N0CALL>APRS, KC1ABC>APRS                |
| composed_acars_131725k_2048k                                         | 48c31b7b7f41 | acarsdec    | 4                                 | 3               | D-AWKT/H1, G-WKIT/5Z, EI-WKT/Q0         |
| composed_ism_433920k_2048k                                           | d9937b2523a9 | rtl433      | 8                                 | 6               | Acurite-3n1/7992                        |
| composed_vdl2_136800k_2048k                                          | 98aab5aa3886 | dumpvdl2    | 22 (11 keys)                      | 17              | 345678/I, 3944EE/S, 400D91/I            |
| composed_dmr_446m_2048k                                              | 207493345b32 | dsd-fme     | 1 call_start                      | 1               | 12345678/12345678                       |
| own_dmr_446m_2048k (private)                                         | 52986b809787 | dsd-fme     | 3 call_start (1 key)              | 2               | none (QH-4)                             |
| own_dmr_446m_2400k (private)                                         | 8551d0f4d680 | dsd-fme     | 3 call_start (1 key)              | 2               | none (QH-4)                             |
| sigid_pocsag                                                         | 2218e1ce0a3e | multimon-ng | 6                                 | 4               | 1234567/3, 1126640/3, 1121802/3         |
| rtl433_acurite_3n1_g001                                              | d3d964b90b38 | rtl433      | 2                                 | 1               | Acurite-3n1/7992                        |
| rtl433_fineoffset_wh32_g001                                          | 7139db4e8428 | rtl433      | 1                                 | 1               | Fineoffset-WH32/248                     |
| composed_ais_162m_2048k_outside, composed_vdl2_136800k_2048k_outside | (golden's)   |             | not run (channelizer only)        | 0               |                                         |
| sdrangel_adsb                                                        | bded99b1a3d6 | readsb      | not run (`large`, not downloaded) | 1 (placeholder) |                                         |

Notes:

- **Strays** (excluded from payloads): composed_pocsag `1690848/3` and sigid_pocsag `1860544/3`. Both are multimon-ng
  address-only lines (`messageType: unknown`, empty message) that match no sidecar page. The composed one falls
  between pages 1 and 2, so it is not a 0x7f pad decode. composed_ais_162m_2400k has 3 keys that 2048k lacks
  (003669761/4, 993672078/21, 993672721/21). The real sources have no ground truth, so payloads use only keys
  that both rates decode.
- **sigid_pocsag** decoded 0 until `decoder_options.offsetHz: -11000` was set. The 128 kHz file has nothing at DC.
  Its paging carrier sits near -11 kHz, and an offline FM demod plus multimon-ng decodes the same pages there.
- **rtl433_olympia_9571_2048k** decoded 0 on the raw path, and `rtl_433 -r cu8:<file> -s 2048000` alone also
  decodes 0. Neither the image's rtl_433 nor 25.12 has an Olympia-9571 decoder. It was moved to `candidates`.
- No record run was suspended. The band verdicts are logged only, because the harness sets `bandSuspension: false`
  (E1). APRS and ACARS read `out-of-band`.

## Runs

| date (CEST)      | host                                  | image                       | HEAD               | path                        | fixtures                       | result                                                                                                                                        | load (1-min, start → end) |
| ---------------- | ------------------------------------- | --------------------------- | ------------------ | --------------------------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| 2026-10-10 09:57 | dev Mac (darwin, wavekit-app stopped) | local-core                  | b6fad0b            | raw, RECORD                 | the 14 above incl. olympia     | 12 recorded; sigid_pocsag float-timeout harness bug (fixed 83b4d8f); olympia 0                                                                | 4.71 → 2.87               |
| 2026-10-10 11:01 | dev Mac                               | local-core                  | 83b4d8f + manifest | raw, RECORD                 | sigid_pocsag (offsetHz -11000) | count 6                                                                                                                                       | 3.85 → 3.08               |
| 2026-10-10 11:03 | dev Mac                               | local-core                  | 83b4d8f + manifest | raw, gate (T8)              | 13 non-negative above          | 13/13 PASS; vitest exit 1 from an unhandled `[vitest-worker]: Timeout calling "onTaskUpdate"` (spawnSync blocks the worker), not an assertion | 3.23 → 2.83               |
| 2026-10-10 (T27) | dev Mac                               | local-core and chan-46fbe76 | 46fbe76            | voice A/B default mode (E5) | `scripts/dsd-fme-voice-ab.mjs` | PASS on both, identical: muted 0.7 %, AMBE errors 6, link control 32, dmrSync 34, terminators 1                                               | 7.9 / 8.2                 |

T8 step 3 (dev Mac): `vitest run tests/unit/fixtures` 157/157, `pnpm run typecheck` exit 0,
`pnpm run lint` 0 errors (59 pre-existing warnings).
