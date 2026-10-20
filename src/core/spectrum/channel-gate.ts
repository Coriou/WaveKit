/**
 * Channel-matched gate (scanner redesign R 2.1–2.4).
 *
 * kCh starts at CHANNEL_GATE_K_DB (3 dB). The per-bin detector table
 * (`defaultK`) is not used: at 1 kHz / 50 ms that table is 4 dB, and R 2.3
 * pins the channel threshold at 3 dB (burst pass at 9 dB = 3 + 6). The
 * raise/lower schedule is the detector CFAR: +0.5 dB per 5 min above the
 * false-alarm target, cap +4 dB, −0.5 dB per 30 min below a quarter of the
 * target, never below 3 dB.
 *
 * Slot runs exist only for CFAR false-alarm accounting and kCh adaptation.
 * A false alarm is a slot run that turned on and ended without passing.
 * A slot is `passed` only while that passing run continues (one off block
 * is tolerated). A second off returns the slot to idle and does not count
 * a false alarm. `passedSample` is the block that first met the rule.
 * `runStartSample` is the first block of that same run, or null while the
 * slot is not passed. Tracks do not borrow this run: stickiness of `passed`
 * lives on the track, which applies R 2.3/2.4 to its own measurements.
 * `resetRuns` clears on, run, offs, best and the pass without a false
 * alarm; kCh and its CFAR windows stay. The last measurement stays readable.
 * `block` does not allocate; scratch is sized here and in `setPlan`.
 *
 * The reading's measurement is this block. `channelSnrDb` is finite, or
 * `Number.NEGATIVE_INFINITY` when the block is invalid, skipped, or more
 * than half masked. `valid` is false in those cases. `kDb` is kCh of the
 * covering slot (pinned when a pin is set). `marginDb` is 3, or 6 when the
 * slot is burst; `minDurationMs` is 300, or 100 when burst. A wide track
 * (A9) sums the covering slots' power, takes the max of their k, and is
 * burst only when every covering slot is burst. `gateOf` still returns the
 * slot's `state` / `passedSample` / `runStartSample` for the gate's tests.
 * It never returns NaN or +Infinity. A non-finite centre, or a non-finite
 * or non-positive OBW, is pending with the sentinel and `valid: false`.
 *
 * A power or floor bin that is missing or not finite (NaN, ±Infinity), or
 * whose linear value overflows, invalidates that slot's block. The slot run
 * ends without passing and is not a false alarm. A masked fraction above
 * 0.5 skips the slot: the slot run does not advance.
 *
 * Slot count is at most `CHANNEL_GATE_MAX_SLOTS`. Doubling the sliding step,
 * then the raster step, counts in `coarsened`. When that cannot get under the
 * cap, duplicate slots with the same (lo, hi, rangeKey, burst) are dropped.
 * If the layout is still over, one sliding grid of `defaultWidthHz` over the
 * tuned window replaces it, doubling the half-width step until the cap holds.
 * Each of those grid reductions counts in `coarsened`.
 */
import {
	CFAR_LOWER_WINDOW_MIN,
	CFAR_MAX_RAISE_DB,
	CFAR_RAISE_WINDOW_MIN,
	CFAR_STEP_DB,
} from "./detector.js"
import { POWER_FLOOR_DB } from "./fft.js"
import {
	CHANNEL_GATE_BURST_MARGIN_DB,
	CHANNEL_GATE_BURST_MIN_DURATION_MS,
	CHANNEL_GATE_HYSTERESIS_DB,
	CHANNEL_GATE_K_DB,
	CHANNEL_GATE_MARGIN_DB,
	CHANNEL_GATE_MAX_SLOTS,
	CHANNEL_GATE_MAX_WIDTH_HZ,
	CHANNEL_GATE_MIN_DURATION_MS,
	CHANNEL_GATE_MIN_WIDTH_HZ,
	type ChannelGateState,
	type ChannelPlan,
	type ChannelPlanEntry,
} from "../scanner/scanner-redesign-contract.js"

/**
 * One slot reading. `state` / `passedSample` / `runStartSample` describe the
 * slot run (CFAR). The rest is this block's measurement for a track.
 * `minDurationMs` is 300, or 100 when the measurement is burst.
 */
export interface ChannelGateReading {
	state: ChannelGateState
	channelSnrDb: number
	passedSample: number | null
	runStartSample: number | null
	minDurationMs: number
	kDb: number
	marginDb: number
	valid: boolean
}
import { WaveKitError } from "../../utils/errors.js"

/** Same slack the detector uses so a rate exactly at the target does not raise. */
const RATE_TOLERANCE = 1e-9
/**
 * Keeps an exact multiple (4 096 × 6 250 / 6 250 = 4 096) from rounding up.
 */
const COUNT_SLACK = 1e-9
/** Uncovered span does not share a caller's rangeKey. */
const DEFAULT_RANGE_KEY = "\0default"
/**
 * scanner.detection.faTargetPerMhzMin default, used until setFaTargets.
 * Per MHz per minute.
 */
const DEFAULT_FA_PER_MHZ_MIN = 1
/** 1e-6 dB covers the pow/log round trip so an exact margin still passes. */
const MARGIN_SLACK_DB = 1e-6
/** 10^(db/10) = exp(db · ln(10) / 10). */
const LN10_OVER_10 = Math.LN10 / 10
/** Linear power matching `powerToDb`'s POWER_FLOOR_DB clamp. */
const POWER_FLOOR_LIN = Math.exp(POWER_FLOOR_DB * LN10_OVER_10)

export interface ChannelGate {
	setPlan(plan: ChannelPlan | null): void
	recentre(centreHz: number): void
	setFaTargets(
		byRangeKey: ReadonlyMap<string, number>,
		defaultPerMhzMin: number,
	): void
	/** Pinned k − table k. null selects adaptive kCh. */
	setPinnedOffsetDb(offsetDb: number | null): void
	block(
		powerDb: Float32Array,
		floorDb: Float32Array,
		masked: Uint8Array,
		sample: number,
	): void
	/**
	 * Same measurement as `block`. `powerAcc` is the pipeline linear sum
	 * before `powerToDb`; `frames` is the integrated-frame count. Floors
	 * stay in dB. Does not allocate.
	 */
	blockLinear(
		powerAcc: Float64Array,
		frames: number,
		floorDb: Float32Array,
		masked: Uint8Array,
		sample: number,
	): void
	/**
	 * Drops every slot's on/run/off/best and its pass. Does not count a
	 * false alarm and does not touch kCh or the CFAR windows.
	 */
	resetRuns(): void
	gateOf(centreHz: number, obwHz: number): ChannelGateReading
	/**
	 * Same reading as `gateOf`, written into `out`. The hot path reuses one
	 * object per block. `out` is returned.
	 */
	gateInto(
		centreHz: number,
		obwHz: number,
		out: ChannelGateReading,
	): ChannelGateReading
	kFor(rangeKey: string): number
	stats(): {
		slots: number
		coarsened: number
		maskedSkipped: number
		falseAlarms: number
	}
}

interface RangeState {
	key: string
	/** Entry span in MHz (gaps included). Exposure is mhz × minutes. */
	mhz: number
	k: number
	fa5: number
	exp5: number
	min5: number
	fa30: number
	exp30: number
	min30: number
}

interface Draft {
	lo: number
	hi: number
	centre: number
	key: string
	burst: boolean
	mhz: number
}

export function createChannelGate(opts: {
	binHz: number
	blockMs: number
	centreHz: number
	bins: number
	now?: () => number
}): ChannelGate {
	if (
		!(opts.binHz > 0) ||
		!Number.isFinite(opts.binHz) ||
		!(opts.blockMs > 0) ||
		!Number.isFinite(opts.blockMs) ||
		!Number.isFinite(opts.centreHz) ||
		!Number.isInteger(opts.bins) ||
		opts.bins < 1
	) {
		throw new WaveKitError(
			"channel gate needs finite centreHz and positive binHz, blockMs and bins",
			"CHANNEL_GATE_CONFIG",
		)
	}
	return new ChannelGateImpl(opts)
}

class ChannelGateImpl implements ChannelGate {
	private readonly binHz: number
	private readonly blockMs: number
	private centreHz: number
	private readonly bins: number
	private readonly nowFn: (() => number) | null
	private readonly prefixP: Float64Array
	private readonly prefixF: Float64Array
	private readonly prefixM: Uint32Array
	/** Unmasked bins that are missing, non-finite, or overflow in linear power. */
	private readonly prefixI: Uint32Array

	private ranges: RangeState[] = []
	private plan: ChannelPlan | null = null
	/** Planned keys survive away windows; only active ranges below accrue exposure. */
	private readonly retained = new Map<string, RangeState>()
	private readonly floorCached: Float32Array
	private readonly floorLinear: Float64Array
	private slotCount = 0
	private coarsened = 0
	private maskedSkipped = 0
	private falseAlarmCount = 0
	private pinnedOffset: number | null = null
	private defaultTarget = DEFAULT_FA_PER_MHZ_MIN
	private readonly targets = new Map<string, number>()
	private lastNow: number | null = null

	private slotLo = new Float64Array(0)
	private slotHi = new Float64Array(0)
	private slotCentre = new Float64Array(0)
	private slotBin0 = new Int32Array(0)
	private slotBin1 = new Int32Array(0)
	private slotRange = new Int32Array(0)
	private slotBurst = new Uint8Array(0)
	private slotOn = new Uint8Array(0)
	private slotRunning = new Uint8Array(0)
	private slotPassed = new Uint8Array(0)
	private slotOffs = new Uint8Array(0)
	private slotOnBlocks = new Int32Array(0)
	/** Best linear power/floor ratio in the run; convert only queried readings. */
	private slotBest = new Float64Array(0)
	private slotSnr = new Float64Array(0)
	private slotP = new Float64Array(0)
	private slotF = new Float64Array(0)
	/** 1 when this block produced a finite SNR for the slot. Not part of the run. */
	private slotBlockValid = new Uint8Array(0)
	private slotPassedSample = new Float64Array(0)
	/** Sample of the current run's first block. NaN while no run is open. */
	private slotRunStart = new Float64Array(0)
	/** Layout order, so a distance tie still picks the earlier slot. */
	private slotOrd = new Int32Array(0)
	/** Widest slot. Bounds the contain walk after the binary search on `lo`. */
	private maxSlotWidth = 0
	/** Inclusive-exclusive bin span covered by any slot. Prefix sums stop here. */
	private span0 = 0
	private span1 = 0

	constructor(opts: {
		binHz: number
		blockMs: number
		centreHz: number
		bins: number
		now?: () => number
	}) {
		this.floorCached = new Float32Array(opts.bins).fill(Number.NaN)
		this.floorLinear = new Float64Array(opts.bins)
		this.binHz = opts.binHz
		this.blockMs = opts.blockMs
		this.centreHz = opts.centreHz
		this.bins = opts.bins
		this.nowFn = opts.now ?? null
		this.prefixP = new Float64Array(opts.bins + 1)
		this.prefixF = new Float64Array(opts.bins + 1)
		this.prefixM = new Uint32Array(opts.bins + 1)
		this.prefixI = new Uint32Array(opts.bins + 1)
		for (
			let k = CHANNEL_GATE_K_DB;
			k <= CHANNEL_GATE_K_DB + CFAR_MAX_RAISE_DB;
			k += CFAR_STEP_DB
		)
			this.cacheThresholds(k)
	}

	setPlan(plan: ChannelPlan | null): void {
		// null clears the slots. An empty entry list still grids the tuned window.
		// Each rangeKey keeps k and its CFAR windows. A slot keeps its run when
		// (lo, hi, rangeKey, burst) is unchanged, so a re-sent plan does not
		// wipe adaptation or a run already in progress.
		this.plan = plan
		this.lastNow = null
		const keys = new Set(plan?.entries.map(e => e.rangeKey))
		keys.add(DEFAULT_RANGE_KEY)
		for (const key of this.retained.keys()) {
			if (plan === null || !keys.has(key)) this.retained.delete(key)
		}
		const built = plan === null ? null : layoutPlan(plan, this.window())
		this.install(built)
	}

	recentre(centreHz: number): void {
		if (!Number.isFinite(centreHz))
			throw new WaveKitError(
				"channel gate needs finite centreHz",
				"CHANNEL_GATE_CONFIG",
			)
		this.centreHz = centreHz
		// Exposure is received block time (or intervals between injected clock reads
		// within one epoch). Away time never counts; the injected clock starts
		// fresh on the first block after a retune or gain change. Windows survive.
		this.lastNow = null
		this.install(
			this.plan === null ? null : layoutPlan(this.plan, this.window()),
		)
		this.resetRuns()
		this.slotBlockValid.fill(0)
	}

	private linearFloor(i: number, db: number): number {
		if (this.floorCached[i] !== db) {
			this.floorCached[i] = db
			this.floorLinear[i] = Math.exp(db * LN10_OVER_10)
		}
		return this.floorLinear[i]!
	}

	setFaTargets(
		byRangeKey: ReadonlyMap<string, number>,
		defaultPerMhzMin: number,
	): void {
		this.defaultTarget = defaultPerMhzMin
		this.targets.clear()
		for (const [key, value] of byRangeKey) this.targets.set(key, value)
	}

	setPinnedOffsetDb(offsetDb: number | null): void {
		this.pinnedOffset = offsetDb
		if (offsetDb !== null) this.cacheThresholds(CHANNEL_GATE_K_DB + offsetDb)
	}

	block(
		powerDb: Float32Array,
		floorDb: Float32Array,
		masked: Uint8Array,
		sample: number,
	): void {
		const pP = this.prefixP
		const pF = this.prefixF
		const pM = this.prefixM
		const pI = this.prefixI
		const begin = this.span0
		const end = this.span1
		// One conversion pass, and only across bins a slot actually reads.
		// prefixI counts unmasked bins that cannot be measured. Those bins add
		// nothing to the power sums, so one bad bin cannot poison the suffix.
		if (end > begin) {
			pP[begin] = 0
			pF[begin] = 0
			pM[begin] = 0
			pI[begin] = 0
			let accP = 0
			let accF = 0
			let accM = 0
			let accI = 0
			const ln = LN10_OVER_10
			for (let i = begin; i < end; i++) {
				const isMasked = (masked[i] ?? 0) !== 0
				// Masked bins contribute 0 to both sums and are counted.
				if (isMasked) accM++
				else {
					const pDb = powerDb[i]
					const fDb = floorDb[i]
					if (
						pDb === undefined ||
						fDb === undefined ||
						!Number.isFinite(pDb) ||
						!Number.isFinite(fDb)
					) {
						accI++
					} else {
						const lp = Math.exp(pDb * ln)
						const lf = this.linearFloor(i, fDb)
						if (!Number.isFinite(lp) || !Number.isFinite(lf)) accI++
						else {
							accP += lp
							accF += lf
						}
					}
				}
				const next = i + 1
				pP[next] = accP
				pF[next] = accF
				pM[next] = accM
				pI[next] = accI
			}
		}
		this.finishSlots(sample)
	}

	blockLinear(
		powerAcc: Float64Array,
		frames: number,
		floorDb: Float32Array,
		masked: Uint8Array,
		sample: number,
	): void {
		const pP = this.prefixP
		const pF = this.prefixF
		const pM = this.prefixM
		const pI = this.prefixI
		const begin = this.span0
		const end = this.span1
		if (end > begin) {
			pP[begin] = 0
			pF[begin] = 0
			pM[begin] = 0
			pI[begin] = 0
			let accP = 0
			let accF = 0
			let accM = 0
			let accI = 0
			const scale =
				1 / (Math.max(1, frames) * (this.bins / 2) * (this.bins / 2))
			for (let i = begin; i < end; i++) {
				const isMasked = (masked[i] ?? 0) !== 0
				if (isMasked) accM++
				else {
					const raw = powerAcc[i]
					const fDb = floorDb[i]
					if (
						raw === undefined ||
						fDb === undefined ||
						!Number.isFinite(raw) ||
						!Number.isFinite(fDb)
					) {
						accI++
					} else {
						const lpRaw = raw * scale
						const lf = this.linearFloor(i, fDb)
						if (!Number.isFinite(lpRaw) || !Number.isFinite(lf)) accI++
						else {
							const lp =
								!(lpRaw > 0) || lpRaw < POWER_FLOOR_LIN
									? POWER_FLOOR_LIN
									: lpRaw
							accP += lp
							accF += lf
						}
					}
				}
				const next = i + 1
				pP[next] = accP
				pF[next] = accF
				pM[next] = accM
				pI[next] = accI
			}
		}
		this.finishSlots(sample)
	}

	resetRuns(): void {
		const n = this.slotCount
		for (let s = 0; s < n; s++) {
			this.slotOn[s] = 0
			this.slotRunning[s] = 0
			this.slotOffs[s] = 0
			this.slotOnBlocks[s] = 0
			this.slotBest[s] = Number.NEGATIVE_INFINITY
			this.slotPassed[s] = 0
			this.slotPassedSample[s] = Number.NaN
			this.slotRunStart[s] = Number.NaN
		}
	}

	private finishSlots(sample: number): void {
		const elapsedMin = this.pullElapsedMin()
		const ns = this.slotCount
		this.slotBlockValid.fill(0, 0, ns)
		for (let s = 0; s < ns; s++) this.updateSlot(s, sample)
		if (this.pinnedOffset === null) this.adapt(elapsedMin)
	}

	gateOf(centreHz: number, obwHz: number): ChannelGateReading {
		return this.gateInto(centreHz, obwHz, {
			state: "pending",
			channelSnrDb: 0,
			passedSample: null,
			runStartSample: null,
			minDurationMs: CHANNEL_GATE_MIN_DURATION_MS,
			kDb: CHANNEL_GATE_K_DB,
			marginDb: CHANNEL_GATE_MARGIN_DB,
			valid: false,
		})
	}

	gateInto(
		centreHz: number,
		obwHz: number,
		out: ChannelGateReading,
	): ChannelGateReading {
		// A bad query is not a measurement and must not report a passed slot.
		if (!Number.isFinite(centreHz) || !Number.isFinite(obwHz) || !(obwHz > 0))
			return this.writeIdle(out)
		const trackLo = centreHz - obwHz / 2
		const trackHi = centreHz + obwHz / 2
		const reach = this.maxSlotWidth
		let primary = -1
		let primaryDist = Infinity
		let primaryOrd = Infinity
		// Slots are ordered by lo. A containing slot starts at or before the
		// centre and no further left than its own width.
		for (let s = this.rightmostLo(centreHz); s >= 0; s--) {
			const slo = this.slotLo[s]!
			if (slo <= centreHz - reach) break
			if (centreHz >= this.slotHi[s]!) continue
			const d = Math.abs(this.slotCentre[s]! - centreHz)
			const ord = this.slotOrd[s]!
			if (d < primaryDist || (d === primaryDist && ord < primaryOrd)) {
				primaryDist = d
				primary = s
				primaryOrd = ord
			}
		}
		// A track that fits in the nearest containing slot uses that slot.
		// A wider track sums every slot that intersects its OBW (A9).
		if (
			primary >= 0 &&
			trackLo >= this.slotLo[primary]! &&
			trackHi <= this.slotHi[primary]!
		)
			return this.writeSlot(primary, out)
		let p = 0
		let f = 0
		let any = false
		let allValid = true
		let allBurst = true
		let maxK = Number.NEGATIVE_INFINITY
		let passed = false
		let passedSample = Infinity
		let runStart = Number.NaN
		for (let s = this.rightmostLo(trackHi); s >= 0; s--) {
			const slo = this.slotLo[s]!
			if (slo >= trackHi) continue
			if (slo + reach <= trackLo) break
			if (this.slotHi[s]! <= trackLo) continue
			any = true
			if (this.slotBlockValid[s] === 1) {
				p += this.slotP[s]!
				f += this.slotF[s]!
			} else allValid = false
			const k = this.kOfSlot(s)
			if (k > maxK) maxK = k
			if (this.slotBurst[s] !== 1) allBurst = false
			if (this.slotPassed[s] === 1) {
				passed = true
				const ps = this.slotPassedSample[s]!
				if (ps < passedSample) {
					passedSample = ps
					runStart = this.slotRunStart[s]!
				}
			}
		}
		if (!any) return this.writeIdle(out)
		const burst = allBurst
		const snr = allValid ? finiteSnr(p, f) : null
		out.state = passed ? "passed" : "pending"
		out.channelSnrDb = snr ?? Number.NEGATIVE_INFINITY
		out.passedSample = passed ? passedSample : null
		out.runStartSample = passed && Number.isFinite(runStart) ? runStart : null
		out.minDurationMs = burst
			? CHANNEL_GATE_BURST_MIN_DURATION_MS
			: CHANNEL_GATE_MIN_DURATION_MS
		out.kDb = Number.isFinite(maxK) ? maxK : this.kFallback()
		out.marginDb = burst ? CHANNEL_GATE_BURST_MARGIN_DB : CHANNEL_GATE_MARGIN_DB
		out.valid = snr !== null
		return out
	}

	/** Largest index whose lo is ≤ hz, or −1. Slots are sorted by lo. */
	private rightmostLo(hz: number): number {
		let lo = 0
		let hi = this.slotCount
		while (lo < hi) {
			const mid = (lo + hi) >>> 1
			if (this.slotLo[mid]! <= hz) lo = mid + 1
			else hi = mid
		}
		return lo - 1
	}

	kFor(rangeKey: string): number {
		// Pinned: kCh = 3 dB + offset, for every range, with no adaptation.
		if (this.pinnedOffset !== null) return CHANNEL_GATE_K_DB + this.pinnedOffset
		const retained = this.retained.get(rangeKey)
		if (retained) return retained.k
		return CHANNEL_GATE_K_DB
	}

	stats(): {
		slots: number
		coarsened: number
		maskedSkipped: number
		falseAlarms: number
	} {
		return {
			slots: this.slotCount,
			coarsened: this.coarsened,
			maskedSkipped: this.maskedSkipped,
			falseAlarms: this.falseAlarmCount,
		}
	}

	private window(): { lo: number; hi: number } {
		// Bin i is centred at centreHz + (i − bins/2)·binHz, so the centres
		// occupy [centre − bins/2·binHz, centre + bins/2·binHz).
		const half = (this.bins / 2) * this.binHz
		return { lo: this.centreHz - half, hi: this.centreHz + half }
	}

	private install(built: { drafts: Draft[]; coarsened: number } | null): void {
		if (built === null) {
			this.ranges = []
			this.slotCount = 0
			this.coarsened = 0
			this.span0 = 0
			this.span1 = 0
			this.maxSlotWidth = 0
			this.zeroSlots(0)
			return
		}
		const prevRanges = this.retained
		const prevSlots = this.snapshotSlots()
		const byKey = new Map<string, number>()
		const ranges: RangeState[] = []
		for (const d of built.drafts) {
			let idx = byKey.get(d.key)
			if (idx === undefined) {
				idx = ranges.length
				byKey.set(d.key, idx)
				const prev = prevRanges.get(d.key)
				ranges.push(
					prev
						? {
								key: d.key,
								mhz: 0,
								k: prev.k,
								fa5: prev.fa5,
								exp5: prev.exp5,
								min5: prev.min5,
								fa30: prev.fa30,
								exp30: prev.exp30,
								min30: prev.min30,
							}
						: {
								key: d.key,
								mhz: 0,
								k: CHANNEL_GATE_K_DB,
								fa5: 0,
								exp5: 0,
								min5: 0,
								fa30: 0,
								exp30: 0,
								min30: 0,
							},
				)
			}
			ranges[idx]!.mhz += d.mhz
		}
		for (const r of ranges) this.retained.set(r.key, r)
		const drafts = built.drafts
		const n = drafts.length
		// `gateInto` binary-searches `lo`. Layout order stays in `slotOrd`.
		const order = new Array<number>(n)
		for (let i = 0; i < n; i++) order[i] = i
		order.sort((a, b) => drafts[a]!.lo - drafts[b]!.lo || a - b)
		this.zeroSlots(n)
		const used = new Uint8Array(prevSlots.length)
		let span0 = this.bins
		let span1 = 0
		let maxWidth = 0
		for (let s = 0; s < n; s++) {
			const src = order[s]!
			const d = drafts[src]!
			this.slotLo[s] = d.lo
			this.slotHi[s] = d.hi
			this.slotCentre[s] = d.centre
			this.slotOrd[s] = src
			const width = d.hi - d.lo
			if (width > maxWidth) maxWidth = width
			const [b0, b1] = this.binSpan(d.lo, d.hi)
			this.slotBin0[s] = b0
			this.slotBin1[s] = b1
			this.slotRange[s] = byKey.get(d.key)!
			const burst = d.burst ? 1 : 0
			this.slotBurst[s] = burst
			const match = takeSlot(prevSlots, used, d.lo, d.hi, d.key, burst)
			if (match) this.copyRun(s, match)
			else this.clearRun(s)
			if (b1 > b0) {
				if (b0 < span0) span0 = b0
				if (b1 > span1) span1 = b1
			}
		}
		this.maxSlotWidth = maxWidth
		this.ranges = ranges
		this.slotCount = n
		this.coarsened = built.coarsened
		if (span1 > span0) {
			this.span0 = span0
			this.span1 = span1
		} else {
			this.span0 = 0
			this.span1 = 0
		}
	}

	private snapshotSlots(): SlotSnap[] {
		const n = this.slotCount
		const out: SlotSnap[] = []
		for (let s = 0; s < n; s++) {
			out.push({
				lo: this.slotLo[s]!,
				hi: this.slotHi[s]!,
				key: this.ranges[this.slotRange[s]!]?.key ?? "",
				burst: this.slotBurst[s]!,
				on: this.slotOn[s]!,
				running: this.slotRunning[s]!,
				passed: this.slotPassed[s]!,
				offs: this.slotOffs[s]!,
				onBlocks: this.slotOnBlocks[s]!,
				best: this.slotBest[s]!,
				snr: this.slotSnr[s]!,
				p: this.slotP[s]!,
				f: this.slotF[s]!,
				passedSample: this.slotPassedSample[s]!,
				runStart: this.slotRunStart[s]!,
			})
		}
		return out
	}

	private copyRun(s: number, snap: SlotSnap): void {
		this.slotOn[s] = snap.on
		this.slotRunning[s] = snap.running
		this.slotPassed[s] = snap.passed
		this.slotOffs[s] = snap.offs
		this.slotOnBlocks[s] = snap.onBlocks
		this.slotBest[s] = snap.best
		this.slotSnr[s] = snap.snr
		this.slotP[s] = snap.p
		this.slotF[s] = snap.f
		this.slotPassedSample[s] = snap.passedSample
		this.slotRunStart[s] = snap.runStart
	}

	private clearRun(s: number): void {
		this.slotBest[s] = Number.NEGATIVE_INFINITY
		this.slotSnr[s] = Number.NEGATIVE_INFINITY
		this.slotPassedSample[s] = Number.NaN
		this.slotRunStart[s] = Number.NaN
	}

	private zeroSlots(n: number): void {
		this.slotLo = new Float64Array(n)
		this.slotHi = new Float64Array(n)
		this.slotCentre = new Float64Array(n)
		this.slotBin0 = new Int32Array(n)
		this.slotBin1 = new Int32Array(n)
		this.slotRange = new Int32Array(n)
		this.slotBurst = new Uint8Array(n)
		this.slotOn = new Uint8Array(n)
		this.slotRunning = new Uint8Array(n)
		this.slotPassed = new Uint8Array(n)
		this.slotOffs = new Uint8Array(n)
		this.slotOnBlocks = new Int32Array(n)
		this.slotBest = new Float64Array(n)
		this.slotSnr = new Float64Array(n)
		this.slotP = new Float64Array(n)
		this.slotF = new Float64Array(n)
		this.slotBlockValid = new Uint8Array(n)
		this.slotPassedSample = new Float64Array(n)
		this.slotRunStart = new Float64Array(n)
		this.slotOrd = new Int32Array(n)
	}

	/** Bins whose centres lie in [lo, hi), clamped to the FFT. */
	private binSpan(lo: number, hi: number): [number, number] {
		const half = this.bins / 2
		const x0 = (lo - this.centreHz) / this.binHz + half
		const x1 = (hi - this.centreHz) / this.binHz + half
		const i0 = Math.max(0, Math.ceil(x0 - COUNT_SLACK))
		const i1 = Math.min(this.bins, Math.ceil(x1 - COUNT_SLACK))
		return i1 > i0 ? [i0, i1] : [i0, i0]
	}

	private pullElapsedMin(): number {
		if (this.nowFn === null) return this.blockMs / 60_000
		const t = this.nowFn()
		const prev = this.lastNow
		this.lastNow = t
		if (prev === null) return 0
		const d = t - prev
		return d > 0 ? d / 60_000 : 0
	}

	private updateSlot(s: number, sample: number): void {
		const i0 = this.slotBin0[s]!
		const i1 = this.slotBin1[s]!
		const total = i1 - i0
		if (total <= 0) return
		// Any unmeasurable unmasked bin fails the block closed. Masked bins are
		// not read, so a NaN under a mask does not by itself invalidate.
		const invalidCount = this.prefixI[i1]! - this.prefixI[i0]!
		if (invalidCount > 0) {
			this.invalidateSlot(s)
			return
		}
		const maskedCount = this.prefixM[i1]! - this.prefixM[i0]!
		// Masked fraction > 0.5: 2×masked > bins. 7/12 skips, 6/12 is tested.
		if (maskedCount * 2 > total) {
			this.maskedSkipped++
			return
		}
		const pSum = this.prefixP[i1]! - this.prefixP[i0]!
		const fSum = this.prefixF[i1]! - this.prefixF[i0]!
		const snr = pSum / fSum
		if (!(pSum > 0) || !(fSum > 0) || !(snr > 0) || !Number.isFinite(snr)) {
			this.invalidateSlot(s)
			return
		}
		this.slotP[s] = pSum
		this.slotF[s] = fSum
		this.slotSnr[s] = snr
		this.slotBlockValid[s] = 1

		const k = this.kOfSlot(s)
		const on = this.hysteresis(this.slotOn[s] === 1, snr, k)
		this.slotOn[s] = on ? 1 : 0
		if (this.slotRunning[s] !== 1) {
			if (!on) return
			this.slotRunning[s] = 1
			this.slotOnBlocks[s] = 1
			this.slotOffs[s] = 0
			this.slotBest[s] = snr
			this.slotRunStart[s] = sample
		} else if (on) {
			this.slotOnBlocks[s] = this.slotOnBlocks[s]! + 1
			if (snr > this.slotBest[s]!) this.slotBest[s] = snr
		} else if (this.slotOffs[s] === 0) {
			// One off block inside the run counts as on.
			this.slotOffs[s] = 1
			this.slotOnBlocks[s] = this.slotOnBlocks[s]! + 1
		} else {
			// A second off ends the run. A passed run is not a false alarm.
			this.endRun(s, this.slotPassed[s] !== 1)
			return
		}
		this.maybePass(s, sample, k)
	}

	private readonly thresholds = new Map<number, number>()

	private cacheThresholds(k: number): void {
		for (const db of [
			k,
			k - CHANNEL_GATE_HYSTERESIS_DB,
			k + CHANNEL_GATE_MARGIN_DB - MARGIN_SLACK_DB,
			k + CHANNEL_GATE_BURST_MARGIN_DB - MARGIN_SLACK_DB,
		])
			this.thresholds.set(db, Math.pow(10, db / 10))
	}

	private threshold(db: number): number {
		return this.thresholds.get(db)!
	}

	private atLeast(ratio: number, db: number, slackDb = 0): boolean {
		const threshold = this.threshold(db - slackDb)
		// Preserve the original log-domain decision at floating-point boundaries.
		// Elsewhere a linear comparison avoids log10 for slots no track reads.
		if (Math.abs(ratio - threshold) <= threshold * 1e-12)
			return 10 * Math.log10(ratio) + slackDb >= db
		return ratio >= threshold
	}

	private hysteresis(wasOn: boolean, snr: number, k: number): boolean {
		// On at snr ≥ kCh. Off below kCh − 1.5. The band in between holds.
		return this.atLeast(snr, wasOn ? k - CHANNEL_GATE_HYSTERESIS_DB : k)
	}

	private maybePass(s: number, sample: number, k: number): void {
		// The passing sample stays the block that first met the rule. The run
		// itself continues so one later off is still tolerated.
		if (this.slotPassed[s] === 1) return
		const burst = this.slotBurst[s] === 1
		// 300 ms = 6 × 50 ms; burst 100 ms = 2 × 50 ms.
		const minMs = burst
			? CHANNEL_GATE_BURST_MIN_DURATION_MS
			: CHANNEL_GATE_MIN_DURATION_MS
		// Margin 3 dB → pass at 6 dB; burst margin 6 dB → pass at 9 dB.
		const margin = burst ? CHANNEL_GATE_BURST_MARGIN_DB : CHANNEL_GATE_MARGIN_DB
		if (this.slotOnBlocks[s]! * this.blockMs < minMs) return
		if (!this.atLeast(this.slotBest[s]!, k + margin, MARGIN_SLACK_DB)) return
		this.slotPassed[s] = 1
		this.slotPassedSample[s] = sample
	}

	private endRun(s: number, countFalseAlarm: boolean): void {
		this.slotRunning[s] = 0
		this.slotOnBlocks[s] = 0
		this.slotOffs[s] = 0
		this.slotBest[s] = Number.NEGATIVE_INFINITY
		this.slotPassed[s] = 0
		this.slotPassedSample[s] = Number.NaN
		this.slotRunStart[s] = Number.NaN
		if (!countFalseAlarm) return
		this.falseAlarmCount++
		const r = this.ranges[this.slotRange[s]!]
		if (r) {
			r.fa5++
			r.fa30++
		}
	}

	private kOfSlot(s: number): number {
		if (this.pinnedOffset !== null) return CHANNEL_GATE_K_DB + this.pinnedOffset
		return this.ranges[this.slotRange[s]!]?.k ?? CHANNEL_GATE_K_DB
	}

	private adapt(elapsedMin: number): void {
		if (!(elapsedMin > 0)) return
		for (let i = 0; i < this.ranges.length; i++) {
			const r = this.ranges[i]!
			if (!(r.mhz > 0)) continue
			const exposure = r.mhz * elapsedMin
			r.min5 += elapsedMin
			r.min30 += elapsedMin
			r.exp5 += exposure
			r.exp30 += exposure
			const target = this.targets.get(r.key) ?? this.defaultTarget
			if (r.min5 >= CFAR_RAISE_WINDOW_MIN) {
				const rate = r.exp5 > 0 ? r.fa5 / r.exp5 : 0
				const cap = CHANNEL_GATE_K_DB + CFAR_MAX_RAISE_DB
				const noisy = rate > target * (1 + RATE_TOLERANCE)
				if (noisy && r.k < cap) r.k = Math.min(cap, r.k + CFAR_STEP_DB)
				// A noisy 5 min window clears the 30 min average, matching the detector.
				if (noisy) {
					r.fa30 = 0
					r.exp30 = 0
					r.min30 = 0
				}
				r.fa5 = 0
				r.exp5 = 0
				r.min5 = 0
			}
			if (r.min30 >= CFAR_LOWER_WINDOW_MIN) {
				const rate30 = r.exp30 > 0 ? r.fa30 / r.exp30 : 0
				if (rate30 < target / 4 && r.k > CHANNEL_GATE_K_DB) {
					r.k = Math.max(CHANNEL_GATE_K_DB, r.k - CFAR_STEP_DB)
				}
				r.fa30 = 0
				r.exp30 = 0
				r.min30 = 0
			}
		}
	}

	/** Ends a run in progress. Keeps the last finite SNR. Not a false alarm. */
	private invalidateSlot(s: number): void {
		if (this.slotRunning[s] === 1) this.endRun(s, false)
	}

	private writeSlot(s: number, out: ChannelGateReading): ChannelGateReading {
		const passed = this.slotPassed[s] === 1
		const snr =
			finiteSnr(this.slotP[s]!, this.slotF[s]!) ?? Number.NEGATIVE_INFINITY
		const runStart = this.slotRunStart[s]!
		const measured = this.slotBlockValid[s] === 1 && Number.isFinite(snr)
		const burst = this.slotBurst[s] === 1
		out.state = passed ? "passed" : "pending"
		out.channelSnrDb = measured ? snr : Number.NEGATIVE_INFINITY
		out.passedSample = passed ? this.slotPassedSample[s]! : null
		out.runStartSample = passed && Number.isFinite(runStart) ? runStart : null
		out.minDurationMs = burst
			? CHANNEL_GATE_BURST_MIN_DURATION_MS
			: CHANNEL_GATE_MIN_DURATION_MS
		out.kDb = this.kOfSlot(s)
		out.marginDb = burst ? CHANNEL_GATE_BURST_MARGIN_DB : CHANNEL_GATE_MARGIN_DB
		out.valid = measured
		return out
	}

	/** No covering slot. The slot run is not a track measurement. */
	private writeIdle(out: ChannelGateReading): ChannelGateReading {
		out.state = "pending"
		out.channelSnrDb = Number.NEGATIVE_INFINITY
		out.passedSample = null
		out.runStartSample = null
		out.minDurationMs = CHANNEL_GATE_MIN_DURATION_MS
		out.kDb = this.kFallback()
		out.marginDb = CHANNEL_GATE_MARGIN_DB
		out.valid = false
		return out
	}

	private kFallback(): number {
		if (this.pinnedOffset !== null) return CHANNEL_GATE_K_DB + this.pinnedOffset
		return CHANNEL_GATE_K_DB
	}
}

/** Finite 10·log10(p/f). Null when the ratio is not a finite dB value. */
function finiteSnr(p: number, f: number): number | null {
	if (!(p > 0) || !(f > 0)) return null
	const db = 10 * Math.log10(p / f)
	return Number.isFinite(db) ? db : null
}

/** Widths clamp to [6 250, 200 000] Hz. */
function clampWidth(hz: number): number {
	if (hz < CHANNEL_GATE_MIN_WIDTH_HZ) return CHANNEL_GATE_MIN_WIDTH_HZ
	if (hz > CHANNEL_GATE_MAX_WIDTH_HZ) return CHANNEL_GATE_MAX_WIDTH_HZ
	return hz
}

function stepsIn(span: number, step: number): number {
	if (!(span > 0) || !(step > 0)) return 0
	const n = Math.ceil(span / step - COUNT_SLACK)
	return n > 0 ? n : 0
}

function countRaster(
	start: number,
	end: number,
	first: number,
	step: number,
): number {
	if (!(step > 0) || !(end > start)) return 0
	const n = Math.ceil((start - first) / step - COUNT_SLACK)
	const last = Math.floor((end - first) / step - COUNT_SLACK)
	if (last < n) return 0
	return last - n + 1
}

function windowGaps(
	lo: number,
	hi: number,
	covered: { startHz: number; endHz: number }[],
): [number, number][] {
	const clipped: [number, number][] = []
	for (const e of covered) {
		const a = Math.max(e.startHz, lo)
		const b = Math.min(e.endHz, hi)
		if (b > a) clipped.push([a, b])
	}
	clipped.sort((a, b) => a[0] - b[0])
	const merged: [number, number][] = []
	for (const iv of clipped) {
		const last = merged[merged.length - 1]
		if (!last || iv[0] > last[1]) merged.push([iv[0], iv[1]])
		else if (iv[1] > last[1]) last[1] = iv[1]
	}
	const gaps: [number, number][] = []
	let cursor = lo
	for (const [a, b] of merged) {
		if (a > cursor) gaps.push([cursor, a])
		cursor = Math.max(cursor, b)
	}
	if (cursor < hi) gaps.push([cursor, hi])
	return gaps
}

interface SlotSnap {
	lo: number
	hi: number
	key: string
	burst: number
	on: number
	running: number
	passed: number
	offs: number
	onBlocks: number
	best: number
	snr: number
	p: number
	f: number
	passedSample: number
	runStart: number
}

function takeSlot(
	slots: SlotSnap[],
	used: Uint8Array,
	lo: number,
	hi: number,
	key: string,
	burst: number,
): SlotSnap | null {
	for (let i = 0; i < slots.length; i++) {
		if (used[i] === 1) continue
		const s = slots[i]!
		if (s.lo === lo && s.hi === hi && s.key === key && s.burst === burst) {
			used[i] = 1
			return s
		}
	}
	return null
}

interface GridFlags {
	slidingReducible: boolean
	rasterReducible: boolean
	total: number
}

function survey(
	plan: ChannelPlan,
	slideMul: number,
	rasterMul: number,
	win: { lo: number; hi: number },
): GridFlags {
	let total = 0
	let slidingReducible = false
	let rasterReducible = false
	for (const e of plan.entries) {
		const span = e.endHz - e.startHz
		if (!(span > 0)) continue
		if (isRaster(e)) {
			const n = countRaster(
				e.startHz,
				e.endHz,
				e.firstChannelHz!,
				e.rasterHz! * rasterMul,
			)
			total += n
			if (n > 1) rasterReducible = true
		} else {
			const step = (clampWidth(e.widthHz) / 2) * slideMul
			const n = stepsIn(span, step)
			total += n
			if (n > 1) slidingReducible = true
		}
	}
	const defW = clampWidth(plan.defaultWidthHz)
	for (const [a, b] of windowGaps(win.lo, win.hi, plan.entries)) {
		const step = (defW / 2) * slideMul
		const n = stepsIn(b - a, step)
		total += n
		if (n > 1) slidingReducible = true
	}
	return { slidingReducible, rasterReducible, total }
}

function isRaster(e: ChannelPlanEntry): boolean {
	return e.rasterHz !== null && e.firstChannelHz !== null && e.rasterHz > 0
}

/** Drop the part of each entry that lies outside the tuned window. */
function clipPlan(
	plan: ChannelPlan,
	win: { lo: number; hi: number },
): ChannelPlan {
	const entries: ChannelPlanEntry[] = []
	for (const e of plan.entries) {
		const startHz = Math.max(e.startHz, win.lo)
		const endHz = Math.min(e.endHz, win.hi)
		if (!(endHz > startHz)) continue
		entries.push({ ...e, startHz, endHz })
	}
	return {
		sourceId: plan.sourceId,
		defaultWidthHz: plan.defaultWidthHz,
		entries,
	}
}

function layoutPlan(
	plan: ChannelPlan,
	win: { lo: number; hi: number },
): { drafts: Draft[]; coarsened: number } {
	// Slots entirely outside the FFT window must not count or coarsen.
	const clipped = clipPlan(plan, win)
	// Past 4 096 slots, double the sliding step (then the raster step).
	// Each doubling that actually shrinks the grid increments `coarsened`.
	let slideMul = 1
	let rasterMul = 1
	let coarsened = 0
	let est = survey(clipped, slideMul, rasterMul, win)
	for (
		let guard = 0;
		est.total > CHANNEL_GATE_MAX_SLOTS && guard < 40;
		guard++
	) {
		let nextSlide = slideMul
		let nextRaster = rasterMul
		if (est.slidingReducible) nextSlide *= 2
		else if (est.rasterReducible) nextRaster *= 2
		else break
		const next = survey(clipped, nextSlide, nextRaster, win)
		if (next.total >= est.total) break
		slideMul = nextSlide
		rasterMul = nextRaster
		coarsened++
		est = next
	}
	// Hard bound before the oversized layout is kept. One slot per entry cannot
	// be shrunk by doubling, so duplicates are dropped and, if still over, the
	// whole layout becomes one sliding grid.
	if (est.total <= CHANNEL_GATE_MAX_SLOTS) {
		const drafts = materialize(clipped, slideMul, rasterMul, win)
		if (drafts.length <= CHANNEL_GATE_MAX_SLOTS) return { drafts, coarsened }
		const deduped = dropDuplicateSlots(drafts)
		if (deduped.length <= CHANNEL_GATE_MAX_SLOTS) {
			return { drafts: deduped, coarsened }
		}
		return fallbackGrid(plan, win, coarsened)
	}
	const deduped = dedupMaterialize(clipped, slideMul, rasterMul, win)
	if (deduped) return { drafts: deduped, coarsened }
	return fallbackGrid(plan, win, coarsened)
}

function slotGeometry(d: Draft): string {
	return `${d.lo}\0${d.hi}\0${d.burst ? 1 : 0}`
}

/** First slot with a given (lo, hi, rangeKey, burst) wins. */
function dropDuplicateSlots(drafts: Draft[]): Draft[] {
	const seen = new Map<string, Set<string>>()
	const out: Draft[] = []
	for (const d of drafts) {
		const geometry = slotGeometry(d)
		let keys = seen.get(geometry)
		if (!keys) {
			keys = new Set()
			seen.set(geometry, keys)
		}
		if (keys.has(d.key)) continue
		keys.add(d.key)
		out.push(d)
	}
	return out
}

/**
 * Same slots as materialize, stopping once a new identity would pass the cap.
 * Null means the unique set does not fit.
 */
function dedupMaterialize(
	plan: ChannelPlan,
	slideMul: number,
	rasterMul: number,
	win: { lo: number; hi: number },
): Draft[] | null {
	const drafts: Draft[] = []
	const seen = new Map<string, Set<string>>()
	const fit = forEachSlot(plan, slideMul, rasterMul, win, d => {
		const geometry = slotGeometry(d)
		let keys = seen.get(geometry)
		if (!keys) {
			keys = new Set()
			seen.set(geometry, keys)
		}
		if (keys.has(d.key)) return true
		if (drafts.length >= CHANNEL_GATE_MAX_SLOTS) return false
		keys.add(d.key)
		drafts.push(d)
		return true
	})
	return fit ? drafts : null
}

/**
 * One sliding grid over the tuned window. The replacement counts as a coarsen
 * when the default pitch already fits; each doubling of the half-width step
 * that is required to get under the cap counts as well.
 */
function fallbackGrid(
	plan: ChannelPlan,
	win: { lo: number; hi: number },
	coarsened: number,
): { drafts: Draft[]; coarsened: number } {
	const span = win.hi - win.lo
	if (!(span > 0)) return { drafts: [], coarsened }
	const width = clampWidth(plan.defaultWidthHz)
	let step = width / 2
	let n = stepsIn(span, step)
	let guard = 0
	while (n > CHANNEL_GATE_MAX_SLOTS && guard < 60) {
		const nextStep = step * 2
		if (!Number.isFinite(nextStep) || !(nextStep > step)) break
		const nextN = stepsIn(span, nextStep)
		if (!(nextN < n)) break
		step = nextStep
		n = nextN
		coarsened++
		guard++
	}
	const mhz = span / 1e6
	if (!(n >= 1) || n > CHANNEL_GATE_MAX_SLOTS) {
		coarsened++
		return {
			drafts: [
				{
					lo: win.lo,
					hi: win.lo + width,
					centre: win.lo + width / 2,
					key: DEFAULT_RANGE_KEY,
					burst: false,
					mhz,
				},
			],
			coarsened,
		}
	}
	if (guard === 0) coarsened++
	const drafts: Draft[] = []
	for (let i = 0; i < n; i++) {
		const lo = win.lo + i * step
		drafts.push({
			lo,
			hi: lo + width,
			centre: lo + width / 2,
			key: DEFAULT_RANGE_KEY,
			burst: false,
			mhz: i === 0 ? mhz : 0,
		})
	}
	return { drafts, coarsened }
}

function materialize(
	plan: ChannelPlan,
	slideMul: number,
	rasterMul: number,
	win: { lo: number; hi: number },
): Draft[] {
	const drafts: Draft[] = []
	forEachSlot(plan, slideMul, rasterMul, win, d => {
		drafts.push(d)
		return true
	})
	return drafts
}

/** False from `emit` stops the walk. The walk itself returns false when stopped. */
function forEachSlot(
	plan: ChannelPlan,
	slideMul: number,
	rasterMul: number,
	win: { lo: number; hi: number },
	emit: (d: Draft) => boolean,
): boolean {
	for (const e of plan.entries) {
		const span = e.endHz - e.startHz
		if (!(span > 0)) continue
		const width = clampWidth(e.widthHz)
		const mhz = span / 1e6
		if (isRaster(e)) {
			const step = e.rasterHz! * rasterMul
			const n0 = Math.ceil((e.startHz - e.firstChannelHz!) / step - COUNT_SLACK)
			const n1 = Math.floor((e.endHz - e.firstChannelHz!) / step - COUNT_SLACK)
			let firstSlot = true
			for (let n = n0; n <= n1; n++) {
				const c = e.firstChannelHz! + n * step
				if (c < e.startHz || c >= e.endHz) continue
				if (
					!emit({
						lo: c - width / 2,
						hi: c + width / 2,
						centre: c,
						key: e.rangeKey,
						burst: e.burst,
						mhz: firstSlot ? mhz : 0,
					})
				) {
					return false
				}
				firstSlot = false
			}
		} else {
			const step = (width / 2) * slideMul
			const n = stepsIn(span, step)
			for (let i = 0; i < n; i++) {
				const lo = e.startHz + i * step
				if (
					!emit({
						lo,
						hi: lo + width,
						centre: lo + width / 2,
						key: e.rangeKey,
						burst: e.burst,
						mhz: i === 0 ? mhz : 0,
					})
				) {
					return false
				}
			}
		}
	}
	const defW = clampWidth(plan.defaultWidthHz)
	for (const [a, b] of windowGaps(win.lo, win.hi, plan.entries)) {
		const step = (defW / 2) * slideMul
		const n = stepsIn(b - a, step)
		const mhz = (b - a) / 1e6
		for (let i = 0; i < n; i++) {
			const lo = a + i * step
			if (
				!emit({
					lo,
					hi: lo + defW,
					centre: lo + defW / 2,
					key: DEFAULT_RANGE_KEY,
					burst: false,
					mhz: i === 0 ? mhz : 0,
				})
			) {
				return false
			}
		}
	}
	return true
}
