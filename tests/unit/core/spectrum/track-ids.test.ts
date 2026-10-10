import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { trackIdPrefixes } from "../../../../src/core/spectrum/pipeline.js"

/** The tracker's id rule (emissions/tracker.ts): prefix + base-36 sequence from 1. */
const idOf = (prefix: string, seq: number): string =>
	`${prefix}${seq.toString(36)}`

describe("pipeline track ids", () => {
	it("keeps main track 1153 apart from the first wideband track (base 36 contains w)", () => {
		const p = trackIdPrefixes("rtl-1", 1_791_547_200_000)
		expect(idOf(p.main, 1153)).not.toBe(idOf(p.wideband, 1))
	})

	it("never gives a main and a wideband track the same id", () => {
		fc.assert(
			fc.property(
				fc.string({ maxLength: 8 }),
				fc.nat(),
				fc.integer({ min: 1, max: 2 ** 30 }),
				fc.integer({ min: 1, max: 2 ** 30 }),
				(sourceId, atMs, mainSeq, widebandSeq) => {
					const p = trackIdPrefixes(sourceId, atMs)
					const wide = idOf(p.wideband, widebandSeq)
					// the main sequence number whose base-36 digits spell "w" + the wideband digits
					const lookalike = parseInt(`w${widebandSeq.toString(36)}`, 36)
					expect(idOf(p.main, lookalike)).not.toBe(wide)
					expect(idOf(p.main, mainSeq)).not.toBe(wide)
				},
			),
			{ numRuns: 100 },
		)
	})
})
