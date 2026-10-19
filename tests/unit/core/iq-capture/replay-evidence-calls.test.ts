import type { ScannerProbeDecoderType } from "@wavekit/api-types"
import { describe, expect, it } from "vitest"
import { replayEvidenceCalls } from "../../../../src/core/iq-capture/replay-first.js"
import type { IqReplayResult } from "../../../../src/core/scanner/iq-capture-contract.js"
import type {
	AnalogTrialResult,
	ObservationEvidenceSink,
	ProofAnalogInput,
	ProofTrialInput,
} from "../../../../src/core/scanner/scanner-redesign-contract.js"

class FakeSink implements ObservationEvidenceSink {
	order = 0
	trials: { observationId: string; trial: ProofTrialInput }[] = []
	analog: { observationId: string; analog: ProofAnalogInput }[] = []
	unavailable: { observationId: string; type: ScannerProbeDecoderType }[] = []
	/** Not part of the sink. A mapping that reaches for a miss must show up here. */
	misses: string[] = []
	undecoded: string[] = []
	nextTrialOrder(): number {
		this.order += 1
		return this.order
	}
	recordTrial(observationId: string, trial: ProofTrialInput): boolean {
		this.trials.push({ observationId, trial })
		return true
	}
	recordAnalog(observationId: string, analog: ProofAnalogInput): boolean {
		this.analog.push({ observationId, analog })
		return true
	}
	recordUnavailable(
		observationId: string,
		type: ScannerProbeDecoderType,
	): boolean {
		this.unavailable.push({ observationId, type })
		return true
	}
	recordMiss(protocol: string): boolean {
		this.misses.push(protocol)
		return false
	}
	markUndecoded(reason: string): boolean {
		this.undecoded.push(reason)
		return false
	}
}

const AT = 1_700_000_000_000

function heardStats(): NonNullable<AnalogTrialResult["stats"]> {
	return {
		mode: "nfm",
		frames: [
			{
				carrierDb: -20,
				hfNoiseDb: -40,
				audioDb: -12,
				syllabic: 0.4,
				cluster: 0.1,
			},
		],
		gapSamples: 0,
		floorDb: -90,
	}
}

function result(patch: Partial<IqReplayResult> = {}): IqReplayResult {
	return {
		captureId: "cap-1",
		sourceId: "rtl",
		observationId: "from-result",
		epoch: 3,
		trials: [],
		decoded: null,
		...patch,
	}
}

describe("replayEvidenceCalls", () => {
	it("orders one trial per kept outcome, skips not-needed, and forces the analog decoder", () => {
		const sink = new FakeSink()
		replayEvidenceCalls(
			result({
				trials: [
					{
						protocol: "dmr",
						decoderType: "dsd-fme",
						known: true,
						outcome: "not-needed" as unknown as "no-sync",
					},
					{
						protocol: "analog-fm",
						decoderType: "dsd-fme",
						decoder: "forged",
						mode: "nfm",
						known: false,
						outcome: "heard",
					},
					{
						protocol: "pocsag",
						decoderType: "multimon-ng",
						decoder: "not-a-decoder",
						known: false,
						outcome: "no-sync",
					},
					{
						protocol: "dmr",
						decoderType: "dsd-fme",
						known: true,
						outcome: "unsupported",
						reason: "decoder-unavailable",
					},
				],
				analog: {
					outcome: "heard",
					mode: "nfm",
					voice: true,
					tones: {
						ctcssHz: 88.5,
						dcs: null,
						audioSeconds: 0.5,
					},
					stats: heardStats(),
				},
				unavailable: ["dsd-fme"],
			}),
			"obs-1",
			sink,
			AT,
		)
		expect(sink.order).toBe(3)
		expect(sink.trials.map(t => t.observationId)).toEqual([
			"obs-1",
			"obs-1",
			"obs-1",
		])
		expect(sink.trials.map(t => t.trial)).toEqual([
			{
				protocol: "analog-fm",
				decoder: "analog-demod",
				outcome: "heard",
				order: 1,
				at: AT,
			},
			{
				protocol: "pocsag",
				decoder: "multimon-ng",
				outcome: "no-sync",
				order: 2,
				at: AT,
			},
			{
				protocol: "dmr",
				decoder: "dsd-fme",
				outcome: "unsupported",
				order: 3,
				at: AT,
			},
		])
		expect(sink.analog).toEqual([
			{
				observationId: "obs-1",
				analog: {
					outcome: "heard",
					mode: "nfm",
					voice: true,
					tone: { ctcssHz: 88.5, dcs: null },
					transport: "replay",
					at: AT,
				},
			},
		])
		expect(sink.unavailable).toEqual([
			{ observationId: "obs-1", type: "dsd-fme" },
		])
		expect(sink.misses).toEqual([])
		expect(sink.undecoded).toEqual([])
	})

	it("an unsupported trial records the trial and the type, and never a miss", () => {
		const sink = new FakeSink()
		replayEvidenceCalls(
			result({
				trials: [
					{
						protocol: "dmr",
						decoderType: "dsd-fme",
						known: true,
						outcome: "unsupported",
						reason: "decoder-unavailable",
					},
				],
				unavailable: [
					"dsd-fme",
					"not-a-type",
					"dsd-fme",
					"rtl433",
				] as unknown as ScannerProbeDecoderType[],
			}),
			"obs-1",
			sink,
			AT,
		)
		expect(sink.trials.map(t => t.trial.outcome)).toEqual(["unsupported"])
		expect(sink.unavailable.map(u => u.type)).toEqual(["dsd-fme", "rtl433"])
		expect(sink.misses).toEqual([])
		expect(sink.undecoded).toEqual([])
		expect(sink.analog).toEqual([])
	})

	it("drops forged outcomes, unknown protocols and non-finite or unknown tones", () => {
		const sink = new FakeSink()
		replayEvidenceCalls(
			result({
				trials: [
					{
						protocol: "dmr",
						decoderType: "dsd-fme",
						known: false,
						outcome: "pwned" as "no-sync",
					},
					{
						protocol: "not-a-protocol" as "dmr",
						decoderType: "dsd-fme",
						known: false,
						outcome: "no-sync",
					},
					{
						protocol: "aprs",
						decoderType: "direwolf",
						known: false,
						outcome: "timeout",
					},
				],
				analog: {
					outcome: "decoded",
					mode: "am",
					voice: false,
					tones: {
						ctcssHz: Number.POSITIVE_INFINITY,
						dcs: { code: "999", polarity: "normal" },
						audioSeconds: Number.NaN,
					},
					stats: null,
				},
			}),
			"obs-1",
			sink,
			AT,
		)
		expect(sink.trials.map(t => t.trial)).toEqual([
			{
				protocol: "aprs",
				decoder: "direwolf",
				outcome: "timeout",
				order: 1,
				at: AT,
			},
		])
		// A decoded result whose tones are not finite is not recorded as decoded.
		expect(sink.analog).toEqual([])
	})

	it("keeps a known DCS tone and refuses an analog result that carries an error", () => {
		const sink = new FakeSink()
		replayEvidenceCalls(
			result({
				analog: {
					outcome: "decoded",
					mode: "nfm",
					voice: true,
					tones: {
						ctcssHz: 88.5,
						dcs: { code: "023", polarity: "inverted" },
						audioSeconds: 2,
					},
					stats: null,
					error: "unavailable",
				},
			}),
			"obs-1",
			sink,
			AT,
		)
		expect(sink.analog).toEqual([])
		const kept = new FakeSink()
		replayEvidenceCalls(
			result({
				analog: {
					outcome: "decoded",
					mode: "nfm",
					voice: true,
					tones: {
						ctcssHz: null,
						dcs: { code: "023", polarity: "inverted" },
						audioSeconds: 2,
					},
					stats: null,
				},
			}),
			"obs-1",
			kept,
			AT,
		)
		expect(kept.analog[0]?.analog.tone).toEqual({
			ctcssHz: null,
			dcs: { code: "023", polarity: "inverted" },
		})
		expect(kept.analog[0]?.analog.transport).toBe("replay")
	})

	it("records nothing when the clock or the observation id is not usable", () => {
		const sink = new FakeSink()
		replayEvidenceCalls(
			result({
				trials: [
					{
						protocol: "dmr",
						decoderType: "dsd-fme",
						known: true,
						outcome: "no-sync",
					},
				],
			}),
			"obs-1",
			sink,
			Number.NaN,
		)
		replayEvidenceCalls(
			result({
				trials: [
					{
						protocol: "dmr",
						decoderType: "dsd-fme",
						known: true,
						outcome: "no-sync",
					},
				],
			}),
			"",
			sink,
			AT,
		)
		expect(sink.trials).toEqual([])
		expect(sink.order).toBe(0)
	})

	it("decoded CTCSS with audioSeconds 0 is not recorded as decoded", () => {
		const sink = new FakeSink()
		replayEvidenceCalls(
			result({
				analog: {
					outcome: "decoded",
					mode: "nfm",
					voice: true,
					tones: { ctcssHz: 88.5, dcs: null, audioSeconds: 0 },
					stats: null,
				},
			}),
			"obs-1",
			sink,
			AT,
		)
		expect(sink.analog).toEqual([])
	})

	it("heard with voice false and empty frames is not recorded as heard", () => {
		const sink = new FakeSink()
		replayEvidenceCalls(
			result({
				analog: {
					outcome: "heard",
					mode: "nfm",
					voice: false,
					tones: { ctcssHz: null, dcs: null, audioSeconds: 1 },
					stats: {
						...heardStats(),
						frames: [],
					},
				},
			}),
			"obs-1",
			sink,
			AT,
		)
		expect(sink.analog).toEqual([])
	})

	it("a decoded analog-demod trial with a malformed analog result is recorded as cancelled", () => {
		const sink = new FakeSink()
		replayEvidenceCalls(
			result({
				trials: [
					{
						protocol: "analog-fm",
						decoderType: "dsd-fme",
						decoder: "analog-demod",
						mode: "nfm",
						known: false,
						outcome: "decoded",
					},
				],
				analog: { outcome: "decoded" } as AnalogTrialResult,
			}),
			"obs-1",
			sink,
			AT,
		)
		expect(sink.trials.map(t => t.trial.outcome)).toEqual(["cancelled"])
		expect(sink.analog).toEqual([])
	})

	it("a bare heard result is not recorded as heard", () => {
		const sink = new FakeSink()
		replayEvidenceCalls(
			result({
				analog: {
					outcome: "heard",
					mode: "nfm",
					voice: true,
				} as unknown as AnalogTrialResult,
			}),
			"obs-1",
			sink,
			AT,
		)
		expect(sink.analog).toEqual([])
	})

	it("decoded with a non-finite CTCSS is not recorded as decoded", () => {
		const sink = new FakeSink()
		replayEvidenceCalls(
			result({
				analog: {
					outcome: "decoded",
					mode: "nfm",
					voice: true,
					tones: {
						ctcssHz: Number.POSITIVE_INFINITY,
						dcs: null,
						audioSeconds: 1,
					},
					stats: null,
				},
			}),
			"obs-1",
			sink,
			AT,
		)
		expect(sink.analog).toEqual([])
	})

	it("a throwing getter records nothing positive", () => {
		const sink = new FakeSink()
		const analog: Record<string, unknown> = {
			mode: "nfm",
			voice: true,
			tones: { ctcssHz: 88.5, dcs: null, audioSeconds: 1 },
			stats: heardStats(),
		}
		Object.defineProperty(analog, "outcome", {
			enumerable: true,
			get() {
				throw new Error("analog getter")
			},
		})
		expect(() =>
			replayEvidenceCalls(
				result({ analog: analog as unknown as AnalogTrialResult }),
				"obs-1",
				sink,
				AT,
			),
		).not.toThrow()
		expect(sink.analog).toEqual([])
	})

	it("non-finite stats or audio duration are not recorded as heard or decoded", () => {
		const missingDuration = new FakeSink()
		replayEvidenceCalls(
			result({
				analog: {
					outcome: "decoded",
					mode: "nfm",
					voice: true,
					tones: { ctcssHz: 88.5, dcs: null },
					stats: null,
				} as unknown as AnalogTrialResult,
			}),
			"obs-1",
			missingDuration,
			AT,
		)
		const infiniteAudio = new FakeSink()
		replayEvidenceCalls(
			result({
				analog: {
					outcome: "decoded",
					mode: "nfm",
					voice: true,
					tones: {
						ctcssHz: 88.5,
						dcs: null,
						audioSeconds: Number.POSITIVE_INFINITY,
					},
					stats: null,
				},
			}),
			"obs-1",
			infiniteAudio,
			AT,
		)
		const infiniteStats = new FakeSink()
		const base = heardStats()
		const stats = {
			...base,
			frames: base.frames.map((frame, index) =>
				index === 0 ? { ...frame, carrierDb: Number.POSITIVE_INFINITY } : frame,
			),
		}
		replayEvidenceCalls(
			result({
				analog: {
					outcome: "heard",
					mode: "nfm",
					voice: true,
					tones: { ctcssHz: null, dcs: null, audioSeconds: 1 },
					stats,
				},
			}),
			"obs-1",
			infiniteStats,
			AT,
		)
		expect(missingDuration.analog).toEqual([])
		expect(infiniteAudio.analog).toEqual([])
		expect(infiniteStats.analog).toEqual([])
	})
})
