/**
 * dsd-fme DMR: every call publishes (call_start / call_end with TGT/SRC,
 * slot and timing) whatever its trust; the DMR clearance only sets the
 * encrypted / encryptionKnown fields and recording admission.
 *
 * - Shapes modelled (shape from a private capture; ids, times and colour
 *   codes synthetic) on the WG25 image acceptance replay: a repeater over
 *   dsd-fme decoded only as its terminator train (TLC + LC pairs) with one
 *   `PI (CRC ERR)` burst of the other slot; a direct capture opening on the
 *   end of a transmission (two errored voice bursts, TLC + LC); a direct
 *   over whose last burst and terminator name the next talker.
 * - Privacy independence: every recorded and synthetic DMR script, and the
 *   cases here, publish the same calls (count, IDs, slot) with every privacy
 *   print removed (PI bursts, ALG / KEY ID prints, the Encrypted word and
 *   the SVC privacy bit of a link control).
 */
import { readdirSync, readFileSync } from "node:fs"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
	at,
	createDecoder,
	replay,
	T0,
	type CallData,
	type Line,
} from "./dsd-fme-call-first-helpers.js"

const BS = (slot: 1 | 2, burst: string, cc = "01") =>
	slot === 1
		? `03:04:05 Sync: +DMR  [slot1]  slot2  | Color Code=${cc} | ${burst} `
		: `03:04:05 Sync: +DMR   slot1  [slot2] | Color Code=${cc} | ${burst} `
const MS = (burst: string, cc = "11") =>
	`03:04:05 Sync: +DMR MS/DM MODE/MONO | Color Code=${cc} | ${burst} `
const LC = (tg: number, src: number, kind = "Group Call") =>
	` SLOT 1 TGT=${tg} SRC=${src} ${kind} `
const FLCO_FEC = " SLOT 1 FLCO FEC ERR  (FEC ERR)"
const SLCO_CRC = " SLCO CRC ERR"
const CSBK = " Channel Timing CSBK (CT_CSBK) "
const NO_SYNC = "Sync: no sync"

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

/**
 * Modelled on 100041 (private repeater capture): slot 1's terminator train
 * of one talker, slot 2 idle, one PI burst of slot 2 with a CRC error, no
 * voice burst decoded.
 */
function repeaterTrain(from: number, tg = 9001, src = 91): Line[] {
	const lines: Line[] = [
		[from, BS(2, "PI  \x1b[31m (CRC ERR) \x1b[0m", "00")],
		[from + 1, BS(2, "IDLE")],
	]
	for (let i = 0; i < 6; i++) {
		const t = from + 300 + i * 120
		lines.push([t, BS(1, "TLC")], [t + 1, LC(tg, src)], [t + 2, SLCO_CRC])
		lines.push([t + 60, BS(2, "IDLE")])
	}
	lines.push([from + 1100, NO_SYNC])
	return lines
}

/**
 * Modelled on 090127 (private direct capture): the capture opens on the end
 * of one transmission (two voice bursts whose link control failed, its
 * terminator and link control), then another talker's whole over.
 */
function directCutStart(): Line[] {
	return [
		[0, MS("VC*", "15")],
		[1, FLCO_FEC],
		[60, MS("VC*", "10")],
		[61, FLCO_FEC],
		[120, MS("TLC")],
		[121, LC(9001, 91)],
		[180, MS("CSBK")],
		[181, CSBK],
		[200, NO_SYNC],
		[1000, MS("CACH/Burst FEC ERR", "15")],
		[1060, MS("VLC", "15")],
		[1061, LC(9002, 92)],
		[1120, MS("VC*")],
		[1121, LC(9002, 92)],
		[1480, MS("VC*")],
		[1481, LC(9002, 92)],
		[1840, MS("TLC")],
		[1841, LC(9002, 92)],
		[1900, MS("CSBK")],
		[1901, CSBK],
		[1920, NO_SYNC],
	]
}

/**
 * Modelled on 091133 (private direct capture): one talker's over (header,
 * voice, a failed link control), then a voice burst and the terminator both
 * naming another talker (two agreeing copies) with no gap between them.
 */
function directNextTalker(): Line[] {
	const lines: Line[] = [
		[0, MS("CACH/Burst FEC ERR")],
		[60, MS("VLC")],
		[61, LC(9001, 91)],
	]
	for (let i = 0; i < 4; i++) {
		const t = 120 + i * 360
		lines.push([t, MS("VC*")], [t + 1, i === 3 ? FLCO_FEC : LC(9001, 91)])
	}
	lines.push(
		[1560, MS("VC*")],
		[1561, LC(9002, 92)],
		[1620, MS("TLC")],
		[1621, LC(9002, 92)],
		[1680, MS("CSBK")],
		[1681, CSBK],
		[1700, NO_SYNC],
	)
	return lines
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

/** Every DMR line script of the repository: recorded excerpts and synthetic captures. */
function corpus(): { name: string; mode: string; lines: Line[] }[] {
	const out: { name: string; mode: string; lines: Line[] }[] = []
	const tabbed = (path: string): Line[] =>
		readFileSync(path, "utf8")
			.split("\n")
			.filter(line => line !== "" && !line.startsWith("#"))
			.map((line): Line => {
				const tab = line.indexOf("\t")
				return [Number(line.slice(0, tab)), line.slice(tab + 1)]
			})
	const recorded = "tests/mocks/fixtures/recorded/dsd-fme-dmr"
	for (const file of readdirSync(recorded).filter(f => f.endsWith(".txt")))
		out.push({
			name: file,
			mode: "auto",
			lines: tabbed(`${recorded}/${file}`),
		})
	for (const file of ["dmr-ms-two-ptt.txt", "dmr-bs-checked-csbk.txt"])
		out.push({
			name: file,
			mode: "auto",
			lines: tabbed(`tests/mocks/fixtures/dsd-fme/${file}`),
		})
	const synthetic = "tests/mocks/fixtures/synthetic"
	for (const file of readdirSync(synthetic).filter(f =>
		/^dv-latency-dmr-.*\.json$/.test(f),
	)) {
		const json = JSON.parse(readFileSync(`${synthetic}/${file}`, "utf8")) as {
			lines: { atMs: number; text: string }[]
		}
		out.push({
			name: file,
			mode: "auto",
			lines: json.lines.map((l): Line => [Math.round(l.atMs), l.text]),
		})
	}
	out.push(
		{
			name: "modelled repeater train",
			mode: "auto",
			lines: repeaterTrain(1000),
		},
		{
			name: "modelled direct cut start",
			mode: "auto",
			lines: directCutStart(),
		},
		{
			name: "modelled direct next talker",
			mode: "auto",
			lines: directNextTalker(),
		},
	)
	return out
}

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
