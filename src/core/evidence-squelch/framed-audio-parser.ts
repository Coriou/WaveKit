/**
 * Framed Rust demod audio (`audioFraming: "wkaf1"`, evidence-squelch amendment A18): a push
 * parser that splits the socket stream back into PCM views and stage-1 markers, in stream order.
 *
 * The wire format is `native/wavekit-chan/src/framing.rs` (its `decode_stream` is the reference
 * decoder; the checks and reason names here mirror it). All fields are little-endian.
 *
 * Hot path (docs/PERFORMANCE.md rules 1 and 2): constant work per frame, one pass per chunk, PCM
 * forwarded as `chunk.subarray` views (never copied or scanned), one fixed 64-byte scratch for a
 * preamble, header or marker payload split across chunks, one small object per marker.
 */
import type { EvidencePcmFormat } from "./contract.js"

export const WKAF_MAGIC = 0x46414b57 // "WKAF" read as u32 LE
export const WKAF_VERSION = 1
export const WKAF_PREAMBLE_LEN = 16
export const WKAF_HEADER_LEN = 8
export const WKAF_MAX_PCM_PAYLOAD = 65_536
export const WKAF_MAX_MARKER_PAYLOAD = 64
export const WKAF_RATE_HZ = 48_000

export const WKAF_FORMAT_S16LE = 1
export const WKAF_FORMAT_F32LE = 2

export const WKAF_T_PCM = 1
export const WKAF_T_GATE_OPEN = 2
export const WKAF_T_GATE_CLOSE = 3
export const WKAF_T_RESET = 4
export const WKAF_T_DROP = 5
export const WKAF_T_BLOCK = 6
/** Types at or above this are ignorable; below it an unknown type is critical. */
export const WKAF_T_IGNORABLE_MIN = 0x8000

export const WKAF_GATE_LEN = 8
export const WKAF_DISCONTINUITY_LEN = 24
export const WKAF_BLOCK_LEN = 16

/** RESET / DROP flags. */
export const WKAF_FLAG_GATE_OPEN = 1
export const WKAF_FLAG_BURST_START = 2
/** DROP only: a reset happened inside the dropped run. */
export const WKAF_FLAG_RESET_INSIDE = 4

/**
 * Smallest framed `queueBytes` Rust accepts (`min_framed_queue_bytes`): two 32-byte DROP
 * records plus a one-sample PCM record.
 */
export function minFramedQueueBytes(format: EvidencePcmFormat): number {
	return (
		2 * (WKAF_HEADER_LEN + WKAF_DISCONTINUITY_LEN) +
		WKAF_HEADER_LEN +
		sampleBytes(format)
	)
}

export interface GateMarker {
	type: "gate"
	open: boolean
	at: number
}

export interface DiscontinuityMarker {
	type: "reset" | "drop"
	at: number
	/** RESET: dropped input samples; DROP: dropped output samples. */
	count: number
	flags: number
}

export interface BlockMarker {
	type: "block"
	at: number
	/** NaN when unmeasured. */
	powerDbfs: number
	/** NaN unusable, +Infinity a silent discriminator. */
	quietingDb: number
}

export type FramedMarker = GateMarker | DiscontinuityMarker | BlockMarker

/** Framing reasons stop the parser (requirement 9.6 (b)). */
export type FramingErrorReason =
	| "preamble"
	| "header-bound"
	| "pcm-partial"
	| "reserved"
	| "payload-length"
/** Marker reasons fail the run safe and keep parsing for PCM (requirement 9.6 (a)). */
export type MarkerErrorReason =
	| "unknown-critical"
	| "index-mismatch"
	| "gate-repeat"

export interface FramedAudioFault {
	kind: "framing" | "marker"
	reason: FramingErrorReason | MarkerErrorReason
	/** Frame type number when known (null for the preamble). */
	frameType: number | null
	/** Stream byte offset of the frame (or preamble) the fault was found in. */
	offset: number
}

export interface FramedAudioSink {
	/** A PCM view into the pushed chunk, consumed synchronously; may split a sample. */
	pcm(view: Buffer): void
	/** A trusted marker, at the running position. Not called after a marker fault. */
	marker(marker: FramedMarker): void
	/** At most one marker fault and at most one framing fault per parser. */
	fault(fault: FramedAudioFault): void
}

const Phase = {
	Preamble: 0,
	Header: 1,
	Pcm: 2,
	Payload: 3,
	Dead: 4,
} as const
type Phase = (typeof Phase)[keyof typeof Phase]

function sampleBytes(format: EvidencePcmFormat): number {
	return format === "s16le" ? 2 : 4
}

export class FramedAudioParser {
	private readonly scratch = Buffer.alloc(WKAF_MAX_MARKER_PAYLOAD)
	private readonly width: number
	private readonly formatCode: number
	private phase: Phase = Phase.Preamble
	/** Bytes held in `scratch` for the current preamble, header or payload. */
	private fill = 0
	/** Bytes the current preamble, header, payload or PCM run still needs. */
	private need = WKAF_PREAMBLE_LEN
	private frameType = 0
	private frameOffset = 0
	/** Stream byte offset of the next byte pushed. */
	private offset = 0
	private pos = 0
	private gate = false
	private burst = false
	private markerFailed = false

	constructor(
		format: EvidencePcmFormat,
		private readonly sink: FramedAudioSink,
	) {
		this.width = sampleBytes(format)
		this.formatCode = format === "s16le" ? WKAF_FORMAT_S16LE : WKAF_FORMAT_F32LE
	}

	/** Running output-sample position: delivered PCM plus DROP counts. */
	get position(): number {
		return this.pos
	}

	/** Stage 1 for the PCM that follows: the gate state, closed inside a discontinuity burst. */
	get stage1Open(): boolean {
		return this.gate && !this.burst && !this.markerFailed
	}

	get failed(): "none" | "marker" | "framing" {
		if (this.phase === Phase.Dead) return "framing"
		return this.markerFailed ? "marker" : "none"
	}

	push(chunk: Buffer): void {
		const length = chunk.length
		let i = 0
		while (i < length && this.phase !== Phase.Dead) {
			if (this.phase === Phase.Pcm) {
				const n = Math.min(this.need, length - i)
				this.need -= n
				this.offset += n
				this.sink.pcm(chunk.subarray(i, i + n))
				i += n
				if (this.need === 0) this.startHeader()
				continue
			}
			const want = this.need - this.fill
			let src: Buffer
			let at: number
			if (this.fill === 0 && length - i >= this.need) {
				// Whole field inside this chunk: read it in place.
				src = chunk
				at = i
				i += this.need
				this.offset += this.need
			} else {
				const n = Math.min(want, length - i)
				chunk.copy(this.scratch, this.fill, i, i + n)
				this.fill += n
				i += n
				this.offset += n
				if (this.fill < this.need) return
				src = this.scratch
				at = 0
			}
			this.fill = 0
			if (this.phase === Phase.Preamble) this.preamble(src, at)
			else if (this.phase === Phase.Header) this.header(src, at)
			else this.payload(src, at)
		}
	}

	private startHeader(): void {
		this.phase = Phase.Header
		this.need = WKAF_HEADER_LEN
		this.frameOffset = this.offset
	}

	private preamble(b: Buffer, o: number): void {
		const flags = b[o + 13] ?? 0
		if (
			b.readUInt32LE(o) !== WKAF_MAGIC ||
			b.readUInt16LE(o + 4) !== WKAF_VERSION ||
			b.readUInt16LE(o + 6) !== WKAF_PREAMBLE_LEN ||
			b.readUInt32LE(o + 8) !== WKAF_RATE_HZ ||
			b[o + 12] !== this.formatCode ||
			(flags & ~1) !== 0 ||
			b[o + 14] !== 0 ||
			b[o + 15] !== 0
		) {
			this.framing("preamble", null, 0)
			return
		}
		this.gate = (flags & 1) !== 0
		this.startHeader()
	}

	private header(b: Buffer, o: number): void {
		const type = b.readUInt16LE(o)
		const length = b.readUInt32LE(o + 4)
		this.frameType = type
		if (b[o + 2] !== 0 || b[o + 3] !== 0) {
			this.framing("reserved", type, this.frameOffset)
			return
		}
		if (type === WKAF_T_PCM) {
			if (length === 0 || length > WKAF_MAX_PCM_PAYLOAD) {
				this.framing("header-bound", type, this.frameOffset)
				return
			}
			if (length % this.width !== 0) {
				this.framing("pcm-partial", type, this.frameOffset)
				return
			}
			this.advance(length / this.width, type, this.frameOffset)
			this.phase = Phase.Pcm
			this.need = length
			return
		}
		const exact = markerLength(type)
		if (exact === null) {
			if (length > WKAF_MAX_MARKER_PAYLOAD) {
				this.framing("header-bound", type, this.frameOffset)
				return
			}
		} else if (length !== exact) {
			this.framing("payload-length", type, this.frameOffset)
			return
		}
		if (length === 0) {
			this.payload(b, o)
			return
		}
		this.phase = Phase.Payload
		this.need = length
	}

	private payload(b: Buffer, o: number): void {
		const type = this.frameType
		const frameOffset = this.frameOffset
		this.startHeader()
		if (type >= WKAF_T_IGNORABLE_MIN) return
		if (markerLength(type) === null) {
			this.markerFault("unknown-critical", type, frameOffset)
			return
		}
		const at = readU64(b, o)
		if (type === WKAF_T_RESET || type === WKAF_T_DROP) {
			// Rust checks the index before the reserved bytes; the reserved check is framing.
			const mismatch = !this.markerFailed && at !== this.pos
			for (let k = 17; k < 24; k++)
				if (b[o + k] !== 0) {
					this.framing("reserved", type, frameOffset)
					return
				}
			const count = readU64(b, o + 8)
			const flags = b[o + 16] ?? 0
			// Any u64 field past MAX_SAFE_INTEGER (read as -1) cannot be trusted.
			if (mismatch || (!this.markerFailed && count < 0)) {
				this.markerFault("index-mismatch", type, frameOffset)
				return
			}
			if (type === WKAF_T_DROP) this.advance(count, type, frameOffset)
			if (this.markerFailed) return
			this.gate = (flags & WKAF_FLAG_GATE_OPEN) !== 0
			this.burst = (flags & WKAF_FLAG_BURST_START) !== 0
			this.sink.marker({
				type: type === WKAF_T_RESET ? "reset" : "drop",
				at,
				count,
				flags,
			})
			return
		}
		if (this.markerFailed) return
		if (at !== this.pos) {
			this.markerFault("index-mismatch", type, frameOffset)
			return
		}
		if (type === WKAF_T_BLOCK) {
			this.sink.marker({
				type: "block",
				at,
				powerDbfs: b.readFloatLE(o + 8),
				quietingDb: b.readFloatLE(o + 12),
			})
			return
		}
		const open = type === WKAF_T_GATE_OPEN
		if (open === this.gate) {
			this.markerFault("gate-repeat", type, frameOffset)
			return
		}
		this.gate = open
		this.sink.marker({ type: "gate", open, at })
	}

	/**
	 * Advances the running position. A count past `Number.MAX_SAFE_INTEGER` (unreadable, -1) or a
	 * sum past it cannot be tracked exactly: a marker fault (framing stays intact, as in
	 * `decode_stream`, which tracks u64 and would report the next marker as `index-mismatch`).
	 * After a marker fault positions are no longer checked or advanced.
	 */
	private advance(count: number, type: number, offset: number): void {
		if (this.markerFailed) return
		if (count < 0 || count > Number.MAX_SAFE_INTEGER - this.pos) {
			this.markerFault("index-mismatch", type, offset)
			return
		}
		this.pos += count
	}

	private markerFault(
		reason: MarkerErrorReason,
		frameType: number,
		offset: number,
	): void {
		if (this.markerFailed) return
		this.markerFailed = true
		this.gate = false
		this.burst = false
		this.sink.fault({ kind: "marker", reason, frameType, offset })
	}

	private framing(
		reason: FramingErrorReason,
		frameType: number | null,
		offset: number,
	): void {
		this.phase = Phase.Dead
		this.gate = false
		this.sink.fault({ kind: "framing", reason, frameType, offset })
	}
}

function markerLength(type: number): number | null {
	switch (type) {
		case WKAF_T_GATE_OPEN:
		case WKAF_T_GATE_CLOSE:
			return WKAF_GATE_LEN
		case WKAF_T_RESET:
		case WKAF_T_DROP:
			return WKAF_DISCONTINUITY_LEN
		case WKAF_T_BLOCK:
			return WKAF_BLOCK_LEN
		default:
			return null
	}
}

/**
 * u64 LE as a number, exact up to `Number.MAX_SAFE_INTEGER`; a larger value is -1, which never
 * equals a position (always an index mismatch) and is rejected as a count.
 */
function readU64(b: Buffer, o: number): number {
	const high = b.readUInt32LE(o + 4)
	if (high >= 0x200000) return -1
	return high * 0x1_0000_0000 + b.readUInt32LE(o)
}
