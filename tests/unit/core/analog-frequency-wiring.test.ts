/**
 * WG9 req 3.2 (Main wiring): the analog transmission frequency label in src/index.ts uses the
 * controller's per-connection write record, so a state the strict rule would call
 * `commanded`/`relay` is `unverified` when nothing was written on the current connection.
 */

import { describe, expect, it } from "vitest"
import type { TunerState } from "@wavekit/api-types"
import { analogFrequencyAt } from "../../../src/index.js"

function state(controlMode: "internal" | "external"): TunerState {
	return {
		frequency: 446_000_000,
		controlMode,
		unknownFields: [],
		declaredOnlyFields: [],
	} as unknown as TunerState
}

function tuner(
	controlMode: "internal" | "external",
	written: boolean,
): Parameters<typeof analogFrequencyAt>[0] {
	return {
		getState: () => state(controlMode),
		tuningWrittenOnConnection: () => written,
	} as unknown as Parameters<typeof analogFrequencyAt>[0]
}

describe("analog transmission frequency label wiring (WG9 3.2)", () => {
	it.each([
		["internal", true, "commanded"],
		["external", true, "relay"],
		["internal", false, "unverified"],
		["external", false, "unverified"],
	] as const)("%s, written %s: %s", (mode, written, trust) => {
		const at = analogFrequencyAt(tuner(mode, written))
		expect(at("rtl", 12_500)).toEqual({ hz: 446_012_500, tuningTrust: trust })
	})

	it("asks the controller for the transmission's own source", () => {
		const asked: string[] = []
		const at = analogFrequencyAt({
			getState: () => state("internal"),
			tuningWrittenOnConnection: (id: string) => {
				asked.push(id)
				return true
			},
		} as unknown as Parameters<typeof analogFrequencyAt>[0])
		at("rtl-pi", 0)
		expect(asked).toEqual(["rtl-pi"])
	})
})
