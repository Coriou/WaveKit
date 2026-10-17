/**
 * WG10 frozen contract (docs/specs/web-gaps-10, task 0.1): identify analog evidence and the
 * unavailable decoder list; spectrum warning suspects; storage kept totals; live audio silence and
 * swap bounds; recording delete progress names, sweep and alias bounds, keep totals and the
 * scanner deleter port; the identify analog evidence port. No behaviour beyond defaults.
 */
import { describe, expect, it } from "vitest"
import type * as Api from "@wavekit/api-types"
import {
	IDENTIFY_ANALOG_LOOKBACK_MS,
	IDENTIFY_ANALOG_MAX_TRANSMISSIONS,
	LIVE_AUDIO_FRONT_SWAP_TIMEOUT_MS,
	LIVE_AUDIO_NOISE_QUIETING_DB,
	LIVE_AUDIO_SILENCE_CHUNK_MS,
	LIVE_AUDIO_SILENCE_FILL_MAX_MS,
	PROBE_UNAVAILABLE_MEMO_MS,
	RECORDING_ERROR_STATUS,
	RECORDING_KEEPS_MAX_BYTES,
	RECORDING_KEEPS_MAX_ENTRIES,
	SPECTRUM_WARNING_LOG_INTERVAL_MS,
} from "@wavekit/api-types"
import {
	DISCOVERY_RECORDING_ALIASES_MAX,
	RECORDING_DELETE_PRIVATE_DIR,
	RECORDING_DELETE_SWEEP_MAX_DIRS,
	RECORDING_DELETE_VERIFIED_NAME,
	RECORDING_KEEP_KEY,
	type RecordingDeleteSweepResult,
	type RecordingKeepTotals,
	type RecordingKeepTotalsSource,
	type ScannerRecordingDeleter,
} from "../../../src/core/recordings/contract.js"
import type {
	AnalogEvidenceTransmission,
	IdentifyAnalogEvidence,
} from "../../../src/core/scanner/identify-analog-contract.js"
import { guardScan } from "../../../cli/source/data/scanner-guards.js"
import { SCAN_JOB } from "../../../cli/source/test/fixtures.js"

type Same<A, B> =
	(<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
		? true
		: false
const same = <A, B>(value: Same<A, B>): Same<A, B> => value

describe("WG10 contract: identify analog evidence and unavailable decoders", () => {
	it("widens trial decoder and reason, keeps the state list (WG11 adds the heard outcome)", () => {
		type Decoder = Api.ScannerIdentifyTrial["decoder"]
		expect(
			same<
				Decoder,
				| "dsd-fme"
				| "multimon-ng"
				| "direwolf"
				| "rtl433"
				| Api.ScannerAmbientDecoderType
				| "live-audio"
				| null
			>(true),
		).toBe(true)
		type Reason = NonNullable<Api.ScannerIdentifyTrial["reason"]>
		expect(
			same<
				Reason,
				| "no-decoder"
				| "needs-channelizer"
				| "unsupported-format"
				| "no-ambient-decoder"
				| "decoder-unavailable"
				| "no-live-audio"
			>(true),
		).toBe(true)
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
				// WG11 req 1.1: an analog squelch opening without a tone or code
				| "heard"
			>(true),
		).toBe(true)
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

	it("pins the analog evidence and memo bounds with their arithmetic", () => {
		// 32 transmissions: a PTT every ~1 s for the whole 30 s lookback still fits.
		expect(IDENTIFY_ANALOG_MAX_TRANSMISSIONS).toBe(32)
		expect(IDENTIFY_ANALOG_LOOKBACK_MS).toBe(30_000)
		expect(IDENTIFY_ANALOG_MAX_TRANSMISSIONS * 1000).toBeGreaterThanOrEqual(
			IDENTIFY_ANALOG_LOOKBACK_MS,
		)
		// 5 minutes: twenty 15 s identify jobs reuse one observed failure.
		expect(PROBE_UNAVAILABLE_MEMO_MS).toBe(300_000)
		expect(PROBE_UNAVAILABLE_MEMO_MS / 15_000).toBe(20)
		expect(
			same<
				Api.ScannerProbeDecoderType,
				"dsd-fme" | "multimon-ng" | "direwolf" | "rtl433"
			>(true),
		).toBe(true)
	})

	it("shapes the analog result and keeps both new result fields optional", () => {
		const analog: Api.ScannerIdentifyAnalog = {
			source: "live-audio",
			modulation: "nfm",
			transmissions: 2,
			transmissionId: "00000000-0000-4000-8000-000000000000",
			ctcssHz: 67,
			dcs: null,
			tuningTrust: "commanded",
		}
		const result: Api.ScannerIdentifyResult = {
			protocol: "analog-fm",
			confidence: "classified",
			metadata: {
				talkgroups: [],
				sources: [],
				slots: [],
				callsigns: [],
				capcodes: [],
				ismModels: [],
				ctcssHz: 67,
			},
			measurements: {
				source: "spectrum",
				centreHz: 446_156_250,
				obwHz: null,
				peakDbfs: null,
				snrDb: null,
				floorDbfs: null,
				dutyCycle: null,
				class: "unknown",
			},
			analog,
			decodersUnavailable: ["dsd-fme"],
		}
		expect(result.analog?.ctcssHz).toBe(67)
		type Optional<K extends keyof Api.ScannerIdentifyResult> =
			undefined extends Api.ScannerIdentifyResult[K] ? true : false
		expect(same<Optional<"analog">, true>(true)).toBe(true)
		expect(same<Optional<"decodersUnavailable">, true>(true)).toBe(true)
	})

	it("is accepted by the CLI identify guard (closed outcome list; WG11 adds heard)", () => {
		const target = SCAN_JOB.identify!.targets[0]!
		const job = {
			...SCAN_JOB,
			identify: {
				...SCAN_JOB.identify!,
				targets: [
					{
						...target,
						state: "identified",
						trials: [
							{
								protocol: "analog-fm",
								decoder: "live-audio",
								mode: "nfm",
								transport: "ambient",
								outcome: "decoded",
							},
							{
								protocol: "dmr",
								decoder: "dsd-fme",
								mode: null,
								transport: null,
								outcome: "unsupported",
								reason: "decoder-unavailable",
							},
							{
								protocol: "analog-am",
								decoder: "live-audio",
								mode: null,
								transport: null,
								outcome: "unsupported",
								reason: "no-live-audio",
							},
						],
						result: {
							...target.result!,
							protocol: "analog-fm",
							confidence: "classified",
							analog: {
								source: "live-audio",
								modulation: "nfm",
								transmissions: 1,
								transmissionId: "t1",
								ctcssHz: 67,
								dcs: { code: "023", polarity: "normal" },
								tuningTrust: "commanded",
							},
							decodersUnavailable: ["dsd-fme", "multimon-ng"],
						},
					},
				],
			},
		}
		const parsed = guardScan("job", job)
		expect(parsed).toBeDefined()
		expect(parsed?.identify?.targets[0]?.trials.map(t => t.outcome)).toEqual([
			"decoded",
			"unsupported",
			"unsupported",
		])
	})
})

describe("WG10 contract: spectrum warnings, storage kept, live audio bounds", () => {
	it("adds optional warning fields and the log interval", () => {
		expect(
			same<
				Api.SpectrumWarningSuspect,
				"iq-byte-slip" | "signal-change" | "external-control"
			>(true),
		).toBe(true)
		const w: Api.SpectrumWarning = {
			code: "untracked-retune",
			deltaHz: -273_000,
			at: "2026-10-17T12:00:00.000Z",
			suspected: "iq-byte-slip",
			lastCommandAgeMs: null,
		}
		const old: Api.SpectrumWarning = {
			code: "host-centre-mismatch",
			deltaHz: 1,
			at: w.at,
		}
		expect(old.suspected).toBeUndefined()
		expect(
			same<
				Api.SpectrumWarning["code"],
				"untracked-retune" | "host-centre-mismatch"
			>(true),
		).toBe(true)
		// One warn line per source per minute at most.
		expect(SPECTRUM_WARNING_LOG_INTERVAL_MS).toBe(60_000)
	})

	it("reports kept totals or null", () => {
		const ready: Api.StorageKeptSummary = {
			state: "ready",
			recordings: 2,
			bytes: 1024,
			maxRecordings: RECORDING_KEEPS_MAX_ENTRIES,
			maxBytes: RECORDING_KEEPS_MAX_BYTES,
		}
		const failed: Api.StorageKeptSummary = { state: "failed" }
		const kept: Api.StorageReport["kept"][] = [ready, failed, null]
		expect(kept).toHaveLength(3)
		expect(ready.maxBytes).toBe(512 * 1024 * 1024)
		expect(ready.maxRecordings).toBe(2000)
	})

	it("pins the silence fill and front swap bounds", () => {
		expect(LIVE_AUDIO_SILENCE_CHUNK_MS).toBe(20)
		expect(LIVE_AUDIO_SILENCE_FILL_MAX_MS).toBe(5_000)
		// at most 250 silence writes per restart per client
		expect(LIVE_AUDIO_SILENCE_FILL_MAX_MS / LIVE_AUDIO_SILENCE_CHUNK_MS).toBe(
			250,
		)
		expect(LIVE_AUDIO_FRONT_SWAP_TIMEOUT_MS).toBe(2_000)
		expect(LIVE_AUDIO_FRONT_SWAP_TIMEOUT_MS).toBeLessThan(
			LIVE_AUDIO_SILENCE_FILL_MAX_MS,
		)
		// the carrier test of the auto floor uses the noise squelch default
		expect(LIVE_AUDIO_NOISE_QUIETING_DB.default).toBe(6)
	})
})

describe("WG10 contract: recording delete progress, sweep, aliases, ports", () => {
	it("accepts only mkdtemp-shaped private directory names", () => {
		for (const ok of [".wavekit-delete-abc123", ".wavekit-delete-ZZZZZZ"])
			expect(RECORDING_DELETE_PRIVATE_DIR.test(ok)).toBe(true)
		for (const bad of [
			".wavekit-delete-",
			".wavekit-delete-abc12",
			".wavekit-delete-abc1234",
			".wavekit-delete-abc/12",
			".wavekit-delete-ab..12",
			"wavekit-delete-abc123",
			".wavekit-delete-abc123/",
			"../.wavekit-delete-abc123",
		])
			expect(RECORDING_DELETE_PRIVATE_DIR.test(bad)).toBe(false)
		expect(RECORDING_DELETE_VERIFIED_NAME).toBe("verified")
		// `verified` can never be a recording name (no .wav), so the two progress states never collide
		expect(
			RECORDING_KEEP_KEY.test(`dsd~${RECORDING_DELETE_VERIFIED_NAME}`),
		).toBe(false)
	})

	it("pins the sweep and alias bounds", () => {
		expect(RECORDING_DELETE_SWEEP_MAX_DIRS).toBe(64)
		expect(DISCOVERY_RECORDING_ALIASES_MAX).toBe(64)
		const r: RecordingDeleteSweepResult = {
			found: 0,
			deleted: 0,
			restored: 0,
			removedEmpty: 0,
			left: 0,
		}
		expect(Object.keys(r).sort()).toEqual([
			"deleted",
			"found",
			"left",
			"removedEmpty",
			"restored",
		])
	})

	it("shapes the keep totals, scanner deleter and analog evidence ports", async () => {
		const totals: RecordingKeepTotals = { recordings: 0, bytes: 0 }
		const source: RecordingKeepTotalsSource = {
			state: () => "failed",
			totals: () => null,
		}
		expect(source.totals()).toBeNull()
		expect(totals.recordings).toBe(0)
		const deleter: ScannerRecordingDeleter = {
			deleteRecording: (_id, stillDeletable) =>
				Promise.resolve(stillDeletable() ? "deleted" : "not-found"),
		}
		await expect(
			deleter.deleteRecording("d_x~a.wav", () => false),
		).resolves.toBe("not-found")
		const t: AnalogEvidenceTransmission = {
			transmissionId: "t1",
			sourceId: "rtl",
			startedAtMs: 0,
			endedAtMs: null,
			hz: 446_156_250,
			tuningTrust: "unverified",
			modulation: "nfm",
			ctcssHz: null,
			dcs: null,
		}
		const evidence: IdentifyAnalogEvidence = {
			transmissionsNear: () => [t],
			monitoring: () => false,
		}
		expect(
			evidence.transmissionsNear("rtl", 446_156_250, 1000, 0),
		).toHaveLength(1)
	})

	it("keeps the WG9 recording codes and statuses", () => {
		expect(RECORDING_ERROR_STATUS.RECORDING_DELETE_UNSUPPORTED).toBe(409)
		expect(RECORDING_ERROR_STATUS.RECORDING_BUSY).toBe(409)
		expect(RECORDING_ERROR_STATUS.RECORDING_KEPT).toBe(409)
		expect(RECORDING_ERROR_STATUS.RECORDING_NOT_FOUND).toBe(404)
	})

	it("keeps the tuning trust vocabulary", () => {
		expect(
			same<Api.TuningTrust, "commanded" | "relay" | "unverified">(true),
		).toBe(true)
	})
})
