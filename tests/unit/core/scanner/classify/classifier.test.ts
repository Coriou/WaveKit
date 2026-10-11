import { describe, expect, it } from "vitest"
import {
	applyPriors,
	CLASS_HYPOTHESES,
	classifySpectral,
	classOf,
	familyOf,
	leakOrIntermod,
} from "../../../../../src/core/scanner/classify/classifier.js"
import type { ScannerProtocol } from "../../../../../src/core/scanner/types.js"
import type { TrackSnapshot } from "../../../../../src/core/spectrum/types.js"
import {
	addInto,
	fsk4Burst,
	gaussianNoise,
	mulberry32,
} from "../../../../mocks/scanner/signals.js"
import { BLOCK, CENTRE, FS, Harness } from "../../spectrum/pipeline-harness.js"

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
	it("multiplies by priors and removes protocols whose prior is 0", () => {
		const c = classifySpectral(snap(), {
			priors: { dmr: 1, ysf: 0, p25p1: 0.5 },
			protocols: [],
		})
		expect(c.hypotheses.map(h => h.protocol)).toEqual([
			"dmr",
			"nxdn96",
			"p25p1",
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
