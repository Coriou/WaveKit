/**
 * Spur learning (spec § 4.4). Keyed by `${fs}:${gainKey}:${fftSize}` in
 * baseband bin offsets, so it survives retunes and accumulates across every
 * hop of a sweep. A candidate is a bin range ≤ maxWidthBins wide that is on
 * for ≥ onFraction of ≥ minObservedMs of settled observation. It is classified
 * by whether it moves with the centre:
 *
 * - on at the same baseband bins in epochs with ≥ 3 different centres →
 *   baseband spur: masked (mask()), never reported as an RF discovery;
 * - on at the same RF frequency in epochs with ≥ 2 different centres →
 *   RF-fixed carrier (rfCarriers()): reported once as a `carrier`, excluded
 *   from probe allocation, not from detection.
 *
 * An epoch counts for a centre when the bin was on for ≥ onFraction of that
 * epoch's observed time. Classification runs after every observed block; its
 * results are sticky per key (masking a spur does not un-learn it) and
 * persist via exportState(). RF positions are quantised to the key's bin
 * width; an RF entry counts as on when a window bin within ±1 bin of it is
 * on, so carriers that straddle a bin edge under different centres still
 * accumulate in one entry.
 *
 * Callers pass only settled, gap-free, non-overload blocks.
 */
import type { EngineState } from "./types.js"

export const MIN_BASEBAND_CENTRES = 3
export const MIN_RF_CENTRES = 2
const MAX_CENTRES_KEPT = 8
const MAX_RF_ENTRIES = 16_384

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
	epoch: number | null
	centreHz: number
	onMs: Float64Array
	observedMs: Float64Array
	epochOnMs: Float64Array
	epochObservedMs: Float64Array
	centres: number[][]
	baseband: Uint8Array
	rf: Map<number, RfEntry>
	rfConfirmed: Map<
		number,
		{ rfHz: number; widthBins: number; basebandBin: number }
	>
}

export class SpurMap {
	private readonly fftSize: number
	private readonly minObservedMs: number
	private readonly onFraction: number
	private readonly maxWidthBins: number
	private readonly keys = new Map<string, KeyState>()
	private readonly dilated: Uint8Array
	private readonly qualifies: Uint8Array

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
	}

	observe(
		key: string,
		epoch: EpochRef,
		onBins: Uint8Array,
		blockMs: number,
	): void {
		const n = this.fftSize
		const s = this.state(key, epoch.binHz)
		if (s.epoch !== epoch.epoch) {
			this.closeBasebandEpoch(s)
			s.epoch = epoch.epoch
			s.centreHz = epoch.centreHz
		}
		for (let i = 0; i < n; i++) {
			s.observedMs[i] = s.observedMs[i]! + blockMs
			s.epochObservedMs[i] = s.epochObservedMs[i]! + blockMs
			if (onBins[i] === 1) {
				s.onMs[i] = s.onMs[i]! + blockMs
				s.epochOnMs[i] = s.epochOnMs[i]! + blockMs
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
	}

	/**
	 * Makes `ranges` baseband spurs of `key` at once (sticky, persisted like learned ones): the comb
	 * fast path of spec § 4.9 (Task 7a's ProvisionalSpurs returns the ranges, widened by ±1 bin).
	 */
	promote(
		key: string,
		binHz: number,
		ranges: readonly { startBin: number; endBin: number }[],
	): void {
		const s = this.state(key, binHz)
		for (const r of ranges)
			s.baseband.fill(
				1,
				Math.max(0, r.startBin),
				Math.min(this.fftSize, r.endBin),
			)
	}

	/** Sets out[i] = 1 on the key's baseband spur bins (other bins untouched). */
	mask(key: string, out: Uint8Array): void {
		const s = this.keys.get(key)
		if (s === undefined) return
		for (let i = 0; i < this.fftSize; i++) if (s.baseband[i] === 1) out[i] = 1
	}

	rfCarriers(): { rfHz: number; widthBins: number }[] {
		const out = new Map<number, { rfHz: number; widthBins: number }>()
		for (const s of this.keys.values()) {
			for (const c of s.rfConfirmed.values())
				out.set(c.rfHz, { rfHz: c.rfHz, widthBins: c.widthBins })
		}
		return [...out.values()].sort((a, b) => a.rfHz - b.rfHz)
	}

	exportState(): Pick<EngineState, "spurs"> {
		const spurs: EngineState["spurs"] = []
		for (const [key, s] of this.keys) {
			for (let i = 0; i < this.fftSize; ) {
				if (s.baseband[i] !== 1) {
					i++
					continue
				}
				let j = i
				while (j < this.fftSize && s.baseband[j] === 1) j++
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
					if (i >= 0) s.baseband[i] = 1
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
			s = {
				binHz,
				epoch: null,
				centreHz: 0,
				onMs: new Float64Array(n),
				observedMs: new Float64Array(n),
				epochOnMs: new Float64Array(n),
				epochObservedMs: new Float64Array(n),
				centres: Array.from({ length: n }, () => []),
				baseband: new Uint8Array(n),
				rf: new Map(),
				rfConfirmed: new Map(),
			}
			this.keys.set(key, s)
		}
		return s
	}

	private closeBasebandEpoch(s: KeyState): void {
		if (s.epoch === null) return
		for (let i = 0; i < this.fftSize; i++) {
			const obs = s.epochObservedMs[i]!
			if (obs > 0 && s.epochOnMs[i]! >= this.onFraction * obs)
				addCentre(s.centres[i]!, s.centreHz)
		}
		s.epochOnMs.fill(0)
		s.epochObservedMs.fill(0)
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

	/** Promotes qualifying narrow runs to sticky baseband spurs / RF carriers. */
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
				for (let k = i; k < j; k++) s.baseband[k] = 1
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

function addCentre(list: number[], centreHz: number): void {
	if (!list.includes(centreHz) && list.length < MAX_CENTRES_KEPT)
		list.push(centreHz)
}
