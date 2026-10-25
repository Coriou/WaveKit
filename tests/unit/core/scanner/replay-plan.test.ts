/** WG11 req 6.4 / 1.7 (planner side): planReplayTrials order, filters and bound. */
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import {
	familyOf,
	inPagerRange,
} from "../../../../src/core/scanner/classify/classifier.js"
import {
	IQ_REPLAY_MAX_TRIALS,
	type IqCaptureView,
	type IqReplayPlanInput,
	type IqReplayTrial,
} from "../../../../src/core/scanner/iq-capture-contract.js"
import {
	boundReplayTrials,
	planReplayTrials,
} from "../../../../src/core/scanner/replay-plan.js"
import type { ScannerProtocol } from "../../../../src/core/scanner/types.js"
import { TARGET_HZ, trackOf } from "../../../mocks/scanner/identify-fakes.js"

const capture: IqCaptureView = {
	captureId: "c1",
	sourceId: "rtl",
	observationId: "o_t1",
	epoch: 1,
	rfHz: TARGET_HZ,
	tuningTrust: "commanded",
	capturedAtMs: 0,
	durationMs: 2000,
	gapSamples: 0,
}

function input(over: Partial<IqReplayPlanInput> = {}): IqReplayPlanInput {
	return {
		capture,
		track: trackOf({ acf30: -0.94, acf60: 0.99 }),
		knownProtocol: null,
		priors: {},
		narrowRaster: false,
		...over,
	}
}

const key = (t: IqReplayTrial) =>
	`${t.mode.decoderType}:${JSON.stringify(t.mode.options)}`

const ALL: ScannerProtocol[] = [
	"analog-fm",
	"analog-am",
	"dmr",
	"p25p1",
	"p25p2",
	"nxdn48",
	"nxdn96",
	"ysf",
	"dstar",
	"dpmr",
	"pocsag",
	"flex",
	"aprs",
	"ism",
	"ais",
	"acars",
	"vdl2",
	"lora",
	"unknown",
	"carrier",
]

describe("planReplayTrials", () => {
	it("a DMR track: the probe modes by score, deduplicated, no known", () => {
		const out = planReplayTrials(input())
		expect(out.map(t => [t.protocol, t.known])).toEqual([
			["dmr", false],
			["aprs", false],
			["pocsag", false],
			["nxdn96", false],
		])
	})

	it("the known protocol first (known: true), deduplicated against the track's modes", () => {
		const out = planReplayTrials(input({ knownProtocol: "nxdn96" }))
		expect(out.map(t => [t.protocol, t.known])).toEqual([
			["nxdn96", true],
			["dmr", false],
			["aprs", false],
			["pocsag", false],
		])
	})

	it("narrow raster adds dpmr, nxdn48 (dstar shares dsd auto with dmr)", () => {
		const out = planReplayTrials(
			input({
				track: trackOf({ obwHz: 11_000, spectralShape: "peaked" }),
				narrowRaster: true,
			}),
		)
		const ps = out.map(t => t.protocol)
		expect(ps).toEqual(expect.arrayContaining(["dpmr", "nxdn48"]))
		expect(ps).not.toContain("analog-fm")
	})

	it("no track: the known protocol alone", () => {
		const out = planReplayTrials(
			input({ track: null, knownProtocol: "dmr", priors: { pocsag: 1 } }),
		)
		expect(out.map(t => [t.protocol, t.known])).toEqual([["dmr", true]])
	})

	it("a prior of 0 removes the known protocol too (requirement 1.3)", () => {
		const out = planReplayTrials(
			input({ track: null, knownProtocol: "dmr", priors: { dmr: 0 } }),
		)
		expect(out).toEqual([])
		const withTrack = planReplayTrials(
			input({ knownProtocol: "dmr", priors: { dmr: 0 } }),
		)
		expect(withTrack.some(t => t.known)).toBe(false)
	})

	it("no track, no known: analog trial when its prior is above 0, then modes by prior; never ambient or rtl433", () => {
		// Spec 5.6: analog-fm prior 3 is a replay analog trial. Ambient and rtl433 stay out.
		const out = planReplayTrials(
			input({
				track: null,
				priors: {
					pocsag: 0.5,
					dmr: 2,
					dpmr: 0,
					"analog-fm": 3,
					ais: 3,
					ism: 3,
					flex: 0.5,
				},
			}),
		)
		expect(out.map(t => t.protocol)).toEqual(["analog-fm", "dmr", "flex"])
		expect(out[0]).toMatchObject({
			kind: "analog",
			analogMode: "nfm",
			known: false,
		})
		expect(out.map(t => t.mode.decoderType)).not.toContain("rtl433")
		expect(out.map(t => t.protocol)).not.toContain("ais")
		expect(out.map(t => t.protocol)).not.toContain("ism")
	})

	it("an unknown known protocol is no trial", () => {
		expect(
			planReplayTrials(
				input({ track: null, knownProtocol: "bogus" as ScannerProtocol }),
			),
		).toEqual([])
	})

	it("known analog-fm is the analog trial first, known true, even with a missing prior", () => {
		const out = planReplayTrials(
			input({ track: null, knownProtocol: "analog-fm" }),
		)
		expect(out).toHaveLength(1)
		expect(out[0]).toMatchObject({
			protocol: "analog-fm",
			kind: "analog",
			analogMode: "nfm",
			known: true,
		})
	})

	it("known analog-am is mode am and known true", () => {
		const out = planReplayTrials(
			input({ track: null, knownProtocol: "analog-am" }),
		)
		expect(out).toHaveLength(1)
		expect(out[0]).toMatchObject({
			protocol: "analog-am",
			kind: "analog",
			analogMode: "am",
			known: true,
		})
	})

	it("known analog with an explicit prior of 0 is not planned", () => {
		expect(
			planReplayTrials(
				input({
					track: null,
					knownProtocol: "analog-fm",
					priors: { "analog-fm": 0 },
				}),
			),
		).toEqual([])
		const other = planReplayTrials(
			input({
				track: null,
				knownProtocol: "analog-fm",
				priors: { "analog-fm": 0, "analog-am": 1 },
			}),
		)
		expect(other).toHaveLength(1)
		expect(other[0]).toMatchObject({
			protocol: "analog-am",
			analogMode: "am",
			known: false,
			kind: "analog",
		})
	})

	it("known analog is first and is the only analog trial", () => {
		const fm = planReplayTrials(
			input({
				knownProtocol: "analog-fm",
				priors: { "analog-fm": 1, "analog-am": 1 },
				capture: { ...capture, rfHz: 120_000_000 },
			}),
		)
		expect(fm.filter(t => t.kind === "analog")).toHaveLength(1)
		expect(fm[0]).toMatchObject({
			protocol: "analog-fm",
			analogMode: "nfm",
			known: true,
			kind: "analog",
		})
		expect(fm.slice(1).every(t => t.kind !== "analog")).toBe(true)
		const am = planReplayTrials(
			input({
				knownProtocol: "analog-am",
				priors: { "analog-fm": 1, "analog-am": 1 },
			}),
		)
		expect(am.filter(t => t.kind === "analog")).toHaveLength(1)
		expect(am[0]).toMatchObject({
			protocol: "analog-am",
			analogMode: "am",
			known: true,
		})
	})

	it(`bound: ${IQ_REPLAY_MAX_TRIALS} candidates kept, the 9th dropped, order kept`, () => {
		const mk = (i: number, known = false): IqReplayTrial => ({
			protocol: "dmr",
			mode: {
				decoderType: "dsd-fme",
				protocol: "dmr",
				covers: ["dmr"],
				options: { mode: `m${i}` },
				holdMs: 1000,
			},
			known,
		})
		const eight = Array.from({ length: 8 }, (_, i) => mk(i, i === 0))
		expect(boundReplayTrials(eight)).toEqual(eight)
		const nine = [...eight, mk(8)]
		expect(boundReplayTrials(nine)).toEqual(eight)
		expect(boundReplayTrials([mk(1), mk(1), mk(2)])).toEqual([mk(1), mk(2)])
	})

	it("known dmr first, then analog nfm, then digital by score", () => {
		const out = planReplayTrials(
			input({
				knownProtocol: "dmr",
				priors: { "analog-fm": 1, "analog-am": 1 },
			}),
		)
		expect(out.map(t => [t.protocol, t.known, t.kind ?? "probe"])).toEqual([
			["dmr", true, "probe"],
			["analog-fm", false, "analog"],
			["aprs", false, "probe"],
			["pocsag", false, "probe"],
			["nxdn96", false, "probe"],
		])
		expect(out[1]).toMatchObject({ analogMode: "nfm", kind: "analog" })
	})

	it("AM band plan → analogMode am", () => {
		const out = planReplayTrials(
			input({
				capture: { ...capture, rfHz: 120_000_000 },
				priors: { "analog-fm": 1, "analog-am": 1 },
			}),
		)
		expect(out[0]).toMatchObject({
			kind: "analog",
			protocol: "analog-am",
			analogMode: "am",
			known: false,
		})
	})

	it("120 MHz with analog-am prior 0 and analog-fm prior 1 → analog-fm nfm", () => {
		const out = planReplayTrials(
			input({
				capture: { ...capture, rfHz: 120_000_000 },
				priors: { "analog-am": 0, "analog-fm": 1 },
			}),
		)
		const analog = out.filter(t => t.kind === "analog")
		expect(analog).toHaveLength(1)
		expect(analog[0]).toMatchObject({
			protocol: "analog-fm",
			analogMode: "nfm",
			kind: "analog",
		})
	})

	it("AM-only positive prior outside AM ranges → analog-am am", () => {
		const out = planReplayTrials(
			input({
				capture: { ...capture, rfHz: TARGET_HZ },
				priors: { "analog-am": 1, "analog-fm": 0 },
			}),
		)
		const analog = out.filter(t => t.kind === "analog")
		expect(analog).toHaveLength(1)
		expect(analog[0]).toMatchObject({
			protocol: "analog-am",
			analogMode: "am",
			kind: "analog",
		})
	})

	it("Analog prior 0 → no analog trial", () => {
		const out = planReplayTrials(input({ priors: { "analog-fm": 0 } }))
		expect(out.some(t => t.kind === "analog")).toBe(false)
		expect(out.map(t => t.protocol)).toEqual([
			"dmr",
			"aprs",
			"pocsag",
			"nxdn96",
		])
	})

	it("Analog excluded by request → none", () => {
		// The frozen plan input has no protocol allow-list. A prior of 0 is how a request
		// removes analog-fm and analog-am (requirement 1.3, 5.6).
		const out = planReplayTrials(
			input({
				knownProtocol: "dmr",
				priors: { dmr: 1, "analog-fm": 0, "analog-am": 0 },
			}),
		)
		expect(
			out.some(
				t =>
					t.kind === "analog" ||
					t.protocol === "analog-fm" ||
					t.protocol === "analog-am",
			),
		).toBe(false)
		expect(out[0]).toMatchObject({ protocol: "dmr", known: true })
	})

	it("9 candidates → exactly 8 with analog counted", () => {
		const mk = (i: number): IqReplayTrial => ({
			protocol: "dmr",
			mode: {
				decoderType: "dsd-fme",
				protocol: "dmr",
				covers: ["dmr"],
				options: { mode: `m${i}` },
				holdMs: 1000,
			},
			known: false,
		})
		const analog: IqReplayTrial = {
			protocol: "analog-fm",
			kind: "analog",
			analogMode: "nfm",
			known: false,
			mode: {
				decoderType: "dsd-fme",
				protocol: "analog-fm",
				covers: ["analog-fm"],
				options: { analogTrial: "nfm" },
				holdMs: 0,
			},
		}
		const atBound = [analog, ...Array.from({ length: 7 }, (_, i) => mk(i))]
		expect(atBound).toHaveLength(IQ_REPLAY_MAX_TRIALS)
		expect(boundReplayTrials(atBound)).toEqual(atBound)
		const past = [...atBound, mk(7)]
		expect(past).toHaveLength(IQ_REPLAY_MAX_TRIALS + 1)
		const capped = boundReplayTrials(past)
		expect(capped).toHaveLength(IQ_REPLAY_MAX_TRIALS)
		expect(capped[0]).toMatchObject({ kind: "analog" })
		expect(capped.some(t => t.mode.options["mode"] === "m7")).toBe(false)
	})

	// Feature: web-gaps-11, Property 14: Known first, decays safely (replay planner side)
	// Validates: Requirements 1.7, 6.4
	it("property: at most 8, known first when replayable, unique modes, never rtl433 or ambient; analog only as the one replay trial", () => {
		fc.assert(
			fc.property(
				fc.record({
					hasTrack: fc.boolean(),
					obwHz: fc.integer({ min: 500, max: 24_000 }),
					shape: fc.constantFrom("flat" as const, "peaked" as const),
					known: fc.oneof(fc.constant(null), fc.constantFrom(...ALL)),
					priors: fc.dictionary(
						fc.constantFrom(...ALL),
						fc.constantFrom(0, 0.5, 1, 2),
					),
					narrow: fc.boolean(),
				}),
				c => {
					const out = planReplayTrials(
						input({
							track: c.hasTrack
								? trackOf({ obwHz: c.obwHz, spectralShape: c.shape })
								: null,
							knownProtocol: c.known,
							priors: c.priors,
							narrowRaster: c.narrow,
						}),
					)
					expect(out.length).toBeLessThanOrEqual(IQ_REPLAY_MAX_TRIALS)
					expect(new Set(out.map(key)).size).toBe(out.length)
					const fm = c.priors["analog-fm"]
					const amPrior = c.priors["analog-am"]
					const knownAnalog =
						(c.known === "analog-fm" || c.known === "analog-am") &&
						c.priors[c.known] !== 0
					const priorAnalog =
						(typeof fm === "number" && fm > 0) ||
						(typeof amPrior === "number" && amPrior > 0)
					const analogWanted = knownAnalog || priorAnalog
					const analogs = out.filter(t => t.kind === "analog")
					expect(analogs).toHaveLength(analogWanted ? 1 : 0)
					for (const t of out) {
						expect(t.mode.decoderType).not.toBe("rtl433")
						if (t.kind === "analog") {
							expect(["analog-fm", "analog-am"]).toContain(t.protocol)
							if (knownAnalog) {
								expect(t.known).toBe(true)
								expect(t.protocol).toBe(c.known)
								expect(t.analogMode).toBe(
									c.known === "analog-am" ? "am" : "nfm",
								)
							} else {
								const prior = c.priors[t.protocol]
								expect(typeof prior === "number" && prior > 0).toBe(true)
								expect(t.known).toBe(false)
								// TARGET_HZ is outside shipped AM ranges, so AM only when FM is excluded.
								const fmPos = typeof fm === "number" && fm > 0
								const amPos = typeof amPrior === "number" && amPrior > 0
								const expectAm = amPos && !fmPos
								expect(t.protocol).toBe(expectAm ? "analog-am" : "analog-fm")
								expect(t.analogMode).toBe(expectAm ? "am" : "nfm")
							}
						} else {
							expect([
								"analog-fm",
								"analog-am",
								"ais",
								"acars",
								"vdl2",
								"lora",
							]).not.toContain(t.protocol)
						}
					}
					if (analogs.length === 1) {
						if (analogs[0]!.known) expect(out.indexOf(analogs[0]!)).toBe(0)
						else
							// in a paging range the analog trial follows the pager trials.
							expect(out.indexOf(analogs[0]!)).toBe(
								out.filter(
									t =>
										t.known ||
										(inPagerRange(c.priors) &&
											t.kind !== "analog" &&
											familyOf(t.protocol) === "pager"),
								).length,
							)
					}
					const replayable =
						c.known !== null &&
						c.priors[c.known] !== 0 &&
						[
							"dmr",
							"p25p1",
							"p25p2",
							"nxdn48",
							"nxdn96",
							"ysf",
							"dstar",
							"dpmr",
							"pocsag",
							"flex",
							"aprs",
						].includes(c.known)
					const knownPlanned = replayable || knownAnalog
					if (knownPlanned)
						expect(out[0]).toMatchObject({ protocol: c.known, known: true })
					expect(out.filter(t => t.known).length).toBe(knownPlanned ? 1 : 0)
					if (!c.hasTrack && c.known !== null)
						expect(out.length).toBe(
							(replayable ? 1 : 0) + (analogWanted ? 1 : 0),
						)
				},
			),
			{ numRuns: 300 },
		)
	})
})
