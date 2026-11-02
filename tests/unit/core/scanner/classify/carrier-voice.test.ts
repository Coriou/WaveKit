import { describe, expect, it } from "vitest"
import { carrierAwareAnalog } from "../../../../../src/core/scanner/classify/carrier-voice.js"
import { CARRIER_LINE_MAX_BINS } from "../../../../../src/core/scanner/classify/classifier.js"
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

	it("repro: width bound in bins of the observation's FFT, inclusive: a half-bin tone (4 bins) is a carrier at 1.024 and 2.4 Msps", () => {
		expect(CARRIER_LINE_MAX_BINS).toBe(4)
		for (const binHz of [1_024_000 / 1_024, 2_400_000 / 2_048]) {
			const at = (obwHz: number) =>
				carrierAwareAnalog(row(), { cls: "carrier", obwHz, binHz }).outcome
			expect({ binHz, outcome: at(3 * binHz) }).toEqual({
				binHz,
				outcome: "carrier-only",
			})
			expect({ binHz, outcome: at(4 * binHz) }).toEqual({
				binHz,
				outcome: "carrier-only",
			})
			expect({ binHz, outcome: at(4 * binHz + 1) }).toEqual({
				binHz,
				outcome: "heard",
			})
		}
		// without its bin width an observation reads the default 1 kHz bin (4 000 Hz inclusive)
		expect(
			carrierAwareAnalog(row(), { cls: "carrier", obwHz: 4_000 }).outcome,
		).toBe("carrier-only")
		expect(
			carrierAwareAnalog(row(), { cls: "carrier", obwHz: 4_001 }).outcome,
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
