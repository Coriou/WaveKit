import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { classifyAnalogTrial } from "../../../../src/core/scanner/analog-trial.js"
import {
	identifyDigitalProof,
	identifyScores,
	identifyVerdict,
} from "../../../../src/core/scanner/identify.js"
import type { ScannerIdentifyTrial } from "@wavekit/api-types"
import { trackOf } from "../../../mocks/scanner/identify-fakes.js"
import { referenceStats, syntheticTone } from "./identify-synth.js"
import { harness } from "./identify-heard-fakes.js"

const stats = (cluster: number) => ({
	mode: "nfm" as const,
	floorDb: -60,
	gapSamples: 0,
	frames: [
		{ carrierDb: -10, hfNoiseDb: -12, audioDb: -20, syllabic: 0.8, cluster },
	],
})
const verdict = {
	artefact: null,
	decoded: false,
	heardIdentity: false,
	discoveryConfidence: "classified" as const,
	topScore: 1,
}

describe("identify evidence and unrestricted planning", () => {
	// Feature: scanner-redesign, Property 30: Standard subaudible tones beat digital priors
	// Validates: Requirements 6.7, 6.9
	it("identifies FM CTCSS and DCS from noisy synthetic IQ", () => {
		fc.assert(
			fc.property(
				fc.constantFrom("ctcss" as const, "dcs" as const),
				fc.constantFrom(1500, 2500, 5000),
				fc.constantFrom(12, 20, 40, 58),
				fc.integer(),
				fc.boolean(),
				(kind, deviation, snr, seed, inverted) => {
					const { tones } = syntheticTone({
						kind,
						offset: seed % 1001,
						deviation,
						snr,
						seed,
						inverted,
					})
					if (kind === "ctcss") expect(tones.ctcssHz).toBe(74.4)
					else expect(tones.dcs).not.toBeNull()
					expect(classifyAnalogTrial(stats(0.9), tones)).toBe("decoded")
				},
			),
			{ numRuns: 100 },
		)
	})

	// Feature: scanner-redesign, Property 31: Four-level FM does not invent a tone
	// Validates: Requirements 6.7, 6.9
	it("rejects shaped 4FSK tone evidence across SNRs and deviations", () => {
		fc.assert(
			fc.property(
				fc.constantFrom(1050, 1500, 2500),
				fc.constantFrom(6, 12, 20, 40, 58),
				fc.constantFrom(2400, 4800),
				fc.integer(),
				(deviation, snr, baud, seed) => {
					const { tones, disc } = syntheticTone({
						kind: "fsk4",
						deviation,
						snr,
						baud,
						seed,
					})
					expect(tones.ctcssHz).toBeNull()
					expect(tones.dcs).toBeNull()
					const outcome = classifyAnalogTrial(referenceStats(disc), tones)
					expect(["decoded", "heard"]).not.toContain(outcome)
				},
			),
			{ numRuns: 100 },
		)
	})

	// Feature: scanner-redesign, Property 32: Defaults and priors only order trials
	// Validates: Requirements 6.7, 6.9
	it("retains analog and digital trials despite zero priors or default lists", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 3000, max: 5000 }),
				fc.constantFrom("flat" as const, "narrow" as const, "peaked" as const),
				fc.boolean(),
				(obwHz, spectralShape, narrow) => {
					const track = trackOf({ obwHz, spectralShape })
					const ctx = {
						priors: { "analog-fm": 0, dpmr: 0 },
						protocols: ["dmr" as const],
						narrow,
					}
					const scores = identifyScores(track, { ...ctx, explicit: false })
					expect(
						scores.find(s => s.protocol === "analog-fm")?.score,
					).toBeGreaterThan(0)
					if (narrow || spectralShape === "flat")
						expect(
							scores.find(s => s.protocol === "dpmr")?.score,
						).toBeGreaterThan(0)
					expect(
						identifyScores(track, { ...ctx, explicit: true }).map(
							s => s.protocol,
						),
					).toEqual(["dmr"])
				},
			),
			{ numRuns: 100 },
		)
	})

	it("bounds runner trials only with an explicit range or request list", async () => {
		for (const explicit of [false, true]) {
			const h = harness({
				request: { protocols: [] },
				rangeProtocolsAt: () => ({ protocols: ["dmr"], explicit }),
			})
			await h.start(trackOf({ obwHz: 4000, spectralShape: "flat" }))
			const protocols = h.last()?.trials.map(t => t.protocol) ?? []
			if (explicit) expect(protocols).toEqual(["dmr"])
			else
				expect(protocols).toEqual(
					expect.arrayContaining(["analog-fm", "dpmr", "nxdn48"]),
				)
			await h.settle()
		}
		const h = harness({
			request: { protocols: ["analog-fm"] },
			rangeProtocolsAt: () => ({ protocols: ["dmr"], explicit: true }),
		})
		await h.start(trackOf({ obwHz: 4000, spectralShape: "flat" }))
		expect(h.last()?.trials.map(t => t.protocol)).toEqual(["analog-fm"])
		await h.settle()
	})

	it("fails closed for missing, malformed, or throwing verdict evidence", () => {
		expect(identifyVerdict(verdict)).toBe("unidentified")
		for (const analog of [
			undefined,
			null,
			{},
			{ tone: "yes", trusted: true },
			{
				get tone() {
					throw new TypeError("bad evidence")
				},
			},
		]) {
			const value = { ...verdict, analog } as Parameters<
				typeof identifyVerdict
			>[0]
			expect(identifyVerdict(value)).not.toBe("identified")
		}
		expect(
			identifyVerdict({
				...verdict,
				get decoded(): boolean {
					throw new TypeError("bad evidence")
				},
			}),
		).toBe("unidentified")
	})

	it("builds digital proof only for completed unsuccessful digital trials", () => {
		const trial: ScannerIdentifyTrial = {
			protocol: "dpmr",
			decoder: "dsd-fme",
			mode: "dpmr",
			transport: "offset",
			outcome: "no-sync",
		}
		expect(
			identifyDigitalProof(
				[trial, { ...trial, protocol: "nxdn48", outcome: "timeout" }],
				"o1",
				1000,
			)?.summary,
		).toBe("Digital, not decoded (tried dPMR, NXDN)")
		expect(
			identifyDigitalProof([{ ...trial, transport: "replay" }], "o1", 1000)
				?.transport,
		).toBe("replay")
		const analog: ScannerIdentifyTrial = {
			protocol: "analog-fm",
			decoder: "analog-demod",
			mode: "nfm",
			transport: "replay",
			outcome: "data-like",
		}
		expect(
			identifyDigitalProof(
				[
					analog,
					{
						...trial,
						decoder: null,
						mode: null,
						transport: null,
						outcome: "unsupported",
						reason: "no-decoder",
					},
				],
				"o1",
				1000,
			),
		).toMatchObject({ kind: "digital-undecoded", transport: "replay" })
		for (const field of [
			"protocol",
			"decoder",
			"transport",
			"mode",
			"outcome",
		] as const) {
			const missing: Record<string, unknown> = { ...trial }
			delete missing[field]
			for (const malformed of [
				missing,
				{ ...trial, [field]: "unknown-field" },
			]) {
				if (field === "mode" && malformed[field] === "unknown-field") continue
				expect(
					identifyDigitalProof(
						[trial, malformed as unknown as ScannerIdentifyTrial],
						"o1",
						1000,
					),
				).toBeNull()
			}
		}
		expect(
			identifyDigitalProof(
				[{ outcome: "timeout" } as ScannerIdentifyTrial],
				"o1",
				1000,
			),
		).toBeNull()

		for (const outcome of [
			"running",
			"pending",
			"decoded",
			"cancelled",
		] as const)
			expect(
				identifyDigitalProof([{ ...trial, outcome }], "o1", 1000),
			).toBeNull()
	})
})
