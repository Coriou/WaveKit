// src/core/spectrum/iq-ring.ts
/**
 * Raw IQ ring indexed by absolute sample number (spec § 4.8): the last
 * `capacitySamples` samples of one source stream (ringSeconds × fs), for
 * probe pre-roll (§ 6.5) and IQ evidence snippets (§ 8). Gaps (dropped
 * samples, counter runs) are recorded; a read that reaches past the oldest
 * sample or across a gap returns only the contiguous part after it. Reads
 * return copies.
 */
import { WaveKitError } from "../../utils/errors.js"

export class IqRing {
	private readonly bps: number
	private readonly capacity: number
	private readonly buf: Uint8Array
	private first: number | null = null
	private end = 0
	/** Ascending, non-overlapping [start, end) intervals not yet older than the ring. */
	private gaps: [number, number][] = []

	constructor(opts: { bytesPerSample: number; capacitySamples: number }) {
		if (
			!Number.isInteger(opts.bytesPerSample) ||
			opts.bytesPerSample < 1 ||
			!Number.isInteger(opts.capacitySamples) ||
			opts.capacitySamples < 1
		) {
			throw new WaveKitError(
				`Invalid IQ ring size ${opts.capacitySamples} × ${opts.bytesPerSample}`,
				"SCANNER_RING_CONFIG",
			)
		}
		this.bps = opts.bytesPerSample
		this.capacity = opts.capacitySamples
		this.buf = new Uint8Array(opts.capacitySamples * opts.bytesPerSample)
	}

	/** Oldest sample still held (equals newestSample while empty). */
	get oldestSample(): number {
		return this.first === null
			? this.end
			: Math.max(this.first, this.end - this.capacity)
	}

	/** One past the newest sample written or marked as gap. */
	get newestSample(): number {
		return this.end
	}

	/** Appends whole samples starting at `startSample` (≥ newestSample; a jump is a gap). */
	write(startSample: number, bytes: Uint8Array): void {
		if (bytes.length % this.bps !== 0) {
			throw new WaveKitError(
				`IQ ring write of ${bytes.length} bytes is not whole ${this.bps}-byte samples`,
				"SCANNER_RING_WRITE",
			)
		}
		this.advanceTo(startSample)
		const samples = bytes.length / this.bps
		const skip = Math.max(0, samples - this.capacity)
		for (let s = startSample + skip; s < startSample + samples; ) {
			const slot = s % this.capacity
			const run = Math.min(startSample + samples - s, this.capacity - slot)
			const from = (s - startSample) * this.bps
			this.buf.set(bytes.subarray(from, from + run * this.bps), slot * this.bps)
			s += run
		}
		this.end = startSample + samples
		this.prune()
	}

	/** Records `samples` missing samples starting at `startSample` (≥ newestSample). */
	markGap(startSample: number, samples: number): void {
		if (!Number.isSafeInteger(samples) || samples < 0) {
			throw new WaveKitError(
				`Invalid IQ ring gap of ${samples} samples`,
				"SCANNER_RING_WRITE",
			)
		}
		this.advanceTo(startSample)
		this.addGap(startSample, startSample + samples)
		this.end = startSample + samples
		this.prune()
	}

	/** Bytes of [fromSample, toSample) after the last gap or ring start inside it; null when nothing is left. */
	read(
		fromSample: number,
		toSample: number,
	): { startSample: number; bytes: Uint8Array } | null {
		let lo = Math.max(fromSample, this.oldestSample)
		const hi = Math.min(toSample, this.end)
		for (const [gs, ge] of this.gaps)
			if (gs < hi && ge > lo) lo = Math.max(lo, ge)
		if (this.first === null || lo >= hi) return null
		const out = new Uint8Array((hi - lo) * this.bps)
		for (let s = lo; s < hi; ) {
			const slot = s % this.capacity
			const run = Math.min(hi - s, this.capacity - slot)
			out.set(
				this.buf.subarray(slot * this.bps, (slot + run) * this.bps),
				(s - lo) * this.bps,
			)
			s += run
		}
		return { startSample: lo, bytes: out }
	}

	private advanceTo(startSample: number): void {
		if (!Number.isSafeInteger(startSample) || startSample < 0) {
			throw new WaveKitError(
				`Invalid IQ ring sample index ${startSample}`,
				"SCANNER_RING_WRITE",
			)
		}
		if (this.first === null) {
			this.first = startSample
			this.end = startSample
			return
		}
		if (startSample < this.end) {
			throw new WaveKitError(
				`IQ ring write at ${startSample} overlaps data up to ${this.end}`,
				"SCANNER_RING_WRITE",
			)
		}
		if (startSample > this.end) this.addGap(this.end, startSample)
	}

	private addGap(start: number, end: number): void {
		if (end <= start) return
		const last = this.gaps[this.gaps.length - 1]
		if (last !== undefined && last[1] === start) last[1] = end
		else this.gaps.push([start, end])
	}

	private prune(): void {
		const oldest = this.oldestSample
		while (this.gaps.length > 0 && this.gaps[0]![1] <= oldest) this.gaps.shift()
	}
}
