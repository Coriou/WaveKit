import { describe, expect, it } from "vitest"
import {
	confirmedRealRange,
	REAL_RANGE_QUANTUM_HZ,
} from "../../../../src/core/scanner/real-ranges.js"
import type { RealEvidence } from "../../../../src/core/scanner/real-ranges.js"
import { MAX_REAL_RANGES } from "../../../../src/core/spectrum/spur-map.js"
import { PipelineInputSchema } from "../../../../src/core/spectrum/worker-protocol.js"

const WEAK: RealEvidence = {
	confidence: "weak",
	evidence: { recordings: 0 },
	frequencyHz: 145_500_000,
	measuredOffsetHz: 300,
	bandwidthHz: 11_000,
}

function masks(n: number): unknown {
	return {
		kind: "masks",
		exclusions: [],
		cfarRanges: [],
		burstRanges: [],
		rasters: [],
		obwHz: [],
		inWindow: true,
		realRanges: Array.from({ length: n }, (_, i) => ({
			startHz: 1e8 + i * 12_500,
			endHz: 1e8 + i * 12_500 + 11_000,
		})),
	}
}

describe("confirmed real ranges for spur masks", () => {
	it("counts a decode, an identity, a kept voice recording or a proof, never a weak record or a decode anchor", () => {
		expect(confirmedRealRange(WEAK)).toBeNull()
		for (const d of [
			{ ...WEAK, confidence: "decoded" },
			{ ...WEAK, identity: { kind: "callsign", value: "X" } },
			{ ...WEAK, evidence: { recordings: 1 } },
			{ ...WEAK, proof: {} },
		])
			expect(confirmedRealRange(d)).not.toBeNull()
		expect(
			confirmedRealRange({ ...WEAK, confidence: "decoded", anchor: "decode" }),
		).toBeNull()
	})

	it("is the measured centre ± half the OBW, widened outward to whole kHz", () => {
		const r = confirmedRealRange({ ...WEAK, evidence: { recordings: 2 } })
		// centre 145 500 300 Hz ± 5 500 Hz = 145 494 800 to 145 505 800 Hz
		expect(r).toEqual({ startHz: 145_494_000, endHz: 145_506_000 })
		expect(REAL_RANGE_QUANTUM_HZ).toBe(1000)
		const narrow = confirmedRealRange({
			...WEAK,
			bandwidthHz: 0,
			measuredOffsetHz: 0,
			evidence: { recordings: 1 },
		})
		expect(narrow).toEqual({ startHz: 145_500_000, endHz: 145_501_000 })
	})

	it("bounds the masks message at MAX_REAL_RANGES ranges", () => {
		expect(MAX_REAL_RANGES).toBe(4096)
		expect(PipelineInputSchema.safeParse(masks(MAX_REAL_RANGES)).success).toBe(
			true,
		)
		expect(
			PipelineInputSchema.safeParse(masks(MAX_REAL_RANGES + 1)).success,
		).toBe(false)
		const { realRanges: _r, ...old } = masks(0) as Record<string, unknown>
		expect(PipelineInputSchema.safeParse(old).success).toBe(true) // older senders
	})
})
