/**
 * dsd-fme DMR clearance: the named bypass shapes, each a timed line script
 * replayed through the real adapter, every DMR publication (call_start,
 * call_end, voice-call) judged at its emission by an independent per-call
 * oracle (./dsd-fme-dmr-call-oracle.ts, which shares no code with the
 * clearance module). A publication may say clear (encrypted false,
 * encryptionKnown not false) only when the oracle authorizes it there.
 * Shapes that forge a clear publication assert the oracle rejects it.
 * Ids are synthetic.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { DsdFmeVoiceCallState } from "../../../src/decoders/builtin/dsd-fme.js"
import type { DecoderOutput } from "../../../src/decoders/types.js"
import {
	createDecoder,
	T0,
	type CallData,
} from "./dsd-fme-call-first-helpers.js"
import {
	CallOracle,
	RESTART_LINE,
	type Claim,
} from "./dsd-fme-dmr-call-oracle.js"

type Item = [atMs: number, text: string]

const M = (k: string) =>
	`00:00:01 Sync: +DMR MS/DM MODE/MONO | Color Code=01 | ${k} `
const B1 = (k: string) =>
	`00:00:01 Sync: +DMR  [SLOT1]  slot2  | Color Code=01 | ${k} `
const B2 = (k: string) =>
	`00:00:01 Sync: +DMR   slot1  [SLOT2] | Color Code=01 | ${k} `
const X = (k: string) =>
	`00:00:01 Sync: +DMR   slot1   slot2  | Color Code=01 | ${k} `
const LC = (extra = "", tg = 9001, src = 91, slot = 1) =>
	` SLOT ${slot} TGT=${tg} SRC=${src} Group Call ${extra} `
const BARE = "00:00:01 Sync: +DMR "
const DSTAR = "00:00:01 Sync: +DSTAR VOICE "
const DMR_VOICE = " DMR Voice TGT: 9001; SRC: 91; "
const SLCO_NULL = " SLCO NULL "
const FEC = " (FEC ERR) "
const CSBK = " Channel Timing CSBK (CT_CSBK) "

interface Pub extends Claim {
	kind: "call_start" | "call_end" | "voice-call"
	slot: number | null | undefined
	verdict: string | null
}

interface Trace {
	pubs: Pub[]
	violations: string[]
	oracle: CallOracle
	lines: number
}

/** Replays items (10 ms steps, the 500 ms timer) and judges each publication inside its emit. */
function replay(items: Item[]): Trace {
	const decoder = createDecoder({ mode: "dmr" })
	const internals = decoder as unknown as {
		handleOutputLine(line: string): void
		checkCallTimeoutAsync(): void
		endOpenCallsForRestart?: (now: Date) => void
		laneKey: number
		callState: { callId: string } | null
		startPendingCall(...args: unknown[]): { callId: string }
		endCall(...args: unknown[]): DecoderOutput | null
	}
	const oracle = new CallOracle()
	let seq = 0
	const start = internals.startPendingCall.bind(internals)
	vi.spyOn(internals, "startPendingCall").mockImplementation((...args) => {
		const call = start(...args)
		oracle.born(call.callId, seq, internals.laneKey)
		return call
	})
	const end = internals.endCall.bind(internals)
	vi.spyOn(internals, "endCall").mockImplementation((...args) => {
		const call = internals.callState
		if (call) oracle.ended(call.callId, seq)
		return end(...args)
	})
	const pubs: Pub[] = []
	const violations: string[] = []
	const judge = (pub: Omit<Pub, "verdict">) => {
		const verdict = oracle.judge(pub)
		pubs.push({ ...pub, verdict })
		if (verdict !== null)
			violations.push(`${pub.kind} at ${pub.seq}: ${verdict}`)
	}
	decoder.on("output", (o: DecoderOutput) => {
		if (o.type !== "call_start" && o.type !== "call_end") return
		const d = o.data as CallData & { encrypted?: boolean }
		if (d.protocol !== "dmr") return
		judge({
			kind: o.type,
			callId: d.callId,
			seq,
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
		if (v.protocol !== "dmr") return
		judge({
			kind: "voice-call",
			callId: v.callId,
			seq,
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
			oracle.line(index + 1, atMs, text)
			// Publications on line i carry seq i + 0.25; timer ones i + 0.5.
			seq = index + 1.25
			if (text === RESTART_LINE) {
				expect(typeof internals.endOpenCallsForRestart).toBe("function")
				internals.endOpenCallsForRestart!(new Date(T0 + atMs))
			} else internals.handleOutputLine(text)
			index++
		}
		vi.setSystemTime(T0 + now)
		seq = index + 0.5
		if (now % 500 === 0) internals.checkCallTimeoutAsync()
	}
	return { pubs, violations, oracle, lines: sorted.length }
}

const clear = (p: Pub) => !p.encrypted && p.encryptionKnown !== false

/** Every DMR publication carries encryptionKnown and every clear one is authorized. */
function expectAuthorized(items: Item[]): Trace {
	const trace = replay(items)
	expect(trace.violations).toEqual([])
	expect(trace.pubs.every(p => p.hasField)).toBe(true)
	return trace
}

/** No DMR publication is clear at all (a stricter check for the never-clear shapes). */
function expectNeverClear(items: Item[]): Trace {
	const trace = expectAuthorized(items)
	expect(trace.pubs.filter(clear)).toEqual([])
	return trace
}

/** No DMR publication from line `fromLine` on is clear. */
function expectNotClearFrom(items: Item[], fromLine: number): Trace {
	const trace = expectAuthorized(items)
	expect(trace.pubs.filter(p => p.seq >= fromLine && clear(p))).toEqual([])
	return trace
}

function forged(trace: Trace, seq: number, callId?: string): Claim {
	const real = trace.pubs.at(-1)
	return {
		callId: callId ?? real?.callId ?? "absent",
		seq,
		talkgroup: real?.talkgroup ?? 9001,
		source: real?.source ?? 91,
		encrypted: false,
		encryptionKnown: true,
		hasField: true,
	}
}

describe("dsd-fme DMR clearance repro corpus", () => {
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["Date"] })
		vi.setSystemTime(T0)
	})
	afterEach(() => {
		vi.useRealTimers()
		vi.restoreAllMocks()
	})

	describe("oracle controls", () => {
		it("authorizes a header call settled by its voice and a named call proven by its own LC", () => {
			const header = expectAuthorized([
				[0, M("VLC")],
				[1, LC()],
				[60, M("VC*")],
				[420, M("VC*")],
				[780, M("TLC")],
			])
			expect(header.pubs.some(clear)).toBe(true)
			const named = expectAuthorized([
				[0, B1("VC1")],
				[60, B1("VC2")],
				[61, LC()],
				[120, B1("VC3")],
				[180, B1("VC4")],
			])
			expect(named.pubs.some(clear)).toBe(true)
		})

		it("rejects a forged clear for an unknown call, an unnamed key and an omitted field", () => {
			const trace = replay([[0, M("VC*")]])
			expect(
				trace.oracle.judge(forged(trace, 2, "never-opened")),
			).not.toBeNull()
			const header = replay([
				[0, M("VLC")],
				[1, LC()],
				[60, M("VC*")],
			])
			const id = header.pubs[0]!.callId
			expect(
				header.oracle.judge({ ...forged(header, 3.25, id), talkgroup: 9002 }),
			).not.toBeNull()
			expect(
				header.oracle.judge({
					...forged(header, 3.25, id),
					hasField: false,
					encryptionKnown: undefined,
				}),
			).not.toBeNull()
		})
	})

	describe("first set (B1-B6)", () => {
		it("B1: a clean MS header followed by SLCO NULL and a burst error is never clear", () => {
			expectNeverClear([
				[0, M("VLC")],
				[1, LC()],
				[110, SLCO_NULL],
				[120, FEC],
			])
		})

		it("B2a: a bare DMR sync then a link control is never clear", () => {
			expectNeverClear([
				[0, BARE],
				[1, LC()],
				[110, SLCO_NULL],
				[120, M("IDLE")],
			])
		})

		it("B2a: a first DMR Voice print after a restart is never clear", () => {
			expectNeverClear([
				[0, RESTART_LINE],
				[1, DMR_VOICE],
				[110, SLCO_NULL],
				[120, M("IDLE")],
			])
		})

		it("B2b: a header before another protocol gives a later bare DMR call nothing", () => {
			expectNeverClear([
				[0, M("VLC")],
				[10, DSTAR],
				[20, BARE],
				[21, LC()],
				[130, SLCO_NULL],
			])
		})

		it("B2c: an expired call's voice context gives a later call nothing", () => {
			expectNeverClear([
				[0, M("VC*")],
				[360, M("VC*")],
				[5000, SLCO_NULL],
				[5010, LC()],
				[5120, SLCO_NULL],
				[5130, M("IDLE")],
			])
		})

		it("B3: a dropped proof is not settled by a terminator trailer and another protocol", () => {
			expectNeverClear([
				[0, M("VC*")],
				[360, M("VC*")],
				[370, LC()],
				[380, CSBK],
				[420, M("TLC")],
				[421, LC()],
				[480, DSTAR],
			])
		})

		it("B3: nor by a bracketless idle burst", () => {
			expectNeverClear([
				[0, M("VC*")],
				[360, M("VC*")],
				[370, LC()],
				[380, CSBK],
				[420, M("TLC")],
				[421, LC()],
				[480, X("IDLE")],
			])
		})

		it("B3 unnamed: a dirty terminator and its trailer never clear an unnamed call", () => {
			expectNeverClear([
				[0, B1("VC1")],
				[60, B1("VC2")],
				[120, B1("TLC  (FEC ERR)")],
				[121, LC()],
				[180, B1("IDLE")],
			])
		})

		it("B4a: an error before the link control in the same burst is remembered", () => {
			expectNeverClear([
				[0, B1("VC1")],
				[60, B1("VC2")],
				[120, FEC],
				[121, LC()],
				[180, B1("VC3")],
			])
		})

		it("B4b: a dirty opening sync gives its clean link control no proof", () => {
			expectNeverClear([
				[0, B1("VC1")],
				[60, B1("VC2  (FEC ERR)")],
				[61, LC()],
				[120, B1("VC3")],
			])
		})

		it("B4c: an error inside an allowlisted AMBE print kills the proof", () => {
			expectNeverClear([
				[0, B1("VC1")],
				[60, B1("VC2")],
				[61, LC()],
				[62, " AMBE 01 err = [0] [0] (FEC ERR)"],
				[120, B1("VC3")],
			])
		})

		it("B5a: an encrypted print with a CRC error ends clear for good", () => {
			expectNotClearFrom(
				[
					[0, B1("VC1")],
					[60, B1("VC2")],
					[61, LC()],
					[180, B1("VC3")],
					[200, LC("Encrypted (CRC ERR)")],
					[240, B1("VC4")],
					[241, LC()],
					[300, B1("VC5")],
				],
				5,
			)
		})

		it("B5b: an encrypted link control after a PI burst ends clear for good", () => {
			expectNotClearFrom(
				[
					[0, B1("VC1")],
					[60, B1("VC2")],
					[61, LC()],
					[120, B1("VC3")],
					[180, B1("PI")],
					[181, LC("Encrypted")],
					[240, B1("VC4")],
					[241, LC()],
					[300, B1("VC5")],
				],
				6,
			)
		})

		it("B5c: a rival's encrypted print is not forgotten when the original key returns", () => {
			expectNotClearFrom(
				[
					[0, B1("VC1")],
					[60, B1("VC2")],
					[61, LC()],
					[120, B1("VC3")],
					[121, LC("Encrypted", 9002, 92)],
					[180, B1("VC4")],
					[181, LC()],
					[240, B1("VC5")],
				],
				5,
			)
		})

		it("B5d: an SVC privacy bit alone is privacy", () => {
			expectNeverClear([
				[0, B1("VC1")],
				[60, B1("VC2")],
				[61, " SLOT 1 TGT=9001 SRC=91 SVC=0x40 Group Call  "],
				[120, B1("VC3")],
			])
		})

		it("B6: a bracketless burst error reaches the MS call's proof", () => {
			expectNeverClear([
				[0, M("VC*")],
				[360, M("VC*")],
				[361, LC()],
				[362, X("VC3  (FEC ERR)")],
				[480, M("VC*")],
			])
		})
	})

	describe("second set", () => {
		for (const privacy of [
			" SLOT 1 TGT=9002 SRC=92 Group Call Encrypted ",
			" SLOT 1 TGT=9002 SRC=92 SVC=0x40 Group Call ",
		])
			it(`1: a rival's privacy lands before any announcement (${privacy.includes("SVC") ? "SVC" : "Encrypted"})`, () => {
				expectNotClearFrom(
					[
						[0, B1("VLC")],
						[1, LC()],
						[60, B1("VC1")],
						[110, privacy],
						[120, B1("VC2")],
					],
					4,
				)
			})

		it("2: a DMR Voice print is not a link control", () => {
			expectNeverClear([
				[0, B1("VC1")],
				[60, B1("VC2")],
				[61, DMR_VOICE],
				[120, B1("VC3")],
				[240, B1("VC4")],
			])
		})

		for (const other of [LC(), " SLOT 1 ALG ID: 00; KEY ID: 00; "])
			it(`3: a line printed on the other slot proves nothing (${other.includes("ALG") ? "ALG" : "LC"})`, () => {
				expectNeverClear([
					[0, B1("VLC")],
					[1, LC()],
					[2, FEC],
					[60, B1("VC1")],
					[80, B2("VC1")],
					[81, other],
					[120, B1("VC2")],
					[240, B1("VC3")],
				])
			})

		for (const privacy of [
			" SLOT 1 TGT=9001 SRC=91 Group Call SVC=0x40 ",
			" SLOT 1 TGT=9001 SRC=91 Group Call Encrypted (CRC ERR) ",
		])
			it(`4: unattributable privacy reaches a live MS call (${privacy.includes("SVC") ? "SVC" : "CRC"})`, () => {
				expectNotClearFrom(
					[
						[0, M("VLC")],
						[1, LC()],
						[60, M("VC*")],
						[180, M("VC*")],
						[200, X("IDLE")],
						[201, privacy],
						[240, M("VC*")],
					],
					6,
				)
			})

		it("5a: the oracle rejects a clear after a privacy print earlier in the call", () => {
			const trace = expectAuthorized([
				[0, B1("VC1")],
				[60, B1("VC2")],
				[61, LC("Encrypted")],
				[120, B1("VC3")],
				[121, LC()],
				[180, B1("VC4")],
			])
			const id = trace.pubs[0]?.callId
			expect(id).toBeDefined()
			expect(trace.oracle.judge(forged(trace, 6.3, id))).not.toBeNull()
		})

		it("5b: the oracle rejects a second call borrowing the first call's name", () => {
			const trace = expectAuthorized([
				[0, M("VLC")],
				[1, LC()],
				[60, M("VC*")],
				[420, M("TLC")],
				[5420, M("VC*")],
				[5780, M("VC*")],
				[6140, M("TLC")],
				[6141, LC()],
				[6200, M("IDLE")],
			])
			const ids = [...new Set(trace.pubs.map(p => p.callId))]
			expect(ids.length).toBeGreaterThanOrEqual(2)
			expect(trace.oracle.judge(forged(trace, 9.3, ids.at(-1)))).not.toBeNull()
		})
	})

	describe("third set", () => {
		const unplaced = (privacy: string): Item[] => [
			[0, BARE],
			[1, LC()],
			[110, SLCO_NULL],
			[120, X("IDLE")],
			[121, privacy],
			[180, M("VC*")],
			[181, LC()],
			[240, M("VC*")],
		]

		for (const privacy of [
			" SLOT 1 TGT=9001 SRC=91 SVC=0x40 Group Call ",
			" SLOT 1 TGT=9001 SRC=91 Group Call Encrypted (CRC ERR) ",
		])
			it(`a call opened without a lane keeps unattributable privacy (${privacy.includes("SVC") ? "SVC" : "CRC"})`, () => {
				expectNeverClear(unplaced(privacy))
			})

		it("A: the oracle rejects a clear injected for that call", () => {
			const trace = expectNeverClear(
				unplaced(" SLOT 1 TGT=9001 SRC=91 SVC=0x40 Group Call "),
			)
			const id = trace.pubs[0]?.callId
			expect(id).toBeDefined()
			expect(trace.oracle.judge(forged(trace, 8.3, id))).not.toBeNull()
		})

		it("B: the oracle rejects a clear under a different callId with the same ids and slot", () => {
			const trace = expectAuthorized([
				[0, M("VLC")],
				[1, LC()],
				[60, M("VC*")],
				[420, M("VC*")],
			])
			expect(trace.pubs.some(clear)).toBe(true)
			expect(
				trace.oracle.judge(forged(trace, 4.3, "dsd-fme-forged-1")),
			).not.toBeNull()
		})
	})

	describe("fourth set", () => {
		it("1: an unplaced Call Termination sync never publishes a clear end", () => {
			const trace = expectAuthorized([
				[0, M("VLC")],
				[1, LC()],
				[60, M("VC*")],
				[420, M("VC*")],
				[480, "00:00:01 Sync: +DMR Call Termination "],
			])
			expect(trace.pubs.filter(p => p.seq >= 5 && clear(p))).toEqual([])
			// The call was announced and is ended (call_end and the inactive snapshot).
			expect(trace.pubs.some(p => p.kind === "call_end")).toBe(true)
		})

		const restartShapes: [string, Item[]][] = [
			[
				"a header call",
				[
					[0, M("VLC")],
					[1, LC()],
					[60, M("VC*")],
					[80, RESTART_LINE],
				],
			],
			[
				"a terminator holding for its trailer",
				[
					[0, M("VC*")],
					[360, M("VC*")],
					[370, LC()],
					[380, CSBK],
					[420, M("TLC")],
					[421, LC()],
					[422, RESTART_LINE],
				],
			],
			[
				"a dirty unnamed terminator",
				[
					[0, B1("VC1")],
					[60, B1("VC2")],
					[120, B1("TLC  (FEC ERR)")],
					[121, LC()],
					[122, RESTART_LINE],
				],
			],
		]
		for (const [name, items] of restartShapes)
			it(`2: a restart ends ${name} unknown, judged inside each emit`, () => {
				const at = items.findIndex(([, t]) => t === RESTART_LINE) + 1
				const trace = expectNotClearFrom(items, at)
				// The restart publishes the announced call's end; an unnamed call
				// without evidence is suppressed and publishes nothing.
				expect(trace.pubs.some(p => Math.floor(p.seq) === at)).toBe(
					!name.includes("unnamed"),
				)
			})

		it("3: the oracle rejects a clear injected for a call opened unplaced", () => {
			const trace = expectNeverClear([
				[0, BARE],
				[1, LC()],
				[110, SLCO_NULL],
				[120, X("IDLE")],
				[121, SLCO_NULL],
				[180, M("VC*")],
				[181, LC()],
				[240, M("VC*")],
			])
			const id = trace.pubs[0]?.callId
			expect(id).toBeDefined()
			expect(trace.oracle.judge(forged(trace, 8.3, id))).not.toBeNull()
		})

		it("4: a second LC of a live call backs no forged callId", () => {
			const trace = expectAuthorized([
				[0, M("VLC")],
				[1, LC()],
				[60, M("VC*")],
				[420, M("VC*")],
				[421, LC()],
				[780, M("VC*")],
			])
			expect(trace.pubs.some(clear)).toBe(true)
			expect(
				trace.oracle.judge(forged(trace, 6.3, "dsd-fme-forged-2")),
			).not.toBeNull()
		})
	})
})
