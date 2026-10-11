import { describe, expect, it } from "vitest"
import { trackIdPrefixes } from "../../../../src/core/spectrum/pipeline.js"

/** The tracker's id rule (emissions/tracker.ts): prefix + base-36 sequence. */
const idOf = (prefix: string, seq: number): string =>
	`${prefix}${seq.toString(36)}`

const COUNTERS = 5_000

describe("pipeline track ids", () => {
	it("keeps main track 1153 apart from the first wideband track (base 36 contains w)", () => {
		const p = trackIdPrefixes("rtl-1", 1_791_547_200_000)
		expect(idOf(p.main, 1153)).not.toBe(idOf(p.wideband, 1))
	})

	it("never gives a main and a wideband track the same id, for counters 0..5000", () => {
		for (const [sourceId, atMs] of [
			["rtl-1", 1_791_547_200_000],
			["", 0],
		] as const) {
			const p = trackIdPrefixes(sourceId, atMs)
			const main = new Set<string>()
			for (let seq = 0; seq <= COUNTERS; seq++) main.add(idOf(p.main, seq))
			const shared: string[] = []
			for (let seq = 0; seq <= COUNTERS; seq++) {
				const id = idOf(p.wideband, seq)
				if (main.has(id)) shared.push(id)
			}
			expect(shared).toEqual([])
		}
	})
})
