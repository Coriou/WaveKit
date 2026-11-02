import { describe, expect, it } from "vitest"
import { carrierAwareAnalog } from "../../../../../src/core/scanner/classify/carrier-voice.js"
import { CARRIER_LINE_MAX_HZ } from "../../../../../src/core/scanner/classify/classifier.js"
import type { ProofAnalogInput } from "../../../../../src/core/scanner/scanner-redesign-contract.js"

const row = (over: Partial<ProofAnalogInput> = {}): ProofAnalogInput => ({
	outcome: "heard",
	mode: "nfm",
	voice: true,
	tone: { ctcssHz: null, dcs: null },
	transport: "live",
	at: 1,
	...over,
})

const carrier = { cls: "carrier" as const, obwHz: 1_000 }

describe("carrierAwareAnalog", () => {
	it("a tone-less NFM heard row on an observation that measured a carrier is carrier-only, no voice", () => {
		expect(carrierAwareAnalog(row(), carrier)).toEqual(
			row({ outcome: "carrier-only", voice: false }),
		)
	})

	it("the observation's own measurement decides: any other class, or a voice-wide line, keeps the voice", () => {
		for (const cls of ["analog-fm", "unknown", "analog-am", undefined] as const)
			expect(carrierAwareAnalog(row(), { cls, obwHz: 1_000 })).toEqual(row())
		// a carrier vote 11 kHz wide (FM voice width) is not a carrier line
		expect(
			carrierAwareAnalog(row(), { cls: "carrier", obwHz: 11_000 }),
		).toEqual(row())
		expect(carrierAwareAnalog(row(), undefined)).toEqual(row())
		expect(
			carrierAwareAnalog(row(), { cls: "carrier", obwHz: Number.NaN }),
		).toEqual(row())
	})

	it("width bound: just under 4 kHz is a carrier line, at 4 kHz it is not", () => {
		expect(CARRIER_LINE_MAX_HZ).toBe(4_000)
		expect(
			carrierAwareAnalog(row(), {
				cls: "carrier",
				obwHz: CARRIER_LINE_MAX_HZ - 1,
			}).outcome,
		).toBe("carrier-only")
		expect(
			carrierAwareAnalog(row(), { cls: "carrier", obwHz: CARRIER_LINE_MAX_HZ })
				.outcome,
		).toBe("heard")
	})

	it("leaves tone, AM and non-heard rows alone", () => {
		const kept = [
			row({ mode: "am" }),
			row({ outcome: "decoded", tone: { ctcssHz: 88.5, dcs: null } }),
			row({
				outcome: "decoded",
				tone: { ctcssHz: null, dcs: { code: "023", polarity: "normal" } },
			}),
			row({ outcome: "data-like", voice: false }),
			row({ outcome: "carrier-only", voice: false }),
		]
		for (const r of kept) expect(carrierAwareAnalog(r, carrier)).toBe(r)
	})
})
