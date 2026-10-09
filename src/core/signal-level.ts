/**
 * Signal-flat check: measures the IQ level of a source's byte stream and
 * flags a level that has stayed implausibly low. Warning only; sibling of the
 * rate-truth check (rate-truth.ts), which catches a wrong rate, not a dead one.
 *
 * Incident (2026-10-09): an external SDR++ client left the dongle at near-zero
 * gain. IQ kept flowing at the declared rate (u8 IQ std about 0.6 LSB), so no
 * check fired and every decoder silently decoded nothing all night.
 *
 * Cost: the stream is subsampled, one IQ component every SIGNAL_LEVEL_STRIDE
 * components of the stream (an odd stride, so I and Q alternate), about 4000
 * reads/s on a 2 Msps u8 stream. The level is the RMS of the components about
 * their zero point (127.5 for u8, 0 for s16), relative to that format's full
 * scale: dBFS = 20·log10(rms / fullScale). No DC removal.
 *
 * Levels are evaluated per metrics interval. A flag needs every measured
 * interval for the hold period to be below the threshold (a brief dip does not
 * flag); clearing needs the same period at or above threshold + hysteresis,
 * so a level hovering at the threshold does not flap.
 */

import type { SourceCaps } from "../config.js"

/**
 * Default flag threshold. u8 IQ (full scale 127.5 LSB): −40 dBFS is an RMS of
 * about 1.27 LSB. The incident's near-zero gain measured about 0.6 LSB
 * (−46.5 dBFS), barely above the 0.29 LSB of pure quantisation noise, while
 * an antenna noise floor at any sensible gain sits at several LSB (3 LSB is
 * about −32.6 dBFS, 8 LSB about −24 dBFS). −40 leaves about 6 dB of margin
 * on each side.
 */
export const SIGNAL_FLAT_THRESHOLD_DBFS = -40
/** How long a low level (or, to clear it, a recovered level) must hold. */
export const SIGNAL_FLAT_HOLD_MS = 30_000
/** Clearing needs the level back at or above threshold + this. */
export const SIGNAL_FLAT_HYSTERESIS_DB = 3
/** Components between two reads; odd so that I and Q alternate. */
export const SIGNAL_LEVEL_STRIDE = 1021
/** Floor for reported levels (an all-zero s16 stream would be −∞). */
export const SIGNAL_LEVEL_MIN_DBFS = -150

/** How one IQ component is stored on the wire. */
export interface IqComponentFormat {
	/** Bytes per component (one of I or Q). */
	bytes: 1 | 2
	/** Wire value of zero signal. */
	zero: number
	/** Distance from zero to full scale, in wire units. */
	fullScale: number
}

/**
 * Component format for the IQ formats sources actually deliver; undefined for
 * anything that is not interleaved IQ (audio PCM, auto-detected formats).
 * rtl_tcp delivers unsigned 8-bit IQ centred on 127.5; S16_IQ is signed
 * little-endian 16-bit.
 */
export function iqComponentFormatFor(
	caps: Pick<SourceCaps, "kind" | "format">,
): IqComponentFormat | undefined {
	if (caps.kind !== "iq") return undefined
	switch (caps.format) {
		case "U8_IQ":
			return { bytes: 1, zero: 127.5, fullScale: 127.5 }
		case "S16_IQ":
			return { bytes: 2, zero: 0, fullScale: 32768 }
		default:
			return undefined
	}
}

/** Level of a mean square (in normalised units) in dBFS, floored. */
export function meanSquareToDbfs(meanSquare: number): number {
	if (!(meanSquare > 0)) return SIGNAL_LEVEL_MIN_DBFS
	return Math.max(SIGNAL_LEVEL_MIN_DBFS, 10 * Math.log10(meanSquare))
}

export interface SignalLevelSample {
	/** End of the interval (ms since epoch). */
	atMs: number
	elapsedMs: number
}

export interface SignalFlat {
	/** Latest interval level while flagged. */
	levelDbfs: number
	thresholdDbfs: number
	/** When this low-level run was first observed. */
	since: Date
}

interface Run {
	low: boolean
	startedAtMs: number
	elapsedMs: number
}

export interface SignalLevelTrackerOptions {
	thresholdDbfs?: number | undefined
	holdMs?: number | undefined
	hysteresisDb?: number | undefined
	stride?: number | undefined
}

export class SignalLevelTracker {
	readonly thresholdDbfs: number
	private readonly holdMs: number
	private readonly hysteresisDb: number
	private readonly stride: number

	private format: IqComponentFormat | undefined
	/** Bytes to skip at the start of the next chunk before the next read. */
	private skip = 0
	private sumSquares = 0
	private count = 0
	private latest: number | undefined
	private run: Run | undefined
	private flagged: SignalFlat | undefined

	constructor(options: SignalLevelTrackerOptions = {}) {
		this.thresholdDbfs = options.thresholdDbfs ?? SIGNAL_FLAT_THRESHOLD_DBFS
		this.holdMs = options.holdMs ?? SIGNAL_FLAT_HOLD_MS
		this.hysteresisDb = options.hysteresisDb ?? SIGNAL_FLAT_HYSTERESIS_DB
		this.stride = Math.max(1, Math.floor(options.stride ?? SIGNAL_LEVEL_STRIDE))
	}

	/** Latest measured interval level; undefined until an interval had samples. */
	get levelDbfs(): number | undefined {
		return this.latest
	}

	get flat(): SignalFlat | undefined {
		return this.flagged ? { ...this.flagged } : undefined
	}

	/**
	 * Sets the wire format of the stream that follows (undefined: not
	 * measurable). A change forgets everything; returns true when a flag was
	 * cleared.
	 */
	setFormat(format: IqComponentFormat | undefined): boolean {
		const same =
			format?.bytes === this.format?.bytes &&
			format?.zero === this.format?.zero &&
			format?.fullScale === this.format?.fullScale
		if (same) return false
		const cleared = this.reset()
		this.format = format
		return cleared
	}

	/** Forgets everything but the format; returns true when a flag was cleared. */
	reset(): boolean {
		const wasFlagged = this.flagged !== undefined
		this.flagged = undefined
		this.run = undefined
		this.latest = undefined
		this.skip = 0
		this.sumSquares = 0
		this.count = 0
		return wasFlagged
	}

	/**
	 * Accumulates a subsample of the next stream bytes. Positions are tracked
	 * across chunks, so arbitrary TCP boundaries keep component alignment.
	 */
	feed(chunk: Buffer): void {
		const format = this.format
		if (!format) return
		const step = this.stride * format.bytes
		let i = this.skip
		for (; i < chunk.length; i += step) {
			// A component split across chunks is skipped, not reassembled.
			if (i + format.bytes > chunk.length) continue
			const raw = format.bytes === 1 ? chunk[i]! : chunk.readInt16LE(i)
			const x = (raw - format.zero) / format.fullScale
			this.sumSquares += x * x
			this.count++
		}
		this.skip = i - chunk.length
	}

	/**
	 * Closes one interval: computes its level from the samples fed since the
	 * previous call and returns the transition it caused, if any. An interval
	 * without samples (no bytes: waiting/stale source) never counts toward a
	 * flag or a clear.
	 */
	observe(sample: SignalLevelSample): "flagged" | "cleared" | null {
		const count = this.count
		const meanSquare = count > 0 ? this.sumSquares / count : 0
		this.sumSquares = 0
		this.count = 0
		if (count === 0 || sample.elapsedMs <= 0) {
			this.latest = undefined
			this.run = undefined
			return null
		}
		const level = Math.round(meanSquareToDbfs(meanSquare) * 10) / 10
		this.latest = level

		// While flagged, only a clearly recovered level counts as "not low".
		const low = this.flagged
			? level < this.thresholdDbfs + this.hysteresisDb
			: level < this.thresholdDbfs
		if (this.run?.low === low) {
			this.run.elapsedMs += sample.elapsedMs
		} else {
			this.run = {
				low,
				startedAtMs: sample.atMs - sample.elapsedMs,
				elapsedMs: sample.elapsedMs,
			}
		}
		const sustained = this.run.elapsedMs >= this.holdMs

		if (!low) {
			if (this.flagged && sustained) {
				this.flagged = undefined
				return "cleared"
			}
			return null
		}
		if (this.flagged) {
			this.flagged.levelDbfs = level
			return null
		}
		if (!sustained) return null
		this.flagged = {
			levelDbfs: level,
			thresholdDbfs: this.thresholdDbfs,
			since: new Date(this.run.startedAtMs),
		}
		return "flagged"
	}
}
