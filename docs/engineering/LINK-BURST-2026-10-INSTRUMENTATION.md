# Link-burst instrumentation (October 2026)

Requirement 2.3: live observation on 2026-10-23, 01:25–02:25 UTC, at commit
`0670a211`. The receiver used Ethernet; the core host used Wi-Fi. Samples crossed a
local bridge into the core container. The absorber was off throughout: 30 minutes
each at 2.048 and 2.4 Msps, with link-quality polls every 2 s and fanout counters
and attribution logs. This is instrumentation, not the two-hour-per-rate soak.

| Measurement                                     | 2.048 Msps                     | 2.4 Msps                       |
| ----------------------------------------------- | ------------------------------ | ------------------------------ |
| Phase UTC                                       | 01:25:03–01:55:05              | 01:55:05–02:25:06              |
| Polls                                           | 805                            | 802                            |
| Worst stall over phase                          | 1965 ms                        | 495 ms                         |
| Maximum gap p99 over rolling 10 min windows     | 136 ms                         | 108 ms                         |
| Final-window largest catch-up bucket            | ≤ 4 MiB, 1 burst               | ≤ 4 MiB, 4 bursts              |
| Most catch-up bursts                            | ≤ 512 KiB                      | ≤ 512 KiB                      |
| Maximum catch-up bytes per 10 min               | 128.4 MB                       | 153.3 MB                       |
| Burst seconds per 10 min at old 80 ms threshold | 600                            | 600                            |
| Live-demod cumulative counters                  | 3.62 MB, 57 chunks, 2 episodes | 4.44 MB, 76 chunks, 5 episodes |
| Interval loop p99 in steady state               | ≤ 32 ms; one startup spike     | ≤ 32 ms                        |

MB denotes decimal bytes; MiB denotes binary bytes. Rolling windows overlap and
must not be summed. Histogram counts below describe the final rolling 10 min,
whereas worst stalls cover the phase and fanout counters are cumulative endpoint snapshots.

## Distributions and drops

The final gap histograms have two normal cadence clusters. At 2.048 Msps,
35.5–44.4 ms contains 3888 arrivals, 86.7–108.4 ms contains 1182 and approximately
108–135 ms contains 442. There are 9 gaps above 169 ms, including 1 in the ≤ 517 ms bucket.
At 2.4 Msps, approximately 28–35.5 ms contains 4472 arrivals, 86.7–108.4 ms
contains 1269 and approximately 108–135 ms contains 387. There are 13 gaps above
169 ms, including 2 in the ≤ 517 ms bucket. Bucket labels are rounded geometric edges.
The ≤ 517 ms bucket spans approximately 414–517 ms; it does not imply a stall
above 516 ms. This distinction reconciles the histogram with the exact worst gap.

Catch-up histograms are concentrated at ≤ 512 KiB; their largest observed bucket
is ≤ 4 MiB (in the final window: 1 burst at 2.048 Msps, 4 at 2.4 Msps). These are bucket upper bounds,
not exact burst sizes. Four MiB is about 1.02 s of U8 IQ at 2.048 Msps.

The supplied summary describes four logged `consumer` intervals as live-demod-only
drops following 127–495 ms stalls, with interval loop delay
16–132 ms. Fanout episodes and logged attribution intervals count different things.
With the absorber off, these are the clumps the absorber is intended to
hold. The strict-subset rule calls them `consumer` even when a link stall triggers
the clump. This is related to open item I in the
[acceptance record](LINK-BURST-2026-10-ACCEPTANCE.md); the attribution rule is unchanged.

## Decisions

- **Keep the 2 s default and enable it for network IQ sources.** The worst stalls,
  1.965 s and 0.495 s, fit within two seconds. U8 IQ capacity is
  2 × sample rate × 2 bytes: 8,192,000 B and 9,600,000 B respectively. Catch-up
  bursts of at most the 4 MiB bucket fit too. Smooth delivery remains pass-through;
  loopback and recordings remain unbuffered by default.
- **Raise `LINK_GAP_MS` from 80 to 200 ms.** Normal delivery has a ~100 ms gap
  cluster and a maximum rolling p99 of 108–136 ms. At 80 ms almost every second
  counts as a burst second, and normal jitter can excuse decoder drops as link
  evidence: a fail-open risk. At 200 ms the threshold exceeds p99 with at least
  64 ms margin and remains below the observed 495–1965 ms stall cluster. This
  moves attribution in the fail-closed direction. Attribution also subtracts loop
  delay and requires recovery evidence. Acceptance verdicts are unaffected:
  overflow/upstream fixtures stall for 2500/4000 ms, while lossless fixtures have
  no drops (their shortest stall is 150 ms).
- **Keep `ABSORBER_LAGGARD_MS` at 500 ms.** The live observations provide no
  contrary evidence, and the fake-link consumer runs pass the two-part exclusion
  and drain criterion. Their measured exclusion maxima are 500.6–501.2 ms, within
  the chunk-and-loop allowance.

The [fake-link acceptance record](LINK-BURST-2026-10-ACCEPTANCE.md) retains the
remaining gaps: host/subset attribution, non-vacuous upstream-loss attribution,
repeated shedding, upper-chunk-rate pass-through budget and Pi-class measurements.
The live soak with absorption enabled remains outstanding (requirement 9.5).

## Ten-minute snapshots

The following snapshots near each ten-minute boundary summarize retained histograms.
Catch-up upper edges are bucket bounds. Chunk counts are grouped by bucket upper edge.

| Rate (Msps) | UTC      | Worst gap (ms) | Catch-up largest bucket (count) | Chunk buckets ≤ 8 KiB / 16–32 KiB / 64 KiB |
| ----------- | -------- | -------------- | ------------------------------- | ------------------------------------------ |
| 2.048       | 01:35:02 | 274.7          | ≤ 4 MiB (1)                     | 30193 / 81617 / 17455                      |
| 2.048       | 01:45:01 | 623.3          | ≤ 4 MiB (2)                     | 29837 / 79067 / 18098                      |
| 2.048       | 01:55:02 | 474.0          | ≤ 4 MiB (1)                     | 30486 / 83027 / 16926                      |
| 2.4         | 02:05:01 | 271.4          | ≤ 2 MiB (1)                     | 36189 / 97787 / 19667                      |
| 2.4         | 02:15:01 | 416.2          | ≤ 2 MiB (1)                     | 35952 / 99379 / 19275                      |
| 2.4         | 02:25:04 | 495.4          | ≤ 4 MiB (4)                     | 35515 / 97363 / 19995                      |

## Counter reconciliation

The supplied interpretation says only live-demod dropped and all other branches
were zero. The raw fanout endpoint snapshots do not support that literal claim:
channelizer counters are 684,240 B / 12 chunks at the first endpoint and
717,344 B / 15 chunks at the second. Scanner remains at zero. Live-demod counters
are 3,619,200 B / 57 chunks / 2 backpressure entries, then 4,436,536 B / 76 chunks /
5 entries. Thus the second-phase live-demod increment is 817,336 B / 19 chunks /
3 entries. A starting snapshot is unavailable, so the first endpoint is not a
proven first-phase delta. Channelizer total bytes written resets across the rate
change, so its counter lifetime needs clarification before deriving a phase delta.

The strict-subset `consumer` attribution remains consistent with the surviving
scanner; the observation should be read as live-demod-dominated loss, with the
summary's live-demod-only interpretation pending reconciliation. This discrepancy
does not alter the measured stall/p99 evidence for the constants, but prevents a
claim that all other branches were lossless.

## Histogram bucket counts

Each list is `bucket upper edge: count`; omitted buckets have zero count. Gap
edges are milliseconds rounded to three decimals; byte edges are exact. These
are six rolling snapshots near ten-minute boundaries, not disjoint totals.

### 2.048 Msps, 01:35:02 UTC

Gap: 1.000: 53807, 1.250: 16319, 1.562: 12908, 1.953: 10146, 2.441: 9017, 3.052: 7038, 3.815: 5166, 4.768: 3036, 5.960: 1536, 7.451: 973, 9.313: 802, 11.642: 544, 14.552: 397, 18.190: 278, 22.737: 180, 28.422: 210, 35.527: 411, 44.409: 3889, 55.511: 849, 69.389: 49, 86.736: 66, 108.420: 1197, 135.525: 424, 169.407: 18, 211.758: 2, 264.698: 2, 330.872: 1.

Catch-up: 1024: 45, 2048: 1, 16384: 6, 32768: 15, 65536: 465, 131072: 231, 262144: 332, 524288: 27, 1048576: 5, 4194304: 1.

Chunk size: 64: 4, 128: 8, 512: 4, 1024: 39, 2048: 1053, 4096: 19193, 8192: 9892, 16384: 40004, 32768: 41613, 65536: 17455.

### 2.048 Msps, 01:45:01 UTC

Gap: 1.000: 53503, 1.250: 16219, 1.562: 12342, 1.953: 9826, 2.441: 8909, 3.052: 6961, 3.815: 4959, 4.768: 2844, 5.960: 1514, 7.451: 873, 9.313: 629, 11.642: 473, 14.552: 367, 18.190: 247, 22.737: 205, 28.422: 173, 35.527: 384, 44.409: 3673, 55.511: 1144, 69.389: 46, 86.736: 61, 108.420: 1183, 135.525: 436, 169.407: 19, 211.758: 2, 264.698: 4, 330.872: 4, 516.988: 1, 646.235: 1.

Catch-up: 1024: 42, 2048: 1, 8192: 3, 16384: 1, 32768: 7, 65536: 497, 131072: 203, 262144: 335, 524288: 25, 1048576: 4, 2097152: 2, 4194304: 2.

Chunk size: 64: 21, 128: 7, 512: 12, 1024: 35, 2048: 1061, 4096: 19054, 8192: 9647, 16384: 38291, 32768: 40776, 65536: 18098.

### 2.048 Msps, 01:55:02 UTC

Gap: 1.000: 55093, 1.250: 17223, 1.562: 12874, 1.953: 10027, 2.441: 8970, 3.052: 7123, 3.815: 5050, 4.768: 2868, 5.960: 1426, 7.451: 838, 9.313: 617, 11.642: 451, 14.552: 332, 18.190: 220, 22.737: 143, 28.422: 154, 35.527: 394, 44.409: 3888, 55.511: 999, 69.389: 43, 86.736: 45, 108.420: 1182, 135.525: 442, 169.407: 28, 211.758: 5, 264.698: 3, 516.988: 1.

Catch-up: 1024: 38, 2048: 1, 16384: 3, 32768: 19, 65536: 475, 131072: 214, 262144: 336, 524288: 31, 1048576: 6, 4194304: 1.

Chunk size: 64: 27, 128: 8, 256: 2, 512: 11, 1024: 35, 2048: 1041, 4096: 19377, 8192: 9985, 16384: 40669, 32768: 42358, 65536: 16926.

### 2.4 Msps, 02:05:01 UTC

Gap: 1.000: 66102, 1.250: 20018, 1.562: 15054, 1.953: 11743, 2.441: 10634, 3.052: 8428, 3.815: 5864, 4.768: 3396, 5.960: 1639, 7.451: 917, 9.313: 677, 11.642: 442, 14.552: 409, 18.190: 348, 22.737: 325, 28.422: 539, 35.527: 4679, 44.409: 638, 55.511: 77, 69.389: 8, 86.736: 57, 108.420: 1296, 135.525: 341, 169.407: 9, 211.758: 2, 330.872: 1.

Catch-up: 1024: 168, 2048: 2, 4096: 5, 8192: 6, 16384: 11, 32768: 20, 65536: 81, 131072: 341, 262144: 443, 524288: 42, 1048576: 4, 2097152: 1.

Chunk size: 64: 21, 128: 5, 256: 1, 512: 8, 1024: 26, 2048: 1247, 4096: 23189, 8192: 11692, 16384: 48310, 32768: 49477, 65536: 19667.

### 2.4 Msps, 02:15:01 UTC

Gap: 1.000: 65584, 1.250: 20032, 1.562: 15694, 1.953: 11877, 2.441: 11085, 3.052: 8501, 3.815: 5989, 4.768: 3328, 5.960: 1768, 7.451: 940, 9.313: 689, 11.642: 470, 14.552: 383, 18.190: 316, 22.737: 339, 28.422: 521, 35.527: 4651, 44.409: 665, 55.511: 65, 69.389: 10, 86.736: 66, 108.420: 1338, 135.525: 287, 169.407: 5, 264.698: 1, 413.590: 1, 516.988: 1.

Catch-up: 1024: 104, 2048: 3, 4096: 4, 8192: 16, 16384: 32, 32768: 82, 65536: 105, 131072: 226, 262144: 501, 524288: 43, 1048576: 8, 2097152: 1.

Chunk size: 64: 2, 128: 9, 256: 2, 512: 9, 1024: 24, 2048: 1173, 4096: 23068, 8192: 11665, 16384: 48869, 32768: 50510, 65536: 19275.

### 2.4 Msps, 02:25:04 UTC

Gap: 1.000: 64975, 1.250: 19866, 1.562: 15089, 1.953: 11945, 2.441: 10773, 3.052: 8495, 3.815: 6038, 4.768: 3460, 5.960: 1689, 7.451: 918, 9.313: 611, 11.642: 447, 14.552: 390, 18.190: 331, 22.737: 331, 28.422: 509, 35.527: 4472, 44.409: 694, 55.511: 75, 69.389: 16, 86.736: 65, 108.420: 1269, 135.525: 387, 169.407: 15, 211.758: 2, 264.698: 8, 413.590: 1, 516.988: 2.

Catch-up: 1024: 172, 2048: 2, 4096: 3, 8192: 9, 16384: 14, 32768: 28, 65536: 92, 131072: 319, 262144: 436, 524288: 43, 1048576: 4, 2097152: 2, 4194304: 4.

Chunk size: 64: 21, 128: 11, 512: 14, 1024: 43, 2048: 1167, 4096: 22797, 8192: 11462, 16384: 47530, 32768: 49833, 65536: 19995.
