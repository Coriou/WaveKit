import { describe, expect, it } from "vitest"
import fc from "fast-check"
import {
	bandwidthAccepted,
	isCu8Format,
	selectEngine,
	type EngineFallbackReason,
	type EngineSelectionInput,
} from "../../../../src/core/live-demod/select-engine.js"

const REASONS: EngineFallbackReason[] = [
	"binary-unavailable",
	"protocol-unsupported",
	"input-format-unsupported",
	"modulation-unsupported",
	"open-rejected",
	"process-unstable",
]

function expected(input: EngineSelectionInput): {
	engine: "csdr" | "rust"
	fallback?: EngineFallbackReason
} {
	if (input.config.engine !== "rust") return { engine: "csdr" }
	const probe = input.probe
	if (probe.processUnstable)
		return { engine: "csdr", fallback: "process-unstable" }
	if (!probe.available)
		return { engine: "csdr", fallback: "binary-unavailable" }
	if (probe.protocol === null || probe.protocol < 2)
		return { engine: "csdr", fallback: "protocol-unsupported" }
	if (!isCu8Format(input.caps?.format))
		return { engine: "csdr", fallback: "input-format-unsupported" }
	if (input.config.modulation !== "nfm" && input.config.modulation !== "am")
		return { engine: "csdr", fallback: "modulation-unsupported" }
	if (probe.openRejected || !bandwidthAccepted(input.config.bandwidth))
		return { engine: "csdr", fallback: "open-rejected" }
	return { engine: "rust" }
}

describe("selectEngine", () => {
	const ready = { available: true, protocol: 2 }

	it("keeps csdr when rust was not requested", () => {
		expect(
			selectEngine({
				config: { engine: "csdr", modulation: "wfm", bandwidth: 100 },
				caps: null,
				probe: { available: false, protocol: null, processUnstable: true },
			}),
		).toEqual({ engine: "csdr" })
		expect(
			selectEngine({
				config: { modulation: "nfm", bandwidth: 12500 },
				caps: { format: "U8_IQ" },
				probe: ready,
			}),
		).toEqual({ engine: "csdr" })
	})

	it.each([
		{
			reason: "process-unstable" as const,
			probe: { available: false, protocol: null, processUnstable: true },
			format: "U8_IQ",
			modulation: "nfm",
			bandwidth: 12500,
		},
		{
			reason: "binary-unavailable" as const,
			probe: { available: false, protocol: 2 },
			format: "U8_IQ",
			modulation: "nfm",
			bandwidth: 12500,
		},
		{
			reason: "protocol-unsupported" as const,
			probe: { available: true, protocol: 1 },
			format: "U8_IQ",
			modulation: "nfm",
			bandwidth: 12500,
		},
		{
			reason: "protocol-unsupported" as const,
			probe: { available: true, protocol: null },
			format: "cu8",
			modulation: "am",
			bandwidth: 10000,
		},
		{
			reason: "input-format-unsupported" as const,
			probe: ready,
			format: "S16_IQ",
			modulation: "nfm",
			bandwidth: 12500,
		},
		{
			reason: "modulation-unsupported" as const,
			probe: ready,
			format: "U8_IQ",
			modulation: "wfm",
			bandwidth: 12500,
		},
		{
			reason: "open-rejected" as const,
			probe: { ...ready, openRejected: true },
			format: "U8_IQ",
			modulation: "nfm",
			bandwidth: 12500,
		},
		{
			reason: "open-rejected" as const,
			probe: ready,
			format: "U8_IQ",
			modulation: "am",
			bandwidth: 2499,
		},
		{
			reason: "open-rejected" as const,
			probe: ready,
			format: "U8_IQ",
			modulation: "nfm",
			bandwidth: 40001,
		},
	])("falls back ($reason) for $modulation $format $bandwidth", row => {
		expect(REASONS).toContain(row.reason)
		expect(
			selectEngine({
				config: {
					engine: "rust",
					modulation: row.modulation,
					bandwidth: row.bandwidth,
				},
				caps: { format: row.format },
				probe: row.probe,
			}),
		).toEqual({ engine: "csdr", fallback: row.reason })
	})

	it("accepts nfm and am cu8 inside the bandwidth bounds", () => {
		for (const bandwidth of [2500, 12500, 40000]) {
			for (const modulation of ["nfm", "am"]) {
				expect(
					selectEngine({
						config: { engine: "rust", modulation, bandwidth },
						caps: { format: "U8_IQ" },
						probe: ready,
					}),
				).toEqual({ engine: "rust" })
			}
		}
		expect(
			selectEngine({
				config: { engine: "rust", modulation: "nfm", bandwidth: 12500 },
				caps: { format: "cu8" },
				probe: ready,
			}),
		).toEqual({ engine: "rust" })
	})

	it("property: rust is chosen only when every blocker is clear", () => {
		const input = fc.record({
			config: fc.record({
				engine: fc.constantFrom("csdr" as const, "rust" as const, undefined),
				modulation: fc.constantFrom("nfm", "am", "wfm", "usb", "raw", "cw"),
				bandwidth: fc.double({ min: -100_000, max: 100_000, noNaN: true }),
			}),
			caps: fc.option(
				fc.record({
					format: fc.constantFrom(
						"U8_IQ",
						"cu8",
						"S16_IQ",
						"S16LE",
						"FLOAT32LE",
						"auto",
					),
				}),
				{ nil: null },
			),
			probe: fc.record({
				available: fc.boolean(),
				protocol: fc.option(fc.integer({ min: 0, max: 4 }), { nil: null }),
				openRejected: fc.option(fc.boolean(), { nil: undefined }),
				processUnstable: fc.option(fc.boolean(), { nil: undefined }),
			}),
		})
		// Feature: rust-demod-a, Property 7: engine selection
		// Validates: Requirements 1.3
		fc.assert(
			fc.property(input, value => {
				const selected = selectEngine(value)
				const want = expected(value)
				expect(selected).toEqual(want)
				const blocked =
					value.config.engine === "rust" &&
					(value.probe.processUnstable === true ||
						!value.probe.available ||
						value.probe.protocol === null ||
						value.probe.protocol < 2 ||
						!isCu8Format(value.caps?.format) ||
						(value.config.modulation !== "nfm" &&
							value.config.modulation !== "am") ||
						value.probe.openRejected === true ||
						!bandwidthAccepted(value.config.bandwidth))
				if (blocked) expect(selected.engine).not.toBe("rust")
				if (value.config.engine !== "rust")
					expect(selected.fallback).toBeUndefined()
			}),
			{ numRuns: 200 },
		)
	})
})
