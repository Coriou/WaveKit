/**
 * Cheap per-track features from the FFT (spec §6.2). Envelopes are 1 ms per sample.
 * Thresholds follow output/scanner-research/scripts/classify_features.py.
 */

/** Normalised (biased) autocorrelation of the mean-removed envelope at `lagMs`. */
export function envelopeAcf(envelope: Float32Array, lagMs: number): number {
	const lag = Math.round(lagMs)
	const n = envelope.length
	if (lag <= 0 || n <= lag) return 0
	let mean = 0
	for (let i = 0; i < n; i++) mean += envelope[i] ?? 0
	mean /= n
	let energy = 0
	for (let i = 0; i < n; i++) energy += ((envelope[i] ?? 0) - mean) ** 2
	if (energy <= 0) return 0
	let acc = 0
	for (let i = 0; i + lag < n; i++)
		acc += ((envelope[i] ?? 0) - mean) * ((envelope[i + lag] ?? 0) - mean)
	return acc / energy
}

/** Width between the outermost bins in [startBin, endBin) that are within `belowPeakDb` of the peak. */
export function obwAtDb(
	powerDb: Float32Array,
	startBin: number,
	endBin: number,
	binHz: number,
	belowPeakDb: number,
): number {
	const lo = Math.max(0, startBin)
	const hi = Math.min(powerDb.length, endBin)
	if (hi <= lo) return 0
	let peak = -Infinity
	for (let i = lo; i < hi; i++) peak = Math.max(peak, powerDb[i] ?? -Infinity)
	const limit = peak - belowPeakDb
	let first = -1
	let last = -1
	for (let i = lo; i < hi; i++) {
		if ((powerDb[i] ?? -Infinity) < limit) continue
		if (first < 0) first = i
		last = i
	}
	return first < 0 ? 0 : (last - first + 1) * binHz
}

function percentile(sorted: Float32Array, q: number): number {
	const idx = Math.min(
		sorted.length - 1,
		Math.max(0, Math.round(q * (sorted.length - 1))),
	)
	return sorted[idx] ?? 0
}

/** Fraction of 1 ms samples above sqrt(p5·p95); 1 when the envelope spans less than 6 dB. */
export function dutyFromEnvelope(envelope: Float32Array): number | null {
	if (envelope.length < 50) return null
	const sorted = Float32Array.from(envelope).sort()
	const p5 = percentile(sorted, 0.05)
	const p95 = percentile(sorted, 0.95)
	if (p5 > 0 && p95 <= 4 * p5) return 1
	const threshold = Math.sqrt(Math.max(0, p5) * p95)
	let on = 0
	for (let i = 0; i < envelope.length; i++)
		if ((envelope[i] ?? 0) > threshold) on++
	return on / envelope.length
}

/**
 * narrow: ≤ 2 bins at −6 dB (a Hann-windowed carrier); flat: the bins within 20 dB of the peak
 * have a median at most 6 dB below it (4FSK flat top); peaked otherwise (analog FM).
 */
export function spectralShape(
	powerDb: Float32Array,
	startBin: number,
	endBin: number,
	binHz: number,
): "flat" | "peaked" | "narrow" {
	if (obwAtDb(powerDb, startBin, endBin, binHz, 6) <= 2 * binHz) return "narrow"
	const lo = Math.max(0, startBin)
	const hi = Math.min(powerDb.length, endBin)
	let peak = -Infinity
	for (let i = lo; i < hi; i++) peak = Math.max(peak, powerDb[i] ?? -Infinity)
	const inner: number[] = []
	for (let i = lo; i < hi; i++) {
		const p = powerDb[i] ?? -Infinity
		if (p >= peak - 20) inner.push(p)
	}
	inner.sort((a, b) => a - b)
	const median = inner[Math.floor(inner.length / 2)] ?? peak
	return peak - median <= 6 ? "flat" : "peaked"
}
