/**
 * Rate-truth check: compares a source's measured byte rate with what its
 * declared caps imply (caps.sampleRate × bytes per sample) and flags a
 * sustained mismatch. Warning only; caps are never corrected from it.
 *
 * Incident (2026-10-09): an external SDR++ client left the dongle at about
 * 2.16 Msps for 8 h while caps said 2.048 Msps, silently breaking decodes.
 *
 * A short burst (catch-up after a stall) must not flag, so a mismatch has to
 * hold in the same direction on every stable interval for the sustain period;
 * clearing needs the same period of agreement. Faster than declared can only
 * mean a wrong declared rate; slower can also be delivery loss upstream.
 */

import type { SourceCaps } from "../config.js"

/** Relative deviation tolerated before an interval counts as a mismatch. */
export const RATE_TRUTH_TOLERANCE = 0.02
/** How long a mismatch (or, to clear it, agreement) must hold. */
export const RATE_TRUTH_SUSTAIN_MS = 30_000

/** Wire bytes per sample for a declared format; undefined when unknown. */
export function bytesPerSampleFor(
	caps: Pick<SourceCaps, "format" | "channels">,
): number | undefined {
	switch (caps.format) {
		case "U8_IQ":
			return 2
		case "S16_IQ":
			return 4
		case "S16LE":
			return 2 * (caps.channels ?? 1)
		case "FLOAT32LE":
			return 4 * (caps.channels ?? 1)
		default:
			return undefined
	}
}

export interface RateTruthSample {
	/** End of the interval (ms since epoch). */
	atMs: number
	elapsedMs: number
	bytes: number
	declaredSampleRateHz: number
	bytesPerSample: number
	/** False when the interval cannot be trusted (paused, reconnecting). */
	stable: boolean
}

export interface RateMismatch {
	declaredSampleRateHz: number
	/** Mean over the current mismatching run. */
	measuredSampleRateHz: number
	/** measured / declared − 1; positive = faster than declared. */
	deviation: number
	/** When this mismatching run was first observed. */
	since: Date
}

interface Run {
	sign: -1 | 0 | 1
	startedAtMs: number
	elapsedMs: number
	bytes: number
}

export class RateTruthTracker {
	private flagged: RateMismatch | undefined
	private run: Run | undefined
	private declaredSampleRateHz: number | undefined
	private bytesPerSample: number | undefined

	constructor(
		private readonly tolerance = RATE_TRUTH_TOLERANCE,
		private readonly sustainMs = RATE_TRUTH_SUSTAIN_MS,
	) {}

	get mismatch(): RateMismatch | undefined {
		return this.flagged ? { ...this.flagged } : undefined
	}

	/** Forgets everything; returns true when a flag was cleared. */
	reset(): boolean {
		const wasFlagged = this.flagged !== undefined
		this.flagged = undefined
		this.run = undefined
		this.declaredSampleRateHz = undefined
		this.bytesPerSample = undefined
		return wasFlagged
	}

	/** Feeds one interval; returns the transition it caused, if any. */
	observe(sample: RateTruthSample): "flagged" | "cleared" | null {
		const declaredChanged =
			(this.declaredSampleRateHz !== undefined &&
				this.declaredSampleRateHz !== sample.declaredSampleRateHz) ||
			(this.bytesPerSample !== undefined &&
				this.bytesPerSample !== sample.bytesPerSample)
		if (declaredChanged) {
			// The interval straddles the change: start over without it.
			const cleared = this.reset()
			this.declaredSampleRateHz = sample.declaredSampleRateHz
			this.bytesPerSample = sample.bytesPerSample
			return cleared ? "cleared" : null
		}
		this.declaredSampleRateHz = sample.declaredSampleRateHz
		this.bytesPerSample = sample.bytesPerSample

		const valid =
			sample.stable &&
			sample.elapsedMs > 0 &&
			// Nothing delivered is a waiting/stale source, not a rate: activity
			// already reports it, and it must not read as -100 %.
			sample.bytes > 0 &&
			sample.declaredSampleRateHz > 0 &&
			sample.bytesPerSample > 0
		if (!valid) {
			this.run = undefined
			return null
		}

		const measuredHz =
			sample.bytes / sample.bytesPerSample / (sample.elapsedMs / 1000)
		const deviation = measuredHz / sample.declaredSampleRateHz - 1
		const sign: Run["sign"] =
			Math.abs(deviation) <= this.tolerance ? 0 : deviation > 0 ? 1 : -1

		if (this.run?.sign === sign) {
			this.run.elapsedMs += sample.elapsedMs
			this.run.bytes += sample.bytes
		} else {
			this.run = {
				sign,
				startedAtMs: sample.atMs,
				elapsedMs: sample.elapsedMs,
				bytes: sample.bytes,
			}
		}
		const sustained = this.run.elapsedMs >= this.sustainMs

		if (sign === 0) {
			if (this.flagged && sustained) {
				this.flagged = undefined
				return "cleared"
			}
			return null
		}
		if (!sustained) return null

		const runHz =
			this.run.bytes / sample.bytesPerSample / (this.run.elapsedMs / 1000)
		const wasFlagged = this.flagged !== undefined
		this.flagged = {
			declaredSampleRateHz: sample.declaredSampleRateHz,
			measuredSampleRateHz: Math.round(runHz),
			deviation: runHz / sample.declaredSampleRateHz - 1,
			since: new Date(this.run.startedAtMs),
		}
		return wasFlagged ? null : "flagged"
	}
}
