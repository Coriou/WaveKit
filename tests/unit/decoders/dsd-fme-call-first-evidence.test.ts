/**
 * dsd-fme call-first evidence rules: lost bursts and missed syncs keep
 * an over whole (no superframe grid is measured on clumped line arrival,
 * DSD_FME_LINE_CLUMP_MS), identity-less calls announced only on evidence
 * (no phantom calls from two noise syncs), a terminator's trailer naming a
 * call that had no IDs yet, and "known clear" only once the link control's
 * burst closed clean.
 */
import fc from "fast-check"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
	DMR_BURST_MS,
	DMR_SUPERFRAME_MS,
	DMR_TRAILER_HOLD_MS,
	DV_SUPERFRAME_MS,
	SYNC_CHAIN_MS,
	SYNC_PRINT_JITTER_MS,
	UNNAMED_EVIDENCE_SYNCS,
	unnamedEvidenceSpanMs,
} from "../../../src/decoders/builtin/dsd-fme.js"
import {
	at,
	LC,
	MS,
	replay,
	T0,
	type Line,
} from "./dsd-fme-call-first-helpers.js"

/** A repeater (BS) burst of slot 1. */
const BS = (burst: string) =>
	`03:04:05 Sync: +DMR  [slot1]  slot2  | Color Code=01 | ${burst} `
const DSTAR = "03:04:05 Sync: +DSTAR VOICE "
const P25 = (duid: string) => `03:04:05 Sync: +P25p1 NAC/CC: 2A5;  ${duid}`

/** Per-burst prints VC1..VC6 from `t0`, one per 60 ms burst, skipping `lost` burst indexes. */
function bursts(
	sync: (burst: string) => string,
	t0: number,
	count: number,
	lost: ReadonlySet<number> = new Set(),
): Line[] {
	const lines: Line[] = []
	for (let k = 0; k < count; k++)
		if (!lost.has(k))
			lines.push([t0 + k * DMR_BURST_MS, sync(`VC${(k % 6) + 1}`)])
	return lines
}

const range = (from: number, to: number) =>
	new Set(Array.from({ length: to - from + 1 }, (_, i) => from + i))

describe("dsd-fme call-first: evidence rules", () => {
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["Date"] })
		vi.setSystemTime(T0)
	})
	afterEach(() => {
		vi.useRealTimers()
	})

	it("states its bounds", () => {
		expect(DMR_SUPERFRAME_MS).toBe(6 * DMR_BURST_MS)
		expect(SYNC_PRINT_JITTER_MS).toBe(45)
		// One burst plus the print jitter: 60 + 45.
		expect(DMR_TRAILER_HOLD_MS).toBe(105)
		expect(UNNAMED_EVIDENCE_SYNCS).toBe(3)
		// 2 superframes less 2 x 45: DMR and P25 720 - 90, D-STAR 840 - 90.
		expect(DV_SUPERFRAME_MS).toMatchObject({ dmr: 360, p25p1: 360, dstar: 420 })
		expect(unnamedEvidenceSpanMs("dmr")).toBe(630)
		expect(unnamedEvidenceSpanMs("p25p1")).toBe(630)
		expect(unnamedEvidenceSpanMs("dstar")).toBe(750)
		expect(unnamedEvidenceSpanMs("ysf")).toBeUndefined()
	})

	describe("R1: one missed sync and a late next print keep an over whole", () => {
		/** over(14) from 1000 with sync 6 dropped and sync 7 `offset` ms off its grid. */
		const dropped = (offset: number, withLc: boolean): Line[] => {
			const lines: Line[] = []
			for (let i = 0; i < 14; i++) {
				if (i === 6) continue
				const t = 1000 + i * DMR_SUPERFRAME_MS + (i === 7 ? offset : 0)
				lines.push([t, MS("VC*")])
				if (withLc && i % 2 === 1) lines.push([t + 50, LC(1)])
			}
			return lines
		}
		for (const withLc of [false, true])
			it.each([35, 40, 45, -40])(
				`sync 7 at %i ms after the gap stays one call (LC every other superframe: ${withLc})`,
				offset => {
					// A 720 + offset ms gap with no header burst: the same over.
					const { starts, ends } = replay(dropped(offset, withLc), 12_000)
					expect(starts).toHaveLength(1)
					expect(ends).toHaveLength(1)
					expect(at(ends[0]!.startedAt)).toBe(1000)
					if (withLc)
						expect(ends[0]).toMatchObject({ talkgroup: 9, source: 100 })
				},
			)

		it("after a two-superframe gap a sync at any offset is the same over: 90, 91 and 180 ms off", () => {
			// Adapted (was: 91 ms off the grid split at once). Arrival is
			// clumped (DSD_FME_LINE_CLUMP_MS 340 ms), so no offset of a sync's
			// arrival says it began another over.
			const run = (offset: number) => {
				const lines: Line[] = []
				for (let i = 0; i < 3; i++)
					lines.push([1000 + i * DMR_SUPERFRAME_MS, MS("VC*")])
				// Two superframes without a sync (1720 -> 2440), then the next over or the same.
				const t = 1720 + 2 * DMR_SUPERFRAME_MS + offset
				for (let j = 0; j < 4; j++)
					lines.push([t + j * DMR_SUPERFRAME_MS, MS("VC*")])
				return replay(lines, 12_000).ends
			}
			for (const offset of [90, 91, 180]) {
				const ends = run(offset)
				expect(ends).toHaveLength(1)
				expect(at(ends[0]!.startedAt)).toBe(1000)
			}
		})
	})

	describe("lost bursts keep an over whole", () => {
		it("a repeater over printing VC1..VC6 that lost bursts 21-29 (600 ms) stays one call", () => {
			const lines = bursts(BS, 1000, 60, range(21, 29))
			lines.push([1000 + 60 * DMR_BURST_MS, BS("TLC")])
			const { starts, ends } = replay(lines, 12_000)
			expect(starts).toHaveLength(1)
			expect(ends).toHaveLength(1)
			expect(at(ends[0]!.startedAt)).toBe(1000)
		})

		it("a direct over printing per burst that lost 3 bursts (240 ms) stays one call", () => {
			const lines = bursts(MS, 1000, 40, range(15, 17))
			const { starts, ends } = replay(lines, 12_000)
			expect(starts).toHaveLength(1)
			expect(ends).toHaveLength(1)
		})

		it("a re-key through the repeater splits on its voice LC header, and without header or terminator stays one call", () => {
			// Adapted (was: over B 120 ms off the 360 ms grid split). Over A:
			// bursts 0-29; over B from burst 38, 540 ms after A's last burst.
			const a = bursts(BS, 1000, 30)
			const b = bursts(BS, 1000 + 38 * DMR_BURST_MS, 30)
			// No header, no terminator, the same (no) IDs: a missed split, never a split over.
			const merged = replay([...a, ...b], 12_000)
			expect(merged.starts).toHaveLength(1)
			expect(merged.ends).toHaveLength(1)
			// B's voice LC header one burst before its first voice burst splits.
			const vlcAt = 1000 + 37 * DMR_BURST_MS
			const { starts, ends } = replay([...a, [vlcAt, BS("VLC")], ...b], 12_000)
			expect(starts).toHaveLength(2)
			expect(ends).toHaveLength(2)
			expect(at(ends[0]!.endedAt!)).toBe(1000 + 29 * DMR_BURST_MS)
			expect(at(ends[1]!.startedAt)).toBe(vlcAt)
		})

		it("property: per-burst prints with random lost bursts and ±45 ms jitter never split an over", () => {
			// Feature: dv-call-first, Property: lost DMR bursts never split a continuous over
			// Validates: lost bursts and missed syncs keep one over
			fc.assert(
				fc.property(
					fc.boolean(),
					fc.array(
						fc.record({
							keep: fc.integer({ min: 1, max: 12 }),
							lose: fc.integer({ min: 0, max: 12 }),
						}),
						{ minLength: 3, maxLength: 10 },
					),
					fc.array(
						fc.integer({
							min: -SYNC_PRINT_JITTER_MS,
							max: SYNC_PRINT_JITTER_MS,
						}),
						{ minLength: 256, maxLength: 256 },
					),
					(repeater, runs, jitter) => {
						const sync = repeater ? BS : MS
						const lines: Line[] = []
						// Three clean superframes first (the call starts and is announced).
						let k = 0
						for (; k < 18; k++)
							lines.push([1000 + k * DMR_BURST_MS, sync(`VC${(k % 6) + 1}`)])
						for (const run of runs) {
							k += run.lose
							for (let j = 0; j < run.keep; j++, k++)
								lines.push([
									1000 + k * DMR_BURST_MS + (jitter[k % 256] ?? 0),
									sync(`VC${(k % 6) + 1}`),
								])
						}
						const { starts, ends } = replay(lines, 1000 + k * 60 + 6000)
						expect(starts).toHaveLength(1)
						expect(ends).toHaveLength(1)
					},
				),
				{ numRuns: 100 },
			)
		})
	})

	describe("an identity-less call needs evidence", () => {
		it("two direct-mode voice syncs 700 ms apart start no call", () => {
			const { starts, ends, voice } = replay(
				[
					[1000, MS("VC*")],
					[1700, MS("VC*")],
				],
				8000,
			)
			expect(starts).toHaveLength(0)
			expect(ends).toHaveLength(0)
			expect(voice).toHaveLength(0)
		})

		it("two D-STAR voice syncs 420 ms apart start no call", () => {
			const { starts, ends } = replay(
				[
					[1000, DSTAR],
					[1420, DSTAR],
				],
				8000,
			)
			expect(starts).toHaveLength(0)
			expect(ends).toHaveLength(0)
		})

		it("three DMR syncs announce at a 630 ms span, not at 629", () => {
			// Three clean syncs of one colour code, the first and last `span` apart.
			const run = (span: number) =>
				replay(
					[
						[1000, MS("VC*")],
						[1000 + span - 150, MS("VC*")],
						[1000 + span, MS("VC*")],
					],
					8000,
				)
			expect(run(unnamedEvidenceSpanMs("dmr")! - 1).starts).toHaveLength(0)
			const ok = run(unnamedEvidenceSpanMs("dmr")!)
			expect(ok.starts).toHaveLength(1)
			// Back-dated to the first sync.
			expect(at(ok.starts[0]!.startedAt)).toBe(1000)
		})

		it("three D-STAR syncs announce at a 750 ms span, not at 749", () => {
			const run = (span: number) =>
				replay(
					[
						[1000, DSTAR],
						[1000 + Math.floor(span / 2), DSTAR],
						[1000 + span, DSTAR],
					],
					8000,
				).starts
			expect(run(unnamedEvidenceSpanMs("dstar")! - 1)).toHaveLength(0)
			expect(run(unnamedEvidenceSpanMs("dstar")!)).toHaveLength(1)
		})

		it("two syncs at the 630 ms span are not three: no call", () => {
			expect(unnamedEvidenceSpanMs("dmr")!).toBeLessThan(SYNC_CHAIN_MS.dmr!)
			const { starts } = replay(
				[
					[1000, MS("VC*")],
					[1000 + SYNC_CHAIN_MS.dmr!, MS("VC*")],
				],
				8000,
			)
			expect(starts).toHaveLength(0)
		})

		it("a P25 over announces on five frames over 720 ms", () => {
			const { starts } = replay(
				[
					[1000, P25("HDU")],
					[1180, P25("LDU1")],
					[1360, P25("LDU2")],
					[1540, P25("LDU1")],
					[1720, P25("LDU2")],
				],
				8000,
			)
			expect(starts).toHaveLength(1)
			expect(at(starts[0]!.startedAt)).toBe(1000)
		})

		it("is announced on the line that completes its evidence, not on the next timer tick", () => {
			const span = unnamedEvidenceSpanMs("dmr")!
			const { outputs } = replay(
				[
					[1000, MS("VC*")],
					[1000 + span - 150, MS("VC*")],
					[1000 + span, MS("VC*")],
				],
				8000,
			)
			const start = outputs.find(o => o.type === "call_start")
			expect(start).toBeDefined()
			expect(start!.timestamp.getTime() - T0).toBe(1000 + span)
		})

		it("syncs arriving off a 360 ms grid are one over's evidence: one call from the first", () => {
			// Adapted (was: 1820, 100 ms off after a 460 ms gap and confirmed at
			// 2180, began a second over and was no evidence of the first). With
			// no header between them these syncs are one over.
			const { starts, ends } = replay(
				[
					[1000, MS("VC*")],
					[1360, MS("VC*")],
					[1820, MS("VC*")],
					[2180, MS("VC*")],
					[2540, MS("VC*")],
				],
				8000,
			)
			expect(starts).toHaveLength(1)
			expect(ends).toHaveLength(1)
			expect(at(starts[0]!.startedAt)).toBe(1000)
		})

		it("a link control naming the call is evidence on two syncs", () => {
			const { starts, ends } = replay(
				[
					[1000, MS("VC*")],
					[1360, MS("VC*")],
					[1400, LC(1)],
				],
				8000,
			)
			expect(starts).toHaveLength(1)
			expect(ends[0]).toMatchObject({ talkgroup: 9, source: 100 })
		})
	})

	describe("the terminator's trailer names a call with no IDs yet", () => {
		const head: Line[] = [
			[1000, MS("VC*")],
			[1360, MS("VC*")],
			[1720, MS("VC*")],
		]

		it("VC* at 1000/1360/1720 and TLC + SLOT line at 1900, closed by a clean sync: one call, tg 9 src 100, known clear", () => {
			const { outputs, starts, ends, voice } = replay(
				[...head, [1900, MS("TLC")], [1900, LC(1)], [1960, MS("CSBK")]],
				8000,
			)
			expect(starts).toHaveLength(1)
			expect(ends).toHaveLength(1)
			// Announced on the line that completes its evidence (1720), before
			// the trailer names it: unnamed, encryption not known yet.
			const start = outputs.find(o => o.type === "call_start")
			expect(start!.timestamp.getTime() - T0).toBe(1720)
			expect(starts[0]).toMatchObject({
				talkgroup: null,
				source: null,
				encryptionKnown: false,
			})
			expect(ends[0]).toMatchObject({
				talkgroup: 9,
				source: 100,
				encryptionKnown: true,
			})
			expect(at(ends[0]!.startedAt)).toBe(1000)
			expect(at(ends[0]!.endedAt!)).toBe(1900)
			expect(ends[0]!.flags?.timeout).toBe(false)
			expect(voice.at(-1)).toMatchObject({ active: false, talkgroup: 9 })
			// With no closing sync, the trailer window runs out: it still names
			// the call but proves nothing (fail closed).
			const unclosed = replay([...head, [1900, MS("TLC")], [1900, LC(1)]], 8000)
			expect(unclosed.ends[0]).toMatchObject({
				talkgroup: 9,
				source: 100,
				encryptionKnown: false,
			})
		})

		it("the trailer counts at 105 ms after the terminator, not at 106", () => {
			const run = (late: number) =>
				replay([...head, [1900, MS("TLC")], [1900 + late, LC(1)]], 8000)
			const inside = run(DMR_TRAILER_HOLD_MS)
			expect(inside.ends).toHaveLength(1)
			expect(inside.ends[0]).toMatchObject({ talkgroup: 9, source: 100 })
			const past = run(DMR_TRAILER_HOLD_MS + 1)
			// One call all the same (three syncs), unnamed; the late LC starts nothing.
			expect(past.starts).toHaveLength(1)
			expect(past.ends).toHaveLength(1)
			expect(past.ends[0]).toMatchObject({ talkgroup: null, source: null })
			expect(at(past.ends[0]!.endedAt!)).toBe(1900)
		})

		it("a short over named only by its trailer is a call; without the trailer it is none", () => {
			const short: Line[] = [
				[1000, MS("VC*")],
				[1360, MS("VC*")],
				[1540, MS("TLC")],
			]
			const named = replay([...short, [1540, LC(1)]], 8000)
			expect(named.starts).toHaveLength(1)
			expect(named.ends[0]).toMatchObject({ talkgroup: 9, source: 100 })
			expect(at(named.ends[0]!.endedAt!)).toBe(1540)
			expect(replay(short, 8000).starts).toHaveLength(0)
		})

		it("a trailer whose burst printed an error after it names nothing and leaves the encryption unknown", () => {
			const { starts, ends } = replay(
				[...head, [1900, MS("TLC")], [1900, LC(1)], [1910, " (CRC ERR) "]],
				8000,
			)
			expect(starts).toHaveLength(1)
			expect(ends).toHaveLength(1)
			expect(ends[0]).toMatchObject({
				talkgroup: null,
				source: null,
				encryptionKnown: false,
			})
			expect(at(ends[0]!.endedAt!)).toBe(1900)
		})

		it("a short over whose only trailer printed an error is no call", () => {
			const { starts } = replay(
				[
					[1000, MS("VC*")],
					[1360, MS("VC*")],
					[1540, MS("TLC")],
					[1540, LC(1)],
					[1550, " (CRC ERR) "],
				],
				8000,
			)
			expect(starts).toHaveLength(0)
		})

		it("the terminator printed again inside the hold keeps the call_end held for its trailer", () => {
			const { starts, ends } = replay(
				[
					...head,
					[1900, MS("TLC")],
					[1930, MS("TLC")],
					[1950, LC(1)],
					[1990, MS("CSBK")],
				],
				8000,
			)
			expect(starts).toHaveLength(1)
			expect(ends).toHaveLength(1)
			expect(ends[0]).toMatchObject({
				talkgroup: 9,
				source: 100,
				encryptionKnown: true,
			})
			expect(at(ends[0]!.endedAt!)).toBe(1900)
		})

		it("an encrypted trailer makes the call known encrypted", () => {
			const { ends } = replay(
				[...head, [1900, MS("TLC")], [1900, LC(1, 9, 100, "Encrypted")]],
				8000,
			)
			expect(ends[0]).toMatchObject({ talkgroup: 9, encryptionKnown: true })
			expect(ends[0]!.flags?.encrypted).toBe(true)
		})

		it("the next sync closes the trailer at once, and the next over starts on its own", () => {
			const { starts, ends } = replay(
				[
					...head,
					[1900, MS("TLC")],
					[1900, LC(1)],
					[1950, MS("VLC")],
					[2010, MS("VC*")],
					[2370, MS("VC*")],
					[2730, MS("VC*")],
				],
				8000,
			)
			expect(starts).toHaveLength(2)
			expect(ends).toHaveLength(2)
			expect(ends[0]).toMatchObject({ talkgroup: 9, source: 100 })
			expect(at(ends[0]!.endedAt!)).toBe(1900)
			expect(at(ends[1]!.startedAt)).toBeGreaterThanOrEqual(1950)
		})
	})

	describe("m2: known clear only once the link control's burst closes clean", () => {
		const head: Line[] = [
			[1000, MS("VC*")],
			[1360, MS("VC*")],
			[1720, MS("VC*")],
		]

		it("a link control that printed (FEC ERR) does not make the call known", () => {
			const { ends } = replay(
				[
					...head,
					[1800, LC(1, 9, 100, "(FEC ERR)")],
					[2080, MS("VC*")],
					[2440, MS("VC*")],
				],
				10_000,
			)
			expect(ends).toHaveLength(1)
			expect(ends[0]!.encryptionKnown).toBe(false)
		})

		it("an error line before the closing sync does not either; a clean close does", () => {
			const run = (tail: Line[]) =>
				replay(
					[
						...head,
						[1800, LC(1)],
						...tail,
						[2080, MS("VC*")],
						[2440, MS("VC*")],
					],
					10_000,
				).ends
			expect(run([[1810, " (CRC ERR) "]])[0]!.encryptionKnown).toBe(false)
			expect(run([])[0]!.encryptionKnown).toBe(true)
		})

		it("a link control the next DMR sync never closes (sync lost) says nothing", () => {
			const { ends } = replay(
				[...head, [1800, LC(1)], [1900, "SYNC LOST"]],
				10_000,
			)
			expect(ends[0]!.encryptionKnown).toBe(false)
		})

		it("in a repeater the other slot's next sync closes the burst", () => {
			const slot2 =
				"03:04:05 Sync: +DMR   slot1  [slot2] | Color Code=01 | IDLE "
			const { ends } = replay(
				[
					[1000, BS("VC*")],
					[1360, BS("VC*")],
					[1720, BS("VC*")],
					[1800, LC(1)],
					[1830, slot2],
					[2080, BS("VC*")],
				],
				10_000,
			)
			expect(ends).toHaveLength(1)
			expect(ends[0]).toMatchObject({ slot: 1, encryptionKnown: true })
		})
	})

	describe("m4: P25 src/tg prints", () => {
		const frames: Line[] = [
			[1000, P25("HDU")],
			[1180, P25("LDU1")],
			[1360, P25("LDU2")],
			[1540, P25("LDU1")],
			[1720, P25("LDU2")],
		]

		it("a clear ALG on an error-free src/tg line makes the call known clear", () => {
			const { ends } = replay(
				[...frames, [1550, " nac: [ 2A5] src: [ 1234] tg: [ 56] ALG ID: 0x80"]],
				10_000,
			)
			expect(ends).toHaveLength(1)
			expect(ends[0]).toMatchObject({
				talkgroup: 56,
				source: 1234,
				encryptionKnown: true,
			})
		})

		it("an encrypting ALG makes it known encrypted; no ALG or an errored line leaves it unknown", () => {
			const run = (line: string) =>
				replay([...frames, [1550, line]], 10_000).ends[0]!
			const encrypted = run(" nac: [ 2A5] src: [ 1234] tg: [ 56] ALG ID: 0x84")
			expect(encrypted.encryptionKnown).toBe(true)
			expect(encrypted.flags?.encrypted).toBe(true)
			expect(run(" nac: [ 2A5] src: [ 1234] tg: [ 56]").encryptionKnown).toBe(
				false,
			)
			expect(
				run(" nac: [ 2A5] src: [ 1234] tg: [ 56] ALG ID: 0x80 (CRC ERR)")
					.encryptionKnown,
			).toBe(false)
		})
	})
})
