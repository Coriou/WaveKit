/**
 * Per-bin activity detector with masks, hysteresis and per-range adaptive
 * CFAR (spec § 4.5).
 *
 * - A bin turns on when P_i > floor_i + k and off when P_i < floor_i + k − h.
 * - Masks (setMasks): DC ± dcGuardBins, bins outside the usable span
 *   (i < edgeBins or i > N − edgeBins, symmetric about DC), and `extra`
 *   (exclusions, baseband spurs). Masked bins are always off.
 * - k defaults from the measured table (feasibility § 3a): the nearest RBW row
 *   (in log frequency), linear in T between 20, 50 and 100 ms, clamped outside.
 * - Adaptive CFAR per range key: noise edges are rising edges ≤ 2 bins wide
 *   that never join a track lasting ≥ 2 blocks (checked in the edge's block
 *   and the next), counted per MHz of unmasked span per minute of settled
 *   time. Burst ranges are not counted. Over each 5 minutes, a rate above the
 *   target raises k by 0.5 dB (cap table + 4 dB); over each 30 minutes, a rate
 *   below target/4 lowers it by 0.5 dB (never below the table). A pinned k
 *   disables both the table and the adaptation.
 *
 * Bins are FFT-shifted (spectrum/fft.ts); ranges are half-open bin intervals.
 */
export const K_TABLE_T_MS = [20, 50, 100] as const
export const K_TABLE: readonly {
	rbwHz: number
	kDb: readonly [number, number, number]
}[] = [
	{ rbwHz: 1000, kDb: [5.5, 4.0, 3.5] },
	{ rbwHz: 500, kDb: [7.0, 5.0, 4.0] },
	{ rbwHz: 250, kDb: [9.0, 7.5, 5.5] },
]
export const CFAR_STEP_DB = 0.5
export const CFAR_MAX_RAISE_DB = 4
export const CFAR_RAISE_WINDOW_MIN = 5
export const CFAR_LOWER_WINDOW_MIN = 30
export const MAX_NOISE_EDGE_BINS = 2
/** Relative slack so float-accumulated exposure does not flip a rate exactly at the target. */
const RATE_TOLERANCE = 1e-9

export function defaultK(rbwHz: number, integrationMs: number): number {
	let row = K_TABLE[0]!
	for (const r of K_TABLE)
		if (
			Math.abs(Math.log2(rbwHz / r.rbwHz)) <
			Math.abs(Math.log2(rbwHz / row.rbwHz))
		)
			row = r
	const t = K_TABLE_T_MS
	if (integrationMs <= t[0]) return row.kDb[0]
	if (integrationMs >= t[2]) return row.kDb[2]
	const seg = integrationMs <= t[1] ? 0 : 1
	const frac = (integrationMs - t[seg]) / (t[seg + 1]! - t[seg])
	return row.kDb[seg]! + frac * (row.kDb[seg + 1]! - row.kDb[seg]!)
}

/** k for the 5 ms short-burst path (feasibility § 3a, T = 5 ms column; 250 Hz measured "> 14", unvalidated). */
export const SHORT_K_TABLE: readonly { rbwHz: number; kDb: number }[] = [
	{ rbwHz: 1000, kDb: 8.5 },
	{ rbwHz: 500, kDb: 11.5 },
	{ rbwHz: 250, kDb: 15 },
]

/** Nearest-RBW row (in octaves) of SHORT_K_TABLE. */
export function shortK(rbwHz: number): number {
	let row = SHORT_K_TABLE[0]!
	for (const r of SHORT_K_TABLE) {
		if (
			Math.abs(Math.log2(rbwHz / r.rbwHz)) <
			Math.abs(Math.log2(rbwHz / row.rbwHz))
		)
			row = r
	}
	return row.kDb
}

/** Bins masked on each side of DC: ceil(max(dcGuardHz, 2·RBW) / binHz) (§ 4.5). */
export function dcGuardBins(
	dcGuardHz: number,
	rbwHz: number,
	binHz: number,
): number {
	return Math.ceil(Math.max(dcGuardHz, 2 * rbwHz) / binHz)
}

/** Bins masked at each end so that only |offset| ≤ u·fs/2 stays usable. */
export function usableEdgeBins(
	fftSize: number,
	usableFraction: number,
): number {
	return Math.ceil(Math.round((fftSize / 2) * (1 - usableFraction) * 1e9) / 1e9)
}

export interface CfarRange {
	startBin: number
	/** Exclusive. */
	endBin: number
	key: string
	burst: boolean
}

interface RangeState {
	k: number
	edges5: number
	exposure5: number
	minutes5: number
	edges30: number
	exposure30: number
	minutes30: number
	rate: number
}

interface PendingEdge {
	from: number
	to: number
	key: string
}

export class Detector {
	private readonly fftSize: number
	private readonly hysteresisDb: number
	private readonly faTarget: number
	private readonly pinnedK: number | null
	private readonly tableK: number
	private readonly mask: Uint8Array
	private readonly state: Uint8Array
	private readonly prevOn: Uint8Array
	private readonly binRange: Int32Array
	private readonly kBin: Float32Array
	private ranges: CfarRange[] = []
	private readonly perKey = new Map<string, RangeState>()
	private pending: PendingEdge[] = []

	constructor(opts: {
		fftSize: number
		hysteresisDb: number
		faTargetPerMhzMin: number
		pinnedK: number | null
		rbwHz: number
		integrationMs: number
	}) {
		this.fftSize = opts.fftSize
		this.hysteresisDb = opts.hysteresisDb
		this.faTarget = opts.faTargetPerMhzMin
		this.pinnedK = opts.pinnedK
		this.tableK = defaultK(opts.rbwHz, opts.integrationMs)
		this.mask = new Uint8Array(opts.fftSize).fill(1)
		this.state = new Uint8Array(opts.fftSize)
		this.prevOn = new Uint8Array(opts.fftSize)
		this.binRange = new Int32Array(opts.fftSize).fill(-1)
		this.kBin = new Float32Array(opts.fftSize).fill(opts.pinnedK ?? this.tableK)
	}

	setMasks(m: {
		dcGuardBins: number
		edgeBins: number
		extra: Uint8Array | null
	}): void {
		const n = this.fftSize
		const dc = n / 2
		for (let i = 0; i < n; i++) {
			const masked =
				i < m.edgeBins ||
				i > n - m.edgeBins ||
				Math.abs(i - dc) <= m.dcGuardBins ||
				m.extra?.[i] === 1
			this.mask[i] = masked ? 0 : 1
		}
	}

	/** Current mask, 1 = usable. A live view; read-only by convention. */
	unmasked(): Uint8Array {
		return this.mask
	}

	setCfarRanges(ranges: CfarRange[]): void {
		this.ranges = ranges.map(r => ({ ...r }))
		this.binRange.fill(-1)
		this.ranges.forEach((r, idx) => {
			for (
				let i = Math.max(0, r.startBin);
				i < Math.min(this.fftSize, r.endBin);
				i++
			)
				this.binRange[i] = idx
			this.rangeState(r.key)
		})
		this.pending = []
		this.refreshK()
	}

	/** Hysteresis per bin against floorDb + k; masked bins off. */
	detect(powerDb: Float32Array, floorDb: Float32Array, out: Uint8Array): void {
		const h = this.hysteresisDb
		for (let i = 0; i < this.fftSize; i++) {
			if (this.mask[i] !== 1) {
				this.state[i] = 0
				out[i] = 0
				continue
			}
			const t = floorDb[i]! + this.kBin[i]!
			const p = powerDb[i]!
			const on = this.state[i] === 1 ? p >= t - h : p > t
			this.state[i] = on ? 1 : 0
			out[i] = this.state[i]!
		}
	}

	/**
	 * Accounts one settled, gap-free, non-overload block: `on` is this block's
	 * detector output, `joinedTrack` marks bins of tracks that have lasted ≥ 2
	 * blocks, `minutes` the block's settled time and `mhz` the window's total
	 * unmasked span (shared among ranges by unmasked bins).
	 */
	recordNoiseEdges(
		on: Uint8Array,
		joinedTrack: Uint8Array,
		minutes: number,
		mhz: number,
	): void {
		const n = this.fftSize
		const near = (from: number, to: number): boolean => {
			for (let i = Math.max(0, from - 1); i <= Math.min(n - 1, to + 1); i++)
				if (joinedTrack[i] === 1) return true
			return false
		}
		for (const e of this.pending) {
			if (!near(e.from, e.to)) {
				const s = this.rangeState(e.key)
				s.edges5++
				s.edges30++
			}
		}
		this.pending = []
		for (let i = 0; i < n; ) {
			if (on[i] !== 1) {
				i++
				continue
			}
			let j = i
			let rising = true
			while (j < n && on[j] === 1) {
				if (this.prevOn[j] === 1) rising = false
				j++
			}
			const idx = this.binRange[i]!
			const range = idx >= 0 ? this.ranges[idx] : undefined
			if (
				rising &&
				j - i <= MAX_NOISE_EDGE_BINS &&
				range !== undefined &&
				!range.burst &&
				!near(i, j - 1)
			) {
				this.pending.push({ from: i, to: j - 1, key: range.key })
			}
			i = j
		}
		this.prevOn.set(on.subarray(0, n))
		let totalUnmasked = 0
		for (let i = 0; i < n; i++) totalUnmasked += this.mask[i]!
		if (totalUnmasked === 0) return
		let changed = false
		for (const r of this.ranges) {
			if (r.burst) continue
			let bins = 0
			for (let i = Math.max(0, r.startBin); i < Math.min(n, r.endBin); i++)
				bins += this.mask[i]!
			if (bins === 0) continue
			const s = this.rangeState(r.key)
			const exposure = ((mhz * bins) / totalUnmasked) * minutes
			s.exposure5 += exposure
			s.exposure30 += exposure
			s.minutes5 += minutes
			s.minutes30 += minutes
			changed = this.adapt(s) || changed
		}
		if (changed) this.refreshK()
	}

	kFor(bin: number): number {
		return this.kBin[bin] ?? this.pinnedK ?? this.tableK
	}

	stats(): { key: string; k: number; faPerMhzMin: number }[] {
		return [...this.perKey].map(([key, s]) => ({
			key,
			k: this.pinnedK ?? s.k,
			faPerMhzMin: s.rate,
		}))
	}

	/** Restores persisted k values, clamped to [table, table + 4 dB]. */
	importK(entries: { key: string; k: number }[]): void {
		for (const e of entries) {
			if (!Number.isFinite(e.k)) continue
			this.rangeState(e.key).k = Math.min(
				this.tableK + CFAR_MAX_RAISE_DB,
				Math.max(this.tableK, e.k),
			)
		}
		this.refreshK()
	}

	/** Clears hysteresis and pending edges (new epoch). */
	reset(): void {
		this.state.fill(0)
		this.prevOn.fill(0)
		this.pending = []
	}

	private rangeState(key: string): RangeState {
		let s = this.perKey.get(key)
		if (s === undefined) {
			s = {
				k: this.tableK,
				edges5: 0,
				exposure5: 0,
				minutes5: 0,
				edges30: 0,
				exposure30: 0,
				minutes30: 0,
				rate: 0,
			}
			this.perKey.set(key, s)
		}
		return s
	}

	private adapt(s: RangeState): boolean {
		let changed = false
		if (s.minutes5 >= CFAR_RAISE_WINDOW_MIN) {
			s.rate = s.exposure5 > 0 ? s.edges5 / s.exposure5 : 0
			const noisy = s.rate > this.faTarget * (1 + RATE_TOLERANCE)
			if (noisy && s.k < this.tableK + CFAR_MAX_RAISE_DB) {
				s.k = Math.min(this.tableK + CFAR_MAX_RAISE_DB, s.k + CFAR_STEP_DB)
				changed = true
			}
			if (noisy) {
				s.edges30 = 0
				s.exposure30 = 0
				s.minutes30 = 0
			}
			s.edges5 = 0
			s.exposure5 = 0
			s.minutes5 = 0
		}
		if (s.minutes30 >= CFAR_LOWER_WINDOW_MIN) {
			const rate30 = s.exposure30 > 0 ? s.edges30 / s.exposure30 : 0
			if (rate30 < this.faTarget / 4 && s.k > this.tableK) {
				s.k = Math.max(this.tableK, s.k - CFAR_STEP_DB)
				changed = true
			}
			s.edges30 = 0
			s.exposure30 = 0
			s.minutes30 = 0
		}
		return changed
	}

	private refreshK(): void {
		for (let i = 0; i < this.fftSize; i++) {
			const idx = this.binRange[i]!
			const range = idx >= 0 ? this.ranges[idx] : undefined
			this.kBin[i] =
				this.pinnedK ??
				(range === undefined ? this.tableK : this.rangeState(range.key).k)
		}
	}
}
