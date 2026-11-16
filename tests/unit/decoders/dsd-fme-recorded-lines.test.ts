/**
 * dsd-fme DMR call lifecycle on lines recorded from dsd-fme (synthetic IQ in
 * the core image: tests/integration/dv-capture.test.ts, the seeds of
 * tests/mocks/fixtures/synthetic/dv-latency-dmr-*.json). Each case is a short
 * excerpt of one line shape the modelled per-burst timings hid:
 *
 * - a repeater over's first voice burst prints "VC1*" (with the star);
 * - an over's first syncs print a garbled colour code (07, 13, 05, 02, 00);
 * - lines arrive in clumps about 340 ms apart (DSD_FME_LINE_CLUMP_MS), so a
 *   superframe grid measured on arrival times split continuous overs;
 * - a direct over keys up with a header burst whose slot type failed
 *   ("CACH/Burst FEC ERR") or a PI header: the next over's first line;
 * - a stray sync of another protocol seconds after an over ended it there.
 */
import { readFileSync } from "node:fs"
import fc from "fast-check"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
	DMR_SUPERFRAME_MS,
	DSD_FME_LINE_CLUMP_MS,
	REKEY_GAP_MS,
	SYNC_CHAIN_MS,
} from "../../../src/decoders/builtin/dsd-fme.js"
import { at, replay, T0, type Line } from "./dsd-fme-call-first-helpers.js"

/** A recorded seed's lines from `fromMs` to `toMs` (inclusive). */
function excerpt(scene: string, fromMs: number, toMs: number): Line[] {
	const seed = JSON.parse(
		readFileSync(
			`tests/mocks/fixtures/synthetic/dv-latency-${scene}.json`,
			"utf8",
		),
	) as { lines: { atMs: number; text: string }[] }
	return seed.lines
		.filter(l => l.atMs >= fromMs && l.atMs <= toMs)
		.map((l): Line => [l.atMs, l.text])
}

const DIRECT = (cc: string, burst: string) =>
	`10:52:53 Sync: +DMR MS/DM MODE/MONO | Color Code=${cc} | ${burst} `
const ID = " SLOT 1 TGT=4321 SRC=1234567 Group Call  "

describe("dsd-fme on recorded DMR lines", () => {
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["Date"] })
		vi.setSystemTime(T0)
	})
	afterEach(() => {
		vi.useRealTimers()
	})

	it("states the measured clump and the bounds it is checked against", () => {
		expect(DSD_FME_LINE_CLUMP_MS).toBe(340)
		// An empty clump between two syncs of a direct over (2 x 340 = 680)
		// stays inside one chain window (2 x 360 + 40 = 760).
		expect(2 * DSD_FME_LINE_CLUMP_MS).toBeLessThan(SYNC_CHAIN_MS.dmr!)
		// A clump is shorter than a superframe: each direct sync arrives in its own.
		expect(DSD_FME_LINE_CLUMP_MS).toBeLessThan(DMR_SUPERFRAME_MS)
	})

	it('a repeater over starts on its "VC1*" burst (repeater-lengths, 0.5 s over)', () => {
		// Recorded: the six bursts of one superframe in two clumps (1397, 1731-1769).
		const lines: Line[] = [
			[1389.6, "10:55:03 Sync: +DMR  [slot1]  slot2  | CACH/Burst FEC ERR"],
			[1391.7, "10:55:03 Sync: +DMR   slot1  [slot2] | CACH/Burst FEC ERR"],
			[1397.6, "10:55:03 Sync: +DMR  [SLOT1]  slot2  | Color Code=XX | VC1*"],
			[1724.1, "10:55:03 Sync: +DMR   slot1  [slot2] | Color Code=01 | IDLE "],
			[1731.9, "10:55:03 Sync: +DMR  [SLOT1]  slot2  | Color Code=01 | VC2 "],
			[1734.2, "10:55:03 Sync: +DMR   slot1  [slot2] | Color Code=01 | IDLE "],
			[1736.6, "10:55:03 Sync: +DMR  [SLOT1]  slot2  | Color Code=01 | VC3 "],
			[1738.1, "10:55:03 Sync: +DMR   slot1  [slot2] | Color Code=01 | IDLE "],
			[1754.6, "10:55:03 Sync: +DMR  [SLOT1]  slot2  | Color Code=01 | VC4 "],
			[1760, "10:55:03 Sync: +DMR   slot1  [slot2] | Color Code=01 | IDLE "],
			[1766, "10:55:03 Sync: +DMR  [SLOT1]  slot2  | Color Code=01 | VC5 "],
			[1767.2, "10:55:03 Sync: +DMR   slot1  [slot2] | Color Code=01 | IDLE "],
			[1769.3, "10:55:03 Sync: +DMR  [SLOT1]  slot2  | Color Code=01 | VC6 "],
			[1769.9, ID],
			[1771.9, "10:55:03 Sync: +DMR   slot1  [slot2] | Color Code=01 | IDLE "],
			[1773.5, "10:55:03 Sync: +DMR  [slot1]  slot2  | Color Code=01 | TLC  "],
			[1773.5, ID],
		]
		const { starts, ends } = replay(lines, 8000)
		expect(starts).toHaveLength(1)
		expect(ends).toHaveLength(1)
		expect(ends[0]).toMatchObject({ slot: 1, talkgroup: 4321, source: 1234567 })
		// Was 1731 (VC2): "VC1*" did not read as a voice burst.
		expect(at(ends[0]!.startedAt)).toBe(1397)
		expect(at(ends[0]!.endedAt!)).toBe(1773)
		expect(ends[0]!.flags?.timeout).toBe(false)
	})

	describe("a garbled colour code on an over's first syncs", () => {
		it("keeps the over's start (direct-lengths, 3 s over: CC 07 then 01)", () => {
			const lines: Line[] = [
				[
					19817.1,
					"10:52:10 Sync: +DMR MS/DM MODE/MONO | Color Code=07 | CACH/Burst FEC ERR",
				],
				[19820.8, "10:52:10 Sync: +DMR MS/DM MODE/MONO | Color Code=07 | VC* "],
				[20175, " SLOT 1 FLCO FEC ERR  (FEC ERR)"],
				[20181.4, "10:52:11 Sync: +DMR MS/DM MODE/MONO | Color Code=01 | VC* "],
				[20523.9, ID],
				...excerpt("dmr-direct-lengths", 20530, 22920),
			]
			const { starts, ends } = replay(lines, 30_000)
			expect(starts).toHaveLength(1)
			expect(ends).toHaveLength(1)
			// Was 20181 and a split at 21531: the CC 07 sync began a chain of its own.
			expect(at(ends[0]!.startedAt)).toBe(19817)
			expect(at(ends[0]!.endedAt!)).toBe(22919)
			expect(ends[0]).toMatchObject({ talkgroup: 4321, source: 1234567 })
		})

		it("starts a call only on two syncs of one code: 07, 01 is none, 07, 01, 01 is one from the first", () => {
			const one = replay(
				[
					[1000, DIRECT("07", "VC*")],
					[1340, DIRECT("01", "VC*")],
				],
				8000,
			)
			expect(one.starts).toHaveLength(0)
			const two = replay(
				[
					[1000, DIRECT("07", "VC*")],
					[1340, DIRECT("01", "VC*")],
					[1680, DIRECT("01", "VC*")],
					[2020, DIRECT("01", "VC*")],
					[2360, DIRECT("01", "VC*")],
				],
				8000,
			)
			expect(two.starts).toHaveLength(1)
			expect(at(two.ends[0]!.startedAt)).toBe(1000)
			// "XX" prints no code: XX, 01 pairs.
			const xx = replay(
				[
					[1000, DIRECT("XX", "VC*")],
					[1340, DIRECT("01", "VC*")],
					[1460, ID],
				],
				8000,
			)
			expect(xx.starts).toHaveLength(1)
			expect(at(xx.starts[0]!.startedAt)).toBe(1000)
		})

		it("needs three syncs of one code over 630 ms to announce an unnamed call", () => {
			// 07, 01, 01, 01: the run of 01 spans 680 ms (1340 -> 2020), so the
			// fourth sync announces; 01, 01, 05, 01 starts a call on the pair
			// but never has three of one code: it is never announced.
			const run = (ccs: string[]) =>
				replay(
					ccs.map(
						(cc, i): Line => [
							1000 + i * DSD_FME_LINE_CLUMP_MS,
							DIRECT(cc, "VC*"),
						],
					),
					8000,
				).starts
			expect(run(["07", "01", "01", "01"])).toHaveLength(1)
			expect(run(["01", "01", "05", "01"])).toHaveLength(0)
		})
	})

	describe("clumped arrival never splits a continuous over", () => {
		it("a 10 s direct over with 638, 653 and 663 ms steps is one call (direct-lengths)", () => {
			const { starts, ends } = replay(
				excerpt("dmr-direct-lengths", 27_000, 38_300),
				45_000,
			)
			expect(starts).toHaveLength(1)
			expect(ends).toHaveLength(1)
			// Was three calls: re-keys at 33125 and 36230 (off a 360 ms grid).
			expect(at(ends[0]!.startedAt)).toBe(28080)
			expect(at(ends[0]!.endedAt!)).toBe(37639)
		})

		it("a 10 s repeater over is one call (repeater-lengths, was ten)", () => {
			const { starts, ends } = replay(
				excerpt("dmr-repeater-lengths", 27_000, 41_400),
				48_000,
			)
			expect(starts).toHaveLength(1)
			expect(ends).toHaveLength(1)
			expect(ends[0]).toMatchObject({ slot: 1, talkgroup: 4321 })
			expect(ends[0]!.flags?.timeout).toBe(false)
		})

		it("two busy repeater slots give two concurrent calls (repeater-two-slots, was six)", () => {
			const { starts, ends } = replay(
				excerpt("dmr-repeater-two-slots", 0, 9000),
				15_000,
			)
			expect(starts).toHaveLength(2)
			expect(ends).toHaveLength(2)
			const bySlot = new Map(ends.map(e => [e.slot, e]))
			expect(bySlot.get(1)).toMatchObject({ talkgroup: 4321, source: 1234567 })
			expect(bySlot.get(2)).toMatchObject({ talkgroup: 4322, source: 7654321 })
			expect(at(bySlot.get(1)!.startedAt)).toBe(1392)
			expect(at(bySlot.get(1)!.endedAt!)).toBe(4460)
			expect(at(bySlot.get(2)!.startedAt)).toBe(2442)
			expect(at(bySlot.get(2)!.endedAt!)).toBe(5491)
			// Concurrent: slot 2 started before slot 1 ended.
			expect(at(bySlot.get(2)!.startedAt)).toBeLessThan(
				at(bySlot.get(1)!.endedAt!),
			)
		})

		it("property: a direct over whose syncs arrive in clumps of 300 to 400 ms is one call", () => {
			// Feature: dv-call-first, Property: clumped DMR line arrival never splits a continuous over
			// Validates: no superframe grid on clumped arrival times
			fc.assert(
				fc.property(
					fc.integer({ min: 4, max: 30 }),
					fc.integer({ min: 300, max: 400 }),
					fc.integer({ min: 0, max: 120 }),
					fc.array(fc.integer({ min: 0, max: 30 }), {
						minLength: 30,
						maxLength: 30,
					}),
					fc.boolean(),
					(superframes, clumpMs, latencyMs, spread, withIds) => {
						const lines: Line[] = []
						for (let k = 0; k < superframes; k++) {
							// The sync's line waits for the next clump boundary.
							const sent = 1000 + k * DMR_SUPERFRAME_MS + latencyMs
							const arrival =
								Math.ceil(sent / clumpMs) * clumpMs + (spread[k] ?? 0)
							lines.push([arrival, DIRECT("01", "VC*")])
							if (withIds && k % 2 === 1) lines.push([arrival + 1, ID])
						}
						const end = 1000 + superframes * DMR_SUPERFRAME_MS + 2000
						const { starts, ends } = replay(lines, end + 6000)
						expect(starts).toHaveLength(1)
						expect(ends).toHaveLength(1)
					},
				),
				{ numRuns: 100 },
			)
		})
	})

	describe("a direct over's header burst", () => {
		it("after sync loss begins the next over at the header (direct-gaps-same, 0.7 s gap)", () => {
			const lines: Line[] = [
				...excerpt("dmr-direct-gaps-same", 3400, 5130),
				[5148.2, ID],
				[5152.8, "10:52:53 Sync: +DMR MS/DM MODE/MONO | Color Code=01 | VC* "],
				[5526.3, ID],
				[5527.5, "10:52:53 Sync: +DMR MS/DM MODE/MONO | Color Code=01 | VC* "],
				[
					5840.5,
					" SLOT 1 Protected LC  FLCO=0x13 FID=0xFF  SLOT 1 FLCO FEC ERR  (FEC ERR)",
				],
				[6174.2, "Sync: no sync"],
				[
					6179.8,
					"10:52:54 Sync: +DMR MS/DM MODE/MONO | Color Code=02 | CACH/Burst FEC ERR",
				],
				[6504.4, "10:52:54 Sync: +DMR MS/DM MODE/MONO | Color Code=02 | VC* "],
				[6536.3, " SLOT 1 FLCO FEC ERR  (FEC ERR)"],
				[6845.8, "10:52:55 Sync: +DMR MS/DM MODE/MONO | Color Code=01 | VC* "],
				[6881.6, ID],
				[7189.4, "10:52:55 Sync: +DMR MS/DM MODE/MONO | Color Code=01 | VC* "],
				[7233.4, ID],
			]
			const { starts, ends } = replay(lines, 14_000)
			expect(starts).toHaveLength(2)
			expect(ends).toHaveLength(2)
			// The first ends at its last voice line, the second starts at its header.
			expect(at(ends[0]!.endedAt!)).toBe(5527)
			expect(ends[0]!.flags?.timeout).toBe(true)
			// Was 6845: the CC 02 sync began a chain of its own and the header was no sync.
			expect(at(ends[1]!.startedAt)).toBe(6179)
			for (const e of ends)
				expect(e).toMatchObject({ talkgroup: 4321, source: 1234567 })
		})

		/** A named direct over of four syncs 340 ms apart from 1000, then `tail`. */
		const named = (tail: Line[]): Line[] => [
			[1000, DIRECT("01", "VC*")],
			[1340, DIRECT("01", "VC*")],
			[1341, ID],
			[1680, DIRECT("01", "VC*")],
			[2020, DIRECT("01", "VC*")],
			...tail,
		]
		const followed = (header: string, gap: number): Line[] =>
			named([
				[2020 + gap, header],
				[2020 + gap + 340, DIRECT("01", "VC*")],
				[2020 + gap + 680, DIRECT("01", "VC*")],
				[2020 + gap + 681, ID],
			])

		it.each([
			["a failed data burst", DIRECT("13", "CACH/Burst FEC ERR")],
			["an errored PI header", DIRECT("05", "PI   (FEC ERR)")],
			["a voice LC header", DIRECT("01", "VLC ")],
		])(
			"%s re-keys 200 ms after the last voice sync, not 199 ms",
			(_name, header) => {
				const near = replay(followed(header, REKEY_GAP_MS - 1), 10_000)
				expect(near.ends).toHaveLength(1)
				const far = replay(followed(header, REKEY_GAP_MS), 10_000)
				expect(far.ends).toHaveLength(2)
				// The first call ends at its last voice sync, the next starts at the header.
				expect(at(far.ends[0]!.endedAt!)).toBe(2020)
				expect(at(far.ends[1]!.startedAt)).toBe(2020 + REKEY_GAP_MS)
			},
		)

		it("a repeater's failed CACH names no slot and splits nothing", () => {
			const bs = (burst: string) =>
				`10:55:03 Sync: +DMR  [SLOT1]  slot2  | Color Code=01 | ${burst} `
			const lines: Line[] = []
			for (let k = 0; k < 8; k++)
				for (let n = 1; n <= 6; n++)
					lines.push([1000 + k * 340 + n, bs(`VC${n}`)])
			lines.push([
				1000 + 4 * 340 - 100,
				"10:55:03 Sync: +DMR  [slot1]  slot2  | CACH/Burst FEC ERR",
			])
			const { starts, ends } = replay(lines, 10_000)
			expect(starts).toHaveLength(1)
			expect(ends).toHaveLength(1)
		})
	})

	it("a stray X2-TDMA sync after the over ends the call at its last line (direct-lengths)", () => {
		const lines: Line[] = [
			...excerpt("dmr-direct-lengths", 12_900, 14_350),
			[14359.1, ID],
			[14362.8, "10:52:05 Sync: +DMR MS/DM MODE/MONO | Color Code=01 | VC* "],
			[14708, ID],
			[14711.9, "10:52:05 Sync: +DMR MS/DM MODE/MONO | Color Code=01 | VC* "],
			[
				15042.9,
				" SLOT 1 Protected LC  FLCO=0x13 FID=0x9A  SLOT 1 FLCO FEC ERR  (FEC ERR)",
			],
			[15389.7, "Sync: no sync"],
			[16753.8, "10:52:07 Sync: -X2-TDMA  NAC: 000;   [slot1]  RATE 1/2 DATA"],
		]
		const { starts, ends } = replay(lines, 22_000)
		expect(starts).toHaveLength(1)
		expect(ends).toHaveLength(1)
		// Was 16753: the switch to another protocol ended it at the switch line.
		expect(at(ends[0]!.endedAt!)).toBe(14711)
		expect(ends[0]!.flags?.timeout).toBe(false)
		expect(at(ends[0]!.startedAt)).toBe(12988)
	})
})
