/**
 * dsd-fme: every publication site that can carry DMR call state goes through
 * the one gate (DsdFmeDecoder.publish), which reads the call's clearance at
 * emission time; and a recording is admitted (linked, so playable) only for
 * a call known clear.
 *
 * Structural: a source scan of the adapter lists every event sink, every
 * caller of the gate and every site that hands a publication to it; a new
 * one fails until it is named here. Behavioural: each named site, driven,
 * publishes only from inside the gate, with the trust the clearance holds at
 * that moment (the emitting site is read from the call stack).
 * Ids are synthetic.
 */
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { DMR_RECORDING_LINK_ENABLED } from "../../../src/decoders/builtin/call-recordings.js"
import type { DsdFmeVoiceCallState } from "../../../src/decoders/builtin/dsd-fme.js"
import type { DecoderOutput } from "../../../src/decoders/types.js"
import {
	createDecoder,
	T0,
	type CallData,
} from "./dsd-fme-call-first-helpers.js"

const SOURCE_PATH = "src/decoders/builtin/dsd-fme.ts"
const SOURCE = fs.readFileSync(SOURCE_PATH, "utf8")

const METHOD_HEADER =
	/^\t(?:(?:private|protected|public|override|async|static|readonly)\s+)*(?:get\s+)?([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\(/gm
const METHODS = [...SOURCE.matchAll(METHOD_HEADER)].map(m => ({
	line: SOURCE.slice(0, m.index).split("\n").length,
	at: m.index,
	name: m[1]!,
}))

/** The method enclosing a source offset or a 1-based line. */
function methodAt(where: { at?: number; line?: number }): string {
	const owner = METHODS.filter(m =>
		where.at !== undefined ? m.at < where.at : m.line <= (where.line ?? 0),
	).at(-1)
	return owner?.name ?? "<module>"
}

/** Each match of `pattern` with the method it sits in. */
function sites(
	pattern: RegExp,
	source = SOURCE,
): { method: string; text: string }[] {
	return [...source.matchAll(pattern)].map(m => ({
		method: methodAt({ at: m.index }),
		text: m[0],
	}))
}

/**
 * The sites that hand a call publication to the gate: callers of the output
 * override (and the base class's parse result), and callers of the call
 * update. A new one must be added here and driven below.
 */
const OUTPUT_SITES = [
	"endOpenCallsForRestart",
	"stop",
	"resolveHeldEnd",
	"checkCallTimeoutAsync",
	"checkCallTimeoutAsync",
	"parseOutput",
	"parseOutput",
	"handleSync",
	"handleDmrTrainIds",
	"handleDmrTrainIds",
	"handleP25P1Line",
	"findWavFileAsync",
	"endCall",
]
const UPDATE_SITES = [
	"markEncrypted",
	"markClear",
	"applyDmrTrust",
	"applyDmrTrust",
]
/**
 * Sites that never carry a DMR call (each returns before for DMR or parses another protocol).
 * While DMR recordings are off, the late recording update never runs for a DMR call either.
 */
const NON_DMR_SITES = [
	"handleP25P1Line",
	"markClear",
	...(DMR_RECORDING_LINK_ENABLED ? [] : ["findWavFileAsync"]),
]

describe("dsd-fme DMR publication sites (structural)", () => {
	it("emits events only from the gate, plus the named link-layer sink", () => {
		expect(sites(/\b(?:this|super)\.emit\(\s*["'`]?([\w-]*)/g)).toEqual([
			// The gate: the voice-call half of every call publication.
			{ method: "publish", text: 'this.emit("voice-call' },
			// Link-layer lines for the scanner: no call, no clearance field.
			{ method: "emitLink", text: 'this.emit("link' },
		])
		const link = fs.readFileSync("src/decoders/builtin/dsd-fme-link.ts", "utf8")
		expect(link).not.toMatch(/encryptionKnown|callId/)
	})

	it("sets a call's IDs only in the binding, so its taint check always runs", () => {
		// Plain, compound or logical assignment of any `.talkgroup` / `.source`
		// member, and a bulk assignment that could carry them.
		const pattern =
			/\.\s*(?:talkgroup|source)\s*(?:\?\?|\|\||&&|[-+*/%|&^])?=(?!=)|\bObject\.assign\(|\bReflect\.set\(/g
		const assigned = sites(pattern)
		// The binding's own two assignments, and nothing else (no allowlist).
		expect(assigned.filter(s => s.method !== "bindDmrCall")).toEqual([])
		expect(assigned.map(s => s.method)).toEqual(["bindDmrCall", "bindDmrCall"])
		// The scan sees every assignment form, and no comparison.
		const probe =
			"a.talkgroup = 1; b.source ??= 2; c.talkgroup === 3; d.source !== 4; Object.assign(e, f)"
		expect([...probe.matchAll(pattern)].length).toBe(3)
	})

	it("reaches the output stream only through the gate", () => {
		expect(sites(/\bsuper\.emitOutput\(/g)).toEqual([
			{ method: "publish", text: "super.emitOutput(" },
		])
		expect(SOURCE).not.toMatch(/outputStream|\.emit\(\s*["']output["']/)
	})

	it("calls the gate only from the output override, the call snapshot and the call update", () => {
		expect(sites(/\bthis\.publish\(/g).map(s => s.method)).toEqual([
			"emitOutput",
			"emitOutput",
			"publishCallSnapshot",
			"publishCallUpdate",
		])
		const override = SOURCE.match(
			/\n\tprotected override emitOutput\([\s\S]+?\n\t\}/,
		)?.[0]
		expect(override).toBeDefined()
		expect(override).not.toMatch(/\bsuper\.|\.emit\(/)
	})

	it("names every site that hands a publication to the gate", () => {
		expect(sites(/\bthis\.emitOutput\(/g).map(s => s.method)).toEqual(
			OUTPUT_SITES,
		)
		expect(sites(/\bthis\.publishCallUpdate\(/g).map(s => s.method)).toEqual(
			UPDATE_SITES,
		)
		expect(sites(/\bthis\.publishCallSnapshot\(/g).map(s => s.method)).toEqual([
			"emitOutput",
		])
		// The non-DMR sites: P25's split, and markClear returning for DMR
		// (positiveClearProtocol never names DMR).
		expect(SOURCE).toMatch(
			/private markClear\([^)]*\): void \{\n\t\tif \(!positiveClearProtocol\(call\.protocol\) \|\| call\.flags\.encrypted\) return/,
		)
		const strict = SOURCE.match(
			/\nexport function positiveClearProtocol\([\s\S]+?\n\}/,
		)?.[0]
		expect(strict).toBeDefined()
		expect(strict).not.toMatch(/"dmr"/)
	})

	it("the gate writes both trust fields of every DMR publication from the clearance", () => {
		const gate = SOURCE.match(/\n\tprivate publish\([\s\S]+?\n\t\}/)?.[0]
		expect(gate).toMatch(/this\.dmrClearance\.trust\(data\.callId\)/)
		expect(gate).toMatch(/data\.encrypted = trust === "encrypted"/)
		expect(gate).toMatch(
			/data\.encryptionKnown = data\.encrypted \|\| trust === "clear"/,
		)
	})

	it("admits a recording from one rule, at the end and in the late update", () => {
		expect(sites(/\bthis\.recordingLinkable\(/g).map(s => s.method)).toEqual([
			"findWavFileAsync",
			"endCall",
		])
		for (const s of sites(/\bwavFile\s*[:,]/g))
			expect(["findWavFileAsync", "endCall"]).toContain(s.method)
	})

	it("the base class publishes parse results through the overridable emitOutput", () => {
		const base = fs.readFileSync("src/decoders/base-decoder.ts", "utf8")
		expect(base.match(/\bthis\.emit\(\s*["']output["']/g)).toHaveLength(1)
		expect(base).toMatch(
			/const output = this\.parseOutput\(line\)\s*\n\s*if \(output\) this\.emitOutput\(output\)/,
		)
		const parent = fs.readFileSync(
			"src/decoders/audio-demod-decoder.ts",
			"utf8",
		)
		expect(parent).not.toMatch(/\.emit\(\s*["'](?:output|voice-call)["']/)
	})
})

// --- Behavioural: drive each site ---

const M = (k: string) =>
	`00:00:01 Sync: +DMR MS/DM MODE/MONO | Color Code=01 | ${k} `
const B1 = (k: string) =>
	`00:00:01 Sync: +DMR  [SLOT1]  slot2  | Color Code=01 | ${k} `
const LC = (extra = "", tg = 9001, src = 91) =>
	` SLOT 1 TGT=${tg} SRC=${src} Group Call ${extra} `

interface Seen {
	kind: string
	inGate: boolean
	consistent: boolean
	/** The site that handed it to the gate (a method of the adapter, or base:handleOutputLine). */
	site: string
	data: CallData & { wavFile?: string }
}

/** The adapter method that called `callee` (the frame below it in the stack). */
function emitter(stack: string): string {
	const frames = stack.split("\n").slice(1)
	for (let i = frames.length - 2; i >= 0; i--) {
		const f = frames[i]!
		if (
			!/DsdFmeDecoder\.(?:emitOutput|publishCallUpdate) \(.*builtin\/dsd-fme\.ts:/.test(
				f,
			)
		)
			continue
		const caller = frames[i + 1] ?? ""
		const own = /builtin\/dsd-fme\.ts:(\d+):\d+\)?$/.exec(caller)?.[1]
		if (own !== undefined) return methodAt({ line: Number(own) })
		if (/base-decoder\.ts/.test(caller) && /handleOutputLine/.test(caller))
			return "base:handleOutputLine"
		return `?${caller.trim()}`
	}
	return "?"
}

type Internals = {
	handleOutputLine(line: string): void
	checkCallTimeoutAsync(): void
	endOpenCallsForRestart(now: Date): void
	dmrClearance: { trust(id: string): string }
}

const observed = new Set<string>()

function harness(options: Record<string, unknown> = {}) {
	const decoder = createDecoder({ mode: "dmr", ...options })
	const adapter = decoder as unknown as Internals
	const seen: Seen[] = []
	const onPublication = (kind: string, d: CallData & { wavFile?: string }) => {
		if (d.protocol !== "dmr") return
		const stack = new Error().stack ?? ""
		const trust = adapter.dmrClearance.trust(d.callId)
		const encrypted =
			kind === "call_end" ? d.flags?.encrypted === true : d.encrypted === true
		const site = emitter(stack)
		observed.add(site)
		seen.push({
			kind,
			inGate: /DsdFmeDecoder\.publish \(/.test(stack),
			consistent:
				"encryptionKnown" in d &&
				encrypted === (trust === "encrypted") &&
				d.encryptionKnown === (trust === "clear" || trust === "encrypted"),
			site,
			data: d,
		})
	}
	decoder.on("output", (o: DecoderOutput) => {
		if (o.type === "call_start" || o.type === "call_end")
			onPublication(o.type, o.data as CallData)
	})
	decoder.on("voice-call", (v: DsdFmeVoiceCallState) =>
		onPublication("voice-call", v as unknown as CallData),
	)
	const at = (ms: number, line: string) => {
		vi.setSystemTime(T0 + ms)
		adapter.handleOutputLine(line)
	}
	const tick = (ms: number) => {
		vi.setSystemTime(T0 + ms)
		adapter.checkCallTimeoutAsync()
	}
	return { decoder, adapter, seen, at, tick }
}

/** Every publication went through the gate with the clearance's trust, and `site` emitted one. */
function expectGated(seen: Seen[], site: string, kind?: string): void {
	expect(seen.length).toBeGreaterThan(0)
	for (const s of seen) {
		expect(s.inGate).toBe(true)
		expect(s.consistent).toBe(true)
	}
	expect(seen.map(s => `${s.site}:${s.kind}`)).toContain(
		`${site}:${kind ?? seen.find(s => s.site === site)?.kind ?? "any"}`,
	)
}

describe("dsd-fme DMR publication sites (behavioural)", () => {
	let limit: number
	beforeEach(() => {
		limit = Error.stackTraceLimit
		Error.stackTraceLimit = 200
		vi.useFakeTimers({ toFake: ["Date"] })
		vi.setSystemTime(T0)
	})
	afterEach(() => {
		Error.stackTraceLimit = limit
		vi.useRealTimers()
	})

	it("a line announces its call (the parse result) and a settlement updates it (applyDmrTrust)", () => {
		const h = harness({ callStartDelayMs: 0 })
		h.at(0, M("VLC"))
		h.at(1, LC())
		h.at(60, M("VC*"))
		h.at(420, M("VC*"))
		expectGated(h.seen, "base:handleOutputLine", "call_start")
		expectGated(h.seen, "applyDmrTrust", "voice-call")
	})

	it("another talker's trailer ends a held call at its terminator (handleDmrTrainIds)", () => {
		const h = harness({ callStartDelayMs: 0 })
		h.at(0, M("VC*"))
		h.at(60, M("VC*"))
		h.at(61, LC())
		// An error line drops the naming proof: the call does not know it is clear.
		h.at(62, " SLOT 1 FLCO FEC ERR  (FEC ERR)")
		h.at(120, M("VC*"))
		h.at(180, M("TLC"))
		h.at(181, LC("", 9002, 92))
		expectGated(h.seen, "handleDmrTrainIds", "call_end")
		const ends = h.seen.filter(s => s.kind === "call_end")
		expect(ends.map(e => e.data.talkgroup)).toEqual([9001])
		// One copy inside the ended call's train is a rival only; a second
		// agreeing copy is the next talker's call.
		h.at(240, M("TLC"))
		h.at(241, LC("", 9002, 92))
		h.tick(5000)
		// The next talker's train call publishes its IDs too, never known clear.
		const last = h.seen.filter(s => s.kind === "call_end").at(-1)
		expect(last?.data).toMatchObject({
			talkgroup: 9002,
			source: 92,
			encryptionKnown: false,
		})
	})

	it("the timer promotes a pending call and times it out (checkCallTimeoutAsync)", () => {
		const h = harness({ callStartDelayMs: 400 })
		h.at(0, B1("VC1"))
		h.at(60, B1("VC2"))
		h.at(61, LC())
		h.at(120, B1("VC3"))
		h.tick(500)
		h.tick(5000)
		expectGated(h.seen, "checkCallTimeoutAsync", "call_start")
		expectGated(h.seen, "checkCallTimeoutAsync", "call_end")
	})

	it("a line finds the timeout of its lane's call (parseOutput), and an unannounced call starts from its end (endCall)", () => {
		const h = harness({ callStartDelayMs: 5000 })
		h.at(0, M("VLC"))
		h.at(1, LC())
		h.at(60, M("VC*"))
		h.at(5000, M("VC*"))
		expectGated(h.seen, "endCall", "call_start")
		expectGated(h.seen, "parseOutput", "call_end")
	})

	it("a named call's terminator end with its trailer (the parse result)", () => {
		const h = harness()
		h.at(0, M("VLC"))
		h.at(1, LC())
		h.at(60, M("VC*"))
		h.at(420, M("TLC"))
		h.at(421, LC())
		h.at(480, M("IDLE"))
		expectGated(h.seen, "base:handleOutputLine", "call_end")
	})

	it("an unnamed call's held end, closed by the next sync without its trailer (resolveHeldEnd)", () => {
		const h = harness()
		let t = 0
		for (let n = 0; n < 2; n++)
			for (const k of ["VC1", "VC2", "VC3", "VC4", "VC5", "VC6"]) {
				h.at(t, B1(k))
				t += 60
			}
		h.at(t, B1("TLC"))
		h.at(t + 60, B1("IDLE"))
		expectGated(h.seen, "resolveHeldEnd", "call_end")
	})

	it("a protocol switch ends the call (handleSync)", () => {
		const h = harness({ mode: "auto" })
		h.at(0, M("VLC"))
		h.at(1, LC())
		h.at(60, M("VC*"))
		h.at(420, M("VC*"))
		h.at(480, "00:00:01 Sync: +DSTAR VOICE ")
		expectGated(h.seen, "handleSync", "call_end")
	})

	it("a restart ends the call (endOpenCallsForRestart)", () => {
		const h = harness()
		h.at(0, M("VLC"))
		h.at(1, LC())
		h.at(60, M("VC*"))
		h.at(420, M("VC*"))
		vi.setSystemTime(T0 + 430)
		h.adapter.endOpenCallsForRestart(new Date(T0 + 430))
		expectGated(h.seen, "endOpenCallsForRestart", "call_end")
	})

	it("a stop ends the call (stop)", async () => {
		const h = harness()
		h.at(0, M("VLC"))
		h.at(1, LC())
		h.at(60, M("VC*"))
		h.at(420, M("VC*"))
		await h.decoder.stop()
		expectGated(h.seen, "stop", "call_end")
	})

	it("an encrypted print mutes an announced call (markEncrypted)", () => {
		const h = harness()
		h.at(0, B1("VC1"))
		h.at(60, B1("VC2"))
		h.at(61, LC())
		h.at(120, B1("VC3"))
		h.at(180, B1("VC4"))
		h.at(181, LC("Encrypted"))
		expectGated(h.seen, "markEncrypted", "voice-call")
		expect(h.seen.at(-1)?.data.encrypted).toBe(true)
	})
})

describe("dsd-fme recording admission", () => {
	const START = new Date(2026, 0, 9, 10, 53, 27)
	const FILE = "20260109_105327_123_DMR_CC_1_GROUP_TGT_9001_SRC_91.wav"
	let root: string
	beforeEach(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "wk-dmr-admit-"))
		vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] })
		vi.setSystemTime(START)
	})
	afterEach(() => {
		vi.useRealTimers()
		fs.rmSync(root, { recursive: true, force: true })
	})

	/** One header call, optionally encrypted mid-call; the file exists at its end or only later. */
	function call(encrypted: boolean, fileFirst: boolean): Seen[] {
		if (fileFirst) fs.writeFileSync(path.join(root, FILE), "")
		const h = harness({
			enablePerCallRecording: true,
			perCallRecordingDir: root,
			perCallRecordingPrune: false,
		})
		const base = START.getTime() - T0
		h.at(base, M("VLC"))
		h.at(base + 1, LC())
		h.at(base + 60, M("VC*"))
		if (encrypted) h.at(base + 61, LC("Encrypted"))
		h.at(base + 420, M("VC*"))
		h.tick(base + 5000)
		if (!fileFirst) fs.writeFileSync(path.join(root, FILE), "")
		vi.advanceTimersByTime(2000)
		return h.seen
	}

	const linked = (seen: Seen[]) =>
		seen.filter(s => s.kind === "call_end" && s.data.wavFile !== undefined)

	it("links a clear call's file at its end (endCall) only while DMR recordings are on", () => {
		const seen = call(false, true)
		expect(linked(seen).map(s => s.data.flags?.wavFileUpdate)).toEqual(
			DMR_RECORDING_LINK_ENABLED ? [undefined] : [],
		)
		expectGated(seen, "checkCallTimeoutAsync", "call_end")
	})

	it("links a clear call's file found later (findWavFileAsync) only while DMR recordings are on", () => {
		const seen = call(false, false)
		expect(linked(seen).map(s => s.data.flags?.wavFileUpdate)).toEqual(
			DMR_RECORDING_LINK_ENABLED ? [true] : [],
		)
		if (DMR_RECORDING_LINK_ENABLED)
			expectGated(seen, "findWavFileAsync", "call_end")
	})

	it("never links a clear DMR call's file while DMR recordings are off, at its end or later", () => {
		if (DMR_RECORDING_LINK_ENABLED) return
		const now = call(false, true)
		expect(
			now.some(s => s.kind === "call_end" && s.data.encryptionKnown === true),
		).toBe(true)
		expect(linked(now)).toEqual([])
		expect(now.some(s => s.data.flags?.wavFileUpdate === true)).toBe(false)
		fs.rmSync(path.join(root, FILE))
		const later = call(false, false)
		expect(linked(later)).toEqual([])
		expect(later.some(s => s.data.flags?.wavFileUpdate === true)).toBe(false)
	})

	it("never links a known encrypted call's file, at its end or later", () => {
		const now = call(true, true)
		expect(
			now.some(s => s.kind === "call_end" && s.data.flags?.encrypted === true),
		).toBe(true)
		expect(linked(now)).toEqual([])
		fs.rmSync(path.join(root, FILE))
		expect(linked(call(true, false))).toEqual([])
	})
})

// Runs last (tests run in file order): every DMR-capable site named in the scan was driven above.
it("drove every DMR-capable site named in the scan", () => {
	const dmrSites = new Set(
		[...OUTPUT_SITES, ...UPDATE_SITES].filter(s => !NON_DMR_SITES.includes(s)),
	)
	dmrSites.add("base:handleOutputLine")
	expect([...dmrSites].filter(s => !observed.has(s))).toEqual([])
	expect([...observed].filter(s => s.startsWith("?"))).toEqual([])
})
