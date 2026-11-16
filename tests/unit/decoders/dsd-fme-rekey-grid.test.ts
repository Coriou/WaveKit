/**
 * dsd-fme DMR re-key without a terminator: a sync printed late or early
 * (off the call's 360 ms superframe grid) after a missing embedded-LC print
 * does not split an over; the gap is measured from voice syncs; a re-key is a
 * voice LC header after REKEY_GAP_MS, an off-grid sync after
 * DMR_REKEY_LONG_GAP_MS, or an off-grid sync confirmed by the next one.
 */
import fc from "fast-check"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
	DMR_GRID_TOLERANCE_MS,
	DMR_REKEY_CONFIRM_MS,
	DMR_REKEY_LONG_GAP_MS,
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

/** A direct over: one voice sync per superframe from 1000 ms, then a terminator. */
function over(
	superframes: number,
	offsets: Record<number, number> = {},
): Line[] {
	const lines: Line[] = []
	for (let i = 0; i < superframes; i++)
		lines.push([1000 + i * DMR_SUPERFRAME_MS + (offsets[i] ?? 0), MS("VC*")])
	return lines
}

describe("dsd-fme DMR re-key grid", () => {
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["Date"] })
		vi.setSystemTime(T0)
	})
	afterEach(() => {
		vi.useRealTimers()
	})

	it("states its bounds", () => {
		// One superframe with no sync plus the re-key gap: 360 + 200.
		expect(DMR_REKEY_LONG_GAP_MS).toBe(DMR_SUPERFRAME_MS + REKEY_GAP_MS)
		expect(DMR_REKEY_LONG_GAP_MS).toBe(560)
		// Two prints each up to 45 ms off: 2 x 45.
		expect(DMR_REKEY_CONFIRM_MS).toBe(90)
		expect(DMR_GRID_TOLERANCE_MS).toBe(30)
	})

	it.each([35, 40, -40])(
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

	it("an off-grid sync after a long gap re-keys at once: at 560 ms, not at 559", () => {
		// The last sync at 1720; the next 559 / 560 ms later (off the grid by 161 / 160).
		const near = replay(
			[...over(3), [1720 + DMR_REKEY_LONG_GAP_MS - 1, MS("VC*")]],
			12_000,
		)
		expect(near.ends).toHaveLength(1)
		const far = replay(
			[
				...over(3),
				[1720 + DMR_REKEY_LONG_GAP_MS, MS("VC*")],
				[1720 + DMR_REKEY_LONG_GAP_MS + 360, MS("VC*")],
				[1720 + DMR_REKEY_LONG_GAP_MS + 720, MS("VC*")],
			],
			12_000,
		)
		expect(far.ends).toHaveLength(2)
		expect(at(far.ends[0]!.endedAt!)).toBe(1720)
		expect(at(far.ends[1]!.startedAt)).toBe(2280)
	})

	it("confirmation needs the second sync more than 90 ms off the call's grid: 91 splits, 90 does not", () => {
		// Last sync 1720; the suspect 2 superframes on plus the offset, then one on its grid.
		const lines = (offset: number): Line[] => [
			...over(3),
			[1720 + 360 + offset, MS("VC*")],
			[1720 + 720 + offset, MS("VC*")],
			[1720 + 1080 + offset, MS("VC*")],
		]
		expect(replay(lines(DMR_REKEY_CONFIRM_MS), 12_000).ends).toHaveLength(1)
		const split = replay(lines(DMR_REKEY_CONFIRM_MS + 1), 12_000)
		expect(split.ends).toHaveLength(2)
		expect(at(split.ends[1]!.startedAt)).toBe(1720 + 360 + 91)
		// A second sync off the suspect's grid (by 31) confirms nothing.
		const unconfirmed = replay(
			[
				...over(3),
				[1720 + 360 + 120, MS("VC*")],
				[1720 + 720 + 120 + DMR_GRID_TOLERANCE_MS + 1, MS("VC*")],
			],
			12_000,
		)
		expect(unconfirmed.ends).toHaveLength(1)
	})

	it("a split over back-dates the next one to its first sync and starts it on the confirming sync", () => {
		const { starts, ends } = replay(
			[
				...over(3),
				[1720 + 480, MS("VC*")],
				[1720 + 840, MS("VC*")],
				[1720 + 1200, MS("VC*")],
			],
			12_000,
		)
		expect(starts).toHaveLength(2)
		expect(ends).toHaveLength(2)
		expect(at(ends[0]!.endedAt!)).toBe(1720)
		expect(at(starts[1]!.startedAt)).toBe(2200)
	})

	it("an over whose last sync is off the grid and never confirmed is still one call", () => {
		// 1725 is 31 ms off the grid of 1334: a suspect no later sync confirms,
		// so it was a late print of this over and counts as its evidence.
		const { starts, ends } = replay(
			[
				[1000, MS("VC*")],
				[1334, MS("VC*")],
				[1725, MS("VC*")],
			],
			8000,
		)
		expect(starts).toHaveLength(1)
		expect(ends).toHaveLength(1)
		expect(at(starts[0]!.startedAt)).toBe(1000)
	})

	it("property: jitter within ±45 ms on each sync of a continuous over never splits it", () => {
		// Feature: dv-call-first, Property: DMR jitter never splits a continuous over
		// Validates: review M1 (a late sync after a missing LC print)
		fc.assert(
			fc.property(
				fc.integer({ min: 3, max: 16 }),
				fc.array(fc.integer({ min: -45, max: 45 }), {
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
