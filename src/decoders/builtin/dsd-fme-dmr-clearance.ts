/**
 * DMR clearance: whether a DMR call is known clear (its voice may play).
 *
 * A pure per-lane state machine (no I/O, no timers). The adapter
 * (dsd-fme.ts) classifies every dsd-fme line (classify), feeds it here with
 * its line sequence number and monotonic time (line), then reports the
 * lane's call after its own call lifecycle ran on that line (call). The
 * machine answers with trust decisions for call ids; `clear` below is the
 * only place a call becomes CLEAR.
 *
 * Lanes: a repeater (BS) slot "1" or "2" (its sync bracketed), the direct
 * (MS/DM) channel "ms", and "x" for a BS sync that brackets no slot (or a
 * bare "Sync: +DMR", or any line before a DMR sync): "x" never opens,
 * names, proves or settles anything; its error marks every open burst
 * errored.
 *
 * Proof kinds, each settled only by `clear` on the lane's next clean sync
 * of the same format, with no error anywhere in the burst from its opening
 * sync to that settling sync, inside callTimeoutMs of the link control:
 * - P1: a checked link control equal to the named call's key, in a clean
 *   voice burst at or after the call's first voice burst;
 * - P2: a checked link control in a clean voice LC header burst, naming the
 *   call it opens (or its own key); settled by the next voice burst or
 *   header;
 * - P3: a named call's own key in its clean terminator's trailer.
 *
 * Any privacy field (Encrypted, an SVC privacy bit, a non-clear ALG, a
 * non-zero KEY ID) on any line of the lane makes the lane's call encrypted,
 * for good. Ordering uses sequence numbers only; elapsed time only expires.
 */

/** The plausible DMR IDs (24-bit; the top 800 source addresses are reserved). */
export const DMR_TALKGROUP_MAX = 0xffffff
export const DMR_SOURCE_MAX = DMR_TALKGROUP_MAX - 800

export type DmrLane = "1" | "2" | "ms" | "x"
export type DmrFormat = "bs" | "ms" | "x"
export type DmrBurstKind = "vlc" | "voice" | "tlc" | "other" | "bare"
export type DmrProofKind = "P1" | "P1n" | "P2" | "P3" | "ALG"
export type DmrLaneTrust = "unknown" | "pending" | "clear" | "encrypted"

/** A DMR sync line of a lane. */
export interface DmrSyncEvent {
	type: "sync"
	lane: DmrLane
	format: DmrFormat
	burst: DmrBurstKind
	/** The sync printed no error (no FEC/CRC/RAS error, no Frame Sync Err). */
	clean: boolean
	privacy: boolean
}

/** Another protocol's sync. */
export interface DmrForeignEvent {
	type: "foreign"
}

/** A link control (TGT/SRC) line. */
export interface DmrLcEvent {
	type: "lc"
	lane: DmrLane
	key: string
	errored: boolean
	plausible: boolean
	privacy: boolean
	/** The slot the line printed (attributes an "x" line's privacy). */
	slot: "1" | "2" | undefined
}

/** Any other line. */
export interface DmrOtherEvent {
	type: "line"
	lane: DmrLane
	errored: boolean
	privacy: boolean
	/** An allowlisted line that neither settles nor drops a proof. */
	neutral: boolean
	/** A clean PI / late-entry print of a clear algorithm (ALG 00 or 80). */
	clearAlg: boolean
	slot: "1" | "2" | undefined
}

/** One classified dsd-fme line, routed to its lane. */
export type DmrLineEvent =
	| DmrSyncEvent
	| DmrForeignEvent
	| DmrLcEvent
	| DmrOtherEvent

export interface DmrEvidence {
	kind: DmrProofKind
	decoderGeneration: number
	modeGeneration: number
	lane: DmrLane
	format: DmrFormat
	callId: string
	callKey: string
	firstVoiceSeq: number | undefined
	openingBurstSeq: number
	openingBurstKind: "vlc" | "voice" | "tlc"
	lcLineSeq: number
	lcKey: string
	expiresAt: number
	burstClean: boolean
}

/** A trust change for a call id: the adapter publishes it. */
export interface DmrDecision {
	callId: string
	trust: "unknown" | "clear" | "encrypted"
}

/** The lane's call as the adapter holds it after a line. */
export interface DmrCallView {
	callId: string
	/** "talkgroup/source", or null while the call has no IDs. */
	key: string | null
}

interface Burst {
	seq: number
	kind: DmrBurstKind
	format: DmrFormat
	syncClean: boolean
	errored: boolean
}

interface LcSeen {
	seq: number
	key: string
	/** No error, plausible, no privacy field. */
	ok: boolean
	burstSeq: number | undefined
	/** The burst's first link control (a second one is no proof: row 11). */
	first: boolean
	/** The call's first link control after its first voice burst (P1n). */
	firstAfterVoice: boolean
}

interface CallRecord {
	callId: string
	key: string | null
	firstVoiceSeq: number | undefined
	trust: DmrLaneTrust
	evidence: DmrEvidence | undefined
	/** A link control of the lane came after the call's first voice burst. */
	lcAfterVoice: boolean
}

interface LaneState {
	burst: Burst | undefined
	lc: LcSeen | undefined
	/** The line seq of a privacy field printed while the lane had no call (it mutes a call that line opens). */
	privacySeq: number | undefined
	call: CallRecord | undefined
	modeGeneration: number
}

const LANES: readonly DmrLane[] = ["1", "2", "ms", "x"]
const PROOF_LANES: readonly DmrLane[] = ["1", "2", "ms"]

// --- Classification (error-first, privacy-independent) ---

const SYNC = /\bSync:\s*(?<pol>[+-])?(?<proto>(?!no\b)[A-Za-z0-9]+)\b/i
const BRACKET_SLOT = /\[slot(?<slot>[12])\]/i
const MS_DM = /\bMS\/DM\b/
const BURST = /\|\s*(?<burst>VLC|VC[1-6*]|TLC)\*?(?=\s|$)/
const SLOT_WORD = /\bSLOT\s+(?<slot>[12])\b/i
const SLOT_INLINE = /\bslot(?<slot>[12])\b/i
const TGT_SRC = /\bTGT[:=]\s*(?<tgt>\d+)\b.*\bSRC[:=]\s*(?<src>\d+)\b/i
const VOICE_EVENT =
	/\bDMR\s+Voice\b.*\bTGT:\s*(?<tgt>\d+);\s*SRC:\s*(?<src>\d+);/i
const LINE_ERR = /\b(?:CRC|FEC)(?:16|32)?\s+ERR\b/i
const SYNC_LOSS = /Frame Sync Err\b|SYNC LOST/i
/** The CACH short LC's own failure: CACH, not the burst. */
const CACH_SLCO_ERR = /^\s*SLCO CRC ERR\s*$/
const ENCRYPTED = /\bEncrypted\b/i
const SVC = /\bSVC=0x(?<svc>[0-9A-F]+)\b/i
const ALG = /\bALG(?:\s+ID)?:\s*(?:0x)?(?<alg>[0-9A-F]{2,4})\b/i
const KEY_ID = /\bKEY\s+ID:\s*(?:0x)?(?<key>[0-9A-F]{2,4})\b/i
const FLCO = /\bFLCO=0x(?<flco>[0-9A-F]+)\b/i
const FID = /\bFID=0x(?<fid>[0-9A-F]+)\b/i
const SVC_PRIVACY = 0x40

/** Lines that neither settle nor drop a pending proof (each anchored). */
const NEUTRAL: readonly RegExp[] = [
	/^\s*$/,
	CACH_SLCO_ERR,
	/^\s*SLCO NULL\b/,
	/^\s*Activity Update\b/,
	/^\s*DMR PDU Payload\b/,
	/^\s*SLCO Completed Block\b/,
	/^\s*SB: /,
	/^\s*AMBE /,
]

/** A line printed an error of its burst (the CACH short LC's own failure excepted). */
export function dmrLineErrored(line: string): boolean {
	if (CACH_SLCO_ERR.test(line)) return false
	return (
		LINE_ERR.test(line) ||
		// Any other upper-case error print (VOICE CACH/EMB ERR, FLCO FEC ERR).
		/\bERR\b/.test(line) ||
		SYNC_LOSS.test(line) ||
		/ -RAS /.test(line) ||
		/\bKey:.*(?:ERR|error)/i.test(line)
	)
}

/** Any privacy field on the line, each parsed on its own. */
export function dmrLinePrivacy(line: string): boolean {
	if (ENCRYPTED.test(line)) return true
	const svc = SVC.exec(line)?.groups?.["svc"]
	if (svc !== undefined && (parseInt(svc, 16) & SVC_PRIVACY) !== 0) return true
	const alg = ALG.exec(line)?.groups?.["alg"]
	if (alg !== undefined) {
		const value = parseInt(alg, 16)
		if (value !== 0 && value !== 0x80) return true
	}
	const key = KEY_ID.exec(line)?.groups?.["key"]
	return key !== undefined && parseInt(key, 16) !== 0
}

/**
 * Whether a link control's IDs may name a call: the IDs are in range, and
 * when -Z prints FLCO/FID, it is group (0x00) or unit (0x03) voice with
 * FID 0x00. A sanity check only: it rejects, it never proves.
 */
export function dmrIdsPlausible(
	line: string,
	tg: number,
	src: number,
): boolean {
	if (tg < 1 || tg > DMR_TALKGROUP_MAX || src < 1 || src > DMR_SOURCE_MAX)
		return false
	const flcoText = FLCO.exec(line)?.groups?.["flco"]
	const fidText = FID.exec(line)?.groups?.["fid"]
	if (flcoText !== undefined) {
		const flco = parseInt(flcoText, 16)
		if (flco !== 0x00 && flco !== 0x03) return false
	}
	return fidText === undefined || parseInt(fidText, 16) === 0x00
}

/** The router's memory: the last DMR sync's format and bracketed slot. */
export interface DmrRoute {
	format: DmrFormat | undefined
	slot: "1" | "2"
}

export const newDmrRoute = (): DmrRoute => ({ format: undefined, slot: "1" })

const slotOf = (text: string | undefined): "1" | "2" | undefined =>
	text === "1" || text === "2" ? text : undefined

/**
 * Classifies one line (ANSI codes stripped) and routes it to its lane,
 * updating `route`. Errors and privacy are read before anything else.
 */
export function classifyDmrLine(line: string, route: DmrRoute): DmrLineEvent {
	const errored = dmrLineErrored(line)
	const privacy = dmrLinePrivacy(line)
	const sync = SYNC.exec(line)
	if (sync !== null) {
		if (sync.groups?.["proto"]?.toUpperCase() !== "DMR") {
			route.format = undefined
			return { type: "foreign" }
		}
		const bracket = slotOf(BRACKET_SLOT.exec(line)?.groups?.["slot"])
		const format: DmrFormat =
			bracket !== undefined ? "bs" : MS_DM.test(line) ? "ms" : "x"
		route.format = format
		if (bracket !== undefined) route.slot = bracket
		const burstText = BURST.exec(line)?.groups?.["burst"]
		const burst: DmrBurstKind = !line.includes("|")
			? "bare"
			: burstText === undefined
				? "other"
				: burstText === "VLC"
					? "vlc"
					: burstText === "TLC"
						? "tlc"
						: "voice"
		const lane: DmrLane =
			format === "bs" ? (bracket ?? "1") : format === "ms" ? "ms" : "x"
		return { type: "sync", lane, format, burst, clean: !errored, privacy }
	}
	const slot = slotOf(
		SLOT_WORD.exec(line)?.groups?.["slot"] ??
			SLOT_INLINE.exec(line)?.groups?.["slot"],
	)
	const lane: DmrLane =
		route.format === "bs"
			? (slot ?? route.slot)
			: route.format === "ms"
				? "ms"
				: "x"
	const ids = VOICE_EVENT.exec(line)?.groups ?? TGT_SRC.exec(line)?.groups
	if (ids !== undefined) {
		const tg = parseInt(ids["tgt"] ?? "0", 10)
		const src = parseInt(ids["src"] ?? "0", 10)
		return {
			type: "lc",
			lane,
			key: `${tg}/${src}`,
			errored,
			plausible: dmrIdsPlausible(line, tg, src),
			privacy,
			slot,
		}
	}
	const neutral =
		!errored && !privacy && NEUTRAL.some(pattern => pattern.test(line))
	const clearAlg = !errored && !privacy && ALG.test(line)
	return { type: "line", lane, errored, privacy, neutral, clearAlg, slot }
}

// --- The state machine ---

const emptyLane = (modeGeneration: number): LaneState => ({
	burst: undefined,
	lc: undefined,
	privacySeq: undefined,
	call: undefined,
	modeGeneration,
})

export class DmrClearance {
	private decoderGeneration = 0
	private burstSeq = 0
	private mode: "bs" | "ms" | undefined
	private readonly lanes = new Map<DmrLane, LaneState>()
	/** Calls marked encrypted: sticky per call id, whatever lane they move to. */
	private readonly encryptedIds = new Set<string>()

	constructor(private readonly callTimeoutMs: number) {
		for (const lane of LANES) this.lanes.set(lane, emptyLane(0))
	}

	private lane(key: DmrLane): LaneState {
		const lane = this.lanes.get(key)
		if (lane === undefined) throw new RangeError(`unknown DMR lane ${key}`)
		return lane
	}

	/** The trust of `callId` (unknown when it has no record). */
	trust(callId: string): DmrLaneTrust {
		if (this.encryptedIds.has(callId)) return "encrypted"
		for (const lane of this.lanes.values())
			if (lane.call?.callId === callId) return lane.call.trust
		return "unknown"
	}

	/** The pending proof of `callId`, if any (tests and diagnostics). */
	evidence(callId: string): DmrEvidence | undefined {
		for (const lane of this.lanes.values())
			if (lane.call?.callId === callId) return lane.call.evidence
		return undefined
	}

	/**
	 * A decoder restart, child replacement, stop or rebuild: every lane is
	 * reset and evidence of the old generation is dead.
	 */
	restart(): void {
		this.decoderGeneration++
		this.mode = undefined
		for (const key of LANES) {
			const generation = this.lane(key).modeGeneration + 1
			this.lanes.set(key, emptyLane(generation))
		}
	}

	/** The adapter ended a lane's call on its call timeout. */
	timeout(lanes: readonly DmrLane[]): void {
		for (const key of lanes) this.bumpMode(key)
	}

	/** The adapter ended `callId` (any cause): its record and proof go. */
	ended(callId: string): void {
		for (const lane of this.lanes.values())
			if (lane.call?.callId === callId) lane.call = undefined
	}

	/** The adapter marked `callId` encrypted (its own parse): sticky here too. */
	encrypted(callId: string): void {
		this.encryptedIds.add(callId)
		for (const lane of this.lanes.values()) {
			const call = lane.call
			if (call?.callId !== callId) continue
			call.trust = "encrypted"
			call.evidence = undefined
		}
	}

	private bumpMode(key: DmrLane): void {
		const lane = this.lane(key)
		lane.modeGeneration++
		lane.burst = undefined
		lane.lc = undefined
		lane.privacySeq = undefined
		const call = lane.call
		if (call?.trust === "pending") {
			call.trust = "unknown"
			call.evidence = undefined
		}
	}

	/** One classified line, before the adapter's call lifecycle runs on it. */
	line(event: DmrLineEvent, seq: number, atMs: number): DmrDecision[] {
		const out: DmrDecision[] = []
		if (event.type === "foreign") {
			this.mode = undefined
			for (const key of LANES) this.bumpMode(key)
			return out
		}
		if (event.lane === "x") {
			this.onUnplaced(event, seq, out)
			if (event.type === "sync") {
				const lane = this.lane("x")
				lane.burst = this.newBurst(event)
				lane.lc = undefined
			}
			return out
		}
		const lane = this.lane(event.lane)
		if (event.type === "sync") {
			const mode = event.format === "bs" ? "bs" : "ms"
			if (this.mode !== undefined && this.mode !== mode)
				// A BS/MS change: no evidence of the old mode survives, and a
				// call known clear under it is not any more (fail closed).
				for (const key of LANES) {
					this.bumpMode(key)
					const call = this.lane(key).call
					if (call?.trust !== "clear") continue
					call.trust = "unknown"
					out.push({ callId: call.callId, trust: "unknown" })
				}
			this.mode = mode
			this.settle(event, lane, seq, atMs, out)
			lane.burst = this.newBurst(event)
			lane.lc = undefined
			const call = lane.call
			if (event.burst === "voice" && call !== undefined)
				call.firstVoiceSeq ??= lane.burst.seq
			if (event.privacy) this.privacy(lane, seq, out)
			return out
		}
		if (event.errored) this.dirty(lane)
		if (event.privacy) this.privacy(lane, seq, out)
		const call = lane.call
		if (event.type === "line") {
			// P1n: a clean clear-algorithm print of a clean burst is the
			// call's proof, settled like an LC.
			if (event.clearAlg && call !== undefined) {
				this.drop(call)
				this.armAlg(lane, call, seq, atMs)
				return out
			}
			// Row 11: any non-neutral line drops a pending proof.
			if (!event.neutral) this.drop(call)
			return out
		}
		// A link control. A second one in the burst drops a pending proof.
		this.drop(call)
		const ok = !event.errored && event.plausible && !event.privacy
		const burst = lane.burst
		lane.lc = {
			seq,
			key: event.key,
			ok,
			burstSeq: burst?.seq,
			first: lane.lc === undefined,
			firstAfterVoice:
				call !== undefined &&
				call.firstVoiceSeq !== undefined &&
				!call.lcAfterVoice,
		}
		if (call?.firstVoiceSeq !== undefined) call.lcAfterVoice = true
		// Row 16: the first checked rival copy after voice revokes at once.
		if (
			ok &&
			call !== undefined &&
			call.key !== null &&
			call.key !== event.key &&
			burst?.kind === "voice" &&
			call.trust === "clear"
		) {
			call.trust = "unknown"
			call.evidence = undefined
			out.push({ callId: call.callId, trust: "unknown" })
		}
		return out
	}

	/**
	 * The lane's call after the adapter's lifecycle ran on line `seq` (null:
	 * no call): a new call is recorded (unknown, or pending under P2), a
	 * named call's link control on this line may arm P1 or P3.
	 */
	call(
		key: DmrLane,
		view: DmrCallView | null,
		seq: number,
		atMs: number,
	): DmrDecision[] {
		const out: DmrDecision[] = []
		const lane = this.lane(key)
		if (view === null) {
			lane.call = undefined
			return out
		}
		let record = lane.call
		if (record?.callId !== view.callId) {
			// A new call here, or one the adapter moved from another lane:
			// it inherits nothing but its encryption.
			let wasClear = false
			for (const other of this.lanes.values())
				if (other !== lane && other.call?.callId === view.callId) {
					wasClear = other.call.trust === "clear"
					other.call = undefined
				}
			// A privacy field on the line that opened the call is its own.
			const encrypted =
				this.encryptedIds.has(view.callId) || lane.privacySeq === seq
			lane.privacySeq = undefined
			record = {
				callId: view.callId,
				key: view.key,
				firstVoiceSeq:
					lane.burst?.kind === "voice" ? lane.burst.seq : undefined,
				trust: encrypted ? "encrypted" : "unknown",
				evidence: undefined,
				lcAfterVoice: false,
			}
			lane.call = record
			if (encrypted) {
				this.encryptedIds.add(view.callId)
				out.push({ callId: view.callId, trust: "encrypted" })
				return out
			}
			if (wasClear) out.push({ callId: view.callId, trust: "unknown" })
			// P2: the call opened on a checked LC of a clean header burst.
			if (key !== "x" && view.key !== null)
				this.arm(lane, record, seq, atMs, "opened")
			return out
		}
		const keyBefore = record.key
		if (keyBefore !== null && view.key !== keyBefore) {
			// A named call never changes key; fail closed if it does.
			if (record.trust === "clear")
				out.push({ callId: record.callId, trust: "unknown" })
			if (record.trust !== "encrypted") record.trust = "unknown"
			record.evidence = undefined
		}
		record.key = view.key
		if (key === "x" || record.key === null) return out
		// P1n: the link control that names a call started on its voice
		// frames is its proof when it is the first one after its first voice
		// burst; any other naming proves nothing (row 7).
		this.arm(lane, record, seq, atMs, keyBefore === null ? "named" : "known")
		return out
	}

	/** Arms P1, P2 or P3 from the link control printed on line `seq`, if any. */
	private arm(
		lane: LaneState,
		record: CallRecord,
		seq: number,
		atMs: number,
		how: "opened" | "named" | "known",
	): void {
		const lc = lane.lc
		const burst = lane.burst
		if (
			lc?.seq !== seq ||
			!lc.ok ||
			!lc.first ||
			lc.key !== record.key ||
			burst === undefined ||
			lc.burstSeq !== burst.seq ||
			!burst.syncClean ||
			burst.errored ||
			record.trust === "encrypted" ||
			record.trust === "clear"
		)
			return
		let kind: DmrProofKind
		if (how === "named") {
			if (
				!lc.firstAfterVoice ||
				burst.kind !== "voice" ||
				record.firstVoiceSeq === undefined ||
				burst.seq < record.firstVoiceSeq
			)
				return
			kind = "P1n"
		} else if (burst.kind === "vlc") kind = "P2"
		else if (how === "opened") return
		else if (
			burst.kind === "voice" &&
			record.firstVoiceSeq !== undefined &&
			burst.seq >= record.firstVoiceSeq
		)
			kind = "P1"
		else if (burst.kind === "tlc") kind = "P3"
		else return
		record.trust = "pending"
		record.evidence = {
			kind,
			decoderGeneration: this.decoderGeneration,
			modeGeneration: lane.modeGeneration,
			lane: this.keyOf(lane),
			format: burst.format,
			callId: record.callId,
			callKey: record.key ?? "",
			firstVoiceSeq: record.firstVoiceSeq,
			openingBurstSeq: burst.seq,
			openingBurstKind:
				burst.kind === "vlc" ? "vlc" : burst.kind === "tlc" ? "tlc" : "voice",
			lcLineSeq: seq,
			lcKey: lc.key,
			expiresAt: atMs + this.callTimeoutMs,
			burstClean: true,
		}
	}

	/**
	 * P1n by algorithm: a clean clear ALG print (PI header, late entry) in a
	 * clean burst of the lane's call, settled on the lane's next clean sync.
	 */
	private armAlg(
		lane: LaneState,
		record: CallRecord,
		seq: number,
		atMs: number,
	): void {
		const burst = lane.burst
		if (
			burst === undefined ||
			!burst.syncClean ||
			burst.errored ||
			burst.kind === "tlc" ||
			burst.kind === "bare" ||
			record.trust === "encrypted" ||
			record.trust === "clear"
		)
			return
		record.trust = "pending"
		record.evidence = {
			kind: "ALG",
			decoderGeneration: this.decoderGeneration,
			modeGeneration: lane.modeGeneration,
			lane: this.keyOf(lane),
			format: burst.format,
			callId: record.callId,
			callKey: record.key ?? "",
			firstVoiceSeq: record.firstVoiceSeq,
			openingBurstSeq: burst.seq,
			openingBurstKind: burst.kind === "vlc" ? "vlc" : "voice",
			lcLineSeq: seq,
			lcKey: record.key ?? "",
			expiresAt: atMs + this.callTimeoutMs,
			burstClean: true,
		}
	}

	private keyOf(lane: LaneState): DmrLane {
		for (const [key, value] of this.lanes) if (value === lane) return key
		return "x"
	}

	private newBurst(event: DmrSyncEvent): Burst {
		return {
			seq: ++this.burstSeq,
			kind: event.burst,
			format: event.format,
			syncClean: event.clean,
			errored: !event.clean,
		}
	}

	/** An error line of the lane's open burst: its pending proof is dead. */
	private dirty(lane: LaneState): void {
		if (lane.burst !== undefined) lane.burst.errored = true
		const evidence = lane.call?.evidence
		if (evidence !== undefined) evidence.burstClean = false
	}

	private drop(call: CallRecord | undefined): void {
		if (call?.trust !== "pending") return
		call.trust = "unknown"
		call.evidence = undefined
	}

	/** Row 15: a privacy field makes the lane's call encrypted, for good. */
	private privacy(lane: LaneState, seq: number, out: DmrDecision[]): void {
		const call = lane.call
		if (call === undefined) {
			lane.privacySeq = seq
			return
		}
		if (call.trust === "encrypted") return
		call.trust = "encrypted"
		call.evidence = undefined
		this.encryptedIds.add(call.callId)
		out.push({ callId: call.callId, trust: "encrypted" })
	}

	/**
	 * Row 14: a line of no lane (a BS sync bracketing no slot, or what
	 * follows it). It never opens, names, proves or settles; its error
	 * spoils every open burst, and its privacy field mutes the slot it
	 * prints, or holds every call's voice when it prints none.
	 */
	private onUnplaced(
		event: DmrSyncEvent | DmrLcEvent | DmrOtherEvent,
		seq: number,
		out: DmrDecision[],
	): void {
		const errored = event.type === "sync" ? !event.clean : event.errored
		if (errored) for (const key of PROOF_LANES) this.dirty(this.lane(key))
		if (!event.privacy) return
		const slot = event.type === "sync" ? undefined : event.slot
		if (slot !== undefined) {
			const lane = this.lane(slot)
			this.privacy(lane, seq, out)
			return
		}
		for (const key of PROOF_LANES) {
			const call = this.lane(key).call
			if (call === undefined || call.trust === "encrypted") continue
			if (call.trust === "clear")
				out.push({ callId: call.callId, trust: "unknown" })
			call.trust = "unknown"
			call.evidence = undefined
		}
	}

	/** Rows 12, 13, 21: the lane's next sync settles or drops a pending proof. */
	private settle(
		event: DmrSyncEvent,
		lane: LaneState,
		seq: number,
		atMs: number,
		out: DmrDecision[],
	): void {
		const call = lane.call
		const evidence = call?.evidence
		if (call === undefined || evidence === undefined) return
		if (this.clear(lane, call, evidence, event, seq, atMs))
			out.push({ callId: call.callId, trust: "clear" })
		else this.drop(call)
	}

	/**
	 * The only writer of CLEAR. `settling` is the lane's next sync after the
	 * proof's burst: it must be clean, of the proof's format (P2: a voice
	 * burst or header), of the current generations, inside the expiry, and
	 * the burst from the opening sync to it must have printed no error.
	 */
	private clear(
		lane: LaneState,
		call: CallRecord,
		evidence: DmrEvidence,
		settling: DmrSyncEvent,
		seq: number,
		atMs: number,
	): boolean {
		const burst = lane.burst
		if (
			call.trust !== "pending" ||
			this.encryptedIds.has(call.callId) ||
			evidence.callId !== call.callId ||
			evidence.callKey !== (call.key ?? "") ||
			evidence.lcKey !== (call.key ?? "") ||
			evidence.decoderGeneration !== this.decoderGeneration ||
			evidence.modeGeneration !== lane.modeGeneration ||
			evidence.lane !== settling.lane ||
			evidence.format !== settling.format ||
			!evidence.burstClean ||
			burst === undefined ||
			burst.seq !== evidence.openingBurstSeq ||
			burst.errored ||
			!settling.clean ||
			settling.privacy ||
			settling.burst === "bare" ||
			(evidence.kind === "P2" &&
				settling.burst !== "voice" &&
				settling.burst !== "vlc") ||
			seq <= evidence.lcLineSeq ||
			atMs > evidence.expiresAt
		)
			return false
		call.trust = "clear"
		call.evidence = undefined
		return true
	}
}
