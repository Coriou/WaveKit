/**
 * Spur learning (spec § 4.4). Keyed by `${fs}:${gainKey}:${fftSize}` in
 * baseband bin offsets, so it survives retunes and accumulates across every
 * hop of a sweep. A candidate is a bin range ≤ maxWidthBins wide that is on
 * for ≥ onFraction of ≥ minObservedMs of settled observation. It is classified
 * by whether it moves with the centre:
 *
 * - on at the same baseband bins in epochs with ≥ 3 different centres →
 *   baseband spur candidate (sticky until it expires), never reported as an RF discovery;
 * - on at the same RF frequency in epochs with ≥ 2 different centres →
 *   RF-fixed carrier (rfCarriers()): reported once as a `carrier`, excluded
 *   from probe allocation, not from detection.
 *
 * A candidate (learned here, promoted by the comb fast path, or restored from disk) masks only
 * while it is verified (`mask`, `masks`):
 *
 * - Level. A bin counts as a line only while its slot level, Σ power / Σ floor over a 12.5 kHz
 *   slot centred on it (the channel gate's measure), is under SPUR_MAX_LEVEL_DB: the gate's own
 *   pass level, k 3 dB + margin 3 dB = 6 dB. Real receiver lines measured at most +3.5 dB, 2.5 dB
 *   under it; a carrier or a voice the gate would pass is no receiver line and is never learned.
 *   A neighbour on air within half a slot makes a line's bins loud too: the line is then neither
 *   credited nor missed, so it verifies later, never wrongly.
 * - Lift. A verified mask lifts while the line's own footprint is loud, never for a neighbour:
 *   its own level (ownQuiet) is the slot level the footprint alone gives, every other bin of a
 *   12.5 kHz slot centred on it at its floor, 1 + Σ_footprint (power − floor) / Σ_slot floor,
 *   against the same 6 dB. At 1 kHz bins (13-bin slot) that is a footprint excess of
 *   (10^0.6 − 1) · 13 ≈ 38.8 bins of floor power: a 1-bin emission of 16 dB over its floor. With
 *   the neighbours at their floor it equals the slot level, so a line that verified stays masked
 *   at its own level. The footprint of a SpurMap mask is its run of verified candidate bins,
 *   which already holds the line's ±1-bin Hann skirt (a promoted range is widened by ±1, a
 *   learned run is every bin the detector saw on); a provisional or comb line (`masks`) is given
 *   as its core bins and measured with ±1 bin of skirt.
 * - Confined. A loud footprint lifts the mask only while that energy is confined to it, a narrow
 *   carrier sitting on the line (`wider`): when a flank as wide as the footprint just outside it,
 *   on either side, carries a mean excess per bin of at least the footprint's own less 6 dB
 *   (× 0.251), the energy belongs to a wider emission (a voice's FM band over the line) or to a
 *   neighbour, and the mask holds. Such an emission is never hidden by it (the tracker joins its
 *   pieces across a masked line), and lifting for it made the mask flicker and split or join its
 *   track. The flank starts one guard bin past the footprint, so a carrier on the footprint keeps
 *   its Hann main lobe off it: the flank reads nothing for a bin-centred tone and at most 0.04 of
 *   the footprint (−14 dB) for a tone half a bin off the edge. A flank holds the mask only when it
 *   is also loud on its own (it alone would put a slot at 6 dB); a faint spill lifts it.
 * - LO confirmation. A baseband spur stays at its baseband bin when the LO moves; a real emission
 *   moves with RF. An epoch credits its centre to a bin when the bin was a line for ≥ onFraction
 *   of the epoch, and a miss (an epoch of ≥ SPUR_MISS_MIN_MS where the bin was quiet and a line
 *   for under half the time) clears the bin's credits: a receiver spur is under every centre.
 *   A bin is confirmed with MIN_CONFIRM_CENTRES (2) credited centres at least
 *   `ceil(12.5 kHz / bin) + maxWidthBins + 2` bins apart (18 at 1 kHz): one centre cannot tell
 *   baseband from RF, and between two such centres a real emission of up to one 12.5 kHz
 *   channel plus the line's width and its ±1-bin skirt has left the line's bins entirely. The
 *   miss rule keeps two real emitters at one offset under far-apart hops from confirming it.
 *   Credits are never persisted: after a restart every line is unverified until re-confirmed.
 * - Expiry. Time is the key's settled observation time. A candidate expires SPUR_TTL_MS (10 min,
 *   the time the slow path needs to learn a line) after it was flagged or last seen while
 *   confirmed, whichever is later; a confirmed line unseen for SPUR_TTL_MS stops masking.
 *
 * Only confirmed candidates and restored ones not yet expired persist (exportState). Bins a
 * mask may not cover (a confirmed real signal there, `protect`) are left unmasked and counted.
 * RF positions are quantised to the key's bin width; an RF entry counts as on when a window bin
 * within ±1 bin of it is on, so carriers that straddle a bin edge under different centres still
 * accumulate in one entry.
 *
 * Callers pass only settled, gap-free, non-overload blocks.
 */
import {
	CHANNEL_GATE_DEFAULT_WIDTH_HZ,
	CHANNEL_GATE_K_DB,
	CHANNEL_GATE_MARGIN_DB,
} from "../scanner/scanner-redesign-contract.js"
import type { LineGate } from "./provisional-spurs.js"
import type { EngineState } from "./types.js"

export const MIN_BASEBAND_CENTRES = 3
export const MIN_RF_CENTRES = 2
/** Credited centres, pairwise separated, a bin needs before it masks. */
export const MIN_CONFIRM_CENTRES = 2
/** Slot level at or over which a bin is a real signal, not a receiver line: the gate's pass level (3 + 3 dB). */
export const SPUR_MAX_LEVEL_DB = CHANNEL_GATE_K_DB + CHANNEL_GATE_MARGIN_DB
/** Width of the slot the level is measured over (the gate's default channel). */
export const SPUR_LEVEL_SLOT_HZ = CHANNEL_GATE_DEFAULT_WIDTH_HZ
/** Settled observation time of a key after which an unconfirmed or unseen candidate expires. */
export const SPUR_TTL_MS = 600_000
/** Shortest epoch that can be a miss: 2 blocks at 50 ms. */
export const SPUR_MISS_MIN_MS = 100
/**
 * Confirmed real signals a source's masks may carry (`realRanges`): the scanner keeps the most
 * recently seen. 4096 × 12.5 kHz = 51.2 MHz of back-to-back voice channels, past any band set a
 * source watches; the pipeline maps each once per mask change or epoch, O(ranges).
 */
export const MAX_REAL_RANGES = 4096
const SPUR_MISS_ON_FRACTION = 0.5
const MAX_CENTRES_KEPT = 8
const MAX_RF_ENTRIES = 16_384
const DB_TO_LN = Math.LN10 / 10
const MAX_LEVEL_RATIO = 10 ** (SPUR_MAX_LEVEL_DB / 10)

interface EpochRef {
	epoch: number
	centreHz: number
	binHz: number
}

interface RfEntry {
	onMs: number
	observedMs: number
	centres: number[]
	epoch: number
	epochCentreHz: number
	epochOnMs: number
	epochObservedMs: number
	lastBasebandBin: number
}

interface KeyState {
	binHz: number
	/** Minimum distance (Hz) between two credited centres that confirm a bin. */
	separationHz: number
	epoch: number | null
	centreHz: number
	/** Settled observation time of this key (ms): the clock of expiry. */
	clockMs: number
	onMs: Float64Array
	observedMs: Float64Array
	epochOnMs: Float64Array
	epochObservedMs: Float64Array
	/** Time in this epoch the bin was at or over the level bound. */
	epochLoudMs: Float64Array
	/** Credited centres since the bin's last miss. */
	centres: number[][]
	/** 1 = MIN_CONFIRM_CENTRES separated centres in `centres`. */
	confirmed: Uint8Array
	/** Clock of the last block the bin was a line (−∞ never). */
	lastSeenMs: Float64Array
	/** Candidate flags (learned, promoted or restored). */
	baseband: Uint8Array
	/** Clock a candidate bin was flagged. */
	bornMs: Float64Array
	/** Latest clock a candidate bin was seen while confirmed (−∞ never). */
	keepMs: Float64Array
	/** 1 = the candidate came from disk and has not expired. */
	imported: Uint8Array
	rf: Map<number, RfEntry>
	rfConfirmed: Map<
		number,
		{ rfHz: number; widthBins: number; basebandBin: number }
	>
}

export class SpurMap implements LineGate {
	private readonly fftSize: number
	private readonly minObservedMs: number
	private readonly onFraction: number
	private readonly maxWidthBins: number
	private readonly keys = new Map<string, KeyState>()
	private readonly dilated: Uint8Array
	private readonly qualifies: Uint8Array
	/** Slot level of the last measured block, linear (power / floor); 0 until measured, +∞ unknown. */
	private readonly level: Float32Array
	private readonly sumP: Float64Array
	private readonly sumF: Float64Array
	/** False after a measurement without a floor: the block is no evidence for the baseband learner. */
	private levelKnown = true
	/** Bins of the level slot in the last measurement (13 at 1 kHz). */
	private slotBins = 1
	/** False until the first measurement: every level reads 0 (quiet) until then. */
	private measured = false

	constructor(opts: {
		fftSize: number
		minObservedMs: number
		onFraction: number
		maxWidthBins: number
	}) {
		this.fftSize = opts.fftSize
		this.minObservedMs = opts.minObservedMs
		this.onFraction = opts.onFraction
		this.maxWidthBins = opts.maxWidthBins
		this.dilated = new Uint8Array(opts.fftSize)
		this.qualifies = new Uint8Array(opts.fftSize)
		this.level = new Float32Array(opts.fftSize)
		this.sumP = new Float64Array(opts.fftSize + 1)
		this.sumF = new Float64Array(opts.fftSize + 1)
	}

	/**
	 * This block's slot level per bin: Σ power / Σ floor over the bins of a SPUR_LEVEL_SLOT_HZ
	 * slot centred on it (13 bins at 1 kHz), from prefix sums (2 exp per bin, no allocation).
	 * `floorDb` null (no floor of this key yet) makes every bin unknown: nothing masks, and the
	 * block counts neither for nor against a line. `mask`, `masks` and `observe` read the last measurement.
	 */
	measure(
		powerDb: Float32Array,
		floorDb: Float32Array | null,
		binHz: number,
	): void {
		const n = this.fftSize
		const lv = this.level
		this.levelKnown = floorDb !== null && binHz > 0
		this.measured = true
		if (floorDb === null || !(binHz > 0)) {
			lv.fill(Number.POSITIVE_INFINITY)
			return
		}
		const p = this.sumP
		const f = this.sumF
		for (let i = 0; i < n; i++) {
			const v = powerDb[i]!
			const fl = floorDb[i]!
			p[i + 1] = p[i]! + (Number.isFinite(v) ? Math.exp(v * DB_TO_LN) : 0)
			f[i + 1] = f[i]! + (Number.isFinite(fl) ? Math.exp(fl * DB_TO_LN) : 0)
		}
		const w = Math.max(1, Math.round(SPUR_LEVEL_SLOT_HZ / binHz))
		this.slotBins = w
		const lo = (w - 1) >> 1
		const hi = w - lo
		for (let i = 0; i < n; i++) {
			const a = i - lo < 0 ? 0 : i - lo
			const b = i + hi > n ? n : i + hi
			const fs = f[b]! - f[a]!
			lv[i] = fs > 0 ? (p[b]! - p[a]!) / fs : Number.POSITIVE_INFINITY
		}
	}

	/**
	 * One block. `onBins` (the detector output) feeds the RF-carrier learner. `line` feeds the
	 * baseband learner: `on` = the bin is on as a line (the caller re-tests bins its own mask
	 * hid), `observable` = the bin could be seen at all (not DC, edge or an exclusion). Without
	 * `line`, `onBins` and every bin. A bin at or over the level bound is no line.
	 */
	observe(
		key: string,
		epoch: EpochRef,
		onBins: Uint8Array,
		blockMs: number,
		line?: { on: Uint8Array; observable: Uint8Array },
	): void {
		const n = this.fftSize
		const s = this.state(key, epoch.binHz)
		if (s.epoch !== epoch.epoch) {
			this.closeBasebandEpoch(s)
			s.epoch = epoch.epoch
			s.centreHz = epoch.centreHz
		}
		s.clockMs += blockMs
		const lineOn = line?.on ?? onBins
		const observable = line?.observable
		const lv = this.level
		for (let i = 0; i < n && this.levelKnown; i++) {
			if (observable !== undefined && observable[i] !== 1) continue
			s.observedMs[i] = s.observedMs[i]! + blockMs
			s.epochObservedMs[i] = s.epochObservedMs[i]! + blockMs
			if (!(lv[i]! < MAX_LEVEL_RATIO)) {
				s.epochLoudMs[i] = s.epochLoudMs[i]! + blockMs
				continue
			}
			if (lineOn[i] === 1) {
				s.onMs[i] = s.onMs[i]! + blockMs
				s.epochOnMs[i] = s.epochOnMs[i]! + blockMs
				s.lastSeenMs[i] = s.clockMs
			}
		}
		const d = this.dilated
		for (let i = 0; i < n; i++)
			d[i] =
				onBins[i] === 1 || onBins[i - 1] === 1 || onBins[i + 1] === 1 ? 1 : 0
		for (let i = 0; i < n; i++) {
			if (onBins[i] !== 1) continue
			const rb = Math.round(epoch.centreHz / s.binHz) + i - n / 2
			if (!s.rf.has(rb)) {
				s.rf.set(rb, {
					onMs: 0,
					observedMs: 0,
					centres: [],
					epoch: epoch.epoch,
					epochCentreHz: epoch.centreHz,
					epochOnMs: 0,
					epochObservedMs: 0,
					lastBasebandBin: i,
				})
			}
		}
		const centreBin = Math.round(epoch.centreHz / s.binHz)
		for (const [rb, e] of s.rf) {
			const j = rb - centreBin + n / 2
			if (j < 0 || j >= n) continue
			if (e.epoch !== epoch.epoch) {
				this.closeRfEpoch(e)
				e.epoch = epoch.epoch
				e.epochCentreHz = epoch.centreHz
			}
			e.observedMs += blockMs
			e.epochObservedMs += blockMs
			e.lastBasebandBin = j
			if (d[j] === 1) {
				e.onMs += blockMs
				e.epochOnMs += blockMs
			}
		}
		if (s.rf.size > MAX_RF_ENTRIES) {
			for (const [rb, e] of s.rf)
				if (e.onMs < this.onFraction * e.observedMs) s.rf.delete(rb)
		}
		if (s.rf.size > MAX_RF_ENTRIES) {
			// Still over the bound (P11): evict the least-on entries, oldest first on ties.
			const byOn = [...s.rf].sort((a, b) => a[1].onMs - b[1].onMs)
			for (let k = 0; s.rf.size > MAX_RF_ENTRIES; k++) s.rf.delete(byOn[k]![0])
		}
		this.classify(s)
		this.expire(s)
	}

	/**
	 * Flags `ranges` as baseband spur candidates of `key` (the comb fast path of spec § 4.9:
	 * ProvisionalSpurs returns the ranges, widened by ±1 bin). They mask once verified, like
	 * learned ones, and expire like them.
	 */
	promote(
		key: string,
		binHz: number,
		ranges: readonly { startBin: number; endBin: number }[],
	): void {
		const s = this.state(key, binHz)
		for (const r of ranges)
			for (
				let i = Math.max(0, r.startBin);
				i < Math.min(this.fftSize, r.endBin);
				i++
			)
				this.flag(s, i)
	}

	/**
	 * Sets out[i] = 1 on the key's verified baseband spur bins (other bins untouched): each run of
	 * them masks whole while its own level in the last measured block is under SPUR_MAX_LEVEL_DB
	 * (ownQuiet), and lifts whole otherwise. A bin with protect[i] = 1 stays unmasked; returns how many.
	 */
	mask(key: string, out: Uint8Array, protect?: Uint8Array): number {
		const s = this.keys.get(key)
		if (s === undefined) return 0
		const n = this.fftSize
		let suspended = 0
		for (let i = 0; i < n; ) {
			if (!this.active(s, i)) {
				i++
				continue
			}
			let j = i
			while (j < n && this.active(s, j)) j++
			if (this.holds(i, j))
				for (let k = i; k < j; k++) {
					if (protect !== undefined && protect[k] === 1) suspended++
					else out[k] = 1
				}
			i = j
		}
		return suspended
	}

	/**
	 * LineGate: the line [startBin, endBin) (core bins) is verified, and its own level with ±1 bin
	 * of Hann skirt is under SPUR_MAX_LEVEL_DB in the last measured block (ownQuiet).
	 */
	masks(key: string, startBin: number, endBin: number): boolean {
		const s = this.keys.get(key)
		if (s === undefined || !this.verifiedIn(s, startBin, endBin)) return false
		return this.holds(startBin - 1, endBin + 1)
	}

	/**
	 * A verified mask over the footprint [startBin, endBin) holds in the last measured block: its
	 * own level is quiet (ownQuiet), or the loud energy on it is no narrow carrier sitting on the
	 * line but part of a wider emission or a neighbour (wider). An unknown level (no floor yet)
	 * holds nothing.
	 */
	holds(startBin: number, endBin: number): boolean {
		return (
			this.ownQuiet(startBin, endBin) ||
			(this.levelKnown && this.wider(startBin, endBin))
		)
	}

	/**
	 * The loud energy on the footprint [startBin, endBin) spills past it. A flank is as many bins
	 * as the footprint, one guard bin past it on either side (clipped to the FFT): past a SpurMap
	 * run's ±1 bin the tracker cannot see, the bins it sees first. Either flank that is loud on its
	 * own, by both of these, holds the mask:
	 *
	 * - against the footprint, a mean excess over the floor per bin, (Σ power − Σ floor) / bins,
	 *   of at least the footprint's own less SPUR_MAX_LEVEL_DB (× 10^−0.6 ≈ 0.251). A flat
	 *   emission covering the line (a voice's FM band) reads about 1. A Hann carrier with its peak
	 *   on the footprint leaves at most far skirt there: bin-centred, nothing (its main lobe is its
	 *   bin ±1, inside footprint and guard); half a bin off the footprint's edge bin, inward or
	 *   outward, 0.029 + 0.0006 of its peak power against 0.72 (+ 0.029 on a wider footprint), a
	 *   ratio of at most 0.04 (−14 dB). A carrier with its peak on a guard bin spills its −6 dB
	 *   skirt equally on both sides, a ratio of 1: it is a neighbour, and the mask holds;
	 * - against the floor, its own level (ownQuiet over the flank) at least SPUR_MAX_LEVEL_DB,
	 *   as much excess as a lift needs: energy that strong past the mask is tracked there, so the
	 *   emission's track reaches past the masked line (and is never flagged a spur for lying on
	 *   it), where a faint spill the detector does not see would leave it lying on the line alone.
	 */
	wider(startBin: number, endBin: number): boolean {
		const n = this.fftSize
		const a = Math.max(0, startBin)
		const b = Math.min(n, endBin)
		if (b <= a) return false
		const w = b - a
		const own = this.excess(a, b) / w
		if (!(own > 0)) return false
		const bound = own / MAX_LEVEL_RATIO
		const loud = (fa: number, fb: number): boolean =>
			fb > fa &&
			this.excess(fa, fb) / (fb - fa) >= bound &&
			!this.ownQuiet(fa, fb)
		return (
			loud(Math.max(0, a - 1 - w), Math.max(0, a - 1)) ||
			loud(Math.min(n, b + 1), Math.min(n, b + 1 + w))
		)
	}

	/** Σ (power − floor) over [a, b) in the last measured block, linear. */
	private excess(a: number, b: number): number {
		return this.sumP[b]! - this.sumP[a]! - (this.sumF[b]! - this.sumF[a]!)
	}

	/**
	 * The footprint [startBin, endBin) alone stays under SPUR_MAX_LEVEL_DB in the last measured
	 * block: 1 + Σ_footprint (power − floor) / Σ_slot floor, the slot SPUR_LEVEL_SLOT_HZ wide,
	 * centred on the footprint and widened to cover it. Power beside the footprint does not count.
	 * An unknown level (no floor yet) is not quiet; an empty footprint, or one before any
	 * measurement (every level 0, as `level` starts), is.
	 */
	ownQuiet(startBin: number, endBin: number): boolean {
		const n = this.fftSize
		const a = Math.max(0, startBin)
		const b = Math.min(n, endBin)
		if (b <= a || !this.measured) return true
		if (!this.levelKnown) return false
		const f = this.sumF
		const w = this.slotBins
		const c = (a + b - 1) >> 1
		const lo = (w - 1) >> 1
		const sa = Math.max(0, Math.min(a, c - lo))
		const sb = Math.min(n, Math.max(b, c + w - lo))
		const slotFloor = f[sb]! - f[sa]!
		if (!(slotFloor > 0)) return false
		return 1 + this.excess(a, b) / slotFloor < MAX_LEVEL_RATIO
	}

	/**
	 * Every bin of [startBin, endBin) had a slot level under SPUR_MAX_LEVEL_DB in the last measured
	 * block (an unknown level, no floor yet, is not quiet). Key-free: the level is the block's own.
	 * A neighbour within half a slot makes it loud: the stale exemption (pipeline) reads it so.
	 */
	quiet(startBin: number, endBin: number): boolean {
		for (let i = Math.max(0, startBin); i < Math.min(this.fftSize, endBin); i++)
			if (!(this.level[i]! < MAX_LEVEL_RATIO)) return false
		return true
	}

	/** LineGate: a bin of [startBin − 1, endBin] is confirmed and was seen within the TTL. */
	verified(key: string, startBin: number, endBin: number): boolean {
		const s = this.keys.get(key)
		return s !== undefined && this.verifiedIn(s, startBin, endBin)
	}

	/** LineGate: a candidate bin of [startBin − 1, endBin] has not expired. */
	alive(key: string, startBin: number, endBin: number): boolean {
		const s = this.keys.get(key)
		if (s === undefined) return false
		for (
			let i = Math.max(0, startBin - 1);
			i <= Math.min(this.fftSize - 1, endBin);
			i++
		)
			if (s.baseband[i] === 1) return true
		return false
	}

	/**
	 * Sets out[i] = 1 on every candidate bin of `key` that has not expired (learned, promoted or
	 * restored), verified or not and whatever its level (other bins untouched).
	 */
	candidates(key: string, out: Uint8Array): void {
		const s = this.keys.get(key)
		if (s === undefined) return
		const n = Math.min(this.fftSize, out.length)
		for (let i = 0; i < n; i++) if (s.baseband[i] === 1) out[i] = 1
	}

	rfCarriers(): { rfHz: number; widthBins: number }[] {
		const out = new Map<number, { rfHz: number; widthBins: number }>()
		for (const s of this.keys.values()) {
			for (const c of s.rfConfirmed.values())
				out.set(c.rfHz, { rfHz: c.rfHz, widthBins: c.widthBins })
		}
		return [...out.values()].sort((a, b) => a.rfHz - b.rfHz)
	}

	/** Confirmed candidates, and restored ones not yet expired (a new line persists once confirmed). */
	exportState(): Pick<EngineState, "spurs"> {
		const spurs: EngineState["spurs"] = []
		const keep = (s: KeyState, i: number): boolean =>
			s.baseband[i] === 1 && (s.imported[i] === 1 || this.confirmedNear(s, i))
		for (const [key, s] of this.keys) {
			for (let i = 0; i < this.fftSize; ) {
				if (!keep(s, i)) {
					i++
					continue
				}
				let j = i
				while (j < this.fftSize && keep(s, j)) j++
				spurs.push({ key, basebandBin: i, widthBins: j - i, kind: "baseband" })
				i = j
			}
			for (const c of s.rfConfirmed.values())
				spurs.push({
					key,
					basebandBin: c.basebandBin,
					widthBins: c.widthBins,
					kind: "rf",
					rfHz: c.rfHz,
				})
		}
		return { spurs }
	}

	/** Restored baseband lines are candidates with no credits: unverified until re-confirmed. */
	importState(st: Pick<EngineState, "spurs">): void {
		for (const sp of st.spurs) {
			// key = `${fs}:${gainKey}:${fftSize}`; one SpurMap serves one fftSize
			const binHz = Number(sp.key.split(":")[0]) / this.fftSize
			if (!Number.isFinite(binHz) || binHz <= 0) continue
			const s = this.state(sp.key, binHz)
			if (sp.kind === "baseband") {
				for (
					let i = sp.basebandBin;
					i < sp.basebandBin + sp.widthBins && i < this.fftSize;
					i++
				)
					if (i >= 0) {
						this.flag(s, i)
						s.imported[i] = 1
					}
			} else if (sp.rfHz !== undefined) {
				s.rfConfirmed.set(Math.round(sp.rfHz / binHz), {
					rfHz: sp.rfHz,
					widthBins: sp.widthBins,
					basebandBin: sp.basebandBin,
				})
			}
		}
	}

	private state(key: string, binHz: number): KeyState {
		let s = this.keys.get(key)
		if (s === undefined) {
			const n = this.fftSize
			const separationBins =
				Math.ceil(SPUR_LEVEL_SLOT_HZ / binHz) + this.maxWidthBins + 2
			s = {
				binHz,
				separationHz: separationBins * binHz,
				epoch: null,
				centreHz: 0,
				clockMs: 0,
				onMs: new Float64Array(n),
				observedMs: new Float64Array(n),
				epochOnMs: new Float64Array(n),
				epochObservedMs: new Float64Array(n),
				epochLoudMs: new Float64Array(n),
				centres: Array.from({ length: n }, () => []),
				confirmed: new Uint8Array(n),
				lastSeenMs: new Float64Array(n).fill(Number.NEGATIVE_INFINITY),
				baseband: new Uint8Array(n),
				bornMs: new Float64Array(n),
				keepMs: new Float64Array(n).fill(Number.NEGATIVE_INFINITY),
				imported: new Uint8Array(n),
				rf: new Map(),
				rfConfirmed: new Map(),
			}
			this.keys.set(key, s)
		}
		return s
	}

	private flag(s: KeyState, i: number): void {
		if (s.baseband[i] === 1) return
		s.baseband[i] = 1
		s.bornMs[i] = s.clockMs
		s.keepMs[i] = Number.NEGATIVE_INFINITY
		s.imported[i] = 0
	}

	/** A candidate bin verified now (its level aside: mask lifts loud runs whole). */
	private active(s: KeyState, i: number): boolean {
		return (
			s.baseband[i] === 1 &&
			this.confirmedNear(s, i) &&
			s.clockMs - this.seenNear(s, i) < SPUR_TTL_MS
		)
	}

	private verifiedIn(s: KeyState, startBin: number, endBin: number): boolean {
		for (
			let i = Math.max(0, startBin - 1);
			i <= Math.min(this.fftSize - 1, endBin);
			i++
		)
			if (s.confirmed[i] === 1 && s.clockMs - s.lastSeenMs[i]! < SPUR_TTL_MS)
				return true
		return false
	}

	/** A bin within ±1 is confirmed (a promoted range carries a ±1-bin skirt). */
	private confirmedNear(s: KeyState, i: number): boolean {
		return (
			s.confirmed[i] === 1 ||
			(i > 0 && s.confirmed[i - 1] === 1) ||
			(i + 1 < this.fftSize && s.confirmed[i + 1] === 1)
		)
	}

	private seenNear(s: KeyState, i: number): number {
		let t = s.lastSeenMs[i]!
		if (i > 0 && s.lastSeenMs[i - 1]! > t) t = s.lastSeenMs[i - 1]!
		if (i + 1 < this.fftSize && s.lastSeenMs[i + 1]! > t)
			t = s.lastSeenMs[i + 1]!
		return t
	}

	/** Refreshes candidates seen while confirmed; drops those past the TTL. */
	private expire(s: KeyState): void {
		for (let i = 0; i < this.fftSize; i++) {
			if (s.baseband[i] !== 1) continue
			if (this.confirmedNear(s, i)) {
				const seen = this.seenNear(s, i)
				if (seen > s.keepMs[i]!) s.keepMs[i] = seen
			}
			const since = Math.max(s.bornMs[i]!, s.keepMs[i]!)
			if (s.clockMs - since >= SPUR_TTL_MS) {
				s.baseband[i] = 0
				s.imported[i] = 0
			}
		}
	}

	/** Credits the closing epoch's centre to its line bins; a miss clears a bin's credits. */
	private closeBasebandEpoch(s: KeyState): void {
		if (s.epoch === null) return
		let changed = false
		for (let i = 0; i < this.fftSize; i++) {
			const obs = s.epochObservedMs[i]!
			if (obs <= 0) continue
			const on = s.epochOnMs[i]!
			if (on >= this.onFraction * obs) {
				changed = addCentre(s.centres[i]!, s.centreHz) || changed
			} else if (
				obs >= SPUR_MISS_MIN_MS &&
				on < SPUR_MISS_ON_FRACTION * obs &&
				s.epochLoudMs[i]! < SPUR_MISS_ON_FRACTION * obs &&
				s.centres[i]!.length > 0
			) {
				s.centres[i]!.length = 0
				changed = true
			}
		}
		s.epochOnMs.fill(0)
		s.epochObservedMs.fill(0)
		s.epochLoudMs.fill(0)
		if (!changed) return
		for (let i = 0; i < this.fftSize; i++)
			s.confirmed[i] = separated(s.centres[i]!, s.separationHz) ? 1 : 0
	}

	private closeRfEpoch(e: RfEntry): void {
		if (
			e.epochObservedMs > 0 &&
			e.epochOnMs >= this.onFraction * e.epochObservedMs
		)
			addCentre(e.centres, e.epochCentreHz)
		e.epochOnMs = 0
		e.epochObservedMs = 0
	}

	/** Flags qualifying narrow runs as baseband spur candidates; confirms RF carriers. */
	private classify(s: KeyState): void {
		const n = this.fftSize
		const q = this.qualifies
		for (let i = 0; i < n; i++) {
			const obs = s.observedMs[i]!
			let centres = s.centres[i]!.length
			const epObs = s.epochObservedMs[i]!
			if (
				epObs > 0 &&
				s.epochOnMs[i]! >= this.onFraction * epObs &&
				!s.centres[i]!.includes(s.centreHz)
			)
				centres++
			q[i] =
				obs >= this.minObservedMs &&
				s.onMs[i]! >= this.onFraction * obs &&
				centres >= MIN_BASEBAND_CENTRES
					? 1
					: 0
		}
		for (let i = 0; i < n; ) {
			if (q[i] !== 1) {
				i++
				continue
			}
			let j = i
			while (j < n && q[j] === 1) j++
			if (j - i <= this.maxWidthBins)
				for (let k = i; k < j; k++) this.flag(s, k)
			i = j
		}
		const qualifying: number[] = []
		for (const [rb, e] of s.rf) {
			let centres = e.centres.length
			if (
				e.epochObservedMs > 0 &&
				e.epochOnMs >= this.onFraction * e.epochObservedMs &&
				!e.centres.includes(e.epochCentreHz)
			)
				centres++
			if (
				e.observedMs >= this.minObservedMs &&
				e.onMs >= this.onFraction * e.observedMs &&
				centres >= MIN_RF_CENTRES
			)
				qualifying.push(rb)
		}
		qualifying.sort((a, b) => a - b)
		// A carrier that straddles a bin edge under different centres can leave a
		// qualifying entry one bin to either side of its own run, so a run up to
		// two bins wider than maxWidthBins is still accepted; the width reported is
		// the whole run.
		for (let i = 0; i < qualifying.length; ) {
			let j = i
			while (
				j + 1 < qualifying.length &&
				qualifying[j + 1] === qualifying[j]! + 1
			)
				j++
			const width = j - i + 1
			if (width <= this.maxWidthBins + 2) {
				const first = qualifying[i]!
				const last = qualifying[j]!
				const mid = Math.round((first + last) / 2)
				if (![...s.rfConfirmed.keys()].some(k => Math.abs(k - mid) <= 1)) {
					s.rfConfirmed.set(mid, {
						rfHz: ((first + last) / 2) * s.binHz,
						widthBins: width,
						basebandBin: s.rf.get(mid)?.lastBasebandBin ?? 0,
					})
				}
			}
			i = j + 1
		}
	}
}

/** Adds a centre once; past MAX_CENTRES_KEPT the oldest leaves, so fresh evidence still counts. */
function addCentre(list: number[], centreHz: number): boolean {
	if (list.includes(centreHz)) return false
	if (list.length >= MAX_CENTRES_KEPT) list.shift()
	list.push(centreHz)
	return true
}

/** MIN_CONFIRM_CENTRES centres of `list` pairwise at least `minHz` apart (greedy over the sorted list). */
function separated(list: readonly number[], minHz: number): boolean {
	if (list.length < MIN_CONFIRM_CENTRES) return false
	let lo = Number.POSITIVE_INFINITY
	let hi = Number.NEGATIVE_INFINITY
	for (const c of list) {
		if (c < lo) lo = c
		if (c > hi) hi = c
	}
	// MIN_CONFIRM_CENTRES = 2: two centres that far apart exist iff the extremes are.
	return hi - lo >= minHz
}
