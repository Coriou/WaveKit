# LoRa/Meshtastic Decoder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Plan location note:** This plan lives under `docs/superpowers/plans/` per the global brainstorming protocol default. The project has no pre-existing `.kiro/plans/` directory (only `.kiro/specs/` and `.kiro/steering/`), so the default location was chosen. If the project later standardises on `.kiro/plans/`, move this file — its contents do not assume the location.

**Goal:** Add a `lora-meshtastic` pure-consumer decoder to WaveKit that decimates `cu8` IQ from a shared `iq` source via csdr, delegates LoRa demod + AES-CTR decryption + protobuf parsing to a small Python wrapper around gr-lora_sdr, and emits one structured `MeshtasticPacket` event per decoded Meshtastic packet on the `decoders` channel.

**Architecture:** The decoder is a structural twin of `Rtl433Decoder`. It extends `IqDecimateDecoder` (unchanged), so the existing csdr stage handles `cu8` → float → integer-decimate → `cu8` and pipes the result into `python3 /usr/local/bin/lora_meshtastic_decode.py`. The Python wrapper owns the full radio + crypto + protobuf layer; the TypeScript side owns config validation, csdr pipeline configuration, and JSONL boundary parsing. A new `lora-build` Dockerfile stage builds tapparelj/gr-lora_sdr against GNU Radio and the final stages add `python3-gnuradio`, `python3-protobuf`, `python3-cryptography` plus the wrapper + vendored `mesh_pb2.py`.

**Tech Stack:** TypeScript (strict, ESM, Pino, Zod, Vitest, fast-check), Python 3 (gnuradio.lora_sdr, cryptography, protobuf), csdr, Docker multi-stage builds.

---

## Spec → Task Coverage Map

| Spec requirement | Implementing tasks |
|---|---|
| Req 1 (YAML config) | Tasks 1-6, 13 |
| Req 2 (csdr + iq source) | Tasks 4, 5 |
| Req 3 (Python wrapper) | Tasks 7-9 |
| Req 4 (JSONL schema) | Tasks 3, 4, 10 |
| Req 5 (DecoderOutputType union) | Task 1 |
| Req 6 (Registration) | Task 6 |
| Req 7 (Health/lifecycle) | Inherited (verified by Task 10) |
| Req 8 (Tests + fixture) | Tasks 10-12, 15 |
| Req 9 (Docker delta) | Task 9 |
| Req 10 (Vendored protobuf) | Task 7 |
| Req 11 (Example config) | Task 13 |

---

## File Structure

**New files:**
- `src/decoders/builtin/lora-meshtastic.ts` — decoder class, options parser, JSON-boundary validator, factory, caps.
- `docker/scripts/lora_meshtastic_decode.py` — Python wrapper (flowgraph + decrypt + JSONL emit).
- `docker/scripts/meshtastic_proto/__init__.py` — empty marker so it's an importable package.
- `docker/scripts/meshtastic_proto/mesh_pb2.py` — compiled protobuf (vendored from upstream).
- `tests/unit/decoders/lora-meshtastic.test.ts` — eight property-based tests.
- `tests/integration/lora-meshtastic.test.ts` — fixture-replay integration test (skipped without gr-lora_sdr).
- `fixtures/lora/meshtastic-sample.cu8` — small IQ recording (< 5 MB).
- `fixtures/lora/meshtastic-sample.expected.jsonl` — expected events sidecar.
- `fixtures/lora/README.md` — provenance + regeneration command for the fixture.

**Modified files:**
- `src/decoders/types.ts` — add `"meshtastic"` to `DecoderOutputType`.
- `src/index.ts` — register `"lora-meshtastic"` (around current lines 377-388).
- `Dockerfile` — new `lora-build` stage; both `final` and `final-core` stages updated to apt-install python deps, copy artefacts + wrapper + protobuf, extend verification.
- `config/default.yaml` — commented-out example block under "EXAMPLE: Multi-Source Setup".
- `docs/DECODER-GUIDE.md` — new row in the Output Types table.

**Not modified (anti-pattern guards):**
- `src/decoders/iq-decimate-decoder.ts` — base class is unchanged.
- `src/config.ts` (top-level `DecoderConfigSchema`) — Meshtastic fields live in the per-decoder options bag only.

---

## TypeScript-side wiring

### Task 1: Extend `DecoderOutputType` union with `"meshtastic"`

**Files:**
- Modify: `src/decoders/types.ts` (the `DecoderOutputType` union)
- Test: covered indirectly by Task 10 (compile-time + property tests)

- [ ] **Step 1: Write the failing test** — append to `tests/unit/decoders/lora-meshtastic.test.ts` later (Task 10). For this task we only do the type change; the type compiler is the test.

- [ ] **Step 2: Edit the union.** Open `src/decoders/types.ts`. Locate the `DecoderOutputType` union (currently around lines 186-200). Add `"meshtastic"` as a member. Do NOT add `"lora"` (out of scope for v1, see spec §Out of Scope and design §13).

Edit the union to look like:

```ts
export type DecoderOutputType =
	| "sync"
	| "decode"
	| "call"
	| "call_start" // New: Call started
	| "call_end" // New: Call ended with duration
	| "message"
	| "signal"
	| "error"
	| "stats"
	| "aircraft" // ADS-B
	| "acars" // ACARS messages
	| "vdl2" // VDL2 messages
	| "ship" // AIS
	| "aprs" // APRS packets
	| "meshtastic" // Meshtastic LoRa packets
```

- [ ] **Step 3: Verify the change typechecks.**

Run: `pnpm run typecheck`
Expected: exits 0 (no type errors anywhere).

- [ ] **Step 4: Commit.**

```bash
git add src/decoders/types.ts
git commit -m "feat(decoders): add meshtastic to DecoderOutputType union"
```

_Requirements: 5.1, 5.2, 5.3._

---

### Task 2: Create the decoder file skeleton with `LoraMeshtasticOptions`, enums, preset table, and `parseLoraMeshtasticOptions()`

**Files:**
- Create: `src/decoders/builtin/lora-meshtastic.ts`
- Test: covered by Task 10 (Property 1, 5, 6, 7, 8 will assert behaviour)

This task delivers the entire options parser + preset/region tables + the effective-rate math, mirroring `parseAisCatcherOptions` in style. It does NOT yet add the decoder class (Task 4) or the JSON parser (Task 3) — those go in the same file but as later edits.

- [ ] **Step 1: Create the file with all imports, enums, the canonical preset table, the options interface, and the Zod schema.**

```ts
/**
 * LoRa/Meshtastic Decoder.
 *
 * Pure-consumer decoder that extends IqDecimateDecoder. Decimates cu8 IQ to a
 * LoRa-appropriate rate via csdr, then pipes into a Python wrapper around
 * gr-lora_sdr (tapparelj). The wrapper demodulates, AES-CTR-decrypts, and
 * protobuf-parses Meshtastic packets, emitting one JSON line per packet on
 * stdout. The TypeScript side validates the JSON shape and remaps to camelCase.
 *
 * Reference: docs in .kiro/specs/lora-decoder/{requirements,design}.md.
 */

import { z } from "zod"
import {
	IqDecimateDecoder,
	type IqDecimationConfig,
} from "../iq-decimate-decoder.js"
import type { DecoderCaps, DecoderConfig, DecoderOutput } from "../types.js"
import { ConfigValidationError } from "../../utils/errors.js"
import { createComponentLogger, type Logger } from "../../utils/logger.js"

/** Meshtastic regional regulatory regions. */
export const LORA_REGIONS = [
	"US",
	"EU_868",
	"EU_433",
	"CN",
	"JP",
	"ANZ",
	"KR",
	"TW",
	"RU",
	"IN",
	"NZ_865",
	"TH",
	"UA_433",
	"UA_868",
	"MY_433",
	"MY_919",
	"SG_923",
] as const

export type LoraRegion = (typeof LORA_REGIONS)[number]

/** Meshtastic modem presets. */
export const LORA_PRESETS = [
	"LongFast",
	"LongModerate",
	"LongSlow",
	"MediumFast",
	"MediumSlow",
	"ShortFast",
	"ShortSlow",
	"VeryLongSlow",
] as const

export type LoraPreset = (typeof LORA_PRESETS)[number]

/**
 * Canonical preset → (bandwidth Hz, spreading factor, coding rate 5..8) table.
 * Matches the Meshtastic firmware preset definitions. See design.md §4.
 *
 * Property 8 (preset → params mapping fixed-point) tests this table directly.
 */
export const PRESET_TABLE: Readonly<
	Record<LoraPreset, { bw: number; sf: number; cr: number }>
> = Object.freeze({
	ShortFast: { bw: 250_000, sf: 7, cr: 5 },
	ShortSlow: { bw: 250_000, sf: 8, cr: 5 },
	MediumFast: { bw: 250_000, sf: 9, cr: 5 },
	MediumSlow: { bw: 250_000, sf: 10, cr: 5 },
	LongFast: { bw: 250_000, sf: 11, cr: 5 },
	LongModerate: { bw: 125_000, sf: 11, cr: 8 },
	LongSlow: { bw: 125_000, sf: 12, cr: 8 },
	VeryLongSlow: { bw: 62_500, sf: 12, cr: 8 },
})

/** Default IQ input rate (Hz) when the operator does not override. */
const DEFAULT_INPUT_SAMPLE_RATE = 2_048_000
/** Default oversampling multiplier for the nominal csdr target rate. */
const DEFAULT_OVERSAMPLING = 8
/** Allowed samples-per-symbol range (effective rate / bandwidth). */
const MIN_SPS = 2
const MAX_SPS = 32

/** Base64 regex matching standard padded base64 (RFC 4648 §4). */
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/

/**
 * Resolved decoder options after preset + override resolution.
 * `bw`, `sf`, `cr` are post-resolution (preset + overrides applied).
 */
export interface LoraMeshtasticOptions {
	/** Region (used by the wrapper for event metadata + future use). */
	region: LoraRegion
	/** Modem preset (drives default bw/sf/cr). */
	preset: LoraPreset
	/** Tuned frequency in Hz (for event metadata only — not used by csdr). */
	frequency: number
	/** Base64 channel pre-shared key. "AQ==" means default channel. */
	channelKey: string
	/** Resolved bandwidth Hz (preset value or `bandwidth` override). */
	bw: number
	/** Resolved spreading factor (preset value or `spreadingFactor` override). */
	sf: number
	/** Resolved coding rate 5..8 (preset value or `codingRate` override). */
	cr: number
	/** IQ input rate from the source. */
	inputSampleRate: number
	/** Oversampling multiplier (effective rate target = bw * oversampling). */
	oversampling: number
	/** Effective post-decimation output rate (Hz). Passed to wrapper as --samp-rate. */
	effectiveTargetRate: number
}

/** Raw options bag shape (pre-resolution). */
const RawOptionsSchema = z
	.object({
		region: z.enum(LORA_REGIONS),
		preset: z.enum(LORA_PRESETS),
		frequency: z.number().int().positive(),
		channelKey: z
			.string()
			.min(1)
			.refine(
				s => BASE64_RE.test(s) && s.length % 4 === 0,
				"channelKey must be a padded base64 string",
			),
		bandwidth: z.number().int().positive().optional(),
		spreadingFactor: z.number().int().min(6).max(12).optional(),
		codingRate: z.number().int().min(5).max(8).optional(),
		inputSampleRate: z.number().int().positive().optional(),
		oversampling: z.number().int().positive().optional(),
	})
	.strict()

/**
 * Parses + validates the per-decoder options bag, applies preset → (bw,sf,cr),
 * applies raw overrides per field, and computes the effective post-csdr rate.
 *
 * Throws ConfigValidationError on any validation failure (missing field, wrong
 * type, unknown enum value, out-of-range effective sample-per-symbol).
 */
export function parseLoraMeshtasticOptions(
	options: Record<string, unknown>,
): LoraMeshtasticOptions {
	const result = RawOptionsSchema.safeParse(options)
	if (!result.success) {
		throw new ConfigValidationError(result.error)
	}
	const raw = result.data
	const presetParams = PRESET_TABLE[raw.preset]

	const bw = raw.bandwidth ?? presetParams.bw
	const sf = raw.spreadingFactor ?? presetParams.sf
	const cr = raw.codingRate ?? presetParams.cr

	const inputSampleRate = raw.inputSampleRate ?? DEFAULT_INPUT_SAMPLE_RATE
	const oversampling = raw.oversampling ?? DEFAULT_OVERSAMPLING

	const nominalTarget = bw * oversampling
	const decimation = Math.max(
		1,
		Math.round(inputSampleRate / nominalTarget),
	)
	const effectiveTargetRate = inputSampleRate / decimation

	// Reject effective rates that would put samples-per-symbol out of the
	// range gr-lora_sdr's frame_sync can resync (design §3, Property 5).
	const sps = effectiveTargetRate / bw
	if (sps < MIN_SPS || sps > MAX_SPS) {
		const customIssue = new z.ZodError([
			{
				code: "custom",
				path: ["inputSampleRate"],
				message: `Resulting samples-per-symbol ${sps.toFixed(2)} is outside the supported range [${MIN_SPS}, ${MAX_SPS}]. Adjust inputSampleRate, bandwidth, or oversampling.`,
			},
		])
		throw new ConfigValidationError(customIssue)
	}

	return {
		region: raw.region,
		preset: raw.preset,
		frequency: raw.frequency,
		channelKey: raw.channelKey,
		bw,
		sf,
		cr,
		inputSampleRate,
		oversampling,
		effectiveTargetRate,
	}
}
```

- [ ] **Step 2: Verify the file compiles in isolation.**

Run: `pnpm run typecheck`
Expected: exits 0. No `any`, no floating promises, no missing `.js` extensions.

- [ ] **Step 3: Commit.**

```bash
git add src/decoders/builtin/lora-meshtastic.ts
git commit -m "feat(decoders): add lora-meshtastic option parser and preset table"
```

_Requirements: 1.2, 1.3, 1.4, 1.5, 1.6, 2.3, 4.6._

---

### Task 3: Add `MeshtasticPacket` interface and `parseMeshtasticPacket()`

**Files:**
- Modify: `src/decoders/builtin/lora-meshtastic.ts` (append after the option parser)
- Test: covered by Task 10 (Properties 3, 4)

This task adds the JSON-boundary validator. Mirrors `parseJsonShip` in `ais-catcher.ts` and the `ShipData` interface style. Never throws.

- [ ] **Step 1: Append the interface and validator to the file.**

```ts
/**
 * Decoded Meshtastic packet event (camelCase, post-remap from wrapper output).
 * Real TypeScript interface — mirrors ShipData in ais-catcher.ts to support
 * type-safe downstream consumers. Optional fields are present only when the
 * originating node set them (the wrapper omits unset fields).
 */
export interface MeshtasticPacket {
	/** Originating node ID (uint32). */
	from: number
	/** Destination node ID (uint32; 0xFFFFFFFF = broadcast). */
	to: number
	/** Packet ID (uint32). */
	id: number
	/** Channel hash. */
	channel: number
	/** Remaining hops. */
	hopLimit: number
	/** Initial hop count when first transmitted. */
	hopStart: number
	/** Sender requested an ack. */
	wantAck: boolean
	/** Forwarded via MQTT (optional — wrapper omits when not set). */
	viaMqtt?: boolean | undefined
	/** Meshtastic message priority (optional — wrapper omits when not set). */
	priority?: number | undefined
	/** Meshtastic PortNum enum value. */
	portnum: number
	/** Base64-encoded decrypted Data.payload bytes. */
	payloadB64: string
	/** Length of the raw decrypted payload bytes. */
	payloadLen: number
	/** RX RSSI in dBm (0 if unavailable). */
	rxRssi: number
	/** RX SNR in dB (0 if unavailable). */
	rxSnr: number
	/** ISO-8601 UTC time the wrapper observed the frame. */
	rxTime: string
	/** Decoder's tuned frequency in Hz (from config, not measured). */
	frequency: number
	/** LoRa bandwidth used (Hz). */
	bw: number
	/** LoRa spreading factor used. */
	sf: number
	/** LoRa coding rate (5..8 representing 4/5..4/8). */
	cr: number
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return (
		value !== null &&
		typeof value === "object" &&
		!Array.isArray(value)
	)
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value)
}

function isBase64(value: unknown): value is string {
	if (typeof value !== "string") return false
	if (value.length === 0) return true // explicit allow per spec — empty payload
	if (value.length % 4 !== 0) return false
	return BASE64_RE.test(value)
}

function isIsoDate(value: unknown): value is string {
	if (typeof value !== "string" || value.length === 0) return false
	const ms = Date.parse(value)
	return Number.isFinite(ms)
}

/**
 * Validates a wrapper-emitted JSON object and remaps snake_case to camelCase.
 * Returns null (never throws) when input is null/non-object/wrong-typed.
 * Mirrors parseJsonShip in ais-catcher.ts.
 */
export function parseMeshtasticPacket(
	json: unknown,
): MeshtasticPacket | null {
	if (!isPlainObject(json)) return null

	const fromVal = json["from"]
	const toVal = json["to"]
	const idVal = json["id"]
	const channelVal = json["channel"]
	const hopLimitVal = json["hop_limit"]
	const hopStartVal = json["hop_start"]
	const wantAckVal = json["want_ack"]
	const portnumVal = json["portnum"]
	const payloadB64Val = json["payload_b64"]
	const payloadLenVal = json["payload_len"]
	const rxRssiVal = json["rx_rssi"]
	const rxSnrVal = json["rx_snr"]
	const rxTimeVal = json["rx_time"]
	const frequencyVal = json["frequency"]
	const bwVal = json["bw"]
	const sfVal = json["sf"]
	const crVal = json["cr"]

	if (!isFiniteNumber(fromVal)) return null
	if (!isFiniteNumber(toVal)) return null
	if (!isFiniteNumber(idVal)) return null
	if (!isFiniteNumber(channelVal)) return null
	if (!isFiniteNumber(hopLimitVal)) return null
	if (!isFiniteNumber(hopStartVal)) return null
	if (typeof wantAckVal !== "boolean") return null
	if (!isFiniteNumber(portnumVal)) return null
	if (!isBase64(payloadB64Val)) return null
	if (!isFiniteNumber(payloadLenVal)) return null
	if (!isFiniteNumber(rxRssiVal)) return null
	if (!isFiniteNumber(rxSnrVal)) return null
	if (!isIsoDate(rxTimeVal)) return null
	if (!isFiniteNumber(frequencyVal)) return null
	if (!isFiniteNumber(bwVal)) return null
	if (!isFiniteNumber(sfVal)) return null
	if (!isFiniteNumber(crVal)) return null

	const packet: MeshtasticPacket = {
		from: fromVal,
		to: toVal,
		id: idVal,
		channel: channelVal,
		hopLimit: hopLimitVal,
		hopStart: hopStartVal,
		wantAck: wantAckVal,
		portnum: portnumVal,
		payloadB64: payloadB64Val,
		payloadLen: payloadLenVal,
		rxRssi: rxRssiVal,
		rxSnr: rxSnrVal,
		rxTime: rxTimeVal,
		frequency: frequencyVal,
		bw: bwVal,
		sf: sfVal,
		cr: crVal,
	}

	// Optional fields — include only when present and well-typed.
	const viaMqttVal = json["via_mqtt"]
	if (viaMqttVal !== undefined) {
		if (typeof viaMqttVal !== "boolean") return null
		packet.viaMqtt = viaMqttVal
	}
	const priorityVal = json["priority"]
	if (priorityVal !== undefined) {
		if (!isFiniteNumber(priorityVal)) return null
		packet.priority = priorityVal
	}

	return packet
}
```

- [ ] **Step 2: Verify typecheck.**

Run: `pnpm run typecheck`
Expected: exits 0.

- [ ] **Step 3: Commit.**

```bash
git add src/decoders/builtin/lora-meshtastic.ts
git commit -m "feat(decoders): add MeshtasticPacket interface and JSON-boundary validator"
```

_Requirements: 4.1, 4.2, 4.3, 4.6._

---

### Task 4: Add `LoraMeshtasticDecoder` class, factory, and caps

**Files:**
- Modify: `src/decoders/builtin/lora-meshtastic.ts` (append after the JSON validator)
- Test: covered by Tasks 10 + 12

- [ ] **Step 1: Append the class, factory, and caps to the file.**

```ts
/**
 * Capabilities for the LoRa/Meshtastic decoder.
 */
export const LORA_MESHTASTIC_CAPS: DecoderCaps = {
	input: "iq",
	wantsExclusiveSource: false,
	output: "jsonl",
	integrationPattern: "pure_consumer",
}

/** Canonical path to the wrapper inside the Docker image. */
const WRAPPER_SCRIPT_PATH = "/usr/local/bin/lora_meshtastic_decode.py"

/**
 * LoRa/Meshtastic decoder. Mirrors Rtl433Decoder in shape and lifecycle.
 *
 * Decimates cu8 IQ via csdr (handled by IqDecimateDecoder base class), then
 * pipes the decimated stream into a Python wrapper that owns the LoRa demod,
 * AES-CTR decryption, protobuf parsing, and JSONL emission.
 */
export class LoraMeshtasticDecoder extends IqDecimateDecoder {
	private readonly options: LoraMeshtasticOptions
	private readonly componentLog: Logger

	constructor(config: DecoderConfig, logger: Logger) {
		super(config, logger)
		this.options = parseLoraMeshtasticOptions(config.options)
		this.componentLog = createComponentLogger(
			logger,
			"LoraMeshtasticDecoder",
		)
	}

	/** Effective post-csdr rate (Hz) — for tests and debug logging. */
	get effectiveTargetRate(): number {
		return this.options.effectiveTargetRate
	}

	protected override getIqDecimationConfig(): IqDecimationConfig {
		return {
			inputSampleRate: this.options.inputSampleRate,
			targetSampleRate: this.options.bw * this.options.oversampling,
			filterTransition: 0.05,
		}
	}

	protected override getDecoderCommand(): string {
		return "python3"
	}

	protected override getDecoderArgs(): string[] {
		return [
			WRAPPER_SCRIPT_PATH,
			"--bw",
			String(this.options.bw),
			"--sf",
			String(this.options.sf),
			"--cr",
			String(this.options.cr),
			"--samp-rate",
			String(this.options.effectiveTargetRate),
			"--frequency",
			String(this.options.frequency),
			"--channel-key",
			this.options.channelKey,
			"--region",
			this.options.region,
		]
	}

	protected override getCaps(): DecoderCaps {
		return LORA_MESHTASTIC_CAPS
	}

	protected override parseOutput(line: string): DecoderOutput | null {
		const trimmed = line.trim()
		if (!trimmed) return null
		if (!trimmed.startsWith("{")) return null

		let parsed: unknown
		try {
			parsed = JSON.parse(trimmed)
		} catch {
			this.componentLog.debug(
				{ line: trimmed },
				"Failed to parse wrapper output as JSON",
			)
			return null
		}

		const packet = parseMeshtasticPacket(parsed)
		if (!packet) {
			this.componentLog.debug(
				{ line: trimmed },
				"Wrapper output failed MeshtasticPacket schema validation",
			)
			return null
		}

		return {
			timestamp: new Date(),
			decoder: this.id,
			type: "meshtastic",
			data: packet,
		}
	}
}

/**
 * Factory function used by DecoderRegistry.
 */
export function createLoraMeshtasticDecoder(
	config: DecoderConfig,
	logger: Logger,
): LoraMeshtasticDecoder {
	return new LoraMeshtasticDecoder(config, logger)
}
```

- [ ] **Step 2: Verify typecheck.**

Run: `pnpm run typecheck`
Expected: exits 0.

- [ ] **Step 3: Verify lint cleanly passes.**

Run: `pnpm run lint -- src/decoders/builtin/lora-meshtastic.ts`
Expected: zero errors. If the project's `eslint` does not accept a single-file argument, run the full `pnpm run lint`.

- [ ] **Step 4: Commit.**

```bash
git add src/decoders/builtin/lora-meshtastic.ts
git commit -m "feat(decoders): add LoraMeshtasticDecoder class and factory"
```

_Requirements: 1.1, 1.2, 2.1, 2.2, 2.3, 2.4, 2.5, 3.1, 4.4, 4.5, 4.6._

---

### Task 5: (no-op verification) Confirm `IqDecimateDecoder` is unchanged

**Files:**
- Verify (do not modify): `src/decoders/iq-decimate-decoder.ts`

- [ ] **Step 1: Run `git diff --stat src/decoders/iq-decimate-decoder.ts`.**

Expected: zero changes since merge-base. If the file has changed during implementation, revert any modifications — the anti-pattern checklist (design §13) forbids modifying the base class.

```bash
git diff --stat src/decoders/iq-decimate-decoder.ts
# Expected: empty output. If non-empty, run:
#   git checkout -- src/decoders/iq-decimate-decoder.ts
# then revisit Tasks 2-4 to ensure they only touch the subclass.
```

No commit for this task; it's a verification gate.

_Requirements: 2.5; design.md §13._

---

### Task 6: Register `"lora-meshtastic"` in `src/index.ts`

**Files:**
- Modify: `src/index.ts` (imports block around lines 30-55, registration block around lines 377-388, log line around 390-393)

- [ ] **Step 1: Add the import.** Place it alongside the other decoder builtins.

Add (in the imports section, immediately after the `direwolf` import around line 52-55):

```ts
import {
	createLoraMeshtasticDecoder,
	LORA_MESHTASTIC_CAPS,
} from "./decoders/builtin/lora-meshtastic.js"
```

- [ ] **Step 2: Register the decoder.** Add after the `direwolf` registration line:

```ts
decoderRegistry.register(
	"lora-meshtastic",
	createLoraMeshtasticDecoder,
	LORA_MESHTASTIC_CAPS,
)
```

- [ ] **Step 3: Run typecheck.**

Run: `pnpm run typecheck`
Expected: exits 0.

- [ ] **Step 4: Run unit tests so the registry test file picks up the new type.**

Run: `pnpm test`
Expected: existing tests still pass.

- [ ] **Step 5: Commit.**

```bash
git add src/index.ts
git commit -m "feat(decoders): register lora-meshtastic in decoder registry"
```

_Requirements: 6.1, 6.2, 6.3._

---

## Python wrapper + protobuf vendoring

### Task 7: Vendor the Meshtastic `mesh.proto` compiled module

**Files:**
- Create: `docker/scripts/meshtastic_proto/__init__.py`
- Create: `docker/scripts/meshtastic_proto/mesh_pb2.py`

This task does NOT compile `mesh.proto` in CI (CI does not run protoc). Instead it commits the generated output at a pinned upstream SHA. The header comment is the audit trail.

- [ ] **Step 1: Pick the upstream SHA to pin.**

Visit https://github.com/meshtastic/protobufs/commits/master and copy the latest commit's full 40-char SHA. Record it locally for the header comment; we'll call it `<SHA>` below.

- [ ] **Step 2: Generate `mesh_pb2.py` locally.**

Outside the repo, in a scratch directory:

```bash
git clone https://github.com/meshtastic/protobufs.git meshtastic-protos
cd meshtastic-protos
git checkout <SHA>
mkdir -p out
protoc \
  --proto_path=. \
  --python_out=out \
  meshtastic/mesh.proto
# The generated file lands at out/meshtastic/mesh_pb2.py.
```

`mesh.proto` imports a few sibling protos (`config.proto`, `module_config.proto`, `portnums.proto`, `channel.proto`). Compile only `mesh.proto`. The generated `mesh_pb2.py` will reference `portnums_pb2` etc. — **do not** vendor those modules. Edit the generated `mesh_pb2.py` to import the referenced sibling messages **only at the symbol level we need**: `MeshPacket` and `Data`. Where it imports `portnums_pb2`, replace those references with plain ints (PortNum is an enum; we treat it as int on the wrapper side). The diff to apply is decided at generation time — document the exact stripping steps in the file header for future maintainers.

For v1 the supported surface is: `MeshPacket` (with `encrypted` and `decoded` fields), `Data` (with `portnum`, `payload`, `dest`, `source`, etc.). All other imported messages can be replaced with empty stubs.

- [ ] **Step 3: Place the generated file with the audit header.**

Copy the generated and stripped file to `docker/scripts/meshtastic_proto/mesh_pb2.py`. Prepend the header:

```python
# Generated from https://github.com/meshtastic/protobufs at SHA <SHA>, mesh.proto only. Do not edit by hand.
# To regenerate: protoc --python_out=docker/scripts/meshtastic_proto --proto_path=<upstream-clone> meshtastic/mesh.proto
# Stripped to MeshPacket + Data only — see docs/superpowers/plans/2026-05-15-lora-meshtastic-decoder.md Task 7 for stripping steps.
```

Replace `<SHA>` with the literal 40-char SHA chosen in Step 1.

- [ ] **Step 4: Create the package init file.**

```bash
# Create the file via the Write tool with content:
#   # Meshtastic protobuf package marker (mesh.proto only).
#   # See mesh_pb2.py for upstream SHA + regeneration command.
```

Write `docker/scripts/meshtastic_proto/__init__.py` with the two-line comment shown above (and an empty line at end-of-file).

- [ ] **Step 5: Smoke-test the import locally (optional, requires `pip install protobuf` in a virtualenv).**

```bash
cd docker/scripts
python3 -c "from meshtastic_proto import mesh_pb2; print(mesh_pb2.MeshPacket.DESCRIPTOR.name, mesh_pb2.Data.DESCRIPTOR.name)"
# Expected: MeshPacket Data
```

- [ ] **Step 6: Commit.**

```bash
git add docker/scripts/meshtastic_proto/
git commit -m "feat(lora): vendor Meshtastic mesh_pb2.py at upstream SHA <SHA-first-7>"
```

_Requirements: 3.8, 10.1, 10.2, 10.3._

---

### Task 8: Write the Python wrapper `docker/scripts/lora_meshtastic_decode.py`

**Files:**
- Create: `docker/scripts/lora_meshtastic_decode.py`

- [ ] **Step 1: Write the wrapper.**

```python
#!/usr/bin/env python3
"""
LoRa/Meshtastic decoder wrapper.

Reads cu8 IQ from stdin, demodulates LoRa frames using gr-lora_sdr, decrypts
the Meshtastic AES-CTR-encrypted payload, parses the inner Data protobuf, and
emits one JSON line per packet on stdout. All diagnostic output goes to stderr.

Argv:
    --bw <Hz>            LoRa bandwidth (e.g. 250000)
    --sf <int>           Spreading factor (7-12)
    --cr <int>           Coding rate 5..8 (representing 4/5..4/8)
    --samp-rate <Hz>     Effective post-csdr sample rate
    --frequency <Hz>     Tuned frequency (for event metadata only)
    --channel-key <b64>  Meshtastic PSK; "AQ==" = default-channel shorthand
    --region <enum>      Meshtastic regional region tag (US, EU_868, ...)
"""

import argparse
import base64
import json
import signal
import sys
import time
from datetime import datetime, timezone

# Ensure the vendored protobuf module is importable.
sys.path.insert(0, "/usr/local/lib/wavekit")
from meshtastic_proto import mesh_pb2  # noqa: E402

from cryptography.hazmat.primitives.ciphers import (  # noqa: E402
	Cipher,
	algorithms,
	modes,
)

# Meshtastic-defined 16-byte default-channel PSK.
# Source: https://github.com/meshtastic/firmware (Channels::getDefaultPsk).
DEFAULT_PSK = bytes(
	[
		0xD4, 0xF1, 0xBB, 0x3A, 0x20, 0x29, 0x07, 0x59,
		0xF0, 0xBC, 0xFF, 0xAB, 0xCF, 0x4E, 0x69, 0x01,
	]
)

CHUNK_SIZE = 64 * 1024


def err(msg: str, **fields) -> None:
	"""Write a structured log line to stderr."""
	payload = {"ts": datetime.now(timezone.utc).isoformat(), "msg": msg, **fields}
	sys.stderr.write(json.dumps(payload) + "\n")
	sys.stderr.flush()


def resolve_channel_key(raw_b64: str) -> bytes:
	"""Decode the channel key, expanding the "AQ==" shorthand."""
	try:
		key_bytes = base64.b64decode(raw_b64, validate=True)
	except Exception as exc:
		err("invalid_channel_key", reason="not_base64", detail=str(exc))
		raise SystemExit(2)

	if key_bytes == bytes([0x01]):
		return DEFAULT_PSK

	if len(key_bytes) != 16:
		err(
			"invalid_channel_key",
			reason="non_16_byte_custom_key",
			length=len(key_bytes),
		)
		raise SystemExit(2)

	return key_bytes


def derive_nonce(packet_id: int, from_node: int) -> bytes:
	"""
	Build the 16-byte Meshtastic AES-CTR nonce.

	The firmware convention is:
	    bytes  0..3 : packet_id   (little-endian uint32)
	    bytes  4..7 : from_node   (little-endian uint32)
	    bytes 8..15 : zero
	"""
	return (
		packet_id.to_bytes(4, "little")
		+ from_node.to_bytes(4, "little")
		+ b"\x00" * 8
	)


def decrypt(payload: bytes, key: bytes, packet_id: int, from_node: int) -> bytes:
	nonce = derive_nonce(packet_id, from_node)
	cipher = Cipher(algorithms.AES(key), modes.CTR(nonce))
	dec = cipher.decryptor()
	return dec.update(payload) + dec.finalize()


def emit_packet(
	mesh_packet,
	data_pb,
	args,
) -> None:
	"""Emit one Meshtastic packet event as a JSON line on stdout."""
	now_iso = datetime.now(timezone.utc).isoformat()
	payload_bytes = bytes(data_pb.payload)
	event = {
		"from": mesh_packet.from_,
		"to": mesh_packet.to,
		"id": mesh_packet.id,
		"channel": mesh_packet.channel,
		"hop_limit": mesh_packet.hop_limit,
		"hop_start": mesh_packet.hop_start,
		"want_ack": bool(mesh_packet.want_ack),
		"portnum": int(data_pb.portnum),
		"payload_b64": base64.b64encode(payload_bytes).decode("ascii"),
		"payload_len": len(payload_bytes),
		"rx_rssi": int(getattr(mesh_packet, "rx_rssi", 0) or 0),
		"rx_snr": float(getattr(mesh_packet, "rx_snr", 0.0) or 0.0),
		"rx_time": now_iso,
		"frequency": args.frequency,
		"bw": args.bw,
		"sf": args.sf,
		"cr": args.cr,
	}
	# Optional fields — include only when explicitly set on the wire.
	if mesh_packet.HasField("via_mqtt") if mesh_packet.DESCRIPTOR.fields_by_name.get("via_mqtt") else False:
		event["via_mqtt"] = bool(mesh_packet.via_mqtt)
	if mesh_packet.DESCRIPTOR.fields_by_name.get("priority"):
		event["priority"] = int(mesh_packet.priority)

	sys.stdout.write(json.dumps(event) + "\n")
	sys.stdout.flush()


def parse_frame(raw_frame: bytes, key: bytes, args) -> None:
	"""Parse one decoded LoRa frame as a Meshtastic MeshPacket and emit."""
	try:
		mp = mesh_pb2.MeshPacket()
		mp.ParseFromString(raw_frame)
	except Exception as exc:
		err("meshpacket_parse_failed", detail=str(exc))
		return

	# Encrypted payload path (the common case).
	encrypted_field = mp.DESCRIPTOR.fields_by_name.get("encrypted")
	if encrypted_field and mp.HasField("encrypted") and len(mp.encrypted) > 0:
		try:
			plaintext = decrypt(mp.encrypted, key, mp.id, mp.from_)
		except Exception as exc:
			err("aes_ctr_failed", id=mp.id, detail=str(exc))
			return
		try:
			data = mesh_pb2.Data()
			data.ParseFromString(plaintext)
		except Exception as exc:
			err("data_parse_failed", id=mp.id, detail=str(exc))
			return
	elif mp.HasField("decoded"):
		# Already-decoded path (no encryption in test fixtures or local nodes).
		data = mp.decoded
	else:
		err("meshpacket_no_payload", id=mp.id)
		return

	try:
		emit_packet(mp, data, args)
	except Exception as exc:
		err("emit_failed", detail=str(exc))


def build_flowgraph(args, on_frame):
	"""
	Build the gr-lora_sdr rx flowgraph: source → frame_sync → fft_demod →
	gray_mapping → deinterleaver → hamming_dec → header_decoder → dewhitening →
	crc_verif → message_strobe (callback into on_frame).

	Returns the flowgraph object. The caller calls .start() and .stop().

	NOTE: Exact gr-lora_sdr API surface may evolve across releases. The
	tasks.md Task 9 step pins a specific upstream commit so this code stays in
	lock-step. If the upstream block names change, update both this wrapper
	and the lora-build Dockerfile stage in the same PR.
	"""
	from gnuradio import gr, blocks
	from gnuradio import lora_sdr

	class StdinSource(gr.sync_block):
		def __init__(self):
			gr.sync_block.__init__(
				self,
				name="stdin_cu8_to_cf32",
				in_sig=None,
				out_sig=[__import__("numpy").complex64],
			)
			self._buf = b""

		def work(self, input_items, output_items):
			import numpy as np
			out = output_items[0]
			needed_pairs = len(out)
			needed_bytes = needed_pairs * 2 - len(self._buf)
			if needed_bytes > 0:
				more = sys.stdin.buffer.read(min(needed_bytes, CHUNK_SIZE))
				if not more:
					return -1  # EOF
				self._buf += more
			usable_pairs = len(self._buf) // 2
			n = min(usable_pairs, needed_pairs)
			raw = np.frombuffer(self._buf[: n * 2], dtype=np.uint8)
			self._buf = self._buf[n * 2 :]
			i = (raw[0::2].astype(np.float32) - 127.5) / 127.5
			q = (raw[1::2].astype(np.float32) - 127.5) / 127.5
			out[:n] = i + 1j * q
			return n

	tb = gr.top_block("lora_meshtastic_rx")
	src = StdinSource()

	# Hook the gr-lora_sdr blocks. Block names and ctor signatures follow the
	# upstream README; pin the upstream commit in the Dockerfile lora-build
	# stage to keep this stable.
	frame_sync = lora_sdr.frame_sync(
		int(args.frequency), int(args.bw), int(args.sf), False, [16], int(args.samp_rate // args.bw), 8
	)
	fft_demod = lora_sdr.fft_demod(False, True)
	gray_mapping = lora_sdr.gray_mapping(False)
	deinterleaver = lora_sdr.deinterleaver(False)
	hamming_dec = lora_sdr.hamming_dec(False)
	header_decoder = lora_sdr.header_decoder(False, int(args.cr) - 4, 255, True, 2, False)
	dewhitening = lora_sdr.dewhitening()
	crc_verif = lora_sdr.crc_verif(0, False)

	frame_sink = blocks.message_debug()

	tb.connect(src, frame_sync, fft_demod, gray_mapping, deinterleaver, hamming_dec)
	tb.connect(hamming_dec, header_decoder, dewhitening, crc_verif)
	# crc_verif emits payload bytes; we hook a callback via a custom message sink.
	# Implementation note: the simplest path is a blocks.vector_sink_b at the tail
	# and a thread that polls it — see Task 9 verification for the exact wiring
	# that matches the upstream gr-lora_sdr commit pinned in the lora-build stage.

	return tb, frame_sink


def main() -> int:
	parser = argparse.ArgumentParser(description="LoRa/Meshtastic decoder wrapper")
	parser.add_argument("--bw", type=int, required=True)
	parser.add_argument("--sf", type=int, required=True)
	parser.add_argument("--cr", type=int, required=True)
	parser.add_argument("--samp-rate", dest="samp_rate", type=int, required=True)
	parser.add_argument("--frequency", type=int, required=True)
	parser.add_argument("--channel-key", dest="channel_key", required=True)
	parser.add_argument("--region", required=True)
	args = parser.parse_args()

	key = resolve_channel_key(args.channel_key)

	frame_queue: list[bytes] = []

	def on_frame(raw_bytes: bytes) -> None:
		frame_queue.append(raw_bytes)

	tb, _sink = build_flowgraph(args, on_frame)

	stopping = False

	def handle_sigterm(_signo, _frame):
		nonlocal stopping
		stopping = True
		try:
			tb.stop()
			tb.wait()
		except Exception as exc:
			err("flowgraph_stop_failed", detail=str(exc))

	signal.signal(signal.SIGTERM, handle_sigterm)
	signal.signal(signal.SIGINT, handle_sigterm)

	tb.start()
	try:
		while not stopping:
			# Drain any complete frames the flowgraph has produced.
			while frame_queue:
				raw = frame_queue.pop(0)
				parse_frame(raw, key, args)
			time.sleep(0.01)
	finally:
		try:
			tb.stop()
			tb.wait()
		except Exception as exc:
			err("flowgraph_stop_failed", detail=str(exc))

	return 0


if __name__ == "__main__":
	try:
		raise SystemExit(main())
	except SystemExit:
		raise
	except Exception as exc:  # pragma: no cover - top-level safety net
		err("fatal", detail=str(exc))
		raise SystemExit(1)
```

- [ ] **Step 2: Make the wrapper executable.**

```bash
chmod 755 docker/scripts/lora_meshtastic_decode.py
```

- [ ] **Step 3: Smoke-test the argument parser locally (does NOT require gnuradio installed; will fail at the import line, which we want to verify the structure of).**

```bash
python3 docker/scripts/lora_meshtastic_decode.py --help
# Expected: argparse usage text, then exit 0.
# (If "ImportError: gnuradio" appears, that's expected on a host without gnuradio.
# The Docker image installs python3-gnuradio in Task 9.)
```

- [ ] **Step 4: Commit.**

```bash
git add docker/scripts/lora_meshtastic_decode.py
git commit -m "feat(lora): add Python wrapper for gr-lora_sdr + Meshtastic decrypt"
```

_Requirements: 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8._

---

## Docker image

### Task 9: Add `lora-build` Dockerfile stage and update `final` + `final-core`

**Files:**
- Modify: `Dockerfile`

- [ ] **Step 1: Add the `lora-build` stage.** Insert immediately after the `ais-catcher-build` stage (current line ~273), following the pattern of the surrounding stages.

```dockerfile
# ============================================================================
# Stage: lora-build
# Purpose: Build gr-lora_sdr (LoRa demodulator for GNU Radio)
# Size: ~250MB (not in final image)
# ============================================================================
FROM base-deps AS lora-build

WORKDIR /build

RUN apt-get update && apt-get install -y --no-install-recommends \
		gnuradio \
		gnuradio-dev \
		python3-dev \
		pybind11-dev \
		libgmp-dev \
		swig \
	&& rm -rf /var/lib/apt/lists/*

# Pin a known-good upstream commit. Update this and re-test the wrapper when
# bumping. The wrapper at docker/scripts/lora_meshtastic_decode.py is
# coupled to the gr-lora_sdr block API at this commit.
ARG GR_LORA_SDR_REF=master

RUN git clone https://github.com/tapparelj/gr-lora_sdr.git && \
	cd gr-lora_sdr && \
	git checkout ${GR_LORA_SDR_REF} && \
	mkdir build && cd build && \
	cmake -DCMAKE_BUILD_TYPE=Release .. && \
	make -j$(nproc) && \
	make install && \
	ldconfig
```

- [ ] **Step 2: Update the `final` stage.** Append to the runtime apt-install block near the top of `final` (or add a new RUN if one doesn't exist), add the COPY lines, and extend the verification block.

Add `python3 python3-gnuradio python3-protobuf python3-cryptography` to the runtime-base apt-install (or as a new `RUN apt-get install` in `final` if `runtime-base` already finalised). Then, after the existing `COPY --from=ais-catcher-build ...` line:

```dockerfile
# LoRa/Meshtastic decoder (gr-lora_sdr + Python wrapper + vendored protobuf)
COPY --from=lora-build /usr/local/lib/python3*/dist-packages/gnuradio/lora_sdr /usr/local/lib/python3/dist-packages/gnuradio/lora_sdr/
COPY --from=lora-build /usr/local/lib/libgnuradio-lora_sdr* /usr/local/lib/
COPY docker/scripts/lora_meshtastic_decode.py /usr/local/bin/lora_meshtastic_decode.py
COPY docker/scripts/meshtastic_proto /usr/local/lib/wavekit/meshtastic_proto
RUN chmod 755 /usr/local/bin/lora_meshtastic_decode.py && ldconfig
```

Extend the verification block (currently `RUN echo "Verifying decoder installations..." && ...`) to add two lines and update the count:

```dockerfile
	python3 -c "from gnuradio import lora_sdr; print(lora_sdr.__file__)" && \
	python3 /usr/local/bin/lora_meshtastic_decode.py --help > /dev/null 2>&1 && \
	echo "All 9 decoders + csdr verified successfully"
```

Update the comment `# Verify all 8 decoder installations` above the RUN block to `# Verify all 9 decoder installations`.

- [ ] **Step 3: Apply the same changes to `final-core`.**

Repeat Step 2 verbatim in the `final-core` stage (around lines 549-565), including the verification block extension. `final-core` does not currently have a verification block — add one if missing, otherwise mirror `final`.

- [ ] **Step 4: Build the image.**

```bash
make dev-up
# Or, to build only the image without starting:
docker build --target=final -t wavekit-test:lora .
```

Expected: build succeeds and the verification block prints `All 9 decoders + csdr verified successfully`.

- [ ] **Step 5: Verify image size delta is within the ~400-600 MB envelope.**

```bash
docker images wavekit-test:lora --format "table {{.Tag}}\t{{.Size}}"
# Compare against the previous main-branch image.
```

If the delta exceeds ~600 MB, investigate which COPY line is the offender (likely the `python3-gnuradio` apt package — that is the unavoidable runtime cost).

- [ ] **Step 6: Commit.**

```bash
git add Dockerfile
git commit -m "feat(docker): add lora-build stage and ship gr-lora_sdr in final images"
```

_Requirements: 9.1, 9.2, 9.3, 9.4, 9.5._

---

## Tests (checkpoint)

### Task 10: Property-based unit tests

**Files:**
- Create: `tests/unit/decoders/lora-meshtastic.test.ts`

This task implements all eight property tests. Each test has the canonical reference comment. Mirror the file layout of `tests/unit/decoders/rtl433.test.ts`.

- [ ] **Step 1: Scaffold the test file.**

```ts
/**
 * LoRa/Meshtastic Decoder Property-Based Tests.
 *
 * Eight properties from .kiro/specs/lora-decoder/design.md §7.
 */

import { describe, it, expect } from "vitest"
import * as fc from "fast-check"
import pino from "pino"
import type {
	DecoderConfig,
	DecoderOutput,
} from "../../../src/decoders/types.js"
import {
	LoraMeshtasticDecoder,
	LORA_MESHTASTIC_CAPS,
	LORA_PRESETS,
	LORA_REGIONS,
	PRESET_TABLE,
	parseLoraMeshtasticOptions,
	parseMeshtasticPacket,
	type LoraPreset,
	type LoraRegion,
	type MeshtasticPacket,
} from "../../../src/decoders/builtin/lora-meshtastic.js"
import { ConfigValidationError } from "../../../src/utils/errors.js"

const testLogger = pino({ level: "silent" })

class TestDecoder extends LoraMeshtasticDecoder {
	public testParseOutput(line: string): DecoderOutput | null {
		return this.parseOutput(line)
	}
	public testGetDecoderArgs(): string[] {
		return this.getDecoderArgs()
	}
}

function makeConfig(options: Record<string, unknown>): DecoderConfig {
	return {
		id: "test-lora",
		type: "lora-meshtastic",
		enabled: true,
		options,
	}
}

function validOptions(
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		region: "EU_868",
		preset: "LongFast",
		frequency: 869_525_000,
		channelKey: "AQ==",
		...overrides,
	}
}
```

- [ ] **Step 2: Add Property 1 — options round-trip.**

```ts
describe("Property 1: options round-trip", () => {
	// Feature: lora-meshtastic, Property 1: Options round-trip
	// Validates: Requirements 1.2, 1.5, 4.6
	it("returns the same resolved options on repeated parses", () => {
		fc.assert(
			fc.property(
				fc.constantFrom(...LORA_REGIONS),
				fc.constantFrom(...LORA_PRESETS),
				fc.integer({ min: 400_000_000, max: 950_000_000 }),
				fc.option(fc.integer({ min: 62_500, max: 500_000 }), {
					nil: undefined,
				}),
				fc.option(fc.integer({ min: 7, max: 12 }), { nil: undefined }),
				fc.option(fc.integer({ min: 5, max: 8 }), { nil: undefined }),
				(region, preset, frequency, bandwidth, spreadingFactor, codingRate) => {
					const opts: Record<string, unknown> = {
						region,
						preset,
						frequency,
						channelKey: "AQ==",
					}
					if (bandwidth !== undefined) opts["bandwidth"] = bandwidth
					if (spreadingFactor !== undefined)
						opts["spreadingFactor"] = spreadingFactor
					if (codingRate !== undefined) opts["codingRate"] = codingRate
					try {
						const a = parseLoraMeshtasticOptions(opts)
						const b = parseLoraMeshtasticOptions(opts)
						expect(b).toEqual(a)
					} catch (err) {
						// Out-of-range sps inputs throw ConfigValidationError; that's a
						// valid path — Property 5 covers it explicitly.
						expect(err).toBeInstanceOf(ConfigValidationError)
					}
				},
			),
			{ numRuns: 100 },
		)
	})
})
```

- [ ] **Step 3: Add Property 2 — args determinism.**

```ts
describe("Property 2: args determinism", () => {
	// Feature: lora-meshtastic, Property 2: Args determinism
	// Validates: Requirements 3.1, 8.3
	it("produces identical arg arrays for identical resolved options", () => {
		fc.assert(
			fc.property(
				fc.constantFrom(...LORA_REGIONS),
				fc.constantFrom(...LORA_PRESETS),
				fc.integer({ min: 400_000_000, max: 950_000_000 }),
				(region, preset, frequency) => {
					const opts = { region, preset, frequency, channelKey: "AQ==" }
					const a = new TestDecoder(makeConfig(opts), testLogger)
					const b = new TestDecoder(makeConfig(opts), testLogger)
					expect(a.testGetDecoderArgs()).toEqual(b.testGetDecoderArgs())
				},
			),
			{ numRuns: 100 },
		)
	})
})
```

- [ ] **Step 4: Add Property 3 — JSONL round-trip.**

```ts
describe("Property 3: JSONL round-trip", () => {
	// Feature: lora-meshtastic, Property 3: JSONL round-trip
	// Validates: Requirements 4.1, 4.2, 4.4, 5.3
	const wireShapeArb = fc.record({
		from: fc.integer({ min: 0, max: 4_294_967_295 }),
		to: fc.integer({ min: 0, max: 4_294_967_295 }),
		id: fc.integer({ min: 0, max: 4_294_967_295 }),
		channel: fc.integer({ min: 0, max: 255 }),
		hop_limit: fc.integer({ min: 0, max: 7 }),
		hop_start: fc.integer({ min: 0, max: 7 }),
		want_ack: fc.boolean(),
		portnum: fc.integer({ min: 0, max: 255 }),
		payload_b64: fc
			.uint8Array({ minLength: 0, maxLength: 100 })
			.map(bytes => Buffer.from(bytes).toString("base64")),
		payload_len: fc.integer({ min: 0, max: 100 }),
		rx_rssi: fc.integer({ min: -150, max: 0 }),
		rx_snr: fc.double({ min: -20, max: 20, noNaN: true }),
		rx_time: fc
			.integer({
				min: new Date("2020-01-01").getTime(),
				max: new Date("2030-12-31").getTime(),
			})
			.map(ms => new Date(ms).toISOString()),
		frequency: fc.integer({ min: 400_000_000, max: 950_000_000 }),
		bw: fc.constantFrom(62_500, 125_000, 250_000),
		sf: fc.integer({ min: 7, max: 12 }),
		cr: fc.integer({ min: 5, max: 8 }),
	})

	it("remaps snake_case → camelCase and tags type:'meshtastic'", () => {
		fc.assert(
			fc.property(wireShapeArb, wire => {
				const decoder = new TestDecoder(makeConfig(validOptions()), testLogger)
				const out = decoder.testParseOutput(JSON.stringify(wire))
				expect(out).not.toBeNull()
				expect(out!.type).toBe("meshtastic")
				expect(out!.decoder).toBe("test-lora")
				expect(out!.timestamp).toBeInstanceOf(Date)
				const data = out!.data as MeshtasticPacket
				expect(data.from).toBe(wire.from)
				expect(data.to).toBe(wire.to)
				expect(data.id).toBe(wire.id)
				expect(data.channel).toBe(wire.channel)
				expect(data.hopLimit).toBe(wire.hop_limit)
				expect(data.hopStart).toBe(wire.hop_start)
				expect(data.wantAck).toBe(wire.want_ack)
				expect(data.portnum).toBe(wire.portnum)
				expect(data.payloadB64).toBe(wire.payload_b64)
				expect(data.payloadLen).toBe(wire.payload_len)
				expect(data.rxRssi).toBe(wire.rx_rssi)
				expect(data.rxSnr).toBe(wire.rx_snr)
				expect(data.rxTime).toBe(wire.rx_time)
				expect(data.frequency).toBe(wire.frequency)
				expect(data.bw).toBe(wire.bw)
				expect(data.sf).toBe(wire.sf)
				expect(data.cr).toBe(wire.cr)
			}),
			{ numRuns: 100 },
		)
	})
})
```

- [ ] **Step 5: Add Property 4 — non-JSON tolerance.**

```ts
describe("Property 4: non-JSON tolerance", () => {
	// Feature: lora-meshtastic, Property 4: Non-JSON tolerance
	// Validates: Requirements 4.3, 4.5
	it("returns null without throwing for non-JSON, malformed JSON, or invalid shapes", () => {
		const garbageArb = fc.oneof(
			fc.constantFrom("", " ", "\t", "\n", "{", "}", "null", "[]", "log: hi"),
			fc.string({ minLength: 0, maxLength: 80 }),
			fc.uint8Array({ minLength: 0, maxLength: 80 }).map(b => b.toString()),
			fc.dictionary(fc.string(), fc.anything()).map(obj => JSON.stringify(obj)),
		)
		fc.assert(
			fc.property(garbageArb, line => {
				const decoder = new TestDecoder(
					makeConfig(validOptions()),
					testLogger,
				)
				const out = decoder.testParseOutput(line)
				// We don't enforce null vs non-null for valid-shape JSON; only that
				// parseOutput never throws.
				expect(() => decoder.testParseOutput(line)).not.toThrow()
				// Any line that yields a non-null output must validate as Meshtastic.
				if (out !== null) {
					expect(out.type).toBe("meshtastic")
				}
			}),
			{ numRuns: 100 },
		)
	})

	it("parseMeshtasticPacket returns null on null/array/non-object inputs", () => {
		expect(parseMeshtasticPacket(null)).toBeNull()
		expect(parseMeshtasticPacket(undefined)).toBeNull()
		expect(parseMeshtasticPacket([])).toBeNull()
		expect(parseMeshtasticPacket(42)).toBeNull()
		expect(parseMeshtasticPacket("hello")).toBeNull()
	})
})
```

- [ ] **Step 6: Add Property 5 — effective sample-rate derivation.**

```ts
describe("Property 5: effective sample-rate derivation", () => {
	// Feature: lora-meshtastic, Property 5: Effective sample-rate derivation
	// Validates: Requirements 2.2, 2.3, 2.4
	it("matches the documented formula or throws on out-of-range sps", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 250_000, max: 8_000_000 }), // inputSampleRate
				fc.constantFrom(62_500, 125_000, 250_000), // bandwidth
				fc.integer({ min: 1, max: 32 }), // oversampling
				(inputSampleRate, bandwidth, oversampling) => {
					const opts = {
						region: "EU_868" as LoraRegion,
						preset: "LongFast" as LoraPreset,
						frequency: 869_525_000,
						channelKey: "AQ==",
						bandwidth,
						inputSampleRate,
						oversampling,
					}
					try {
						const resolved = parseLoraMeshtasticOptions(opts)
						const nominalTarget = bandwidth * oversampling
						const decimation = Math.max(
							1,
							Math.round(inputSampleRate / nominalTarget),
						)
						const expected = inputSampleRate / decimation
						expect(resolved.effectiveTargetRate).toBe(expected)
						const sps = resolved.effectiveTargetRate / bandwidth
						expect(sps).toBeGreaterThanOrEqual(2)
						expect(sps).toBeLessThanOrEqual(32)
					} catch (err) {
						// Out-of-range sps must throw ConfigValidationError.
						expect(err).toBeInstanceOf(ConfigValidationError)
					}
				},
			),
			{ numRuns: 100 },
		)
	})
})
```

- [ ] **Step 7: Add Property 6 — required-field rejection.**

```ts
describe("Property 6: required-field rejection", () => {
	// Feature: lora-meshtastic, Property 6: Required-field rejection
	// Validates: Requirements 1.2, 1.6
	const requiredFields: ReadonlyArray<keyof ReturnType<typeof validOptions>> = [
		"region",
		"preset",
		"frequency",
		"channelKey",
	]
	for (const field of requiredFields) {
		it(`throws ConfigValidationError when "${String(field)}" is missing`, () => {
			fc.assert(
				fc.property(
					fc.constantFrom(...LORA_REGIONS),
					fc.constantFrom(...LORA_PRESETS),
					(region, preset) => {
						const opts = validOptions({ region, preset })
						delete (opts as Record<string, unknown>)[String(field)]
						expect(() => parseLoraMeshtasticOptions(opts)).toThrow(
							ConfigValidationError,
						)
					},
				),
				{ numRuns: 100 },
			)
		})
	}
})
```

- [ ] **Step 8: Add Property 7 — region & preset enum exhaustiveness.**

```ts
describe("Property 7: region & preset enum exhaustiveness", () => {
	// Feature: lora-meshtastic, Property 7: Region & preset enum exhaustiveness
	// Validates: Requirements 1.3, 1.4
	for (const region of LORA_REGIONS) {
		it(`accepts region "${region}"`, () => {
			const opts = validOptions({ region })
			expect(() => parseLoraMeshtasticOptions(opts)).not.toThrow()
		})
	}
	for (const preset of LORA_PRESETS) {
		it(`accepts preset "${preset}"`, () => {
			const opts = validOptions({ preset })
			expect(() => parseLoraMeshtasticOptions(opts)).not.toThrow()
		})
	}
	it("rejects unknown region strings", () => {
		fc.assert(
			fc.property(
				fc.string({ minLength: 1, maxLength: 10 }).filter(
					s => !(LORA_REGIONS as readonly string[]).includes(s),
				),
				region => {
					const opts = validOptions({ region })
					expect(() => parseLoraMeshtasticOptions(opts)).toThrow(
						ConfigValidationError,
					)
				},
			),
			{ numRuns: 100 },
		)
	})
	it("rejects unknown preset strings", () => {
		fc.assert(
			fc.property(
				fc.string({ minLength: 1, maxLength: 20 }).filter(
					s => !(LORA_PRESETS as readonly string[]).includes(s),
				),
				preset => {
					const opts = validOptions({ preset })
					expect(() => parseLoraMeshtasticOptions(opts)).toThrow(
						ConfigValidationError,
					)
				},
			),
			{ numRuns: 100 },
		)
	})
})
```

- [ ] **Step 9: Add Property 8 — preset → params mapping fixed-point.**

```ts
describe("Property 8: preset → params mapping fixed-point", () => {
	// Feature: lora-meshtastic, Property 8: Preset → (bw,sf,cr) fixed-point
	// Validates: Requirements 1.5, 4.6
	for (const preset of LORA_PRESETS) {
		it(`resolves preset "${preset}" to the canonical (bw, sf, cr)`, () => {
			const expected = PRESET_TABLE[preset]
			const resolved = parseLoraMeshtasticOptions(validOptions({ preset }))
			expect(resolved.bw).toBe(expected.bw)
			expect(resolved.sf).toBe(expected.sf)
			expect(resolved.cr).toBe(expected.cr)
		})
	}
	it("LORA_MESHTASTIC_CAPS matches the spec contract", () => {
		expect(LORA_MESHTASTIC_CAPS.input).toBe("iq")
		expect(LORA_MESHTASTIC_CAPS.wantsExclusiveSource).toBe(false)
		expect(LORA_MESHTASTIC_CAPS.output).toBe("jsonl")
		expect(LORA_MESHTASTIC_CAPS.integrationPattern).toBe("pure_consumer")
	})
})
```

- [ ] **Step 10: Run the tests.**

Run: `pnpm exec vitest run tests/unit/decoders/lora-meshtastic.test.ts`
Expected: all describe blocks pass with `numRuns: 100`.

- [ ] **Step 11: Commit.**

```bash
git add tests/unit/decoders/lora-meshtastic.test.ts
git commit -m "test(decoders): add property-based tests for lora-meshtastic"
```

_Requirements: 8.3._

---

### Task 11: Capture or synthesize the fixture

**Files:**
- Create: `fixtures/lora/meshtastic-sample.cu8`
- Create: `fixtures/lora/meshtastic-sample.expected.jsonl`
- Create: `fixtures/lora/README.md`

- [ ] **Step 1: Pick one origin path.**

**Option A (on-air capture):** Tune a known RTL-SDR with TCXO to the regional Meshtastic primary frequency (869.525 MHz EU / 906.875 MHz US). Configure a Meshtastic node beside it on the default channel. Capture 5-30 seconds with:

```bash
rtl_sdr -f 869525000 -s 2048000 -g 40 - > meshtastic-sample.cu8
# Stop once at least 1-3 packets are transmitted from the node.
# Trim to < 5 MB if necessary using `head -c 5242880` or with sox.
```

**Option B (synthesized):** Use gr-lora_sdr's TX flowgraph to generate a Meshtastic packet from a known node ID, encrypt with the default PSK, modulate to cf32, and quantize to cu8. Document the exact generation command in `fixtures/lora/README.md` (Step 3).

- [ ] **Step 2: Confirm the fixture size.**

```bash
ls -la fixtures/lora/meshtastic-sample.cu8
# Expected: size < 5 MB.
```

- [ ] **Step 3: Write the expected-events sidecar.**

For each packet you expect the decoder to emit, write one JSON object per line to `fixtures/lora/meshtastic-sample.expected.jsonl` matching the wire shape in spec design §5.1. Include at minimum: `from`, `id`, `portnum`, `payload_b64`. Example:

```json
{"from":3735928559,"to":4294967295,"id":1234567890,"channel":8,"hop_limit":3,"hop_start":3,"want_ack":false,"portnum":1,"payload_b64":"SGVsbG8gV29ybGQ=","payload_len":11,"rx_rssi":-95,"rx_snr":6.5,"rx_time":"2026-05-15T12:34:56.789Z","frequency":869525000,"bw":250000,"sf":11,"cr":5}
```

- [ ] **Step 4: Write `fixtures/lora/README.md`** with provenance + regeneration command. Include: SHA of gr-lora_sdr used (if synthesized), node ID, channel key, expected packet count.

- [ ] **Step 5: Commit.**

```bash
git add fixtures/lora/
git commit -m "test(lora): add Meshtastic fixture + expected events sidecar"
```

_Requirements: 8.1._

---

### Task 12: Integration test — fixture replay

**Files:**
- Create: `tests/integration/lora-meshtastic.test.ts`

- [ ] **Step 1: Write the test.**

```ts
/**
 * LoRa/Meshtastic integration test — fixture replay via recording source.
 *
 * Skipped automatically when /usr/local/bin/lora_meshtastic_decode.py is
 * absent (e.g., local dev hosts without gr-lora_sdr). Runs inside the
 * Docker image and in CI environments that build the image.
 */
import { describe, it, expect } from "vitest"
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import pino from "pino"
import { SourceManager } from "../../src/core/source-manager.js"
import { FanoutManager } from "../../src/core/fanout-manager.js"
import { DecoderManager } from "../../src/decoders/manager.js"
import { DecoderRegistry } from "../../src/decoders/registry.js"
import {
	createLoraMeshtasticDecoder,
	LORA_MESHTASTIC_CAPS,
} from "../../src/decoders/builtin/lora-meshtastic.js"
import type { DecoderOutput } from "../../src/decoders/types.js"

const WRAPPER_PATH = "/usr/local/bin/lora_meshtastic_decode.py"
const FIXTURE_PATH = resolve("fixtures/lora/meshtastic-sample.cu8")
const EXPECTED_PATH = resolve("fixtures/lora/meshtastic-sample.expected.jsonl")

const runIntegration = existsSync(WRAPPER_PATH) && existsSync(FIXTURE_PATH)

describe.skipIf(!runIntegration)("lora-meshtastic integration", () => {
	it("emits at least one meshtastic event matching the expected sidecar", async () => {
		const logger = pino({ level: "silent" })
		const registry = new DecoderRegistry()
		registry.register(
			"lora-meshtastic",
			createLoraMeshtasticDecoder,
			LORA_MESHTASTIC_CAPS,
		)

		const sourceManager = new SourceManager(logger)
		const fanoutManager = new FanoutManager(logger)
		const decoderManager = new DecoderManager(registry, fanoutManager, logger)

		await sourceManager.addSource({
			id: "fixture-iq",
			type: "recording",
			filePath: FIXTURE_PATH,
			loop: false,
			playbackSpeed: 1.0,
			caps: {
				kind: "iq",
				sampleRate: 2_048_000,
				format: "U8_IQ",
				exclusive: false,
			},
		})

		decoderManager.createDecoder({
			id: "fixture-lora",
			type: "lora-meshtastic",
			enabled: true,
			sourceId: "fixture-iq",
			options: {
				region: "EU_868",
				preset: "LongFast",
				frequency: 869_525_000,
				channelKey: "AQ==",
			},
		})

		const events: DecoderOutput[] = []
		decoderManager.on("output", out => events.push(out))

		await decoderManager.start()
		// Let the recording play out + give the wrapper a few seconds to drain.
		await new Promise(r => setTimeout(r, 10_000))
		await decoderManager.stopAll()

		const meshEvents = events.filter(e => e.type === "meshtastic")
		expect(meshEvents.length).toBeGreaterThan(0)

		const expected = readFileSync(EXPECTED_PATH, "utf8")
			.trim()
			.split("\n")
			.map(line => JSON.parse(line) as Record<string, unknown>)

		// Match at least one expected packet on (from, id, portnum, payload_b64).
		const expectedHeaders = expected.map(e => ({
			from: e["from"],
			id: e["id"],
			portnum: e["portnum"],
			payload_b64: e["payload_b64"],
		}))
		const matched = meshEvents.some(ev => {
			const d = ev.data as Record<string, unknown>
			return expectedHeaders.some(
				h =>
					h.from === d["from"] &&
					h.id === d["id"] &&
					h.portnum === d["portnum"] &&
					h.payload_b64 === d["payloadB64"],
			)
		})
		expect(matched).toBe(true)
	}, 20_000)
})
```

- [ ] **Step 2: Verify the test compiles and skips gracefully on the dev host.**

Run: `pnpm exec vitest run tests/integration/lora-meshtastic.test.ts`
Expected: on a dev host without the wrapper, the describe block is skipped (vitest reports skipped, exit 0).

- [ ] **Step 3: Commit.**

```bash
git add tests/integration/lora-meshtastic.test.ts
git commit -m "test(lora): add fixture-replay integration test (skipped without wrapper)"
```

_Requirements: 8.2._

> **CHECKPOINT — STOP HERE.**
>
> Run `pnpm test` and confirm all unit + integration tests pass on the dev host. Then run `make dev-up` and exec into the container to run `pnpm test` inside the image — the integration test should run (not skip) and pass against the fixture. Do NOT proceed to the smoke test until both contexts are green.

---

## Config + docs

### Task 13: Add the commented-out example to `config/default.yaml`

**Files:**
- Modify: `config/default.yaml` (under "EXAMPLE: Multi-Source Setup", near the existing decoder examples around line 374-440)

- [ ] **Step 1: Insert the example block** alongside the other commented decoder examples. Choose a placement just below the AIS decoder example (or the most natural neighbour in your tree).

```yaml
#   # -------------------------------------------------------------------------
#   # LoRa/Meshtastic (pure_consumer pattern - shares iq source with rtl_433)
#   # NOTE: Strongly recommend a TCXO RTL-SDR (e.g. RTL-SDR Blog v3) — LoRa is
#   # narrow-band and standard crystals drift several kHz once warm.
#   # -------------------------------------------------------------------------
#   - id: "meshtastic-eu"
#     type: "lora-meshtastic"
#     enabled: true
#     sourceId: "iq-868"   # Can be shared with rtl_433 on the same 868 MHz dongle
#     options:
#       region: "EU_868"
#       preset: "LongFast"
#       frequency: 869525000       # EU_868 Meshtastic primary
#       channelKey: "AQ=="         # Default channel shorthand
```

- [ ] **Step 2: Commit.**

```bash
git add config/default.yaml
git commit -m "docs(config): add commented-out lora-meshtastic example"
```

_Requirements: 11.1, 11.2, 11.3._

---

### Task 14: Update `docs/DECODER-GUIDE.md` output-types table

**Files:**
- Modify: `docs/DECODER-GUIDE.md` (the Output Types table around lines 367-380)

- [ ] **Step 1: Add a row** for `meshtastic` inside the table:

```markdown
| `meshtastic` | Meshtastic LoRa packet | `lora-meshtastic` |
```

Place it alphabetically below `acars` and above `vdl2`, or wherever the existing rows are ordered.

- [ ] **Step 2: Commit.**

```bash
git add docs/DECODER-GUIDE.md
git commit -m "docs(decoders): document meshtastic output type"
```

_Requirements: 5.1._

---

## Manual smoke test (post-merge)

### Task 15: Live smoke test on a Raspberry Pi 4 with TCXO RTL-SDR

This is a manual gate, not a code task. Record the outcome in the PR description.

- [ ] **Step 1: Configure a `lora-meshtastic` decoder for the local region.**

Edit `config/default.yaml` (or a dev variant) to enable a real `lora-meshtastic` decoder. Set `region` (`EU_868` LongFast in EU, `US` LongFast in US), `frequency` to the regional Meshtastic primary, `channelKey: "AQ=="`.

- [ ] **Step 2: Start WaveKit and subscribe to the decoders channel.**

```bash
make dev-up
make dev-logs &
wscat -c ws://localhost:9000/ws # subscribe to {"channel":"decoders"}
```

- [ ] **Step 3: Verify behaviour.**

- At least one event with `type: "meshtastic"` within 5 minutes on a known-busy preset.
- Decoder health transitions to `running`.
- CPU usage stays within comfortable headroom alongside other decoders (record approx % in PR).

If no packets arrive within 15 minutes, verify the antenna + TCXO setup before concluding a code issue.

_Requirements: 8.4._

---

## Non-negotiables (verify before raising the PR)

- [ ] No raw-LoRa or LoRaWAN code paths.
- [ ] `IqDecimateDecoder` not modified — verify with `git diff main -- src/decoders/iq-decimate-decoder.ts`.
- [ ] No Meshtastic decryption or protobuf parsing in TypeScript — verify with `grep -rni "encrypted\\|aes\\|protobuf\\|mesh_pb2" src/`.
- [ ] All Meshtastic config in per-decoder options bag; top-level `DecoderConfigSchema` unchanged — verify with `git diff main -- src/config.ts`.
- [ ] `type: "meshtastic"` is the only emitted type — verify by grep on `parseOutput` body.
- [ ] No new network port; JSONL on stdout only.
- [ ] No `console.log` in production code — verify with `grep -rn "console.log" src/decoders/builtin/lora-meshtastic.ts`.
- [ ] No bare `Error` thrown from feature code.
- [ ] No `any`; strict TS settings respected — `pnpm run typecheck` clean.
- [ ] No floating promises (`void` used to explicitly discard) — `pnpm run lint` clean.
- [ ] Relative imports end in `.js`; `import type` for type-only imports.
- [ ] Tabs, no semicolons, single-arg arrows without parens — Prettier passes.
- [ ] Pino logger via `createComponentLogger(...)`.
- [ ] All external data validated with Zod at the boundary.
- [ ] `parseOutput` does not throw — covered by Property 4 test.

---

## Spec questions

The following items were flagged during plan writing as worth surfacing — not blockers, but the implementer should validate.

1. **gr-lora_sdr API stability.** The wrapper in Task 8 hooks `lora_sdr.frame_sync`, `fft_demod`, etc., with positional ctor arguments. Upstream has refactored these blocks across releases. Task 9 pins an `ARG GR_LORA_SDR_REF` — the implementer must pick a specific commit at implementation time and verify the wrapper's block names and ctor signatures match. If they do not, the wrapper imports will fail at runtime and the integration test will surface it.

2. **`mesh_pb2.py` portnums dependency.** Vendoring `mesh.proto` only (Req 10.3) is tricky because the generated `mesh_pb2.py` references `portnums_pb2`, `config_pb2`, etc. The plan's Task 7 says to strip these references. The exact strip is generation-dependent — the implementer needs to confirm `MeshPacket.decoded.portnum` is exposed as a plain int (not a `portnums_pb2.PortNum` enum) once stripped. If the dependency cannot be cleanly removed, the alternative is to vendor empty stubs for the sibling protos at the same upstream SHA — still consistent with Req 10.3's "only `mesh.proto`'s compiled output" because only `mesh.proto` content is *meaningful* in the bundle.

3. **`MeshPacket` field naming in protobuf Python.** Python protobuf renames `from` to `from_` because `from` is a reserved keyword. The wrapper (Task 8) reads `mp.from_` for that reason. Confirm the generated `mesh_pb2.py` does the same renaming — older protobuf compiler versions did, current `protoc` versions still do.

4. **`hop_start` field availability.** Older Meshtastic firmware may not populate `hop_start`. The wrapper treats it as required (per spec §4.1). If the fixture lacks `hop_start`, either the wrapper should default it to `hop_limit` or the spec should be amended to make it optional. Recommend: keep required, fail-loud if missing.

5. **Integration test recording-source format.** The plan assumes `format: "U8_IQ"` is a valid `caps.format` value for `recording` sources. Verify against `src/config.ts`'s `SourceCaps` schema — if the canonical enum value is `"CU8"` or something different, fix the integration test to match before Task 12 lands.

These are pure clarification questions — none of them require redesigning the feature.
