/** WG11 req 6.4 / 1.7 (planner side): planReplayTrials order, filters and bound. */
import fc from "fast-check"
import { describe, expect, it } from "vitest"
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

	it("no track, no known: modes of protocols with prior > 0, by prior; never analog, ambient or rtl433", () => {
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
		expect(out.map(t => t.protocol)).toEqual(["dmr", "flex"])
	})

	it("an unknown or analog known protocol is no trial", () => {
		expect(
			planReplayTrials(input({ track: null, knownProtocol: "analog-fm" })),
		).toEqual([])
		expect(
			planReplayTrials(
				input({ track: null, knownProtocol: "bogus" as ScannerProtocol }),
			),
		).toEqual([])
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

	// Feature: web-gaps-11, Property 14: Known first, decays safely (replay planner side)
	// Validates: Requirements 1.7, 6.4
	it("property: at most 8, known first when replayable, unique modes, never rtl433/analog/ambient", () => {
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
					for (const t of out) {
						expect(t.mode.decoderType).not.toBe("rtl433")
						expect([
							"analog-fm",
							"analog-am",
							"ais",
							"acars",
							"vdl2",
							"lora",
						]).not.toContain(t.protocol)
					}
					const replayable =
						c.known !== null &&
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
					if (replayable)
						expect(out[0]).toMatchObject({ protocol: c.known, known: true })
					expect(out.filter(t => t.known).length).toBe(replayable ? 1 : 0)
					if (!c.hasTrack && c.known !== null)
						expect(out.length).toBe(replayable ? 1 : 0)
				},
			),
			{ numRuns: 300 },
		)
	})
})
