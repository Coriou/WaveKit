import fc from "fast-check"
import { describe, expect, it } from "vitest"
import {
	CLASS_HYPOTHESES,
	classOf,
} from "../../../../src/core/scanner/classify/classifier.js"
import {
	IDENTIFY_PROTOCOLS,
	compatibleClasses,
	identifyScores,
	identifyVerdict,
	inWindow,
	measureTarget,
	planIdentifyTrials,
	resolveTarget,
	toleranceHz,
	trialOutcome,
} from "../../../../src/core/scanner/identify.js"
import type { ScannerProtocol } from "../../../../src/core/scanner/types.js"
import {
	FLAGS,
	TARGET_HZ,
	summaryOf,
	trackOf,
} from "../../../mocks/scanner/identify-fakes.js"

/** The lab handheld as the spectral tier sees it (feasibility run8: ACF30 −0.94, ACF60 +0.99, 8.75–9 kHz). */
const dmrTrack = () => trackOf({ acf30: -0.94, acf60: 0.99 })

const trackArb = fc
	.record({
		obwHz: fc.integer({ min: 200, max: 40_000 }),
		shape: fc.constantFrom(
			"flat" as const,
			"peaked" as const,
			"narrow" as const,
		),
		acf: fc.option(
			fc.tuple(
				fc.double({ min: -1, max: 1, noNaN: true }),
				fc.double({ min: -1, max: 1, noNaN: true }),
			),
			{ nil: null },
		),
		blocks: fc.integer({ min: 1, max: 200 }),
		burst: fc.boolean(),
	})
	.map(r =>
		trackOf({
			obwHz: r.obwHz,
			spectralShape: r.shape,
			blocks: r.blocks,
			...(r.acf ? { acf30: r.acf[0], acf60: r.acf[1] } : {}),
			flags: { ...FLAGS, burst: r.burst },
		}),
	)
const priorsArb = fc
	.array(
		fc.tuple(
			fc.constantFrom(...IDENTIFY_PROTOCOLS),
			fc.constantFrom(0, 0.25, 0.5, 1),
		),
		{ maxLength: 8 },
	)
	.map(
		pairs =>
			Object.fromEntries(pairs) as Partial<Record<ScannerProtocol, number>>,
	)

describe("identify planning (spec § 10.8)", () => {
	// Feature: signal-discovery-scanner, Property 25: Identify trials
	// Validates: spec § 10.8
	it("plans compatible or explicitly requested protocols with positive clamped priors, in score order, one run per probe mode", () => {
		fc.assert(
			fc.property(
				trackArb,
				priorsArb,
				fc.subarray([...IDENTIFY_PROTOCOLS]),
				fc.boolean(),
				(track, priors, protocols, channelizer) => {
					const plan = planIdentifyTrials(
						identifyScores(track, { priors, protocols }),
						{ format: "U8_IQ", channelizer },
					)
					const classes = compatibleClasses(track)
					expect(classes[0]).toBe(classOf(track))
					const expected = IDENTIFY_PROTOCOLS.filter(
						p =>
							!["ais", "acars", "vdl2", "lora"].includes(p) &&
							(protocols.length > 0 ||
								classes[0] !== "carrier" ||
								p === "analog-fm") &&
							(protocols.length === 0 || protocols.includes(p)) &&
							(protocols.length > 0 ||
								classes.some(c =>
									CLASS_HYPOTHESES[c].some(h => h.protocol === p),
								)),
					)
					const planned = plan.trials.map(t => t.protocol)
					expect(new Set(planned).size).toBe(planned.length)
					expect([...planned].sort()).toEqual([...expected].sort())
					for (let i = 1; i < plan.trials.length; i++) {
						expect(plan.trials[i - 1]!.score).toBeGreaterThanOrEqual(
							plan.trials[i]!.score,
						)
					}
					const firstUse = plan.runs.map((_, r) =>
						plan.trials.findIndex(t => t.run === r),
					)
					expect(
						firstUse.every(
							(at, r) => at >= 0 && (r === 0 || at > firstUse[r - 1]!),
						),
					).toBe(true)
					for (const t of plan.trials) {
						if (t.run === null) expect(t.transport).toBeNull()
						else expect(plan.runs[t.run]!.protocols).toContain(t.protocol)
					}
				},
			),
			{ numRuns: 100, seed: 25 },
		)
	})

	it("tries dsd-fme auto first on a DMR handheld, in one run with D-STAR, YSF and P25", () => {
		const plan = planIdentifyTrials(
			identifyScores(dmrTrack(), { priors: {}, protocols: [] }),
			{ format: "U8_IQ", channelizer: false },
		)
		expect(plan.trials[0]).toMatchObject({
			protocol: "dmr",
			decoder: "dsd-fme",
			mode: "auto",
			transport: "offset",
			run: 0,
		})
		expect(plan.runs[0]).toMatchObject({
			protocols: ["dmr", "dstar", "ysf", "p25p1"],
			holdMs: 2000,
		})
		expect(
			plan.runs.map(
				r => `${r.mode.decoderType}:${String(r.mode.options["mode"] ?? "")}`,
			),
		).toEqual(["dsd-fme:auto", "direwolf:", "multimon-ng:", "dsd-fme:nxdn"])
		expect(plan.trials.find(t => t.protocol === "analog-fm")).toMatchObject({
			transport: null,
			run: null,
			reason: "no-decoder",
		})
		expect(plan.trials.some(t => t.protocol === "ism")).toBe(false)
	})

	it("applies the request's protocol restriction and retains a protocol whose prior is 0", () => {
		expect(
			identifyScores(dmrTrack(), { priors: {}, protocols: ["pocsag"] }).map(
				h => h.protocol,
			),
		).toEqual(["pocsag"])
		const noDmr = identifyScores(dmrTrack(), {
			priors: { dmr: 0 },
			protocols: [],
		})
		expect(noDmr.find(h => h.protocol === "dmr")?.score).toBeGreaterThan(0)
		expect(noDmr[0]?.protocol).toBe("aprs")
	})

	it("marks trials unsupported on a non-U8 source, and ISM as needing the channelizer", () => {
		const s16 = planIdentifyTrials(
			identifyScores(dmrTrack(), { priors: {}, protocols: [] }),
			{ format: "S16_IQ", channelizer: false },
		)
		expect(s16.runs).toEqual([])
		expect(new Set(s16.trials.map(t => t.reason))).toEqual(
			new Set(["unsupported-format", "no-decoder"]),
		)
		const burst = trackOf({
			obwHz: 20_000,
			spectralShape: "peaked",
			blocks: 2,
			flags: { ...FLAGS, burst: true },
		})
		const plan = planIdentifyTrials(
			identifyScores(burst, { priors: {}, protocols: [] }),
			{ format: "U8_IQ", channelizer: false },
		)
		expect(plan.trials[0]).toMatchObject({
			protocol: "ism",
			decoder: "rtl433",
			transport: null,
			run: null,
			reason: "needs-channelizer",
		})
	})

	it("resolves a target to the nearest live track within max(1 kHz, bw/2), the stronger one on a tie", () => {
		const view = (centreHz: number, snrDb: number) => ({
			track: trackOf({ centreHz, snrDb }),
		})
		const a = view(TARGET_HZ + 800, 20)
		const b = view(TARGET_HZ - 800, 30)
		const far = view(TARGET_HZ + 4000, 50)
		expect(toleranceHz(undefined)).toBe(1000)
		expect(toleranceHz(12_500)).toBe(6250)
		expect(resolveTarget(TARGET_HZ, 1000, [a, b, far])).toBe(b)
		expect(resolveTarget(TARGET_HZ, 1000, [far])).toBeNull()
		expect(resolveTarget(TARGET_HZ, 6250, [far])).toBe(far)
	})

	it("accepts a target only inside the usable window, bandwidth included", () => {
		const w = { centreHz: 446_000_000, sampleRateHz: 2_048_000 }
		expect(inWindow(446_819_200, 0, w, 0.8)).toBe(true)
		expect(inWindow(446_819_201, 0, w, 0.8)).toBe(false)
		expect(inWindow(446_815_000, 12_500, w, 0.8)).toBe(false)
	})

	it("maps what a run saw to the trial outcome, and the evidence to the target verdict", () => {
		expect(trialOutcome(undefined)).toBe("no-sync")
		expect(trialOutcome({ output: true, crcFailures: 2, identity: null })).toBe(
			"crc-errors",
		)
		expect(trialOutcome({ output: true, crcFailures: 0, identity: null })).toBe(
			"timeout",
		)
		expect(
			trialOutcome({
				output: true,
				crcFailures: 1,
				identity: { kind: "dmr-cc", value: "1" },
			}),
		).toBe("decoded")
		const v = {
			artefact: null,
			decoded: false,
			heardIdentity: false,
			discoveryConfidence: null,
			topScore: 0,
		}
		expect(identifyVerdict({ ...v, artefact: "dc", decoded: true })).toBe(
			"unidentified",
		)
		expect(identifyVerdict({ ...v, decoded: true })).toBe("identified")
		expect(identifyVerdict({ ...v, heardIdentity: true })).toBe("candidate")
		expect(identifyVerdict({ ...v, discoveryConfidence: "classified" })).toBe(
			"unidentified",
		)
		expect(identifyVerdict({ ...v, topScore: 0.5 })).toBe("unidentified")
		expect(
			identifyVerdict({
				...v,
				topScore: 0.49,
				discoveryConfidence: "candidate",
			}),
		).toBe("unidentified")
	})

	it("measures from the track, or from the latest block summary when no track resolved", () => {
		expect(measureTarget(dmrTrack(), null, TARGET_HZ, 1000)).toEqual({
			source: "track",
			centreHz: TARGET_HZ,
			obwHz: 9000,
			peakDbfs: -40,
			snrDb: 30,
			floorDbfs: -75,
			dutyCycle: 1,
			acf30: -0.94,
			acf60: 0.99,
			class: "tdma-ms",
		})
		expect(measureTarget(null, summaryOf(), TARGET_HZ, 1000)).toEqual({
			source: "spectrum",
			centreHz: TARGET_HZ,
			obwHz: null,
			peakDbfs: -50,
			snrDb: 30,
			floorDbfs: -80,
			dutyCycle: null,
			class: "unknown",
		})
		expect(measureTarget(null, null, TARGET_HZ, 1000)).toMatchObject({
			source: "spectrum",
			peakDbfs: null,
			snrDb: null,
			floorDbfs: null,
		})
	})
})
