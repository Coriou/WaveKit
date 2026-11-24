/**
 * dsd-fme non-DMR recording clearance: timed line scripts (modelled on the
 * pinned build's prints) replayed through the real adapter, with a per-call
 * recording directory holding a file for every call, so a call_end links a
 * recording exactly when the adapter admits it. Every non-DMR publication
 * that says clear or links a recording is judged at its emission by an
 * independent oracle (./dsd-fme-nondmr-call-oracle.ts, no adapter code) that
 * derives the overs from the lines itself, never from the adapter's calls.
 * P25, NXDN, dPMR: a recording only on positive clear evidence of the call
 * itself; D-STAR and YSF carry no privacy field. Ids are synthetic.
 */
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { DsdFmeVoiceCallState } from "../../../src/decoders/builtin/dsd-fme.js"
import type { DecoderOutput } from "../../../src/decoders/types.js"
import {
	createDecoder,
	T0,
	type CallData,
} from "./dsd-fme-call-first-helpers.js"
import { NonDmrOracle, RESTART_LINE } from "./dsd-fme-nondmr-call-oracle.js"

type Item = [atMs: number, text: string]

// --- P25 phase 1 (p25p1_hdu.c, p25p1_ldu2.c, p25_lcw.c, dsd_frame.c) ---
const P1 = (duid: string) => `03:04:05 Sync: +P25p1 NAC/CC: 2A5;  ${duid}`
const LCW = (tg = 56, src = 1234, extra = "") =>
	` LCW${extra} Group Voice Channel User - Group ${tg} Source ${src}`
const LDU2_CLEAR = " LDU2 ALG ID: 0x80 KEY ID: 0x0000 MI: 0x0000000000000000"
const LDU2_ENC = " LDU2 ALG ID: 0x84 KEY ID: 0x1234 MI: 0x1122334455667788 ENC"
const HDU_ENC = " HDU  ALG ID: 0x84 KEY ID: 0x1234 MI: 0x1122334455667788 ENC"

/** One P25 phase 1 over: HDU, then superframes of LDU1 (LCW) and LDU2 (ALG). */
function p25Over(
	t0: number,
	opts: {
		tg?: number
		src?: number
		alg?: (n: number) => string | null
		superframes?: number
		end?: boolean
		hdu?: string | null
		/** The ALG print on the LDU2 sync line itself (no newline between them). */
		algOnSync?: boolean
	} = {},
): Item[] {
	const items: Item[] = [[t0, P1("HDU")]]
	if (opts.hdu) items.push([t0, opts.hdu])
	const n = opts.superframes ?? 3
	for (let i = 0; i < n; i++) {
		const t = t0 + 180 + i * 360
		items.push([t, P1("LDU1")], [t, LCW(opts.tg, opts.src)])
		const alg = opts.alg?.(i) ?? null
		if (opts.algOnSync === true && alg !== null)
			items.push([t + 180, P1("LDU2") + alg])
		else {
			items.push([t + 180, P1("LDU2")])
			if (alg !== null) items.push([t + 180, alg])
		}
	}
	if (opts.end !== false) items.push([t0 + 180 + n * 360 + 20, P1("TDU")])
	return items
}

// --- P25 phase 2 (p25p2_xcch.c MAC_PTT) ---
const P2_SYNC = "03:04:05 Sync: +P25p2 "
const P2_PTT = (tg = 7070, src = 40820) => ` VCH 0 - TG ${tg} SRC ${src} `
const P2_ENC =
	"         ALG ID: 0x84 KEY ID: 0x1234 MI: 0x1122334455667788 MPTT"

function p2Call(t0: number, enc: "none" | "in" | "before" = "none"): Item[] {
	const items: Item[] = [[t0, P2_SYNC]]
	if (enc === "before") items.push([t0, P2_ENC])
	items.push([t0 + 20, " MAC_PTT "], [t0 + 20, P2_PTT()])
	if (enc === "in") items.push([t0 + 20, P2_ENC])
	for (let t = t0 + 200; t <= t0 + 1200; t += 200) items.push([t, P2_SYNC])
	return items
}

// --- NXDN48 (nxdn_element.c NXDN_decode_VCALL) ---
const NX = (pf: string, tail = "") =>
	`03:04:05 Sync: NXDN48  RDCH Voice  RAN 05 PF ${pf}${tail}`
const NX_IDS = (src = 1234, tg = 5678) =>
	` Group Call - Half Duplex 4800bps/EHR (00) - Src=${src} - Dst/TG=${tg} `
const NX_CIPHER = "  Scrambler - Key ID 3 - "

/** One NXDN over; `vcall` puts a VCALL with its IDs (and cipher) on the 4th frame. */
function nxdnOver(
	t0: number,
	opts: {
		vcall?: { src?: number; tg?: number; cipher?: boolean } | null
		frames?: number
		before?: string
	} = {},
): Item[] {
	const items: Item[] = []
	const frames = opts.frames ?? 8
	for (let i = 0; i < frames; i++) {
		const t = t0 + i * 80
		const pf = `${(i % 4) + 1}/4`
		if (i === 3 && opts.vcall) {
			items.push([t, NX(pf, " VCALL")])
			items.push([t, NX_IDS(opts.vcall.src, opts.vcall.tg)])
			if (opts.vcall.cipher) items.push([t, NX_CIPHER])
		} else items.push([t, NX(pf)])
		// After the first frame (the context is NXDN), before the call starts.
		if (i === 0 && opts.before) items.push([t, opts.before])
	}
	return items
}

// --- dPMR (dpmr_voice.c) ---
const DP_SYNC = "03:04:05 Sync: +dPMR  dPMR Frame Sync 2"
const DP_IDS = " TG=0001234 Src=0005678 Channel Code=05"

function dpmrCall(t0: number, scrambler: boolean): Item[] {
	const items: Item[] = []
	for (let t = t0; t <= t0 + 800; t += 80)
		items.push([t, DP_SYNC], [t, DP_IDS + (scrambler ? " Scrambler" : "")])
	return items
}

// --- ProVoice (modelled; it prints no privacy field) ---
const PV_SYNC = "03:04:05 Sync: +ProVoice "
const PV_VOICE = " VOICE inlvl: 40%"

function provoiceCall(t0: number): Item[] {
	const items: Item[] = []
	for (let t = t0; t <= t0 + 800; t += 80)
		items.push([t, PV_SYNC], [t, PV_VOICE])
	return items
}

// --- D-STAR, YSF ---
const DSTAR =
	"03:04:05 Sync: +DSTAR VOICE   RPT 2: DIRECT   RPT 1: DIRECT   DST: CQCQCQ   SRC: N0CALL  TEST"
const YSF = (frame: string) =>
	`03:04:05 Sync: +YSF  V/D2 Group/CQ -Simplex ${frame}`

function dstarCall(t0: number): Item[] {
	const items: Item[] = []
	for (let t = t0; t <= t0 + 1260; t += 420) items.push([t, DSTAR])
	return items
}

function ysfCall(t0: number): Item[] {
	return [
		[t0, YSF("HC FN: 1/7 DST: ALL        SRC: N0CALL     ")],
		[t0 + 100, YSF("CC FN: 2/7 U/L:           ")],
		[t0 + 200, YSF("CC FN: 3/7 D/L:           ")],
		[t0 + 300, YSF("CC FN: 4/7 D/L:           ")],
	]
}

// --- replay ---

interface Pub {
	kind: "call_start" | "call_end" | "voice-call"
	callId: string
	protocol: string | null | undefined
	talkgroup: number | null | undefined
	source: number | null | undefined
	saysClear: boolean
	linked: boolean
	verdict: string | null
}

interface Trace {
	pubs: Pub[]
	violations: string[]
	/** Call ends that linked a recording, as `tg/src`. */
	linked: string[]
	ends: number
	/** Every call_start and call_end (not a recording follow-up), in order. */
	calls: string[]
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0")

/** dsd-fme's per-call name for one call key, stamped `atMs` after T0 (local time). */
function wavName(
	system: string,
	tg: number | string,
	src: number | string,
	atMs = 0,
): string {
	const d = new Date(T0 + atMs)
	const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
	return `${stamp}_12345_${system}_GROUP_TGT_${tg}_SRC_${src}.wav`
}

let root = ""

async function replay(
	mode: string,
	items: Item[],
	files: Array<
		[system: string, tg: number | string, src: number | string, atMs?: number]
	>,
): Promise<Trace> {
	for (const [system, tg, src, atMs] of files)
		fs.writeFileSync(path.join(root, wavName(system, tg, src, atMs)), "")
	const decoder = createDecoder({
		mode,
		enablePerCallRecording: true,
		perCallRecordingDir: root,
		perCallRecordingPrune: false,
	})
	const internals = decoder as unknown as {
		handleOutputLine(line: string): void
		checkCallTimeoutAsync(): void
		endOpenCallsForRestart?: (now: Date) => void
		wavSearch: Promise<void>
	}
	const oracle = new NonDmrOracle()
	let nowMs = 0
	const pubs: Pub[] = []
	const violations: string[] = []
	const linked: string[] = []
	let ends = 0
	const calls: string[] = []
	const judge = (pub: Omit<Pub, "verdict">) => {
		const verdict = oracle.judge({ ...pub, atMs: nowMs })
		pubs.push({ ...pub, verdict })
		if (verdict !== null)
			violations.push(`${pub.kind} ${pub.protocol} at ${nowMs}: ${verdict}`)
	}
	decoder.on("output", (o: DecoderOutput) => {
		if (o.type !== "call_start" && o.type !== "call_end") return
		const d = o.data as CallData & { wavFile?: string }
		if (d.protocol === "dmr") return
		const encrypted =
			o.type === "call_start"
				? d.encrypted === true
				: d.flags?.encrypted === true
		const isLinked = o.type === "call_end" && d.wavFile !== undefined
		if (o.type === "call_end" && !d.flags?.wavFileUpdate) ends++
		if (o.type === "call_start" || !d.flags?.wavFileUpdate)
			calls.push(`${o.type} ${d.protocol} ${d.talkgroup}/${d.source}`)
		if (isLinked) linked.push(`${d.talkgroup}/${d.source}`)
		judge({
			kind: o.type,
			callId: d.callId,
			protocol: d.protocol,
			talkgroup: d.talkgroup,
			source: d.source,
			saysClear: !encrypted && d.encryptionKnown !== false,
			linked: isLinked,
		})
	})
	decoder.on("voice-call", (v: DsdFmeVoiceCallState) => {
		if (v.protocol === "dmr") return
		judge({
			kind: "voice-call",
			callId: v.callId,
			protocol: v.protocol,
			talkgroup: v.talkgroup,
			source: v.source,
			saysClear: !v.encrypted && v.encryptionKnown !== false,
			linked: false,
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
			nowMs = atMs
			vi.setSystemTime(T0 + atMs)
			oracle.line(atMs, text)
			if (text === RESTART_LINE) {
				expect(typeof internals.endOpenCallsForRestart).toBe("function")
				internals.endOpenCallsForRestart!(new Date(T0 + atMs))
			} else internals.handleOutputLine(text)
			index++
		}
		nowMs = now
		vi.setSystemTime(T0 + now)
		if (now % 500 === 0) internals.checkCallTimeoutAsync()
	}
	// The WAV lookups run off the event loop: wait for every one queued (a first attempt finds
	// a file that already exists; a later retry is beyond this trace).
	for (;;) {
		const tail = internals.wavSearch
		await tail
		if (internals.wavSearch === tail) break
	}
	return { pubs, violations, linked, ends, calls }
}

/** Every publication is authorized and no recording is linked. */
function expectNeverLinked(trace: Trace): void {
	expect(trace.ends).toBeGreaterThan(0)
	expect({ linked: trace.linked, violations: trace.violations }).toEqual({
		linked: [],
		violations: [],
	})
}

/** Every publication is authorized and exactly these keys link. */
function expectLinked(trace: Trace, keys: string[]): void {
	expect({ linked: trace.linked, violations: trace.violations }).toEqual({
		linked: keys,
		violations: [],
	})
}

const P1_FILE = (tg = 56, src = 1234): [string, number, number] => [
	"P25_2A5",
	tg,
	src,
]
const P2_FILE: [string, number, number] = ["P25_BEE001232A5_1_1", 7070, 40820]
const NX_FILE = (
	tg = 5678,
	src = 1234,
	atMs = 0,
): [string, number, number, number] => ["NXDN_RAN_5", tg, src, atMs]
const DP_FILE: [string, string, string] = ["DPMR_CC_5", "0001234", "0005678"]
const PV_FILE: [string, number, number] = ["PROVOICE_CC_0", 0, 0]

describe("dsd-fme non-DMR recording clearance repro corpus", () => {
	beforeEach(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "wk-nondmr-rec-"))
		vi.useFakeTimers({ toFake: ["Date"] })
		vi.setSystemTime(T0)
	})
	afterEach(() => {
		vi.useRealTimers()
		vi.restoreAllMocks()
		fs.rmSync(root, { recursive: true, force: true })
	})

	describe("P25 phase 1", () => {
		it("(a) a call with no ALG print at all is never linked", async () => {
			expectNeverLinked(await replay("p25", p25Over(0), [P1_FILE()]))
		})

		it("(b) an encrypted LDU2 ALG is never linked", async () => {
			expectNeverLinked(
				await replay("p25", p25Over(0, { alg: () => LDU2_ENC }), [P1_FILE()]),
			)
		})

		it("(b) encryption printed after a clear LDU2 is never linked", async () => {
			expectNeverLinked(
				await replay(
					"p25",
					p25Over(0, { alg: n => (n === 0 ? LDU2_CLEAR : LDU2_ENC) }),
					[P1_FILE()],
				),
			)
		})

		it("(b) an LCW printing Encrypted is never linked, even with clear LDU2s", async () => {
			const items = p25Over(0, { alg: () => LDU2_CLEAR }).map(
				([t, text]): Item => [
					t,
					text.startsWith(" LCW") ? LCW(56, 1234, " Encrypted") : text,
				],
			)
			expectNeverLinked(await replay("p25", items, [P1_FILE()]))
		})

		it("(b) an encrypted HDU before the call's start in the same context is never linked", async () => {
			expectNeverLinked(
				await replay(
					"p25",
					p25Over(0, { hdu: HDU_ENC, alg: () => LDU2_CLEAR }),
					[P1_FILE()],
				),
			)
		})

		it("(c) a call whose own LDU2 prints ALG 0x80 KEY 0 is linked", async () => {
			expectLinked(
				await replay("p25", p25Over(0, { alg: () => LDU2_CLEAR }), [P1_FILE()]),
				["56/1234"],
			)
		})

		describe("the LDU2 ALG print on the LDU2 sync line itself", () => {
			const onSync = (alg: (n: number) => string | null, extra = {}) =>
				p25Over(0, { alg, algOnSync: true, ...extra })

			it("(c) a clear ALG on the call's own LDU2 sync line is linked", async () => {
				expectLinked(
					await replay(
						"p25",
						onSync(() => LDU2_CLEAR),
						[P1_FILE()],
					),
					["56/1234"],
				)
			})

			it("(b) an encrypted ALG on the LDU2 sync line is never linked", async () => {
				expectNeverLinked(
					await replay(
						"p25",
						onSync(() => LDU2_ENC),
						[P1_FILE()],
					),
				)
			})

			it("(b) encryption on a later LDU2 sync line after a clear one is never linked", async () => {
				expectNeverLinked(
					await replay(
						"p25",
						onSync(n => (n === 0 ? LDU2_CLEAR : LDU2_ENC)),
						[P1_FILE()],
					),
				)
			})

			it("(c) an errored LDU2 sync line's clear ALG is not evidence", async () => {
				expectNeverLinked(
					await replay(
						"p25",
						onSync(() => `${LDU2_CLEAR} FEC ERR`),
						[P1_FILE()],
					),
				)
			})

			it("(c) a clear ALG on an LDU2 sync line with a non-zero key is not evidence", async () => {
				expectNeverLinked(
					await replay(
						"p25",
						onSync(
							() => " LDU2 ALG ID: 0x80 KEY ID: 0x0007 MI: 0x0000000000000000",
						),
						[P1_FILE()],
					),
				)
			})

			it("(d) a clear LDU2 sync line after a failed LDU1 credits no call", async () => {
				const items: Item[] = [
					...p25Over(0, { superframes: 2, end: false }),
					[900, P1("HDU")],
					[1080, P1("LDU1")],
					[1080, " LCW FEC ERR"],
					[1260, P1("LDU2") + LDU2_CLEAR],
					[1440, P1("LDU1")],
					[1440, LCW(58, 99)],
					[1620, P1("LDU2") + LDU2_CLEAR],
					[1640, P1("TDU")],
				]
				expectLinked(await replay("p25", items, [P1_FILE(), P1_FILE(58, 99)]), [
					"58/99",
				])
			})

			it("(d) another call's clear LDU2 sync line is not borrowed by the next call", async () => {
				const items = [
					...onSync(() => LDU2_CLEAR),
					...p25Over(2000, { tg: 57 }),
				]
				expectLinked(await replay("p25", items, [P1_FILE(), P1_FILE(57)]), [
					"56/1234",
				])
			})
		})

		it("(c) an LDU2 clear with a non-zero key is not evidence", async () => {
			expectNeverLinked(
				await replay(
					"p25",
					p25Over(0, {
						alg: () =>
							" LDU2 ALG ID: 0x80 KEY ID: 0x0007 MI: 0x0000000000000000",
					}),
					[P1_FILE()],
				),
			)
		})

		it("(d) an earlier call's clear LDU2 is not borrowed by the next call", async () => {
			const items = [
				...p25Over(0, { alg: () => LDU2_CLEAR }),
				...p25Over(2000, { tg: 57 }),
			]
			expectLinked(await replay("p25", items, [P1_FILE(), P1_FILE(57)]), [
				"56/1234",
			])
		})

		it("(d) another talkgroup named without a terminator does not take the call's evidence", async () => {
			const items = [
				...p25Over(0, { alg: () => LDU2_CLEAR, end: false }),
				[1300, P1("LDU1")] as Item,
				[1300, LCW(58, 99)] as Item,
				[1660, P1("TDU")] as Item,
			]
			expectLinked(await replay("p25", items, [P1_FILE(), P1_FILE(58, 99)]), [
				"56/1234",
			])
		})

		it("(d) a clear LDU2 of the next over, after a failed LDU1, is not credited to the open call", async () => {
			// Call A: two superframes, no ALG print, no terminator. Then over B:
			// its HDU inside the re-key gap, an LDU1 whose LCW failed (no IDs),
			// a clear LDU2, then an LDU1 naming 58/99, a clear LDU2, a TDU.
			const items: Item[] = [
				...p25Over(0, { superframes: 2, end: false }),
				[900, P1("HDU")],
				[1080, P1("LDU1")],
				[1080, " LCW FEC ERR"],
				[1260, P1("LDU2")],
				[1260, " LDU2 ALG ID: 0x80 KEY ID: 0x0000"],
				[1440, P1("LDU1")],
				[1440, LCW(58, 99)],
				[1620, P1("LDU2")],
				[1620, LDU2_CLEAR],
				[1640, P1("TDU")],
			]
			const trace = await replay("p25", items, [P1_FILE(), P1_FILE(58, 99)])
			expectLinked(trace, ["58/99"])
		})
	})

	describe("P25 phase 2", () => {
		it("(a) a MAC_PTT call without any ALG print is never linked (no clear print exists)", async () => {
			expectNeverLinked(await replay("p25", p2Call(0), [P2_FILE]))
		})

		it("(b) a MAC_PTT ALG print is never linked", async () => {
			expectNeverLinked(await replay("p25", p2Call(0, "in"), [P2_FILE]))
		})

		it("(b) an ALG print before the call's start in the same context is never linked", async () => {
			expectNeverLinked(await replay("p25", p2Call(0, "before"), [P2_FILE]))
		})
	})

	describe("NXDN", () => {
		it("(a) a call heard by its RAN only (no VCALL) is never linked", async () => {
			expectNeverLinked(
				await replay("nxdn48", nxdnOver(0, { vcall: null }), [NX_FILE(0, 0)]),
			)
		})

		it("(b) a VCALL followed by its cipher print is never linked", async () => {
			expectNeverLinked(
				await replay("nxdn48", nxdnOver(0, { vcall: { cipher: true } }), [
					NX_FILE(),
				]),
			)
		})

		it("(b) a cipher print after a clear VCALL is never linked", async () => {
			const items = [
				...nxdnOver(0, { vcall: {}, frames: 12 }),
				[800, NX_CIPHER] as Item,
			]
			expectNeverLinked(await replay("nxdn48", items, [NX_FILE()]))
		})

		it("(b) a cipher print before the call's start in the same context is never linked", async () => {
			expectNeverLinked(
				await replay("nxdn48", nxdnOver(0, { vcall: {}, before: NX_CIPHER }), [
					NX_FILE(),
				]),
			)
		})

		it("(c) a call whose own checked VCALL has no cipher print is linked", async () => {
			expectLinked(
				await replay("nxdn48", nxdnOver(0, { vcall: {} }), [NX_FILE()]),
				["5678/1234"],
			)
		})

		it("(d) an earlier call's clear VCALL is not borrowed by a call heard by RAN only", async () => {
			const items = [
				...nxdnOver(0, { vcall: {} }),
				...nxdnOver(6000, { vcall: null }),
			]
			expectLinked(
				await replay("nxdn48", items, [NX_FILE(), NX_FILE(0, 0, 6000)]),
				["5678/1234"],
			)
		})

		it("(d) an earlier call's clear VCALL is not borrowed by a ciphered call", async () => {
			const items = [
				...nxdnOver(0, { vcall: {} }),
				...nxdnOver(6000, { vcall: { src: 77, tg: 66, cipher: true } }),
			]
			expectLinked(
				await replay("nxdn48", items, [NX_FILE(), NX_FILE(66, 77, 6000)]),
				["5678/1234"],
			)
		})
	})

	describe("dPMR", () => {
		it("(a) a call without a Scrambler print is never linked (no clear print exists)", async () => {
			expectNeverLinked(await replay("dpmr", dpmrCall(0, false), [DP_FILE]))
		})

		it("(b) a Scrambler print is never linked", async () => {
			expectNeverLinked(await replay("dpmr", dpmrCall(0, true), [DP_FILE]))
		})
	})

	describe("ProVoice", () => {
		it("(a) a ProVoice call is never linked (no clear print exists)", async () => {
			expectNeverLinked(await replay("provoice", provoiceCall(0), [PV_FILE]))
		})
	})

	describe("D-STAR and YSF (no privacy field)", () => {
		it("(e) a D-STAR call is linked", async () => {
			expectLinked(
				await replay("dstar", dstarCall(0), [
					["DSTAR", "CQCQCQ__", "N0CALL__TEST"],
				]),
				["0/0"],
			)
		})

		it("(e) a YSF call is linked", async () => {
			expectLinked(
				await replay("ysf", ysfCall(0), [["YSF", "ALL_______", "N0CALL____"]]),
				["0/0"],
			)
		})
	})

	describe("context resets", () => {
		it("a restart drops a P25 privacy print's context; the next call proves itself", async () => {
			const items: Item[] = [
				[0, P1("HDU")],
				[0, HDU_ENC],
				[100, RESTART_LINE],
				...p25Over(500, { alg: () => LDU2_CLEAR }),
			]
			expectLinked(await replay("p25", items, [P1_FILE()]), ["56/1234"])
		})
	})
	describe("call publication never depends on privacy", () => {
		/** The corpus with every privacy and clear-evidence print removed. */
		const strip = (items: Item[]): Item[] =>
			items
				.filter(
					([, text]) =>
						!/\bALG ID:/.test(text) && !/^\s*Scrambler - Key ID\b/.test(text),
				)
				.map(
					([t, text]): Item => [
						t,
						text
							.replace(/ Scrambler$/, "")
							.replace(/^ LCW Encrypted /, " LCW "),
					],
				)

		const cases: Array<[name: string, mode: string, items: Item[]]> = [
			["P25 phase 1 clear", "p25", p25Over(0, { alg: () => LDU2_CLEAR })],
			["P25 phase 1 encrypted", "p25", p25Over(0, { alg: () => LDU2_ENC })],
			[
				"P25 phase 1 encrypted LCW",
				"p25",
				p25Over(0, { alg: () => LDU2_CLEAR }).map(
					([t, text]): Item => [
						t,
						text.startsWith(" LCW") ? LCW(56, 1234, " Encrypted") : text,
					],
				),
			],
			[
				"P25 phase 1 two overs",
				"p25",
				[
					...p25Over(0, { superframes: 2, end: false, alg: () => LDU2_ENC }),
					...p25Over(900, { tg: 58, src: 99, alg: () => LDU2_CLEAR }),
				],
			],
			["P25 phase 2 encrypted", "p25", p2Call(0, "in")],
			["P25 phase 2 encrypted before", "p25", p2Call(0, "before")],
			[
				"NXDN clear then ciphered",
				"nxdn48",
				[
					...nxdnOver(0, { vcall: {} }),
					...nxdnOver(6000, { vcall: { src: 77, tg: 66, cipher: true } }),
				],
			],
			["dPMR scrambled", "dpmr", dpmrCall(0, true)],
			["ProVoice", "provoice", provoiceCall(0)],
		]

		for (const [name, mode, items] of cases)
			it(`${name}: the same call_start and call_end events, with the same talkgroup and source, with the privacy prints stripped`, async () => {
				const full = (await replay(mode, items, [])).calls
				const stripped = strip(items)
				expect(stripped.length).toBeLessThanOrEqual(items.length)
				const bare = (await replay(mode, stripped, [])).calls
				expect(full.length).toBeGreaterThan(0)
				expect(full.filter(c => c.startsWith("call_start"))).toHaveLength(
					full.filter(c => c.startsWith("call_end")).length,
				)
				expect(full).toEqual(bare)
			})
	})
})
