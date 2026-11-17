/**
 * dsd-fme DMR: one voiced over is one call, and a call is known clear only
 * on its own clean link control.
 *
 * Recorded (tests/mocks/fixtures/recorded/dsd-fme-dmr, ids replaced): after
 * each over a repeater sends a train of 18-39 same-slot terminators, each
 * followed by its link control (TLC + LC). A link control whose preceding
 * same-lane sync is a terminator (or any burst but voice) never starts,
 * names or clears a call. The over's only clean LC is often its VC6
 * embedded one, followed by a CACH short LC error ("SLCO CRC ERR") and the
 * other slot's sync loss: neither drops it; the slot's next clean sync
 * settles it. A call with IDs that still does not know its encryption at
 * its terminator settles on a clean trailer naming its IDs. One copy
 * of another talker's IDs after a voice burst revokes known clear on the
 * same callId; two agreeing copies split the call.
 */
import { readFileSync } from "node:fs"
import fc from "fast-check"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
	DMR_SOURCE_MAX,
	DMR_SUPERFRAME_MS,
	DMR_TALKGROUP_MAX,
	DMR_VLC_CANDIDATE_MS,
	DSD_FME_LINE_CLUMP_MS,
} from "../../../src/decoders/builtin/dsd-fme.js"
import type { DsdFmeVoiceCallState } from "../../../src/decoders/builtin/dsd-fme.js"
import {
	at,
	createDecoder,
	MS,
	replay,
	T0,
	type Line,
} from "./dsd-fme-call-first-helpers.js"

/** A recorded excerpt: arrival ms and line (ANSI codes kept). */
function fixture(name: string): Line[] {
	return readFileSync(
		`tests/mocks/fixtures/recorded/dsd-fme-dmr/${name}.txt`,
		"utf8",
	)
		.split("\n")
		.filter(line => line !== "" && !line.startsWith("#"))
		.map((line): Line => {
			const tab = line.indexOf("\t")
			return [Number(line.slice(0, tab)), line.slice(tab + 1)]
		})
}

const plain = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "")
const shift = (lines: Line[], byMs: number): Line[] =>
	lines.map(([t, text]): Line => [t + byMs, text])
/** Arrival times of a fixture's lines that match `pattern`. */
const timesOf = (lines: Line[], pattern: RegExp) =>
	lines.filter(([, text]) => pattern.test(plain(text))).map(([t]) => t)

/** A repeater (BS) sync of `slot`'s burst. */
const BS = (slot: 1 | 2, burst: string, cc = "01") =>
	slot === 1
		? `00:00:01 Sync: +DMR  [SLOT1]  slot2  | Color Code=${cc} | ${burst} `
		: `00:00:01 Sync: +DMR   slot1  [SLOT2] | Color Code=${cc} | ${burst} `
const TLC = (slot: 1 | 2) =>
	slot === 1
		? "00:00:01 Sync: +DMR  [slot1]  slot2  | Color Code=01 | TLC  "
		: "00:00:01 Sync: +DMR   slot1  [slot2] | Color Code=01 | TLC  "
const BRACKETLESS_TLC =
	"00:00:01 Sync: +DMR   slot1   slot2  | Color Code=01 | TLC  "
const SYNC_ERR = (slot: 1 | 2) =>
	slot === 1
		? "00:00:01 Sync:  DMR  [SLOT1]  slot2  | Frame Sync Err: 7"
		: "00:00:01 Sync:  DMR   slot1  [SLOT2] | Frame Sync Err: 7"
const LC = (slot: number, tg = 9001, src = 91, extra = "") =>
	` SLOT ${slot} TGT=${tg} SRC=${src} Group Call ${extra} `

/** One superframe of `slot` (VC1* or VC1, then VC2 to VC6, 60 ms apart) from `fromMs`. */
function superframe(slot: 1 | 2, fromMs: number, first = false): Line[] {
	return [1, 2, 3, 4, 5, 6].map(
		(n, i): Line => [
			fromMs + i * 60,
			BS(slot, n === 1 && first ? "VC1*" : `VC${n}`),
		],
	)
}

/** A repeater over of `superframes`, with `lc` after each VC6 (at +301 ms). */
function over(
	slot: 1 | 2,
	fromMs: number,
	superframes: number,
	lc: string | null = LC(slot),
): Line[] {
	const lines: Line[] = []
	for (let s = 0; s < superframes; s++) {
		const t = fromMs + s * DMR_SUPERFRAME_MS
		lines.push(...superframe(slot, t, s === 0))
		if (lc !== null) lines.push([t + 301, lc])
	}
	return lines
}

/** A terminator train: `count` TLC + LC pairs of `slot`, `gapMs` apart. */
function train(
	slot: 1 | 2,
	fromMs: number,
	count: number,
	gapMs = 105,
	lc = LC(slot),
): Line[] {
	const lines: Line[] = []
	for (let i = 0; i < count; i++) {
		lines.push([fromMs + i * gapMs, TLC(slot)])
		lines.push([fromMs + i * gapMs, lc])
	}
	return lines
}

type Internals = { dmrIdRejected: number }

/** Whether a voice-call state ever said clear for `callId` (or any call). */
const everClear = (voice: DsdFmeVoiceCallState[], callId?: string) =>
	voice.some(
		v =>
			(callId === undefined || v.callId === callId) &&
			v.encryptionKnown === true &&
			!v.encrypted,
	)

describe("dsd-fme DMR overs and their terminator trains", () => {
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["Date"] })
		vi.setSystemTime(T0)
	})
	afterEach(() => {
		vi.useRealTimers()
	})

	describe("bounds", () => {
		it("states the candidate window and the ID range with their arithmetic", () => {
			expect(DMR_VLC_CANDIDATE_MS).toBe(700)
			expect(DMR_VLC_CANDIDATE_MS).toBe(
				DMR_SUPERFRAME_MS + DSD_FME_LINE_CLUMP_MS,
			)
			expect(DMR_TALKGROUP_MAX).toBe(16_777_215)
			expect(DMR_SOURCE_MAX).toBe(16_776_415)
		})

		it("a direct key-up names its call with IDs at the range's top, not past it", () => {
			const keyUp = (tg: number, src: number) =>
				replay(
					[
						[1000, MS("VLC")],
						[1000, LC(1, tg, src)],
						[1060, MS("VC*")],
						[1420, MS("VC*")],
						[1600, MS("TLC")],
					],
					8000,
				)
			const top = keyUp(DMR_TALKGROUP_MAX, DMR_SOURCE_MAX)
			expect(top.ends).toHaveLength(1)
			expect(top.ends[0]).toMatchObject({
				talkgroup: DMR_TALKGROUP_MAX,
				source: DMR_SOURCE_MAX,
			})
			for (const [tg, src] of [
				[DMR_TALKGROUP_MAX + 1, 91],
				[9001, DMR_SOURCE_MAX + 1],
				[0, 91],
				[9001, 0],
			] as const) {
				const past = keyUp(tg, src)
				expect(past.ends.every(e => e.talkgroup !== tg)).toBe(true)
			}
		})

		it("a voice LC header whose sync failed names the over if its voice starts within 700 ms, not at 701", () => {
			const run = (lateMs: number) => {
				const vlc: Line[] = [
					[1000, BS(1, "VLC  (FEC ERR)")],
					[1000, LC(1)],
				]
				const voiceAt = 1000 + lateMs - 60
				return replay(
					[...vlc, ...over(1, voiceAt, 3, null), [voiceAt + 1200, TLC(1)]],
					9000,
				)
			}
			// The call starts on the second voice burst, lateMs after the LC.
			const inside = run(DMR_VLC_CANDIDATE_MS)
			expect(inside.starts[0]).toMatchObject({ talkgroup: 9001, source: 91 })
			const past = run(DMR_VLC_CANDIDATE_MS + 1)
			expect(past.starts.every(s => s.talkgroup === null)).toBe(true)
		})
	})

	describe("recorded repeater overs", () => {
		const recorded = fixture("rep-train")
		const firstTlc = timesOf(recorded, /\[slot1\].*\| TLC/)[0]!

		it("an over and its 18-pair train are one call, ending at the first terminator, known clear", () => {
			const { starts, ends, voice } = replay(
				recorded,
				recorded.at(-1)![0] + 6000,
			)
			expect(starts).toHaveLength(1)
			expect(ends).toHaveLength(1)
			expect(at(ends[0]!.endedAt!)).toBe(firstTlc)
			expect(ends[0]).toMatchObject({
				talkgroup: 9001,
				source: 91,
				slot: 1,
				encryptionKnown: true,
			})
			expect(ends[0]!.flags?.timeout).toBe(false)
			// The held voice is released while the call runs (known clear before its end).
			const clear = voice.findIndex(v => v.active && v.encryptionKnown === true)
			const end = voice.findIndex(v => !v.active)
			expect(clear).toBeGreaterThanOrEqual(0)
			expect(clear).toBeLessThan(end)
			// No call starts inside the train.
			expect(starts.every(s => at(s.startedAt) < firstTlc)).toBe(true)
		})

		it("the same with a 2 868 ms fade inside the train", () => {
			const tlcs = timesOf(recorded, /\[slot1\].*\| TLC/)
			const fadeAt = tlcs[5]!
			const faded = recorded.map(
				([t, text]): Line => [t >= fadeAt ? t + 2868 : t, text],
			)
			const { starts, ends } = replay(faded, faded.at(-1)![0] + 6000)
			expect(starts).toHaveLength(1)
			expect(ends).toHaveLength(1)
			expect(at(ends[0]!.endedAt!)).toBe(firstTlc)
		})

		it("an over, its train, then a new voiced over with the same IDs: two calls", () => {
			const gap = recorded.at(-1)![0] + 2000
			const lines = [...recorded, ...shift(recorded, gap)]
			const { starts, ends } = replay(lines, lines.at(-1)![0] + 6000)
			expect(starts).toHaveLength(2)
			expect(ends).toHaveLength(2)
			expect(ends.map(e => at(e.endedAt!))).toEqual([firstTlc, firstTlc + gap])
			expect(ends.every(e => e.encryptionKnown === true)).toBe(true)
		})

		it("an over whose VC6 link control lost its burst settles on its clean trailer; the other slot's run is its own call", () => {
			const lines = fixture("rep-two-slot")
			const { starts, ends } = replay(lines, lines.at(-1)![0] + 6000)
			const slot1 = ends.filter(e => e.slot === 1)
			expect(slot1).toHaveLength(1)
			expect(at(slot1[0]!.endedAt!)).toBe(
				timesOf(lines, /\[slot1\].*\| TLC/)[0],
			)
			expect(slot1[0]).toMatchObject({ talkgroup: 9001, encryptionKnown: true })
			// One call per voiced run of each slot, none inside the trains.
			expect(starts).toHaveLength(2)
			expect(ends.filter(e => e.slot === 2)).toHaveLength(1)
		})

		it("false IDs after a terminator that brackets no slot start nothing", () => {
			const lines = fixture("rep-bogus-id")
			const decoder = createDecoder()
			const { starts } = replay(lines, lines.at(-1)![0] + 6000, decoder)
			expect(starts).toHaveLength(0)
			expect(
				(decoder as unknown as Internals).dmrIdRejected,
			).toBeGreaterThanOrEqual(1)
			// After a recorded over: still one call.
			const after = [...recorded, ...shift(lines, recorded.at(-1)![0] + 200)]
			expect(replay(after, after.at(-1)![0] + 6000).starts).toHaveLength(1)
		})

		it("a -Z false link control (FLCO=0x28 SVC=0x10) names nothing", () => {
			const lines = fixture("rep-false-lc-flco")
			const decoder = createDecoder()
			expect(
				replay(lines, lines.at(-1)![0] + 6000, decoder).starts,
			).toHaveLength(0)
			expect(
				(decoder as unknown as Internals).dmrIdRejected,
			).toBeGreaterThanOrEqual(1)
		})
	})

	describe("known clear", () => {
		it("VC6 LC, a CACH short LC error, the other slot's sync loss, then the terminator: known clear before the end", () => {
			const { ends, voice } = replay(
				[
					...over(1, 1000, 2, null),
					[1300 + 360, BS(1, "VC6")],
					[1662, LC(1)],
					[1663, " SLCO CRC ERR"],
					[
						1664,
						" Activity Update TS1: Group Voice; Hash: 255; TS2: Idle; Hash: 0;",
					],
					[1665, SYNC_ERR(2)],
					[1668, TLC(1)],
					[1668, LC(1)],
				],
				8000,
			)
			expect(ends).toHaveLength(1)
			expect(ends[0]).toMatchObject({ talkgroup: 9001, encryptionKnown: true })
			expect(at(ends[0]!.endedAt!)).toBe(1668)
			const clear = voice.findIndex(v => v.active && v.encryptionKnown === true)
			expect(clear).toBeGreaterThanOrEqual(0)
		})

		it("an LC followed by its late error line is dropped: the next clean sync does not settle it", () => {
			const lines: Line[] = [
				...over(1, 1000, 1, null),
				[1302, LC(1)],
				[1303, " (CRC ERR) "],
				...over(1, 1360, 2, null),
			]
			const { ends, voice } = replay(lines, 8000)
			expect(ends).toHaveLength(1)
			expect(ends[0]).toMatchObject({ talkgroup: 9001, encryptionKnown: false })
			expect(everClear(voice)).toBe(false)
		})

		it("an unlisted line between the LC and its closing sync drops it; a bracketless sync leaves it", () => {
			const dropped = replay(
				[
					...over(1, 1000, 1, null),
					[1302, LC(1)],
					[1303, " SLOT 1 SB/RC (FEC ERR) E:4; I:00000000 D:000;  "],
					...over(1, 1360, 2, null),
				],
				8000,
			)
			expect(everClear(dropped.voice)).toBe(false)
			const unlisted = replay(
				[
					...over(1, 1000, 1, null),
					[1302, LC(1)],
					[1303, ""],
					[1303, " Channel Timing CSBK (CT_CSBK) "],
					...over(1, 1360, 2, null),
				],
				8000,
			)
			expect(everClear(unlisted.voice)).toBe(false)
			const kept = replay(
				[
					...over(1, 1000, 1, null),
					[1302, LC(1)],
					// A blank line neither settles nor drops (BURST_NEUTRAL_LINES).
					[1303, ""],
					[1303, "00:00:01 Sync:  DMR                  | VOICE CACH/EMB ERR"],
					[1304, "00:00:01 Sync: +DMR   slot1   slot2  | CACH/Burst FEC ERR"],
					...over(1, 1360, 2, null),
				],
				8000,
			)
			expect(everClear(kept.voice)).toBe(true)
		})

		it("a call with IDs still unknown at its terminator settles on a clean trailer naming its IDs", () => {
			const head: Line[] = [
				...over(1, 1000, 2, null),
				[1662, LC(1)],
				[1663, SYNC_ERR(1)],
			]
			const settled = replay([...head, [1800, TLC(1)], [1800, LC(1)]], 8000)
			expect(settled.ends).toHaveLength(1)
			expect(settled.ends[0]).toMatchObject({
				talkgroup: 9001,
				encryptionKnown: true,
			})
			expect(at(settled.ends[0]!.endedAt!)).toBe(1800)
			// A trailer naming other IDs, or one whose burst printed an error, says nothing.
			const other = replay(
				[...head, [1800, TLC(1)], [1800, LC(1, 9002, 92)]],
				8000,
			)
			expect(other.ends[0]).toMatchObject({
				talkgroup: 9001,
				encryptionKnown: false,
			})
			expect(at(other.ends[0]!.endedAt!)).toBe(1800)
			const errored = replay(
				[...head, [1800, TLC(1)], [1800, LC(1)], [1801, " (CRC ERR) "]],
				8000,
			)
			expect(errored.ends[0]).toMatchObject({ encryptionKnown: false })
		})

		it("two slots: each lane's link control settles only on its own slot's sync", () => {
			const lines: Line[] = [
				...over(1, 1000, 2, null),
				...over(2, 1030, 2, null),
				// Slot 1's LC, then slot 2's errors: slot 1 settles on its next sync.
				[1662, LC(1)],
				[1663, SYNC_ERR(2)],
				[1664, "00:00:01 Sync: +DMR   slot1  [slot2] | CACH/Burst FEC ERR"],
				// Slot 2's LC, then slot 1's sync loss: slot 2 settles on its own.
				[1692, LC(2, 9003, 93)],
				[1693, SYNC_ERR(1)],
				...over(1, 1720, 1, null),
				...over(2, 1750, 1, null),
				[2400, TLC(1)],
				[2400, LC(1)],
				[2430, TLC(2)],
				[2430, LC(2, 9003, 93, "(CRC ERR)")],
			]
			const { ends } = replay(lines, 9000)
			expect(ends).toHaveLength(2)
			const slot1 = ends.find(e => e.slot === 1)!
			const slot2 = ends.find(e => e.slot === 2)!
			expect(slot1).toMatchObject({ talkgroup: 9001, encryptionKnown: true })
			expect(slot2).toMatchObject({ talkgroup: 9003, encryptionKnown: true })
			// Without slot 2's own closing sync it stays unknown.
			// Slot 2's own sync loss drops its LC; its trailer printed an error.
			const unsettled = replay([...lines, [1700, SYNC_ERR(2)]], 9000)
			expect(unsettled.ends.find(e => e.slot === 2)).toMatchObject({
				encryptionKnown: false,
			})
			expect(unsettled.ends.find(e => e.slot === 1)).toMatchObject({
				encryptionKnown: true,
			})
		})
	})

	describe("trust", () => {
		it("an encrypted VC6 link control, then a clear-looking train: never clear", () => {
			const { ends, voice } = replay(
				[
					...over(1, 1000, 2, null),
					[1662, LC(1, 9001, 91, "Encrypted")],
					...over(1, 1720, 1, null),
					...train(1, 2100, 25),
				],
				12_000,
			)
			expect(ends).toHaveLength(1)
			expect(ends[0]!.flags?.encrypted).toBe(true)
			expect(everClear(voice)).toBe(false)
		})

		it("clear A, its train, then encrypted B on its frames: A's train link controls never clear B", () => {
			const a = [...over(1, 1000, 2), ...train(1, 1800, 20)]
			const b: Line[] = []
			for (let s = 0; s < 4; s++) {
				const t = 5000 + s * DMR_SUPERFRAME_MS
				b.push(...superframe(1, t, s === 0))
				// A's train link controls between B's bursts: after a terminator
				// that brackets no slot, and printed after the other slot's sync.
				b.push([t + 310, BRACKETLESS_TLC], [t + 310, LC(1)])
				b.push([t + 320, TLC(2)], [t + 320, LC(1)])
				b.push([t + 330, BS(2, "IDLE")], [t + 330, LC(1)])
			}
			const bEnd: Line[] = [
				[6500, TLC(1)],
				[6500, LC(1, 9005, 95, "Encrypted")],
			]
			const { ends, voice } = replay([...a, ...b, ...bEnd], 14_000)
			expect(ends).toHaveLength(2)
			const callB = ends[1]!
			expect(callB.flags?.encrypted).toBe(true)
			expect(everClear(voice, callB.callId)).toBe(false)
			// B with no trailer at all stays unknown.
			const silent = replay([...a, ...b, [6500, TLC(1)]], 14_000)
			expect(silent.ends[1]).toMatchObject({
				talkgroup: null,
				encryptionKnown: false,
			})
			expect(everClear(silent.voice, silent.ends[1]!.callId)).toBe(false)
		})

		it("a -Z link control of no voice call after a voice burst names nothing and clears nothing", () => {
			for (const fields of [
				"FLCO=0x28 FID=0x00 SVC=0x10",
				"FLCO=0x00 FID=0x10 SVC=0x00",
			]) {
				const decoder = createDecoder()
				const { ends, voice } = replay(
					[
						...over(1, 1000, 3, null),
						[1302, ` SLOT 1 TGT=9000001 SRC=91 ${fields} Group Call  `],
						[1662, ` SLOT 1 TGT=9000001 SRC=91 ${fields} Group Call  `],
					],
					8000,
					decoder,
				)
				expect(ends.every(e => e.talkgroup === null)).toBe(true)
				expect(everClear(voice)).toBe(false)
				expect(
					(decoder as unknown as Internals).dmrIdRejected,
				).toBeGreaterThanOrEqual(2)
			}
			// The same print with group voice fields names and clears the call.
			const clear = replay(
				[
					...over(1, 1000, 3, null),
					[
						1662,
						" SLOT 1 TGT=9001 SRC=91 FLCO=0x00 FID=0x00 SVC=0x00 Group Call  ",
					],
				],
				8000,
			)
			expect(clear.ends[0]).toMatchObject({
				talkgroup: 9001,
				encryptionKnown: true,
			})
		})
	})

	describe("another talker's IDs", () => {
		const known: Line[] = [...over(1, 1000, 2, null), [1662, LC(1)]]

		it("one copy revokes known clear on the same callId, until the call's own link control settles it again", () => {
			const lines: Line[] = [
				...known,
				...over(1, 1720, 1, null),
				[2022, LC(1, 9002, 92)],
				...over(1, 2080, 1, null),
				[2382, LC(1)],
				...over(1, 2440, 1, null),
				[2800, TLC(1)],
				[2800, LC(1)],
			]
			const { starts, ends, voice } = replay(lines, 9000)
			expect(starts).toHaveLength(1)
			expect(ends).toHaveLength(1)
			const id = ends[0]!.callId
			const states = voice
				.filter(v => v.callId === id && v.active)
				.map(v => v.encryptionKnown)
			// clear, then unknown (revoked), then clear again
			const revoked = states.indexOf(false, states.indexOf(true))
			expect(states.indexOf(true)).toBeGreaterThanOrEqual(0)
			expect(revoked).toBeGreaterThan(states.indexOf(true))
			expect(states.indexOf(true, revoked)).toBeGreaterThan(revoked)
			expect(ends[0]).toMatchObject({ talkgroup: 9001, encryptionKnown: true })
		})

		it("two agreeing copies split: the next talker's call is unknown until its own link control", () => {
			const lines: Line[] = [
				...known,
				...over(1, 1720, 1, null),
				[2022, LC(1, 9002, 92)],
				...over(1, 2080, 1, null),
				[2382, LC(1, 9002, 92)],
				...over(1, 2440, 1, null),
				[2742, LC(1, 9002, 92)],
				...over(1, 2800, 1, null),
				[3200, TLC(1)],
				[3200, LC(1, 9002, 92)],
			]
			const { starts, ends, voice } = replay(lines, 9000)
			expect(starts).toHaveLength(2)
			expect(ends.map(e => e.talkgroup)).toEqual([9001, 9002])
			expect(starts[1]).toMatchObject({
				talkgroup: 9002,
				encryptionKnown: false,
			})
			expect(ends[1]).toMatchObject({ encryptionKnown: true })
			expect(everClear(voice, ends[1]!.callId)).toBe(true)
			expect(at(ends[1]!.endedAt!)).toBe(3200)
		})
	})

	describe("direct (MS/DM)", () => {
		const recorded = fixture("direct-keyup")
		const tlcs = timesOf(recorded, /\| TLC/)

		it("each recorded key-up is a new call known at start, ended at its terminator; the late join settles clear", () => {
			const { starts, ends } = replay(recorded, recorded.at(-1)![0] + 6000)
			expect(starts).toHaveLength(5)
			expect(ends).toHaveLength(5)
			// The fourth over was joined late (voice, then its LC, no header): it
			// is not known at start (encryptionKnown set) and settled clear on its
			// next clean sync, before its call_start went out.
			expect(starts.map(s => s.encryptionKnown)).toEqual([
				undefined,
				undefined,
				undefined,
				true,
				undefined,
			])
			expect(ends[3]).toMatchObject({ encryptionKnown: true })
			expect(ends.every(e => e.talkgroup === 90001 && e.source === 901)).toBe(
				true,
			)
			// Each call ends at the first terminator after its start (direct end time).
			for (const end of ends) {
				const tlc = tlcs.find(t => t >= at(end.startedAt))
				expect(at(end.endedAt!)).toBe(tlc)
				expect(end.flags?.timeout).toBe(false)
			}
		})

		it("a key-up whose first header printed a garbled colour code is one call", () => {
			const lines = fixture("direct-e4")
			const { starts, ends } = replay(lines, lines.at(-1)![0] + 6000)
			expect(starts).toHaveLength(1)
			expect(ends).toHaveLength(1)
			const vlc = timesOf(lines, /\| VLC/)[0]!
			expect(at(ends[0]!.startedAt)).toBe(vlc)
			expect(at(ends[0]!.endedAt!)).toBe(timesOf(lines, /\| TLC/).at(-1))
		})

		it("three voice LC headers of one key-up, the last 260 ms after the second, stay one call under -Z", () => {
			const { starts, ends } = replay(
				[
					[1000, MS("VLC", "15")],
					[1001, LC(1)],
					[1038, MS("VLC", "11")],
					[1042, LC(1)],
					[1298, MS("VLC", "11")],
					[1299, LC(1)],
					[1320, MS("VC*", "11")],
					[1680, MS("VC*", "11")],
					[2000, MS("TLC", "11")],
				],
				8000,
			)
			expect(starts).toHaveLength(1)
			expect(ends).toHaveLength(1)
			expect(at(ends[0]!.startedAt)).toBe(1000)
			expect(at(ends[0]!.endedAt!)).toBe(2000)
			// After a voice burst, a header 200 ms on is still the next over.
			const rekey = replay(
				[
					[1000, MS("VLC")],
					[1001, LC(1)],
					[1060, MS("VC*")],
					[1420, MS("VC*")],
					[1700, MS("VLC")],
					[1701, LC(1)],
					[1760, MS("VC*")],
					[2120, MS("VC*")],
					[2400, MS("TLC")],
				],
				8000,
			)
			expect(rekey.ends).toHaveLength(2)
		})

		it("the printed SLOT 2 names nothing: it neither splits, nor escapes encryption, nor the trailer", () => {
			const head: Line[] = [
				[1000, MS("VLC")],
				[1000, LC(1)],
				[1060, MS("VC*")],
				[1400, LC(2)],
				[1420, MS("VC*")],
			]
			const one = replay([...head, [1800, MS("TLC")]], 8000)
			expect(one.ends).toHaveLength(1)
			expect(one.ends[0]).toMatchObject({ talkgroup: 9001, slot: 1 })
			const muted = replay(
				[...head, [1760, LC(2, 9001, 91, "Encrypted")], [1800, MS("TLC")]],
				8000,
			)
			expect(muted.ends[0]!.flags?.encrypted).toBe(true)
			// An unnamed direct over takes its trailer printed as SLOT 2.
			const unnamed = replay(
				[
					[1000, MS("VC*")],
					[1360, MS("VC*")],
					[1720, MS("VC*")],
					[1900, MS("TLC")],
					[1900, LC(2)],
				],
				8000,
			)
			expect(unnamed.ends[0]).toMatchObject({ talkgroup: 9001, source: 91 })
		})

		it("a direct terminator's train link controls start nothing", () => {
			const { starts } = replay(
				[
					[1000, MS("VLC")],
					[1000, LC(1)],
					[1060, MS("VC*")],
					[1420, MS("VC*")],
					[1800, MS("TLC")],
					[1800, LC(1)],
					[2100, MS("TLC")],
					[2100, LC(1)],
					[2400, MS("CSBK")],
					[2400, LC(1)],
				],
				8000,
			)
			expect(starts).toHaveLength(1)
		})
	})

	describe("unchecked link controls and late joins", () => {
		it("a late join (an LC after a voice burst, no call) is unknown until settled; its late error line keeps it never clear", () => {
			const join: Line[] = [
				[1000, BS(1, "VC2")],
				[1050, LC(1)],
			]
			const settled = replay([...join, ...over(1, 1100, 2, null)], 8000)
			expect(settled.starts).toHaveLength(1)
			// Settled on the next clean sync (not known at start: the field is set).
			expect(settled.starts[0]).toMatchObject({
				talkgroup: 9001,
				encryptionKnown: true,
			})
			expect(everClear(settled.voice)).toBe(true)
			const late = replay(
				[...join, [1051, " (CRC ERR) "], ...over(1, 1100, 2, null)],
				8000,
			)
			expect(late.starts[0]).toMatchObject({ encryptionKnown: false })
			expect(everClear(late.voice)).toBe(false)
		})

		it("an LC whose line printed an error starts nothing and is no rival", () => {
			const errored = (extra: string) => LC(1, 9002, 92, extra)
			for (const extra of ["(CRC ERR)", " -RAS ", "Key: 01 ERR"]) {
				const alone = replay(
					[
						[1000, BS(1, "VC2")],
						[1050, errored(extra)],
					],
					8000,
				)
				expect(alone.starts).toHaveLength(0)
				// Two copies after two voice bursts of a known clear call.
				const rival = replay(
					[
						...over(1, 1000, 2, null),
						[1662, LC(1)],
						...over(1, 1720, 1, null),
						[2022, errored(extra)],
						...over(1, 2080, 1, null),
						[2382, errored(extra)],
						...over(1, 2440, 1, null),
						[2800, TLC(1)],
					],
					9000,
				)
				expect(rival.starts).toHaveLength(1)
				const id = rival.starts[0]!.callId
				const states = rival.voice
					.filter(v => v.callId === id && v.active)
					.map(v => v.encryptionKnown)
				// Known clear and never revoked by an unchecked copy.
				expect(states.indexOf(true)).toBeGreaterThanOrEqual(0)
				expect(states.indexOf(false, states.indexOf(true))).toBe(-1)
			}
		})

		it("a voice LC header candidate is dropped when its burst's late error line arrives", () => {
			const run = (late: boolean) =>
				replay(
					[
						[1000, BS(1, "VLC  (FEC ERR)")],
						[1000, LC(1)],
						...(late ? ([[1001, " (CRC ERR) "]] as Line[]) : []),
						...over(1, 1060, 3, null),
						[2300, TLC(1)],
					],
					9000,
				)
			expect(run(false).starts[0]).toMatchObject({ talkgroup: 9001 })
			const dropped = run(true)
			expect(dropped.starts.every(s => s.talkgroup === null)).toBe(true)
		})

		it("a burst that prints another talker's IDs twice is one copy: no split until a newer voice burst repeats them", () => {
			const known: Line[] = [...over(1, 1000, 2, null), [1662, LC(1)]]
			const twice = replay(
				[
					...known,
					...over(1, 1720, 1, null),
					[2022, LC(1, 9002, 92)],
					[2023, LC(1, 9002, 92)],
					...over(1, 2080, 1, null),
					[2440, TLC(1)],
				],
				9000,
			)
			expect(twice.starts).toHaveLength(1)
			const again = replay(
				[
					...known,
					...over(1, 1720, 1, null),
					[2022, LC(1, 9002, 92)],
					[2023, LC(1, 9002, 92)],
					...over(1, 2080, 1, null),
					[2382, LC(1, 9002, 92)],
					...over(1, 2440, 1, null),
					[2800, TLC(1)],
				],
				9000,
			)
			expect(again.starts).toHaveLength(2)
		})

		it("a -Z print with FLCO or FID but no SVC is checked field by field", () => {
			const run = (fields: string) =>
				replay(
					[
						[1000, BS(1, "VLC")],
						[1000, ` SLOT 1 TGT=9001 SRC=91 ${fields} Group Call `],
						...over(1, 1060, 2, null),
						[1800, TLC(1)],
					],
					9000,
				)
			expect(run("FLCO=0x28").starts.every(s => s.talkgroup === null)).toBe(
				true,
			)
			expect(run("FID=0x10").starts.every(s => s.talkgroup === null)).toBe(true)
			expect(run("FLCO=0x00 FID=0x00").starts[0]).toMatchObject({
				talkgroup: 9001,
			})
		})

		it("an algorithm print never proves clear; a non-clear one drops a held clear trailer", () => {
			const head: Line[] = [
				...over(1, 1000, 2, null),
				[1662, LC(1)],
				[1663, SYNC_ERR(1)],
			]
			const clearAlg = replay(
				[
					...over(1, 1000, 2, null),
					[1662, "ALG ID: 00"],
					...over(1, 1720, 2, null),
				],
				9000,
			)
			expect(everClear(clearAlg.voice)).toBe(false)
			const held = replay(
				[...head, [1800, TLC(1)], [1800, LC(1)], [1801, "ALG ID: 21"]],
				8000,
			)
			expect(everClear(held.voice)).toBe(false)
			// A clear algorithm print after the trailer is not the trailer either:
			// the burst did not close clean, so nothing settles.
			const heldClear = replay(
				[...head, [1800, TLC(1)], [1800, LC(1)], [1801, "ALG ID: 00"]],
				8000,
			)
			expect(heldClear.ends[0]).toMatchObject({ encryptionKnown: false })
			// The trailer alone, closed by a clean sync, settles.
			const trailer = replay(
				[...head, [1800, TLC(1)], [1800, LC(1)], [1850, BS(1, "IDLE")]],
				8000,
			)
			expect(trailer.ends[0]).toMatchObject({ encryptionKnown: true })
		})
	})

	describe("held terminator trailer", () => {
		it("a CSBK print before the terminator, then a trailer closed by a sync loss or another unlisted line: never clear", () => {
			const head: Line[] = [
				...over(1, 1000, 2, null),
				[1662, LC(1)],
				[1663, " Channel Timing CSBK (CT_CSBK) "],
				[1800, TLC(1)],
				[1800, LC(1)],
			]
			for (const close of [SYNC_ERR(1), " Channel Timing CSBK (CT_CSBK) "]) {
				const { ends, voice } = replay([...head, [1850, close]], 8000)
				expect(ends).toHaveLength(1)
				expect(ends[0]!.encryptionKnown).not.toBe(true)
				expect(everClear(voice)).toBe(false)
			}
		})
	})

	describe("dirty voice LC headers", () => {
		it("a new call on a header whose sync printed an error is never known at once, even with a call running", () => {
			const { starts } = replay(
				[
					[1000, BS(1, "VLC")],
					[1000, LC(1)],
					[1060, BS(1, "VLC  (FEC ERR)")],
					[1060, LC(1, 9002, 92)],
					...over(1, 1120, 2, null),
				],
				8000,
			)
			const b = starts.find(s => s.talkgroup === 9002)
			expect(b).toBeDefined()
			expect(b!.encryptionKnown).toBeDefined()
		})
	})

	describe("properties", () => {
		it("property: one over then any train of 1-60 TLC + LC pairs, gaps 0-3 000 ms, is exactly one call", () => {
			// Feature: dmr-over, Property 1: a terminator train never starts a call
			// After one over, the repeater's train of terminators and their link controls starts, names and splits nothing.
			fc.assert(
				fc.property(
					fc.array(fc.integer({ min: 0, max: 3000 }), {
						minLength: 1,
						maxLength: 60,
					}),
					fc.boolean(),
					(gaps, fromFrames) => {
						vi.setSystemTime(T0)
						const lines: Line[] = fromFrames
							? [...over(1, 1000, 2, null), [1662, LC(1)]]
							: [[940, BS(1, "VLC")], [940, LC(1)], ...over(1, 1000, 2, null)]
						let t = 1800
						for (const gap of gaps) {
							t += gap
							lines.push([t, TLC(1)], [t, LC(1)])
						}
						const { starts, ends } = replay(lines, t + 6000)
						expect(starts).toHaveLength(1)
						expect(ends).toHaveLength(1)
						expect(at(ends[0]!.endedAt!)).toBe(1800 + gaps[0]!)
					},
				),
				{ numRuns: 100 },
			)
		})

		it("property: no call learns it is clear without its own clean clear link control after its first voice burst, settled by its lane's next clean sync", () => {
			// Feature: dmr-over, Property 2: known clear only on its own settled link control
			// A call is clear only after a clean clear link control of its own IDs, printed after a voice burst and closed by the lane's next clean sync.
			const TOKENS = {
				vc: (n: number) => BS(1, `VC${(n % 6) + 1}`),
				vcErr: () => BS(1, "VC3  (FEC ERR)"),
				vlc: () => BS(1, "VLC"),
				vlcDirty: () => BS(1, "VLC  (FEC ERR)"),
				tlc: () => TLC(1),
				syncErr: () => SYNC_ERR(1),
				lcK: () => LC(1),
				lcOther: () => LC(1, 9002, 92),
				lcErr: () => LC(1, 9001, 91, "(CRC ERR)"),
				lcEnc: () => LC(1, 9001, 91, "Encrypted"),
				lcZ: () =>
					" SLOT 1 TGT=9001 SRC=91 FLCO=0x28 FID=0x00 SVC=0x10 Group Call  ",
				lateErr: () => " (CRC ERR) ",
				neutral: () => " SLCO CRC ERR",
				unlisted: () => " Channel Timing CSBK (CT_CSBK) ",
				otherSlot: () => BS(2, "IDLE"),
				otherSlotErr: () => SYNC_ERR(2),
				bracketless: () => BRACKETLESS_TLC,
			} as const
			type Token = keyof typeof TOKENS
			const token = fc.constantFrom(...(Object.keys(TOKENS) as Token[]))
			fc.assert(
				fc.property(
					fc.array(
						fc.record({
							token,
							gap: fc.integer({ min: 0, max: 400 }),
						}),
						{ minLength: 1, maxLength: 80 },
					),
					steps => {
						vi.setSystemTime(T0)
						// Every run starts on voice frames (a call-first call, unknown).
						const lines: Line[] = over(1, 1000, 1, null)
						let t = 1360
						steps.forEach(({ token: name, gap }, i) => {
							t += gap
							lines.push([t, TOKENS[name](i)])
						})
						const { voice, starts } = replay(lines, t + 6000)
						// Oracle: a line index proves key (tg, src) when it is a clean
						// clear LC of that key whose lane-1 preceding sync is a voice
						// burst or a terminator, and the next lane-1 line after it
						// that is not neutral is a clean lane-1 sync (or none).
						const proofs = new Set<string>()
						let dmrBs = true
						let slot = 1
						const laneOf = (text: string) => {
							if (/Sync:/.test(text)) {
								const b = /\[slot([12])\]/i.exec(text)?.[1]
								dmrBs = b !== undefined
								if (b !== undefined) slot = Number(b)
								return b === undefined ? 0 : Number(b)
							}
							if (!dmrBs) return 0
							const s = /\bSLOT\s+([12])\b/.exec(text)?.[1]
							return s !== undefined ? Number(s) : slot
						}
						const lanes = lines.map(([, text]) => laneOf(text))
						// Known at start needs a clean voice LC header and a clean LC
						// of the call's IDs printed in its burst (before the lane's
						// next sync).
						const headers = new Set<string>()
						lines.forEach(([, text], i) => {
							if (lanes[i] !== 1 || !/\| VLC/.test(text) || /ERR/.test(text))
								return
							for (let j = i + 1; j < lines.length; j++) {
								if (lanes[j] !== 1) continue
								const next = lines[j]![1]
								if (/Sync:/.test(next)) return
								const ids = /TGT=(\d+) SRC=(\d+)/.exec(next)
								if (ids && !/ERR|Encrypted|FLCO=0x28/.test(next))
									headers.add(`${ids[1]}/${ids[2]}`)
							}
						})
						for (const start of starts) {
							// Known encrypted at start is the safe side: only clear counts.
							if (
								start.encryptionKnown !== undefined ||
								start.encrypted === true
							)
								continue
							expect(headers.has(`${start.talkgroup}/${start.source}`)).toBe(
								true,
							)
						}
						let prevSync: string | undefined
						lines.forEach(([, text], i) => {
							if (lanes[i] !== 1) return
							if (/Sync:/.test(text)) {
								prevSync = text
								return
							}
							const ids = /TGT=(\d+) SRC=(\d+)/.exec(text)
							if (
								ids === null ||
								/ERR|Encrypted|FLCO=0x28/.test(text) ||
								prevSync === undefined ||
								!/\| (VC[1-6*]|TLC)/.test(prevSync)
							)
								return
							for (let j = i + 1; j < lines.length; j++) {
								if (lanes[j] !== 1) continue
								const next = lines[j]![1]
								if (next === " SLCO CRC ERR") continue
								if (/Sync:/.test(next) && !/ERR/.test(next)) break
								// Any other line of the lane drops it.
								return
							}
							proofs.add(`${ids[1]}/${ids[2]}`)
						})
						for (const state of voice) {
							if (state.encryptionKnown !== true || state.encrypted) continue
							const started = voice.find(v => v.callId === state.callId)
							// Only a call that started unknown learns it.
							if (started?.encryptionKnown !== false) continue
							expect(proofs.has(`${state.talkgroup}/${state.source}`)).toBe(
								true,
							)
						}
					},
				),
				{ numRuns: 100 },
			)
		})
	})
})
