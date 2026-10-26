/** WG12 Property 12, planner half: known first, one analog, digital by score, at most 8. */
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import {
	familyOf,
	inPagerRange,
} from "../../../../src/core/scanner/classify/classifier.js"
import { bandplansFor } from "../../../../src/core/scanner/bandplan/index.js"
import type { BandRegionCode } from "../../../../src/core/scanner/bandplan/index.js"
import { identifyScores } from "../../../../src/core/scanner/identify.js"
import {
	IQ_REPLAY_MAX_TRIALS,
	type IqReplayPlanInput,
} from "../../../../src/core/scanner/iq-capture-contract.js"
import { planReplayTrials } from "../../../../src/core/scanner/replay-plan.js"
import type { ScannerProtocol } from "../../../../src/core/scanner/types.js"
import { TARGET_HZ, trackOf } from "../../../mocks/scanner/identify-fakes.js"

const REGIONS = [
	"EU",
	"US",
	"CA",
	"AU",
	"NZ",
	"JP",
	"CN",
] as const satisfies readonly BandRegionCode[]

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

const REPLAYABLE = new Set<ScannerProtocol>([
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
])

function listsAm(hz: number): boolean {
	if (!Number.isFinite(hz)) return false
	for (const region of REGIONS) {
		for (const plan of bandplansFor(region)) {
			for (const range of plan.ranges) {
				if (hz < range.startHz || hz > range.endHz) continue
				if (range.protocols?.includes("analog-am")) return true
			}
		}
	}
	return false
}

function scoresOf(input: IqReplayPlanInput): Map<ScannerProtocol, number> {
	const scores = new Map<ScannerProtocol, number>()
	if (input.track) {
		for (const h of identifyScores(input.track, {
			priors: input.priors,
			protocols: [],
			narrow: input.narrowRaster === true,
		}))
			scores.set(h.protocol, h.score)
	} else {
		for (const [protocol, prior] of Object.entries(input.priors) as [
			ScannerProtocol,
			number | undefined,
		][]) {
			if (typeof prior === "number" && prior > 0) scores.set(protocol, prior)
		}
	}
	return scores
}

describe("planReplayTrials analog order", () => {
	// Feature: scanner-redesign, Property 12: Replay order and stop
	// Validates: Requirements 4.4, 4.6, 5.5
	// known first, ≤ 1 analog, digital by score; no digital after analog decoded/heard; ≤ 8 run;
	// exactly one result and one discard per capture. numRuns: 100
	it("known first, at most one analog, digital by score, at most 8", () => {
		fc.assert(
			fc.property(
				fc.record({
					hasTrack: fc.boolean(),
					obwHz: fc.integer({ min: 500, max: 24_000 }),
					shape: fc.constantFrom(
						"flat" as const,
						"peaked" as const,
						"narrow" as const,
					),
					known: fc.oneof(fc.constant(null), fc.constantFrom(...ALL)),
					priors: fc.dictionary(
						fc.constantFrom(...ALL),
						fc.constantFrom(0, 0.25, 0.5, 1, 2),
						{ maxKeys: 12 },
					),
					narrow: fc.boolean(),
					amBand: fc.boolean(),
				}),
				c => {
					const rfHz = c.amBand ? 120_000_000 : TARGET_HZ
					const input: IqReplayPlanInput = {
						capture: {
							captureId: "c1",
							sourceId: "rtl",
							observationId: "o",
							epoch: 1,
							rfHz,
							tuningTrust: "commanded",
							capturedAtMs: 0,
							durationMs: 2000,
							gapSamples: 0,
						},
						track: c.hasTrack
							? trackOf({ obwHz: c.obwHz, spectralShape: c.shape })
							: null,
						knownProtocol: c.known,
						priors: c.priors,
						narrowRaster: c.narrow,
					}
					const out = planReplayTrials(input)
					expect(out.length).toBeLessThanOrEqual(IQ_REPLAY_MAX_TRIALS)
					const analogs = out.filter(t => t.kind === "analog")
					const fm = c.priors["analog-fm"]
					const amPrior = c.priors["analog-am"]
					const knownAnalog =
						(c.known === "analog-fm" || c.known === "analog-am") &&
						c.priors[c.known] !== 0
					const wanted =
						knownAnalog ||
						(typeof fm === "number" && fm > 0) ||
						(typeof amPrior === "number" && amPrior > 0)
					expect(analogs).toHaveLength(wanted ? 1 : 0)
					const replayable =
						c.known !== null &&
						c.priors[c.known] !== 0 &&
						REPLAYABLE.has(c.known)
					const analogBehindPager =
						knownAnalog &&
						inPagerRange(c.priors) &&
						out.some(
							t => t.kind !== "analog" && familyOf(t.protocol) === "pager",
						)
					const knownPlanned = replayable || (knownAnalog && !analogBehindPager)
					if (knownPlanned)
						expect(out[0]).toMatchObject({ protocol: c.known, known: true })
					expect(out.filter(t => t.known)).toHaveLength(knownPlanned ? 1 : 0)
					if (analogs.length === 1) {
						const analog = analogs[0]!
						// In a paging range a known analog trial runs after the pager trials, unflagged.
						const pagerTrials = out.filter(
							t => t.kind !== "analog" && familyOf(t.protocol) === "pager",
						)
						const pagerFirst = inPagerRange(c.priors) && pagerTrials.length > 0
						if (knownAnalog && pagerFirst) {
							expect(analog.known).toBe(false)
							expect(out.indexOf(analog)).toBe(pagerTrials.length)
						} else if (knownAnalog) {
							expect(analog.known).toBe(true)
							expect(out.indexOf(analog)).toBe(0)
							expect(analog.protocol).toBe(c.known)
							expect(analog.analogMode).toBe(
								c.known === "analog-am" ? "am" : "nfm",
							)
						} else {
							// in a paging range the analog trial follows the pager trials.
							expect(out.indexOf(analog)).toBe(
								out.filter(
									t =>
										t.known ||
										(inPagerRange(c.priors) &&
											t.kind !== "analog" &&
											familyOf(t.protocol) === "pager"),
								).length,
							)
							const amBand = listsAm(rfHz)
							const fmPos = typeof fm === "number" && fm > 0
							const amPos = typeof amPrior === "number" && amPrior > 0
							const expectAm = amPos && (amBand || !fmPos)
							expect(analog.analogMode).toBe(expectAm ? "am" : "nfm")
							expect(analog.protocol).toBe(expectAm ? "analog-am" : "analog-fm")
							expect(analog.known).toBe(false)
							const chosen = c.priors[analog.protocol]
							expect(typeof chosen === "number" && chosen > 0).toBe(true)
						}
					}
					const scores = scoresOf(input)
					const digital = out.filter(t => t.kind !== "analog" && !t.known)
					for (let i = 1; i < digital.length; i++) {
						const prev = digital[i - 1]!
						const cur = digital[i]!
						const ds =
							(scores.get(prev.protocol) ?? 0) - (scores.get(cur.protocol) ?? 0)
						// in a paging range the pager trials lead the digital ones.
						const group = (p: ScannerProtocol): number =>
							inPagerRange(c.priors) && familyOf(p) === "pager" ? 0 : 1
						const dg = group(cur.protocol) - group(prev.protocol)
						if (dg !== 0) {
							expect(dg).toBeGreaterThan(0)
							continue
						}
						expect(
							ds > 0 ||
								(ds === 0 && prev.protocol.localeCompare(cur.protocol) <= 0),
						).toBe(true)
					}
					for (const t of out) {
						expect(t.mode.decoderType).not.toBe("rtl433")
						if (t.kind !== "analog")
							expect(["ais", "acars", "vdl2", "lora"]).not.toContain(t.protocol)
					}
				},
			),
			{ numRuns: 100 },
		)
	})
})
