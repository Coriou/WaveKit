import { describe, expect, it } from "vitest"
import { SCANNER_PROBE_DECODER_TYPES } from "@wavekit/api-types"
import { SCAN_JOB } from "../test/fixtures.js"
import { guardScan } from "./scanner-guards.js"
import { proofSummary } from "./scanner-proof.js"

describe("identify unavailable decoder proof", () => {
	it.each(SCANNER_PROBE_DECODER_TYPES)("retains proof naming %s", decoder => {
		const proof = {
			kind: "digital-undecoded" as const,
			protocol: "digital-unknown" as const,
			transport: "replay" as const,
			at: "2026-10-11T12:00:00Z",
			observationId: "o1",
			tried: ["vdl2" as const],
			unavailable: [decoder],
			encrypted: false,
		}
		const target = SCAN_JOB.identify.targets[0]!
		const parsed = guardScan("job", {
			...SCAN_JOB,
			identify: {
				targets: [
					{
						...target,
						result: {
							...target.result,
							proof: { ...proof, summary: proofSummary(proof) },
						},
					},
				],
			},
		})
		expect(parsed).toBeDefined()
		expect(parsed?.identify?.targets[0]?.result?.proof?.unavailable).toEqual([
			decoder,
		])
	})
})
