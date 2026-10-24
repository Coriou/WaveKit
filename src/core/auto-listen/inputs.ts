/**
 * Router inputs (docs/specs/auto-listen-route/design.md, Inputs): the analog input and one voice
 * input per decoder. Each resamples straight into its own 48 kHz `SourceFifo` through a
 * preallocated scratch copy (requirement 2.4), and accounts every sample that leaves its FIFO so
 * the router can count drops (requirements 4.3, 4.10) and trace provenance.
 */
import type { PcmFormat, StreamFormat } from "../audio-stream-server.js"
import type { VoiceCoverage, VoiceTapCall } from "./contract.js"
import { LIVE_AUDIO_AUTO_ROUTE_RATE } from "@wavekit/api-types"
import { PolyphaseResampler } from "./resampler.js"
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
 * The resampler's integer input rate for a pipeline rate: the nearest integer. The error is at
 * most 0.5 Hz, so at most 0.5 / 8 000 = 62.5 ppm (24 975.61 Hz: 0.39 / 24 975.61 = 15.6 ppm).
 * The pacer absorbs it: at 62.5 ppm a continuous source is 48 000 × 62.5e-6 = 3 samples/s off,
 * one 960-sample block in 960 / 3 = 320 s (one underrun or a silent catch-up), no drift kept.
 */
export function resamplerInputRate(rate: number): number {
	return Math.round(rate)
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

	/** Clears the FIFO (counted) and the resampler state (requirement 5.1). */
	reset(): void {
		this.out.dropAll()
		this.res?.reset()
		this.remLen = 0
		this.lastAudibleAt = Number.NEGATIVE_INFINITY
		this.audibleNow = false
	}

	/** Route stopped: empty everything without counting. */
	stop(): void {
		this.out.clearUncounted()
		this.res?.reset()
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
		this.res = new PolyphaseResampler(
			resamplerInputRate(stream.rate),
			LIVE_AUDIO_AUTO_ROUTE_RATE,
		)
		this.rate = stream.rate
		this.format = stream.format
		this.frameBytes = stream.format === "f32le" ? 4 : 2
		return true
	}
}

/**
 * Voice input for one decoder: 8 kHz s16le mono datagrams resampled to 48 kHz. Only admitted
 * frames are written (requirement 3.2); the resampler tail is flushed at call end or hold expiry
 * (4.11), and invalidation clears without flushing (4.10).
 */
export class VoiceInput {
	readonly id: string
	readonly out: RoutedFifo
	private readonly res: PolyphaseResampler
	private readonly scratch = new Scratch()
	/** N − 1 zeros: the full remaining filter support of the last real sample. */
	private readonly zeros: Int16Array
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

	/** Clears queued audio (counted) and the resampler, without a flush. */
	invalidate(): void {
		this.out.dropAll()
		this.res.reset()
		this.armed = false
	}

	/** Route stopped: empty everything without counting. */
	stop(): void {
		this.out.clearUncounted()
		this.res.reset()
		this.armed = false
		this.lastAdmittedAt = Number.NEGATIVE_INFINITY
	}
}
