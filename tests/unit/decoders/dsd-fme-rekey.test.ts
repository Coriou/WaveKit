/**
 * dsd-fme DMR re-key without a terminator. Replaces the superframe-grid
 * suite (dsd-fme-rekey-grid.test.ts): recorded dsd-fme lines arrive in
 * clumps (DSD_FME_LINE_CLUMP_MS), so a sync's arrival off a 360 ms grid is
 * no sign of a re-key. A re-key is a header burst (a voice LC header, a PI
 * header, a direct-mode data burst whose slot type failed) at least
 * REKEY_GAP_MS after the call's last voice sync, another radio's IDs, or the
 * call timeout; a re-key with none of these stays one call (a missed split,
 * never a split over).
 */
import fc from "fast-check"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
	DMR_SUPERFRAME_MS,
	REKEY_GAP_MS,
} from "../../../src/decoders/builtin/dsd-fme.js"
import {
	at,
	LC,
	MS,
	replay,
	T0,
	type Line,
} from "./dsd-fme-call-first-helpers.js"

/** A direct over: one voice sync per superframe from 1000 ms. */
function over(
	superframes: number,
	offsets: Record<number, number> = {},
): Line[] {
	const lines: Line[] = []
	for (let i = 0; i < superframes; i++)
		lines.push([1000 + i * DMR_SUPERFRAME_MS + (offsets[i] ?? 0), MS("VC*")])
	return lines
}

const HEADER =
	"03:04:05 Sync: +DMR MS/DM MODE/MONO | Color Code=13 | CACH/Burst FEC ERR"

describe("dsd-fme DMR re-key", () => {
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["Date"] })
		vi.setSystemTime(T0)
	})
	afterEach(() => {
		vi.useRealTimers()
	})

	it("states its bound", () => {
		expect(REKEY_GAP_MS).toBe(200)
	})

	it.each([35, 40, -40, 150, -170])(
		"an LC-less 14-superframe over with one sync %i ms off the grid stays one call",
		offset => {
			const { starts, ends } = replay(over(14, { 6: offset }), 10_000)
			expect(starts).toHaveLength(1)
			expect(ends).toHaveLength(1)
			expect(at(ends[0]!.startedAt)).toBe(1000)
		},
	)

	it("the same with IDs whose embedded LC print went missing around the late sync", () => {
		const lines = over(14, { 6: 40 })
		for (let i = 0; i < 14; i++)
			if (i !== 5 && i !== 6)
				lines.push([1000 + i * DMR_SUPERFRAME_MS + 40, LC(1)])
		const { ends } = replay(lines, 10_000)
		expect(ends).toHaveLength(1)
		expect(ends[0]).toMatchObject({ talkgroup: 9, source: 100 })
	})

	it("a sync after a long gap is the same over without a header, the next over with one", () => {
		// Adapted (was: off the grid 560 ms after the last sync re-keyed at once).
		// The last sync at 1720; the next 560 ms later, then three more (an
		// unnamed over announced on three syncs of one code over 630 ms).
		const next = (first: string): Line[] => [
			...over(3),
			[2280, first],
			[2280 + 340, MS("VC*")],
			[2280 + 680, MS("VC*")],
			[2280 + 1020, MS("VC*")],
		]
		const merged = replay(next(MS("VC*")), 12_000)
		expect(merged.ends).toHaveLength(1)
		const split = replay(next(HEADER), 12_000)
		expect(split.ends).toHaveLength(2)
		expect(at(split.ends[0]!.endedAt!)).toBe(1720)
		expect(split.ends[0]!.flags?.timeout).toBe(true)
		expect(at(split.ends[1]!.startedAt)).toBe(2280)
	})

	it("a header within REKEY_GAP_MS of the last voice sync, or with no call, splits nothing", () => {
		const near = replay(
			[
				...over(3),
				[1720 + REKEY_GAP_MS - 1, HEADER],
				...over(3).map(([t, text]): Line => [t + 1080, text]),
			],
			12_000,
		)
		expect(near.ends).toHaveLength(1)
		// A header alone, or a header and one sync, is no call.
		expect(replay([[1000, HEADER]], 6000).starts).toHaveLength(0)
		expect(
			replay(
				[
					[1000, HEADER],
					[1340, MS("VC*")],
				],
				6000,
			).starts,
		).toHaveLength(0)
	})

	it("another radio's IDs still split on a continuous run of syncs", () => {
		const lines: Line[] = [
			...over(8),
			[1000 + DMR_SUPERFRAME_MS + 40, LC(1, 9, 100)],
			[1000 + 3 * DMR_SUPERFRAME_MS + 40, LC(1, 9, 100)],
			[1000 + 6 * DMR_SUPERFRAME_MS + 40, LC(1, 7, 200)],
		]
		const { ends } = replay(lines, 12_000)
		expect(ends).toHaveLength(2)
		expect(ends.map(e => e.talkgroup)).toEqual([9, 7])
		// The old call ends at its last own LC, the new one starts at the first sync after it.
		expect(at(ends[0]!.endedAt!)).toBe(1000 + 3 * DMR_SUPERFRAME_MS + 40)
		expect(at(ends[1]!.startedAt)).toBe(1000 + 4 * DMR_SUPERFRAME_MS)
	})

	it("property: arrival jitter up to a whole clump on each sync never splits a continuous over", () => {
		// Feature: dv-call-first, Property: DMR jitter never splits a continuous over
		// Validates: a late sync after a missing LC print stays in its over; no superframe grid on clumped arrival times
		fc.assert(
			fc.property(
				// Four superframes or more: three of their syncs span at least
				// 3 x 360 - 340 = 740 ms, past the 630 ms evidence span.
				fc.integer({ min: 4, max: 16 }),
				fc.array(fc.integer({ min: -170, max: 170 }), {
					minLength: 16,
					maxLength: 16,
				}),
				fc.boolean(),
				(n, jitter, withLc) => {
					const lines: Line[] = []
					for (let i = 0; i < n; i++) {
						const t = 1000 + i * DMR_SUPERFRAME_MS + (jitter[i] ?? 0)
						lines.push([t, MS("VC*")])
						if (withLc && i % 3 === 1) lines.push([t + 50, LC(1)])
					}
					const { starts, ends } = replay(lines, 1000 + n * 360 + 6000)
					expect(starts).toHaveLength(1)
					expect(ends).toHaveLength(1)
				},
			),
			{ numRuns: 100 },
		)
	})
})
