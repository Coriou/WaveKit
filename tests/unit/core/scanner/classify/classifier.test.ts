import { describe, expect, it } from "vitest"
import {
	CARRIER_DEFAULT_BIN_HZ,
	CARRIER_FLAT_MAX_BINS,
	CARRIER_FLAT_MAX_BINS_6DB,
	CARRIER_LINE_MAX_BINS,
	CARRIER_PEAKED_MAX_BINS_6DB,
	CARRIER_STEADY_DUTY_MIN,
	AMBIGUOUS_LINE_BINS,
	ambiguousLine,
	carrierLine,
	AM_VOICE_MAX_OBW_HZ,
	AM_VOICE_MIN_OBW_HZ,
	applyPriors,
	CLASS_HYPOTHESES,
	classifySpectral,
	classOf,
	familyOf,
	isAmVoice,
	leakOrIntermod,
	steadyLine,
} from "../../../../../src/core/scanner/classify/classifier.js"
import {
	DiscoverySchema,
	ScannerClassSchema,
} from "../../../../../src/core/scanner/store/schemas.js"
import type { ScannerProtocol } from "../../../../../src/core/scanner/types.js"
import {
	obwAtDb,
	spectralShape,
} from "../../../../../src/core/spectrum/emissions/spectral-features.js"
import type { TrackSnapshot } from "../../../../../src/core/spectrum/types.js"
import {
	addInto,
	fsk4Burst,
	gaussianNoise,
	mulberry32,
} from "../../../../mocks/scanner/signals.js"
import { BLOCK, CENTRE, FS, Harness } from "../../spectrum/pipeline-harness.js"

/** FFT bin widths: 1.024 Msps / 1 024 and 2.4 Msps / 2 048 (the engine's default FFT sizes). */
const BIN_1024K = 1_024_000 / 1_024
const BIN_2400K = 2_400_000 / 2_048

/** Power (dB) of a Hann-windowed complex tone at bin `k` (fractional), `n` points, peak `peakDb`. */
function hannToneDb(n: number, k: number, peakDb: number): Float32Array {
	const out = new Float32Array(n).fill(-200)
	const re = new Float64Array(n)
	const im = new Float64Array(n)
	for (let t = 0; t < n; t++) {
		const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * t) / n)
		re[t] = w * Math.cos((2 * Math.PI * k * t) / n)
		im[t] = w * Math.sin((2 * Math.PI * k * t) / n)
	}
	let peak = -Infinity
	const lo = Math.floor(k) - 10
	const hi = Math.floor(k) + 11
	const raw = new Float64Array(n).fill(-Infinity)
	for (let b = lo; b < hi; b++) {
		let sr = 0
		let si = 0
		for (let t = 0; t < n; t++) {
			const a = (-2 * Math.PI * b * t) / n
			const c = Math.cos(a)
			const s = Math.sin(a)
			sr += (re[t] ?? 0) * c - (im[t] ?? 0) * s
			si += (re[t] ?? 0) * s + (im[t] ?? 0) * c
		}
		const p = 10 * Math.log10(Math.max(sr * sr + si * si, 1e-30))
		raw[b] = p
		peak = Math.max(peak, p)
	}
	for (let b = lo; b < hi; b++)
		out[b] = Math.max(-200, (raw[b] ?? -Infinity) - peak + peakDb)
	return out
}

function snap(over: Partial<TrackSnapshot> = {}): TrackSnapshot {
	return {
		trackId: "t1",
		sourceId: "s1",
		stream: 1,
		epoch: 1,
		startSample: 0,
		lastSample: 20 * BLOCK,
		centreHz: 446_093_750,
		obwHz: 8750,
		obwMethod: "-20dB",
		peakDbfs: -30,
		meanDbfs: -25,
		snrDb: 30,
		floorDbfs: -60,
		thresholdDb: 4,
		blocks: 20,
		maxBlockSnrDb: 35,
		dutyCycle: 1,
		spectralShape: "flat",
		flags: {
			overload: false,
			gap: false,
			truncated: false,
			edge: false,
			skirt: false,
			obwBiased: false,
			spur: false,
			burst: false,
			iqImage: false,
		},
		tuningTrust: "commanded",
		...over,
	}
}
const all = { priors: {}, protocols: [] as ScannerProtocol[] }

describe("classOf", () => {
	it.each([
		[{ obwHz: 30_000 }, "wideband"],
		[{ spectralShape: "narrow" as const, obwHz: 2000 }, "carrier"],
		[{ acf30: -0.94, acf60: 0.99 }, "tdma-ms"],
		[{ blocks: 2 }, "ook-burst"],
		[{ obwHz: 4500 }, "fsk4-6k25"],
		[{ obwHz: 8750 }, "fsk4-12k5"],
		[{ obwHz: 12_000 }, "fsk2-wide"],
		[{ spectralShape: "peaked" as const, obwHz: 6000 }, "gmsk-narrow"],
		[{ spectralShape: "peaked" as const, obwHz: 11_000 }, "analog-fm"],
		[{ spectralShape: "peaked" as const, obwHz: 20_000 }, "unknown"],
		[{ acf30: 0.04, acf60: 0 }, "fsk4-12k5"],
	])("%o → %s", (over, cls) => {
		expect(classOf(snap(over))).toBe(cls)
	})
	it("repro: the steady-carrier rule counts bins of the track's FFT (≤ 4 inclusive), at 1.024 and 2.4 Msps", () => {
		expect(CARRIER_STEADY_DUTY_MIN).toBe(0.9)
		expect(CARRIER_LINE_MAX_BINS).toBe(4)
		expect(CARRIER_PEAKED_MAX_BINS_6DB).toBe(3)
		for (const binHz of [BIN_1024K, BIN_2400K]) {
			// an on-bin tone whose ±1 neighbours noise lifted over -6 dB: peaked, 3 bins at both levels
			const line = (over: Partial<TrackSnapshot>) =>
				classOf(
					snap({
						spectralShape: "peaked",
						obwHz: 3 * binHz,
						obw6Hz: 3 * binHz,
						binHz,
						...over,
					}),
				)
			expect({ binHz, cls: line({}) }).toEqual({ binHz, cls: "carrier" })
			// drifted: 4 bins at -20 dB is still a carrier, 4 bins + 1 Hz is not
			expect(line({ obwHz: 4 * binHz })).toBe("carrier")
			expect(line({ obwHz: 4 * binHz + 1 })).not.toBe("carrier")
			// -6 dB wider than 3 bins is not a tone
			expect(line({ obw6Hz: 3 * binHz + 1, obwHz: 4 * binHz })).not.toBe(
				"carrier",
			)
			// duty: at the bound a carrier, under it (keyed CW) not
			expect(line({ dutyCycle: 0.9 })).toBe("carrier")
			expect(line({ dutyCycle: 0.89 })).not.toBe("carrier")
			expect(line({ dutyCycle: Number.NaN })).not.toBe("carrier")
			// a short track stays a burst
			expect(line({ blocks: 4 })).toBe("ook-burst")
			// a half-bin tone reads 2 bins at -6 dB (narrow) and 4 at -20 dB: carrier
			expect(
				classOf(snap({ spectralShape: "narrow", obwHz: 4 * binHz, binHz })),
			).toBe("carrier")
		}
		// the old Hz cut missed both: 3 000 Hz at 1 kHz bins and 3 516 Hz at 1 172 Hz bins
		expect(3 * BIN_1024K).toBeGreaterThanOrEqual(3_000)
		expect(3 * BIN_2400K).toBeGreaterThan(3_000)
	})

	it("narrow digital stays off the carrier rule: flat tops (NXDN48, dPMR) and lines of unknown -6 dB width keep their trials", () => {
		expect(CARRIER_FLAT_MAX_BINS).toBe(3)
		for (const binHz of [BIN_1024K, BIN_2400K]) {
			// a 4 kHz flat top reads 4 bins or more at -20 dB at both rates
			expect(Math.ceil(4_000 / binHz)).toBeGreaterThanOrEqual(4)
			for (const obwHz of [4 * binHz, 5 * binHz])
				expect(["fsk4-6k25", "fsk4-12k5"]).toContain(
					classOf(snap({ spectralShape: "flat", obwHz, obw6Hz: obwHz, binHz })),
				)
			// a flat line with a carrier's -6 dB width (at most 2 bins) is a carrier
			expect(
				classOf(
					snap({
						spectralShape: "flat",
						obwHz: 3 * binHz,
						obw6Hz: 2 * binHz,
						binHz,
					}),
				),
			).toBe("carrier")
		}
		// unknown -6 dB width: the flat-top path as before
		expect(classOf(snap({ spectralShape: "flat", obwHz: 3_000 }))).toBe(
			"fsk4-6k25",
		)
		// a peaked off-raster line of unknown -6 dB width: the pre-existing path (digital trials)
		expect(classOf(snap({ spectralShape: "peaked", obwHz: 2_000 }))).toBe(
			"unknown",
		)
		expect(classOf(snap({ spectralShape: "peaked", obwHz: 2_344 }))).toBe(
			"unknown",
		)
		expect(classOf(snap({ spectralShape: "peaked", obwHz: 3_000 }))).toBe(
			"unknown",
		)
		expect(classOf(snap({ spectralShape: "peaked", obwHz: 11_000 }))).toBe(
			"analog-fm",
		)
	})

	it("repro: a steady three-bin flat top (obwHz = obw6Hz = 3 bins, not narrow) keeps its digital trials at 1 000 and 1 171.875 Hz bins, and is no evidence either way for a spur", () => {
		for (const binHz of [BIN_1024K, BIN_2400K]) {
			const track = snap({
				spectralShape: "flat",
				obwHz: 3 * binHz,
				obw6Hz: 3 * binHz,
				binHz,
				blocks: 40,
				dutyCycle: 1,
			})
			expect(classOf(track)).not.toBe("carrier")
			expect(classOf(track)).toBe("fsk4-6k25")
			// an on-bin tone reads so too: neither a steady line nor proof of none
			expect(steadyLine(track)).toBeUndefined()
			expect(
				carrierLine({
					obwHz: 3 * binHz,
					obw6Hz: 3 * binHz,
					spectralShape: "flat",
					binHz,
				}),
			).toBe(false)
		}
	})

	it("carrierLine: Hann pure tones on a bin centre read 3 bins, half a bin off 4 bins, both carrier lines at both rates", () => {
		for (const [rate, n] of [
			[1_024_000, 1_024],
			[2_400_000, 2_048],
		] as const) {
			const binHz = rate / n
			for (const [frac, bins] of [
				[0, 3],
				[0.5, 4],
			] as const) {
				const k0 = n / 4
				const db = hannToneDb(n, k0 + frac, 40)
				const lo = k0 - 8
				const hi = k0 + 9
				const w20 = obwAtDb(db, lo, hi, binHz, 20)
				const w6 = obwAtDb(db, lo, hi, binHz, 6)
				const shape = spectralShape(db, lo, hi, binHz)
				expect({ rate, frac, bins: Math.round(w20 / binHz) }).toEqual({
					rate,
					frac,
					bins,
				})
				expect(shape).toBe("narrow")
				expect(
					carrierLine({ obwHz: w20, obw6Hz: w6, spectralShape: shape, binHz }),
				).toBe(true)
			}
		}
	})

	it("carrierLine: one shared rule, bounds at and past them, malformed input not a line", () => {
		expect(CARRIER_DEFAULT_BIN_HZ).toBe(1_000)
		const c = (over: Parameters<typeof carrierLine>[0]) => carrierLine(over)
		expect(c({ obwHz: 4_000 })).toBe(true)
		expect(c({ obwHz: 4_001 })).toBe(false)
		expect(c({ obwHz: 4 * BIN_2400K, binHz: BIN_2400K })).toBe(true)
		expect(c({ obwHz: 4 * BIN_2400K + 1, binHz: BIN_2400K })).toBe(false)
		// a malformed bin width reads the default bin
		expect(c({ obwHz: 4_500, binHz: Number.NaN })).toBe(false)
		expect(c({ obwHz: 4_000, binHz: -1 })).toBe(true)
		expect(c({ obwHz: Number.NaN })).toBe(false)
		expect(c({ obwHz: 0 })).toBe(false)
		expect(c({ obwHz: 1_000, spectralShape: "flat" })).toBe(false)
		expect(CARRIER_FLAT_MAX_BINS_6DB).toBe(2)
		// a 3-bin flat top (3 bins at -6 dB too) is narrow digital, not a carrier line
		expect(c({ obwHz: 3_000, spectralShape: "flat", obw6Hz: 3_000 })).toBe(
			false,
		)
		expect(c({ obwHz: 3_000, spectralShape: "flat", obw6Hz: 2_000 })).toBe(true)
		expect(c({ obwHz: 3_000, spectralShape: "flat", obw6Hz: 2_001 })).toBe(
			false,
		)
		expect(c({ obwHz: 3_001, spectralShape: "flat", obw6Hz: 2_000 })).toBe(
			false,
		)
		expect(
			c({
				obwHz: 3 * BIN_2400K,
				spectralShape: "flat",
				obw6Hz: 2 * BIN_2400K,
				binHz: BIN_2400K,
			}),
		).toBe(true)
		expect(
			c({
				obwHz: 3 * BIN_2400K,
				spectralShape: "flat",
				obw6Hz: 2 * BIN_2400K + 1,
				binHz: BIN_2400K,
			}),
		).toBe(false)
		expect(c({ obwHz: 1_000, spectralShape: "peaked" })).toBe(false)
		expect(c({ obwHz: 3_000, spectralShape: "peaked", obw6Hz: 3_000 })).toBe(
			true,
		)
		expect(c({ obwHz: 3_000, spectralShape: "peaked", obw6Hz: 3_001 })).toBe(
			false,
		)
	})

	it("steadyLine: a carrier line over 4 blocks and on 90 % of the time; undecided while young", () => {
		const t = (over: Partial<Parameters<typeof steadyLine>[0]>) =>
			steadyLine({
				obwHz: 1_000,
				blocks: 40,
				dutyCycle: 1,
				spectralShape: "narrow",
				...over,
			})
		expect(t({})).toBe(true)
		expect(t({ obwHz: 4_000 })).toBe(true)
		expect(t({ obwHz: 4_001 })).toBe(false)
		expect(t({ obwHz: 4 * BIN_2400K, binHz: BIN_2400K })).toBe(true)
		expect(t({ dutyCycle: 0.9 })).toBe(true)
		expect(t({ dutyCycle: 0.89 })).toBe(false)
		expect(t({ blocks: 5 })).toBe(true)
		expect(t({ blocks: 4 })).toBeUndefined()
		// a wide young track is already no line
		expect(t({ blocks: 2, obwHz: 11_000 })).toBe(false)
		expect(t({ obwHz: Number.NaN })).toBe(false)
		expect(t({ dutyCycle: Number.NaN })).toBe(false)
		// repro: a continuous dPMR / NXDN48 flat top is no spur candidate; no shape reads as flat
		expect(t({ spectralShape: "flat", obwHz: 3_000 })).toBe(false)
		expect(
			t({ spectralShape: "flat", obwHz: 4_000, obw6Hz: 3_000, binHz: 1_000 }),
		).toBe(false)
		expect(t({ spectralShape: undefined })).toBe(false)
		expect(t({ spectralShape: "peaked", obwHz: 3_000 })).toBe(false)
		expect(t({ spectralShape: "peaked", obwHz: 3_000, obw6Hz: 3_000 })).toBe(
			true,
		)
	})

	it("ambiguousLine: a flat line exactly 3 bins wide at -20 dB and at -6 dB, at both rates; nothing else", () => {
		expect(AMBIGUOUS_LINE_BINS).toBe(3)
		for (const binHz of [BIN_1024K, BIN_2400K]) {
			const a = (
				obwBins: number,
				obw6Bins: number | undefined,
				shape = "flat",
			) =>
				ambiguousLine({
					obwHz: obwBins * binHz,
					...(obw6Bins === undefined ? {} : { obw6Hz: obw6Bins * binHz }),
					spectralShape: shape as TrackSnapshot["spectralShape"],
					binHz,
				})
			expect(a(3, 3)).toBe(true)
			// a carrier's -6 dB width, a wider -20 dB width, a wider -6 dB width: decided
			expect(a(3, 2)).toBe(false)
			expect(a(4, 3)).toBe(false)
			expect(a(4, 4)).toBe(false)
			expect(a(2, 2)).toBe(false)
			// unknown -6 dB width, or another shape: not this reading
			expect(a(3, undefined)).toBe(false)
			expect(a(3, 3, "peaked")).toBe(false)
			expect(a(3, 3, "narrow")).toBe(false)
			// young or old, steady or not: undecided (no learning, no revocation, no taint)
			for (const [blocks, dutyCycle] of [
				[2, 1],
				[40, 1],
				[40, 0.5],
			] as const)
				expect(
					steadyLine({
						obwHz: 3 * binHz,
						obw6Hz: 3 * binHz,
						spectralShape: "flat",
						binHz,
						blocks,
						dutyCycle,
					}),
				).toBeUndefined()
		}
		// the default bin when the track carries none
		expect(
			ambiguousLine({ obwHz: 3_000, obw6Hz: 3_000, spectralShape: "flat" }),
		).toBe(true)
		expect(
			ambiguousLine({
				obwHz: Number.NaN,
				obw6Hz: 3_000,
				spectralShape: "flat",
			}),
		).toBe(false)
	})

	it("does not call short tracks bursts where bursts are implausible", () => {
		expect(classOf(snap({ blocks: 2 }), { allowBurst: false })).toBe(
			"fsk4-12k5",
		)
	})
})

describe("classifySpectral", () => {
	it("ranks DMR first for a TDMA MS track, with scores in [0, 1] sorted descending", () => {
		const c = classifySpectral(snap({ acf30: -0.94, acf60: 0.99 }), all)
		expect(c.class).toBe("tdma-ms")
		expect(c.tier).toBe("spectral")
		expect(c.hypotheses[0]).toEqual({ protocol: "dmr", score: 0.9 })
		expect(c.cap).toBeUndefined()
	})
	it("multiplies by priors and retains protocols whose prior is 0", () => {
		const c = classifySpectral(snap(), {
			priors: { dmr: 1, ysf: 0, p25p1: 0.5 },
			protocols: [],
		})
		expect(c.hypotheses.map(h => h.protocol)).toEqual([
			"dmr",
			"analog-fm",
			"nxdn96",
			"p25p1",
			"ysf",
		])
		expect(c.hypotheses.find(h => h.protocol === "p25p1")?.score).toBeCloseTo(
			0.2,
			6,
		)
	})
	it("keeps only the job's protocols when the job is protocol-specific", () => {
		const c = classifySpectral(snap(), { priors: {}, protocols: ["ysf"] })
		expect(c.hypotheses).toEqual([{ protocol: "ysf", score: 0.45 }])
	})
	it("does not classify a 2-block land-mobile track as an ISM burst", () => {
		const c = classifySpectral(snap({ blocks: 2 }), {
			priors: { dmr: 1, "analog-fm": 1, ism: 0.25 },
			protocols: [],
		})
		expect(c.class).toBe("fsk4-12k5")
		const ism = classifySpectral(snap({ blocks: 2 }), {
			priors: { ism: 1 },
			protocols: [],
		})
		expect(ism.class).toBe("ook-burst")
		expect(ism.hypotheses[0]?.protocol).toBe("ism")
	})
	it("has a hypothesis table entry for every class", () => {
		for (const [cls, hs] of Object.entries(CLASS_HYPOTHESES)) {
			expect(hs.length, cls).toBeGreaterThan(0)
			for (const h of hs) expect(h.score).toBeGreaterThan(0)
		}
	})
	it("applyPriors clamps to [0, 1] and breaks ties by protocol name", () => {
		expect(
			applyPriors(
				[
					{ protocol: "ysf", score: 0.6 },
					{ protocol: "dmr", score: 0.6 },
				],
				{ priors: { ysf: 3 }, protocols: [] },
			),
		).toEqual([
			{ protocol: "ysf", score: 1 },
			{ protocol: "dmr", score: 0.6 },
		])
		expect(
			applyPriors(
				[
					{ protocol: "ysf", score: 0.5 },
					{ protocol: "dmr", score: 0.5 },
				],
				all,
			),
		).toEqual([
			{ protocol: "dmr", score: 0.5 },
			{ protocol: "ysf", score: 0.5 },
		])
	})
})

describe("familyOf", () => {
	it("keeps analog FM and digital voice apart (dual-mode PMR446 handheld = two discoveries)", () => {
		expect(familyOf("analog-fm")).toBe("analog")
		expect(familyOf("dmr")).toBe("digital-voice")
		expect(familyOf("nxdn48")).toBe(familyOf("dpmr"))
		expect(familyOf("pocsag")).toBe("pager")
		expect(familyOf("aprs")).toBe("packet")
		expect(familyOf("ism")).toBe("ism")
		expect(familyOf("carrier")).toBe("carrier")
		expect(familyOf("digital-unknown")).toBe("unknown")
		expect(familyOf("unknown")).toBe("unknown")
	})
})

describe("leakOrIntermod", () => {
	const id = { kind: "dmr-cc" as const, value: "1" }
	it("caps a decode whose identity is ≥ 20 dB stronger at another frequency", () => {
		const t = snap({ centreHz: 446_106_250, peakDbfs: -60 })
		expect(
			leakOrIntermod(t, [], () => [{ centreHz: 446_093_750, peakDbfs: -35 }], {
				identity: id,
			}),
		).toBe("adjacent-leak")
		expect(
			leakOrIntermod(t, [], () => [{ centreHz: 446_093_750, peakDbfs: -45 }], {
				identity: id,
			}),
		).toBeUndefined()
		expect(
			leakOrIntermod(t, [], () => [{ centreHz: 446_106_250, peakDbfs: -20 }], {
				identity: id,
			}),
		).toBeUndefined()
		expect(
			leakOrIntermod(t, [], () => [{ centreHz: 446_093_750, peakDbfs: -35 }]),
		).toBeUndefined()
	})
})

describe("pipeline + classifier", () => {
	it("classifies a TDMA 4FSK burst through the pipeline as tdma-ms with DMR first", () => {
		const rng = mulberry32(99)
		const n = Math.round(1.5 * FS)
		const iq = gaussianNoise(rng, n + 20 * BLOCK, 0.05)
		addInto(iq, fsk4Burst(rng, n, FS, 30_000, 0.3, { tdma: true }), 2 * BLOCK)
		const h = new Harness()
		h.start()
		h.push(iq)
		const closed = h
			.of("track-close")
			.filter(c => Math.abs(c.track.centreHz - (CENTRE + 30_000)) < 2000)
		expect(closed).toHaveLength(1)
		const c = classifySpectral(closed[0]!.track, all)
		expect(c.class).toBe("tdma-ms")
		expect(c.hypotheses[0]?.protocol).toBe("dmr")
	})
})

describe("AM voice is not a bare carrier (detection-quality 1.17)", () => {
	// An AM-only range (airband) and an AM + FM range (CB), as `priorsFor` builds them.
	const AM: Partial<Record<ScannerProtocol, number>> = {
		"analog-am": 1,
		"analog-fm": 0.25,
		carrier: 1,
		unknown: 1,
	}
	const AM_FM: Partial<Record<ScannerProtocol, number>> = {
		...AM,
		"analog-fm": 1,
	}
	const ctx = (priors: Partial<Record<ScannerProtocol, number>>) => ({
		priors,
		protocols: [],
	})
	const am = (over: Partial<TrackSnapshot> = {}) =>
		snap({ spectralShape: "narrow", obwHz: 7_000, blocks: 40, ...over })

	it("boundary: a narrow track with a 6 000 Hz -20 dB OBW is AM voice, 5 999 Hz is a carrier", () => {
		const at = classifySpectral(am({ obwHz: AM_VOICE_MIN_OBW_HZ }), ctx(AM))
		expect(at.class).toBe("analog-am")
		expect(at.hypotheses[0]?.protocol).toBe("analog-am")
		expect(
			classifySpectral(am({ obwHz: AM_VOICE_MIN_OBW_HZ - 1 }), ctx(AM)).class,
		).toBe("carrier")
	})

	it("the analog-am class round-trips through the stored class schema", () => {
		const out = classifySpectral(am(), ctx(AM))
		expect(out.class).toBe("analog-am")
		expect(out.hypotheses.map(h => h.protocol)).toEqual([
			"analog-am",
			"carrier",
		])
		const json: unknown = JSON.parse(JSON.stringify(out.class))
		expect(ScannerClassSchema.parse(json)).toBe("analog-am")
		expect(DiscoverySchema.shape.class.parse(json)).toBe("analog-am")
		expect(ScannerClassSchema.safeParse("analog-xm").success).toBe(false)
	})

	it("boundary: 12 500 Hz is still AM voice, 12 501 Hz is not", () => {
		expect(isAmVoice(am({ obwHz: AM_VOICE_MAX_OBW_HZ }), AM)).toBe(true)
		expect(isAmVoice(am({ obwHz: AM_VOICE_MAX_OBW_HZ + 1 }), AM)).toBe(false)
	})

	it("boundary: a burst of 4 blocks is not AM voice, 5 blocks is", () => {
		expect(isAmVoice(am({ blocks: 4 }), AM)).toBe(false)
		expect(isAmVoice(am({ blocks: 5 }), AM)).toBe(true)
	})

	it("needs a range listing analog-am; peaked tracks only where FM is not listed; never flat", () => {
		expect(isAmVoice(am(), {})).toBe(false)
		expect(classifySpectral(am(), ctx({})).class).toBe("carrier")
		expect(isAmVoice(am(), AM_FM)).toBe(true)
		expect(isAmVoice(am({ spectralShape: "peaked" }), AM)).toBe(true)
		expect(isAmVoice(am({ spectralShape: "peaked" }), AM_FM)).toBe(false)
		expect(isAmVoice(am({ spectralShape: "flat" }), AM)).toBe(false)
	})

	it("malformed input is never AM voice (today's class stays)", () => {
		expect(isAmVoice(am({ obwHz: Number.NaN }), AM)).toBe(false)
		expect(isAmVoice(am({ blocks: Number.NaN }), AM)).toBe(false)
		expect(isAmVoice(am(), { "analog-am": Number.NaN })).toBe(false)
		expect(isAmVoice(am(), { "analog-am": 0.99 })).toBe(false)
		expect(
			isAmVoice(
				am(),
				null as unknown as Partial<Record<ScannerProtocol, number>>,
			),
		).toBe(false)
	})
})
