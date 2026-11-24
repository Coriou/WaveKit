/**
 * Copy (ghost) detection: the per-file fingerprint of a kept analog file and the pure comparison
 * of two of them (compareEnvelopes, sameAudio). A receiver front end that mixes strong signals
 * (third-order intermodulation, 2·f1 − f2) puts a second, weaker copy of a voice on another
 * frequency; the recorder keeps both files. Two files of one source and epoch that overlap in
 * time and carry the same audio envelope are the same audio; copy-detector.ts decides which one
 * is the copy (only with per-file evidence: copy-intermod.ts).
 *
 * The fingerprint is free: SpeechContentMeter (speech-content.ts) already computes, per 32 ms
 * frame (256 samples at 8 kHz) after its FFT, the 312.5 to 1 500 Hz band value
 * `10·log10(4·band/n² + 1)` (0 to about 90 dB in s16 units) and the frame's pitch
 * autocorrelation peak. The fingerprint stores that band value in 0.5 dB steps (one byte,
 * 0 = excluded) and one voicing bit per frame.
 *
 * Bounds (arithmetic):
 * - COPY_MAX_FRAMES = ceil(120 000 ms / 32 ms) = 3 750 frames: the longest file (120 s, the
 *   recorder's file limit; a roll-over part is its own file). 3 750 B of envelope + ceil(3 750 / 8)
 *   = 469 B of voicing per file, allocated once per file.
 * - Lags ℓ ∈ [−COPY_LAG_FRAMES, +COPY_LAG_FRAMES] = ±3 frames (±96 ms): the alignment error of two
 *   files of one sample clock (frame rounding, a channel filter's group delay difference).
 * - Comparison cost: two detrends of ≤ 3 750 frames, 7 lags × ≤ 3 750 frames × ~6 flops and
 *   2 × 16 autocorrelation lags × ≤ 3 750 frames: about 290 kflop, under a millisecond of one
 *   core. Scratch arrays are module-level (one comparison at a time: the detector is
 *   single-threaded and runs one comparison per call).
 */

/** Frame length in 8 kHz samples (speech-content.ts SPEECH_FRAME_SAMPLES): 32 ms. */
export const COPY_FRAME_SAMPLES = 256
/** Frame duration (ms): 256 / 8 000 s. */
export const COPY_FRAME_MS = 32
/** The longest file (ms): the recorder's 120 s file limit. */
export const COPY_MAX_FILE_MS = 120_000
/** ceil(120 000 / 32) = 3 750 frames. */
export const COPY_MAX_FRAMES = Math.ceil(COPY_MAX_FILE_MS / COPY_FRAME_MS)
/**
 * A frame with more exact-zero samples than this is excluded from the fingerprint (squelch-gated
 * and partly-zero frames). 4 zeros of 256 lower the frame's band power by at most 4/256 = 1.6 %,
 * 10·log10(1 − 0.016) ≈ −0.07 dB: kept. (The meter's own level ring keeps its 128 bound.)
 */
export const COPY_MAX_ZEROS = 4
/** Lag search: ±3 frames. */
export const COPY_LAG_FRAMES = 3
/** Minimum overlap (ms): 5 s. */
export const COPY_MIN_OVERLAP_MS = 5_000
/** Minimum valid frames: floor(5 000 / 32) = 156 frames (5 s). */
export const COPY_MIN_VALID_FRAMES = Math.floor(
	COPY_MIN_OVERLAP_MS / COPY_FRAME_MS,
)
/** The overlap must cover at least this share of the shorter file. */
export const COPY_MIN_OVERLAP_SHARE = 0.8
/** Valid frames (both files measured, lag 0) must be at least this share of the overlap. */
export const COPY_MIN_VALID_SHARE = 0.6
/** Detrend window: a centred moving average over 16 frames (0.5 s). */
export const COPY_DETREND_FRAMES = 16
/**
 * Eligibility: each file's detrended envelope std over its valid frames in the overlap must reach
 * 2.5 dB. Noise-only and silent-carrier envelopes sit near 0.7 dB (the band's 38 bins hold about
 * 76 degrees of freedom: 4.34·√(2/76) ≈ 0.7 dB rms); speech moves 5 to 10 dB.
 */
export const COPY_MIN_DEPTH_DB = 2.5
/** Eligibility: each file's pitched share over its valid frames in the overlap. */
export const COPY_MIN_VOICED_SHARE = 0.2
/** Autocorrelation lags of the effective sample size (Bartlett): 16 frames (0.5 s). */
export const COPY_NEFF_LAGS = 16
/** Same audio needs r* ≥ 0.6 … */
export const R_COPY_MIN = 0.6
/** … and a Fisher z of at least 6 standard errors (z = atanh(r*)·√(Neff − 3)). */
export const Z_COPY = 6
/** atanh is unbounded at r = 1: r is clamped to this for z (a constant envelope pair is never compared). */
const R_CLAMP = 0.999_999

/** One file's envelope: per frame 0 (excluded) or clamp(round(2·v), 1, 255); a voicing bitset. */
export interface CopyEnvelope {
	readonly env: Uint8Array
	readonly voiced: Uint8Array
	/** Whole frames measured (≤ COPY_MAX_FRAMES). */
	readonly frames: number
}

/** The placement of an envelope on its source's sample clock. */
export interface CopyPlacement extends CopyEnvelope {
	/** Input (IQ) sample of the file's first audio sample. */
	readonly startSample: number
	/** Input samples per frame: 256 · fs / 8 000. */
	readonly samplesPerFrame: number
}

/** Why two files were not compared. */
export type CopyNoCompare = "short" | "invalid" | "ineligible"

export interface CopyScore {
	readonly r: number
	readonly z: number
	readonly neff: number
	/** B's lag in frames relative to A at r*. */
	readonly lagFrames: number
	readonly validFrames: number
}

export type CopyComparison = CopyScore | { readonly noCompare: CopyNoCompare }

/** The band value v (dB) as the fingerprint byte: 0.5 dB steps, never 0 (0 marks excluded). */
export function envelopeByte(v: number): number {
	const b = Math.round(2 * v)
	return b < 1 ? 1 : b > 255 ? 255 : b
}

/** Whether frame k of a voicing bitset is set. */
export function voicedAt(voiced: Uint8Array, k: number): boolean {
	return ((voiced[k >> 3] ?? 0) & (1 << (k & 7))) !== 0
}

/**
 * Frames [from, to) of the overlap of `a` and `b` on the sample clock, in A's frame indices, and
 * B's frame offset (B frame j ↔ A frame j + off, the fractional offset rounded).
 */
export function overlapFrames(
	a: CopyPlacement,
	b: CopyPlacement,
): { from: number; to: number; off: number } {
	const off = Math.round((b.startSample - a.startSample) / a.samplesPerFrame)
	return {
		from: Math.max(0, off),
		to: Math.min(a.frames, b.frames + off),
		off,
	}
}

/**
 * The overlap rule in input samples: `|O| ≥ max(5 s, 0.8 × the shorter file)`, `rateHz` the
 * input rate (same source and epoch: the caller checks).
 */
export function overlapAllowed(
	a: CopyPlacement,
	b: CopyPlacement,
	rateHz: number,
): boolean {
	const aEnd = a.startSample + a.frames * a.samplesPerFrame
	const bEnd = b.startSample + b.frames * b.samplesPerFrame
	const o = Math.min(aEnd, bEnd) - Math.max(a.startSample, b.startSample)
	const shorter = Math.min(aEnd - a.startSample, bEnd - b.startSample)
	const minimum = Math.max(
		(COPY_MIN_OVERLAP_MS * rateHz) / 1000,
		COPY_MIN_OVERLAP_SHARE * shorter,
	)
	return o > 0 && o >= minimum
}

// Scratch, one comparison at a time: detrended values (NaN = excluded) and prefix sums.
const PAD = COPY_LAG_FRAMES
const xs = new Float64Array(COPY_MAX_FRAMES + 2 * PAD)
const ys = new Float64Array(COPY_MAX_FRAMES + 2 * PAD)
const sum = new Float64Array(COPY_MAX_FRAMES + 1)
const cnt = new Float64Array(COPY_MAX_FRAMES + 1)

/**
 * Detrends frames [from, to) of `e` (dB, 0.5 dB steps) into `out` from index 0: each valid
 * frame minus the mean of the valid frames in its centred 16-frame window; excluded → NaN.
 * Returns the std of the detrended values and the voiced share over the valid frames.
 */
function detrend(
	e: CopyEnvelope,
	from: number,
	to: number,
	out: Float64Array,
): { std: number; voicedShare: number; valid: number } {
	const n = to - from
	sum[0] = 0
	cnt[0] = 0
	for (let i = 0; i < n; i++) {
		const b = e.env[from + i] ?? 0
		sum[i + 1] = sum[i]! + (b === 0 ? 0 : b / 2)
		cnt[i + 1] = cnt[i]! + (b === 0 ? 0 : 1)
	}
	const half = COPY_DETREND_FRAMES / 2
	let valid = 0
	let voiced = 0
	let s1 = 0
	let s2 = 0
	for (let i = 0; i < n; i++) {
		const b = e.env[from + i] ?? 0
		if (b === 0) {
			out[i] = Number.NaN
			continue
		}
		const lo = Math.max(0, i - half)
		const hi = Math.min(n, i + half)
		const mean = (sum[hi]! - sum[lo]!) / (cnt[hi]! - cnt[lo]!)
		const d = b / 2 - mean
		out[i] = d
		valid++
		s1 += d
		s2 += d * d
		if (voicedAt(e.voiced, from + i)) voiced++
	}
	if (valid === 0) return { std: 0, voicedShare: 0, valid: 0 }
	const m = s1 / valid
	return {
		std: Math.sqrt(Math.max(0, s2 / valid - m * m)),
		voicedShare: voiced / valid,
		valid,
	}
}

/** Normalised autocorrelation of `v[0..n)` (NaN excluded) at lag k (0 with no pair). */
function autocorrelation(v: Float64Array, n: number, k: number): number {
	let s1 = 0
	let c = 0
	for (let i = 0; i < n; i++) {
		const x = v[i]!
		if (x === x) {
			s1 += x
			c++
		}
	}
	if (c === 0) return 0
	const m = s1 / c
	let num = 0
	let den = 0
	for (let i = 0; i < n; i++) {
		const x = v[i]!
		if (x !== x) continue
		den += (x - m) * (x - m)
		if (i + k < n) {
			const y = v[i + k]!
			if (y === y) num += (x - m) * (y - m)
		}
	}
	return den > 0 ? num / den : 0
}

/**
 * Compares the envelopes of two overlapping files (the caller has checked the overlap rule):
 * over the overlap, both detrended, each file eligible (depth and voicing), Pearson at lags
 * ±COPY_LAG_FRAMES, the best r* with a data-driven effective sample size (Bartlett over
 * COPY_NEFF_LAGS lags) and its Fisher z. Pure; never throws.
 */
export function compareEnvelopes(
	a: CopyPlacement,
	b: CopyPlacement,
): CopyComparison {
	const { from, to, off } = overlapFrames(a, b)
	const n = to - from
	if (n < COPY_MIN_VALID_FRAMES) return { noCompare: "short" }
	// A's frames [from, to) and B's [from − off, to − off), each detrended over its own overlap
	// frames (so the comparison is symmetric); B sits in `ys` after L excluded frames each side,
	// so A frame from + i pairs with B at lag ℓ as xs[i] with ys[L + i + ℓ].
	const L = COPY_LAG_FRAMES
	const xa = detrend(a, from, to, xs)
	for (let i = 0; i < L; i++) {
		ys[i] = Number.NaN
		ys[L + n + i] = Number.NaN
	}
	const yb = detrend(b, from - off, to - off, ys.subarray(L))
	// Lag 0 validity: both measured.
	let both = 0
	for (let i = 0; i < n; i++) {
		const x = xs[i]!
		const y = ys[i + L]!
		if (x === x && y === y) both++
	}
	if (both < COPY_MIN_VALID_FRAMES || both < COPY_MIN_VALID_SHARE * n)
		return { noCompare: "invalid" }
	if (
		xa.std < COPY_MIN_DEPTH_DB ||
		yb.std < COPY_MIN_DEPTH_DB ||
		xa.voicedShare < COPY_MIN_VOICED_SHARE ||
		yb.voicedShare < COPY_MIN_VOICED_SHARE
	)
		return { noCompare: "ineligible" }
	let best = Number.NEGATIVE_INFINITY
	let bestLag = 0
	let bestN = 0
	for (let lag = -L; lag <= L; lag++) {
		let c = 0
		let sx = 0
		let sy = 0
		let sxx = 0
		let syy = 0
		let sxy = 0
		for (let i = 0; i < n; i++) {
			const x = xs[i]!
			const y = ys[i + L + lag]!
			if (x !== x || y !== y) continue
			c++
			sx += x
			sy += y
			sxx += x * x
			syy += y * y
			sxy += x * y
		}
		if (c < COPY_MIN_VALID_FRAMES) continue
		const vx = c * sxx - sx * sx
		const vy = c * syy - sy * sy
		if (!(vx > 0) || !(vy > 0)) continue
		const r = (c * sxy - sx * sy) / Math.sqrt(vx * vy)
		if (r > best) {
			best = r
			bestLag = lag
			bestN = c
		}
	}
	if (!Number.isFinite(best)) return { noCompare: "invalid" }
	// Effective sample size: Neff = N / (1 + 2·Σ ρx(k)·ρy(k)), k = 1..16, clamped to [3, N].
	// Each file's own autocorrelation over its overlap frames (independent of the alignment).
	const yOwn = ys.subarray(L, L + n)
	let rho = 0
	for (let k = 1; k <= COPY_NEFF_LAGS; k++)
		rho += autocorrelation(xs, n, k) * autocorrelation(yOwn, n, k)
	const neff = Math.min(bestN, Math.max(3, bestN / (1 + 2 * rho)))
	const r = Math.max(-R_CLAMP, Math.min(R_CLAMP, best))
	const z = Math.atanh(r) * Math.sqrt(Math.max(0, neff - 3))
	return { r: best, z, neff, lagFrames: bestLag, validFrames: bestN }
}

/** Same audio: a score with r* ≥ R_COPY_MIN and z ≥ Z_COPY. */
export function sameAudio(c: CopyComparison): c is CopyScore {
	return !("noCompare" in c) && c.r >= R_COPY_MIN && c.z >= Z_COPY
}

/**
 * Excludes (zeroes) the envelope frames a source gap's silence fill spans: `gaps` in 8 kHz audio
 * samples [from, to) of the file (the gap's outputFrameIndex and its fill length).
 */
export function excludeGapFrames(
	env: Uint8Array,
	frames: number,
	gaps: readonly { readonly from: number; readonly to: number }[],
): void {
	for (const g of gaps) {
		if (!(g.to > g.from)) continue
		const first = Math.max(0, Math.floor(g.from / COPY_FRAME_SAMPLES))
		const last = Math.min(
			frames - 1,
			Math.floor((g.to - 1) / COPY_FRAME_SAMPLES),
		)
		for (let k = first; k <= last; k++) env[k] = 0
	}
}
