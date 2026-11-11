/**
 * Retune-delay measurement (diagnostics for the tuning ledger's settle): per flushed frequency
 * or sample-rate frame that changes the value, the payload distance from the frame's flush
 * position to the first block summary whose content reflects the new tuning. Nothing reads it
 * but status; it changes no settle or time budget.
 *
 * "Reflects" is judged on the block summaries the engine already makes (max-hold dBFS bins), only
 * while a measurement is pending: one mean absolute difference per comparison, O(bins) per block.
 * - Frequency change Δ with an overlap of at least MIN_OVERLAP_BINS bins: on the bins that stand
 *   SIGNAL_DB above the reference's median (carriers), the block matches the reference block (the
 *   last one wholly before the flush) shifted by Δ / binHz better, by SHIFT_MARGIN_DB, than
 *   unshifted (a signal at a fixed RF moves by −Δ in baseband).
 * - Otherwise (a jump past the span, or a rate change on the same bin grid): the block differs
 *   from the reference by CHANGE_DB on average.
 * A block from another session, a reference on another bin grid, a newer receipt first, or no
 * detection within RETUNE_DETECT_MAX_MS of payload counts as `undetected`: a quiet band (noise
 * only) is undetected, never a short delay. A sample-rate change nearly always changes the
 * summary's bin grid (bin width follows the rate), so rate changes mostly count as `undetected`:
 * the measurement is in practice one of centre moves.
 *
 * Scanner marker brackets (test mode on, the hop's frames, test mode off) are skipped: a centre
 * or rate receipt while test mode is on starts no measurement, opening a bracket drops a pending
 * one uncounted (the test pattern would read as the change), and a block that may carry the
 * pattern (from the bracket's start to RETUNE_DETECT_MAX_MS of payload past its end) is never a
 * reference nor a detection: a change whose reference would be one counts as `undetected`.
 *
 * Positions are the shadow's lower bounds of a block's first byte, so the delay is a lower bound
 * too (at most the mapping's slack: bytes buffered between the source manager and the engine).
 */

/**
 * Measurements kept for p50 and max. A frequency or rate change is at most one per scanner hop
 * (hops no faster than the local settle, 300 ms): 64 × 0.3 s ≈ 19 s of hopping, or the whole of
 * a live acceptance's few operator retunes; older ones stay in `count`.
 */
export const RETUNE_DELAY_SAMPLES = 64
/**
 * Payload time after the flush within which the change must show, else `undetected`: 5× the
 * 1000 ms network settle default, so a settle five times too short is still measured.
 */
export const RETUNE_DETECT_MAX_MS = 5_000
/** A shifted match must beat the unshifted one by this (the summary grid is 0.5 dB). */
export const SHIFT_MARGIN_DB = 3
/** Mean bin change that counts as new content without a usable shift (noise varies ~1-2 dB). */
export const CHANGE_DB = 6
/** Fewest overlapping bins a shifted comparison needs (below: the generic change rule). */
export const MIN_OVERLAP_BINS = 16
/** A bin this far above the reference's median is a signal the shift comparison follows. */
export const SIGNAL_DB = 10

export interface RetuneDelayStatus {
	/** Measurements made since the engine started. */
	count: number
	/** Over the last RETUNE_DELAY_SAMPLES measurements; null without one. */
	p50Ms: number | null
	maxMs: number | null
	p50Bytes: number | null
	maxBytes: number | null
	/** Changes whose effect was not seen (see the module comment). */
	undetected: number
}

export interface DelayReceipt {
	session: number
	field: "frequency" | "sampleRate"
	value: number
	pos: number
}

/** A flushed test-mode frame (rtl_tcp 0x07): `on` for any value but 0. */
export interface DelayTestMode {
	session: number
	on: boolean
	pos: number
}

export interface DelayBlock {
	session: number
	/** Lower bound of the block's first byte; upper bound of its end (ledger positions). */
	posA: number
	posB: number
	bins: readonly number[]
	binHz: number
}

interface Pending {
	session: number
	field: "frequency" | "sampleRate"
	deltaHz: number
	pos: number
	bytesPerSecond: number
	ref: DelayBlock | null
	/** median(ref.bins) + SIGNAL_DB, computed once per reference (null: not yet). */
	floor: number | null
}

/** Payload span that may carry a test pattern: `[from, until)` of `session`. */
interface Taint {
	session: number
	from: number
	until: number
}

/** Mean |a[k] − b[k + shift]| over the overlap, on bins where either side reaches `floor`. */
function meanAbs(
	a: readonly number[],
	b: readonly number[],
	shift: number,
	floor = Number.NEGATIVE_INFINITY,
): { mean: number; n: number; overlap: number } {
	let sum = 0
	let n = 0
	const from = Math.max(0, -shift)
	const to = Math.min(a.length, b.length - shift)
	for (let k = from; k < to; k++) {
		const x = a[k]!
		const y = b[k + shift]!
		if (!Number.isFinite(x) || !Number.isFinite(y)) continue
		if (x < floor && y < floor) continue
		sum += Math.abs(x - y)
		n += 1
	}
	return { mean: n > 0 ? sum / n : 0, n, overlap: Math.max(0, to - from) }
}

function median(xs: readonly number[]): number {
	const s = xs.filter(Number.isFinite).sort((a, b) => a - b)
	return s.length === 0 ? Number.NaN : s[s.length >> 1]!
}

function percentile(sorted: readonly number[], p: number): number | null {
	if (sorted.length === 0) return null
	return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!
}

export class RetuneDelayMeter {
	private pending: Pending | null = null
	private last: DelayBlock | null = null
	/** The last receipted value per field in `lastSession` (the change's "before"). */
	private lastSession: number | null = null
	private readonly lastValue = new Map<"frequency" | "sampleRate", number>()
	private readonly samples: { ms: number; bytes: number }[] = []
	private count = 0
	private undetected = 0
	/** An open marker bracket (test mode on), or null. */
	private bracket: { session: number; from: number } | null = null
	/** The span of the last closed bracket whose blocks may still carry the pattern. */
	private taint: Taint | null = null

	/**
	 * A flushed test-mode frame. `bytesPerSecond` converts RETUNE_DETECT_MAX_MS to payload past
	 * the bracket's end (null: the taint lasts the session).
	 */
	onTestMode(frame: DelayTestMode, bytesPerSecond: number | null): void {
		this.enterSession(frame.session)
		if (frame.on) {
			if (this.bracket) return
			this.bracket = { session: frame.session, from: frame.pos }
			// The pattern would read as the change: dropped, not counted.
			this.pending = null
			this.last = null
			return
		}
		const from = this.bracket?.from ?? frame.pos
		this.bracket = null
		const span =
			bytesPerSecond !== null &&
			Number.isFinite(bytesPerSecond) &&
			bytesPerSecond > 0
				? (RETUNE_DETECT_MAX_MS / 1000) * bytesPerSecond
				: Number.POSITIVE_INFINITY
		this.taint = { session: frame.session, from, until: frame.pos + span }
	}

	/**
	 * A flushed frame. `before`: the value in effect before it when this session has no earlier
	 * receipt of the field (the engine's current centre or rate), else ignored. `bytesPerSecond`:
	 * the payload rate to convert bytes to ms (null: not measurable).
	 */
	onReceipt(
		receipt: DelayReceipt,
		before: number | null,
		bytesPerSecond: number | null,
	): void {
		this.enterSession(receipt.session)
		const prev = this.lastValue.get(receipt.field) ?? before
		this.lastValue.set(receipt.field, receipt.value)
		if (prev === null || prev === receipt.value) return
		// Inside a marker bracket: the hop's frames are skipped (see the module comment).
		if (this.bracket) return
		if (this.pending) this.undetected += 1
		this.pending = null
		if (
			bytesPerSecond === null ||
			!Number.isFinite(bytesPerSecond) ||
			bytesPerSecond <= 0
		) {
			this.undetected += 1
			return
		}
		const last = this.last
		this.pending = {
			session: receipt.session,
			field: receipt.field,
			deltaHz: receipt.value - prev,
			pos: receipt.pos,
			bytesPerSecond,
			ref:
				last && last.session === receipt.session && last.posB <= receipt.pos
					? last
					: null,
			floor: null,
		}
	}

	/** A block summary with its ledger bounds. */
	onBlock(block: DelayBlock): void {
		const p = this.pending
		if (this.tainted(block)) {
			// May carry the test pattern: neither a reference nor a detection.
			this.last = null
			if (!p) return
			if (block.session !== p.session) return this.miss()
			if (block.posB <= p.pos) {
				p.ref = null
				p.floor = null
				return
			}
			return this.miss()
		}
		this.last = block
		if (!p) return
		if (block.session !== p.session) return this.miss()
		if (block.posB <= p.pos) {
			// Wholly before the flush: the newest such block is the reference.
			p.ref = block
			p.floor = null
			return
		}
		const ref = p.ref
		if (
			!ref ||
			ref.binHz !== block.binHz ||
			ref.bins.length !== block.bins.length
		)
			return this.miss()
		if (this.reflects(p, ref, block)) {
			const bytes = Math.max(0, block.posA - p.pos)
			const ms = (bytes * 1000) / p.bytesPerSecond
			this.samples.push({ ms, bytes })
			if (this.samples.length > RETUNE_DELAY_SAMPLES) this.samples.shift()
			this.count += 1
			this.pending = null
			return
		}
		if (block.posA - p.pos > (RETUNE_DETECT_MAX_MS / 1000) * p.bytesPerSecond)
			this.miss()
	}

	status(): RetuneDelayStatus {
		const ms = this.samples.map(s => s.ms).sort((a, b) => a - b)
		const bytes = this.samples.map(s => s.bytes).sort((a, b) => a - b)
		return {
			count: this.count,
			p50Ms: percentile(ms, 0.5),
			maxMs: ms.at(-1) ?? null,
			p50Bytes: percentile(bytes, 0.5),
			maxBytes: bytes.at(-1) ?? null,
			undetected: this.undetected,
		}
	}

	/** A new session forgets the last values, any bracket and its taint. */
	private enterSession(session: number): void {
		if (this.lastSession === session) return
		this.lastSession = session
		this.lastValue.clear()
		this.bracket = null
		this.taint = null
	}

	private tainted(block: DelayBlock): boolean {
		const b = this.bracket
		if (b && b.session === block.session && block.posB > b.from) return true
		const t = this.taint
		return (
			t !== null &&
			t.session === block.session &&
			block.posA < t.until &&
			block.posB > t.from
		)
	}

	private miss(): void {
		this.undetected += 1
		this.pending = null
	}

	private reflects(p: Pending, ref: DelayBlock, block: DelayBlock): boolean {
		const same = meanAbs(block.bins, ref.bins, 0)
		if (same.n === 0) return false
		if (p.field === "frequency" && block.binHz > 0) {
			const shift = Math.round(p.deltaHz / block.binHz)
			// Once per reference, not per block (a sort of the bins).
			p.floor ??= median(ref.bins) + SIGNAL_DB
			const floor = p.floor
			const moved = meanAbs(block.bins, ref.bins, shift, floor)
			if (moved.overlap >= MIN_OVERLAP_BINS) {
				const still = meanAbs(block.bins, ref.bins, 0, floor)
				// No signal on either side: nothing to follow (a quiet band stays undetected).
				if (moved.n === 0 || still.n === 0) return false
				return moved.mean + SHIFT_MARGIN_DB <= still.mean
			}
		}
		return same.mean >= CHANGE_DB
	}
}
