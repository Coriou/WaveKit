/**
 * dsd-fme DMR clearance: a temporal oracle over the real adapter.
 *
 * Lines (modelled on dsd-fme prints, ids synthetic; the recorded fixtures
 * under tests/mocks/fixtures/recorded/dsd-fme-dmr are replayed too) go
 * through the adapter with a fake clock; every call_start, call_end and
 * voice-call publication is collected with the line sequence number it
 * followed. An independent shadow ledger, built from the raw lines only
 * (it never calls the clearance module), checks each DMR publication:
 * (a) encryptionKnown is present; (b) when it says clear, a P1/P2/P3 chain
 * of the current generation backs it, settled before the publication; (c)
 * no privacy print of the lane came before it in that chain's window; (d)
 * the settling line is a sync of the chain's own lane.
 */
import { readFileSync } from "node:fs"
import fc from "fast-check"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { DsdFmeVoiceCallState } from "../../../src/decoders/builtin/dsd-fme.js"
import type { DecoderOutput } from "../../../src/decoders/types.js"
import {
	createDecoder,
	T0,
	type CallData,
} from "./dsd-fme-call-first-helpers.js"

const TIMEOUT_MS = 4000
const RESTART = "<restart>"

type Item = [atMs: number, text: string]

const MS = (burst: string) =>
	`00:00:01 Sync: +DMR MS/DM MODE/MONO | Color Code=01 | ${burst} `
const BS = (slot: 1 | 2, burst: string) =>
	slot === 1
		? `00:00:01 Sync: +DMR  [SLOT1]  slot2  | Color Code=01 | ${burst} `
		: `00:00:01 Sync: +DMR   slot1  [SLOT2] | Color Code=01 | ${burst} `
const BRACKETLESS = (burst: string) =>
	`00:00:01 Sync: +DMR   slot1   slot2  | Color Code=01 | ${burst} `
const LC = (slot = 1, tg = 9001, src = 91, extra = "") =>
	` SLOT ${slot} TGT=${tg} SRC=${src} Group Call ${extra} `

interface Publication {
	seq: number
	kind: "call_start" | "call_end" | "voice-call"
	callId: string
	protocol: string | null | undefined
	talkgroup: number | null
	source: number | null
	slot: number | null | undefined
	encrypted: boolean
	encryptionKnown: boolean | undefined
	hasField: boolean
}

/** Replays items (10 ms steps, the 500 ms timer), recording each publication's line seq. */
function run(items: Item[]): Publication[] {
	const decoder = createDecoder({ mode: "dmr" })
	const internals = decoder as unknown as {
		handleOutputLine(line: string): void
		checkCallTimeoutAsync(): void
		endOpenCallsForRestart(now: Date): void
	}
	const pubs: Publication[] = []
	let seq = 0
	decoder.on("output", (o: DecoderOutput) => {
		if (o.type !== "call_start" && o.type !== "call_end") return
		const d = o.data as CallData & { encrypted?: boolean }
		if (d.flags?.wavFileUpdate) return
		pubs.push({
			seq,
			kind: o.type,
			callId: d.callId,
			protocol: d.protocol,
			talkgroup: d.talkgroup,
			source: d.source,
			slot: d.slot,
			encrypted:
				o.type === "call_start"
					? d.encrypted === true
					: d.flags?.encrypted === true,
			encryptionKnown: d.encryptionKnown,
			hasField: "encryptionKnown" in d,
		})
	})
	decoder.on("voice-call", (v: DsdFmeVoiceCallState) => {
		pubs.push({
			seq,
			kind: "voice-call",
			callId: v.callId,
			protocol: v.protocol,
			talkgroup: v.talkgroup,
			source: v.source,
			slot: v.slot,
			encrypted: v.encrypted,
			encryptionKnown: v.encryptionKnown,
			hasField: "encryptionKnown" in v,
		})
	})
	const sorted = items
		.map((item, index) => ({ item, index }))
		.sort((a, b) => a.item[0] - b.item[0] || a.index - b.index)
		.map(x => x.item)
	const last = sorted.at(-1)?.[0] ?? 0
	let index = 0
	for (let now = 0; now <= last + 6000; now += 10) {
		while (index < sorted.length && sorted[index]![0] <= now) {
			const [atMs, text] = sorted[index]!
			vi.setSystemTime(T0 + atMs)
			// A publication on line i follows its seq i (i + 0.25); a timer one comes after (i + 0.5).
			seq = index + 1.25
			if (text === RESTART)
				internals.endOpenCallsForRestart(new Date(T0 + atMs))
			else internals.handleOutputLine(text)
			index++
		}
		vi.setSystemTime(T0 + now)
		seq = index + 0.5
		if (now % 500 === 0) internals.checkCallTimeoutAsync()
	}
	items.splice(0, items.length, ...sorted)
	return pubs
}

// --- The shadow ledger (independent of the module under test) ---

interface Shadow {
	seq: number
	atMs: number
	lane: string
	sync: boolean
	foreign: boolean
	format: string
	kind: string
	errored: boolean
	privacy: boolean
	key: string | undefined
	plausible: boolean
	neutral: boolean
	/** A clean clear-algorithm print (P1n by ALG). */
	alg: boolean
	generation: number
	/** Bumped only by a restart or another protocol (a BS/MS change keeps the call's name). */
	hard: number
}

function shadow(items: Item[]): Shadow[] {
	let format: string | undefined
	let slot = "1"
	let mode: string | undefined
	let generation = 0
	let hard = 0
	return items.map(([atMs, text], i): Shadow => {
		const seq = i + 1
		const base = {
			seq,
			atMs,
			sync: false,
			foreign: false,
			format: "",
			kind: "",
			key: undefined,
			plausible: false,
			neutral: false,
			alg: false,
		}
		if (text === RESTART) {
			hard++
			generation++
			format = undefined
			mode = undefined
			return {
				...base,
				lane: "-",
				errored: false,
				privacy: false,
				generation,
				hard,
			}
		}
		const errored =
			!/^\s*SLCO CRC ERR\s*$/.test(text) &&
			(/\bERR\b/.test(text) ||
				/\b(?:FEC|CRC)\s+ERR\b/i.test(text) ||
				/Frame Sync Err|SYNC LOST| -RAS |Key:.*ERR/i.test(text))
		const svc = /SVC=0x([0-9A-F]+)/i.exec(text)?.[1]
		const alg = /ALG(?: ID)?:\s*(?:0x)?([0-9A-F]{2,4})/i.exec(text)?.[1]
		const keyId = /KEY ID:\s*(?:0x)?([0-9A-F]{2,4})/i.exec(text)?.[1]
		const privacy =
			/Encrypted/i.test(text) ||
			(svc !== undefined && (parseInt(svc, 16) & 0x40) !== 0) ||
			(alg !== undefined && ![0, 0x80].includes(parseInt(alg, 16))) ||
			(keyId !== undefined && parseInt(keyId, 16) !== 0)
		const sync = /Sync:\s*[+-]?(?!no\b)(\w+)/i.exec(text)
		if (sync) {
			if (sync[1]!.toUpperCase() !== "DMR") {
				hard++
				generation++
				format = undefined
				mode = undefined
				return {
					...base,
					lane: "-",
					sync: true,
					foreign: true,
					errored,
					privacy,
					generation,
					hard,
				}
			}
			const bracket = /\[slot([12])\]/i.exec(text)?.[1]
			format = bracket ? "bs" : /MS\/DM/.test(text) ? "ms" : "x"
			if (bracket) slot = bracket
			if (format !== "x") {
				if (mode !== undefined && mode !== format) generation++
				mode = format
			}
			const b = /\|\s*(VLC|VC[1-6*]|TLC)/.exec(text)?.[1]
			const kind = !text.includes("|")
				? "bare"
				: b === undefined
					? "other"
					: b === "VLC"
						? "vlc"
						: b === "TLC"
							? "tlc"
							: "voice"
			return {
				...base,
				lane: format === "bs" ? slot : format,
				sync: true,
				format,
				kind,
				errored,
				privacy,
				generation,
				hard,
			}
		}
		const printed = /\bSLOT\s+([12])\b/i.exec(text)?.[1]
		const lane =
			format === "bs" ? (printed ?? slot) : format === "ms" ? "ms" : "x"
		const ids = /TGT[:=]\s*(\d+)\b.*SRC[:=]\s*(\d+)/i.exec(text) ?? undefined
		const tg = Number(ids?.[1] ?? 0)
		const src = Number(ids?.[2] ?? 0)
		const flco = /FLCO=0x([0-9A-F]+)/i.exec(text)?.[1]
		const fid = /FID=0x([0-9A-F]+)/i.exec(text)?.[1]
		const plausible =
			tg >= 1 &&
			tg <= 0xffffff &&
			src >= 1 &&
			src <= 0xffffff - 800 &&
			(flco === undefined || [0, 3].includes(parseInt(flco, 16))) &&
			(fid === undefined || parseInt(fid, 16) === 0)
		const neutral =
			!errored &&
			!privacy &&
			/^\s*$|^\s*SLCO CRC ERR\s*$|^\s*SLCO NULL\b|^\s*Activity Update\b|^\s*DMR PDU Payload\b|^\s*SLCO Completed Block\b|^\s*SB: |^\s*AMBE /.test(
				text,
			)
		return {
			...base,
			lane,
			key: ids ? `${tg}/${src}` : undefined,
			alg:
				!ids &&
				!errored &&
				!privacy &&
				/ALG(?: ID)?:\s*(?:0x)?(?:00|80)\b/i.test(text),
			plausible,
			neutral,
			errored,
			privacy,
			generation,
			hard,
		}
	})
}

/** Whether a clear publication P of key K is backed by a settled chain (checks b, c, d). */
function backed(lines: Shadow[], p: Publication): boolean {
	const key =
		p.talkgroup === null || p.source === null
			? undefined
			: `${p.talkgroup}/${p.source}`
	// A call ended by a protocol switch or a restart publishes its end on
	// that line: it belongs to the generation before it.
	const atLine = lines[Math.min(Math.floor(p.seq), lines.length) - 1]
	const boundary = atLine !== undefined && atLine.lane === "-"
	const genAt =
		(boundary ? lines[atLine.seq - 2]?.generation : atLine?.generation) ?? 0
	const lanes =
		p.slot === 1 || p.slot === 2 ? [String(p.slot), "ms"] : ["ms", "1", "2"]
	for (const l of lines) {
		if (l.seq >= p.seq) break
		if (
			l.sync ||
			l.errored ||
			l.privacy ||
			(!l.alg && (key === undefined || l.key !== key || !l.plausible)) ||
			l.generation !== genAt ||
			!lanes.includes(l.lane)
		)
			continue
		const lane = lines.filter(x => x.lane === l.lane && x.generation === genAt)
		const s = [...lane].reverse().find(x => x.sync && x.seq < l.seq)
		const t = lane.find(x => x.sync && x.seq > l.seq)
		if (s === undefined || t === undefined || t.seq >= p.seq) continue
		if (
			s.errored ||
			!(l.alg ? ["vlc", "voice", "other"] : ["vlc", "voice", "tlc"]).includes(
				s.kind,
			)
		)
			continue
		// The burst's first link control.
		if (lane.some(x => x.key !== undefined && x.seq > s.seq && x.seq < l.seq))
			continue
		if (t.errored || t.privacy || t.format !== s.format) continue
		if (t.atMs - l.atMs > TIMEOUT_MS) continue
		if (s.kind === "vlc" && t.kind !== "voice" && t.kind !== "vlc") continue
		// P3 needs the call named by an earlier link control of its key (P1n
		// lets the first LC after voice name and prove a frames call).
		if (
			s.kind === "tlc" &&
			!lines.some(
				x =>
					x.lane === l.lane &&
					x.hard === l.hard &&
					x.key === key &&
					!x.errored &&
					x.seq < s.seq,
			)
		)
			continue
		const between = lines.filter(x => x.seq > s.seq && x.seq < t.seq)
		if (between.some(x => (x.lane === l.lane || x.lane === "x") && x.errored))
			continue
		if (
			between.some(
				x => x.lane === l.lane && x.seq > l.seq && !x.sync && !x.neutral,
			)
		)
			continue
		// (c) no privacy print of the lane (or an unplaced one) since the chain began.
		const window = lines.filter(
			x =>
				x.seq >= s.seq &&
				x.seq < p.seq &&
				(x.lane === l.lane || x.lane === "x"),
		)
		if (window.some(x => x.privacy)) continue
		// No checked rival copy after a voice burst between the proof and P.
		let afterVoice = false
		let rival = false
		for (const x of lines) {
			if (x.seq <= l.seq || x.seq >= p.seq || x.lane !== l.lane) continue
			if (x.sync) afterVoice = x.kind === "voice"
			else if (
				afterVoice &&
				x.key !== undefined &&
				x.key !== key &&
				!x.errored &&
				x.plausible
			)
				rival = true
		}
		if (rival) continue
		return true
	}
	return false
}

/** Checks (a)-(d) on every DMR publication; returns the failures. */
function oracle(items: Item[], pubs: Publication[]): string[] {
	const lines = shadow(items)
	const failures: string[] = []
	for (const p of pubs) {
		if (p.protocol !== "dmr") continue
		if (!p.hasField || typeof p.encryptionKnown !== "boolean")
			failures.push(`(a) ${p.kind} at ${p.seq} omits encryptionKnown`)
		// I1: clear (encrypted === false && encryptionKnown !== false) requires
		// evidence; encrypted with encryptionKnown true is known encrypted.
		const clear = !p.encrypted && p.encryptionKnown !== false
		if (clear && !backed(lines, p))
			failures.push(`(b-d) ${p.kind} at ${p.seq} clear without a settled chain`)
	}
	return failures
}

/** No publication from line `fromSeq` on is clear, and the oracle holds. */
function expectNotClearFrom(items: Item[], fromSeq: number): void {
	const pubs = run(items)
	const after = pubs.filter(p => p.protocol === "dmr" && p.seq >= fromSeq)
	expect(after.some(p => !p.encrypted && p.encryptionKnown !== false)).toBe(
		false,
	)
	expect(oracle(items, pubs)).toEqual([])
}

/** No publication is clear (or omits the field), and the oracle holds. */
function expectNeverClear(items: Item[]): Publication[] {
	const pubs = run(items)
	const dmr = pubs.filter(p => p.protocol === "dmr")
	expect(dmr.every(p => p.hasField)).toBe(true)
	expect(dmr.some(p => !p.encrypted && p.encryptionKnown !== false)).toBe(false)
	expect(oracle(items, pubs)).toEqual([])
	return pubs
}

const everClear = (pubs: Publication[]) =>
	pubs.some(
		p => p.protocol === "dmr" && !p.encrypted && p.encryptionKnown === true,
	)

/** A repeater call already named: VC1, VC2 with its LC, VC3 (shifted repro after it). */
const NAMED_BS: Item[] = [
	[0, BS(1, "VC1")],
	[60, BS(1, "VC2")],
	// The naming LC would be the call's P1n proof; its burst's late error kills it.
	[61, LC()],
	[62, " (FEC ERR) "],
	[120, BS(1, "VC3")],
]

/** The bypass shapes as generator templates (times relative, ids 9001/91 replaced). */
const SHAPES: Item[][] = [
	[
		[0, MS("VLC")],
		[1, LC()],
		[110, " SLCO NULL "],
		[120, " (FEC ERR) "],
		[180, MS("VC*")],
	],
	[
		[0, "Sync: +DMR"],
		[1, LC()],
		[110, " SLCO NULL "],
		[120, MS("IDLE")],
	],
	[
		[0, MS("VLC")],
		[10, "Sync: +DSTAR VOICE"],
		[20, "Sync: +DMR"],
		[21, LC()],
		[130, MS("VC*")],
	],
	[
		[0, MS("VC*")],
		[360, MS("VC*")],
		[370, LC()],
		[380, " Channel Timing CSBK (CT_CSBK) "],
		[420, MS("TLC")],
		[421, LC()],
		[480, BRACKETLESS("IDLE")],
	],
	[
		[0, BS(1, "VC1")],
		[60, BS(1, "VC2")],
		[120, BS(1, "TLC  (FEC ERR)")],
		[121, LC()],
		[180, BS(1, "IDLE")],
	],
	[
		...NAMED_BS,
		[180, BS(1, "VC4  (FEC ERR)")],
		[181, LC()],
		[240, BS(1, "VC5")],
	],
	[
		...NAMED_BS,
		[180, BS(1, "VC4")],
		[181, LC()],
		[182, " AMBE 01 err = [0] [0] (FEC ERR)"],
		[240, BS(1, "VC5")],
	],
	[
		...NAMED_BS,
		[180, BS(1, "VC4")],
		[181, LC()],
		[240, BS(1, "VC5")],
		[260, LC(1, 9001, 91, "Encrypted (CRC ERR)")],
		[300, BS(1, "VC6")],
	],
	[
		...NAMED_BS,
		[121, LC(1, 9002, 92, "Encrypted")],
		[180, BS(1, "VC4")],
		[181, LC()],
		[240, BS(1, "VC5")],
	],
	[
		...NAMED_BS,
		[180, BS(1, "VC4")],
		[181, " SLOT 1 TGT=9001 SRC=91 SVC=0x40 Group Call  "],
		[240, BS(1, "VC5")],
	],
	[
		[0, MS("VC*")],
		[360, MS("VC*")],
		[361, LC()],
		[720, MS("VC*")],
		[721, LC()],
		[722, BRACKETLESS("VC3  (FEC ERR)")],
		[1080, MS("VC*")],
	],
]

describe("dsd-fme DMR clearance oracle", () => {
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["Date"] })
		vi.setSystemTime(T0)
	})
	afterEach(() => {
		vi.useRealTimers()
	})

	describe("the oracle has teeth", () => {
		it("accepts a header call settled by its voice, and a named call proven by its own LC", () => {
			const header: Item[] = [
				[0, MS("VLC")],
				[1, LC()],
				[60, MS("VC*")],
				[420, MS("VC*")],
				[780, MS("TLC")],
			]
			const pubs = run(header)
			expect(everClear(pubs)).toBe(true)
			expect(oracle(header, pubs)).toEqual([])
			const named: Item[] = [
				...NAMED_BS,
				[180, BS(1, "VC4")],
				[181, LC()],
				[240, BS(1, "VC5")],
			]
			const named2 = run(named)
			expect(everClear(named2)).toBe(true)
			expect(oracle(named, named2)).toEqual([])
		})

		it("rejects a clear publication with no chain", () => {
			const items: Item[] = [[0, MS("VC*")]]
			const lines = shadow(items)
			expect(
				backed(lines, {
					seq: 2,
					kind: "voice-call",
					callId: "x",
					protocol: "dmr",
					talkgroup: 9001,
					source: 91,
					slot: 1,
					encrypted: false,
					encryptionKnown: true,
					hasField: true,
				}),
			).toBe(false)
		})
	})

	describe("bypass shapes never publish clear", () => {
		it("a direct header, its LC, an empty short LC, then a late FEC error in the header burst", () => {
			const shape: Item[] = [
				[0, MS("VLC")],
				[1, LC()],
				[110, " SLCO NULL "],
				[120, " (FEC ERR) "],
				[180, MS("VC*")],
				[540, MS("VC*")],
			]
			expectNeverClear(shape)
			// Without the late error the header call settles on its voice (P2).
			expect(everClear(run(shape.filter(([, t]) => !t.includes("FEC"))))).toBe(
				true,
			)
		})

		it("a bare DMR sync, an LC, an empty short LC and a direct idle burst", () => {
			expectNeverClear([
				[0, "Sync: +DMR"],
				[1, LC()],
				[110, " SLCO NULL "],
				[120, MS("IDLE")],
			])
			// Likewise a first "DMR Voice" print after a restart.
			expectNeverClear([
				[0, MS("VC*")],
				[360, MS("VC*")],
				[400, RESTART],
				[410, " DMR Voice TGT: 9001; SRC: 91; "],
				[420, MS("VC*")],
				[780, MS("VC*")],
			])
		})

		it("a direct header, a D-STAR sync, a bare DMR sync, then the LC", () => {
			expectNeverClear([
				[0, MS("VLC")],
				[10, "Sync: +DSTAR VOICE"],
				[20, "Sync: +DMR"],
				[21, LC()],
				[130, " SLCO NULL "],
				[140, MS("VC*")],
			])
		})

		it("two direct voice bursts, a call timeout, then an LC and an idle burst", () => {
			expectNeverClear([
				[0, MS("VC*")],
				[360, MS("VC*")],
				[5000, " SLCO NULL "],
				[5010, LC()],
				[5120, " SLCO NULL "],
				[5130, MS("IDLE")],
			])
		})

		it("a CSBK print after the LC, then the terminator and its trailer closed by another protocol or a bracketless line", () => {
			for (const close of ["Sync: +DSTAR VOICE", BRACKETLESS("IDLE")])
				expectNeverClear([
					[0, MS("VC*")],
					[360, MS("VC*")],
					[370, LC()],
					[380, " Channel Timing CSBK (CT_CSBK) "],
					[420, MS("TLC")],
					[421, LC()],
					[480, close],
				])
		})

		it("an unnamed repeater call whose dirty terminator's trailer names it", () => {
			expectNeverClear([
				[0, BS(1, "VC1")],
				[60, BS(1, "VC2")],
				[120, BS(1, "TLC  (FEC ERR)")],
				[121, LC()],
				[180, BS(1, "IDLE")],
			])
		})

		it("an error line in the voice burst before its LC", () => {
			const shape = (error: boolean): Item[] => [
				...NAMED_BS,
				[180, BS(1, "VC4")],
				...(error ? ([[181, " (FEC ERR) "]] as Item[]) : []),
				[182, LC()],
				[240, BS(1, "VC5")],
			]
			expectNeverClear(shape(true))
			expect(everClear(run(shape(false)))).toBe(true)
			// The exact short shape (an unnamed call) never clears either.
			expectNeverClear([
				[0, BS(1, "VC1")],
				[60, BS(1, "VC2")],
				[120, " (FEC ERR) "],
				[121, LC()],
				[180, BS(1, "VC3")],
			])
		})

		it("a voice burst whose own sync printed an error, then a clean LC", () => {
			expectNeverClear([
				...NAMED_BS,
				[180, BS(1, "VC4  (FEC ERR)")],
				[181, LC()],
				[240, BS(1, "VC5")],
			])
		})

		it("an AMBE print carrying an error between the LC and its settling sync", () => {
			expectNeverClear([
				...NAMED_BS,
				[180, BS(1, "VC4")],
				[181, LC()],
				[182, " AMBE 0123ABCD err = [0] [0] (FEC ERR)"],
				[240, BS(1, "VC5")],
			])
		})

		it("a proven clear call, then an encrypted LC that failed its CRC", () => {
			const pubs = run([
				...NAMED_BS,
				[180, BS(1, "VC4")],
				[181, LC()],
				[240, BS(1, "VC5")],
				[260, LC(1, 9001, 91, "Encrypted (CRC ERR)")],
				[300, BS(1, "VC6")],
				[301, LC()],
				[360, BS(1, "VC1")],
			])
			const after = pubs.filter(p => p.seq >= 10 && p.protocol === "dmr")
			expect(after.length).toBeGreaterThan(0)
			expect(after.every(p => p.encrypted || p.encryptionKnown === false)).toBe(
				true,
			)
			// The exact short shape: its naming LC is its P1n proof (clear at
			// VC3), and the encrypted print ends that for good (line 5 on).
			expectNotClearFrom(
				[
					[0, BS(1, "VC1")],
					[60, BS(1, "VC2")],
					[61, LC()],
					[180, BS(1, "VC3")],
					[200, LC(1, 9001, 91, "Encrypted (CRC ERR)")],
					[240, BS(1, "VC4")],
				],
				5,
			)
		})

		it("a frames call's naming LC with a bogus id and a late error line never clears", () => {
			expectNeverClear([
				[0, BS(1, "VC1")],
				[60, BS(1, "VC2")],
				[61, LC(1, 7_654_321, 1_234_567)],
				[62, " SLOT 1 SB/RC (FEC ERR) E:4; I:00000000 D:000;  "],
				[120, BS(1, "VC3")],
				[180, BS(1, "VC4")],
			])
		})

		it("a frames call's naming LC followed by an encrypted print never clears", () => {
			for (const print of [
				" Slot 1 DMR PI H- ALG ID: 21; KEY ID: 01;",
				LC(1, 9001, 91, "Encrypted"),
				" SLOT 1 TGT=9001 SRC=91 SVC=0x40 Group Call  ",
			])
				expectNeverClear([
					[0, BS(1, "VC1")],
					[60, BS(1, "VC2")],
					[61, LC()],
					[62, print],
					[120, BS(1, "VC3")],
					[180, BS(1, "VC4")],
				])
		})

		it("a frames call is clear from its first clean voice LC (P1n) or a clear ALG print", () => {
			for (const proof of [LC(), " Slot 1 DMR PI H- ALG ID: 00; KEY ID: 00;"]) {
				const items: Item[] = [
					[0, BS(1, "VC1")],
					[60, BS(1, "VC2")],
					[61, proof],
					// Enough frames for an unnamed call's evidence (>= 630 ms).
					...[3, 4, 5, 6, 1, 2, 3, 4, 5, 6, 1, 2].map(
						(n, i): Item => [120 + i * 60, BS(1, `VC${n}`)],
					),
				]
				const pubs = run(items)
				expect(everClear(pubs)).toBe(true)
				expect(oracle(items, pubs)).toEqual([])
			}
		})

		it("a PI header, then an encrypted LC", () => {
			expectNeverClear([
				...NAMED_BS,
				[180, BS(1, "PI ")],
				[181, LC(1, 9001, 91, "Encrypted")],
				[240, BS(1, "VC4")],
				[241, LC()],
				[300, BS(1, "VC5")],
			])
		})

		it("another talker's encrypted LC, then the call's own LC and voice", () => {
			expectNeverClear([
				...NAMED_BS,
				[121, LC(1, 9002, 92, "Encrypted")],
				[180, BS(1, "VC4")],
				[181, LC()],
				[240, BS(1, "VC5")],
				[241, LC()],
				[300, BS(1, "VC6")],
			])
		})

		it("an LC with only the SVC privacy bit", () => {
			const svc = " SLOT 1 TGT=9001 SRC=91 SVC=0x40 Group Call  "
			expectNeverClear([
				...NAMED_BS,
				[180, BS(1, "VC4")],
				[181, svc],
				[240, BS(1, "VC5")],
				[241, LC()],
				[300, BS(1, "VC6")],
			])
		})

		it("a direct call's LC, then a bracketless repeater burst with an error, then direct voice", () => {
			const shape = (bracketless: string | null): Item[] => [
				[0, MS("VC*")],
				[360, MS("VC*")],
				[361, LC()],
				// Kills the naming LC's own P1n proof: the LC at 721 is the proof.
				[362, " (FEC ERR) "],
				[720, MS("VC*")],
				[721, LC()],
				...(bracketless ? ([[722, bracketless]] as Item[]) : []),
				[1080, MS("VC*")],
			]
			expectNeverClear(shape(BRACKETLESS("VC3  (FEC ERR)")))
			expect(everClear(run(shape(null)))).toBe(true)
			expectNeverClear([
				[0, MS("VC*")],
				[360, MS("VC*")],
				[361, LC()],
				[362, BRACKETLESS("VC3  (FEC ERR)")],
				[480, MS("VC*")],
			])
		})
	})

	describe("recorded fixtures", () => {
		for (const name of [
			"rep-train",
			"rep-two-slot",
			"rep-bogus-id",
			"rep-false-lc-flco",
			"direct-keyup",
			"direct-e4",
		])
			it(`${name} replays with every publication explicit and every clear one backed`, () => {
				const items = fixtureItems(name)
				expect(oracle(items, run(items))).toEqual([])
			})
	})

	it("property: every DMR publication carries encryptionKnown and every clear one has a settled chain", () => {
		// Feature: dmr-clearance, Property 1: known clear only on a settled proof of its own generation
		// Validates: spec invariants I1-I7 (bypass shapes, protocol switches, restarts, timeouts, clumps, BS/MS mixes)
		const ids = fc.constantFrom<[number, number]>(
			[9001, 91],
			[9002, 92],
			[16_777_215, 16_776_415],
			[16_777_216, 91],
		)
		const slot = fc.constantFrom<1 | 2>(1, 2)
		const voice = (s: 1 | 2, n: number) => BS(s, `VC${(n % 6) + 1}`)
		const segment = fc.oneof(
			fc.record({
				k: fc.constant("bsVoice" as const),
				s: slot,
				n: fc.integer({ min: 1, max: 7 }),
			}),
			fc.record({
				k: fc.constant("msVoice" as const),
				n: fc.integer({ min: 1, max: 4 }),
			}),
			fc.record({
				k: fc.constant("lc" as const),
				s: slot,
				id: ids,
				extra: fc.constantFrom(
					"",
					"(CRC ERR)",
					"Encrypted",
					"SVC=0x40",
					"FLCO=0x28 FID=0x00 SVC=0x10",
					"FLCO=0x00 FID=0x00 SVC=0x00",
				),
			}),
			fc.record({
				k: fc.constant("header" as const),
				s: slot,
				ms: fc.boolean(),
				dirty: fc.boolean(),
				id: ids,
			}),
			fc.record({
				k: fc.constant("tlc" as const),
				s: slot,
				ms: fc.boolean(),
				dirty: fc.boolean(),
				id: ids,
				train: fc.integer({ min: 0, max: 4 }),
			}),
			fc.record({
				k: fc.constant("noise" as const),
				line: fc.constantFrom(
					" SLCO CRC ERR",
					" SLCO NULL ",
					" Activity Update TS1: Group Voice; Hash: 1; TS2: Idle; Hash: 0;",
					" AMBE 0123 err = [0] [0] ",
					" AMBE 0123 err = [0] [0] (FEC ERR)",
					" (FEC ERR) ",
					" Channel Timing CSBK (CT_CSBK) ",
					" ALG ID: 00;",
					" Slot 1 DMR PI H- ALG ID: 21; KEY ID: 01;",
					"Sync: no sync",
					"",
					BRACKETLESS("IDLE"),
					BRACKETLESS("VC3  (FEC ERR)"),
					"00:00:01 Sync:  DMR                  | VOICE CACH/EMB ERR",
					"00:00:01 Sync:  DMR   slot1  [SLOT2] | Frame Sync Err: 7",
					BS(1, "IDLE"),
					BS(2, "IDLE"),
					MS("CSBK"),
					MS("CACH/Burst FEC ERR"),
					" DMR Voice TGT: 9001; SRC: 91; ",
					"Sync: +DMR",
				),
			}),
			fc.record({
				k: fc.constant("foreign" as const),
				line: fc.constantFrom(
					"Sync: +DSTAR VOICE",
					"Sync: +P25p1 NAC: 293 duid:LDU1",
					"Sync: +NXDN48 VOICE",
				),
			}),
			fc.record({ k: fc.constant("restart" as const) }),
			fc.record({
				k: fc.constant("gap" as const),
				ms: fc.integer({ min: 4000, max: 6000 }),
			}),
			fc.record({
				k: fc.constant("shape" as const),
				i: fc.integer({ min: 0, max: SHAPES.length - 1 }),
				id: ids,
			}),
		)
		fc.assert(
			fc.property(
				fc.array(
					fc.record({
						seg: segment,
						jitter: fc.integer({ min: 0, max: 340 }),
						clump: fc.boolean(),
					}),
					{ minLength: 1, maxLength: 40 },
				),
				steps => {
					vi.setSystemTime(T0)
					const items: Item[] = []
					let t = 0
					const push = (text: string, step = 60) => {
						items.push([t, text])
						t += step
					}
					for (const { seg, jitter, clump } of steps) {
						t += clump ? 0 : jitter
						switch (seg.k) {
							case "bsVoice":
								for (let i = 0; i < seg.n; i++) push(voice(seg.s, i))
								break
							case "msVoice":
								for (let i = 0; i < seg.n; i++) push(MS("VC*"), 360)
								break
							case "lc":
								push(LC(seg.s, seg.id[0], seg.id[1], seg.extra), 1)
								break
							case "header":
								push(
									seg.ms
										? MS(`VLC${seg.dirty ? "  (FEC ERR)" : ""}`)
										: BS(seg.s, `VLC${seg.dirty ? "  (FEC ERR)" : ""}`),
									1,
								)
								push(LC(seg.s, seg.id[0], seg.id[1]))
								break
							case "tlc":
								for (let i = 0; i <= seg.train; i++) {
									push(
										seg.ms
											? MS(`TLC${seg.dirty ? "  (FEC ERR)" : ""}`)
											: BS(seg.s, `TLC${seg.dirty ? "  (FEC ERR)" : ""}`),
										1,
									)
									push(LC(seg.s, seg.id[0], seg.id[1]), 104)
								}
								break
							case "noise":
								push(seg.line, 1)
								break
							case "foreign":
								push(seg.line, 1)
								break
							case "restart":
								push(RESTART, 1)
								break
							case "gap":
								t += seg.ms
								break
							case "shape": {
								const from = t
								for (const [at, text] of SHAPES[seg.i]!) {
									items.push([
										from + at,
										text.replace(
											"TGT=9001 SRC=91",
											`TGT=${seg.id[0]} SRC=${seg.id[1]}`,
										),
									])
									t = from + at + 1
								}
								break
							}
						}
					}
					const pubs = run(items)
					expect(oracle(items, pubs)).toEqual([])
				},
			),
			{ numRuns: 200, seed: 20261117 },
		)
		// 200 replays of up to 40 segments each (a few seconds on a loaded host).
	}, 120_000)
})

/** A recorded fixture as items (arrival ms and line, ANSI codes kept). */
function fixtureItems(name: string): Item[] {
	return readFileSync(
		`tests/mocks/fixtures/recorded/dsd-fme-dmr/${name}.txt`,
		"utf8",
	)
		.split("\n")
		.filter(line => line !== "" && !line.startsWith("#"))
		.map((line): Item => {
			const tab = line.indexOf("\t")
			return [
				Number(line.slice(0, tab)),
				line.slice(tab + 1).replace(/\x1b\[[0-9;]*m/g, ""),
			]
		})
}
