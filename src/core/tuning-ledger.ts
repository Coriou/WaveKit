/**
 * Tuning trust ledger: the one record of what was written to a receiver, and where in its payload.
 *
 * Per source, a **session** is one connection from its first payload byte to its close, pause or
 * removal (`sessionSeq`, numbered per source from 1). Its **position** `pos` counts the aligned
 * payload bytes handed to the source stream (SourceManager.forwardData). A **receipt** is one
 * tuning frame flushed to the socket (recorded in the write callback, so a frame queued behind
 * socket backpressure gets its receipt when it leaves, and none if the session ended first), at the
 * position of that moment. A **doubt** is evidence that the receiver may have moved without a
 * receipt (untracked-retune alarm, host-centre mismatch, pipeline error, rate-truth mismatch), at a
 * lower bound of the position it applies from, stamped with the source's last receipt `seq` when it
 * was raised.
 *
 * The invariant (reads): a block `[posA, posB)` of session `S` is trusted only if `S` is the source's
 * live session, and for frequency and for sample rate alike the last receipt `R` with
 * `R.pos < posB` has a valid value and a writer, `posA >= B(R)`, and no doubt on that field raised
 * after `R` (by receipt seq, whatever its position) lies before `posB`. `B(R) = R.pos + settle`, at
 * the highest sample rate that can be in effect from `R` to `posB`, pushed later by every
 * centre-moving frame flushed after `R` (ppm, direct sampling, offset tuning, crystals) and lowered
 * only by a detected marker (lowerBoundary, never below `R.pos`). The label is `relay` if either
 * receipt's writer is the relay, else `commanded`. Everything else is `unverified`, including every
 * malformed or unknown input and any lookup that throws. Callers pass `posA` as a lower bound and
 * `posB` as an upper bound of the block's real positions: under-estimating `posA` or
 * over-estimating `posB` can only make the answer stricter. Gain and every other field are recorded
 * and never gate trust.
 *
 * Readers: the TunerController (assert, the skip rule, the API's per-field proof) and the spectrum
 * engine's shadow counter. Trust labels of consumers do not read it yet.
 */
import type { TuningTrust } from "./spectrum/types.js"
import { settleBytes, type SettleLink } from "./spectrum/network-settle.js"

/** Who wrote a frame. `assert` is the controller's automatic write of an unproven field. */
export type TuningWriter = "operator" | "scanner" | "assert" | "relay"

export interface TuningWriterTag {
	writer: TuningWriter
	jobId?: string
}

/** The rtl_tcp fields a frame can set. */
export type TuningField =
	| "frequency"
	| "sampleRate"
	| "gainMode"
	| "gain"
	| "ppm"
	| "ifGain"
	| "testMode"
	| "agcMode"
	| "directSampling"
	| "offsetTuning"
	| "rtlXtal"
	| "tunerXtal"
	| "gainIndex"
	| "biasTee"
	| "tunerIfGain"
	| "unknown"

/** rtl_tcp opcodes (one byte) to fields; anything else is `unknown`. */
const OPCODE_FIELDS: readonly TuningField[] = [
	"unknown", // 0x00
	"frequency", // 0x01
	"sampleRate", // 0x02
	"gainMode", // 0x03
	"gain", // 0x04
	"ppm", // 0x05
	"ifGain", // 0x06
	"testMode", // 0x07
	"agcMode", // 0x08
	"directSampling", // 0x09
	"offsetTuning", // 0x0a
	"rtlXtal", // 0x0b
	"tunerXtal", // 0x0c
	"gainIndex", // 0x0d
	"biasTee", // 0x0e
	"tunerIfGain", // 0x0f
]

export function fieldOfOpcode(cmd: number): TuningField {
	return OPCODE_FIELDS[cmd] ?? "unknown"
}

/** The two fields trust depends on. */
export type GatedField = "frequency" | "sampleRate"
export type DoubtField = GatedField | "both"

/**
 * Frames that never gate trust but move what the receiver delivers: a flushed one pushes the
 * boundary of the field's last receipt to at least its own position plus the settle. The
 * frequency correction (ppm), direct sampling, offset tuning and both crystal frequencies move the
 * centre; ppm and the crystals also scale the real sample rate (librtlsdr derives the resampler
 * ratio from the corrected RTL crystal), so they push the rate boundary too.
 */
const CENTRE_MOVERS: ReadonlySet<TuningField> = new Set<TuningField>([
	"ppm",
	"directSampling",
	"offsetTuning",
	"rtlXtal",
	"tunerXtal",
])
const RATE_MOVERS: ReadonlySet<TuningField> = new Set<TuningField>([
	"ppm",
	"rtlXtal",
	"tunerXtal",
])

export interface TuningReceipt {
	session: number
	/** Per source, increasing across sessions from 1. */
	seq: number
	field: TuningField
	value: number
	/** Undefined: the frame carried no writer tag (reads `unverified`). */
	writer: TuningWriter | undefined
	jobId?: string
	pos: number
}

export interface TuningDoubt {
	session: number
	field: DoubtField
	/** Lower bound of the first position the doubt applies to. */
	pos: number
	/** The source's last receipt seq when the doubt was raised: it unproves receipts after none. */
	afterSeq: number
	reason: string
}

/**
 * Receipts (and, separately, doubts) kept per session. 64 covers what any reader still needs:
 * the spectrum pipeline labels blocks at most its in-flight budget behind the live edge
 * (MAX_INFLIGHT_BYTES 4 MiB ≈ 0.87 s at 2.4 Msps U8), while the densest writer, a scanner hop,
 * writes at most 4 frames (test mode on, rate, frequency, test mode off) per hop and hops no faster
 * than the local settle (300 ms): 64 / 4 × 0.3 s = 4.8 s of history, and a reconnect replay writes
 * at most one frame per rtl_tcp field (15). A block that ends before a field's newest evicted
 * receipt reads `unverified` (older than the ring); each field's newest evicted receipt still
 * proves reads past it, so a long session keeps its proof at the live edge. A read proven by an
 * evicted receipt that ends at or before the newest evicted receipt of any field is older than the
 * ring too: frames that may have pushed its boundary left with that one.
 */
export const TUNING_LEDGER_RING = 64

/** Why a read answered `unverified`. Fixed strings: never an echoed input. */
export type UnverifiedReason =
	| "bad-input"
	| "unknown-source"
	| "no-session"
	| "unknown-session"
	| "session-ended"
	| "beyond-known"
	| "no-receipt"
	| "older-than-ring"
	| "no-writer"
	| "invalid-value"
	| "settling"
	| "doubt"
	| "lookup-failed"

export interface TrustVerdict {
	trust: TuningTrust
	/** The proven values (null when that field is not proven). */
	frequency: number | null
	sampleRate: number | null
	/** Seq of the receipt each field was proven by (null when not proven). */
	receipts: { frequency: number | null; sampleRate: number | null }
	/** Present when `trust` is `unverified`: the first failing check. */
	reason?: UnverifiedReason
	/** Present on a doubt: its reason as raised. */
	doubtReason?: string
}

export type FieldProofState = "proven" | "settling" | "unverified"

/** The latest frame of a field written to the live connection and not yet receipted. */
export interface QueuedFrameState {
	value: number
	writer: TuningWriter | null
}

export interface FieldState {
	state: FieldProofState
	value: number | null
	writer: TuningWriter | null
	session: number | null
	receipt: number | null
	/**
	 * A frame of this field written and not receipted yet: behind socket backpressure (its write
	 * callback has not run), or flushed before the connection's first payload (receipted when the
	 * session starts). Null when none.
	 */
	queued: QueuedFrameState | null
	reason?: UnverifiedReason
	doubtReason?: string
	/**
	 * A standing hold on the field (setHold) while it lasts: the field reads `unverified` with
	 * the hold's reason whatever its receipts say. `answered`: a frame of the field was flushed or
	 * queued after the hold was set (a re-write cannot clear a hold, so one answer is enough).
	 * `withoutHold`: the state the field would have without the hold.
	 */
	hold?: { reason: string; answered: boolean; withoutHold: FieldProofState }
}

/** What changed in the ledger (TuningLedger.subscribe). */
export type LedgerChange =
	| { kind: "session-started"; session: number }
	| { kind: "session-ended"; session: number }
	| { kind: "receipt"; field: TuningField; receipt: TuningReceipt }
	| { kind: "doubt"; field: DoubtField }
	| { kind: "hold"; field: GatedField }

export type LedgerListener = (sourceId: string, change: LedgerChange) => void

/** The live session's counter: SourceManager adds forwarded payload bytes to `pos`. */
export interface LedgerSession {
	readonly sourceId: string
	readonly session: number
	pos: number
	readonly ended: boolean
}

export interface TuningLedgerOptions {
	/**
	 * The settle link per source (configured settle; in-flight estimate), read at every ledger
	 * read so a settings change is seen at once. Default: 1000 ms.
	 */
	settleLink?: (sourceId: string) => SettleLink
	/** Bytes per sample of the source's payload; null = unknown (nothing settles). Default 2 (U8 IQ). */
	frameBytes?: (sourceId: string) => number | null
	/**
	 * The source's current declared rate (caps): the rate assumed in effect before the session's
	 * first rate receipt; null = none.
	 */
	capsRate?: (sourceId: string) => number | null
}

/** Default configured settle: `scanner.sweep.settleMs.network`'s schema default. */
export const DEFAULT_LEDGER_SETTLE_MS = 1000

/** Frame values are rtl_tcp's uint32. */
const MAX_FRAME_VALUE = 0xffff_ffff

class SessionRecord implements LedgerSession {
	pos = 0
	ended = false
	readonly receipts: TuningReceipt[] = []
	/** In position order (ties in raise order). */
	readonly doubts: TuningDoubt[] = []
	/** Receipts of each field evicted from the ring (or from the pre-session queue). */
	readonly evicted = new Map<TuningField, number>()
	/**
	 * The newest receipt of each field evicted from the ring: still the field's last receipt for
	 * any read ending past it with no newer receipt of the field in the ring (a long session keeps
	 * its proof at the live edge); a read ending at or before it is older than the ring.
	 */
	readonly pinned = new Map<TuningField, TuningReceipt>()
	/**
	 * Position of the newest receipt of any field evicted from the ring (-1: none). A read proven
	 * by a pinned receipt and ending at or before it is older than the ring: of the movers evicted
	 * between the two only the newest is kept, and it may lie past the read while an older one,
	 * gone, pushed the read's boundary.
	 */
	evictedMaxPos = -1
	/** The newest centre- and rate-moving receipts evicted (they still push later boundaries). */
	readonly evictedMovers: {
		centre: TuningReceipt | null
		rate: TuningReceipt | null
	} = { centre: null, rate: null }
	/**
	 * The highest valid rate receipted in this session, kept across eviction: the settle rate
	 * when the rate in effect at a receipt has left the ring. 0: none.
	 */
	maxRate = 0
	/** Marker-lowered boundaries by receipt seq (ring receipts only). */
	readonly lowered = new Map<number, number>()
	/**
	 * Doubts evicted per gated field: the lowest position and the highest `afterSeq` among them
	 * (null: none). Any receipt at or before that seq whose reads end past that position is
	 * doubted (pairing the two bounds can only be stricter).
	 */
	evictedDoubt: Record<
		GatedField,
		{ minPos: number; maxAfterSeq: number } | null
	> = {
		frequency: null,
		sampleRate: null,
	}
	/**
	 * Standing holds per gated field (setHold): the reason, the source's seq when set and the
	 * position it was set at.
	 */
	readonly holds = new Map<
		GatedField,
		{ reason: string; afterSeq: number; start: number }
	>()
	/**
	 * Cleared holds per gated field, `[start, end)` in position order: a block overlapping one
	 * reads unverified (the hold's reason) after the clear too. At most TUNING_LEDGER_RING per
	 * field; past it the two oldest merge into one span (covering the gap between: stricter).
	 */
	readonly heldRanges: Record<
		GatedField,
		{ start: number; end: number; reason: string }[]
	> = { frequency: [], sampleRate: [] }
	constructor(
		readonly sourceId: string,
		readonly session: number,
		/**
		 * The caps rate when the session began: a rate in effect before the session's first rate
		 * receipt even after caps moves to the written rate (the controller updates caps right
		 * after the write). 0: none; +Infinity: the lookup threw (nothing settles before a rate
		 * receipt, fail closed).
		 */
		readonly capsAtStart: number = 0,
	) {}
}

interface SourceRecord {
	sessions: number
	seq: number
	live: SessionRecord | null
	/** The newest connection (its queued frames are the source's). */
	current: LedgerConnection | null
}

/** A parsed frame not yet recorded. */
export interface PendingFrame {
	field: TuningField
	value: number
	tag: TuningWriterTag | undefined
}

/**
 * Called once per write when its frames are receipted: with the receipt of the write's last
 * complete frame, or null when nothing was receipted (session ended before the flush, write error,
 * no complete frame, connection closed before its first payload, frame evicted from the pre-session
 * queue).
 */
export type ReceiptCallback = (receipt: TuningReceipt | null) => void

/**
 * Folds the per-frame receipts of one multi-frame call into one: `callback` runs exactly once,
 * after `end()` and once every frame `frame()` issued has settled, with the receipt of the last
 * frame to settle (frames settle in socket order), or null when any frame got none, no frame
 * was issued, or the call failed (`fail()`: frames it meant to write never went out).
 *
 * A frame written after the call returned (after `end()`, e.g. from work the call started but
 * did not await) is not reported: once the callback has fired, a later `frame()` never reaches
 * it, so the receipt describes only what the call wrote before it returned.
 */
export class ReceiptOnce {
	private open = 0
	private ended = false
	private fired = false
	private missing = false
	private last: TuningReceipt | null = null

	constructor(private readonly target: ReceiptCallback) {}

	/** A callback for one frame; only its first call counts. */
	frame(): ReceiptCallback {
		this.open += 1
		let settled = false
		return receipt => {
			if (settled) return
			settled = true
			this.open -= 1
			if (receipt === null) this.missing = true
			else this.last = receipt
			this.settle()
		}
	}

	/** The call failed part-way: whatever it wrote, it reports null. */
	fail(): void {
		this.missing = true
	}

	/** The call issues no more frames. */
	end(): void {
		this.ended = true
		this.settle()
	}

	private settle(): void {
		if (!this.ended || this.open > 0 || this.fired) return
		this.fired = true
		safeReceiptCallback(this.target, this.missing ? null : this.last)
	}
}

const UNVERIFIED_BASE = {
	trust: "unverified" as const,
	frequency: null,
	sampleRate: null,
	receipts: { frequency: null, sampleRate: null },
}

function unverified(
	reason: UnverifiedReason,
	doubtReason?: string,
): TrustVerdict {
	return {
		...UNVERIFIED_BASE,
		receipts: { frequency: null, sampleRate: null },
		reason,
		...(doubtReason !== undefined ? { doubtReason } : {}),
	}
}

function validPos(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0
}

function validValue(field: TuningField, value: number): boolean {
	if (!Number.isInteger(value) || value < 0 || value > MAX_FRAME_VALUE)
		return false
	if (field === "frequency" || field === "sampleRate") return value > 0
	return true
}

function safeReceiptCallback(
	cb: ReceiptCallback | undefined,
	receipt: TuningReceipt | null,
): void {
	if (!cb) return
	try {
		cb(receipt ? { ...receipt } : null)
	} catch {
		// A caller's callback never breaks the ledger or the socket callback.
	}
}

type FieldProof =
	| { ok: true; receipt: TuningReceipt; boundary: number }
	| { ok: false; reason: UnverifiedReason; doubtReason?: string }

/**
 * Splits the bytes written to one connection into rtl_tcp frames (5 bytes: opcode, uint32 BE value),
 * across writes, exactly as the receiver parses them. A frame made of bytes from two writes with
 * different writer tags has no writer (fail closed).
 */
export class RtlTcpFrameAssembler {
	private readonly partial = Buffer.alloc(5)
	private partialLength = 0
	private partialTag: TuningWriterTag | undefined | null = null

	push(payload: Buffer, tag: TuningWriterTag | undefined): PendingFrame[] {
		const frames: PendingFrame[] = []
		let off = 0
		if (this.partialLength > 0) {
			const take = Math.min(5 - this.partialLength, payload.length)
			payload.copy(this.partial, this.partialLength, 0, take)
			this.partialLength += take
			off = take
			if (!sameTag(this.partialTag, tag)) this.partialTag = undefined
			if (this.partialLength < 5) return frames
			frames.push(this.frame(this.partial, 0, this.partialTag ?? undefined))
			this.partialLength = 0
			this.partialTag = null
		}
		while (payload.length - off >= 5) {
			frames.push(this.frame(payload, off, tag))
			off += 5
		}
		if (off < payload.length) {
			payload.copy(this.partial, 0, off)
			this.partialLength = payload.length - off
			this.partialTag = tag
		}
		return frames
	}

	private frame(
		bytes: Buffer,
		off: number,
		tag: TuningWriterTag | undefined,
	): PendingFrame {
		return {
			field: fieldOfOpcode(bytes[off]!),
			value: bytes.readUInt32BE(off + 1),
			tag,
		}
	}
}

function sameTag(
	a: TuningWriterTag | undefined | null,
	b: TuningWriterTag | undefined,
): boolean {
	if (a === null || a === undefined || b === undefined) return false
	return a.writer === b.writer && a.jobId === b.jobId
}

/** Frames of one field written and not receipted: FIFO flush, so the newest is the one that stays. */
interface QueuedCount {
	count: number
	value: number
	writer: TuningWriter | null
}

interface PreSessionFrame {
	frame: PendingFrame
	/** Present on a write's last frame: its receipt callback. */
	done?: ReceiptCallback
}

/**
 * One connection (socket) of a source as the ledger sees it: frames written to it, and its session
 * once its first payload is forwarded. Frames flushed before the session starts are recorded at
 * position 0 of the session when it starts (no payload byte was forwarded before them); a
 * connection closed before its first payload records nothing.
 */
export class LedgerConnection {
	private readonly assembler = new RtlTcpFrameAssembler()
	/** Flushed before the first payload; at most TUNING_LEDGER_RING (older ones count evicted). */
	private pending: PreSessionFrame[] = []
	private readonly pendingEvicted = new Map<TuningField, number>()
	/** Written frames not receipted yet, per field (backpressure or pre-session). */
	private readonly queued = new Map<TuningField, QueuedCount>()
	private closed = false
	private live: SessionRecord | null = null

	constructor(
		private readonly ledger: TuningLedger,
		readonly sourceId: string,
	) {}

	/** The started session, or null before the first payload (and after close). */
	get session(): LedgerSession | null {
		return this.live
	}

	/** The newest not-yet-receipted frame of `field`, or null. */
	queuedFrame(field: TuningField): QueuedFrameState | null {
		const q = this.queued.get(field)
		return q && q.count > 0 ? { value: q.value, writer: q.writer } : null
	}

	/**
	 * Starts the session (first payload about to be forwarded). Idempotent while open; null once
	 * closed.
	 */
	start(): LedgerSession | null {
		if (this.closed) return null
		if (this.live) return this.live
		const session = this.ledger.beginSession(this.sourceId)
		this.live = session
		for (const [field, n] of this.pendingEvicted)
			session.evicted.set(field, (session.evicted.get(field) ?? 0) + n)
		this.pendingEvicted.clear()
		const pending = this.pending
		this.pending = []
		let last: TuningReceipt | null = null
		for (const p of pending) {
			this.unqueue(p.frame.field)
			const receipt = this.ledger.record(session, p.frame)
			if (receipt) last = receipt
			if (p.done) {
				safeReceiptCallback(p.done, last)
				last = null
			}
		}
		this.ledger.notify(this.sourceId, {
			kind: "session-started",
			session: session.session,
		})
		return session
	}

	/**
	 * Parses `payload` in socket order now; the returned callback, run from the socket write
	 * callback, records the frames at the session position of that moment. A write error records
	 * nothing and raises a doubt on both fields (the receiver may have parsed part of it).
	 * `onReceipt` runs once with the receipt of the payload's last complete frame, or null.
	 */
	write(
		payload: Buffer,
		tag: TuningWriterTag | undefined,
		onReceipt?: ReceiptCallback,
	): (err?: Error | null) => void {
		const frames = this.closed ? [] : this.assembler.push(payload, tag)
		for (const frame of frames) this.enqueue(frame)
		return err => {
			if (this.closed || frames.length === 0) {
				safeReceiptCallback(onReceipt, null)
				return
			}
			const session = this.live
			if (err) {
				for (const frame of frames) this.unqueue(frame.field)
				if (session) this.ledger.doubtSession(session, "both", "write-failed")
				safeReceiptCallback(onReceipt, null)
				return
			}
			if (!session) {
				// Still queued (reported so) until the session starts and receipts them.
				frames.forEach((frame, i) => {
					if (this.pending.length >= TUNING_LEDGER_RING) {
						const gone = this.pending.shift()!
						this.unqueue(gone.frame.field)
						this.pendingEvicted.set(
							gone.frame.field,
							(this.pendingEvicted.get(gone.frame.field) ?? 0) + 1,
						)
						if (gone.done) safeReceiptCallback(gone.done, null)
					}
					this.pending.push(
						i === frames.length - 1 && onReceipt
							? { frame, done: onReceipt }
							: { frame },
					)
				})
				return
			}
			let last: TuningReceipt | null = null
			for (const frame of frames) {
				this.unqueue(frame.field)
				last = this.ledger.record(session, frame) ?? last
			}
			safeReceiptCallback(onReceipt, last)
		}
	}

	/** Ends the session (close, pause, removal); later flushes record nothing. */
	close(): void {
		if (this.closed) return
		this.closed = true
		const pending = this.pending
		this.pending = []
		this.queued.clear()
		for (const p of pending) if (p.done) safeReceiptCallback(p.done, null)
		const live = this.live
		this.live = null
		if (live) this.ledger.finishSession(live)
		this.ledger.connectionClosed(this)
	}

	private enqueue(frame: PendingFrame): void {
		const q = this.queued.get(frame.field)
		const writer = frame.tag?.writer ?? null
		if (q) {
			q.count += 1
			q.value = frame.value
			q.writer = writer
		} else
			this.queued.set(frame.field, { count: 1, value: frame.value, writer })
	}

	private unqueue(field: TuningField): void {
		const q = this.queued.get(field)
		if (!q) return
		q.count -= 1
		if (q.count <= 0) this.queued.delete(field)
	}
}

export class TuningLedger {
	private readonly sources = new Map<string, SourceRecord>()
	private readonly opts: TuningLedgerOptions
	private readonly listeners = new Set<LedgerListener>()

	constructor(opts: TuningLedgerOptions = {}) {
		this.opts = opts
	}

	/**
	 * Hears every session start and end, receipt, doubt and hold change, synchronously where it
	 * happens (inside a socket write callback for a receipt): a listener that acts must defer.
	 * A throwing listener is ignored. Returns the unsubscribe function.
	 */
	subscribe(listener: LedgerListener): () => void {
		this.listeners.add(listener)
		return () => {
			this.listeners.delete(listener)
		}
	}

	/** @internal Tells the listeners. */
	notify(sourceId: string, change: LedgerChange): void {
		for (const listener of this.listeners) {
			try {
				listener(sourceId, change)
			} catch {
				// A listener never breaks the ledger or the socket callback.
			}
		}
	}

	/** A new connection of `sourceId` (its session starts at its first payload). */
	connection(sourceId: string): LedgerConnection {
		const conn = new LedgerConnection(this, sourceId)
		this.sourceRecord(sourceId).current = conn
		return conn
	}

	/** @internal LedgerConnection.start: numbers a new session and ends any previous live one. */
	beginSession(sourceId: string): SessionRecord {
		const record = this.sourceRecord(sourceId)
		if (record.live) record.live.ended = true
		record.sessions += 1
		const session = new SessionRecord(
			sourceId,
			record.sessions,
			this.capsSnapshot(sourceId),
		)
		record.live = session
		return session
	}

	/** The caps rate now, for a session's start (see SessionRecord.capsAtStart). */
	private capsSnapshot(sourceId: string): number {
		try {
			const caps = this.opts.capsRate?.(sourceId) ?? 0
			return typeof caps === "number" && Number.isFinite(caps) && caps > 0
				? caps
				: 0
		} catch {
			return Number.POSITIVE_INFINITY
		}
	}

	/** @internal LedgerConnection.close. */
	finishSession(session: SessionRecord): void {
		session.ended = true
		const record = this.sources.get(session.sourceId)
		if (record?.live !== session) return
		record.live = null
		this.notify(session.sourceId, {
			kind: "session-ended",
			session: session.session,
		})
	}

	/** @internal LedgerConnection.close: the source's newest connection is gone. */
	connectionClosed(conn: LedgerConnection): void {
		const record = this.sources.get(conn.sourceId)
		if (record?.current === conn) record.current = null
	}

	/** @internal A flushed frame at the session's current position; null when not recorded. */
	record(session: LedgerSession, frame: PendingFrame): TuningReceipt | null {
		const live = this.liveRecord(session)
		if (!live) return null
		const record = this.sources.get(live.sourceId)
		if (!record) return null
		record.seq += 1
		const receipt: TuningReceipt = {
			session: live.session,
			seq: record.seq,
			field: frame.field,
			value: frame.value,
			writer: frame.tag?.writer,
			...(frame.tag?.jobId !== undefined ? { jobId: frame.tag.jobId } : {}),
			pos: live.pos,
		}
		if (frame.field === "sampleRate" && validValue("sampleRate", frame.value))
			live.maxRate = Math.max(live.maxRate, frame.value)
		live.receipts.push(receipt)
		if (live.receipts.length > TUNING_LEDGER_RING) {
			const gone = live.receipts.shift()!
			live.evicted.set(gone.field, (live.evicted.get(gone.field) ?? 0) + 1)
			live.pinned.set(gone.field, gone)
			live.evictedMaxPos = Math.max(live.evictedMaxPos, gone.pos)
			if (CENTRE_MOVERS.has(gone.field)) live.evictedMovers.centre = gone
			if (RATE_MOVERS.has(gone.field)) live.evictedMovers.rate = gone
			// A pinned receipt keeps no marker-lowered boundary (fail closed: the full settle).
			live.lowered.delete(gone.seq)
		}
		this.notify(live.sourceId, {
			kind: "receipt",
			field: frame.field,
			receipt: { ...receipt },
		})
		return receipt
	}

	/** @internal A doubt on a session object, at `atPos` (a lower bound) or the current position. */
	doubtSession(
		session: LedgerSession,
		field: DoubtField,
		reason: string,
		atPos?: number,
	): void {
		const live = this.liveRecord(session)
		if (!live) return
		const record = this.sources.get(live.sourceId)
		if (!record) return
		// A lower bound: clamped into the session; anything unusable reads as its start (strictest).
		let pos = live.pos
		if (atPos !== undefined)
			pos =
				typeof atPos === "number" && Number.isFinite(atPos)
					? Math.min(live.pos, Math.max(0, atPos))
					: 0
		const doubt: TuningDoubt = {
			session: live.session,
			field,
			pos,
			afterSeq: record.seq,
			reason,
		}
		// Insert in position order, after any equal position (64 at most: a linear scan).
		let i = live.doubts.length
		while (i > 0 && live.doubts[i - 1]!.pos > pos) i--
		live.doubts.splice(i, 0, doubt)
		if (live.doubts.length > TUNING_LEDGER_RING) {
			const gone = live.doubts.shift()!
			for (const f of ["frequency", "sampleRate"] as const) {
				if (gone.field !== f && gone.field !== "both") continue
				const range = live.evictedDoubt[f]
				live.evictedDoubt[f] = range
					? {
							minPos: Math.min(range.minPos, gone.pos),
							maxAfterSeq: Math.max(range.maxAfterSeq, gone.afterSeq),
						}
					: { minPos: gone.pos, maxAfterSeq: gone.afterSeq }
			}
		}
		this.notify(live.sourceId, { kind: "doubt", field })
	}

	/**
	 * A standing hold on `field` of the live session (`reason`, a fixed string), or none (null):
	 * while it stands the field reads `unverified` (reason `doubt`, doubtReason the hold's) however
	 * many receipts follow, for evidence that lasts rather than happens once (a sustained
	 * rate-truth mismatch). It ends with the session. Cleared, it keeps covering the blocks that
	 * overlap its period (from the position it was set at to the one it was cleared at). False
	 * without a live session.
	 */
	setHold(sourceId: string, field: GatedField, reason: string | null): boolean {
		const record = this.sources.get(sourceId)
		const live = record?.live
		if (!record || !live) return false
		const had = live.holds.get(field)
		if (reason === null) {
			if (!had) return true
			live.holds.delete(field)
			const ranges = live.heldRanges[field]
			ranges.push({ start: had.start, end: live.pos, reason: had.reason })
			if (ranges.length > TUNING_LEDGER_RING) {
				const a = ranges.shift()!
				const b = ranges[0]!
				ranges[0] = {
					start: Math.min(a.start, b.start),
					end: Math.max(a.end, b.end),
					reason: b.reason,
				}
			}
		} else {
			if (had?.reason === reason) return true
			// A reason change keeps the period's start.
			live.holds.set(field, {
				reason,
				afterSeq: record.seq,
				start: had?.start ?? live.pos,
			})
		}
		this.notify(sourceId, { kind: "hold", field })
		return true
	}

	/**
	 * Evidence that the receiver may have moved without a receipt. `atPos` is a lower bound of the
	 * first position the evidence covers (clamped to `[0, live position]`); absent = the live
	 * position. No live session: nothing to doubt (everything is already `unverified`).
	 * `reason` must be a fixed string (it is shown in status).
	 */
	raiseDoubt(
		sourceId: string,
		field: DoubtField,
		reason: string,
		atPos?: number,
	): void {
		const live = this.sources.get(sourceId)?.live
		if (live) this.doubtSession(live, field, reason, atPos)
	}

	/**
	 * A detected scanner marker shows receipt `seq` took effect by `pos`: its boundary may move
	 * earlier, to `pos`, never below the receipt's own position and never later than the settle
	 * would put it. Returns false (nothing changed) for anything but a ring receipt of the live
	 * session and a valid position.
	 */
	lowerBoundary(
		sourceId: string,
		session: number,
		seq: number,
		pos: number,
	): boolean {
		try {
			const live = this.sources.get(sourceId)?.live
			if (!live || live.session !== session || !validPos(pos)) return false
			const receipt = live.receipts.find(r => r.seq === seq)
			if (!receipt) return false
			const at = Math.max(receipt.pos, pos)
			const prev = live.lowered.get(seq)
			live.lowered.set(seq, prev === undefined ? at : Math.min(prev, at))
			return true
		} catch {
			return false
		}
	}

	/** The live session and its position, or null. */
	position(sourceId: string): { session: number; pos: number } | null {
		const live = this.sources.get(sourceId)?.live
		return live ? { session: live.session, pos: live.pos } : null
	}

	/** Receipts of the live session, oldest first (diagnostics and tests). */
	receipts(sourceId: string): TuningReceipt[] {
		return (this.sources.get(sourceId)?.live?.receipts ?? []).map(r => ({
			...r,
		}))
	}

	/** Doubts of the live session, in position order (diagnostics and tests). */
	doubts(sourceId: string): TuningDoubt[] {
		return (this.sources.get(sourceId)?.live?.doubts ?? []).map(d => ({
			...d,
		}))
	}

	/** Trust of the block `[posA, posB)` of `session` (see the invariant above). */
	trustAt(
		sourceId: string,
		session: number,
		posA: number,
		posB: number,
	): TrustVerdict {
		try {
			return this.trustAtUnsafe(sourceId, session, posA, posB)
		} catch {
			return unverified("lookup-failed")
		}
	}

	/** Trust of the next payload byte of the live session (receipts at the current position count). */
	trustNow(sourceId: string): TrustVerdict {
		try {
			const record = this.sources.get(sourceId)
			if (!record) return unverified("unknown-source")
			if (!record.live)
				return unverified(
					record.sessions === 0 ? "no-session" : "session-ended",
				)
			return this.verdict(record.live, record.live.pos, record.live.pos + 1)
		} catch {
			return unverified("lookup-failed")
		}
	}

	/**
	 * Per field: proven, settling (receipt not yet past its settle) or unverified, at the live edge,
	 * with the newest frame written and not yet receipted (`queued`).
	 */
	fieldState(sourceId: string): Record<GatedField | "gain", FieldState> {
		const none = (
			reason: UnverifiedReason,
			queued: QueuedFrameState | null = null,
		): FieldState => ({
			state: "unverified",
			value: null,
			writer: null,
			session: null,
			receipt: null,
			queued,
			reason,
		})
		try {
			const record = this.sources.get(sourceId)
			const queuedOf = (field: TuningField): QueuedFrameState | null =>
				record?.current?.queuedFrame(field) ?? null
			const live = record?.live
			if (!record || !live) {
				const reason: UnverifiedReason = !record
					? "unknown-source"
					: record.sessions === 0
						? "no-session"
						: "session-ended"
				return {
					frequency: none(reason, queuedOf("frequency")),
					sampleRate: none(reason, queuedOf("sampleRate")),
					gain: none(reason, queuedOf("gain")),
				}
			}
			const end = live.pos + 1
			const gated = (field: GatedField): FieldState => {
				const queued = queuedOf(field)
				const hold = live.holds.get(field)
				const proof = this.proveField(live, field, live.pos, end, true)
				const last = this.lastReceipt(live, field, end)
				const stateOf = (p: FieldProof): FieldProofState =>
					p.ok ? "proven" : p.reason === "settling" ? "settling" : "unverified"
				const holdInfo = hold
					? {
							hold: {
								reason: hold.reason,
								answered:
									queued !== null ||
									(last !== null && last.seq > hold.afterSeq),
								withoutHold: stateOf(proof),
							},
						}
					: {}
				if (proof.ok && !hold)
					return {
						state: "proven",
						value: proof.receipt.value,
						writer: proof.receipt.writer ?? null,
						session: live.session,
						receipt: proof.receipt.seq,
						queued,
					}
				const base: FieldState = {
					state: hold ? "unverified" : stateOf(proof),
					value: last?.value ?? null,
					writer: last?.writer ?? null,
					session: live.session,
					receipt: last?.seq ?? null,
					queued,
					...holdInfo,
				}
				if (hold) {
					base.reason = "doubt"
					base.doubtReason = hold.reason
				} else if (!proof.ok) {
					base.reason = proof.reason
					if (proof.doubtReason !== undefined)
						base.doubtReason = proof.doubtReason
				}
				return base
			}
			// Gain never gates: its state is "proven" once a gain frame settled, as information.
			const gainReceipt = this.lastReceipt(live, "gain", end)
			const gainQueued = queuedOf("gain")
			const gain: FieldState = gainReceipt
				? {
						state:
							gainReceipt.pos + this.settleFor(live, gainReceipt, end) <=
							live.pos
								? "proven"
								: "settling",
						value: gainReceipt.value,
						writer: gainReceipt.writer ?? null,
						session: live.session,
						receipt: gainReceipt.seq,
						queued: gainQueued,
					}
				: { ...none("no-receipt", gainQueued), session: live.session }
			return {
				frequency: gated("frequency"),
				sampleRate: gated("sampleRate"),
				gain,
			}
		} catch {
			return {
				frequency: none("lookup-failed"),
				sampleRate: none("lookup-failed"),
				gain: none("lookup-failed"),
			}
		}
	}

	// === internals ===

	private sourceRecord(sourceId: string): SourceRecord {
		let record = this.sources.get(sourceId)
		if (!record) {
			record = { sessions: 0, seq: 0, live: null, current: null }
			this.sources.set(sourceId, record)
		}
		return record
	}

	private liveRecord(session: LedgerSession): SessionRecord | null {
		if (!(session instanceof SessionRecord) || session.ended) return null
		return this.sources.get(session.sourceId)?.live === session ? session : null
	}

	private trustAtUnsafe(
		sourceId: unknown,
		session: unknown,
		posA: unknown,
		posB: unknown,
	): TrustVerdict {
		if (typeof sourceId !== "string") return unverified("bad-input")
		if (typeof session !== "number" || !Number.isSafeInteger(session))
			return unverified("bad-input")
		if (!validPos(posA) || !validPos(posB) || posA > posB)
			return unverified("bad-input")
		const record = this.sources.get(sourceId)
		if (!record) return unverified("unknown-source")
		const live = record.live
		if (session < 1 || session > record.sessions)
			return unverified("unknown-session")
		if (!live || live.session !== session) return unverified("session-ended")
		if (posB > live.pos) return unverified("beyond-known")
		return this.verdict(live, posA, posB)
	}

	private verdict(
		live: SessionRecord,
		posA: number,
		posB: number,
	): TrustVerdict {
		const frequency = this.proveField(live, "frequency", posA, posB)
		if (!frequency.ok)
			return unverified(frequency.reason, frequency.doubtReason)
		const rate = this.proveField(live, "sampleRate", posA, posB)
		if (!rate.ok) return unverified(rate.reason, rate.doubtReason)
		const relay =
			frequency.receipt.writer === "relay" || rate.receipt.writer === "relay"
		return {
			trust: relay ? "relay" : "commanded",
			frequency: frequency.receipt.value,
			sampleRate: rate.receipt.value,
			receipts: {
				frequency: frequency.receipt.seq,
				sampleRate: rate.receipt.seq,
			},
		}
	}

	/**
	 * The last receipt of `field` with `pos < posB`: in the ring, else the field's newest evicted
	 * receipt when it lies before `posB` (no ring receipt of the field does, and every older one is
	 * older still); else null.
	 */
	private lastReceipt(
		live: SessionRecord,
		field: TuningField,
		posB: number,
	): TuningReceipt | null {
		for (let i = live.receipts.length - 1; i >= 0; i--) {
			const r = live.receipts[i]!
			if (r.field === field && r.pos < posB) return r
		}
		const pinned = live.pinned.get(field)
		return pinned && pinned.pos < posB ? pinned : null
	}

	private proveField(
		live: SessionRecord,
		field: GatedField,
		posA: number,
		posB: number,
		ignoreHold = false,
	): FieldProof {
		const receipt = this.lastReceipt(live, field, posB)
		if (!receipt)
			return {
				ok: false,
				reason:
					(live.evicted.get(field) ?? 0) > 0 ? "older-than-ring" : "no-receipt",
			}
		// A pinned (evicted) proof holds only for reads ending past every evicted receipt.
		if (live.pinned.get(field) === receipt && posB <= live.evictedMaxPos)
			return { ok: false, reason: "older-than-ring" }
		if (receipt.writer === undefined) return { ok: false, reason: "no-writer" }
		if (!validValue(field, receipt.value))
			return { ok: false, reason: "invalid-value" }
		// A standing hold covers every read while it stands (it ends with the session).
		const hold = ignoreHold ? undefined : live.holds.get(field)
		if (hold) return { ok: false, reason: "doubt", doubtReason: hold.reason }
		// A cleared hold still covers the blocks that overlap its period.
		for (const h of live.heldRanges[field])
			if (posA < h.end && posB > h.start)
				return { ok: false, reason: "doubt", doubtReason: h.reason }
		// A doubt unproves the receipts raised before it (by seq), from its position on; equal
		// positions do not matter: a receipt after the doubt re-proves.
		const evicted = live.evictedDoubt[field]
		if (evicted && evicted.maxAfterSeq >= receipt.seq && evicted.minPos < posB)
			return { ok: false, reason: "doubt", doubtReason: "older-than-ring" }
		for (const d of live.doubts) {
			if (d.pos >= posB) break
			if (d.afterSeq < receipt.seq) continue
			if (d.field === field || d.field === "both")
				return { ok: false, reason: "doubt", doubtReason: d.reason }
		}
		const settle = this.settleFor(live, receipt, posB)
		let boundary = receipt.pos + settle
		const lowered = live.lowered.get(receipt.seq)
		if (lowered !== undefined)
			boundary = Math.max(receipt.pos, Math.min(boundary, lowered))
		// Centre- (and rate-) moving frames flushed after the receipt push its boundary; of the
		// evicted ones the newest has the highest position, so it alone can push further.
		const movers = field === "frequency" ? CENTRE_MOVERS : RATE_MOVERS
		for (const r of live.receipts) {
			if (r.seq <= receipt.seq || r.pos >= posB || !movers.has(r.field))
				continue
			boundary = Math.max(boundary, r.pos + settle)
		}
		const evictedMover =
			field === "frequency"
				? live.evictedMovers.centre
				: live.evictedMovers.rate
		if (
			evictedMover &&
			evictedMover.seq > receipt.seq &&
			evictedMover.pos < posB
		)
			boundary = Math.max(boundary, evictedMover.pos + settle)
		if (!(posA >= boundary)) return { ok: false, reason: "settling" }
		return { ok: true, receipt, boundary }
	}

	/**
	 * Settle in bytes for receipt `receipt` read up to `posB`: a configured time settle is more bytes
	 * at a higher rate, so at the highest rate that can be in effect over `[receipt.pos, posB)`: the
	 * rate in effect before the receipt (its rate receipt; the session's running maximum when that
	 * left the ring or is invalid; the higher of the caps rate at the session start and now when
	 * the session has written no rate before it),
	 * and every valid rate receipted from the receipt on before `posB`. No usable rate: +Infinity
	 * (nothing settles).
	 */
	private settleFor(
		live: SessionRecord,
		receipt: TuningReceipt,
		posB: number,
	): number {
		let rate = 0
		let before: TuningReceipt | null = null
		for (const r of live.receipts) {
			if (r.field !== "sampleRate") continue
			if (r.seq < receipt.seq) {
				before = r
				continue
			}
			if (r.pos >= posB) break
			if (validValue("sampleRate", r.value)) rate = Math.max(rate, r.value)
		}
		if (before)
			rate = Math.max(
				rate,
				validValue("sampleRate", before.value) ? before.value : live.maxRate,
			)
		else if ((live.evicted.get("sampleRate") ?? 0) > 0)
			rate = Math.max(rate, live.maxRate)
		else {
			// The caps rate at the session start or now, whichever is higher: caps may already
			// show the rate the first rate receipt wrote.
			rate = Math.max(rate, live.capsAtStart)
			const caps = this.opts.capsRate?.(live.sourceId) ?? 0
			if (typeof caps === "number" && Number.isFinite(caps))
				rate = Math.max(rate, caps)
		}
		const frameBytes = this.opts.frameBytes
			? this.opts.frameBytes(live.sourceId)
			: 2
		if (frameBytes === null) return Number.POSITIVE_INFINITY
		const link = this.opts.settleLink?.(live.sourceId) ?? {
			configuredSettleMs: DEFAULT_LEDGER_SETTLE_MS,
		}
		return settleBytes(rate, frameBytes, link)
	}
}
