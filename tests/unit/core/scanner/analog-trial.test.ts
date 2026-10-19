import { describe, expect, it } from "vitest"
import {
	classifyAnalogTrial,
	isVoice,
} from "../../../../src/core/scanner/analog-trial.js"
import type {
	AnalogTrialFrame,
	AnalogTrialStats,
	AnalogTrialTones,
} from "../../../../src/core/scanner/scanner-redesign-contract.js"

const SILENT_TONES: AnalogTrialTones = {
	ctcssHz: null,
	dcs: null,
	audioSeconds: 0,
}

function frame(over: Partial<AnalogTrialFrame> = {}): AnalogTrialFrame {
	return {
		carrierDb: -40,
		hfNoiseDb: -20,
		audioDb: -80,
		syllabic: 0,
		cluster: 0,
		...over,
	}
}

function stats(
	frames: readonly AnalogTrialFrame[],
	over: Partial<Omit<AnalogTrialStats, "frames">> = {},
): AnalogTrialStats {
	return {
		mode: "nfm",
		frames,
		gapSamples: 0,
		floorDb: -120,
		...over,
	}
}

describe("classifyAnalogTrial", () => {
	it("quiet fraction 0.5 exactly passes and 0.49 is no-sync", () => {
		const half = stats([frame({ hfNoiseDb: -8 }), frame({ hfNoiseDb: 0 })])
		expect(classifyAnalogTrial(half, SILENT_TONES)).toBe("carrier-only")
		const justUnder = stats([
			...Array.from({ length: 49 }, () => frame({ hfNoiseDb: -8 })),
			...Array.from({ length: 51 }, () => frame({ hfNoiseDb: -7.9 })),
		])
		expect(classifyAnalogTrial(justUnder, SILENT_TONES)).toBe("no-sync")
	})

	it("quieting is inclusive at 8 dB and one step below is not", () => {
		expect(
			classifyAnalogTrial(stats([frame({ hfNoiseDb: -8 })]), SILENT_TONES),
		).toBe("carrier-only")
		expect(
			classifyAnalogTrial(stats([frame({ hfNoiseDb: -7.9 })]), SILENT_TONES),
		).toBe("no-sync")
	})

	it("a frame at or below -159.9 dB is not quieted and not a carrier", () => {
		const silent = { ctcssHz: null, dcs: null, audioSeconds: 0 } as const
		expect(
			classifyAnalogTrial(
				stats([frame({ hfNoiseDb: -160 })], { mode: "nfm" }),
				silent,
			),
		).toBe("no-sync")
		expect(
			classifyAnalogTrial(
				stats([frame({ hfNoiseDb: -159.9 })], { mode: "nfm" }),
				silent,
			),
		).toBe("no-sync")
		expect(
			classifyAnalogTrial(
				stats([frame({ carrierDb: -160, hfNoiseDb: -20 })], { mode: "nfm" }),
				silent,
			),
		).toBe("no-sync")
		expect(
			classifyAnalogTrial(
				stats([frame({ hfNoiseDb: -159.89 })], { mode: "nfm" }),
				silent,
			),
		).toBe("carrier-only")
		expect(
			classifyAnalogTrial(
				stats([frame({ carrierDb: -160, hfNoiseDb: -160 })], {
					mode: "am",
					floorDb: -320,
				}),
				silent,
			),
		).toBe("no-sync")
		expect(
			classifyAnalogTrial(
				stats([frame({ carrierDb: -159.9, hfNoiseDb: -20 })], {
					mode: "am",
					floorDb: -200,
				}),
				silent,
			),
		).toBe("no-sync")
		expect(
			classifyAnalogTrial(
				stats([frame({ carrierDb: -20, hfNoiseDb: -160 })], {
					mode: "am",
					floorDb: -90,
				}),
				silent,
			),
		).toBe("no-sync")
		expect(
			classifyAnalogTrial(
				stats([frame({ carrierDb: -20, hfNoiseDb: -20 })], {
					mode: "am",
					floorDb: -90,
				}),
				silent,
			),
		).toBe("carrier-only")
	})

	it("cluster 0.6 is data-like and 0.59 falls through to the next rule", () => {
		const voice = frame({
			cluster: 0.6,
			syllabic: 0.3,
			audioDb: -30,
		})
		expect(classifyAnalogTrial(stats([voice]), SILENT_TONES)).toBe("data-like")
		const under = frame({
			cluster: 0.59,
			syllabic: 0.3,
			audioDb: -30,
		})
		expect(classifyAnalogTrial(stats([under]), SILENT_TONES)).toBe("heard")
		const neither = frame({ cluster: 0.59, syllabic: 0, audioDb: -80 })
		expect(classifyAnalogTrial(stats([neither]), SILENT_TONES)).toBe(
			"carrier-only",
		)
	})

	it("an even frame count averages the two central cluster values", () => {
		const frames = [frame({ cluster: 0.5 }), frame({ cluster: 0.7 })]
		expect(classifyAnalogTrial(stats(frames), SILENT_TONES)).toBe("data-like")
	})

	it("syllabic 0.3 and audioDb -30 is heard; one step under either is not", () => {
		expect(
			classifyAnalogTrial(
				stats([frame({ syllabic: 0.3, audioDb: -30 })]),
				SILENT_TONES,
			),
		).toBe("heard")
		expect(isVoice(stats([frame({ syllabic: 0.3, audioDb: -30 })]))).toBe(true)
		expect(
			classifyAnalogTrial(
				stats([frame({ syllabic: 0.29, audioDb: -30 })]),
				SILENT_TONES,
			),
		).toBe("carrier-only")
		expect(
			classifyAnalogTrial(
				stats([frame({ syllabic: 0.3, audioDb: -30.1 })]),
				SILENT_TONES,
			),
		).toBe("carrier-only")
		expect(isVoice(stats([frame({ syllabic: 0.3, audioDb: -30.1 })]))).toBe(
			false,
		)
	})

	it("a qualified tone with no quieting is decoded", () => {
		const noisy = stats([frame({ hfNoiseDb: 0, cluster: 0.9 })])
		expect(
			classifyAnalogTrial(noisy, {
				ctcssHz: 88.5,
				dcs: null,
				audioSeconds: 0.75,
			}),
		).toBe("decoded")
		expect(
			classifyAnalogTrial(noisy, {
				ctcssHz: null,
				dcs: { code: "023", polarity: "normal" },
				audioSeconds: 0.75,
			}),
		).toBe("decoded")
	})

	it("malformed tones and short audio are not decoded", () => {
		const noisy = stats([frame({ hfNoiseDb: 0, cluster: 0.9 })])
		const quiet = stats([frame()])
		expect(
			classifyAnalogTrial(noisy, {
				ctcssHz: 88.5,
				dcs: null,
				audioSeconds: 0.749,
			}),
		).toBe("no-sync")
		expect(
			classifyAnalogTrial(quiet, {
				ctcssHz: 88.5,
				dcs: null,
				audioSeconds: 0.4,
			}),
		).toBe("carrier-only")
		expect(
			classifyAnalogTrial(noisy, {
				ctcssHz: Number.NaN,
				dcs: null,
				audioSeconds: 2,
			}),
		).toBe("no-sync")
		expect(
			classifyAnalogTrial(noisy, {
				ctcssHz: 12.5,
				dcs: null,
				audioSeconds: 2,
			}),
		).toBe("no-sync")
		expect(classifyAnalogTrial(noisy, {} as AnalogTrialTones)).toBe("no-sync")
		expect(
			classifyAnalogTrial(noisy, {
				ctcssHz: null,
				dcs: {} as AnalogTrialTones["dcs"],
				audioSeconds: 2,
			}),
		).toBe("no-sync")
		expect(
			classifyAnalogTrial(noisy, {
				ctcssHz: null,
				dcs: { code: "999", polarity: "normal" },
				audioSeconds: 2,
			}),
		).toBe("no-sync")
		expect(
			classifyAnalogTrial(noisy, {
				ctcssHz: null,
				dcs: { code: "023", polarity: "normal" },
				audioSeconds: Number.NaN,
			}),
		).toBe("no-sync")
		expect(
			classifyAnalogTrial(stats([]), {
				ctcssHz: 88.5,
				dcs: null,
				audioSeconds: 0.4,
			}),
		).toBe("no-sync")
	})

	it("a non-finite statistic fails closed", () => {
		const tone = {
			ctcssHz: 88.5,
			dcs: null,
			audioSeconds: 1,
		}
		expect(
			classifyAnalogTrial(stats([frame({ syllabic: Number.NaN })]), tone),
		).toBe("no-sync")
		expect(
			classifyAnalogTrial(
				stats([frame({ audioDb: Number.POSITIVE_INFINITY, syllabic: 0.9 })]),
				SILENT_TONES,
			),
		).toBe("no-sync")
		expect(
			classifyAnalogTrial(
				stats([frame({ hfNoiseDb: Number.NaN, cluster: 0.9, syllabic: 0.9 })]),
				SILENT_TONES,
			),
		).toBe("no-sync")
		expect(
			classifyAnalogTrial(
				stats([
					frame({
						carrierDb: Number.NaN,
						hfNoiseDb: -20,
						syllabic: 0.9,
						audioDb: -10,
					}),
				]),
				SILENT_TONES,
			),
		).toBe("no-sync")
		expect(
			classifyAnalogTrial(
				stats([frame({ cluster: Number.NaN, syllabic: 0.9, audioDb: -10 })]),
				SILENT_TONES,
			),
		).toBe("no-sync")
		expect(
			isVoice(stats([frame({ syllabic: Number.NaN, audioDb: -10 })])),
		).toBe(false)
		const am = stats([frame({ carrierDb: -90 })], {
			mode: "am",
			floorDb: Number.NaN,
		})
		expect(classifyAnalogTrial(am, SILENT_TONES)).toBe("no-sync")
	})

	it("zero frames are no-sync unless a tone or DCS qualified", () => {
		expect(classifyAnalogTrial(stats([]), SILENT_TONES)).toBe("no-sync")
		expect(isVoice(stats([]))).toBe(false)
		expect(
			classifyAnalogTrial(stats([]), {
				ctcssHz: 88.5,
				dcs: null,
				audioSeconds: 1,
			}),
		).toBe("decoded")
	})

	it("AM uses carrier above the floor in place of FM quieting", () => {
		const amPass = stats([frame({ hfNoiseDb: 0, carrierDb: -94 })], {
			mode: "am",
			floorDb: -100,
		})
		expect(classifyAnalogTrial(amPass, SILENT_TONES)).toBe("carrier-only")
		const amMiss = stats([frame({ hfNoiseDb: -40, carrierDb: -94.1 })], {
			mode: "am",
			floorDb: -100,
		})
		expect(classifyAnalogTrial(amMiss, SILENT_TONES)).toBe("no-sync")
		const nfmSame = stats([frame({ hfNoiseDb: 0, carrierDb: -40 })], {
			mode: "nfm",
			floorDb: -100,
		})
		expect(classifyAnalogTrial(nfmSame, SILENT_TONES)).toBe("no-sync")
	})
})
