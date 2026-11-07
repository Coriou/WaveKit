import fc from "fast-check"
import {
	SCANNER_IDENTIFY_VERDICT_CODES,
	SCANNER_IDENTIFY_VERDICT_WHY,
	SCANNER_TRIAL_OUTCOMES,
	type ScannerIdentifyEventData,
	type ScannerIdentifyResult,
	type ScannerIdentifyTrial,
	type ScannerIdentifyVerdict,
	type ScannerTrialOutcome,
} from "@wavekit/api-types"
import { describe, expect, it } from "vitest"
import {
	identifyTargetVerdict,
	type IdentifyVerdictInput,
} from "../../../../src/core/scanner/identify-verdict.js"
import {
	identifyNextStep,
	identifyRequestJoins,
	identifyTuneCentreHz,
	normaliseIdentify,
} from "../../../../src/core/scanner/identify.js"

const METADATA: ScannerIdentifyResult["metadata"] = {
	talkgroups: [],
	sources: [],
	slots: [],
	callsigns: [],
	capcodes: [],
	ismModels: [],
}

function resultOf(
	over: Partial<ScannerIdentifyResult> = {},
	source: "track" | "spectrum" = "track",
): ScannerIdentifyResult {
	return {
		confidence: "activity",
		metadata: METADATA,
		measurements: {
			source,
			centreHz: 1,
			obwHz: null,
			peakDbfs: null,
			snrDb: null,
			floorDbfs: null,
			dutyCycle: null,
			class: "unknown",
		},
		...over,
	}
}

function trialOf(
	outcome: ScannerTrialOutcome,
	over: Partial<ScannerIdentifyTrial> = {},
): ScannerIdentifyTrial {
	return {
		protocol: "dmr",
		decoder: "dsd-fme",
		mode: "auto",
		transport: "offset",
		outcome,
		...over,
	}
}

function input(over: Partial<IdentifyVerdictInput> = {}): IdentifyVerdictInput {
	return {
		state: "unidentified",
		trials: [],
		result: resultOf(),
		requested: [],
		heard: null,
		stopped: null,
		...over,
	}
}

/** Typed by the outcome union: a new outcome does not compile until it is mapped here. */
const BY_OUTCOME: Record<ScannerTrialOutcome, ScannerIdentifyVerdict> = {
	pending: { code: "could-not-test", why: "unknown" },
	running: { code: "could-not-test", why: "unknown" },
	// A trial that says decoded without a confirmed identity in the result claims nothing.
	decoded: { code: "could-not-test", why: "unknown" },
	"no-sync": { code: "undecodable" },
	"crc-errors": { code: "undecodable" },
	// Output without an accepted identity on a probe: a lone sync or one decode.
	timeout: { code: "heard-digital-unconfirmed", protocol: "dmr" },
	"skipped-budget": { code: "could-not-test", why: "budget" },
	unsupported: { code: "could-not-test", why: "unknown" },
	"not-needed": { code: "could-not-test", why: "unknown" },
	cancelled: { code: "could-not-test", why: "interrupted" },
	heard: { code: "undecodable" },
	"data-like": { code: "undecodable" },
	"carrier-only": { code: "undecodable" },
}

describe("identifyTargetVerdict", () => {
	it.each(SCANNER_TRIAL_OUTCOMES)("maps the trial outcome %s", outcome => {
		expect(
			identifyTargetVerdict(input({ trials: [trialOf(outcome)] })),
		).toEqual(BY_OUTCOME[outcome])
	})

	it("the mapping table covers exactly the outcomes of the api-types list", () => {
		expect(Object.keys(BY_OUTCOME).sort()).toEqual(
			[...SCANNER_TRIAL_OUTCOMES].sort(),
		)
	})

	it.each([
		["no-decoder", "unsupported-protocol"],
		["needs-channelizer", "unsupported-protocol"],
		["no-ambient-decoder", "unsupported-protocol"],
		["adsb-window", "unsupported-protocol"],
		["unsupported-format", "unsupported-format"],
		["decoder-unavailable", "decoders-unavailable"],
		["no-live-audio", "no-live-audio"],
	] as const)("an unsupported trial with reason %s is %s", (reason, why) => {
		expect(
			identifyTargetVerdict(
				input({ trials: [trialOf("unsupported", { reason })] }),
			),
		).toEqual({ code: "could-not-test", why })
	})

	it("a confirmed identity is decoded; a candidate with the same identity never is", () => {
		const result = resultOf({
			protocol: "dmr",
			identity: { kind: "dmr-cc", value: "1" },
			confidence: "decoded",
		})
		expect(
			identifyTargetVerdict(
				input({
					state: "identified",
					result,
					trials: [trialOf("decoded")],
				}),
			),
		).toEqual({ code: "decoded", protocol: "dmr" })
		expect(
			identifyTargetVerdict(input({ state: "candidate", result })),
		).toEqual({ code: "heard-digital-unconfirmed", protocol: "dmr" })
	})

	it("identified with no identity, anchor or tone is not decoded", () => {
		expect(
			identifyTargetVerdict(
				input({
					state: "identified",
					result: resultOf({ protocol: "dmr" }),
					trials: [trialOf("decoded")],
				}),
			).code,
		).toBe("could-not-test")
	})

	it("names the protocol decoded even when the request named another", () => {
		expect(
			identifyTargetVerdict(
				input({
					state: "identified",
					requested: ["dmr"],
					result: resultOf({
						protocol: "p25p1",
						identity: { kind: "p25-nac", value: "293" },
					}),
					trials: [trialOf("no-sync")],
				}),
			),
		).toEqual({ code: "decoded", protocol: "p25p1" })
	})

	it("a decode anchor and an analog tone are decoded; analog voice alone is not", () => {
		expect(
			identifyTargetVerdict(
				input({
					state: "identified",
					result: resultOf({ protocol: "adsb", alreadyDecoded: "x" }),
				}),
			),
		).toEqual({ code: "decoded", protocol: "adsb" })
		const analog = {
			source: "live-audio",
			modulation: "nfm",
			transmissions: 1,
			transmissionId: "t",
			ctcssHz: 88.5,
			dcs: null,
			tuningTrust: "commanded",
		} as const
		expect(
			identifyTargetVerdict(
				input({
					state: "identified",
					result: resultOf({ protocol: "analog-fm", analog }),
					trials: [
						trialOf("decoded", {
							protocol: "analog-fm",
							decoder: "live-audio",
						}),
					],
				}),
			),
		).toEqual({ code: "decoded", protocol: "analog-fm" })
		expect(
			identifyTargetVerdict(
				input({
					state: "candidate",
					result: resultOf({ analog: { ...analog, ctcssHz: null } }),
					trials: [
						trialOf("heard", { protocol: "analog-fm", decoder: "live-audio" }),
					],
				}),
			),
		).toEqual({ code: "undecodable" })
	})

	it("a lone sync on another protocol than the one named is heard, not undecodable", () => {
		expect(
			identifyTargetVerdict(
				input({
					requested: ["dmr"],
					heard: "p25p1",
					trials: [trialOf("no-sync")],
				}),
			),
		).toEqual({ code: "heard-digital-unconfirmed", protocol: "p25p1" })
	})

	it("an ambient decoder that stayed silent heard nothing itself", () => {
		expect(
			identifyTargetVerdict(
				input({
					trials: [
						trialOf("timeout", {
							protocol: "ais",
							decoder: "ais-catcher",
							transport: "ambient",
						}),
					],
				}),
			),
		).toEqual({ code: "undecodable" })
	})

	it("no signal is nothing; a track with no trial could not be tested", () => {
		expect(
			identifyTargetVerdict(input({ result: resultOf({}, "spectrum") })),
		).toEqual({ code: "nothing" })
		expect(
			identifyTargetVerdict(
				input({
					requested: ["dmr"],
					result: resultOf({ ended: "no-signal" }, "spectrum"),
				}),
			),
		).toEqual({ code: "nothing", protocol: "dmr" })
		expect(identifyTargetVerdict(input())).toEqual({
			code: "could-not-test",
			why: "unsupported-protocol",
		})
	})

	it("says what stopped it: artefact, window moved, source lost, cancelled", () => {
		expect(
			identifyTargetVerdict(input({ result: resultOf({ artefact: "dc" }) })),
		).toEqual({ code: "could-not-test", why: "artefact" })
		expect(
			identifyTargetVerdict(
				input({
					result: resultOf({ ended: "window-moved" }),
					trials: [trialOf("cancelled")],
				}),
			),
		).toEqual({ code: "could-not-test", why: "window-moved" })
		for (const stopped of ["source-lost", "cancelled"] as const)
			expect(
				identifyTargetVerdict(
					input({
						stopped,
						result: resultOf({}, "spectrum"),
						requested: ["dmr"],
					}),
				),
			).toEqual({ code: "could-not-test", why: stopped, protocol: "dmr" })
	})

	it("one untested plausible trial withholds undecodable", () => {
		expect(
			identifyTargetVerdict(
				input({
					trials: [
						trialOf("no-sync", { protocol: "pocsag" }),
						trialOf("skipped-budget"),
					],
				}),
			),
		).toEqual({ code: "could-not-test", why: "budget" })
		expect(
			identifyTargetVerdict(
				input({
					result: resultOf({ decodersUnavailable: ["dsd-fme"] }),
					trials: [trialOf("no-sync", { protocol: "pocsag" })],
				}),
			),
		).toEqual({ code: "could-not-test", why: "decoders-unavailable" })
	})

	it("an analog trial with no probe decoder says nothing about a digital signal, unless it was named", () => {
		const analog = trialOf("unsupported", {
			protocol: "analog-fm",
			decoder: null,
			reason: "no-decoder",
		})
		expect(
			identifyTargetVerdict(input({ trials: [trialOf("no-sync"), analog] })),
		).toEqual({ code: "undecodable" })
		expect(
			identifyTargetVerdict(
				input({
					requested: ["analog-fm"],
					trials: [trialOf("no-sync"), analog],
				}),
			),
		).toEqual({
			code: "could-not-test",
			why: "unsupported-protocol",
			protocol: "analog-fm",
		})
	})

	it("a named protocol missing from the trials is unknown", () => {
		expect(
			identifyTargetVerdict(
				input({ requested: ["ysf"], trials: [trialOf("no-sync")] }),
			),
		).toEqual({ code: "could-not-test", why: "unknown", protocol: "ysf" })
	})

	it("an unknown outcome, no result, or a throw is the safe answer", () => {
		const unknown = { code: "could-not-test", why: "unknown" }
		expect(
			identifyTargetVerdict(
				input({
					trials: [trialOf("no-sync" as ScannerTrialOutcome)].map(t => ({
						...t,
						outcome: "wat" as ScannerTrialOutcome,
					})),
				}),
			),
		).toEqual(unknown)
		expect(identifyTargetVerdict(input({ result: undefined }))).toEqual(unknown)
		expect(
			identifyTargetVerdict(
				input({
					state: "trying" as ScannerIdentifyEventData["state"],
				}),
			),
		).toEqual(unknown)
		expect(
			identifyTargetVerdict(
				input({ trials: null as unknown as ScannerIdentifyTrial[] }),
			),
		).toEqual(unknown)
	})

	// Feature: identify verdict, Property 1: decoded needs a confirmed identity
	// Validates: closed codes; never decoded without an identity, anchor or tone
	it("only ever answers from the closed lists, and decoded only with a confirmed result", () => {
		const outcome = fc.constantFrom(...SCANNER_TRIAL_OUTCOMES)
		const state = fc.constantFrom(
			"identified" as const,
			"candidate" as const,
			"unidentified" as const,
		)
		fc.assert(
			fc.property(
				fc.array(outcome, { maxLength: 6 }),
				state,
				fc.boolean(),
				fc.constantFrom("track" as const, "spectrum" as const),
				(outcomes, st, withIdentity, source) => {
					const verdict = identifyTargetVerdict(
						input({
							state: st,
							trials: outcomes.map(o => trialOf(o)),
							result: resultOf(
								withIdentity
									? {
											protocol: "dmr",
											identity: { kind: "dmr-cc", value: "1" },
										}
									: {},
								source,
							),
						}),
					)
					expect(SCANNER_IDENTIFY_VERDICT_CODES).toContain(verdict.code)
					if (verdict.why !== undefined)
						expect(SCANNER_IDENTIFY_VERDICT_WHY).toContain(verdict.why)
					expect(verdict.why !== undefined).toBe(
						verdict.code === "could-not-test",
					)
					if (verdict.code === "decoded") {
						expect(st).toBe("identified")
						expect(withIdentity).toBe(true)
					}
				},
			),
			{ numRuns: 200 },
		)
	})
})

describe("identifyRequestJoins", () => {
	const HZ = 446_100_000
	const request = (
		over: Partial<Parameters<typeof normaliseIdentify>[0]> = {},
	) =>
		normaliseIdentify({
			target: { frequencyHz: HZ },
			protocols: ["dmr"],
			...over,
		})
	const waiting = [{ state: "waiting-for-signal", trials: [] }] as const

	it("the tolerance is max(1 kHz, bw/2): at it joins, past it does not", () => {
		expect(
			identifyRequestJoins(
				request(),
				waiting,
				request({ target: { frequencyHz: HZ + 1000 } }),
			),
		).toBe(true)
		expect(
			identifyRequestJoins(
				request(),
				waiting,
				request({ target: { frequencyHz: HZ + 1001 } }),
			),
		).toBe(false)
		const wide = request({ target: { frequencyHz: HZ, bandwidthHz: 12_500 } })
		expect(
			identifyRequestJoins(
				wide,
				waiting,
				request({ target: { frequencyHz: HZ + 6250 } }),
			),
		).toBe(true)
		expect(
			identifyRequestJoins(
				wide,
				waiting,
				request({ target: { frequencyHz: HZ + 6251 } }),
			),
		).toBe(false)
	})

	it("needs the protocols contained in the running job's", () => {
		const both = request({ protocols: ["dmr", "p25p1"] })
		expect(identifyRequestJoins(both, waiting, request())).toBe(true)
		expect(identifyRequestJoins(request(), waiting, both)).toBe(false)
		// "Every plausible" is more than the named set.
		expect(
			identifyRequestJoins(request(), waiting, request({ protocols: [] })),
		).toBe(false)
	})

	it("a job trying every plausible protocol contains one only when it planned a runnable trial", () => {
		const all = request({ protocols: [] })
		expect(identifyRequestJoins(all, waiting, all)).toBe(true)
		expect(identifyRequestJoins(all, waiting, request())).toBe(false)
		const planned = (outcome: ScannerTrialOutcome) =>
			[{ state: "trying", trials: [trialOf(outcome)] }] as const
		expect(identifyRequestJoins(all, planned("running"), request())).toBe(true)
		expect(identifyRequestJoins(all, planned("unsupported"), request())).toBe(
			false,
		)
	})

	it("a finished target, or the whole window, never joins", () => {
		expect(
			identifyRequestJoins(
				request(),
				[{ state: "unidentified", trials: [] }],
				request(),
			),
		).toBe(false)
		const all = request({ target: { all: true } })
		expect(identifyRequestJoins(all, [], all)).toBe(false)
	})

	it("does not join a job that asks for less", () => {
		const noRecord = request({ record: false })
		expect(identifyRequestJoins(noRecord, waiting, request())).toBe(false)
		expect(
			identifyRequestJoins(request(), waiting, request({ exhaustive: true })),
		).toBe(false)
		expect(
			identifyRequestJoins(request(), waiting, request({ timeoutMs: 60_000 })),
		).toBe(false)
		expect(
			identifyRequestJoins(
				request(),
				waiting,
				request({ waitUntilSignal: true }),
			),
		).toBe(false)
		const gated = request({ waitUntilSignal: true, waitMs: 5000 })
		expect(identifyRequestJoins(gated, waiting, request())).toBe(true)
		expect(
			identifyRequestJoins(
				gated,
				waiting,
				request({ waitUntilSignal: true, waitMs: 5001 }),
			),
		).toBe(false)
	})
})

describe("the 409 next step", () => {
	it("tunes half the usable half span off the target, at most 100 kHz", () => {
		const hz = 446_100_000
		// usable half span = rate × 0.8 / 2: 200 000 Hz at 500 kHz, exactly the 100 kHz cap
		expect(identifyTuneCentreHz(hz, { sampleRateHz: 500_000 })).toBe(
			hz - 100_000,
		)
		expect(identifyTuneCentreHz(hz, { sampleRateHz: 2_048_000 })).toBe(
			hz - 100_000,
		)
		// Below the cap: 225 001 Hz is about 90 000 Hz of usable half span, about 45 kHz off.
		expect(identifyTuneCentreHz(hz, { sampleRateHz: 225_001 })).toBe(
			hz - 45_000,
		)
		expect(identifyTuneCentreHz(hz, null)).toBe(hz - 100_000)
	})

	it("names the exact call in fixed text, with preempt only where a job holds the lease", () => {
		const plain = identifyNextStep("rtl", 446_000_000, false)
		expect(plain).toMatchObject({
			method: "POST",
			path: "/api/tuner/rtl/tune",
			body: { frequencyHz: 446_000_000 },
		})
		expect(plain["body"]).not.toHaveProperty("preempt")
		expect(identifyNextStep("rtl", 446_000_000, true)).toMatchObject({
			body: { frequencyHz: 446_000_000, preempt: true },
		})
		// The source id is a path segment.
		expect(identifyNextStep("a/b", 1, false)["path"]).toBe(
			"/api/tuner/a%2Fb/tune",
		)
	})
})
