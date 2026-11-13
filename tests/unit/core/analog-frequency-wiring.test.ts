/**
 * The analog transmission frequency label in src/index.ts is the tuning ledger's at the live edge
 * (`trustNow`): `commanded`/`relay` only for the tuner's own centre, `unverified` without a ledger,
 * on another proven centre, on an unproven session or when the lookup throws.
 */

import { describe, expect, it } from "vitest"
import type { TunerState } from "@wavekit/api-types"
import { analogFrequencyAt } from "../../../src/index.js"
import { FakeReceiverLedger } from "../../mocks/fake-receiver-ledger.js"
import type { TuningLedger } from "../../../src/core/tuning-ledger.js"

const CENTRE = 446_000_000

const tuner = {
	getState: () =>
		({ frequency: CENTRE, controlMode: "internal" }) as unknown as TunerState,
}

function proven(writer: "operator" | "relay"): FakeReceiverLedger {
	const l = new FakeReceiverLedger("rtl", { rateHz: 1_024_000, settleMs: 50 })
	l.prove(CENTRE, 1_024_000, writer)
	return l
}

describe("analog transmission frequency label wiring (tuning ledger)", () => {
	it.each([
		["operator", "commanded"],
		["relay", "relay"],
	] as const)("frames by %s: %s", (writer, trust) => {
		const at = analogFrequencyAt(tuner, proven(writer).ledger)
		expect(at("rtl", 12_500)).toEqual({
			hz: CENTRE + 12_500,
			tuningTrust: trust,
		})
	})

	it("is unverified without a ledger, settling, on another centre, a new session or a throw", () => {
		expect(analogFrequencyAt(tuner, null)("rtl", 0)?.tuningTrust).toBe(
			"unverified",
		)
		const settling = new FakeReceiverLedger("rtl", {
			rateHz: 1_024_000,
			settleMs: 50,
		})
		settling.start()
		settling.write("set-sample-rate", 1_024_000, "operator")
		settling.write("set-frequency", CENTRE, "operator")
		expect(
			analogFrequencyAt(tuner, settling.ledger)("rtl", 0)?.tuningTrust,
		).toBe("unverified")
		const other = proven("operator")
		other.write("set-frequency", CENTRE + 1_000_000, "operator")
		other.advance(other.settleBytes() + 2)
		expect(analogFrequencyAt(tuner, other.ledger)("rtl", 0)?.tuningTrust).toBe(
			"unverified",
		)
		const flapped = proven("operator")
		flapped.reconnect()
		flapped.start()
		expect(
			analogFrequencyAt(tuner, flapped.ledger)("rtl", 0)?.tuningTrust,
		).toBe("unverified")
		const throwing = {
			trustNow: () => {
				throw new Error("ledger gone")
			},
		} as unknown as TuningLedger
		expect(analogFrequencyAt(tuner, throwing)("rtl", 0)?.tuningTrust).toBe(
			"unverified",
		)
	})

	it("asks the ledger for the transmission's own source", () => {
		const asked: string[] = []
		const ledger = {
			trustNow: (id: string) => {
				asked.push(id)
				return { trust: "commanded", frequency: CENTRE }
			},
		} as unknown as TuningLedger
		analogFrequencyAt(tuner, ledger)("rtl-pi", 0)
		expect(asked).toEqual(["rtl-pi"])
	})
})
