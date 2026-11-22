/**
 * dsd-fme DMR clearance: a temporal oracle over the real adapter.
 *
 * Lines (modelled on dsd-fme prints, ids synthetic; the recorded fixtures
 * under tests/mocks/fixtures/recorded/dsd-fme-dmr are replayed too) go
 * through the adapter with a fake clock; every call_start, call_end and
 * voice-call publication is collected with the line sequence number it
 * followed. The lifecycle supplies each call id, opening line and ending line.
 * An independent shadow ledger derives evidence from the raw lines
 * (it never calls the clearance module), checks each DMR publication:
 * (a) encryptionKnown is present; (b) when it says clear, a proof chain (link control after voice, naming link, voice header or terminator;
 * a clear ALG print names no key and is never proof)
 * of the current generation backs it, settled before the publication; (c)
 * no privacy print of the lane came before it in that chain's window; (d)
 * the settling line is a sync of the chain's own lane.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import fc from "fast-check"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { DMR_RECORDING_LINK_ENABLED } from "../../../src/decoders/builtin/call-recordings.js"
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

interface Lifetime {
	/** Input sequence and physical lane where the adapter created this callId. */
	born: number
	end: number
	lane: number
}

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
	/** A call's end: its call_end or the voice-call snapshot that mirrors it. */
	ending?: boolean
	/** The call's published start (ms from T0): its first line is at or after it. */
	startedAtMs?: number
}

type LiveCall = { protocol: string | null; callId: string }
type AdapterLane = {
	callState: LiveCall | null
	pendingCall: { state: LiveCall } | null
}

/** Sample synchronously, including paired voice events and delayed WAV updates. */
function auditPublications(decoder: ReturnType<typeof createDecoder>) {
	const adapter = decoder as unknown as AdapterLane & {
		publish(p: DecoderOutput | DsdFmeVoiceCallState): void
		dmrClearance: { has(id: string): boolean; trust(id: string): string }
		lanes: Map<number, AdapterLane>
	}
	const failures: string[] = []
	const sample = () => {
		for (const lane of [adapter, ...adapter.lanes.values()]) {
			for (const call of [lane.callState, lane.pendingCall?.state])
				if (call?.protocol === "dmr" && !adapter.dmrClearance.has(call.callId))
					failures.push("live call without a clearance record")
		}
	}
	let publishing: DecoderOutput | DsdFmeVoiceCallState | undefined
	const publish = adapter.publish.bind(adapter)
	vi.spyOn(adapter, "publish").mockImplementation(p => {
		// Simulate stale cached fields on every path, including terminal flags.
		const data = "active" in p ? p : (p.data as CallData)
		if (data?.protocol === "dmr" && data.callId) {
			const trust = adapter.dmrClearance.trust(data.callId)
			data.encrypted = trust !== "encrypted"
			data.encryptionKnown = trust !== "clear" && trust !== "encrypted"
			if ("flags" in data && data.flags)
				data.flags = { ...data.flags, encrypted: data.encrypted }
		}
		const previous = publishing
		publishing = p
		try {
			publish(p)
		} finally {
			publishing = previous
		}
	})
	function check(p: DecoderOutput | DsdFmeVoiceCallState) {
		sample()
		const d = "active" in p ? p : (p.data as CallData & { encrypted?: boolean })
		if (d?.protocol !== "dmr" || !d.callId) return
		const trust = adapter.dmrClearance.trust(d.callId)
		if (
			p !== publishing ||
			!adapter.dmrClearance.has(d.callId) ||
			d.encrypted !== (trust === "encrypted") ||
			d.encryptionKnown !== (trust === "clear" || trust === "encrypted") ||
			("flags" in d && d.flags && d.flags.encrypted !== d.encrypted)
		)
			failures.push("publication outside gate or inconsistent with record")
	}
	decoder.on("output", check)
	decoder.on("voice-call", check)
	return { failures, sample }
}

/** Replays items (10 ms steps, the 500 ms timer), recording each publication's line seq. */
function replayTrace(items: Item[]) {
	const decoder = createDecoder({ mode: "dmr" })
	const internals = decoder as unknown as {
		handleOutputLine(line: string): void
		checkCallTimeoutAsync(): void
		endOpenCallsForRestart(now: Date): void
	}
	const { failures, sample } = auditPublications(decoder)
	const lives = new Map<string, Lifetime>()
	const byLane = new Map<number, Lifetime>()
	const lifecycle = decoder as unknown as {
		laneKey: number
		callState: { callId: string } | null
		endCall(...args: unknown[]): DecoderOutput | null
		startPendingCall(...args: unknown[]): { callId: string }
	}
	const open = lifecycle.startPendingCall.bind(lifecycle)
	vi.spyOn(lifecycle, "startPendingCall").mockImplementation((...args) => {
		const call = open(...args)
		const lane = lifecycle.laneKey
		const previous = byLane.get(lane)
		if (previous && previous.end === Infinity) previous.end = seq
		const life = { born: Math.floor(seq), end: Infinity, lane }
		lives.set(call.callId, life)
		byLane.set(lane, life)
		return call
	})
	const end = lifecycle.endCall.bind(lifecycle)
	vi.spyOn(lifecycle, "endCall").mockImplementation((...args) => {
		const call = lifecycle.callState
		if (call) {
			const life = lives.get(call.callId)
			if (life) life.end = seq
		}
		return end(...args)
	})
	const pubs: Publication[] = []
	let seq = 0
	decoder.on("output", (o: DecoderOutput) => {
		if (o.type !== "call_start" && o.type !== "call_end") return
		// A late recording update (wavFileUpdate) is a publication too.
		const d = o.data as CallData & { encrypted?: boolean }
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
			ending: o.type === "call_end",
			startedAtMs: Date.parse(d.startedAt) - T0,
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
			ending: !v.active,
			startedAtMs: Date.parse(v.startedAt) - T0,
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
			sample()
			index++
		}
		vi.setSystemTime(T0 + now)
		seq = index + 0.5
		if (now % 500 === 0) {
			internals.checkCallTimeoutAsync()
			sample()
		}
	}
	expect(failures).toEqual([])
	items.splice(0, items.length, ...sorted)
	const check = (...injected: Publication[]) =>
		oracle(items, [...pubs, ...injected], lives)
	expect(check()).toEqual([])
	return { pubs, check }
}

function run(items: Item[]): Publication[] {
	return replayTrace(items).pubs
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
	/** A clean clear-algorithm print: keyless, so never a proof of the lane's call. */
	alg: boolean
	/** The slot a repeater line printed, when it is not its burst's. */
	printed: string | undefined
	generation: number
	/** Bumped only by a restart or another protocol (a BS/MS change keeps the call's name). */
	hard: number
	/**
	 * Each proof lane's call epoch after this line: a new call begins on a
	 * gap over the call timeout, the first voice burst after a terminator, a
	 * rival's second checked copy, a restart, another protocol or a BS/MS
	 * change.
	 */
	epochs: Record<string, number>
}

const PROOF_LANES: readonly string[] = ["1", "2", "ms"]

/** Adds each line's per-lane call epochs (call boundaries) to the ledger. */
function withEpochs(lines: Omit<Shadow, "epochs">[]): Shadow[] {
	const epoch: Record<string, number> = { "1": 0, "2": 0, ms: 0 }
	const lastAt: Record<string, number | undefined> = {}
	const afterTlc: Record<string, boolean> = {}
	const lastVoice: Record<string, number | undefined> = {}
	const lastKey: Record<string, string | undefined> = {}
	const rival: Record<string, { key: string; burst: number } | undefined> = {}
	const bump = (lane: string) => {
		epoch[lane] = (epoch[lane] ?? 0) + 1
		afterTlc[lane] = false
		lastKey[lane] = undefined
		rival[lane] = undefined
	}
	let generation = 0
	let burst = 0
	const out: Shadow[] = []
	for (const line of lines) {
		if (line.lane === "-" || line.generation !== generation) {
			for (const lane of PROOF_LANES) bump(lane)
			generation = line.generation
		}
		const lane = line.lane
		if (PROOF_LANES.includes(lane)) {
			const last = lastAt[lane]
			if (last !== undefined && line.atMs - last > TIMEOUT_MS) bump(lane)
			lastAt[lane] = line.atMs
			if (line.sync) {
				burst++
				if ((line.kind === "voice" || line.kind === "vlc") && afterTlc[lane])
					bump(lane)
				if (line.kind === "tlc") afterTlc[lane] = true
				lastVoice[lane] = line.kind === "voice" ? burst : undefined
			} else if (
				line.key !== undefined &&
				!line.errored &&
				line.plausible &&
				lastVoice[lane] !== undefined
			) {
				const known = lastKey[lane]
				const voice = lastVoice[lane] ?? 0
				if (known === undefined || known === line.key) {
					lastKey[lane] = line.key
					rival[lane] = undefined
				} else {
					const first = rival[lane]
					if (first?.key === line.key && first.burst !== voice) {
						bump(lane)
						lastKey[lane] = line.key
					} else rival[lane] = { key: line.key, burst: voice }
				}
			}
		}
		out.push({ ...line, epochs: { ...epoch } })
	}
	return out
}

function shadow(items: Item[]): Shadow[] {
	return withEpochs(ledger(items))
}

function ledger(items: Item[]): Omit<Shadow, "epochs">[] {
	let format: string | undefined
	let slot = "1"
	let mode: string | undefined
	let generation = 0
	let hard = 0
	return items.map(([atMs, text], i): Omit<Shadow, "epochs"> => {
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
			printed: undefined,
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
					? /\|\s*PI\b/.test(text)
						? "pi"
						: "other"
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
		// A repeater line belongs to its latest bracketed sync's lane; one
		// printing another slot, and a "DMR Voice" print, prove nothing.
		const said = /\bSLOT\s+([12])\b/i.exec(text)?.[1]
		const lane = format === "bs" ? slot : format === "ms" ? "ms" : "x"
		const other = format === "bs" && said !== undefined && said !== slot
		const ids =
			other || /\bDMR\s+Voice\b/i.test(text)
				? undefined
				: (/TGT[:=]\s*(\d+)\b.*SRC[:=]\s*(\d+)/i.exec(text) ?? undefined)
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
			printed: other ? said : undefined,
			alg:
				!other &&
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
/** A call's proof binding: the lane and call epoch its first clear chain was on. */
interface Binding {
	lane: string
	epoch: number
	/** The chain's link control line: owned by one callId. */
	lcSeq: number
}

/** What the ledger knows of the publication's call. */
interface CallContext {
	firstSeq: number
	startedAtMs: number | undefined
	bound: Binding | undefined
	/** Chains already owned: lc line seq to callId. */
	owner: ReadonlyMap<number, string>
	lifetime?: Lifetime | undefined
}

/**
 * Whether a clear publication P is backed by a settled chain of its own
 * call (checks b, c, d). `firstSeq` is the call's first publication (its
 * call_start); `bound` the lane and epoch an earlier clear of the call
 * used. Returns the chain's binding, or null.
 */
function backed(
	lines: Shadow[],
	p: Publication,
	context: Partial<CallContext> = {},
): Binding | null {
	const firstSeq = context.firstSeq ?? p.seq
	const bound = context.bound
	const startedAtMs = context.startedAtMs ?? p.startedAtMs
	const key =
		p.talkgroup === null || p.source === null
			? undefined
			: `${p.talkgroup}/${p.source}`
	const pIndex = Math.min(Math.floor(p.seq), lines.length) - 1
	const atLine = lines[pIndex]
	if (!atLine || atLine.lane === "-") return null
	const genAt = atLine.generation
	const lanes =
		p.slot === 1 || p.slot === 2 ? [String(p.slot), "ms"] : ["ms", "1", "2"]
	for (const l of lines) {
		if (l.seq >= p.seq) break
		// Exclusive ownership: a chain that backed one call backs no other.
		const owned = context.owner?.get(l.seq)
		if (context.owner && owned !== p.callId) continue
		if (
			l.sync ||
			l.errored ||
			l.privacy ||
			l.alg ||
			key === undefined ||
			l.key !== key ||
			!l.plausible ||
			l.generation !== genAt ||
			!lanes.includes(l.lane)
		)
			continue
		const life = context.lifetime
		if (
			life &&
			(l.seq < life.born ||
				l.lane !== (life.lane === 0 ? "ms" : String(life.lane)))
		)
			continue
		if (
			life?.lane === 0 &&
			lines.some(x => x.seq >= life.born && x.seq < p.seq && x.lane === "x")
		)
			continue
		const lane = lines.filter(x => x.lane === l.lane && x.generation === genAt)
		const s = [...lane].reverse().find(x => x.sync && x.seq < l.seq)
		const t = lane.find(x => x.sync && x.seq > l.seq)
		if (s === undefined || t === undefined || t.seq >= p.seq) continue
		const epoch = l.epochs[l.lane]
		const firstIndex = Math.min(Math.floor(firstSeq), lines.length) - 1
		if (
			epoch === undefined ||
			s.epochs[l.lane] !== epoch ||
			t.epochs[l.lane] !== epoch ||
			atLine.epochs[l.lane] !== epoch ||
			lines[firstIndex]?.epochs[l.lane] !== epoch ||
			(bound !== undefined && (bound.lane !== l.lane || bound.epoch !== epoch))
		)
			continue
		// The call's own life: its lane's lines from the first of its epoch.
		const laneStart =
			lines.find(
				x =>
					x.lane === l.lane &&
					x.generation === genAt &&
					x.epochs[l.lane] === epoch,
			)?.seq ?? s.seq
		// The call's first line on any lane (an unplaced one included): its
		// published start is at or before it.
		const openedAt =
			startedAtMs === undefined
				? undefined
				: lines.find(x => x.atMs >= startedAtMs)?.seq
		const callStart = life?.born ?? Math.min(laneStart, openedAt ?? laneStart)
		if (s.errored || !["vlc", "voice", "tlc"].includes(s.kind)) continue
		// The burst's first link control.
		if (lane.some(x => x.key !== undefined && x.seq > s.seq && x.seq < l.seq))
			continue
		if (t.errored || t.privacy || t.format !== s.format) continue
		if (t.atMs - l.atMs > TIMEOUT_MS) continue
		if (s.kind === "vlc" && t.kind !== "voice" && t.kind !== "vlc") continue
		// terminator needs the call named by an earlier link control of its key (naming-link
		// lets the first LC after voice name and prove a frames call).
		if (
			s.kind === "tlc" &&
			!lines.some(
				x =>
					x.lane === l.lane &&
					x.epochs[l.lane] === epoch &&
					x.seq >= callStart &&
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
		// (c) no privacy print of the lane (an unplaced one, or another
		// slot's naming it) in the call's whole life before P.
		const window = lines.filter(
			x =>
				x.seq >= callStart &&
				x.seq < p.seq &&
				(x.lane === l.lane || x.lane === "x" || x.printed === l.lane),
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
		return { lane: l.lane, epoch, lcSeq: l.seq }
	}
	return null
}

/** Checks (a)-(d) on every DMR publication; returns the failures. */
function oracle(
	items: Item[],
	pubs: Publication[],
	lives: ReadonlyMap<string, Lifetime>,
): string[] {
	const lines = shadow(items)
	const failures: string[] = []
	// The ledger per published callId: its first publication, its binding,
	// and whether it was published encrypted (sticky for its life).
	const first = new Map<string, number>()
	const started = new Map<string, number | undefined>()
	const owner = new Map<number, string>()
	// Assign every candidate print in an observed call lifetime to that id,
	// including unused chains and calls that never publish clear.
	for (const [id, life] of lives) {
		const lane = life.lane === 0 ? "ms" : String(life.lane)
		for (const line of lines) {
			if (line.seq >= life.born && line.seq < life.end && line.lane === lane)
				owner.set(line.seq, id)
		}
	}
	const binding = new Map<string, Binding>()
	const encrypted = new Set<string>()
	for (const p of [...pubs].sort((a, b) => a.seq - b.seq)) {
		if (p.protocol !== "dmr") continue
		if (!first.has(p.callId)) {
			first.set(p.callId, p.seq)
			started.set(p.callId, p.startedAtMs)
		}
		if (!p.hasField || typeof p.encryptionKnown !== "boolean")
			failures.push(`(a) ${p.kind} at ${p.seq} omits encryptionKnown`)
		if (p.encrypted) encrypted.add(p.callId)
		// Clear (encrypted === false && encryptionKnown !== false) requires
		// evidence; encrypted with encryptionKnown true is known encrypted.
		const clear = !p.encrypted && p.encryptionKnown !== false
		if (!clear) continue
		if (encrypted.has(p.callId)) {
			failures.push(`(c) ${p.kind} at ${p.seq} clear after encrypted`)
			continue
		}
		const life = lives.get(p.callId)
		if (!life || p.seq < life.born || p.seq > life.end) {
			failures.push(`(b) ${p.kind} at ${p.seq} clear outside call lifetime`)
			continue
		}
		const bound = binding.get(p.callId)
		const chain = backed(lines, p, {
			firstSeq: first.get(p.callId) ?? p.seq,
			startedAtMs: started.get(p.callId),
			...(bound !== undefined ? { bound } : {}),
			owner,
			lifetime: life,
		})
		if (chain === null)
			failures.push(`(b-d) ${p.kind} at ${p.seq} clear without a settled chain`)
		else {
			binding.set(p.callId, chain)
		}
	}
	return failures
}

/** Challenge the latest call at the last input, before a later timeout publication. */
function challenge(trace: ReturnType<typeof replayTrace>, seq: number) {
	const { pubs, check } = trace
	const call = pubs.filter(p => p.protocol === "dmr").at(-1)
	const forged: Publication = {
		kind: "voice-call",
		callId: call?.callId ?? "absent",
		protocol: "dmr",
		talkgroup: call?.talkgroup ?? 9001,
		source: call?.source ?? 91,
		slot: call?.slot ?? 1,
		seq,
		hasField: true,
		encrypted: false,
		encryptionKnown: true,
	}
	expect(check(forged)).not.toEqual([])
}

/** No publication from line `fromSeq` on is clear, and the oracle holds. */
function expectNotClearFrom(items: Item[], fromSeq: number): void {
	const trace = replayTrace(items)
	const { pubs } = trace
	const after = pubs.filter(p => p.protocol === "dmr" && p.seq >= fromSeq)
	expect(after.some(p => !p.encrypted && p.encryptionKnown !== false)).toBe(
		false,
	)
	challenge(trace, items.length + 0.25)
}

/** No publication is clear (or omits the field), and the oracle holds. */
function expectNeverClear(items: Item[]): Publication[] {
	const trace = replayTrace(items)
	const { pubs } = trace
	const dmr = pubs.filter(p => p.protocol === "dmr")
	expect(dmr.every(p => p.hasField)).toBe(true)
	expect(dmr.some(p => !p.encrypted && p.encryptionKnown !== false)).toBe(false)
	challenge(trace, items.length + 0.25)
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
	// The naming LC would be the call's naming-link proof; its burst's late error kills it.
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

	it("routes every adapter output and voice-call emission through publish", () => {
		const source = readFileSync("src/decoders/builtin/dsd-fme.ts", "utf8")
		const body = source.match(/\n\tprivate publish\([\s\S]+?\n\t\}/)?.[0]
		expect(body).toBeDefined()
		const sinks =
			/(?:this|super)\.(?:emit\(\s*["'](?:voice-call|output)["']|outputStream\.write\()|super\.emitOutput\(/g
		expect(body?.match(sinks)).toHaveLength(2)
		expect(source.replace(body!, "")).not.toMatch(sinks)
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
			const named: Item[] = [
				...NAMED_BS,
				[180, BS(1, "VC4")],
				[181, LC()],
				[240, BS(1, "VC5")],
			]
			const named2 = run(named)
			expect(everClear(named2)).toBe(true)
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
			).toBeNull()
		})
	})

	describe("bypass shapes never publish clear", () => {
		const voice: Item[] = [
			[0, BS(1, "VC1")],
			[60, BS(1, "VC2")],
		]
		const proven: Item[] = [...voice, [61, LC()], [180, BS(1, "VC3")]]
		const directCases: [string, Item[], number][] = [
			[
				"unsettled header followed by FEC",
				[
					[0, MS("VLC")],
					[1, LC()],
					[110, "SLCO NULL"],
					[120, "(FEC ERR)"],
				],
				1,
			],
			[
				"voice metadata alone after restart",
				[
					[0, RESTART],
					[1, "DMR Voice TGT: 9001; SRC: 91;"],
				],
				1,
			],
			[
				"stale header followed by a bare sync",
				[
					[0, MS("VLC")],
					[10, "Sync: +DSTAR VOICE"],
					[20, "Sync: +DMR"],
					[21, LC()],
					[130, "SLCO NULL"],
				],
				1,
			],
			[
				"dirty second voice sync",
				[
					[0, BS(1, "VC1")],
					[60, BS(1, "VC2 (FEC ERR)")],
					[61, LC()],
					[180, BS(1, "VC3")],
				],
				1,
			],
			[
				"AMBE error after first naming LC",
				[...voice, [61, LC()], [62, "AMBE (FEC ERR)"], [180, BS(1, "VC3")]],
				1,
			],
			[
				"privacy in a failed CRC",
				[...proven, [200, LC(1, 9001, 91, "Encrypted (CRC ERR)")]],
				5,
			],
			[
				"privacy after PI",
				[...proven, [200, BS(1, "PI")], [201, LC(1, 9001, 91, "Encrypted")]],
				6,
			],
			[
				"encrypted rival followed by original LC",
				[
					...proven,
					[200, LC(1, 9002, 92, "Encrypted")],
					[201, LC()],
					[240, BS(1, "VC4")],
				],
				5,
			],
			[
				"standalone SVC in naming LC",
				[...voice, [61, LC(1, 9001, 91, "SVC=0x40")], [180, BS(1, "VC3")]],
				1,
			],
		]
		it.each(directCases)("%s", (_name, items, from) =>
			expectNotClearFrom(items, from),
		)

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
			// Without the late error the header call settles on its voice (voice-header).
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
			// The exact short shape: its naming LC is its naming-link proof (clear at
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

		it("a frames call is clear from its first clean voice LC (naming-link), never from a clear ALG print", () => {
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
				// A clear ALG print names no key: it cannot be bound to the call.
				expect(everClear(pubs)).toBe(proof.includes("TGT"))
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
				// Kills the naming LC's own naming-link proof: the LC at 721 is the proof.
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

	describe("unplaced calls (opened with no slot lane)", () => {
		const X = (burst: string) =>
			`00:00:01 Sync: +DMR   slot1   slot2  | Color Code=01 | ${burst} `
		const unplaced = (print: string): Item[] => [
			[0, "Sync: +DMR"],
			[1, LC()],
			[110, " SLCO NULL "],
			[120, X("IDLE")],
			[121, print],
			[180, MS("VC*")],
			[181, LC()],
			[240, MS("VC*")],
		]
		const PRINTS = [
			" SLOT 1 TGT=9001 SRC=91 SVC=0x40 Group Call ",
			" SLOT 1 TGT=9001 SRC=91 Group Call Encrypted (CRC ERR) ",
		]

		it("a call opened after a bare sync is recorded, never clear, and a bracketless privacy print mutes it", () => {
			for (const print of PRINTS) {
				const pubs = expectNeverClear(unplaced(print))
				expect(pubs.some(p => p.encrypted)).toBe(true)
			}
		})

		it("even with no privacy print, a call that was ever unplaced never clears", () => {
			expectNeverClear(unplaced(" SLCO NULL "))
		})

		it("the oracle rejects a clear injected into the unplaced call after the privacy print", () => {
			for (const print of PRINTS) {
				const items = unplaced(print)
				const { pubs, check } = replayTrace(items)
				const real = pubs.find(p => p.protocol === "dmr")
				expect(real).toBeDefined()
				const injected: Publication = {
					...real!,
					seq: 8.3,
					kind: "voice-call",
					encrypted: false,
					encryptionKnown: true,
					talkgroup: 9001,
					source: 91,
				}
				expect(check(injected).length).toBeGreaterThan(0)
			}
		})

		it("the oracle rejects a clear under another callId that borrows a call's chain", () => {
			const items: Item[] = [
				[0, MS("VLC")],
				[1, LC()],
				[60, MS("VC*")],
				[420, MS("VC*")],
			]
			const { pubs, check } = replayTrace(items)
			const real = pubs.find(p => !p.encrypted && p.encryptionKnown === true)
			expect(real).toBeDefined()
			const borrowed: Publication = { ...real!, seq: 4.3, callId: "other" }
			expect(check(borrowed).length).toBeGreaterThan(0)
		})

		it("an unplaced termination revokes before the end and its voice snapshot", () => {
			const items: Item[] = [
				[0, MS("VLC")],
				[1, LC()],
				[60, MS("VC*")],
				[420, MS("VC*")],
				[480, "Sync: +DMR Call Termination"],
			]
			const pubs = run(items)
			expect(everClear(pubs.filter(p => p.seq < 5))).toBe(true)
			expect(
				pubs.filter(p => p.seq === 5.25 && p.ending).map(p => p.kind),
			).toEqual(["call_end", "voice-call"])
			expectNotClearFrom(items, 5)
		})

		it("a restart announces and ends the pending call while its record is live", () => {
			const items: Item[] = [
				[0, MS("VLC")],
				[1, LC()],
				[60, MS("VC*")],
				[80, RESTART],
			]
			const pubs = expectNeverClear(items)
			expect(pubs.filter(p => p.seq === 4.25).map(p => p.kind)).toEqual([
				"call_start",
				"voice-call",
				"call_end",
				"voice-call",
			])
		})

		it("the second settled LC in a live call cannot back another id either", () => {
			const items: Item[] = [
				[0, MS("VLC")],
				[1, LC()],
				[60, MS("VC*")],
				[420, MS("VC*")],
				[421, LC()],
				[780, MS("VC*")],
			]
			const { pubs, check } = replayTrace(items)
			const clear = pubs.find(p => !p.encrypted && p.encryptionKnown)
			expect(clear).toBeDefined()
			const other = { ...clear!, callId: "other", seq: 6.3 }
			expect(pubs.some(p => p.callId === other.callId)).toBe(false)
			expect(check(other)).not.toEqual([])
		})
	})

	describe("further bypass shapes: the adapter never publishes clear and the oracle rejects a forged clear", () => {
		const X = (burst: string) =>
			`00:00:01 Sync: +DMR   slot1   slot2  | Color Code=01 | ${burst} `
		/** A forged clear publication of call `callId` (9001/91) after line `seq`. */
		const forged = (
			seq: number,
			slot: number,
			callId = "forged",
		): Publication => ({
			seq,
			kind: "voice-call",
			callId,
			protocol: "dmr",
			talkgroup: 9001,
			source: 91,
			slot,
			encrypted: false,
			encryptionKnown: true,
			hasField: true,
		})
		const expectForgedRejected = (items: Item[], fake: Publication[]) => {
			const lines = [...items]
			const { check } = replayTrace(lines)
			for (const p of fake.filter(p => p.encryptionKnown))
				expect(check(p)).not.toEqual([])
		}

		it("another talker's encrypted link control right after a header call's first voice: its privacy lands before any announcement", () => {
			for (const print of [
				" SLOT 1 TGT=9002 SRC=92 Group Call Encrypted ",
				" SLOT 1 TGT=9002 SRC=92 SVC=0x40 Group Call ",
			]) {
				const items: Item[] = [
					[0, BS(1, "VLC")],
					[1, LC()],
					[60, BS(1, "VC1")],
					[110, print],
					[120, BS(1, "VC2")],
				]
				expectNotClearFrom(items, 4)
				// Never a clear snapshot after an encrypted one of the same call.
				const pubs = run([...items])
				const firstEncrypted = pubs.findIndex(p => p.encrypted)
				expect(
					pubs
						.slice(firstEncrypted < 0 ? pubs.length : firstEncrypted)
						.some(p => !p.encrypted && p.encryptionKnown !== false),
				).toBe(false)
				expectForgedRejected(items, [forged(4.25, 1), forged(5.25, 1)])
			}
		})

		it("a DMR Voice print naming a frames call is metadata, never proof", () => {
			const items: Item[] = [
				[0, BS(1, "VC1")],
				[60, BS(1, "VC2")],
				[61, " DMR Voice TGT: 9001; SRC: 91; "],
				[120, BS(1, "VC3")],
				[240, BS(1, "VC4")],
			]
			expectNeverClear(items)
			expectForgedRejected(items, [forged(4.25, 1), forged(5.25, 1)])
		})

		it("a link control or clear algorithm print of another slot than its burst's proves nothing on either slot", () => {
			for (const print of [LC(), " SLOT 1 ALG ID: 00; KEY ID: 00;"]) {
				const items: Item[] = [
					[0, BS(1, "VLC")],
					[1, LC()],
					[2, " (FEC ERR) "],
					[60, BS(1, "VC1")],
					[80, BS(2, "VC1")],
					[81, print],
					[120, BS(1, "VC2")],
					[240, BS(1, "VC3")],
				]
				expectNeverClear(items)
				expectForgedRejected(items, [forged(7.25, 1), forged(8.25, 1)])
			}
		})

		it("a privacy print after a bracketless burst mutes a live direct call (fail closed)", () => {
			for (const print of [
				" SLOT 1 TGT=9001 SRC=91 SVC=0x40 Group Call ",
				" SLOT 1 TGT=9001 SRC=91 Group Call Encrypted (CRC ERR) ",
			]) {
				const items: Item[] = [
					[0, MS("VLC")],
					[1, LC()],
					[60, MS("VC*")],
					[180, MS("VC*")],
					[200, X("IDLE")],
					[201, print],
					[240, MS("VC*")],
				]
				expectNotClearFrom(items, 6)
				expectForgedRejected(items, [forged(3.25, 1), forged(7.25, 1)])
			}
		})

		it("the oracle keeps privacy sticky for the call's whole life, before its proof's burst too", () => {
			const items: Item[] = [
				[0, BS(1, "VC1")],
				[60, BS(1, "VC2")],
				[61, LC(1, 9001, 91, "Encrypted")],
				[120, BS(1, "VC3")],
				[121, LC()],
				[180, BS(1, "VC4")],
			]
			expectNeverClear(items)
			expectForgedRejected(items, [forged(2.25, 1), forged(6.25, 1)])
		})

		it("the oracle keeps a terminator's naming call-local: a later call never borrows an earlier one's name", () => {
			const items: Item[] = [
				[0, MS("VLC")],
				[1, LC()],
				[60, MS("VC*")],
				[420, MS("TLC")],
				[5420, MS("VC*")],
				[5780, MS("VC*")],
				[6140, MS("TLC")],
				[6141, LC()],
				[6200, MS("IDLE")],
			]
			expectNotClearFrom(items, 5)
			expectForgedRejected(items, [
				{ ...forged(6.25, 1, "second"), encryptionKnown: false },
				forged(9.25, 1, "second"),
			])
		})

		it("the oracle binds a clear to its published call: another callId never borrows a chain", () => {
			const items: Item[] = [
				[0, MS("VLC")],
				[1, LC()],
				[60, MS("VC*")],
				[420, MS("VC*")],
			]
			const { pubs, check } = replayTrace(items)
			const original = pubs.find(p => p.encryptionKnown && !p.encrypted)!
			expect(check({ ...original, seq: 4.3 })).toEqual([])
			expect(check({ ...original, seq: 4.3, callId: "other" })).not.toEqual([])
			expect(
				check(
					{ ...original, seq: 4.28, encrypted: true },
					{ ...original, seq: 4.3 },
				),
			).not.toEqual([])
		})
	})

	describe("one call's proof never backs another", () => {
		const twoCalls = (named: boolean): Item[] => [
			[0, MS("VC*")],
			[360, MS("VC*")],
			[361, LC()],
			[720, MS("VC*")],
			// A gap over the call timeout: the next frames are another call.
			[5220, MS("VC*")],
			[5580, MS("VC*")],
			...(named
				? ([
						[5581, LC()],
						[5582, " (FEC ERR) "],
					] as Item[])
				: []),
			[5940, MS("VC*")],
			[6300, MS("VC*")],
		]

		it("a call cleared by its own link control, a gap over the call timeout, then a frames call: the second is never clear", () => {
			for (const named of [false, true]) {
				const items = twoCalls(named)
				const pubs = run(items)
				// The first call clears on its own (its naming link control).
				expect(everClear(pubs.filter(p => p.seq < 5))).toBe(true)
				expectNotClearFrom(twoCalls(named), 5)
			}
		})

		it("the ledger does not back the second call's clear with the first call's chain", () => {
			const lines = shadow(twoCalls(true))
			const claim = (seq: number): Publication => ({
				seq,
				kind: "voice-call",
				callId: "second",
				protocol: "dmr",
				talkgroup: 9001,
				source: 91,
				slot: 1,
				encrypted: false,
				encryptionKnown: true,
				hasField: true,
			})
			// The first call's own clear (after its settling sync, line 4) is backed.
			expect(backed(lines, claim(4.25))).not.toBeNull()
			expect(backed(lines, claim(9.5))).toBeNull()
			// A forged clear first published on the new call's first line.
			for (const named of [false, true]) {
				const items = twoCalls(named)
				const { check } = replayTrace(items)
				const forgedNew: Publication = { ...claim(5.25), callId: "new" }
				expect(check(forgedNew).length).toBeGreaterThan(0)
			}
		})
	})

	describe("late recording update", () => {
		it("the call_end that links a recording found late carries encryptionKnown (none while DMR recordings are off)", async () => {
			const dir = mkdtempSync(join(tmpdir(), "wk-dmr-clearance-"))
			try {
				const decoder = createDecoder({
					mode: "dmr",
					enablePerCallRecording: true,
					perCallRecordingDir: dir,
					perCallRecordingPrune: false,
				})
				const { failures } = auditPublications(decoder)
				const ends: CallData[] = []
				decoder.on("output", (o: DecoderOutput) => {
					if (o.type === "call_end") ends.push(o.data as CallData)
				})
				const internals = decoder as unknown as {
					handleOutputLine(line: string): void
				}
				const lines: Item[] = [
					[0, MS("VLC")],
					[1, LC()],
					[60, MS("VC*")],
					[420, MS("VC*")],
					[780, MS("TLC")],
				]
				for (const [atMs, text] of lines) {
					vi.setSystemTime(T0 + atMs)
					internals.handleOutputLine(text)
				}
				expect(ends).toHaveLength(1)
				expect(ends[0]!.encryptionKnown).toBe(true)
				// dsd-fme closes the recording after the call_end: the async
				// search (200 ms retries, 5 tries) finds it and publishes again.
				const start = new Date(Date.parse(ends[0]!.startedAt))
				const two = (n: number) => String(n).padStart(2, "0")
				const stamp = `${start.getFullYear()}${two(start.getMonth() + 1)}${two(start.getDate())}_${two(start.getHours())}${two(start.getMinutes())}${two(start.getSeconds())}`
				writeFileSync(
					join(dir, `${stamp}_123_DMR_CC_1_GROUP_TGT_9001_SRC_91.wav`),
					"",
				)
				await new Promise(resolve => setTimeout(resolve, 700))
				const update = ends.find(e => e.flags?.wavFileUpdate === true)
				if (DMR_RECORDING_LINK_ENABLED) {
					expect(update).toBeDefined()
					expect(update).toMatchObject({ encryptionKnown: true })
				} else expect(update).toBeUndefined()
				expect(failures).toEqual([])
			} finally {
				rmSync(dir, { recursive: true, force: true })
			}
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
				replayTrace(items)
			})
	})

	it("property: every DMR publication carries encryptionKnown and every clear one has a settled chain", () => {
		// Feature: dmr-clearance, Property 1: known clear only on a settled proof of the call's own
		// Validates: a call is known clear only from settled evidence of its own (bypass shapes, protocol switches, restarts, timeouts, clumps, BS/MS mixes)
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
					replayTrace(items)
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
