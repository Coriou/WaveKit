# Decoder band defaults and operator override

Status: implementation-ready short design, 2026-10-09. Extends the band-aware
suspension of roadmap item 8 (`src/decoders/band-resolver.ts`) and fits the
transition table of the
[rate model addendum §4.3](2026-10-08-rate-model-instances-and-suspension.md).
Line numbers cite the tree at `4c99d6d`. Core only; no Pi placement is assumed:
a dongle plugged straight into the computer is the reference setup.

Goal: band suspension works out of the box (every decoder that can have a sane
default has one), the operator can correct any band per decoder in YAML or over
the API (the API change survives a restart), and a decoder the operator started
by hand runs wherever the source is tuned.

## 1. Start mode and pin

`DecoderState` (`manager.ts:87-125`) gains `startMode: "auto" | "operator"`,
initial `"auto"`.

| Path | Effect on `startMode` |
|---|---|
| `startAll()` (`manager.ts:460-475`, called from `src/index.ts:715`) | calls `startDecoder(id, { startMode: "auto" })` |
| REST `POST /api/decoders/:id/start` | the only path that sets `"operator"` (see §1.1) |
| `stopDecoder` (also disable, remove) | resets to `"auto"`: stop clears the pin |
| `restartDecoder` (REST restart, caps-change restart at `manager.ts:1224`) | reads the mode before its internal `stopDecoder`, passes it back as `startDecoder(id, { startMode: saved })` |
| crash restart (`restartTimer`, `manager.ts:870`) | unchanged; it calls `decoder.start()` directly, mode untouched |
| core restart | modes are not persisted; `startAll` brings every enabled decoder back as `"auto"` |

`startDecoder(id, intent?: { startMode: DecoderStartMode })` sets
`state.startMode` from `intent` before its eligibility check; an omitted intent
keeps the current mode. Setting the mode inside the method (not unconditionally
to `"operator"`) is what keeps internal restarts from pinning.

The pin overrides **only** the band check. In `assessEligibility`
(`manager.ts:1624-1637`):

```ts
const bandSuspends =
	this.config.bandSuspension &&
	resolved.bandSuspension && // per-decoder opt-out, §3
	state.startMode !== "operator"
const blockedBy =
	rate.verdict === "unusable"
		? (rate.reasonCode ?? "unsupported-sample-rate")
		: bandSuspends && band.verdict === "out-of-band"
			? "frequency-out-of-band"
			: null
```

Rate suspension still applies to a pinned decoder: an `unusable` rate means
nothing can decode. `bandAssessment` is computed and reported for pinned
decoders exactly as for auto ones.

### 1.1 REST start body

`POST /api/decoders/:id/start` accepts an optional body `{ pin?: boolean }`
(Zod-validated in the handler, `pin` defaults to `true`; an absent body is
today's request and behaves as `pin: true`).

| Decoder state | No body | `{ pin: true }` | `{ pin: false }` |
|---|---|---|---|
| stopped | start as `"operator"` | same | start as `"auto"` (may band-suspend at once) |
| band-suspended | pin + resume: **"run anyway"** (replaces today's 200 no-op) | same | 200 no-op, stays `"auto"` |
| rate-suspended | 200 no-op, pin recorded (holds when the rate recovers) | same | 200 no-op, mode `"auto"` |
| running | 409 `DECODER_ALREADY_RUNNING` (today) | 200, mode → `"operator"` | 200, mode → `"auto"`; band re-evaluated, may suspend |

On a running decoder a body is an explicit mode change, so it returns 200; a
bare start keeps today's 409. Running mode changes go through
`DecoderManager.setStartMode(id, mode)`, which records the mode and re-evaluates
as in §5.4.

Chosen over a separate unpin route because it also covers "start in auto
mode" for a stopped decoder in one call; start-then-unpin would briefly pin and
spawn a pipeline that is out of band. There is no new pin endpoint. The
persistent equivalent of a pin is a band override with `bandSuspension: false`
(§3).

### 1.2 Transition table additions (rate addendum §4.3)

| Current | Event | Plan | Action |
|---|---|---|---|
| idle / band-suspended | REST start, pin | rate usable/unknown | `startMode = "operator"`; band ignored; existing spawn / `resume` path |
| rate-suspended | REST start, pin | rate unusable | `startMode = "operator"`; 200 no-op, stay suspended |
| suspended (rate), operator | caps change | rate usable, band out | `resume` (pin holds) |
| running, operator | caps change | rate usable, band out | stay running; `bandPlan` out-of-band; publish |
| running, operator | caps change | rate unusable | `suspend` with the rate reason; mode kept |
| running | REST start with `pin` body | — | `setStartMode`; re-evaluate (§5.4) |
| any | band override PUT/DELETE | — | recompute `bandPlan`, publish, re-evaluate (§5.4) |
| any | stop / disable / remove | — | as today; `startMode = "auto"` |

## 2. Band shape: ranges

Built-in defaults are RF ranges, not point targets: audio-demod decoders
(window ≈ ±19 kHz, `audio-demod-decoder.ts`) and rtl_433 decode whatever sits at
the capture centre.

`DecoderBandRequirements` (`band-resolver.ts:25-35`) becomes:

```ts
export interface DecoderBandRange {
	minHz: number
	maxHz: number // minHz <= maxHz
}

export interface DecoderBandRequirements {
	targetsHz?: number[]
	rangesHz?: DecoderBandRange[]
	basis: DecoderBandBasis
	followCenter?: true // applies to targetsHz only, unchanged
	region?: DecoderBandRegion // set when a region-dependent default was used
	overrideSource?: "config" | "api" // set when basis is "override"
}
```

`assessDecoderBand` rule, with `h = windowHalfWidthHz` computed as today
(`min(captureRate, frontendRate) × 0.8 / 2`) and `c` the capture centre:

- a **target** `t` fits when `|t − c| ≤ h` (unchanged); `followCenter` targets
  keep the existing min..max span rule (unchanged);
- a **range** `r` fits when `r.minHz − h ≤ c ≤ r.maxHz + h`, i.e. the distance
  from `c` to the interval `[minHz, maxHz]` is at most `h`. A degenerate range
  `{ minHz: t, maxHz: t }` is exactly target `t`;
- in band when any target or any range fits. With neither a valid target nor a
  valid range the verdict is `unknown` / `no-target-frequency`, as today.
  Missing centre or rate stays `unknown` / `source-center-unknown`.

The assessment echoes `rangesHz`, `region` and `overrideSource` beside the
existing `targetsHz` and `basis`.

**Channelizer compatibility.** Ranges are absolute RF requirements; nothing
in the table encodes "the centre must equal X". A future channelized instance
replaces `h` with the capture's usable half-span (`fs × 0.8 / 2`, addendum §6)
and admits a channel at any frequency `f` inside a range when
`|f − c| + bandwidthHz/2 + transitionHz ≤ fs × usableFraction / 2`. The default
table and overrides need no change for that.

## 3. Precedence and config override

### 3.1 Decoder declarations

`Decoder.getBandRequirements?()` (`types.ts:429`) is replaced by
`getBandDeclaration?(): DecoderBandDeclaration`, which only states what the
decoder itself knows:

```ts
export interface DecoderBandDeclaration {
	/** Reads its own SDR, not the shared source (readsb rtlTcpHost): always unknown. */
	ownSource?: true
	/** Picks its own channels (AIS-catcher `-c` in extraArgs): no built-in default applies. */
	ownTuning?: true
	/** From frequencies / options.frequency(ies), exactly as today, basis "configured". */
	configured?: DecoderBandRequirements
	/** Protocol constant or the decoder's own option default. */
	intrinsic?: DecoderBandRequirements
}
```

| Decoder | Declaration |
|---|---|
| `AudioDemodDecoder`, `IqDecimateDecoder` bases (acarsdec, direwolf, dsd-fme, multimon-ng, rtl433) | `configured` from `configuredBandRequirements` |
| readsb | `ownSource` when `rtlTcpHost`; else `intrinsic` 1090 MHz, basis `protocol` |
| ais-catcher | `configured`; `ownTuning` when `-c` in extraArgs; `intrinsic` AIS channels, basis `protocol` |
| dumpvdl2 | unchanged split: followCenter → `configured` only when configured; else `configured` or `intrinsic` default list, basis `decoder-default` |
| lora-meshtastic | `configured` as today; followCenter without top-level `frequencies` → `intrinsic` `{ rangesHz: [LORA_REGION_RANGES_HZ[options.region]], basis: "decoder-default" }` |

So a followCenter LoRa no longer needs top-level `frequencies`; its band comes
from its own Meshtastic `region` option, not the global region.

### 3.2 One resolver

`resolveBandRequirements(input)` in `src/decoders/band-defaults.ts` is pure and
has one call site: `assessBand` (`manager.ts:1597-1621`), which passes the
decoder's declaration, `config`, the effective global region (§4), the API
override from the store (§5) and the table. It returns
`{ requirements?: DecoderBandRequirements; bandSuspension: boolean }`.
First match wins:

1. `ownSource` → no requirements (unknown).
2. API override band (`rangesHz` / `targetsHz`) → basis `"override"`, `overrideSource: "api"`.
3. Config override band (`decoders[].band`) → basis `"override"`, `overrideSource: "config"`.
4. `configured` (top-level `frequencies`, `options.frequency(ies)`) → basis `"configured"`, unchanged.
5. `ownTuning` → no requirements (unknown), as today.
6. Built-in table entry for `config.type` and the decoder's region → basis `"region-default"`.
7. `intrinsic` → `"protocol"` / `"decoder-default"`, as today.

**Override layers merge field-wise**, API over config: the band (`rangesHz` and
`targetsHz` as one unit; an API override with either list replaces both config
lists), `region` and `bandSuspension` each take the API value when set, else the
config value. `bandSuspension` resolves to `true` when neither sets it.

**"configured" vs the override.** Top-level `frequencies` and
`options.frequency(ies)` stay what the process is told to decode and keep basis
`"configured"`; `targetFrequenciesHz` in status is unchanged. A `band` override
only changes band admission, never the process arguments, and outranks
`configured` because it is the more specific statement about where the decoder
is useful. Override targets are point targets; to declare a follow span, use
`rangesHz`.

ADS-B, AIS and VDL2 get no table entry: their existing `protocol` /
`decoder-default` declarations already apply in every region and keep their
current basis, so the CLI sees no change for them.

### 3.3 Config schema (`src/config.ts`)

```ts
export const BAND_REGIONS = ["EU", "US", "CA", "AU", "NZ", "JP", "CN"] as const
const RegionSchema = z.preprocess(
	v => (typeof v === "string" ? v.toUpperCase() : v),
	z.enum(BAND_REGIONS),
)
const HzSchema = z.number().finite().positive()
const BandRangeSchema = z
	.object({ minHz: HzSchema, maxHz: HzSchema })
	.strict()
	.refine(r => r.minHz <= r.maxHz, "minHz must not exceed maxHz")
export const DecoderBandOverrideSchema = z
	.object({
		rangesHz: z.array(BandRangeSchema).min(1).max(32).optional(),
		targetsHz: z.array(HzSchema).min(1).max(64).optional(),
		region: RegionSchema.optional(),
		bandSuspension: z.boolean().optional(),
	})
	.strict()
	.refine(o => Object.keys(o).length > 0, "empty band override; omit it or DELETE")
```

- `DecoderConfigSchema` (`config.ts:87-105`) gains `band: DecoderBandOverrideSchema.optional()`.
- `ConfigSchema` (`config.ts:275-290`) gains `region: RegionSchema.optional()` and
  `stateDir: z.string().min(1).default("data")` (relative paths resolve against
  the process working directory).
- `LEGACY_ENV_MAPPINGS` (`config.ts:341-347`) gains `WAVEKIT_REGION → ["region"]`
  and `WAVEKIT_STATE_DIR → ["stateDir"]` (single-underscore names are not parsed
  otherwise). Per-decoder scalars use the existing nested form, e.g.
  `WAVEKIT_DECODERS__2__BAND__BAND_SUSPENSION=false`,
  `WAVEKIT_DECODERS__2__BAND__REGION=US`; list entries follow the existing rule
  (env may only override an index the YAML already defines). No new env syntax.
- An unknown explicit region code is a config validation error at startup, like
  any other invalid key. Only the guess (§4) is soft.

## 4. Region

`src/decoders/band-region.ts` exports the pure
`resolveBandRegion(input): DecoderBandRegion`:

```ts
interface BandRegionInput {
	configured?: BandRegion // config.region, which WAVEKIT_REGION feeds
	env: Readonly<Record<string, string | undefined>>
	intlTimeZone?: string // Intl.DateTimeFormat().resolvedOptions().timeZone
	intlLocale?: string // Intl.DateTimeFormat().resolvedOptions().locale
}
```

Guess order, first usable signal wins:

1. `configured` → source `"configured"`.
2. `env.TZ` → `"guessed:tz"`.
3. `intlTimeZone` → `"guessed:intl-timezone"`.
4. `env.LC_ALL`, then `env.LC_CTYPE`, then `env.LANG` (POSIX order) → `"guessed:locale-env"`.
5. `intlLocale` → `"guessed:intl-locale"`.
6. `EU` → `"default"`.

Time zones come before locales: a locale is commonly `en_US` wherever the
machine is, while a time zone tracks location (on a Mac with no `TZ`, Intl
reads the system zone). This refines the "TZ, then LANG/LC_*, then Intl" order
of the decision pack by splitting Intl into its zone and locale halves.

Unusable signals are skipped, never errors: `UTC`, `GMT`, `Etc/*`, `C`,
`POSIX`, `C.UTF-8`, empty, unmapped. Mappings:

- zones: `Europe/*`, `Africa/*` → EU; Canadian zones (`America/Toronto`,
  `Vancouver`, `Edmonton`, `Winnipeg`, `Halifax`, `St_Johns`, `Regina`, `Moncton`,
  `Whitehorse`, `Yellowknife`, `Iqaluit`, `Canada/*`) → CA; other `America/*`,
  `US/*`, `Pacific/Honolulu` → US; `Australia/*` → AU; `Pacific/Auckland`,
  `Pacific/Chatham`, `NZ` → NZ; `Asia/Tokyo`, `Japan` → JP; `Asia/Shanghai`,
  `Asia/Urumqi`, `PRC` → CN;
- locales: the territory of `ll_TT` / `ll-TT` (ISO 3166): US, CA, AU, NZ, JP, CN
  map to themselves; CEPT member territories (EU states, GB, CH, NO, IS, LI and
  the rest of the CEPT list, held as a literal set) → EU.

Region codes name band plans, not polities: `EU` is CEPT / IARU Region 1
(includes the UK, Switzerland, Norway; Africa via time zone).

`src/index.ts` resolves the region once before building the manager (passing
`process.env` and `Intl`), logs `info({ region, source }, "Band region")`, and
passes it in `DecoderManagerConfig`. A decoder `band.region` (config or API)
yields `{ code, source: "decoder" }` for that decoder only.

`DecoderBandRegion = { code: BandRegion; source: BandRegionSource }`,
`BandRegionSource = "configured" | "decoder" | "guessed:tz" | "guessed:intl-timezone" | "guessed:locale-env" | "guessed:intl-locale" | "default"`.
It is reported in `bandAssessment.region` whenever a region-dependent table row
produced the band, and always in `GET /api/decoders/:id/band`, so a wrong guess
is visible and fixable.

## 5. Built-in table, API override and persistence

### 5.1 Default table (`src/decoders/band-defaults.ts`, pure data)

```ts
type BandDefault = { targetsHz?: readonly number[]; rangesHz?: readonly DecoderBandRange[] }
type BandDefaultEntry =
	| { scope: "all"; band: BandDefault }
	| { scope: "region"; byRegion: Readonly<Record<BandRegion, BandDefault>> }
export const BAND_DEFAULTS: Readonly<Partial<Record<string, BandDefaultEntry>>>
export const LORA_REGION_RANGES_HZ: Readonly<Record<LoraRegion, DecoderBandRange>> // import type only
```

Values in MHz (stored in Hz):

| Type | Scope | Band |
|---|---|---|
| `acarsdec` | all | range 129.000–137.000 (VHF ACARS incl. EU 136.7–136.9) |
| `dsd-fme` | all | ranges 136.000–174.000, 380.000–512.000, 764.000–941.000 (VHF, UHF incl. US T-band, 700/800/900 land mobile) |
| `direwolf` | region | targets EU 144.800; US, CA 144.390; AU 145.175; NZ 144.575; JP, CN 144.640; every region adds 145.825 (ISS APRS) |
| `rtl433` | region | EU 433.050–434.790, 863.000–870.000; US, CA 314.000–316.000, 344.000–346.000, 433.050–434.790, 902.000–928.000; AU 433.050–434.790, 915.000–928.000; NZ 433.050–434.790, 864.000–868.000, 915.000–928.000; JP 314.000–316.000, 920.500–928.100; CN 314.000–316.000, 433.050–434.790 |
| `multimon-ng` | — | **no entry**: country-specific paging plus FLEX/EAS/DTMF modes make any default risky; stays unknown unless configured or overridden |

`LORA_REGION_RANGES_HZ` (Meshtastic firmware region table): US 902.0–928.0,
EU_433 433.0–434.0, EU_868 869.4–869.65, CN 470.0–510.0, JP 920.5–923.5,
ANZ 915.0–928.0, KR 920.0–923.0, TW 920.0–925.0, RU 868.7–869.2, IN 865.0–867.0,
NZ_865 864.0–868.0, TH 920.0–925.0, UA_433 433.0–434.7, UA_868 868.0–868.6,
MY_433 433.0–435.0, MY_919 919.0–924.0, SG_923 917.0–925.0. The
`Record<LoraRegion, …>` type makes a missing `LORA_REGIONS` member a compile
error.

Wide ranges are deliberate: an operator start or an override always wins, and
a wrong "in band" only keeps a decoder running.

### 5.2 API (`src/api/routes/decoder-band.ts`, registered beside `decoders.ts`)

`PATCH /api/decoders/:id` (501 `DECODER_CONFIG_UPDATE_UNSUPPORTED`) is untouched.

- `GET /api/decoders/:id/band` → `DecoderBandSettings`:
  ```ts
  interface DecoderBandSettings {
  	decoderId: string
  	override: DecoderBandOverride | null // API layer (persisted)
  	configOverride: DecoderBandOverride | null // decoders[].band
  	region: DecoderBandRegion // effective for this decoder
  	persisted: boolean // false while the API layer lives only in memory
  	bandAssessment: DecoderBandAssessment
  }
  ```
- `PUT /api/decoders/:id/band`, body `DecoderBandOverride` (Zod,
  `DecoderBandOverrideSchema`; replaces the whole API layer) → 200
  `DecoderBandSettings`.
- `DELETE /api/decoders/:id/band` → 200 `DecoderBandSettings` with
  `override: null`; idempotent.

Errors: 400 `INVALID_BAND_OVERRIDE` (Zod issues in `message`), 404
`DECODER_NOT_FOUND`, 409 `DECODER_BAND_NOT_APPLICABLE` for external-input
decoders (they own their device; the band check never applies). An override on
a readsb with `rtlTcpHost` is stored but resolves to unknown (rule 1). Fastify
response schemas list every field (Fastify drops unlisted ones).

### 5.3 Override store (`src/decoders/band-override-store.ts`)

File `<stateDir>/decoder-band-overrides.json`:

```json
{ "version": 1, "overrides": { "<decoderId>": { "rangesHz": [{ "minHz": 433050000, "maxHz": 434790000 }], "bandSuspension": false } } }
```

`BandOverrideStore`: `load(): Promise<void>`, `get(id)`,
`set(id, override): Promise<{ persisted: boolean }>`,
`delete(id): Promise<{ persisted: boolean }>`. Every write serializes the whole
in-memory map through a promise chain: `mkdir -p stateDir`, write
`<file>.<pid>.tmp`, `FileHandle.sync()`, `rename` over the file.

| Situation | Behaviour |
|---|---|
| file missing (`ENOENT`) | empty map; debug log |
| unreadable, invalid JSON, or fails the Zod schema | `warn`; empty map; keep running; the next write replaces the file |
| `version` other than 1 | `warn`; empty map; writes stay in memory (`persisted: false`) so a newer core's file is never clobbered |
| write fails (read-only mount, `EACCES`, `ENOSPC`) | `warn`; override applied in memory; `persisted: false` |
| entry for a decoder id not in config | kept in the file, ignored at runtime |

`src/index.ts` builds the store from `config.stateDir`, awaits `load()` before
`startAll()` (so the first eligibility check already sees persisted overrides)
and hands it to the `DecoderManager` constructor (`src/index.ts:306`). When no
store is passed (unit tests), the manager uses an in-memory store whose writes
report `persisted: false`.

### 5.4 Re-evaluation

After a PUT, DELETE or a running-decoder mode change, the manager
synchronously recomputes `state.bandPlan` with the source's current caps and
emits `decoder:status`, so the REST response and the event carry the new
assessment. If the decoder is wanted (`desiredRunning`) and its source has caps,
it then calls `enqueueSourceEvaluation(sourceId, { caps, adapt: false })`
(`manager.ts:1094`) so a suspend or resume runs in the serial caps worker
(rate addendum §4.4), never inline. The resulting transition publishes
`decoder:status` again ≈300 ms later (`CAPS_CHANGE_DEBOUNCE_MS`).

## 6. Contract additions (optional fields only)

Each field lands in all four places: `packages/api-types/src/decoders.ts`,
`src/decoders/types.ts`, the Fastify schemas (`startMode` in
`src/api/routes/decoder-status-schemas.ts`; the band fields in
`decoderBandAssessmentSchema`, which lives in
`src/api/routes/decoder-rate-schemas.ts:95`), and
`src/api/serializers/decoder-status.ts` (deep-copy `rangesHz` and `region` like
`targetsHz`).

- `DecoderStatus.startMode?: "auto" | "operator"`, sent while
  `desiredRunning` is true. `startMode` beats `pinned?: boolean`: it says who
  started the decoder, and "pinned" is just `startMode === "operator"`.
- `DecoderBandAssessment.rangesHz?: DecoderBandRange[]`,
  `region?: DecoderBandRegion`, `overrideSource?: "config" | "api"`.
- `DecoderBandBasis` widens to
  `"configured" | "protocol" | "decoder-default" | "region-default" | "override"`.
  **New union members break exhaustive switches**; the announcement says so.
- New exported types: `DecoderStartMode`, `DecoderBandRange`, `BandRegion`,
  `BandRegionSource`, `DecoderBandRegion`, `DecoderBandOverride`,
  `DecoderBandSettings`.
- New routes: `GET|PUT|DELETE /api/decoders/:id/band`; `POST /start` optional
  body `{ pin?: boolean }`.

## 7. Docs and deployment

- `compose.yaml`: add `./data:/app/data` and `WAVEKIT_STATE_DIR: /app/data` to
  the `app` (line 28 area) and `dev` (line 102 area) services; `config/` stays
  `:ro`. `.gitignore`: add `data/`.
- `config/default.yaml`: document `region`, `stateDir`, `decoders[].band` beside
  `bandSuspension` (~397-406).
- `docs/API.md` "Band check and band suspension" (~668) and the start route
  (~755): ranges rule, precedence, region, start body, the band routes.
- `docs/DOCKER-SETUP.md`: the state volume and the read-only fallback.

## 8. Correctness properties

Property tests use fast-check with `numRuns: 100` and the comment
`// Feature: decoder-band-defaults, Property N: <name>` plus
`// Validates: <section>`.

1. **Range admission.** For any finite positive range, centre and `h`, a range
   fits iff `dist(c, [min, max]) ≤ h`; `{ minHz: t, maxHz: t }` gives the same
   verdict as target `t`. (§2)
2. **Monotonicity.** Widening a range, adding a range or a target never turns
   `in-band` into `out-of-band`; a missing centre or rate is never
   `out-of-band`. (§2)
3. **Precedence.** For any combination of present layers, the resolved basis
   is the highest present layer of §3.2; removing any lower layer leaves the
   result unchanged; `ownSource` yields unknown whatever else is present;
   `ownTuning` suppresses only rules 6-7. (§3.2)
4. **Field-wise merge.** For any API and config overrides, each of band,
   `region`, `bandSuspension` equals the API value when defined, else the config
   value; an API list replaces both config lists. (§3.2)
5. **Region resolution is total.** For arbitrary strings in `TZ`, `LC_*`,
   `LANG` and Intl inputs, `resolveBandRegion` never throws, returns a member of
   `BAND_REGIONS` and a valid source, and returns `"configured"` whenever
   `configured` is set. (§4)
6. **Pin never band-suspends.** For any sequence of caps changes, an
   `"operator"` decoder is never suspended with `frequency-out-of-band`, while
   an unusable rate still suspends it; an `"auto"` decoder with the same inputs
   behaves as before this change. (§1)
7. **Store round-trip and robustness.** Any valid override map survives
   `set` → fresh `load` unchanged; any byte string as file content loads
   without throwing (empty map on invalid). (§5.3)

## 9. Tests

- `tests/unit/decoders/band-resolver.test.ts`: properties 1-2; existing target
  and followCenter cases unchanged.
- `tests/unit/decoders/band-defaults.test.ts` (new): properties 3-4; every
  table row is valid (`minHz ≤ maxHz`, positive); every `LORA_REGIONS` member has
  a range; `multimon-ng` has no entry.
- `tests/unit/decoders/band-region.test.ts` (new): property 5; examples
  `TZ=Europe/Paris` → EU, Docker `TZ=UTC`, `LANG=C` → EU `"default"`,
  `LANG=en_US.UTF-8` with `intlTimeZone=Europe/Berlin` → EU
  `"guessed:intl-timezone"`, `America/Toronto` → CA.
- `tests/unit/decoders/band-declarations.test.ts`: each built-in declaration
  per §3.1 (LoRa followCenter without `frequencies` → Meshtastic range).
- `tests/unit/decoders/manager-band-suspension.test.ts`: property 6; run anyway
  on a band-suspended decoder; `{ pin: false }` on a running pinned decoder
  suspends via the worker; restart keeps the mode; stop clears it; per-decoder
  `bandSuspension: false`.
- `tests/unit/decoders/manager-suspension.test.ts`: pinned decoder still
  rate-suspends and rate-suspended start stays a no-op.
- `tests/unit/decoders/band-override-store.test.ts` (new): property 7; atomic
  write (tmp then rename), `version: 2` file is not overwritten, unwritable
  directory → `persisted: false`.
- `tests/unit/api/decoder-band-contract.test.ts`: new assessment fields
  survive serialization and Fastify schemas; `startMode` in `decoder:status`;
  band routes 200/400/404/409; start body table of §1.1.
- `tests/unit/utils/config.test.ts`: `region`
  case-insensitive, unknown code rejected, `WAVEKIT_REGION`, `WAVEKIT_STATE_DIR`,
  `decoders[].band` validation; `tests/unit/decoders/manager-options.test.ts`
  for the region and store reaching the manager.

## 10. Known limits (out of scope)

- A suspended decoder keeps `health: "running"`; dashboards render `suspended`
  ahead of `health` (unchanged).
- The band check trusts `caps.centerFreq`, which goes stale when a retune
  bypasses the relay (e.g. SDR++ tuning the dongle directly).
- Pins are runtime intent: a core restart returns every decoder to `"auto"`.
  The durable form is `band.bandSuspension: false`.
- No built-in default for POCSAG / multimon-ng.

## 11. Decisions recorded

- `startMode` over `pinned` (§6); start body over an unpin route (§1.1).
- Decoders declare, one resolver resolves at one call site (§3.2): overrides and
  region stay manager concerns, and decoders never see persistence.
- Override layers merge field-wise; band lists are one unit (§3.2).
- Override outranks `configured` for admission only; process arguments are
  never changed by a band override (§3.2).
- ADS-B / AIS / VDL2 keep their basis; the table only adds what was missing
  (§3.2, §5.1).
- Time zone signals before locale signals in the region guess (§4).
- An unknown-version state file is read as empty and never overwritten (§5.3).

## 12. CLI-COORDINATION announcement (append to `docs/CLI-COORDINATION.md` when the branch is ready; not yet appended)

```markdown
### Core: proposed contract for decoder band defaults + operator override — pending review, NOT merged (2026-10-09)

Spec: `docs/superpowers/specs/2026-10-09-decoder-band-defaults-and-override.md`.
On a core branch; names may still change before merge. All additive:

- **Start mode** (`DecoderStatus`, REST + `decoder:status`): new
  `startMode?: "auto" | "operator"`, sent while `desiredRunning` is true.
  `"operator"` = started by hand via `POST /api/decoders/:id/start`; such a
  decoder is never band-suspended (a rate suspension still applies). Decoders
  brought up at boot are `"auto"`. Stop clears it; restart keeps it.
- **"Run anyway"**: `POST /api/decoders/:id/start` on a decoder suspended with
  `"frequency-out-of-band"` now pins and resumes it (was a 200 no-op). A
  rate-suspended decoder is still a 200 no-op. Optional body `{ pin?: boolean }`
  (default `true`): on a running decoder `{ pin: true }` pins it and
  `{ pin: false }` returns it to auto (may then band-suspend), both 200; a bare
  start on a running decoder is still 409.
- **Band assessment** (`bandAssessment`): new optional
  `rangesHz?: { minHz: number; maxHz: number }[]` (in band when the centre is
  within `windowHalfWidthHz` of any range), `region?: { code: "EU" | "US" | "CA" |
  "AU" | "NZ" | "JP" | "CN"; source: "configured" | "decoder" | "guessed:tz" |
  "guessed:intl-timezone" | "guessed:locale-env" | "guessed:intl-locale" |
  "default" }` (present when a regional default was used) and
  `overrideSource?: "config" | "api"`.
  **`basis` gains two members, `"region-default"` and `"override"`: an
  exhaustive switch on `DecoderBandBasis` needs both.**
  Built-in defaults now exist for acarsdec, dsd-fme, direwolf (per region),
  rtl433 (per region) and followCenter LoRa (from its Meshtastic region), so
  more decoders report a real verdict instead of `unknown`. multimon-ng stays
  `unknown` unless configured.
- **Band override routes**: `GET|PUT|DELETE /api/decoders/:id/band` →
  `DecoderBandSettings { decoderId; override; configOverride; region;
  persisted; bandAssessment }`. PUT body `{ rangesHz?; targetsHz?; region?;
  bandSuspension? }` (at least one key). Persisted by core across restarts.
  Errors: 400 `INVALID_BAND_OVERRIDE`, 404 `DECODER_NOT_FOUND`, 409
  `DECODER_BAND_NOT_APPLICABLE` (external-input decoders).
- CLI impact: for `suspension.reasonCode === "frequency-out-of-band"` show the
  reason from `bandAssessment` (targets/ranges, basis, region and its source)
  and a "Run anyway" action (`POST …/start`); for a running decoder with
  `startMode === "operator"` and `bandAssessment.verdict === "out-of-band"`
  show "running out of band (pinned)" and offer "Return to auto"
  (`POST …/start` with `{ "pin": false }`). Older cores omit all new fields.
```
