import {
	dutyFromEnvelope,
	envelopeAcf,
	obwAtDb,
	spectralShape,
} from "./spectral-features.js"
import type {
	ObservationEndReason,
	PipelineEvent,
	TrackFlags,
	TrackSnapshot,
	TuningTrust,
} from "../types.js"
import type { Segment } from "./segmenter.js"
import type { PersistentFeature } from "../retune-alarm.js"
import { frameTrust } from "../retune-settle.js"
import type { ImageCandidate } from "./iq-image.js"
import type { TrackAssociation } from "../frame-tracks.js"
import {
	CHANNEL_GATE_HYSTERESIS_DB,
	CHANNEL_GATE_MIN_WIDTH_HZ,
} from "../../scanner/scanner-redesign-contract.js"

/**
 * Per-epoch emission tracks (spec §4.2, §6.2): matches each block's segments to open tracks by bin
 * overlap, keeps a 1 ms envelope (first 1 s) for the TDMA features, accumulates the mean PSD for
 * OBW and shape, and closes tracks after a hang, on a new epoch, on a long gap or at maxTrackMs.
 */
export interface TrackerOptions {
	sourceId: string
	binHz: number
	blockMs: number
	hangBlocks: number
	maxTracks: number
	maxTrackBlocks: number
	idPrefix: string
	/**
	 * Local floor: bins each side of a segment (after a 1-bin gap) whose median power
	 * is the segment's local floor. Absent or 0: no local SNR.
	 */
	localBins?: number
}

export interface TrackerBlock {
	endSample: number
	powerDb: Float32Array
	floorDb: Float32Array
	blockFloorDb: number
	thresholdDb: number
	gap: boolean
	overload: boolean
	/** Segments of this block that are short-path bursts (spec § 4.10). */
	burstSegments?: ReadonlySet<Segment>
}

interface EpochInfo {
	stream: number
	epoch: number
	centreHz: number
	tuningTrust: TuningTrust
	/** WG9 req 3.4: a track that starts before this sample is `unverified` (null: no window). */
	verifiedFromSample: number | null
}

const ENV_MAX_MS = 1000
const ACF_MIN_MS = 300
const SPEC_PAD_BINS = 2
const OBW_MIN_SNR_DB = 20
const MATCH_TOLERANCE_BINS = 1
const FIRST_UPDATE_BLOCKS = 2
/** Matched-window minimum (see `localSnr`): a Hann tone's two main-lobe bins. */
export const MATCHED_MIN_BINS = 2
/** Matched width: bins within 6 dB of the peak (a Hann tone's main lobe at its -6 dB points). */
export const MATCHED_DROP_DB = 6
/**
 * Support for a matched window: a bin counts toward the 2-bin minimum only at or above the local
 * floor plus this (dB). A Hann tone's second main-lobe bin is within 6 dB of its peak, so a tone
 * 9 dB or more over the floor has it; a lone hot bin's neighbours sit on the floor.
 */
export const MATCHED_SUPPORT_DB = 3

class SpectrumAccumulator {
	lo = 0
	hi = 0
	private sum = new Float64Array(0)
	private count = new Uint32Array(0)
	private mean = new Float32Array(0)

	add(powerDb: Float32Array, lo: number, hi: number): void {
		if (this.hi === this.lo) {
			this.lo = lo
			this.hi = hi
			this.sum = new Float64Array(hi - lo)
			this.count = new Uint32Array(hi - lo)
		} else if (lo < this.lo || hi > this.hi) {
			const nlo = Math.min(lo, this.lo)
			const nhi = Math.max(hi, this.hi)
			const sum = new Float64Array(nhi - nlo)
			const count = new Uint32Array(nhi - nlo)
			sum.set(this.sum, this.lo - nlo)
			count.set(this.count, this.lo - nlo)
			this.lo = nlo
			this.hi = nhi
			this.sum = sum
			this.count = count
		}
		for (let i = lo; i < hi; i++) {
			const j = i - this.lo
			this.sum[j] = (this.sum[j] ?? 0) + 10 ** ((powerDb[i] ?? -200) / 10)
			this.count[j] = (this.count[j] ?? 0) + 1
		}
	}

	/** Mean PSD in dB over the window; index 0 is bin `lo`. Reuses one buffer. */
	meanDb(): Float32Array {
		const n = this.hi - this.lo
		if (this.mean.length !== n) this.mean = new Float32Array(n)
		const out = this.mean
		for (let j = 0; j < n; j++) {
			const c = this.count[j] ?? 0
			out[j] =
				c > 0 ? 10 * Math.log10(Math.max((this.sum[j] ?? 0) / c, 1e-20)) : -200
		}
		return out
	}
}

const NO_GATE_EVENTS: PipelineEvent[] = []

interface Features {
	acf30?: number
	acf60?: number
	duty: number | null
}

/**
 * This block's channel measurement. The track runs R 2.3/2.4 on its own
 * sequence of these. `valid` false (invalid, skipped, or masked) ends the
 * run without passing. `channelSnrDb` is −Infinity in that case.
 */
interface GateReading {
	channelSnrDb: number
	/** Best single covering slot (absent: same as `channelSnrDb`). */
	peakChannelSnrDb?: number
	kDb: number
	marginDb: number
	minDurationMs: number
	valid: boolean
}

/** One step of a track's own gate run, for the property oracle. No hot-path alloc when unset. */
export interface GateTrace {
	trackId: string
	kind: "measure" | "off" | "invalid" | "reset" | "inherit"
	snr: number
	kDb: number
	marginDb: number
	minMs: number
	endSample: number
	gate: "pending" | "passed" | "below"
	passedSample: number | null
	on: boolean
	run: boolean
	offUsed: boolean
	onBlocks: number
	best: number
	/** Set on `inherit`. Null for every other step. */
	fromTrackId: string | null
}

interface OpenTrack {
	id: string
	epoch: EpochInfo
	openedAtBlock: number
	lastOnBlock: number
	startSample: number
	lastSample: number
	startBin: number
	endBin: number
	lastSeg: Segment
	onMin: number
	onMax: number
	maxWidthBins: number
	blocks: number
	misses: number
	peakDbfs: number
	maxBlockSnrDb: number
	bandLinSum: number
	/** Sum and count of per-block local SNRs (dB). */
	localSnrSum: number
	localSnrBlocks: number
	/**
	 * Admission only: the latest block's matched-window SNR (see `localSnr`), dB; NaN when
	 * not measured.
	 */
	matchedSnrDb: number
	floorLinSum: number
	floorDbSum: number
	centroidNum: number
	centroidDen: number
	thresholdDb: number
	spectrum: SpectrumAccumulator
	env: Float32Array
	envLen: number
	envOrigin: number
	envBucket: number
	envSum: number
	envFrames: number
	frozen: Features | null
	flags: TrackFlags
	flagsChanged: boolean
	justOpened: boolean
	/**
	 * WG11 req 5.1: the frame chain this track continues after a max-duration rollover (null: the
	 * track starts its chain). Frame-only state: never in a TrackSnapshot or a tracker event.
	 */
	chain: ChainBase | null
	/**
	 * Sticky verdict. `passed` stays for this track's life. Separate from the run.
	 */
	gate?: "pending" | "passed" | "below"
	channelSnrDb?: number
	/** Best single covering slot of the last measurement. */
	peakChannelSnrDb?: number
	gatePassedSample?: number
	/** Last measured step was on. The next on-test uses `gateRun`, not this. */
	gateOn: boolean
	/** The run is in progress. Stepped on every block, including after a pass. */
	gateRun: boolean
	/** Tolerated offs in this run. The next off ends it. */
	gateOffs: number
	gateOnBlocks: number
	/**
	 * Blocks of this run measured at snr >= k. Only these count toward the
	 * minimum on-time (DQ 1.8); hysteresis and tolerated-off blocks do not.
	 */
	gateStrongBlocks: number
	gateBest: number
	/** Latched once this run meets duration and margin. Cleared when the run ends. */
	gateQualified: boolean
	/** Block end on which `gateQualified` became true. NaN until then. */
	gateQualifiedSample: number
	gateK: number
	gateMargin: number
	gateMinMs: number
	/** This block's step already moved `gate` to `passed`. */
	gateJustPassed: boolean
	/** Block number `geomCentre` / `geomObw` were computed for. −1: none. */
	geomBlock: number
	geomCentre: number
	geomObw: number
	/** `blockNo` of the last gate step applied to this track. 0: none. */
	gateStamp: number
	/**
	 * The predecessor this track re-opened from on a max-duration rollover.
	 * Cleared once that predecessor's run has been considered. Never a new detection.
	 */
	rolloverFrom: OpenTrack | null
}

/**
 * The part of a frame chain before its current track (WG11 req 5.1): the chain's first tracker
 * id and start, and the predecessors' totals without the rollover block (that block is counted
 * by the current track, which re-opens on the same segment of the same block).
 */
interface ChainBase {
	id: string
	startSample: number
	blocks: number
	bandLinSum: number
	floorLinSum: number
	peakDbfs: number
	maxBlockSnrDb: number
	spur: boolean
	iqImage: boolean
}

export class Tracker {
	private open: OpenTrack[] = []
	private seq = 0
	private blockNo = 0
	private n = 0 // fft size, learned from the first frame or block
	private epoch: EpochInfo = {
		stream: 0,
		epoch: 0,
		centreHz: 0,
		tuningTrust: "unverified",
		verifiedFromSample: null,
	}
	private readonly updateEvery: number
	/**
	 * WG11 req 5.1: this block's segment → track decisions (matched, opened or re-opened at
	 * max-duration). Rebuilt by every `block()`; read by the pipeline's summary of that block.
	 */
	private readonly assoc = new Map<Segment, OpenTrack>()
	/** Gate fields are copied onto snapshots only while this is set. */
	private planActive = false
	/** Ids closed by the current `block()`, so their close events can be painted. */
	private readonly closedThisBlock = new Set<string>()
	/**
	 * Closed this block while observed, before this block's measurement.
	 * `publishGate` steps the run, then paints the close.
	 */
	private readonly closedObserved = new Map<string, OpenTrack>()
	/**
	 * Open tracks not observed this block. Stepped in `publishGate` once the
	 * block's measurement is known. An invalid measurement ends the run; a
	 * valid one is the tolerated off. Reused, not allocated per block.
	 */
	private readonly pendingOff: OpenTrack[] = []
	/** `endSample` of the block in progress. Off steps use it, not `lastSample`. */
	private blockEndSample = 0
	/** Reused by `obwWindow`. Callers read `a` and `e` before the next call. */
	private readonly obwSpan = { a: 0, e: 0 }
	private readonly gateReported = new Set<string>()
	private readonly gateExtra: PipelineEvent[] = []
	/** Set only by tests. Production leaves it null and allocates nothing. */
	private gateTrace: ((e: GateTrace) => void) | null = null
	/**
	 * The block about to run does not continue a run (a gap, a skipped block,
	 * an exclusion). Taken at the start of `block` so the rollover decision,
	 * which waits until that block is measured, still sees it.
	 */
	private gateBroken = false
	/** `gateBroken` as of the start of the current block. */
	private blockGateBreak = false

	constructor(private readonly opts: TrackerOptions) {
		this.updateEvery = Math.max(1, Math.round(1000 / opts.blockMs))
	}

	get openCount(): number {
		return this.open.length
	}

	beginEpoch(e: {
		stream: number
		epoch: number
		centreHz: number
		tuningTrust: TuningTrust
		verifiedFromSample?: number
	}): PipelineEvent[] {
		const events = this.closeAll("retune")
		this.epoch = {
			stream: e.stream,
			epoch: e.epoch,
			centreHz: e.centreHz,
			tuningTrust: e.tuningTrust,
			verifiedFromSample: e.verifiedFromSample ?? null,
		}
		return events
	}

	frame(framePowerDb: Float32Array, sample: number): void {
		this.n = framePowerDb.length
		const samplesPerMs = (this.opts.binHz * framePowerDb.length) / 1000
		for (const t of this.open) {
			if (t.frozen) continue
			let sum = 0
			for (let i = t.startBin; i < t.endBin; i++)
				sum += 10 ** ((framePowerDb[i] ?? -200) / 10)
			if (t.envOrigin < 0) t.envOrigin = sample
			const bucket = Math.floor((sample - t.envOrigin) / samplesPerMs)
			if (bucket !== t.envBucket) this.flushEnvelope(t, bucket)
			if (t.frozen) continue
			t.envSum += sum
			t.envFrames++
		}
	}

	/** Turns gate fields on or off. Clearing the plan drops them from open tracks. */
	setGatePlan(active: boolean): void {
		if (this.planActive && !active) {
			for (const t of this.open) {
				delete t.gate
				delete t.channelSnrDb
				delete t.peakChannelSnrDb
				delete t.gatePassedSample
				this.clearGateRun(t)
				t.rolloverFrom = null
			}
			this.closedObserved.clear()
			this.pendingOff.length = 0
		}
		this.planActive = active
	}

	/** Test hook. `null` restores the production path, which does not allocate. */
	setGateTrace(fn: ((e: GateTrace) => void) | null): void {
		this.gateTrace = fn
	}

	/**
	 * The next `block` does not continue a run across a gap or a skipped
	 * block. A max-duration successor on that block starts fresh.
	 */
	noteGateBreak(): void {
		this.gateBroken = true
	}

	/**
	 * Drops every open track's in-progress run. A track that already passed
	 * stays passed. kCh is not here; the channel gate keeps that.
	 */
	resetGateRuns(): void {
		if (!this.planActive) return
		for (const t of this.open) {
			this.clearGateRun(t)
			this.trace(
				t,
				"reset",
				Number.NEGATIVE_INFINITY,
				t.gateK,
				t.gateMargin,
				t.gateMinMs,
				t.lastSample,
			)
		}
	}

	/** Applies one measurement to an open track. A no-op until a plan is set. */
	setGate(id: string, reading: GateReading): void {
		if (!this.planActive) return
		const t = this.open.find(o => o.id === id)
		if (t === undefined) return
		this.stepReading(t, reading, t.lastSample)
	}

	/**
	 * Steps every track observed this block on its own measurement, then paints
	 * the block's events. A miss waits until that measurement is known: invalid
	 * ends the run, valid counts as off. `from` is the first event index that
	 * belongs to this block. Returns a track-update for each track that became
	 * `passed` without one yet.
	 */
	publishGate(
		gateOf: (centreHz: number, obwHz: number) => GateReading,
		events: PipelineEvent[],
		from: number,
		measure = true,
	): PipelineEvent[] {
		if (!this.planActive) return NO_GATE_EVENTS
		if (
			this.open.length === 0 &&
			this.closedThisBlock.size === 0 &&
			this.pendingOff.length === 0
		)
			return NO_GATE_EVENTS
		this.gateReported.clear()
		this.gateExtra.length = 0
		// The close snapshot was built before this measurement. Step misses
		// now that the block is known, then tracks that were on. A rollover
		// copies the predecessor's run only after that step, and only while
		// the run is still alive. A gap or a fully excluded block does not
		// measure (`measure` false): the run was reset and the miss is not an off.
		const end = this.blockEndSample
		for (const t of this.pendingOff) {
			if (t.gateStamp === this.blockNo) continue
			if (measure) this.stepDeferredOff(t, gateOf, end)
			else this.stepOff(t, end)
		}
		if (measure) {
			for (const t of this.closedObserved.values()) {
				if (t.lastOnBlock !== this.blockNo || t.gateStamp === this.blockNo)
					continue
				this.stepObserved(t, gateOf)
			}
		}
		for (const t of this.open) {
			const prev = t.rolloverFrom
			if (prev === null) continue
			// The predecessor was stepped above. Copy the run only if that
			// step left it alive and this block is not a gate break. The
			// sticky verdict is never copied.
			// The successor's own channel must also measure valid on this block:
			// its geometry can differ from the predecessor's cumulative one.
			if (
				prev.gateRun &&
				!this.blockGateBreak &&
				measure &&
				this.measuresValid(t, gateOf)
			)
				this.inheritRun(prev, t)
			else if (
				measure &&
				t.lastOnBlock === this.blockNo &&
				t.gateStamp !== this.blockNo
			)
				this.stepObserved(t, gateOf)
			t.rolloverFrom = null
		}
		if (measure) {
			for (const t of this.assoc.values()) {
				if (t.lastOnBlock !== this.blockNo || t.gateStamp === this.blockNo)
					continue
				this.stepObserved(t, gateOf)
			}
		}
		for (const t of this.closedObserved.values()) {
			if (t.gate !== "passed") t.gate = "below"
		}
		for (let i = from; i < events.length; i++) {
			const e = events[i]
			if (
				e === undefined ||
				(e.kind !== "track-open" &&
					e.kind !== "track-update" &&
					e.kind !== "track-close")
			)
				continue
			const live = this.liveById(e.track.trackId)
			if (live !== undefined) {
				this.paintLive(e.track, live)
				this.gateReported.add(live.id)
				continue
			}
			if (
				e.kind === "track-close" &&
				this.closedThisBlock.has(e.track.trackId)
			) {
				const remembered = this.closedObserved.get(e.track.trackId)
				if (remembered !== undefined) this.paintLive(e.track, remembered)
				else {
					const missed = this.pendingOffById(e.track.trackId)
					if (missed !== undefined) {
						if (missed.gate !== "passed") missed.gate = "below"
						this.paintLive(e.track, missed)
					} else this.paintStoredClose(e.track)
				}
			}
		}
		for (const t of this.open) {
			if (!t.gateJustPassed) continue
			t.gateJustPassed = false
			if (this.gateReported.has(t.id)) continue
			const track = this.snapshotOf(t.id)
			if (track) this.gateExtra.push({ kind: "track-update", track })
		}
		for (const t of this.closedObserved.values()) t.gateJustPassed = false
		return this.gateExtra
	}

	block(segments: Segment[], b: TrackerBlock): PipelineEvent[] {
		this.closedThisBlock.clear()
		this.closedObserved.clear()
		this.pendingOff.length = 0
		this.blockEndSample = b.endSample
		this.blockGateBreak = this.gateBroken
		this.gateBroken = false
		this.blockNo++
		this.n = b.floorDb.length
		const n = b.floorDb.length
		const blockSamples = Math.round(
			(this.opts.blockMs * this.opts.binHz * n) / 1000,
		)
		const events: PipelineEvent[] = []
		const matched = new Set<OpenTrack>()
		this.assoc.clear()
		const order = segments
			.map((_, i) => i)
			.sort((x, y) => (segments[y]?.peakDb ?? 0) - (segments[x]?.peakDb ?? 0))
		for (const idx of order) {
			const s = segments[idx]
			if (s === undefined) continue
			const t = this.bestMatch(s, matched)
			if (t) {
				matched.add(t)
				this.extend(t, s, b, n)
				this.assoc.set(s, t)
				continue
			}
			if (b.gap) continue
			if (s.flags.truncated || this.open.length >= this.opts.maxTracks) {
				events.push({
					kind: "transient",
					centreHz: this.rf(s.centroidBin, n),
					epoch: this.epoch.epoch,
					sample: b.endSample - blockSamples,
				})
				continue
			}
			const nt = this.openTrack(s, b, n, blockSamples)
			matched.add(nt)
			this.assoc.set(s, nt)
			events.push({ kind: "track-open", track: this.snapshot(nt, n) })
		}
		for (const t of [...this.open]) {
			if (matched.has(t)) continue
			t.misses++
			// Not observed. The off waits for this block's measurement: a masked
			// or non-finite block ends the run, and only a valid one can pass.
			if (this.planActive) this.pendingOff.push(t)
			if (t.misses >= this.opts.hangBlocks)
				events.push(this.close(t, b.gap ? "gap" : "quiet", n))
		}
		for (const t of matched) {
			if (t.justOpened) {
				t.justOpened = false
				continue
			}
			if (this.blockNo - t.openedAtBlock + 1 >= this.opts.maxTrackBlocks) {
				const seg = t.lastSeg
				events.push(this.close(t, "max-duration", n))
				const nt = this.openTrack(seg, b, n, blockSamples)
				nt.justOpened = false
				nt.chain = chainBaseOf(t, nt)
				// `publishGate` steps this block on the predecessor, then copies
				// the run only if it is still alive.
				// Only gating reads the predecessor; without a plan keep no reference.
				if (this.planActive) nt.rolloverFrom = t
				// the segment now belongs to the successor (same block, fresh id)
				if (this.assoc.get(seg) === t) this.assoc.set(seg, nt)
				events.push({ kind: "track-open", track: this.snapshot(nt, n) })
				continue
			}
			if (
				t.blocks === FIRST_UPDATE_BLOCKS ||
				t.blocks % this.updateEvery === 0 ||
				t.flagsChanged
			) {
				t.flagsChanged = false
				events.push({ kind: "track-update", track: this.snapshot(t, n) })
			}
		}
		return events
	}

	/**
	 * WG11 req 5.1: the tracker's own decision for `s` in the last `block()` (no geometry): the
	 * associated track's state as of now, or null for a segment it did not associate (a gap
	 * block, a transient, a segment of an earlier block). Call before the next `block()`.
	 */
	associationOf(s: Segment): TrackAssociation | null {
		const t = this.assoc.get(s)
		if (t === undefined || t.lastOnBlock !== this.blockNo) return null
		const c = chainTotalsOf(t)
		const out: TrackAssociation = {
			trackId: c.id,
			trackerId: t.id,
			snrDb: snrDbOf(c.bandLinSum, c.floorLinSum, c.blocks),
			peakDbfs: c.peakDbfs,
			blocks: c.blocks,
			startSample: c.startSample,
			lastSample: t.lastSample,
			maxBlockSnrDb: c.maxBlockSnrDb,
			thresholdDb: t.thresholdDb,
			spur: c.spur,
			iqImage: c.iqImage,
			burst: t.flags.burst,
		}
		// Frames carry the open-track gate only (R 2.6). `below` is a close state
		// and stays on the snapshot. No plan: both keys stay absent.
		if (t.gate === "pending" || t.gate === "passed") out.gate = t.gate
		if (t.channelSnrDb !== undefined && Number.isFinite(t.channelSnrDb))
			out.channelSnrDb = t.channelSnrDb
		return out
	}

	closeAll(reason: ObservationEndReason): PipelineEvent[] {
		const events: PipelineEvent[] = []
		for (const t of [...this.open]) events.push(this.close(t, reason, this.n))
		return events
	}

	/** Sets 1 on the current bins of open tracks with ≥ minBlocks on-blocks that were on in the last block. */
	trackBinsMask(out: Uint8Array, minBlocks: number): void {
		out.fill(0)
		for (const t of this.open) {
			if (t.blocks < minBlocks || t.misses > 0) continue
			for (let i = t.startBin; i < t.endBin; i++) out[i] = 1
		}
	}

	/** Open, non-burst tracks that were on in the last block and have been open ≥ minSamples (spec § 4.7). */
	longLived(minSamples: number): (Pick<
		PersistentFeature,
		"rfHz" | "widthHz"
	> & {
		trackId: string
		startBin: number
		endBin: number
		ageSamples: number
	})[] {
		const out: ReturnType<Tracker["longLived"]> = []
		for (const t of this.open) {
			if (
				t.misses > 0 ||
				t.flags.burst ||
				t.flags.iqImage ||
				t.lastSample - t.startSample < minSamples
			)
				continue
			out.push({
				trackId: t.id,
				startBin: t.lastSeg.startBin,
				endBin: t.lastSeg.endBin,
				ageSamples: t.lastSample - t.startSample,
				rfHz: this.rf(this.centroidBin(t), this.n, t.epoch.centreHz),
				widthHz: (t.endBin - t.startBin) * this.opts.binHz,
			})
		}
		return out
	}

	/** Open, non-burst tracks on in the last block, with the −6 dB OBW of their mean spectrum (spec § 4.9). */
	openCandidates(): ImageCandidate[] {
		const out: ImageCandidate[] = []
		for (const t of this.open) {
			if (t.misses > 0 || t.flags.burst) continue
			const mean = t.spectrum.meanDb()
			const { a, e } = this.obwWindow(t, mean)
			out.push({
				trackId: t.id,
				centreHz: this.rf(this.centroidBin(t), this.n, t.epoch.centreHz),
				obwHz: obwAtDb(mean, a, e, this.opts.binHz, 6),
				peakDbfs: t.peakDbfs,
			})
		}
		return out
	}

	/** Sets a sticky flag on open tracks; returns the ids that were newly flagged. */
	raiseFlag(ids: ReadonlySet<string>, flag: "iqImage"): string[] {
		const raised: string[] = []
		for (const t of this.open) {
			if (!ids.has(t.id) || t.flags[flag]) continue
			t.flags[flag] = true
			raised.push(t.id)
		}
		return raised
	}

	snapshotOf(trackId: string): TrackSnapshot | undefined {
		const t = this.open.find(o => o.id === trackId)
		return t ? this.snapshot(t, this.n) : undefined
	}

	/**
	 * Raises the sticky `spur` flag (spec § 4.9, Task 7a) on open tracks whose current bins all lie on
	 * a spur line and returns their updates. Their segments are dropped from now on, so they close after the hang.
	 */
	flagSpurs(lineMask: Uint8Array): PipelineEvent[] {
		const events: PipelineEvent[] = []
		for (const t of this.open) {
			if (t.flags.spur || t.endBin <= t.startBin) continue
			let inside = true
			for (let i = t.startBin; i < t.endBin && inside; i++)
				inside = lineMask[i] === 1
			if (!inside) continue
			t.flags.spur = true
			events.push({ kind: "track-update", track: this.snapshot(t, this.n) })
		}
		return events
	}

	private bestMatch(
		s: Segment,
		taken: ReadonlySet<OpenTrack>,
	): OpenTrack | undefined {
		let best: OpenTrack | undefined
		let bestOverlap = 0
		for (const t of this.open) {
			if (taken.has(t)) continue
			const overlap =
				Math.min(s.endBin + MATCH_TOLERANCE_BINS, t.endBin) -
				Math.max(s.startBin - MATCH_TOLERANCE_BINS, t.startBin)
			if (overlap > bestOverlap) {
				bestOverlap = overlap
				best = t
			}
		}
		return best
	}

	private openTrack(
		s: Segment,
		b: TrackerBlock,
		n: number,
		blockSamples: number,
	): OpenTrack {
		const t: OpenTrack = {
			id: `${this.opts.idPrefix}${(++this.seq).toString(36)}`,
			epoch: { ...this.epoch },
			openedAtBlock: this.blockNo,
			lastOnBlock: this.blockNo,
			startSample: b.endSample - blockSamples,
			lastSample: b.endSample,
			startBin: s.startBin,
			endBin: s.endBin,
			lastSeg: s,
			onMin: s.startBin,
			onMax: s.endBin,
			maxWidthBins: 0,
			blocks: 0,
			misses: 0,
			peakDbfs: -Infinity,
			maxBlockSnrDb: -Infinity,
			bandLinSum: 0,
			localSnrSum: 0,
			localSnrBlocks: 0,
			matchedSnrDb: Number.NaN,
			floorLinSum: 0,
			floorDbSum: 0,
			centroidNum: 0,
			centroidDen: 0,
			thresholdDb: b.thresholdDb,
			spectrum: new SpectrumAccumulator(),
			env: new Float32Array(ENV_MAX_MS),
			envLen: 0,
			envOrigin: -1,
			envBucket: 0,
			envSum: 0,
			envFrames: 0,
			frozen: null,
			flags: {
				overload: false,
				gap: false,
				truncated: false,
				edge: false,
				skirt: false,
				obwBiased: false,
				spur: false,
				burst: false,
				iqImage: false,
			},
			flagsChanged: false,
			justOpened: true,
			chain: null,
			geomBlock: -1,
			geomCentre: 0,
			geomObw: 0,
			gateOn: false,
			gateRun: false,
			gateOffs: 0,
			gateOnBlocks: 0,
			gateStrongBlocks: 0,
			gateBest: Number.NEGATIVE_INFINITY,
			gateQualified: false,
			gateQualifiedSample: Number.NaN,
			gateK: 0,
			gateMargin: 0,
			gateMinMs: 0,
			gateJustPassed: false,
			gateStamp: 0,
			rolloverFrom: null,
		}
		this.open.push(t)
		this.extend(t, s, b, n)
		if (this.planActive) t.gate = "pending"
		t.flagsChanged = false
		return t
	}

	private extend(t: OpenTrack, s: Segment, b: TrackerBlock, n: number): void {
		t.startBin = s.startBin
		t.endBin = s.endBin
		t.lastSeg = s
		t.blocks++
		t.misses = 0
		t.lastOnBlock = this.blockNo
		t.lastSample = b.endSample
		t.thresholdDb = b.thresholdDb
		let band = 0
		let floor = 0
		let maxSnr = -Infinity
		for (let i = s.startBin; i < s.endBin; i++) {
			const p = b.powerDb[i] ?? -200
			const f = b.floorDb[i] ?? -200
			band += 10 ** (p / 10)
			floor += 10 ** (f / 10)
			maxSnr = Math.max(maxSnr, p - f)
		}
		t.bandLinSum += band
		const local = this.localSnr(t, s, b.powerDb, band)
		if (local !== null) {
			t.localSnrSum += local
			t.localSnrBlocks++
		}
		t.floorLinSum += floor
		t.floorDbSum += b.blockFloorDb
		t.peakDbfs = Math.max(t.peakDbfs, s.peakDb)
		t.maxBlockSnrDb = Math.max(t.maxBlockSnrDb, maxSnr)
		const weight = Math.max(band - floor, 1e-30)
		t.centroidNum += s.centroidBin * weight
		t.centroidDen += weight
		t.onMin = Math.min(t.onMin, s.startBin)
		t.onMax = Math.max(t.onMax, s.endBin)
		t.maxWidthBins = Math.max(t.maxWidthBins, s.endBin - s.startBin)
		t.spectrum.add(
			b.powerDb,
			Math.max(0, s.startBin - SPEC_PAD_BINS),
			Math.min(n, s.endBin + SPEC_PAD_BINS),
		)
		this.raise(t, "overload", b.overload)
		this.raise(t, "gap", b.gap)
		this.raise(t, "truncated", s.flags.truncated)
		this.raise(t, "edge", s.flags.edge)
		this.raise(t, "skirt", s.flags.skirt)
		// Burst is AND over the track's blocks: one continuous block makes it an ordinary track.
		const isBurst = b.burstSegments?.has(s) ?? false
		const wasBurst = t.flags.burst
		t.flags.burst = t.blocks === 1 ? isBurst : wasBurst && isBurst
		if (wasBurst && !t.flags.burst) t.flagsChanged = true
	}

	private raise(t: OpenTrack, flag: keyof TrackFlags, value: boolean): void {
		if (!value || t.flags[flag]) return
		t.flags[flag] = true
		t.flagsChanged = true
	}

	private flushEnvelope(t: OpenTrack, nextBucket: number): void {
		if (t.envFrames > 0) {
			const value = t.envSum / t.envFrames
			const until = Math.min(Math.max(nextBucket, t.envLen + 1), ENV_MAX_MS)
			for (let i = t.envLen; i < until; i++) t.env[i] = value
			t.envLen = until
			if (t.envLen >= ENV_MAX_MS) t.frozen = this.features(t)
		}
		t.envSum = 0
		t.envFrames = 0
		t.envBucket = nextBucket
	}

	private features(t: OpenTrack): Features {
		if (t.frozen) return t.frozen
		const env = t.env.subarray(0, t.envLen)
		const f: Features = { duty: dutyFromEnvelope(env) }
		if (t.envLen >= ACF_MIN_MS) {
			f.acf30 = envelopeAcf(env, 30)
			f.acf60 = envelopeAcf(env, 60)
		}
		return f
	}

	private rf(bin: number, n: number, centreHz = this.epoch.centreHz): number {
		return centreHz + (bin - n / 2) * this.opts.binHz
	}

	/** Power-weighted mean bin over the track's blocks (the current span's middle before any weight). */
	private centroidBin(t: OpenTrack): number {
		return t.centroidDen > 0
			? t.centroidNum / t.centroidDen
			: (t.startBin + t.endBin - 1) / 2
	}

	/** The OBW/shape window over `mean` (index 0 = bin `spectrum.lo`): the on-bins ± 1. */
	private obwWindow(
		t: OpenTrack,
		mean: Float32Array,
	): { a: number; e: number } {
		const span = this.obwSpan
		span.a = Math.max(0, t.onMin - 1 - t.spectrum.lo)
		span.e = Math.min(mean.length, t.onMax + 1 - t.spectrum.lo)
		return span
	}

	private close(
		t: OpenTrack,
		reason: ObservationEndReason,
		n: number,
	): PipelineEvent {
		if (this.planActive) {
			this.closedThisBlock.add(t.id)
			// Still on this block and not yet measured: `publishGate` steps it,
			// then paints over this snapshot. A miss is stepped there too, once
			// the measurement is known. Never-passed is `below` on the snapshot
			// now, so a close that never reaches `publishGate` (gap, retune,
			// plan-less epoch) still reports below. A later pass overwrites it.
			if (t.lastOnBlock === this.blockNo && t.gateStamp !== this.blockNo)
				this.closedObserved.set(t.id, t)
			if (t.gate !== "passed") t.gate = "below"
		}
		this.open = this.open.filter(o => o !== t)
		return {
			kind: "track-close",
			track: this.snapshot(t, n),
			endReason: reason,
		}
	}

	/** 1e-6 dB so an exact margin still passes, matching the slot run. */
	private static readonly MARGIN_SLACK_DB = 1e-6

	private clearGateRun(t: OpenTrack): void {
		t.gateOn = false
		t.gateRun = false
		t.gateOffs = 0
		t.gateOnBlocks = 0
		t.gateStrongBlocks = 0
		t.gateBest = Number.NEGATIVE_INFINITY
		t.gateQualified = false
		t.gateQualifiedSample = Number.NaN
	}

	/** On at snr ≥ k, or at snr ≥ k − 1.5 while the run is alive. */
	private isOn(alive: boolean, snr: number, k: number): boolean {
		if (snr >= k) return true
		return alive && snr >= k - CHANNEL_GATE_HYSTERESIS_DB
	}

	/**
	 * One observed measurement. Copies the reading's scalars before return:
	 * the caller reuses the reading object.
	 */
	private measuresValid(
		t: OpenTrack,
		gateOf: (centreHz: number, obwHz: number) => GateReading,
	): boolean {
		this.ensureGeometry(t)
		const reading = gateOf(t.geomCentre, t.geomObw)
		return reading.valid && Number.isFinite(reading.channelSnrDb)
	}

	private stepObserved(
		t: OpenTrack,
		gateOf: (centreHz: number, obwHz: number) => GateReading,
	): void {
		this.ensureGeometry(t)
		const reading = gateOf(t.geomCentre, t.geomObw)
		this.stepReading(t, reading, t.lastSample)
	}

	/**
	 * One measurement. Copies the reading's scalars before return: the caller
	 * reuses the reading object.
	 */
	private stepReading(
		t: OpenTrack,
		reading: GateReading,
		endSample: number,
	): void {
		const snr = reading.channelSnrDb
		const k = reading.kDb
		const margin = reading.marginDb
		const minMs = reading.minDurationMs
		const valid = reading.valid && Number.isFinite(snr)
		t.gateStamp = this.blockNo
		if (!valid) {
			this.clearGateRun(t)
			if (t.gate !== "passed") t.gate = "pending"
			this.trace(t, "invalid", snr, k, margin, minMs, endSample)
			return
		}
		t.channelSnrDb = snr
		// Admission reads the highest of the slot SNR, the best covering slot and the
		// matched-window SNR of this block; the gate's own pass rule reads `snr` only.
		const peak = reading.peakChannelSnrDb
		let best = snr
		if (peak !== undefined && Number.isFinite(peak) && peak > best) best = peak
		if (Number.isFinite(t.matchedSnrDb) && t.matchedSnrDb > best)
			best = t.matchedSnrDb
		t.peakChannelSnrDb = best
		if (t.gate === undefined) t.gate = "pending"
		this.stepAlive(t, snr, k, margin, minMs, true, endSample)
	}

	/**
	 * A block this track was not observed on, once its measurement is known.
	 * Invalid ends the run without passing. Valid counts as off, and only
	 * that off can complete a pass.
	 */
	private stepDeferredOff(
		t: OpenTrack,
		gateOf: (centreHz: number, obwHz: number) => GateReading,
		endSample: number,
	): void {
		this.ensureGeometry(t)
		const reading = gateOf(t.geomCentre, t.geomObw)
		const snr = reading.channelSnrDb
		const k = reading.kDb
		const margin = reading.marginDb
		const minMs = reading.minDurationMs
		const valid = reading.valid && Number.isFinite(snr)
		if (!valid) {
			t.gateStamp = this.blockNo
			this.clearGateRun(t)
			if (t.gate !== "passed") t.gate = "pending"
			this.trace(t, "invalid", snr, k, margin, minMs, endSample)
			return
		}
		this.stepOff(t, endSample)
	}

	/**
	 * Counts as off. `stepDeferredOff` uses it for a valid miss. A block that
	 * was not measured calls it too; a reset has usually already ended the run.
	 */
	private stepOff(t: OpenTrack, endSample: number): void {
		t.gateStamp = this.blockNo
		if (t.gate === undefined) t.gate = "pending"
		this.stepAlive(
			t,
			Number.NEGATIVE_INFINITY,
			t.gateK,
			t.gateMargin,
			t.gateMinMs,
			false,
			endSample,
		)
	}

	/**
	 * One step of the run. An observed block is on at snr ≥ k, or at
	 * snr ≥ k − 1.5 while the run is alive. Anything else valid is off: the
	 * first off in a living run is tolerated, the next ends it. An unobserved
	 * block is an off even when its SNR would have been on. Passing does not
	 * stop the run; `qualified` clears only when the run ends.
	 */
	private stepAlive(
		t: OpenTrack,
		snr: number,
		k: number,
		margin: number,
		minMs: number,
		observed: boolean,
		endSample: number,
	): void {
		const on = observed && this.isOn(t.gateRun, snr, k)
		if (on) {
			if (!t.gateRun) {
				t.gateRun = true
				t.gateOffs = 0
				t.gateOnBlocks = 0
				t.gateStrongBlocks = 0
				t.gateBest = Number.NEGATIVE_INFINITY
				t.gateQualified = false
				t.gateQualifiedSample = Number.NaN
			}
			t.gateOn = true
			t.gateOnBlocks++
			if (snr >= k) t.gateStrongBlocks++
			if (snr > t.gateBest) t.gateBest = snr
			t.gateK = k
			t.gateMargin = margin
			t.gateMinMs = minMs
		} else if (t.gateRun && t.gateOffs === 0) {
			t.gateOn = false
			t.gateOffs = 1
			t.gateOnBlocks++
		} else {
			this.clearGateRun(t)
			if (t.gate !== "passed") t.gate = "pending"
			this.trace(
				t,
				observed ? "measure" : "off",
				observed ? snr : Number.NEGATIVE_INFINITY,
				k,
				margin,
				minMs,
				endSample,
			)
			return
		}
		this.noteQualified(t, endSample)
		this.grantPass(t, endSample)
		this.trace(
			t,
			observed ? "measure" : "off",
			observed ? snr : Number.NEGATIVE_INFINITY,
			k,
			margin,
			minMs,
			endSample,
		)
	}

	/** Latches `gateQualified` for this run. A later block does not clear it. */
	private noteQualified(t: OpenTrack, endSample: number): void {
		if (!t.gateRun || t.gateQualified) return
		if (t.gateStrongBlocks * this.opts.blockMs < t.gateMinMs) return
		if (t.gateBest + Tracker.MARGIN_SLACK_DB < t.gateK + t.gateMargin) return
		t.gateQualified = true
		t.gateQualifiedSample = endSample
	}

	/** The sticky verdict. The first qualified block of this track passes it. */
	private grantPass(t: OpenTrack, endSample: number): void {
		if (t.gate === "passed") return
		if (!t.gateQualified) {
			t.gate = "pending"
			return
		}
		t.gate = "passed"
		t.gatePassedSample = endSample
		t.gateJustPassed = true
	}

	/**
	 * Copies the predecessor's run after the rollover block's step. The
	 * successor passes only when that run is qualified, at the later of its
	 * own start and the block that qualified the run.
	 */
	private inheritRun(prev: OpenTrack, next: OpenTrack): void {
		if (!this.planActive) return
		next.gateOn = prev.gateOn
		next.gateRun = prev.gateRun
		next.gateOffs = prev.gateOffs
		next.gateOnBlocks = prev.gateOnBlocks
		next.gateStrongBlocks = prev.gateStrongBlocks
		next.gateBest = prev.gateBest
		next.gateK = prev.gateK
		next.gateMargin = prev.gateMargin
		next.gateMinMs = prev.gateMinMs
		next.gateQualified = prev.gateQualified
		next.gateQualifiedSample = prev.gateQualifiedSample
		next.gateStamp = this.blockNo
		if (prev.channelSnrDb !== undefined && Number.isFinite(prev.channelSnrDb))
			next.channelSnrDb = prev.channelSnrDb
		if (
			prev.peakChannelSnrDb !== undefined &&
			Number.isFinite(prev.peakChannelSnrDb)
		)
			next.peakChannelSnrDb = prev.peakChannelSnrDb
		if (next.gateQualified) {
			const qualifiedAt = next.gateQualifiedSample
			const end = Number.isFinite(qualifiedAt) ? qualifiedAt : next.lastSample
			this.grantPass(next, Math.max(next.startSample, end))
		}
		this.trace(
			next,
			"inherit",
			next.channelSnrDb ?? Number.NEGATIVE_INFINITY,
			next.gateK,
			next.gateMargin,
			next.gateMinMs,
			next.startSample,
			prev.id,
		)
	}

	private trace(
		t: OpenTrack,
		kind: GateTrace["kind"],
		snr: number,
		kDb: number,
		marginDb: number,
		minMs: number,
		endSample: number,
		fromTrackId: string | null = null,
	): void {
		const fn = this.gateTrace
		if (fn === null) return
		fn({
			trackId: t.id,
			kind,
			snr,
			kDb,
			marginDb,
			minMs,
			endSample,
			gate: t.gate ?? "pending",
			passedSample: t.gatePassedSample ?? null,
			on: t.gateOn,
			run: t.gateRun,
			offUsed: t.gateOffs > 0,
			onBlocks: t.gateOnBlocks,
			best: t.gateBest,
			fromTrackId,
		})
	}

	private liveById(id: string): OpenTrack | undefined {
		for (const t of this.open) if (t.id === id) return t
		return undefined
	}

	private pendingOffById(id: string): OpenTrack | undefined {
		for (const t of this.pendingOff) if (t.id === id) return t
		return undefined
	}

	private paintLive(track: TrackSnapshot, t: OpenTrack): void {
		if (t.gate !== undefined) track.gate = t.gate
		if (t.channelSnrDb !== undefined && Number.isFinite(t.channelSnrDb))
			track.channelSnrDb = t.channelSnrDb
		else delete track.channelSnrDb
		if (
			t.peakChannelSnrDb !== undefined &&
			Number.isFinite(t.peakChannelSnrDb) &&
			t.peakChannelSnrDb !== t.channelSnrDb
		)
			track.peakChannelSnrDb = t.peakChannelSnrDb
		else delete track.peakChannelSnrDb
		if (t.gate === "passed" && t.gatePassedSample !== undefined)
			track.gatePassedSample = t.gatePassedSample
		else delete track.gatePassedSample
	}

	/**
	 * A close built before its measurement, or a close that never passed.
	 * A pass sample may sit one block past `lastSample` when the run met the
	 * rule on a hang block the track was not observed on.
	 */
	private paintStoredClose(track: TrackSnapshot): void {
		if (
			track.gate === "passed" &&
			track.gatePassedSample !== undefined &&
			Number.isFinite(track.gatePassedSample)
		)
			return
		track.gate = "below"
		delete track.gatePassedSample
	}

	/** Reused by `localSnr`. */
	private localScratch = new Float32Array(0)

	/**
	 * This block's local contrast: the mean segment power (or, for a carrier whose matched width
	 * fits one 6.25 kHz slot, the higher of that and the matched-window power) over the median of `localBins` bins each side (skipping the bin next to
	 * each edge), in dB. Null without the option or neighbours.
	 *
	 * Also stores `t.matchedSnrDb`: the highest mean power of `W` contiguous segment bins over
	 * the same local floor, W = the bins within `MATCHED_DROP_DB` (6 dB) of the segment peak,
	 * contiguous around it, capped at the track's OBW in bins and the segment, at least
	 * `MATCHED_MIN_BINS` (2). A carrier with weak sidebands merged into a wide segment is
	 * still measured over its own width. A slot SNR spreads a narrow carrier over the whole slot: a 1 kHz carrier
	 * 15 dB over the floor in an 8.33 kHz slot reads 10·log10((31.6 + 7.33) / 8.33) = 6.7 dB, under
	 * the 9 dB run floor, while matched to its 1 kHz it reads about 15 dB (a Hann-windowed tone
	 * keeps its second bin within 6 dB: 2-bin mean about 13 dB). A window counts only with at
	 * least 2 bins `MATCHED_SUPPORT_DB` over the local floor (a 1-bin segment may borrow the bin
	 * next to each edge), so one hot bin on the floor has no matched SNR and cannot read as a carrier.
	 */
	private localSnr(
		t: OpenTrack,
		s: Segment,
		powerDb: Float32Array,
		bandLin: number,
	): number | null {
		t.matchedSnrDb = Number.NaN
		const w = this.opts.localBins ?? 0
		const width = s.endBin - s.startBin
		if (w <= 0 || width <= 0) return null
		if (this.localScratch.length < 2 * w)
			this.localScratch = new Float32Array(2 * w)
		let k = 0
		for (let i = s.startBin - 1 - w; i < s.startBin - 1; i++) {
			const v = powerDb[i]
			if (v !== undefined && Number.isFinite(v)) this.localScratch[k++] = v
		}
		for (let i = s.endBin + 1; i < s.endBin + 1 + w; i++) {
			const v = powerDb[i]
			if (v !== undefined && Number.isFinite(v)) this.localScratch[k++] = v
		}
		if (k === 0) return null
		const sorted = this.localScratch.subarray(0, k).sort()
		const mid = k >> 1
		const median =
			k % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
		const mean = 10 * Math.log10(Math.max(bandLin / width, 1e-30))
		// Matched width: the bins within 6 dB of the segment peak, contiguous around it (the
		// carrier's own width), never more than the track's OBW nor fewer than 2.
		const peakDb = powerDb[s.peakBin] ?? -200
		let lo6 = s.peakBin
		let hi6 = s.peakBin
		while (
			lo6 > s.startBin &&
			(powerDb[lo6 - 1] ?? -200) >= peakDb - MATCHED_DROP_DB
		)
			lo6--
		while (
			hi6 < s.endBin - 1 &&
			(powerDb[hi6 + 1] ?? -200) >= peakDb - MATCHED_DROP_DB
		)
			hi6++
		const obwBins = Math.round(t.geomObw / this.opts.binHz)
		const cap = Number.isFinite(obwBins) && obwBins > 0 ? obwBins : width
		// A segment narrower than the 2-bin minimum may borrow the bin next to each edge, so a
		// tone whose second bin fell under the detection threshold is still measured on 2 bins.
		const lo =
			width < MATCHED_MIN_BINS ? Math.max(0, s.startBin - 1) : s.startBin
		const hi =
			width < MATCHED_MIN_BINS
				? Math.min(powerDb.length, s.endBin + 1)
				: s.endBin
		const win = Math.min(
			hi - lo,
			Math.max(MATCHED_MIN_BINS, Math.min(hi6 - lo6 + 1, cap)),
		)
		// Only a window with at least 2 bins above the local floor is an emission's width: one
		// hot bin with its neighbours on the floor never reads as a carrier.
		const supportDb = median + MATCHED_SUPPORT_DB
		let sum = 0
		let support = 0
		let bestSum = 0
		for (let i = lo; i < hi; i++) {
			const v = powerDb[i] ?? -200
			sum += 10 ** (v / 10)
			if (v >= supportDb) support++
			if (i - lo >= win) {
				const old = powerDb[i - win] ?? -200
				sum -= 10 ** (old / 10)
				if (old >= supportDb) support--
			}
			if (i - lo >= win - 1 && support >= MATCHED_MIN_BINS && sum > bestSum)
				bestSum = sum
		}
		const narrow =
			win >= MATCHED_MIN_BINS &&
			win * this.opts.binHz <= CHANNEL_GATE_MIN_WIDTH_HZ
		// Attempt 2: the matched window serves admission only for a narrow carrier too.
		if (bestSum > 0 && narrow)
			t.matchedSnrDb = 10 * Math.log10(bestSum / win) - median
		// Local contrast is the whole segment's. Narrow exception: when the matched width (the
		// carrier's own width) fits one slot (`CHANNEL_GATE_MIN_WIDTH_HZ`, 6.25 kHz), the
		// matched window may stand in, so a carrier with wide weak sidebands merged into its
		// segment still stands out by its carrier. Wider carriers keep the segment contrast.
		const whole = mean - median
		return narrow && Number.isFinite(t.matchedSnrDb) && t.matchedSnrDb > whole
			? t.matchedSnrDb
			: whole
	}

	/**
	 * The -20 dB OBW never exceeds the widest single-block segment. On a weak track
	 * (peak under 20 dB above the floor in the mean) -20 dB reaches the floor, so the width would
	 * be the union of every span the track drifted over, not one emission's width. A strong
	 * track's -20 dB width sits inside its on-bins and is unchanged.
	 */
	private cappedObw(t: OpenTrack, obwHz: number): number {
		const widest = t.maxWidthBins * this.opts.binHz
		return widest > 0 && obwHz > widest ? widest : obwHz
	}

	/** Centre and OBW for this block, computed once and reused by `snapshot`. */
	private ensureGeometry(t: OpenTrack): void {
		if (t.geomBlock === this.blockNo) return
		const centreHz = this.rf(this.centroidBin(t), this.n, t.epoch.centreHz)
		const mean = t.spectrum.meanDb()
		const { a, e } = this.obwWindow(t, mean)
		const obwHz =
			t.maxBlockSnrDb >= OBW_MIN_SNR_DB
				? this.cappedObw(t, obwAtDb(mean, a, e, this.opts.binHz, 20))
				: t.maxWidthBins * this.opts.binHz
		t.geomBlock = this.blockNo
		t.geomCentre = centreHz
		t.geomObw = obwHz
	}

	private snapshot(t: OpenTrack, n: number): TrackSnapshot {
		const binHz = this.opts.binHz
		const mean = t.spectrum.meanDb()
		const { a, e } = this.obwWindow(t, mean)
		const useDb = t.maxBlockSnrDb >= OBW_MIN_SNR_DB
		const f = this.features(t)
		const blocks = Math.max(1, t.blocks)
		const bandMean = t.bandLinSum / blocks
		const centreHz = this.rf(this.centroidBin(t), n, t.epoch.centreHz)
		const obwHz = useDb
			? this.cappedObw(t, obwAtDb(mean, a, e, binHz, 20))
			: t.maxWidthBins * binHz
		t.geomBlock = this.blockNo
		t.geomCentre = centreHz
		t.geomObw = obwHz
		const snap: TrackSnapshot = {
			trackId: t.id,
			sourceId: this.opts.sourceId,
			stream: t.epoch.stream,
			epoch: t.epoch.epoch,
			startSample: t.startSample,
			lastSample: t.lastSample,
			centreHz,
			obwHz,
			obwMethod: useDb ? "-20dB" : "on-bins",
			peakDbfs: t.peakDbfs,
			meanDbfs: 10 * Math.log10(Math.max(bandMean, 1e-30)),
			snrDb: trackSnrDb(t),
			floorDbfs: t.floorDbSum / blocks,
			thresholdDb: t.thresholdDb,
			blocks: t.blocks,
			maxBlockSnrDb: t.maxBlockSnrDb,
			dutyCycle:
				f.duty ?? t.blocks / Math.max(1, t.lastOnBlock - t.openedAtBlock + 1),
			spectralShape: spectralShape(mean, a, e, binHz),
			flags: { ...t.flags },
			tuningTrust: frameTrust(
				t.epoch.tuningTrust,
				t.startSample,
				t.epoch.verifiedFromSample,
			),
		}
		if (this.planActive && t.gate !== undefined) {
			// A gate field like the others; absent without a channel plan.
			if (t.localSnrBlocks > 0)
				snap.localSnrDb = t.localSnrSum / t.localSnrBlocks
			snap.gate = t.gate
			if (t.channelSnrDb !== undefined && Number.isFinite(t.channelSnrDb))
				snap.channelSnrDb = t.channelSnrDb
			if (
				t.peakChannelSnrDb !== undefined &&
				Number.isFinite(t.peakChannelSnrDb) &&
				t.peakChannelSnrDb !== t.channelSnrDb
			)
				snap.peakChannelSnrDb = t.peakChannelSnrDb
			if (
				t.gate === "passed" &&
				t.gatePassedSample !== undefined &&
				Number.isFinite(t.gatePassedSample)
			)
				snap.gatePassedSample = t.gatePassedSample
		}
		if (f.acf30 !== undefined) snap.acf30 = f.acf30
		if (f.acf60 !== undefined) snap.acf60 = f.acf60
		return snap
	}
}

/** The snapshot's SNR: mean band power over mean floor power across the track's blocks, dB. */
function trackSnrDb(t: OpenTrack): number {
	return snrDbOf(t.bandLinSum, t.floorLinSum, t.blocks)
}

function snrDbOf(bandLinSum: number, floorLinSum: number, n: number): number {
	const blocks = Math.max(1, n)
	const bandMean = bandLinSum / blocks
	const floorMean = floorLinSum / blocks
	return (
		10 *
		Math.log10(
			Math.max(bandMean - floorMean, 1e-30) / Math.max(floorMean, 1e-30),
		)
	)
}

/**
 * WG11 req 5.1: a track's frame chain totals (its own state on top of its chain base). SNR is
 * the chain's mean band over mean floor and the peak and best block SNR its maxima, like the
 * lifetime mean / max of a single track; spur and image are sticky across the chain.
 */
function chainTotalsOf(t: OpenTrack): ChainBase {
	const c = t.chain
	if (c === null)
		return {
			id: t.id,
			startSample: t.startSample,
			blocks: t.blocks,
			bandLinSum: t.bandLinSum,
			floorLinSum: t.floorLinSum,
			peakDbfs: t.peakDbfs,
			maxBlockSnrDb: t.maxBlockSnrDb,
			spur: t.flags.spur,
			iqImage: t.flags.iqImage,
		}
	return {
		id: c.id,
		startSample: c.startSample,
		blocks: c.blocks + t.blocks,
		bandLinSum: c.bandLinSum + t.bandLinSum,
		floorLinSum: c.floorLinSum + t.floorLinSum,
		peakDbfs: Math.max(c.peakDbfs, t.peakDbfs),
		maxBlockSnrDb: Math.max(c.maxBlockSnrDb, t.maxBlockSnrDb),
		spur: c.spur || t.flags.spur,
		iqImage: c.iqImage || t.flags.iqImage,
	}
}

/**
 * The chain base of `next`, which re-opened at max-duration on the segment and block that also
 * extended `prev`: prev's chain totals minus next's own (that one shared block), so the block
 * is counted once.
 */
function chainBaseOf(prev: OpenTrack, next: OpenTrack): ChainBase {
	const p = chainTotalsOf(prev)
	return {
		...p,
		blocks: Math.max(0, p.blocks - next.blocks),
		bandLinSum: Math.max(0, p.bandLinSum - next.bandLinSum),
		floorLinSum: Math.max(0, p.floorLinSum - next.floorLinSum),
	}
}
