import type { EngineState } from "./types.js"

/**
 * Fast spur path (spec § 4.9). SpurMap's baseband/RF classification (§ 4.4) needs 10 minutes and
 * three centres; until then the Pi's comb about ±0.9 MHz from centre would surface as discoveries.
 * Here a narrow line that is on in ≥ 95 % of settled blocks over 30 s becomes a provisional spur:
 * the pipeline drops its segments before tracking, it is never reported, and it is demoted as soon
 * as it falls below 95 %. ≥ 3 lines equally spaced within ± 1 bin form a comb, returned for
 * SpurMap.promote (baseband spurs at once) and kept here as sticky comb lines.
 *
 * Per key `${fs}:${gainKey}:${fftSize}`, in FFT-shifted baseband bins. Per bin, `winMs` is the
 * length of the current ≥ 95 % run (capped at the window) and `offMs` the core-off time inside it,
 * decayed once the window is full (an exponential stand-in for a sliding window); a bin whose off
 * time exceeds 5 % of the window starts over. A bin is on for a line only at the line's core: on,
 * and within LINE_CORE_DB of the strongest bin within ±2, so Hann skirts are not width. A line is
 * a run of ≤ 3 qualifying bins whose neighbours 2 bins out are on less than half the time.
 *
 * Callers pass only settled, gap-free, non-overload blocks with at most half their frames blanked.
 */
export const PROVISIONAL_WINDOW_MS = 30_000
export const PROVISIONAL_ON_FRACTION = 0.95
export const PROVISIONAL_MAX_WIDTH_BINS = 3
export const LINE_CORE_DB = 6
export const ISOLATION_MAX_ON = 0.5
export const COMB_MIN_LINES = 3
export const COMB_TOLERANCE_BINS = 1
export const COMB_MIN_SPACING_BINS = 4
const CORE_REACH_BINS = 2
const ISOLATION_GAP_BINS = 2
const ISOLATION_TAU_MS = 5000
const MAX_LINES = 64

/** Half-open baseband bin range [startBin, endBin). */
export interface BinRange {
	startBin: number
	endBin: number
}
/** A line's core bins; `comb` lines are sticky and promoted to SpurMap. */
export interface ProvisionalLine extends BinRange {
	comb: boolean
}
type Entry = NonNullable<EngineState["provisionalSpurs"]>[number]

interface KeyState {
	winMs: Float64Array
	offMs: Float64Array
	onAvg: Float32Array
	provisional: ProvisionalLine[]
	comb: ProvisionalLine[]
}

export class ProvisionalSpurs {
	private readonly n: number
	private readonly windowMs: number
	private readonly offBudgetMs: number
	private readonly keys = new Map<string, KeyState>()
	private readonly foreign: Entry[] = []

	constructor(opts: { fftSize: number; windowMs?: number }) {
		this.n = opts.fftSize
		this.windowMs = opts.windowMs ?? PROVISIONAL_WINDOW_MS
		this.offBudgetMs = (1 - PROVISIONAL_ON_FRACTION) * this.windowMs
	}

	/**
	 * One block. `on` is the detector output (provisional lines are not detector-masked), `powerDb`
	 * the block PSD, `usable` 1 where the detector may turn bins on. Returns the comb lines promoted
	 * in this block, widened by the ±1-bin Hann skirt, for SpurMap.promote.
	 */
	observe(
		key: string,
		on: Uint8Array,
		powerDb: Float32Array,
		usable: Uint8Array,
		blockMs: number,
	): BinRange[] {
		const s = this.state(key)
		const n = this.n
		const decay = Math.min(1, blockMs / this.windowMs)
		const iso = Math.min(1, blockMs / ISOLATION_TAU_MS)
		for (let i = 0; i < n; i++) {
			if (usable[i] !== 1) {
				s.winMs[i] = 0
				s.offMs[i] = 0
				s.onAvg[i] = 0
				continue
			}
			const isOn = on[i] === 1
			s.onAvg[i] =
				(s.onAvg[i] ?? 0) + ((isOn ? 1 : 0) - (s.onAvg[i] ?? 0)) * iso
			let peak = Number.NEGATIVE_INFINITY
			for (
				let j = Math.max(0, i - CORE_REACH_BINS);
				j <= Math.min(n - 1, i + CORE_REACH_BINS);
				j++
			) {
				peak = Math.max(peak, powerDb[j] ?? Number.NEGATIVE_INFINITY)
			}
			const core =
				isOn && (powerDb[i] ?? Number.NEGATIVE_INFINITY) >= peak - LINE_CORE_DB
			if ((s.winMs[i] ?? 0) >= this.windowMs)
				s.offMs[i] = (s.offMs[i] ?? 0) * (1 - decay)
			s.winMs[i] = Math.min(this.windowMs, (s.winMs[i] ?? 0) + blockMs)
			if (!core) s.offMs[i] = (s.offMs[i] ?? 0) + blockMs
			if ((s.offMs[i] ?? 0) > this.offBudgetMs) {
				s.winMs[i] = 0
				s.offMs[i] = 0
			}
		}
		const next = this.findLines(s)
		if (sameLines(next, s.provisional)) return []
		s.provisional = next
		return this.promoteCombs(s)
	}

	/** Comb and provisional lines of `key` (core bins), ascending. */
	lines(key: string): ProvisionalLine[] {
		const s = this.keys.get(key)
		if (s === undefined) return []
		return [...s.comb, ...s.provisional]
			.map(l => ({ ...l }))
			.sort((a, b) => a.startBin - b.startBin)
	}

	/** Sets out[i] = 1 on the core bins of every line of `key` (other bins untouched). */
	mask(key: string, out: Uint8Array): void {
		const s = this.keys.get(key)
		if (s === undefined) return
		for (const l of [...s.comb, ...s.provisional])
			out.fill(1, l.startBin, l.endBin)
	}

	exportState(): { provisionalSpurs: Entry[] } {
		const out: Entry[] = [...this.foreign]
		for (const [key, s] of this.keys) {
			for (const l of [...s.comb, ...s.provisional]) {
				out.push({
					key,
					basebandBin: l.startBin,
					widthBins: l.endBin - l.startBin,
					comb: l.comb,
				})
			}
		}
		return { provisionalSpurs: out }
	}

	/** Comb lines come back sticky, provisional lines already qualifying: a restart starts masked. */
	importState(st: Pick<EngineState, "provisionalSpurs">): void {
		for (const e of st.provisionalSpurs ?? []) {
			if (Number(e.key.split(":").at(-1)) !== this.n) {
				this.foreign.push(e)
				continue
			}
			const start = e.basebandBin
			const end = e.basebandBin + e.widthBins
			if (start < 0 || end > this.n || end <= start) continue
			const s = this.state(e.key)
			const line: ProvisionalLine = {
				startBin: start,
				endBin: end,
				comb: e.comb,
			}
			if (e.comb) {
				if (s.comb.length < MAX_LINES) s.comb.push(line)
			} else if (s.provisional.length < MAX_LINES) {
				s.provisional.push(line)
				s.winMs.fill(this.windowMs, start, end)
			}
		}
	}

	private findLines(s: KeyState): ProvisionalLine[] {
		const n = this.n
		const out: ProvisionalLine[] = []
		for (let i = 0; i < n && out.length < MAX_LINES; ) {
			if ((s.winMs[i] ?? 0) < this.windowMs) {
				i++
				continue
			}
			let j = i
			while (j < n && (s.winMs[j] ?? 0) >= this.windowMs) j++
			const narrow = j - i <= PROVISIONAL_MAX_WIDTH_BINS
			if (
				narrow &&
				this.isolated(s, i, j) &&
				!s.comb.some(c => c.startBin < j && c.endBin > i)
			) {
				out.push({ startBin: i, endBin: j, comb: false })
			}
			i = j
		}
		return out
	}

	private isolated(s: KeyState, start: number, end: number): boolean {
		const left = start - ISOLATION_GAP_BINS
		const right = end - 1 + ISOLATION_GAP_BINS
		const quiet = (i: number): boolean =>
			i < 0 || i >= this.n || (s.onAvg[i] ?? 0) < ISOLATION_MAX_ON
		return quiet(left) && quiet(right)
	}

	private promoteCombs(s: KeyState): BinRange[] {
		const all = [...s.comb, ...s.provisional].sort(
			(a, b) => a.startBin - b.startBin,
		)
		const members = combMembers(all.map(l => (l.startBin + l.endBin - 1) / 2))
		const promoted: BinRange[] = []
		for (const idx of members) {
			const line = all[idx]
			if (line === undefined || line.comb) continue
			if (s.comb.length >= MAX_LINES) break
			line.comb = true // the same object as in s.provisional
			s.comb.push(line)
			promoted.push({
				startBin: Math.max(0, line.startBin - 1),
				endBin: Math.min(this.n, line.endBin + 1),
			})
		}
		if (promoted.length > 0) s.provisional = s.provisional.filter(l => !l.comb)
		return promoted
	}

	private state(key: string): KeyState {
		let s = this.keys.get(key)
		if (s === undefined) {
			s = {
				winMs: new Float64Array(this.n),
				offMs: new Float64Array(this.n),
				onAvg: new Float32Array(this.n),
				provisional: [],
				comb: [],
			}
			this.keys.set(key, s)
		}
		return s
	}
}

/**
 * Indices of the ascending `centres` that belong to a run of ≥ COMB_MIN_LINES equally spaced
 * lines: each next member within ± COMB_TOLERANCE_BINS of first + step × spacing (the spacing is
 * re-estimated from the last member), spacing ≥ COMB_MIN_SPACING_BINS. Teeth may be missing.
 */
export function combMembers(centres: readonly number[]): Set<number> {
	const out = new Set<number>()
	for (let i = 0; i < centres.length; i++) {
		const first = centres[i] ?? 0
		for (let j = i + 1; j < centres.length; j++) {
			let spacing = (centres[j] ?? 0) - first
			if (spacing < COMB_MIN_SPACING_BINS) continue
			const chain = [i, j]
			let step = 2
			for (let k = j + 1; k < centres.length; k++) {
				const c = centres[k] ?? 0
				const expected = first + step * spacing
				if (c > expected + COMB_TOLERANCE_BINS) break
				if (c < expected - COMB_TOLERANCE_BINS) continue
				chain.push(k)
				spacing = (c - first) / step
				step++
			}
			if (chain.length >= COMB_MIN_LINES) for (const m of chain) out.add(m)
		}
	}
	return out
}

function sameLines(a: readonly BinRange[], b: readonly BinRange[]): boolean {
	return (
		a.length === b.length &&
		a.every(
			(l, i) => l.startBin === b[i]?.startBin && l.endBin === b[i]?.endBin,
		)
	)
}
