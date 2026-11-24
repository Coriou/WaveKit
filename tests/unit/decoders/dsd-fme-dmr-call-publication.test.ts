/**
 * dsd-fme DMR: every call publishes (call_start / call_end with TGT/SRC,
 * slot and timing) whatever its trust; the DMR clearance only sets the
 * encrypted / encryptionKnown fields and recording admission.
 *
 * - Shapes modelled (shape from a private capture; ids, times and colour
 *   codes synthetic) on an image acceptance replay: a repeater over
 *   dsd-fme decoded only as its terminator train (TLC + LC pairs) with one
 *   `PI (CRC ERR)` burst of the other slot; a direct capture opening on the
 *   end of a transmission (two errored voice bursts, TLC + LC); a direct
 *   over whose last burst and terminator name the next talker.
 * - Privacy independence: every recorded and synthetic DMR script, and the
 *   cases here, publish the same calls (count, IDs, slot) with every privacy
 *   print removed (PI bursts, ALG / KEY ID prints, the Encrypted word and
 *   the SVC privacy bit of a link control).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
	at,
	createDecoder,
	replay,
	T0,
	type CallData,
	type Line,
} from "./dsd-fme-call-first-helpers.js"
import {
	BS,
	LC,
	MS,
	NO_SYNC,
	corpus,
	directCutStart,
	directErroredTrailer,
	directNextTalker,
	repeaterTrain,
} from "./dsd-fme-dmr-corpus.js"

/** Plain text (ANSI colour codes off), as the adapter reads it. */
const plain = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "")

/**
 * The script with every privacy print removed: PI bursts and ALG / KEY ID
 * prints are dropped, a link control keeps its IDs but loses the Encrypted
 * word and the SVC privacy bit (0x40). Nothing else changes.
 */
function withoutPrivacy(lines: readonly Line[]): Line[] {
	const out: Line[] = []
	for (const [t, raw] of lines) {
		const text = plain(raw)
		if (/\|\s*PI\b/.test(text) || /\b(?:ALG ID|KEY ID)\b|\bDMR PI\b/.test(text))
			continue
		out.push([
			t,
			text
				.replace(/\bEncrypted\s+/g, "")
				.replace(/\bSVC=0x([0-9A-Fa-f]{2})\b/g, (_, hex: string) => {
					const svc = parseInt(hex, 16) & ~0x40
					return `SVC=0x${svc.toString(16).padStart(2, "0").toUpperCase()}`
				}),
		])
	}
	return out
}

const hasPrivacy = (lines: readonly Line[]) =>
	withoutPrivacy(lines).length !== lines.length ||
	withoutPrivacy(lines).some(([, text], i) => text !== plain(lines[i]![1]))

/** A call as published, without its trust fields. */
const shape = (d: CallData) => ({
	talkgroup: d.talkgroup,
	source: d.source,
	slot: d.slot ?? null,
	startedAt: at(d.startedAt),
	endedAt: d.endedAt === undefined ? null : at(d.endedAt),
})

function calls(lines: readonly Line[], mode: string) {
	const last = lines.reduce((m, [t]) => Math.max(m, t), 0)
	const { starts, ends } = replay(
		[...lines],
		last + 6000,
		createDecoder({ mode }),
	)
	return { starts: starts.map(shape), ends: ends.map(shape) }
}

describe("dsd-fme DMR calls publish whatever their trust", () => {
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["Date"] })
		vi.setSystemTime(T0)
	})
	afterEach(() => vi.useRealTimers())

	it("a repeater over known only from its terminator train, with a PI (CRC ERR) burst, is one call with its IDs", () => {
		const lines = repeaterTrain(1000)
		const { starts, ends } = replay(
			lines,
			9000,
			createDecoder({ mode: "auto" }),
		)
		expect(starts).toHaveLength(1)
		expect(ends).toHaveLength(1)
		const firstLc = lines.find(([, t]) => t.includes("TGT="))![0]
		const lastTlc = lines.filter(([, t]) => t.includes("| TLC")).at(-1)![0]
		expect(ends[0]).toMatchObject({
			talkgroup: 9001,
			source: 91,
			slot: 1,
			// No voice decoded: never known clear, never encrypted.
			encryptionKnown: false,
		})
		expect(at(ends[0]!.startedAt)).toBe(firstLc)
		// It ends at its train's last burst (its call timeout).
		expect(at(ends[0]!.endedAt!)).toBe(lastTlc + 1)
		expect(ends[0]!.flags?.timeout).toBe(true)
		// Two such trains of one talker, 4 s apart or more: two calls.
		const two = [...lines, ...repeaterTrain(7000)]
		expect(
			replay(two, 16_000, createDecoder({ mode: "auto" })).ends,
		).toHaveLength(2)
	})

	it("a terminator train of another talker inside a just-ended call's train starts nothing on one copy", () => {
		const over: Line[] = [
			[0, BS(1, "VLC")],
			[1, LC(9001, 91)],
			[60, BS(1, "VC1")],
			[420, BS(1, "VC2")],
			[421, LC(9001, 91)],
			[480, BS(1, "VC3")],
			[540, BS(1, "TLC")],
			[541, LC(9001, 91)],
			[600, BS(1, "TLC")],
			[601, LC(9003, 90001)],
			[660, BS(1, "TLC")],
			[661, LC(9001, 91)],
		]
		const { ends } = replay(over, 7000, createDecoder({ mode: "auto" }))
		expect(ends.map(e => [e.talkgroup, e.source])).toEqual([[9001, 91]])
	})

	it("a direct capture that opens on a transmission's end publishes that fragment, then the next over", () => {
		const { starts, ends } = replay(
			directCutStart(),
			8000,
			createDecoder({ mode: "auto" }),
		)
		expect(starts).toHaveLength(2)
		expect(ends.map(e => [e.talkgroup, e.source, e.slot])).toEqual([
			[9001, 91, 1],
			[9002, 92, 1],
		])
		// Back-dated to its first voice burst, ended at its link control.
		expect(at(ends[0]!.startedAt)).toBe(0)
		expect(at(ends[0]!.endedAt!)).toBe(121)
		expect(ends[0]!.encryptionKnown).toBe(false)
		// Back-dated to the over's first sync.
		expect(at(ends[1]!.startedAt)).toBe(1000)
		expect(at(ends[1]!.endedAt!)).toBe(1840)
	})

	it("a direct over whose last burst and terminator name another talker is two calls", () => {
		// Two agreeing copies of other IDs (the voice burst's and the
		// terminator's): a second radio keyed right after the first, so its
		// call is its own, not a split of the first over.
		const { ends } = replay(
			directNextTalker(),
			8000,
			createDecoder({ mode: "auto" }),
		)
		expect(ends.map(e => [e.talkgroup, e.source])).toEqual([
			[9001, 91],
			[9002, 92],
		])
		expect(at(ends[0]!.startedAt)).toBeLessThanOrEqual(60)
		expect(at(ends[0]!.endedAt!)).toBe(1620)
		expect(at(ends[1]!.startedAt)).toBe(1621)
	})
})

describe("dsd-fme DMR terminator trains: one over is one call", () => {
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["Date"] })
		vi.setSystemTime(T0)
	})
	afterEach(() => vi.useRealTimers())

	it("repro A: an unnamed over whose trailer failed its CRC is named by the clean terminator copies after it", () => {
		const { starts, ends } = replay(
			directErroredTrailer(2),
			8000,
			createDecoder({ mode: "auto" }),
		)
		expect(starts).toHaveLength(1)
		expect(ends.map(e => [e.talkgroup, e.source])).toEqual([[9001, 91]])
		expect(at(ends[0]!.startedAt)).toBe(0)
		// It ends at its first terminator.
		expect(at(ends[0]!.endedAt!)).toBe(720)
	})

	it("repro A: two voice bursts 60 ms apart, an errored trailer, then clean copies: one named call", () => {
		const { starts, ends } = replay(
			directErroredTrailer(2, 60),
			8000,
			createDecoder({ mode: "auto" }),
		)
		expect(starts).toHaveLength(1)
		expect(ends.map(e => [e.talkgroup, e.source])).toEqual([[9001, 91]])
		expect(at(ends[0]!.startedAt)).toBe(0)
		expect(at(ends[0]!.endedAt!)).toBe(120)
	})

	it("repro A: an announced unnamed over gets its IDs from its clean terminator copies", () => {
		const { starts, ends } = replay(
			directErroredTrailer(10),
			10_000,
			createDecoder({ mode: "auto" }),
		)
		expect(starts).toHaveLength(1)
		expect(ends.map(e => [e.talkgroup, e.source])).toEqual([[9001, 91]])
		expect(at(ends[0]!.endedAt!)).toBe(3600)
	})

	it("repro B: one link control after a terminator sync that printed an error starts no call", () => {
		const lines: Line[] = [
			[0, MS("TLC \x1b[31m (CRC ERR) \x1b[0m")],
			[1, LC(9001, 91)],
			[100, NO_SYNC],
		]
		const { starts, ends } = replay(
			lines,
			8000,
			createDecoder({ mode: "auto" }),
		)
		expect(starts).toHaveLength(0)
		expect(ends).toHaveLength(0)
		// A clean copy of the same terminator confirms it: one call, from the first copy.
		const confirmed = replay(
			[
				...lines.slice(0, 2),
				[60, MS("TLC")],
				[61, LC(9001, 91)],
				[100, NO_SYNC],
			],
			8000,
			createDecoder({ mode: "auto" }),
		)
		expect(confirmed.ends.map(e => [e.talkgroup, e.source])).toEqual([
			[9001, 91],
		])
		expect(at(confirmed.ends[0]!.startedAt)).toBe(1)
	})

	it("repro C: a direct talker's second over, only its terminators decoded, 2.2 s after the first, is its own call", () => {
		const lines: Line[] = [
			[0, MS("VLC")],
			[1, LC(9001, 91)],
			[60, MS("VC*")],
			[61, LC(9001, 91)],
			[420, MS("VC*")],
			[421, LC(9001, 91)],
			[780, MS("TLC")],
			[781, LC(9001, 91)],
			[840, NO_SYNC],
			[3000, MS("TLC")],
			[3001, LC(9001, 91)],
			[3060, MS("TLC")],
			[3061, LC(9001, 91)],
			[3100, NO_SYNC],
		]
		const { ends } = replay(lines, 10_000, createDecoder({ mode: "auto" }))
		expect(ends.map(e => [e.talkgroup, e.source, at(e.startedAt)])).toEqual([
			[9001, 91, 0],
			[9001, 91, 3001],
		])
		expect(at(ends[0]!.endedAt!)).toBe(780)
		expect(at(ends[1]!.endedAt!)).toBe(3061)
	})

	it("repro C: another direct talker's one clean terminator copy right after a call is that talker's call", () => {
		const lines: Line[] = [
			[0, MS("VLC")],
			[1, LC(9001, 91)],
			[60, MS("VC*")],
			[420, MS("VC*")],
			[421, LC(9001, 91)],
			[780, MS("TLC")],
			[781, LC(9001, 91)],
			[840, MS("TLC")],
			[841, LC(9002, 92)],
			[900, NO_SYNC],
		]
		const { ends } = replay(lines, 10_000, createDecoder({ mode: "auto" }))
		expect(ends.map(e => [e.talkgroup, e.source])).toEqual([
			[9001, 91],
			[9002, 92],
		])
		// On an unclean sync one copy of another talker is not enough.
		const unclean = lines.map(
			([t, text]): Line =>
				t === 840 ? [t, MS("TLC \x1b[31m (CRC ERR) \x1b[0m")] : [t, text],
		)
		expect(
			replay(unclean, 10_000, createDecoder({ mode: "auto" })).ends.map(e => [
				e.talkgroup,
				e.source,
			]),
		).toEqual([[9001, 91]])
	})

	it("repro D: a repeater train call ends at its own last link control; the next talker starts at its first copy", () => {
		const lines: Line[] = []
		for (let i = 0; i < 4; i++)
			lines.push([i * 120, BS(1, "TLC")], [i * 120 + 1, LC(9001, 91)])
		lines.push(
			[2000, BS(1, "TLC")],
			[2001, LC(9002, 92)],
			[2120, BS(1, "TLC")],
			[2121, LC(9002, 92)],
		)
		const { ends } = replay(lines, 14_000, createDecoder({ mode: "auto" }))
		expect(
			ends.map(e => [e.talkgroup, e.source, at(e.startedAt), at(e.endedAt!)]),
		).toEqual([
			[9001, 91, 1, 361],
			[9002, 92, 2001, 2121],
		])
	})

	it("a repeater slot that goes idle between two trains of one talker: two overs, two calls", () => {
		// Modelled on 100041 (private repeater capture): two terminator
		// trains of one talker, the slot idle between them (two RF overs).
		const train = (from: number): Line[] => {
			const out: Line[] = []
			for (let i = 0; i < 4; i++)
				out.push(
					[from + i * 120, BS(1, "TLC")],
					[from + i * 120 + 1, LC(9001, 91)],
				)
			return out
		}
		const idle: Line[] = [
			[600, BS(1, "IDLE")],
			[660, BS(2, "IDLE")],
			[720, BS(1, "IDLE")],
		]
		const two = replay(
			[...train(0), ...idle, ...train(900)],
			10_000,
			createDecoder({ mode: "auto" }),
		)
		expect(
			two.ends.map(e => [
				e.talkgroup,
				e.source,
				at(e.startedAt),
				at(e.endedAt!),
			]),
		).toEqual([
			[9001, 91, 1, 361],
			[9001, 91, 901, 1261],
		])
		// One idle burst inside a continuous train (a misread slot type): one call.
		const one = replay(
			[...train(0), [400, BS(1, "IDLE")], ...train(480)],
			10_000,
			createDecoder({ mode: "auto" }),
		)
		expect(one.ends.map(e => [at(e.startedAt), at(e.endedAt!)])).toEqual([
			[1, 841],
		])
	})

	it("repro D: one copy of another talker in a repeater train neither refreshes nor ends the train call", () => {
		const lines: Line[] = []
		for (let i = 0; i < 4; i++)
			lines.push([i * 120, BS(1, "TLC")], [i * 120 + 1, LC(9001, 91)])
		lines.push([2000, BS(1, "TLC")], [2001, LC(9002, 92)])
		lines.push([5800, BS(1, "TLC")], [5801, LC(9002, 92)])
		const { ends } = replay(lines, 14_000, createDecoder({ mode: "auto" }))
		// The two copies of the other talker are 3.8 s apart: not one train.
		expect(
			ends.map(e => [e.talkgroup, e.source, at(e.startedAt), at(e.endedAt!)]),
		).toEqual([
			[9001, 91, 1, 361],
			[9002, 92, 5801, 5801],
		])
	})
})

describe("dsd-fme DMR call publication does not depend on privacy prints", () => {
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["Date"] })
		vi.setSystemTime(T0)
	})
	afterEach(() => vi.useRealTimers())

	const scripts = corpus()

	it("covers the recorded and synthetic DMR corpus, privacy prints included", () => {
		expect(scripts.length).toBeGreaterThanOrEqual(20)
		expect(scripts.filter(s => hasPrivacy(s.lines)).length).toBeGreaterThan(0)
	})

	for (const script of scripts)
		it(`${script.name}: the same calls with every privacy print removed`, () => {
			const withPrivacy = calls(script.lines, script.mode)
			const without = calls(withoutPrivacy(script.lines), script.mode)
			expect(withPrivacy.starts.length).toBe(withPrivacy.ends.length)
			expect(
				withPrivacy.ends.map(e => [e.talkgroup, e.source, e.slot]),
			).toEqual(without.ends.map(e => [e.talkgroup, e.source, e.slot]))
			expect(withPrivacy.starts.length).toBe(without.starts.length)
		})
})
