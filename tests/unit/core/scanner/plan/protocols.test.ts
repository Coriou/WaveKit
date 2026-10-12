import { describe, expect, it } from "vitest"
import {
	protocolsForFrequency,
	protocolsForHop,
} from "../../../../../src/core/scanner/plan/protocols.js"
import type { NormalisedJobSpec } from "../../../../../src/core/scanner/types.js"

type ProtocolSpec = Pick<
	NormalisedJobSpec,
	"ranges" | "protocols" | "provenance"
>
const spec: ProtocolSpec = {
	ranges: [
		{ startHz: 156_000_000, endHz: 157_000_000, protocols: ["analog-fm"] },
		{
			startHz: 156_900_000,
			endHz: 158_000_000,
			protocols: ["dmr", "analog-fm"],
		},
	],
	protocols: ["analog-fm", "dmr"],
	provenance: { protocols: "bandplan" },
}

describe("protocols for a scan location", () => {
	it("keeps Marine VHF frequencies free of neighbouring DMR protocols", () => {
		expect(protocolsForFrequency(spec, 156_500_000)).toEqual(["analog-fm"])
		expect(protocolsForFrequency(spec, 157_500_000)).toEqual([
			"dmr",
			"analog-fm",
		])
	})

	it("unions overlapping ranges, including their boundaries, without duplicates", () => {
		expect(protocolsForFrequency(spec, 157_000_000)).toEqual([
			"analog-fm",
			"dmr",
		])
		expect(protocolsForFrequency(spec, 159_000_000)).toEqual([])
	})

	it("uses only the ranges intersecting a preview hop", () => {
		expect(
			protocolsForHop(spec, {
				covered: { startHz: 155_900_000, endHz: 156_800_000 },
			}),
		).toEqual(["analog-fm"])
		expect(
			protocolsForHop(spec, {
				covered: { startHz: 156_800_000, endHz: 157_100_000 },
			}),
		).toEqual(["analog-fm", "dmr"])
	})

	it.each([{ protocols: ["p25p1" as const] }, { protocols: [] }])(
		"honours explicit override %j everywhere",
		({ protocols }) => {
			const overridden: ProtocolSpec = {
				...spec,
				protocols,
				provenance: { protocols: "operator" },
			}
			expect(protocolsForFrequency(overridden, 156_500_000)).toEqual(protocols)
			expect(
				protocolsForHop(overridden, {
					covered: { startHz: 156_000_000, endHz: 158_000_000 },
				}),
			).toEqual(protocols)
		},
	)
})
