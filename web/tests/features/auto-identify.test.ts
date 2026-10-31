import { describe, expect, it } from "vitest"
import fc from "fast-check"
import {
	shouldAutoIdentify,
	type AutoIdentifyInput,
} from "../../src/features/tuned/auto-identify.ts"

const HZ = 431_926_000

const base: AutoIdentifyInput = {
	enabled: true,
	readOnly: false,
	onIt: true,
	heldByScan: false,
	transmitting: true,
	decodersHere: 0,
	identifyShown: false,
	known: false,
	triedHz: null,
	hz: HZ,
}

describe("shouldAutoIdentify", () => {
	it("identifies a transmission on a frequency nothing decodes", () => {
		expect(shouldAutoIdentify(base)).toBe(true)
	})

	it("waits for a transmission, and never asks twice on one visit", () => {
		expect(shouldAutoIdentify({ ...base, transmitting: false })).toBe(false)
		expect(shouldAutoIdentify({ ...base, triedHz: HZ })).toBe(false)
		expect(shouldAutoIdentify({ ...base, triedHz: HZ + 12_500 })).toBe(true)
	})

	it("leaves alone what is known, decoded, shown, held or not its to start", () => {
		for (const over of [
			{ enabled: false },
			{ readOnly: true },
			{ onIt: false },
			{ heldByScan: true },
			{ decodersHere: 1 },
			{ identifyShown: true },
			{ known: true },
		])
			expect(shouldAutoIdentify({ ...base, ...over })).toBe(false)
	})

	it("starts only when every condition holds", () => {
		fc.assert(
			fc.property(
				fc.record({
					enabled: fc.boolean(),
					readOnly: fc.boolean(),
					onIt: fc.boolean(),
					heldByScan: fc.boolean(),
					transmitting: fc.boolean(),
					decodersHere: fc.nat(3),
					identifyShown: fc.boolean(),
					known: fc.boolean(),
					triedHz: fc.option(fc.constant(HZ)),
					hz: fc.constant(HZ),
				}),
				i => {
					const all =
						i.enabled &&
						!i.readOnly &&
						i.onIt &&
						!i.heldByScan &&
						i.transmitting &&
						i.decodersHere === 0 &&
						!i.identifyShown &&
						!i.known &&
						i.triedHz === null
					expect(shouldAutoIdentify(i)).toBe(all)
				},
			),
			{ numRuns: 200 },
		)
	})
})
