/** WG12 Property 13: a live confirm hold starts only in the cases of requirement 4.2. */
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import {
	needsLiveConfirm,
	type LiveConfirmInput,
} from "../../../../src/core/iq-capture/replay-first.js"
import type { ChannelGateState } from "../../../../src/core/scanner/scanner-redesign-contract.js"

/**
 * Requirement 4.2, written as the three cases rather than the implementation's
 * ladder. An absent gate is not `passed`.
 */
function specLiveConfirm(input: LiveConfirmInput): boolean {
	const gated = input.gate === "passed"
	const noCapture = gated && !input.captureRunning
	const replaySettled =
		gated && input.captureRunning && !input.capturePending && input.replayEnded
	const onAirUndecoded =
		replaySettled && !input.replayDecoded && input.trackOpen
	const identityFollowUp =
		replaySettled && input.discoveryDecoded && input.emitterOnAir
	return noCapture || onAirUndecoded || identityFollowUp
}

const flags = {
	captureRunning: fc.boolean(),
	capturePending: fc.boolean(),
	replayEnded: fc.boolean(),
	replayDecoded: fc.boolean(),
	trackOpen: fc.boolean(),
	discoveryDecoded: fc.boolean(),
	emitterOnAir: fc.boolean(),
}

function input(
	gate: LiveConfirmInput["gate"],
	rest: Omit<LiveConfirmInput, "gate">,
): LiveConfirmInput {
	return { gate, ...rest }
}

describe("needsLiveConfirm", () => {
	it("an undefined gate is the safe answer, false", () => {
		expect(
			needsLiveConfirm(
				input(undefined, {
					captureRunning: false,
					capturePending: false,
					replayEnded: true,
					replayDecoded: false,
					trackOpen: true,
					discoveryDecoded: true,
					emitterOnAir: true,
				}),
			),
		).toBe(false)
	})

	it("case (a) no capture confirms a passed gate and nothing else does", () => {
		const passed = input("passed", {
			captureRunning: false,
			capturePending: true,
			replayEnded: false,
			replayDecoded: false,
			trackOpen: false,
			discoveryDecoded: false,
			emitterOnAir: false,
		})
		expect(needsLiveConfirm(passed)).toBe(true)
		expect(needsLiveConfirm({ ...passed, gate: "below" })).toBe(false)
		expect(needsLiveConfirm({ ...passed, gate: "pending" })).toBe(false)
	})

	it("case (b) is on air after replay ended without a decode", () => {
		expect(
			needsLiveConfirm(
				input("passed", {
					captureRunning: true,
					capturePending: false,
					replayEnded: true,
					replayDecoded: false,
					trackOpen: true,
					discoveryDecoded: false,
					emitterOnAir: false,
				}),
			),
		).toBe(true)
	})

	it("case (c) is identity follow-up after replay, and not while replay is open", () => {
		const followUp = input("passed", {
			captureRunning: true,
			capturePending: false,
			replayEnded: true,
			replayDecoded: true,
			trackOpen: false,
			discoveryDecoded: true,
			emitterOnAir: true,
		})
		expect(needsLiveConfirm(followUp)).toBe(true)
		expect(needsLiveConfirm({ ...followUp, replayEnded: false })).toBe(false)
		expect(needsLiveConfirm({ ...followUp, capturePending: true })).toBe(false)
		expect(needsLiveConfirm({ ...followUp, emitterOnAir: false })).toBe(false)
	})

	it("a settled replay with no decode and a closed track is not a confirm", () => {
		expect(
			needsLiveConfirm(
				input("passed", {
					captureRunning: true,
					capturePending: false,
					replayEnded: true,
					replayDecoded: false,
					trackOpen: false,
					discoveryDecoded: false,
					emitterOnAir: false,
				}),
			),
		).toBe(false)
	})

	// Feature: scanner-redesign, Property 13: Replay before live in scans
	// Validates: Requirements 4.2, 4.3
	// random gated tracks, capture availability and replay timings → needsLiveConfirm true only in
	// cases (a) no capture, (b) on air after replay ended undecoded, (c) identity follow-up. numRuns: 100
	it("holds only for no capture, on air after an undecoded replay, or identity follow-up", () => {
		fc.assert(
			fc.property(
				fc.constantFrom<ChannelGateState | "absent">(
					"pending",
					"passed",
					"below",
					"absent",
				),
				fc.record(flags),
				(gate, rest) => {
					const sample = input(gate === "absent" ? undefined : gate, rest)
					expect(needsLiveConfirm(sample)).toBe(specLiveConfirm(sample))
				},
			),
			{ numRuns: 100 },
		)
	})
})
