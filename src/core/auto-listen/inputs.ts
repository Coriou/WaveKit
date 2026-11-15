/**
 * Router inputs (docs/specs/auto-listen-route/design.md, Inputs): the analog input and one voice
 * input per decoder. Each resamples straight into its own 48 kHz `SourceFifo` through a
 * preallocated scratch copy (requirement 2.4), and accounts every sample that leaves its FIFO so
 * the router can count drops (requirements 4.3, 4.10) and trace provenance.
 */
import type { PcmFormat, StreamFormat } from "../audio-stream-server.js"
import { AUTO_ROUTE_PENDING_VOICE_MS } from "./contract.js"
import type { VoiceCoverage, VoiceTapCall } from "./contract.js"
import { LIVE_AUDIO_AUTO_ROUTE_RATE } from "@wavekit/api-types"
import { PolyphaseResampler, rationalRate } from "./resampler.js"
import { FLAG_ADMITTED, FLAG_SILENT, SourceFifo } from "./source-fifo.js"
import type { SampleFlag } from "./source-fifo.js"

/** A FIFO write, or why samples left a FIFO (played, silent discard, counted drop). */
export type AutoRouteTraceKind = "write" | "read" | "discard" | "drop"

/**
 * One FIFO event, for diagnostics and tests: `count` samples from absolute FIFO position
 * `from` (positions count every sample ever written to that source's FIFO). The object is
 * reused; copy what you keep.
 */
export interface AutoRouteTrace {
	kind: AutoRouteTraceKind
	/** "analog" or the decoder id. */
	source: string
	from: number
	count: number
}

export type AutoRouteTraceFn = (trace: Readonly<AutoRouteTrace>) => void

/** Shared drop counter (samples) for `autoRoute.droppedMs`. */
export interface DropCounter {
	droppedSamples: number
}

/**
 * A `SourceFifo` with absolute positions and drop accounting. Overflow, preemption and
 * invalidation drops are counted; silent discards (catch-up, non-selected) are not.
 */
export class RoutedFifo {
	readonly fifo: SourceFifo
	private readonly source: string
	private readonly counter: DropCounter
	private readonly traceFn: AutoRouteTraceFn | undefined
	private readonly trace: AutoRouteTrace
	private overflowSeen = 0
	/** Absolute position of the head (samples removed so far). */
	private removed = 0
	/** Absolute position of the tail (samples written so far). */
	private written = 0

	constructor(
		source: string,
		counter: DropCounter,
		traceFn: AutoRouteTraceFn | undefined,
	) {
		this.fifo = new SourceFifo()
		this.source = source
		this.counter = counter
		this.traceFn = traceFn
		this.trace = { kind: "read", source, from: 0, count: 0 }
	}

	get queued(): number {
		return this.fifo.queuedSamples
	}

	get queuedQualified(): number {
		return this.fifo.queuedAudibleSamples
	}

	get oldestAt(): number | null {
		return this.fifo.oldestQueuedAt
	}

	write(
		res: PolyphaseResampler,
		view: Int16Array | Float32Array,
		start: number,
		end: number,
		flag: SampleFlag,
		at: number,
	): void {
		const before = this.fifo.queuedSamples
		this.fifo.writeFrom(res, view, start, end, flag, at)
		const over = this.fifo.overflowDroppedSamples - this.overflowSeen
		const produced = this.fifo.queuedSamples - before + over
		if (produced > 0) {
			const from = this.written
			this.written += produced
			this.emitTrace("write", from, produced)
		}
		if (over > 0) {
			this.overflowSeen += over
			this.counter.droppedSamples += over
			this.note("drop", over)
		}
	}

	read(out: Int16Array, n: number): number {
		const got = this.fifo.read(out, 0, n)
		if (got > 0) this.note("read", got)
		return got
	}

	discardSilentHead(max: number): number {
		const n = this.fifo.discardSilentHead(max)
		if (n > 0) this.note("discard", n)
		return n
	}

	discardUntilAudible(): number {
		const n = this.fifo.discardUntilAudible()
		if (n > 0) this.note("discard", n)
		return n
	}

	/** Drops everything queued and counts it (preemption, invalidation, reset). */
	dropAll(): number {
		const n = this.fifo.queuedSamples
		this.fifo.clear()
		if (n > 0) {
			this.counter.droppedSamples += n
			this.note("drop", n)
		}
		return n
	}

	/** Empties the FIFO without counting (the route stopped: no client hears it). */
	clearUncounted(): void {
		const n = this.fifo.queuedSamples
		this.fifo.clear()
		if (n > 0) this.note("discard", n)
	}

	private note(kind: AutoRouteTraceKind, count: number): void {
		const from = this.removed
		this.removed += count
		this.emitTrace(kind, from, count)
	}

	private emitTrace(
		kind: AutoRouteTraceKind,
		from: number,
		count: number,
	): void {
		const fn = this.traceFn
		if (fn === undefined) return
		const t = this.trace
		t.kind = kind
		t.source = this.source
		t.from = from
		t.count = count
		fn(t)
	}
}

/** Typed views over one preallocated scratch, grown only on a new largest span. */
class Scratch {
	bytes: Buffer = Buffer.alloc(0)
	i16: Int16Array = new Int16Array(0)
	f32: Float32Array = new Float32Array(0)

	ensure(byteLength: number): void {
		if (byteLength <= this.bytes.length) return
		// Power of two, at least 4 kB: growth stops after the largest chunk has been seen once.
		let size = 4_096
		while (size < byteLength) size *= 2
		// A fresh ArrayBuffer (byte offset 0), so the Float32Array view is aligned.
		const ab = new ArrayBuffer(size)
		this.bytes = Buffer.from(ab)
		this.i16 = new Int16Array(ab)
		this.f32 = new Float32Array(ab)
	}
}

/**
 * Requirement 2.2: any pipeline rate from 8 000 to 200 000 Hz, fractional included (csdr's
 * channel rate is the IQ rate over the decimation: 1 024 000 / 41 = 24 975.61 Hz).
 */
function validStream(stream: StreamFormat): boolean {
	return (
		(stream.format === "s16le" || stream.format === "f32le") &&
		typeof stream.rate === "number" &&
		Number.isFinite(stream.rate) &&
		stream.rate >= 8_000 &&
		stream.rate <= 200_000
	)
}

/**
 * Analog input: client bytes of `/stream` in sample-aligned spans (requirement 3.6) with a
 * split-sample remainder (lead bytes completing a sample take the previous span's flag).
 * Rebuilds its resampler on a rate or format change, keeping the queued 48 kHz audio (5.2).
 */
export class AnalogInput {
	readonly out: RoutedFifo
	private res: PolyphaseResampler | null = null
	private rate = 0
	private format: PcmFormat = "s16le"
	private frameBytes = 2
	private readonly scratch = new Scratch()
	/** 4-byte remainder of a sample split across spans, with typed views over it. */
	private readonly remAb = new ArrayBuffer(4)
	private readonly rem = Buffer.from(this.remAb)
	private readonly remI16 = new Int16Array(this.remAb, 0, 1)
	private readonly remF32 = new Float32Array(this.remAb, 0, 1)
	private remLen = 0
	private remFlag: SampleFlag = FLAG_SILENT
	/** Spans were skipped since the last push: the resampler history is stale. */
	private skipped = false
	/** Clock time of the last audible span, -Infinity when none since the last reset. */
	lastAudibleAt = Number.NEGATIVE_INFINITY
	/** Flag of the last span. */
	audibleNow = false

	constructor(counter: DropCounter, trace: AutoRouteTraceFn | undefined) {
		this.out = new RoutedFifo("analog", counter, trace)
	}

	/** Pushes `chunk[start..end)` (bytes) with one qualification; returns false if rejected. */
	push(
		chunk: Buffer,
		start: number,
		end: number,
		flag: SampleFlag,
		stream: StreamFormat,
		now: number,
	): boolean {
		if (stream.rate !== this.rate || stream.format !== this.format) {
			if (!this.rebuild(stream)) return false
		}
		const res = this.res
		if (res === null) return false
		if (this.skipped) {
			this.skipped = false
			res.reset()
		}
		let s = Math.max(0, Math.min(chunk.length, Math.trunc(start) || 0))
		const e = Math.max(s, Math.min(chunk.length, Math.trunc(end) || 0))
		const audible = flag !== FLAG_SILENT
		this.audibleNow = audible
		if (audible) this.lastAudibleAt = now
		const fb = this.frameBytes
		const isFloat = this.format === "f32le"
		if (this.remLen > 0 && s < e) {
			const take = Math.min(fb - this.remLen, e - s)
			chunk.copy(this.rem, this.remLen, s, s + take)
			this.remLen += take
			s += take
			if (this.remLen === fb) {
				this.remLen = 0
				this.out.write(
					res,
					isFloat ? this.remF32 : this.remI16,
					0,
					1,
					this.remFlag,
					now,
				)
			}
		}
		const usable = e - s - ((e - s) % fb)
		if (usable > 0) {
			this.scratch.ensure(usable)
			chunk.copy(this.scratch.bytes, 0, s, s + usable)
			this.out.write(
				res,
				isFloat ? this.scratch.f32 : this.scratch.i16,
				0,
				usable / fb,
				flag,
				now,
			)
			s += usable
		}
		if (s < e) {
			chunk.copy(this.rem, 0, s, e)
			this.remLen = e - s
			this.remFlag = flag
		}
		return true
	}

	/**
	 * Listen: `chunk[start..end)` under a listen mode that never plays analog (`digital`, nothing
	 * pending): no resampling and no FIFO write. The audibility state is kept and the split
	 * sample stays exact (the span's last partial sample becomes the remainder), so a later
	 * `push` continues on the sample grid; the resampler history is reset before that push,
	 * since the skipped samples never entered it.
	 */
	skip(
		chunk: Buffer,
		start: number,
		end: number,
		flag: SampleFlag,
		stream: StreamFormat,
		now: number,
	): void {
		const s = Math.max(0, Math.min(chunk.length, Math.trunc(start) || 0))
		const e = Math.max(s, Math.min(chunk.length, Math.trunc(end) || 0))
		const audible = flag !== FLAG_SILENT
		this.audibleNow = audible
		if (audible) this.lastAudibleAt = now
		if (stream.rate !== this.rate || stream.format !== this.format) {
			// The next push rebuilds (and starts a new sample grid, as a rebuild always does).
			this.res = null
			this.rate = 0
			this.remLen = 0
			return
		}
		this.skipped = true
		const keep = (this.remLen + (e - s)) % this.frameBytes
		if (e - s >= keep) chunk.copy(this.rem, 0, e - keep, e)
		else chunk.copy(this.rem, this.remLen, s, e)
		this.remLen = keep
		this.remFlag = flag
	}

	/** Clears the FIFO (counted) and the resampler state (requirement 5.1). */
	reset(): void {
		this.out.dropAll()
		this.res?.reset()
		this.skipped = false
		this.remLen = 0
		this.lastAudibleAt = Number.NEGATIVE_INFINITY
		this.audibleNow = false
	}

	/**
	 * Listen: the listen mode in force does not play analog (`digital`): empty the FIFO without
	 * counting, keeping the resampler and the split sample so the stream stays continuous.
	 */
	discardQueued(): void {
		if (this.out.queued > 0) this.out.clearUncounted()
	}

	/** Route stopped: empty everything without counting. */
	stop(): void {
		this.out.clearUncounted()
		this.res?.reset()
		this.skipped = false
		this.remLen = 0
		this.lastAudibleAt = Number.NEGATIVE_INFINITY
		this.audibleNow = false
	}

	private rebuild(stream: StreamFormat): boolean {
		this.remLen = 0
		if (!validStream(stream)) {
			this.res = null
			this.rate = 0
			return false
		}
		// The exact fraction (rationalRate: csdr's IQ rate / decimation is recovered exactly), so
		// the 48 kHz output never drifts from the input; a rejected fraction rejects the stream.
		const exact = rationalRate(stream.rate)
		let res: PolyphaseResampler | null = null
		if (exact !== null) {
			try {
				res = new PolyphaseResampler(exact, LIVE_AUDIO_AUTO_ROUTE_RATE)
			} catch {
				res = null
			}
		}
		this.res = res
		if (res === null) {
			this.rate = 0
			return false
		}
		this.rate = stream.rate
		this.format = stream.format
		this.frameBytes = stream.format === "f32le" ? 4 : 2
		return true
	}
}

/**
 * Pending voice of one decoder: decoded voice (input rate) that is not admitted yet, with its
 * arrival time, in a preallocated ring of `AUTO_ROUTE_PENDING_VOICE_MS`. A write past the
 * capacity overwrites the oldest samples. Nothing here is ever counted dropped: pending voice
 * was never admitted, so letting it go is the fail-closed rule, not lost route audio.
 */
export class PendingVoice {
	readonly capacity: number
	private readonly samples: Int16Array
	private readonly arrivals: Float64Array
	private head = 0
	private size = 0

	constructor(voiceRate: number) {
		// 8 000 × 720 / 1 000 = 5 760 samples at the tap rate.
		this.capacity = Math.max(
			1,
			Math.ceil((voiceRate * AUTO_ROUTE_PENDING_VOICE_MS) / 1000),
		)
		this.samples = new Int16Array(this.capacity)
		this.arrivals = new Float64Array(this.capacity)
	}

	get length(): number {
		return this.size
	}

	/** Arrival time of the oldest pending sample, null when empty. */
	get oldestAt(): number | null {
		return this.size === 0 ? null : (this.arrivals[this.head] ?? null)
	}

	/** Appends whole s16le samples of `pcm` (a trailing odd byte is ignored), oldest overwritten. */
	write(pcm: Buffer, at: number): void {
		const n = pcm.length >> 1
		const cap = this.capacity
		// Only the newest `capacity` samples can stay.
		const skip = Math.max(0, n - cap)
		for (let i = skip; i < n; i++) {
			const idx = (this.head + this.size) % cap
			this.samples[idx] = pcm.readInt16LE(i * 2)
			this.arrivals[idx] = at
			if (this.size < cap) this.size++
			else this.head = (this.head + 1) % cap
		}
	}

	/** Forgets samples that arrived before `since`. */
	expire(since: number): void {
		while (this.size > 0 && (this.arrivals[this.head] ?? since) < since) {
			this.head = (this.head + 1) % this.capacity
			this.size--
		}
	}

	clear(): void {
		this.head = 0
		this.size = 0
	}

	/**
	 * Hands every pending sample, in order, to `sink` as runs of one arrival time within one
	 * contiguous ring segment (`view[start..end)`), then empties the ring.
	 */
	drain(
		sink: (view: Int16Array, start: number, end: number, at: number) => void,
	): void {
		const cap = this.capacity
		let left = this.size
		let at = this.head
		while (left > 0) {
			const t = this.arrivals[at] ?? 0
			let end = at + 1
			while (end < cap && end - at < left && this.arrivals[end] === t) end++
			sink(this.samples, at, end, t)
			left -= end - at
			at = end % cap
		}
		this.clear()
	}
}

/**
 * Voice input for one decoder: 8 kHz s16le mono datagrams resampled to 48 kHz. Only admitted
 * frames are written (requirement 3.2); the resampler tail is flushed at call end or hold expiry
 * (4.11), and invalidation clears without flushing (4.10). Voice handed over before its call is
 * active and clear waits in `pending` (see `PendingVoice`) until it is admitted or let go.
 */
export class VoiceInput {
	readonly id: string
	readonly out: RoutedFifo
	private readonly res: PolyphaseResampler
	private readonly scratch = new Scratch()
	/** N − 1 zeros: the full remaining filter support of the last real sample. */
	private readonly zeros: Int16Array
	/** Decoded voice not admitted yet (before the call is active and explicitly clear). */
	readonly pending: PendingVoice
	/**
	 * The last call snapshot's encryption is unresolved (`encryptionKnown === false`): not clear,
	 * so its voice waits in `pending`; see the router's `encryptionUnresolved`.
	 */
	unresolved = false
	/** Last call snapshot (frame or call event). */
	call: VoiceTapCall | null = null
	lastAdmittedAt = Number.NEGATIVE_INFINITY
	/** Real samples entered the resampler since the last flush or reset. */
	armed = false
	/** Coverage generation of the cached answer (NaN: never computed). */
	generation = Number.NaN
	coverage: VoiceCoverage = "unknown"

	constructor(
		id: string,
		voiceRate: number,
		counter: DropCounter,
		trace: AutoRouteTraceFn | undefined,
	) {
		this.id = id
		this.out = new RoutedFifo(id, counter, trace)
		this.res = new PolyphaseResampler(voiceRate, LIVE_AUDIO_AUTO_ROUTE_RATE)
		this.zeros = new Int16Array(this.res.taps)
		this.pending = new PendingVoice(voiceRate)
	}

	get taps(): number {
		return this.res.taps
	}

	/** Writes one admitted datagram (whole s16le samples; a trailing odd byte is ignored). */
	admit(pcm: Buffer, now: number): void {
		const usable = pcm.length - (pcm.length % 2)
		this.lastAdmittedAt = now
		if (usable === 0) return
		this.scratch.ensure(usable)
		pcm.copy(this.scratch.bytes, 0, 0, usable)
		this.out.write(
			this.res,
			this.scratch.i16,
			0,
			usable / 2,
			FLAG_ADMITTED,
			now,
		)
		this.armed = true
	}

	/**
	 * Admits the pending voice that arrived within `AUTO_ROUTE_PENDING_VOICE_MS` before `now`, in
	 * arrival order and under its arrival times (so the start buffer counts its real age), then
	 * empties it. Called only once the call is active, explicitly clear and covering.
	 */
	admitPending(now: number): void {
		const p = this.pending
		p.expire(now - AUTO_ROUTE_PENDING_VOICE_MS)
		if (p.length === 0) return
		p.drain(this.pendingSink)
		this.lastAdmittedAt = now
		this.armed = true
	}

	private readonly pendingSink = (
		view: Int16Array,
		start: number,
		end: number,
		at: number,
	): void => {
		this.out.write(this.res, view, start, end, FLAG_ADMITTED, at)
	}

	/**
	 * Completes every real sample's response with N − 1 zeros under the admission flag, then
	 * resets the resampler. Skipped while the history holds no real sample.
	 */
	flush(now: number): void {
		if (!this.armed) return
		this.out.write(
			this.res,
			this.zeros,
			0,
			this.zeros.length - 1,
			FLAG_ADMITTED,
			now,
		)
		this.res.reset()
		this.armed = false
	}

	/** Clears queued audio (counted) and the resampler, without a flush; pending voice goes uncounted. */
	invalidate(): void {
		this.out.dropAll()
		this.res.reset()
		this.armed = false
		this.pending.clear()
	}

	/**
	 * Listen: the listen mode in force does not play decoded voice (`analog`): queued voice and
	 * the resampler history are emptied without counting (policy, not lost audio).
	 */
	discard(): void {
		this.out.clearUncounted()
		this.res.reset()
		this.armed = false
		this.pending.clear()
	}

	/** Route stopped: empty everything without counting. */
	stop(): void {
		this.out.clearUncounted()
		this.res.reset()
		this.armed = false
		this.pending.clear()
		this.lastAdmittedAt = Number.NEGATIVE_INFINITY
	}
}
