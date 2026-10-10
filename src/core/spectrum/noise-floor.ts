/**
 * Noise floor estimation (spec § 4.3).
 *
 * - Block floor F_b: the 20th percentile of the block's per-bin power over the
 *   given bins, corrected by the chi-square quantile ratio for 2L degrees of
 *   freedom so it estimates the mean noise power. A low quantile stays on
 *   noise while most of the window is occupied (a 70 % occupied window still
 *   reads within 1 dB at L = 50).
 * - Absolute floor A(key): a slow minimum tracker over quiet blocks (no
 *   tracks, no gap, no overload), keyed `${fs}:${gainKey}:${fftSize}` and
 *   persisted with the engine state. The effective block floor is
 *   max(F_b, A − 1 dB); F_b > A + k marks the block `floorOccupied`.
 * - Per-bin baseline B_i in baseband bins, keyed like A: an exponential
 *   minimum tracker (falls with time constant tauBlocks/8, rises with
 *   tauBlocks), clamped to F_b ± 6 dB. It absorbs passband ripple. The
 *   per-bin floor is max(F_eff, B_i).
 *
 * Power arrays are FFT-shifted per-bin dBFS (spectrum/fft.ts conventions);
 * masks are Uint8Array with 1 = use this bin.
 */
import { WaveKitError } from "../../utils/errors.js"
import type { EngineState } from "./types.js"

export const FLOOR_QUANTILE = 0.2
export const BASELINE_CLAMP_DB = 6
export const ABSOLUTE_FLOOR_MARGIN_DB = 1
const BASELINE_FALL_SPEEDUP = 8

/** Inverse standard normal CDF (Acklam's rational approximation, |error| < 1.2e-9). */
function normalQuantile(p: number): number {
	const a = [
		-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2,
		1.38357751867269e2, -3.066479806614716e1, 2.506628277459239,
	]
	const b = [
		-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2,
		6.680131188771972e1, -1.328068155288572e1,
	]
	const c = [
		-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838,
		-2.549732539343734, 4.374664141464968, 2.938163982698783,
	]
	const d = [
		7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996,
		3.754408661907416,
	]
	const tail = (q: number): number =>
		(((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q +
			c[5]!) /
		((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1)
	if (p < 0.02425) return tail(Math.sqrt(-2 * Math.log(p)))
	if (p > 1 - 0.02425) return -tail(Math.sqrt(-2 * Math.log(1 - p)))
	const q = p - 0.5
	const r = q * q
	return (
		((((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r +
			a[5]!) *
			q) /
		(((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1)
	)
}

/**
 * 10·log10(Q_q(χ²_dof) / dof): how far the q-quantile of a mean of dof/2
 * exponential bin powers sits below their mean. Exact for dof = 2
 * (−2·ln(1 − q)); Wilson–Hilferty otherwise (< 0.05 dB error from dof 4 for
 * q in [0.1, 0.95]; 0.03 dB at the floor's q = 0.2).
 */
export function chiSquareQuantileRatioDb(
	dof: number,
	quantile: number,
): number {
	if (!(dof > 0) || !(quantile > 0 && quantile < 1)) {
		throw new WaveKitError(
			`Invalid chi-square quantile request dof=${dof} q=${quantile}`,
			"SCANNER_FLOOR_CONFIG",
		)
	}
	if (dof === 2) return 10 * Math.log10(-Math.log(1 - quantile))
	const h = 2 / (9 * dof)
	const x = Math.max(0, 1 - h + normalQuantile(quantile) * Math.sqrt(h))
	return 10 * Math.log10(Math.max(x * x * x, 1e-12))
}

export class NoiseFloor {
	private readonly fftSize: number
	private readonly tauBlocks: number
	private readonly correctionDb: number
	private readonly scratch: Float32Array
	private readonly absolute = new Map<string, number>()
	private readonly baselines = new Map<string, Float32Array>()
	private activeKey: string | null = null

	constructor(opts: {
		fftSize: number
		framesPerBlock: number
		tauBlocks: number
	}) {
		if (
			!Number.isInteger(opts.framesPerBlock) ||
			opts.framesPerBlock < 1 ||
			!(opts.tauBlocks >= 1)
		) {
			throw new WaveKitError(
				`Invalid noise floor options L=${opts.framesPerBlock} tau=${opts.tauBlocks}`,
				"SCANNER_FLOOR_CONFIG",
			)
		}
		this.fftSize = opts.fftSize
		this.tauBlocks = opts.tauBlocks
		this.correctionDb = chiSquareQuantileRatioDb(
			2 * opts.framesPerBlock,
			FLOOR_QUANTILE,
		)
		this.scratch = new Float32Array(opts.fftSize)
	}

	/** F_b over bins with unmasked[i] = 1 (§ 4.3). Throws when no bin is unmasked. */
	blockFloor(powerDb: Float32Array, unmasked: Uint8Array): number {
		let m = 0
		for (let i = 0; i < this.fftSize; i++)
			if (unmasked[i] === 1) this.scratch[m++] = powerDb[i]!
		if (m === 0)
			throw new WaveKitError(
				"Block floor needs at least one unmasked bin",
				"SCANNER_FLOOR_EMPTY",
			)
		const sorted = this.scratch.subarray(0, m).sort()
		const rank = Math.max(0, Math.ceil(FLOOR_QUANTILE * m) - 1)
		return sorted[rank]! - this.correctionDb
	}

	/** Selects the per-bin baseline used by perBinFloor (call at every epoch start). */
	useKey(absKey: string): void {
		this.activeKey = absKey
	}

	/**
	 * Learns from one settled block (never a gap or overload block). `learnMask`
	 * marks bins that are unmasked and not on, so emissions never raise the
	 * floor. The absolute floor learns only when `quiet`.
	 */
	update(
		powerDb: Float32Array,
		learnMask: Uint8Array,
		quiet: boolean,
		absKey: string,
	): void {
		this.activeKey = absKey
		let any = false
		for (let i = 0; i < this.fftSize && !any; i++) any = learnMask[i] === 1
		if (!any) return
		const fb = this.blockFloor(powerDb, learnMask)
		let baseline = this.baselines.get(absKey)
		if (baseline === undefined) {
			baseline = new Float32Array(this.fftSize).fill(Number.NaN)
			this.baselines.set(absKey, baseline)
		}
		const up = 1 / this.tauBlocks
		const down = Math.min(1, BASELINE_FALL_SPEEDUP / this.tauBlocks)
		for (let i = 0; i < this.fftSize; i++) {
			if (learnMask[i] !== 1) continue
			const p = powerDb[i]!
			const b = baseline[i]!
			const next = Number.isNaN(b) ? p : b + (p - b) * (p < b ? down : up)
			baseline[i] = Math.min(
				fb + BASELINE_CLAMP_DB,
				Math.max(fb - BASELINE_CLAMP_DB, next),
			)
		}
		if (quiet) {
			const a = this.absolute.get(absKey)
			this.absolute.set(
				absKey,
				a === undefined || fb < a ? fb : a + (fb - a) * up,
			)
		}
	}

	/** max(F_b, A − 1 dB), or F_b while A is unknown. */
	effectiveFloor(blockFloorDb: number, absKey: string): number {
		const a = this.absolute.get(absKey)
		return a === undefined
			? blockFloorDb
			: Math.max(blockFloorDb, a - ABSOLUTE_FLOOR_MARGIN_DB)
	}

	/** out[i] = max(F, clamp(B_i, F − 6, F + 6)) for the active key; F where B_i is unknown. */
	perBinFloor(out: Float32Array, blockFloorDb: number): void {
		const baseline =
			this.activeKey === null ? undefined : this.baselines.get(this.activeKey)
		const hi = blockFloorDb + BASELINE_CLAMP_DB
		for (let i = 0; i < this.fftSize; i++) {
			const b = baseline === undefined ? Number.NaN : baseline[i]!
			out[i] = Number.isNaN(b)
				? blockFloorDb
				: Math.max(blockFloorDb, Math.min(hi, b))
		}
	}

	absoluteFloor(absKey: string): number | null {
		return this.absolute.get(absKey) ?? null
	}

	/** The block's floor sits more than k above the absolute floor: the window's median is an emission. */
	occupied(blockFloorDb: number, k: number, absKey: string): boolean {
		const a = this.absolute.get(absKey)
		return a !== undefined && blockFloorDb > a + k
	}

	exportState(): Pick<EngineState, "absoluteFloors"> {
		return {
			absoluteFloors: [...this.absolute].map(([key, dbfs]) => ({ key, dbfs })),
		}
	}

	importState(s: Pick<EngineState, "absoluteFloors">): void {
		for (const { key, dbfs } of s.absoluteFloors)
			if (Number.isFinite(dbfs)) this.absolute.set(key, dbfs)
	}
}
