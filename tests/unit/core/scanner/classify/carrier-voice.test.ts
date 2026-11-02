import { describe, expect, it } from "vitest"
import { carrierAwareAnalog } from "../../../../../src/core/scanner/classify/carrier-voice.js"
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

describe("carrierAwareAnalog", () => {
	it("a tone-less NFM heard row on a carrier record is carrier-only, no voice", () => {
		expect(carrierAwareAnalog(row(), "carrier")).toEqual(
			row({ outcome: "carrier-only", voice: false }),
		)
	})

	it("leaves every other row and record class alone", () => {
		for (const cls of ["analog-fm", "unknown", "analog-am", undefined] as const)
			expect(carrierAwareAnalog(row(), cls)).toEqual(row())
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
		for (const r of kept) expect(carrierAwareAnalog(r, "carrier")).toBe(r)
	})
})
