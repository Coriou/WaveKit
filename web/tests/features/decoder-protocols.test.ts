import { describe, expect, it } from "vitest"
import type { ScanRange } from "@wavekit/api-types"

import { DECODER_PROTOCOLS as CORE_DECODER_PROTOCOLS } from "../../../src/decoders/enablement/contract.ts"
import {
	DECODER_PROTOCOLS,
	planListsHz,
} from "../../src/features/tuned/decoder-protocols.ts"

describe("decoder band plan protocols", () => {
	it("are the core's DECODER_PROTOCOLS", () => {
		expect(DECODER_PROTOCOLS).toEqual(CORE_DECODER_PROTOCOLS)
	})

	it("cover a frequency only inside a range listing one of the type's protocols", () => {
		const ranges: Pick<ScanRange, "startHz" | "endHz" | "protocols">[] = [
			{ startHz: 148_000_000, endHz: 152_000_000, protocols: ["pocsag"] },
			{ startHz: 160_000_000, endHz: 162_000_000, protocols: ["dmr"] },
			{ startHz: 170_000_000, endHz: 171_000_000 },
		]
		expect(planListsHz("multimon-ng", ranges, 150_000_000)).toBe(true)
		expect(planListsHz("multimon-ng", ranges, 161_000_000)).toBe(false)
		expect(planListsHz("dsd-fme", ranges, 161_000_000)).toBe(true)
		expect(planListsHz("multimon-ng", ranges, 170_500_000)).toBe(false)
		expect(planListsHz("readsb", ranges, 150_000_000)).toBe(false)
		expect(planListsHz("toString", ranges, 150_000_000)).toBe(false)
		for (const hz of [0, -1, Number.NaN, Infinity])
			expect(planListsHz("multimon-ng", ranges, hz)).toBe(false)
	})
})
