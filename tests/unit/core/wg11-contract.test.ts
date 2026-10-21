/**
 * WG11 frozen contract (docs/specs/web-gaps-11, task 0.1): the `heard` trial outcome and the
 * `replay` transports (CLI guard first); stable frame track fields; the `config` tuner command
 * origin; per-source tuner config, passive cost limit and IQ capture config; the passive cost,
 * IQ capture and track identity contract modules. No behaviour beyond defaults.
 */
import type { Readable } from "node:stream"
import { describe, expect, it } from "vitest"
import type * as Api from "@wavekit/api-types"
import { SPECTRUM_FRAME_TRACK_MAX_EXTRA_BYTES } from "@wavekit/api-types"
import {
	ScannerConfigSchema,
	SourceConfigSchema,
	SourceTunerConfigSchema,
} from "../../../src/config.js"
import {
	PASSIVE_COST_CLEAR_RATIO,
	PASSIVE_COST_LIMIT_DEFAULT,
	PASSIVE_COST_RECHECK_MS,
	PASSIVE_COST_WINDOW_MS,
	type PassiveCostDecision,
	type PassiveCostInput,
} from "../../../src/core/scanner/passive-cost-contract.js"
import {
	IDENTIFY_REPLAY_MAX_CAPTURES,
	IQ_CAPTURE_BYTES_PER_SAMPLE,
	IQ_CAPTURE_CONTROL_LINE_MAX_BYTES,
	IQ_CAPTURE_DIR,
	IQ_CAPTURE_FILE_PATTERN,
	IQ_CAPTURE_MAX_BYTES,
	IQ_CAPTURE_MAX_CONCURRENT,
	IQ_CAPTURE_MAX_MS,
	IQ_CAPTURE_PER_SOURCE_PER_MINUTE,
	IQ_CAPTURE_PREROLL_MAX_MS,
	IQ_CAPTURE_RATE_HZ,
	IQ_CAPTURE_ORPHAN_TTL_MS,
	IQ_CAPTURE_TOTAL_MAX_BYTES,
	IQ_REPLAY_MAX_PROBES,
	IQ_REPLAY_MAX_TRIALS,
	IQ_REPLAY_PROBE_CORES,
	type IqCapturePort,
	type IqCaptureRefusal,
	type IqCaptureView,
	type IqCaptureDiscardReason,
	type IqReplayPlanner,
	type IqReplayResult,
	type IqReplaySink,
} from "../../../src/core/scanner/iq-capture-contract.js"
import {
	KNOWN_PROTOCOL_MAX_MISSES,
	type KnownProtocolMemory,
} from "../../../src/core/scanner/known-protocol-contract.js"
import type { ProbeTransport } from "../../../src/core/scanner/probes/probe-pool.js"
import type { SpectrumTrackIdentityLookup } from "../../../src/core/spectrum/track-identity-contract.js"
import {
	guardScan,
	guardSpectrumFrame,
} from "../../../cli/source/data/scanner-guards.js"
import { SCAN_FRAME, SCAN_JOB } from "../../../cli/source/test/fixtures.js"

type Same<A, B> =
	(<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
		? true
		: false
const same = <A, B>(value: Same<A, B>): Same<A, B> => value

describe("WG11 contract: identify outcomes and transports", () => {
	it("adds heard to the outcome list and replay to both transports", () => {
		expect(
			same<
				Api.ScannerTrialOutcome,
				| "pending"
				| "running"
				| "decoded"
				| "no-sync"
				| "crc-errors"
				| "timeout"
				| "skipped-budget"
				| "unsupported"
				| "not-needed"
				| "cancelled"
				| "heard"
				// WG12: analog replay trial outcomes
				| "data-like"
				| "carrier-only"
			>(true),
		).toBe(true)
		expect(
			same<
				Api.ScannerIdentifyTrial["transport"],
				"offset" | "channel" | "ambient" | "replay" | null
			>(true),
		).toBe(true)
		expect(
			same<Api.ScanJobProbe["transport"], "offset" | "channel" | "replay">(
				true,
			),
		).toBe(true)
		expect(same<ProbeTransport, "offset" | "channel" | "replay">(true)).toBe(
			true,
		)
		// The identify state list is unchanged.
		expect(
			same<
				Api.ScannerIdentifyState,
				| "waiting-for-signal"
				| "trying"
				| "identified"
				| "candidate"
				| "unidentified"
			>(true),
		).toBe(true)
	})

	it("is accepted by the CLI identify guard (heard, replay trial and replay probe)", () => {
		const target = SCAN_JOB.identify!.targets[0]!
		const trial = target.trials[0]!
		const job = {
			...SCAN_JOB,
			progress: {
				...SCAN_JOB.progress,
				probes: [
					{
						probeId: "p1",
						decoderId: "d1",
						targetHz: 446_006_250,
						protocol: "nxdn48",
						transport: "replay",
						state: "confirming",
					},
				],
			},
			identify: {
				...SCAN_JOB.identify!,
				targets: [
					{
						...target,
						state: "candidate",
						trials: [
							{
								...trial,
								protocol: "analog-fm",
								decoder: "live-audio",
								mode: "nfm",
								transport: "ambient",
								outcome: "heard",
							},
							{
								...trial,
								protocol: "nxdn48",
								decoder: "dsd-fme",
								mode: "nxdn48",
								transport: "replay",
								outcome: "decoded",
							},
						],
					},
				],
			},
		}
		const parsed = guardScan("job", job)
		expect(parsed).toBeDefined()
		expect(parsed?.identify?.targets[0]?.trials.map(t => t.outcome)).toEqual([
			"heard",
			"decoded",
		])
		expect(parsed?.progress.probes[0]?.transport).toBe("replay")
	})
})

describe("WG11 contract: stable frame tracks", () => {
	const full: Api.SpectrumFrameTrack = {
		startHz: 446_000_000,
		endHz: 446_012_500,
		flags: { burst: false, iqImage: false, edge: false, spur: false },
		trackId: "t-0000000000000001",
		snrDb: -100.5,
		peakDbfs: -120.5,
		blocks: 2_000_000_000,
		ageMs: 2_000_000_000,
		surfaced: false,
		scanner: {
			discoveryId: "00000000-0000-4000-8000-000000000000",
			protocol: "digital-unknown",
			confidence: "classified",
		},
	}

	it("keeps every new field optional", () => {
		type Optional<K extends keyof Api.SpectrumFrameTrack> =
			undefined extends Api.SpectrumFrameTrack[K] ? true : false
		for (const ok of [
			same<Optional<"trackId">, true>(true),
			same<Optional<"snrDb">, true>(true),
			same<Optional<"peakDbfs">, true>(true),
			same<Optional<"blocks">, true>(true),
			same<Optional<"ageMs">, true>(true),
			same<Optional<"surfaced">, true>(true),
			same<Optional<"scanner">, true>(true),
		])
			expect(ok).toBe(true)
		const old: Api.SpectrumFrameTrack = {
			startHz: 1,
			endHz: 2,
			flags: { burst: false, iqImage: false, edge: false },
		}
		expect(old.trackId).toBeUndefined()
		expect(
			same<Api.SpectrumFrameEventData["tracks"], Api.SpectrumFrameTrack[]>(
				true,
			),
		).toBe(true)
		expect(
			same<
				Api.SpectrumFrameTrackScanner,
				{
					discoveryId: string
					protocol: Api.ScannerProtocol
					confidence: Api.ScannerConfidence
				}
			>(true),
		).toBe(true)
	})

	it("bounds the per-track growth (260 B with every field at a long value)", () => {
		const base = JSON.stringify({
			startHz: full.startHz,
			endHz: full.endHz,
			flags: { burst: false, iqImage: false, edge: false },
		})
		const grown = JSON.stringify(full)
		expect(grown.length - base.length).toBeLessThanOrEqual(
			SPECTRUM_FRAME_TRACK_MAX_EXTRA_BYTES,
		)
		expect(SPECTRUM_FRAME_TRACK_MAX_EXTRA_BYTES).toBe(260)
	})

	it("is accepted by the CLI frame guard, 256 tracks included", () => {
		const one = guardSpectrumFrame({ ...SCAN_FRAME, tracks: [full] })
		expect(one).toBeDefined()
		const many = guardSpectrumFrame({
			...SCAN_FRAME,
			tracks: Array.from({ length: 256 }, () => full),
		})
		expect(many?.tracks).toHaveLength(256)
	})

	it("types the identity lookup port", () => {
		const lookup: SpectrumTrackIdentityLookup = (sourceId, trackId) =>
			sourceId === "rtl" && trackId === "t1" ? full.scanner! : null
		expect(lookup("rtl", "t1")?.confidence).toBe("classified")
		expect(lookup("other", "t1")).toBeNull()
	})
})

describe("WG11 contract: tuner config and command origin", () => {
	it("adds the config origin", () => {
		expect(
			same<
				Api.TunerCommandOrigin,
				"rest" | "scanner" | "replay" | "config" | "decoder-rate"
			>(true),
		).toBe(true)
	})

	it("validates the per-source tuner config", () => {
		expect(
			SourceTunerConfigSchema.parse({
				gainMode: "manual",
				gainDb: 49.6,
				agcMode: false,
			}),
		).toEqual({ gainMode: "manual", gainDb: 49.6, agcMode: false })
		expect(SourceTunerConfigSchema.parse({ gainMode: "agc" })).toEqual({
			gainMode: "agc",
		})
		for (const bad of [
			{ gainMode: "manual" },
			{ gainMode: "agc", gainDb: 20 },
			{ gainMode: "manual", gainDb: 50.1 },
			{ gainMode: "manual", gainDb: -0.1 },
			{ gainMode: "manual", gainDb: 49.65 },
			{ gainMode: "manual", gainDb: 10, extra: true },
			{ gainMode: "auto" },
		])
			expect(SourceTunerConfigSchema.safeParse(bad).success).toBe(false)
		// 50 dB is the tuner controller's gain bound (500 tenths).
		expect(
			SourceTunerConfigSchema.safeParse({ gainMode: "manual", gainDb: 50 })
				.success,
		).toBe(true)
	})

	it("leaves a source without tuner unchanged", () => {
		const source = SourceConfigSchema.parse({
			id: "rtl",
			type: "rtl_tcp",
			host: "127.0.0.1",
			port: 1234,
			caps: { kind: "iq", sampleRate: 2_048_000, format: "U8_IQ" },
		})
		expect("tuner" in source).toBe(false)
	})
})

describe("WG11 contract: passive cost and IQ capture config", () => {
	it("parses the shipped scanner config without the new keys", () => {
		const parsed = ScannerConfigSchema.parse({})
		expect("maxEngineUtilization" in parsed.passive).toBe(false)
		expect("iqCapture" in parsed).toBe(false)
	})

	it("bounds the passive limit and pins the guard constants", () => {
		const ok = ScannerConfigSchema.parse({
			passive: { maxEngineUtilization: 0.5 },
		})
		expect(ok.passive.maxEngineUtilization).toBe(0.5)
		for (const v of [0.04, 1.01])
			expect(
				ScannerConfigSchema.safeParse({ passive: { maxEngineUtilization: v } })
					.success,
			).toBe(false)
		expect(PASSIVE_COST_LIMIT_DEFAULT).toBe(0.25)
		expect(PASSIVE_COST_WINDOW_MS).toBe(60_000)
		// 5 minutes: at most 12 reads per source per hour; one utilization read each.
		expect(PASSIVE_COST_RECHECK_MS).toBe(300_000)
		expect(PASSIVE_COST_RECHECK_MS / PASSIVE_COST_WINDOW_MS).toBe(5)
		// Hysteresis: the default clears at or below 0.2 of a core.
		expect(PASSIVE_COST_CLEAR_RATIO).toBe(0.8)
		expect(PASSIVE_COST_LIMIT_DEFAULT * PASSIVE_COST_CLEAR_RATIO).toBeCloseTo(
			0.2,
		)
		const input: PassiveCostInput = {
			utilization: null,
			limit: PASSIVE_COST_LIMIT_DEFAULT,
			disabled: false,
			sinceOpenMs: null,
			sinceLastCheckMs: null,
		}
		const decisions: PassiveCostDecision[] = ["disable", "clear", "keep"]
		expect(input.utilization).toBeNull()
		expect(decisions).toHaveLength(3)
	})

	it("fills IQ capture defaults only when the object is present, within the contract bounds", () => {
		const parsed = ScannerConfigSchema.parse({ iqCapture: {} })
		expect(parsed.iqCapture).toEqual({
			enabled: false,
			maxTotalMb: 256,
			maxCaptureMs: 4000,
			preRollMs: 500,
			binaryPath: "wavekit-iqcap",
			// WG12: filled only when the object is present. Absent iqCapture stays omitted.
			allowLegacy: false,
		})
		for (const bad of [
			{ maxTotalMb: 257 },
			{ maxTotalMb: 15 },
			{ maxCaptureMs: 4001 },
			{ maxCaptureMs: 499 },
			{ preRollMs: 2001 },
			{ binaryPath: "" },
			{ unknown: true },
		])
			expect(ScannerConfigSchema.safeParse({ iqCapture: bad }).success).toBe(
				false,
			)
		expect(256 * 1024 * 1024).toBe(IQ_CAPTURE_TOTAL_MAX_BYTES)
		expect(4000).toBe(IQ_CAPTURE_MAX_MS)
		expect(2000).toBe(IQ_CAPTURE_PREROLL_MAX_MS)
		const settings: Api.ScannerIqCaptureSettings = parsed.iqCapture!
		expect(settings.enabled).toBe(false)
	})
})

describe("WG11 contract: IQ capture bounds and port", () => {
	it("pins the capture constants with their arithmetic", () => {
		expect(IQ_CAPTURE_RATE_HZ).toBe(48_000)
		expect(IQ_CAPTURE_BYTES_PER_SAMPLE).toBe(8)
		// 4 s × 48 000 samples/s × 8 B (cf32).
		expect(IQ_CAPTURE_MAX_BYTES).toBe(1_536_000)
		expect(IQ_CAPTURE_MAX_BYTES).toBe(
			(IQ_CAPTURE_MAX_MS / 1000) *
				IQ_CAPTURE_RATE_HZ *
				IQ_CAPTURE_BYTES_PER_SAMPLE,
		)
		// 256 MiB holds 174 full captures.
		expect(Math.floor(IQ_CAPTURE_TOTAL_MAX_BYTES / IQ_CAPTURE_MAX_BYTES)).toBe(
			174,
		)
		// 6 per minute per source: at most 9.216 MB of disk per minute per source.
		expect(IQ_CAPTURE_PER_SOURCE_PER_MINUTE * IQ_CAPTURE_MAX_BYTES).toBe(
			9_216_000,
		)
		// The native ring: 2 s of CU8 at 2.048 Msps is 8 192 000 B (2 B per sample).
		expect((IQ_CAPTURE_PREROLL_MAX_MS / 1000) * 2_048_000 * 2).toBe(8_192_000)
		// Discarded at its result; an orphan (no result) after 10 minutes. At 6 per minute per
		// source a full orphan backlog is 60 captures (92 MB), inside the 256 MiB cap.
		expect(IQ_CAPTURE_ORPHAN_TTL_MS).toBe(10 * 60 * 1000)
		expect(
			(IQ_CAPTURE_ORPHAN_TTL_MS / 60_000) *
				IQ_CAPTURE_PER_SOURCE_PER_MINUTE *
				IQ_CAPTURE_MAX_BYTES,
		).toBeLessThan(IQ_CAPTURE_TOTAL_MAX_BYTES)
		expect(IQ_REPLAY_MAX_TRIALS).toBe(8)
		expect(IQ_CAPTURE_MAX_CONCURRENT).toBe(2)
		expect(IQ_CAPTURE_DIR).toBe("iq-captures")
		expect(IQ_CAPTURE_CONTROL_LINE_MAX_BYTES).toBe(4096)
		expect(IQ_REPLAY_MAX_PROBES).toBe(1)
		expect(IQ_REPLAY_PROBE_CORES).toBe(0.15)
		expect(IDENTIFY_REPLAY_MAX_CAPTURES).toBe(2)
	})

	it("accepts only uuid v4 capture file names", () => {
		for (const ok of [
			"00000000-0000-4000-8000-000000000000.cf32",
			"0123abcd-ef01-4abc-9def-0123456789ab.cf32",
		])
			expect(IQ_CAPTURE_FILE_PATTERN.test(ok)).toBe(true)
		for (const bad of [
			"00000000-0000-4000-8000-000000000000.cf32.tmp",
			"00000000-0000-1000-8000-000000000000.cf32",
			"00000000-0000-4000-7000-000000000000.cf32",
			"0123ABCD-EF01-4ABC-9DEF-0123456789AB.cf32",
			"../00000000-0000-4000-8000-000000000000.cf32",
			"00000000-0000-4000-8000-000000000000.wav",
			".cf32",
			"",
		])
			expect(IQ_CAPTURE_FILE_PATTERN.test(bad)).toBe(false)
	})

	it("types the capture port", () => {
		const view: IqCaptureView = {
			captureId: "00000000-0000-4000-8000-000000000000",
			sourceId: "rtl",
			observationId: null,
			epoch: 3,
			rfHz: 446_006_250,
			tuningTrust: "commanded",
			capturedAtMs: 0,
			durationMs: 4000,
			gapSamples: 0,
		}
		const refusals: IqCaptureRefusal[] = [
			"disabled",
			"not-protected",
			"unavailable",
			"rate-limited",
			"busy",
			"full",
			"epoch-changed",
			"invalid",
		]
		const port: IqCapturePort = {
			near: () => [view],
			capture: () => ({ refused: "disabled" }),
			end: () => undefined,
			claim: () => false,
			settle: () => undefined,
			confirmLive: () => 0,
			openReplay: (): Readable | null => null,
		}
		expect(
			port.near("rtl", 446_006_250, 1000, { observationId: null, limit: 2 }),
		).toHaveLength(1)
		expect(
			port.capture({
				sourceId: "rtl",
				observationId: null,
				epoch: 3,
				rfHz: 446_006_250,
				tuningTrust: "commanded",
				fromSample: 0,
				reason: "detection",
			}),
		).toEqual({ refused: "disabled" })
		expect(port.openReplay(view.captureId, "dsd-fme")).toBeNull()
		expect(refusals).toHaveLength(8)
		const reasons: IqCaptureDiscardReason[] = [
			"result",
			"confirmed-live",
			"orphan-ttl",
			"invalid",
			"shutdown",
		]
		expect(reasons).toHaveLength(5)
	})

	it("types the replay queue planner and result sink (capture → queue → trials → result → discard)", () => {
		const planner: IqReplayPlanner = input =>
			input.knownProtocol === "dmr"
				? [
						{
							protocol: "dmr",
							mode: {
								decoderType: "dsd-fme",
								protocol: "dmr",
								options: { mode: "auto" },
								covers: ["dmr"],
								holdMs: 1800,
							},
							known: true,
						},
					]
				: []
		const trials = planner({
			capture: {
				captureId: "00000000-0000-4000-8000-000000000000",
				sourceId: "rtl",
				observationId: "o1",
				epoch: 1,
				rfHz: 446_006_250,
				tuningTrust: "commanded",
				capturedAtMs: 0,
				durationMs: 4000,
				gapSamples: 0,
			},
			track: null,
			knownProtocol: "dmr",
			priors: {},
			narrowRaster: true,
		})
		expect(trials[0]?.known).toBe(true)
		const results: IqReplayResult[] = []
		const sink: IqReplaySink = r => results.push(r)
		sink({
			captureId: "00000000-0000-4000-8000-000000000000",
			sourceId: "rtl",
			observationId: "o1",
			epoch: 1,
			trials: [
				{
					protocol: "dmr",
					decoderType: "dsd-fme",
					known: true,
					outcome: "no-sync",
				},
			],
			decoded: null,
		})
		expect(results).toHaveLength(1)
	})

	it("pins the known-protocol memory", () => {
		// Two consecutive full-hold misses: one bad transmission never drops the prior, two do.
		expect(KNOWN_PROTOCOL_MAX_MISSES).toBe(2)
		const misses = new Map<string, number>()
		const memory: KnownProtocolMemory = {
			known: id =>
				(misses.get(id) ?? 0) < KNOWN_PROTOCOL_MAX_MISSES ? "dmr" : null,
			recordMiss: id => void misses.set(id, (misses.get(id) ?? 0) + 1),
			recordDecode: id => void misses.delete(id),
			forget: id => void misses.delete(id),
		}
		memory.recordMiss("d1", "dmr")
		expect(memory.known("d1")).toBe("dmr")
		memory.recordMiss("d1", "dmr")
		expect(memory.known("d1")).toBeNull()
		memory.recordDecode("d1")
		expect(memory.known("d1")).toBe("dmr")
	})
})
