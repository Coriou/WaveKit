import {
	dutyFromEnvelope,
	envelopeAcf,
	obwAtDb,
	spectralShape,
	twoTone,
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
	CHANNEL_GATE_BURST_MARGIN_DB,
	CHANNEL_GATE_BURST_MIN_DURATION_MS,
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
	/**
	 * FSK pair reach per bin (0 = off there): two new segments of similar level whose peaks are
	 * closer than this (the smaller of the two peaks' values) and that start on the same block are
	 * the two tones of one emission (see `FSK_PAIR_DB`). Absent: no pairing.
	 */
	pairReachBins?: Uint16Array
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
/**
 * FSK pair: two tones of one 2FSK emission show as two segments when the valley between them
 * drops to the floor (a ±4.5 kHz POCSAG pair at 10 dB, a ±30 kHz ISM sensor). Their peaks sit
 * within 1 to 2 dB of each other; 6 dB (`PROMINENCE_DB`) leaves room for the block-to-block
 * scatter of a weak pair while a carrier and its far weaker neighbour stay apart. Pairing also
 * needs both to start within one block of each other (not on an epoch's first block), so two
 * independent emitters of similar level only join when they key up within 100 ms. The two tones of one emission are also about as wide
 * as each other (`FSK_PAIR_WIDTH_RATIO`).
 */
export const FSK_PAIR_DB = 6
/**
 * FSK pair parts differ in width by at most this factor (plus one bin of quantisation): both
 * tones carry the same symbol stream. A 13 kHz OOK sensor and a 30 kHz LoRa fragment keyed up on
 * the same block (2.3 times) stay apart.
 */
export const FSK_PAIR_WIDTH_RATIO = 2
/**
 * Bridge (`Tracker.cling`): a piece at most this many floor bins from a group member is part of
 * it whatever its width. 2 = the segmenter's own hole (`gapBins`) and a Hann main lobe's half
 * width: abutting LoRa chirp pieces and a tone's split-off crumb, never a carrier 3 or more bins
 * clear of the tone.
 */
export const CLING_ABUT_BINS = 2
/**
 * Bridge past `CLING_ABUT_BINS`: the piece's width times this reaches the member's and the floor
 * gap is narrower than the member. A ±30 kHz ISM send's transition hump (12 bins, 4 from 30-bin
 * tones: 3 · 12 = 36 ≥ 30) joins; a 1-bin carrier 5 bins from 6-bin tones (3 · 1 = 3 < 6) keeps
 * its own identity.
 */
export const CLING_WIDTH_RATIO = 3
/**
 * Bridge of a 2FSK transition hump: a piece between two members, weaker than both, with each floor
 * gap narrower than the member beside it, whose middle lies within 1/this of the members' spacing
 * of their midpoint. The transition sweeps through the carrier frequency, so its hump is centred
 * there: a ±30 kHz sensor at 10 dB shows a 1 to 3-bin hump at most 2.3 bins off the midpoint of
 * tones 48.5 bins apart (2.3 ≤ 48.5 / 8 = 6.1). A carrier off the midpoint keeps its identity.
 */
export const CLING_MIDPOINT_FRACTION = 8
/**
 * Two-tone spectrum (`TrackSnapshot.fsk2`): tones at least 6 kHz apart, with a valley 6 dB
 * (`PROMINENCE_DB`) under the weaker. 6 kHz is past AFSK and FM voice humps (audio to 3 kHz each
 * side) and 4FSK outer symbols (±1.944 kHz on DMR: 3.9 kHz apart), under a ±4.5 kHz POCSAG pair
 * (9 kHz apart).
 */
export const FSK2_MIN_SPACING_HZ = 6_000
const FSK2_DIP_DB = 6
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
const NO_SPANS = new Int32Array(0)

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
	/** Burst slots cover the track though its rule is the standard one (see `ChannelGateReading`). */
	burstCovered?: boolean
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
	/**
	 * The last on block's reading had `burstCovered`: the run may also qualify by the burst
	 * rule (100 ms at k + 6 dB) besides its own (`gateMinMs` at k + `gateMargin`).
	 */
	gateBurstAlso: boolean
	/** This block's step already moved `gate` to `passed`. */
	gateJustPassed: boolean
	/** Block number `geomCentre` / `geomObw` were computed for. −1: none. */
	geomBlock: number
	geomCentre: number
	geomObw: number
	/** `blockNo` of the last gate step applied to this track. 0: none. */
	gateStamp: number
	/**
	 * Opened from a fused FSK pair: while open, the tones peaking inside its span [onMin, onMax)
	 * join it into one segment, and one tone alone anywhere in the span matches it.
	 */
	paired: boolean
	/**
	 * This block's strongest fused part (one FSK tone) as RF centre and width, for `stepObserved`;
	 * valid only while `partBlock` is the current block.
	 */
	partCentre: number
	partObw: number
	partBlock: number
	/**
	 * Width (bins) of the paired track's latest tone: the strongest part of its latest fused
	 * segment. A segment far narrower than this (`farNarrower`) is no tone of the pair. 0: none.
	 */
	toneBins: number
	/**
	 * Bin spans [start, end) of the parts of the paired track's latest fused segment, in pairs
	 * (`partSpans` entries used: 2 · `partCount`). Reused; grows only.
	 */
	partSpans: Int32Array
	partCount: number
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
	/** Blocks seen in this epoch: an FSK pair needs the block before it in the same epoch. */
	private epochBlocks = 0
	/** `fusePairs` scratch, reused block to block (docs/PERFORMANCE.md rule 4). */
	private fuseOrder = new Int32Array(0)
	private fuseGroup = new Int32Array(0)
	private fuseFresh = new Uint8Array(0)
	private fuseByLevel = new Int32Array(0)
	private fuseReach: Uint16Array<ArrayBufferLike> = new Uint16Array(0)
	private readonly fuseSorted: Segment[] = []
	private readonly fuseOut: Segment[] = []
	private readonly fuseParts = new Map<Segment, Segment[]>()
	private readonly fusePool: Segment[][] = []
	private readonly fuseBurst = new Set<Segment>()
	/**
	 * Fused segments, reused: one is free once no open track holds it as `lastSeg` and this
	 * `fusePairs` call has not taken it, so a steady pair rotates two.
	 */
	private readonly fuseSegs: Segment[] = []
	private readonly fuseSegTaken: number[] = []
	/** The open paired track an established group belongs to, by group; null for a new pair. */
	private readonly fuseTrack: (OpenTrack | null)[] = []
	private fuseStamp = 0
	private readonly fuseBlock: TrackerBlock = {
		endSample: 0,
		powerDb: new Float32Array(0),
		floorDb: new Float32Array(0),
		blockFloorDb: 0,
		thresholdDb: 0,
		gap: false,
		overload: false,
	}
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
		this.epochBlocks = 0
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

	block(input: Segment[], blockIn: TrackerBlock): PipelineEvent[] {
		this.epochBlocks++
		const fused = this.fusePairs(input, blockIn)
		const segments = fused ? this.fuseOut : input
		const b = fused ? this.fuseBlock : blockIn
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
		// The pipeline asks for the segments it passed in: each part maps to the fused track.
		if (fused)
			for (const [s, parts] of this.fuseParts) {
				const t = this.assoc.get(s)
				if (t === undefined) continue
				t.paired = true
				let strongest = parts[0]!
				for (const part of parts) {
					this.assoc.set(part, t)
					if (part.peakDb > strongest.peakDb) strongest = part
				}
				t.partCentre = this.rf(strongest.centroidBin, n, t.epoch.centreHz)
				t.partObw =
					Math.max(1, strongest.endBin - strongest.startBin) * this.opts.binHz
				t.partBlock = this.blockNo
				t.toneBins = strongest.endBin - strongest.startBin
				if (t.partSpans.length < 2 * parts.length)
					t.partSpans = new Int32Array(2 * Math.max(4, parts.length))
				for (let i = 0; i < parts.length; i++) {
					t.partSpans[2 * i] = parts[i]!.startBin
					t.partSpans[2 * i + 1] = parts[i]!.endBin
				}
				t.partCount = parts.length
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
				nt.paired = t.paired
				if (t.paired) {
					// the successor keeps the pair's span and tone: one tone alone still matches it
					nt.onMin = Math.min(nt.onMin, t.onMin)
					nt.onMax = Math.max(nt.onMax, t.onMax)
					nt.toneBins = t.toneBins
					nt.partSpans = t.partSpans
					nt.partCount = t.partCount
				}
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
				t.blocks === 5 ||
				t.blocks === 20 ||
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

	/**
	 * FSK pairs (see `FSK_PAIR_DB`). Inside an open paired track's span, its strongest segment
	 * and every one within `FSK_PAIR_DB` and `FSK_PAIR_WIDTH_RATIO` of it join into one; a weaker
	 * or far narrower emitter there keeps its own segment unless it clings to them (`bridge`). Then, on a block whose predecessor in
	 * this epoch was measured, the strongest new segment (no open track overlaps it, or only a
	 * track opened on the previous block) pairs with the strongest such segment within the pair
	 * reach, `FSK_PAIR_DB` and `FSK_PAIR_WIDTH_RATIO` of it, with no tracked segment between them;
	 * the pair, every such segment between them that pairs with the first one or clings, and pieces
	 * that chain on within the reach become one segment. The fused segment's track turns paired;
	 * a one-block track it left without a segment closes on its hang (it never passed: the gate
	 * needs 2 blocks). False when nothing joined; true leaves the block's segments in `fuseOut`,
	 * the block in `fuseBlock` and each fused segment's parts in `fuseParts`. Scratch storage is
	 * the tracker's own: a block where nothing joins allocates nothing.
	 */
	private fusePairs(segments: Segment[], b: TrackerBlock): boolean {
		const reach = b.pairReachBins
		const m = segments.length
		// Map.clear allocates a new table even when empty.
		if (this.fuseParts.size > 0) this.fuseParts.clear()
		if (reach === undefined || b.gap || m < 2) return false
		if (this.fuseOrder.length < m) {
			const cap = Math.max(2 * this.fuseOrder.length, m)
			this.fuseOrder = new Int32Array(cap)
			this.fuseGroup = new Int32Array(cap)
			this.fuseFresh = new Uint8Array(cap)
			this.fuseByLevel = new Int32Array(cap)
		}
		const order = this.fuseOrder
		const group = this.fuseGroup
		const fresh = this.fuseFresh
		const sorted = this.fuseSorted
		this.fuseReach = reach
		// Insertion sort by peak bin: the segmenter emits bin order, so one pass.
		for (let i = 0; i < m; i++) {
			const s = segments[i]!
			let j = i
			for (; j > 0 && sorted[j - 1]!.peakBin > s.peakBin; j--) {
				sorted[j] = sorted[j - 1]!
				order[j] = order[j - 1]!
			}
			sorted[j] = s
			order[j] = i
		}
		sorted.length = m
		group.fill(-1, 0, m)
		let groups = 0
		for (let o = 0; o < this.open.length; o++) {
			const t = this.open[o]!
			if (!t.paired) continue
			const lo = t.onMin - MATCH_TOLERANCE_BINS
			const hi = t.onMax + MATCH_TOLERANCE_BINS
			// The anchor is the strongest segment that can be one of the pair's tones: a stronger
			// narrow carrier keying up inside the span never takes the pair's place.
			let a = -1
			for (let k = 0; k < m; k++) {
				const s = sorted[k]!
				if (group[k]! >= 0 || s.peakBin < lo || s.peakBin >= hi) continue
				if (farNarrower(s, t.toneBins)) continue
				if (a < 0 || s.peakDb > sorted[a]!.peakDb) a = k
			}
			if (a < 0) continue
			let first = 0
			while (sorted[first]!.peakBin < lo) first++
			let last = m - 1
			while (sorted[last]!.peakBin >= hi) last--
			for (let k = first; k <= last; k++)
				if (group[k]! < 0 && (k === a || pairLevel(sorted[a]!, sorted[k]!)))
					group[k] = groups
			this.fuseTrack[groups] = t
			this.bridge(groups, first, last)
			let count = 0
			for (let k = first; k <= last; k++) if (group[k] === groups) count++
			if (count >= 2) groups++
			else group[a] = -1
		}
		if (this.epochBlocks >= 2) {
			// 2: no open track overlaps it (it starts on this block). 1: it overlaps only unpaired
			// tracks opened on the previous block: a tone that keyed up one block early, or a pair
			// whose partial first block read the tones too far apart in level. 0: other. Tracks
			// that ran longer never join here.
			const byLevel = this.fuseByLevel
			let c = 0
			for (let k = 0; k < m; k++) {
				fresh[k] = group[k]! >= 0 ? 0 : this.freshState(sorted[k]!)
				if (fresh[k] === 0) continue
				// Insertion by level, strongest first: only new segments take part.
				let j = c++
				for (
					;
					j > 0 && sorted[byLevel[j - 1]!]!.peakDb < sorted[k]!.peakDb;
					j--
				)
					byLevel[j] = byLevel[j - 1]!
				byLevel[j] = k
			}
			for (let q = 0; q < c; q++) {
				const i = byLevel[q]!
				if (group[i]! >= 0) continue
				const a = sorted[i]!
				let partner = -1
				for (let dir = -1; dir <= 1; dir += 2) {
					for (let j = i + dir; this.fuseFree(j); j += dir) {
						const s = sorted[j]!
						if (Math.abs(s.peakBin - a.peakBin) >= this.reachOf(a)) break
						if (!this.pairs(a, s)) continue
						if (partner < 0 || s.peakDb > sorted[partner]!.peakDb) partner = j
					}
				}
				if (partner < 0) continue
				let from = Math.min(i, partner)
				let to = Math.max(i, partner)
				group[i] = groups
				group[partner] = groups
				// A weaker or far narrower emitter between the two tones keeps its own segment
				// unless it clings to them (`bridge`).
				for (let k = from + 1; k < to; k++)
					if (this.pairs(a, sorted[k]!)) group[k] = groups
				// More pieces of the same emission (a LoRa chirp cut at channel edges) join while each
				// pairs with the group's edge piece and the whole group stays within the reach.
				for (let k = from - 1; this.fuseFree(k) && this.spans(k, to); k--)
					if (this.pairs(sorted[from]!, sorted[k]!)) {
						group[k] = groups
						from = k
					}
				for (let k = to + 1; this.fuseFree(k) && this.spans(from, k); k++)
					if (this.pairs(sorted[to]!, sorted[k]!)) {
						group[k] = groups
						to = k
					}
				this.fuseTrack[groups] = null
				this.bridge(groups, from, to)
				groups++
			}
		}
		if (groups === 0) return false
		this.fuseStamp++
		const out = this.fuseOut
		const parts = this.fuseParts
		// `fresh` is spent: it now marks joined segments by input index.
		const joined = this.fuseFresh
		out.length = 0
		joined.fill(0, 0, m)
		for (let k = 0; k < m; k++) if (group[k]! >= 0) joined[order[k]!] = 1
		for (let i = 0; i < m; i++) if (joined[i] === 0) out.push(segments[i]!)
		const burstIn = b.burstSegments
		const burst = this.fuseBurst
		burst.clear()
		if (burstIn !== undefined) for (const s of burstIn) burst.add(s)
		for (let g = 0; g < groups; g++) {
			let list = this.fusePool[g]
			if (list === undefined) {
				list = []
				this.fusePool.push(list)
			}
			list.length = 0
			let allBurst = true
			for (let k = 0; k < m; k++) {
				if (group[k] !== g) continue
				list.push(sorted[k]!)
				if (!burst.has(sorted[k]!)) allBurst = false
			}
			const s = joinSegments(list, b.powerDb, b.floorDb, this.freeFuseSeg())
			// A fused segment is a burst only when every part was one.
			if (allBurst) burst.add(s)
			parts.set(s, list)
			out.push(s)
		}
		Object.assign(this.fuseBlock, b)
		this.fuseBlock.burstSegments = burst
		return true
	}

	/**
	 * Sorted positions in [from, to] that joined no group still join `g` when they cling to it:
	 * the floor gap to a sorted neighbour already in `g` is at most `CLING_ABUT_BINS`, or narrower
	 * than that neighbour with the piece at least 1/`CLING_WIDTH_RATIO` of its width or a
	 * transition hump at the midpoint between it and the next member (`CLING_MIDPOINT_FRACTION`)
	 * or inside the bins one of the established track's parts covered (`inPart`), and so on
	 * outward. A 2FSK emission's transition energy sits in its valley 15 dB under the tones (a
	 * ±30 kHz ISM sensor: 30 kHz tones, a 12 kHz hump 4 to 5 kHz from each), and a LoRa chirp's
	 * pieces abut each other at levels up to 8 dB apart; an independent narrow carrier between
	 * the tones that does not abut one stays apart.
	 */
	private bridge(g: number, from: number, to: number): void {
		for (let k = from + 1; k <= to; k++) this.cling(g, k, k - 1)
		for (let k = to - 1; k >= from; k--) this.cling(g, k, k + 1)
	}

	/** Sorted position `k` joins group `g` of its neighbour `n` when it clings (see `bridge`). */
	private cling(g: number, k: number, n: number): void {
		if (this.fuseGroup[k]! >= 0 || this.fuseGroup[n] !== g) return
		const s = this.fuseSorted[k]!
		const p = this.fuseSorted[n]!
		const gap = n < k ? s.startBin - p.endBin : p.startBin - s.endBin
		const member = p.endBin - p.startBin
		if (
			gap <= CLING_ABUT_BINS ||
			(gap < member &&
				(CLING_WIDTH_RATIO * (s.endBin - s.startBin) >= member ||
					this.midHump(g, k, n, gap) ||
					this.inPart(g, s, p)))
		)
			this.fuseGroup[k] = g
	}

	/**
	 * `s` lies inside the bins one part of group `g`'s established track covered on its last fused
	 * block: a fragment of the emission itself (a LoRa chirp's tail), co-channel with it. The old
	 * footprint is no evidence for a piece stronger than the member `p` it clings to: a fragment
	 * of an emission does not outshine the emission, while an independent carrier keying up where
	 * a tone used to reach would otherwise take the pair's identity (the tones then reopen as new
	 * tracks). Such a piece joins only by abutment or width.
	 */
	private inPart(g: number, s: Segment, p: Segment): boolean {
		if (!(s.peakDb <= p.peakDb)) return false
		const t = this.fuseTrack[g]
		if (t === null || t === undefined) return false
		for (let i = 0; i < t.partCount; i++)
			if (
				s.startBin >= t.partSpans[2 * i]! &&
				s.endBin <= t.partSpans[2 * i + 1]!
			)
				return true
		return false
	}

	/**
	 * Sorted position `k`, `gap` floor bins from member `n`, is (a piece of) a transition hump
	 * between `n` and the nearest member on its other side (see `CLING_MIDPOINT_FRACTION`).
	 */
	private midHump(g: number, k: number, n: number, gap: number): boolean {
		const dir = k - n
		let o = k + dir
		while (o >= 0 && o < this.fuseSorted.length && this.fuseGroup[o]! < 0)
			o += dir
		if (o < 0 || o >= this.fuseSorted.length || this.fuseGroup[o] !== g)
			return false
		const s = this.fuseSorted[k]!
		const p = this.fuseSorted[n]!
		const q = this.fuseSorted[o]!
		const gapQ = o > k ? q.startBin - s.endBin : s.startBin - q.endBin
		if (gapQ >= q.endBin - q.startBin || gap < 0 || gapQ < 0) return false
		if (s.peakDb >= Math.min(p.peakDb, q.peakDb)) return false
		// doubled bin centres: start + end
		const mid = (p.startBin + p.endBin + q.startBin + q.endBin) / 2
		const spacing = Math.abs(q.startBin + q.endBin - p.startBin - p.endBin)
		return (
			CLING_MIDPOINT_FRACTION * Math.abs(s.startBin + s.endBin - mid) <= spacing
		)
	}

	/** A fused segment no open track holds and this `fusePairs` call has not taken. */
	private freeFuseSeg(): Segment {
		const pool = this.fuseSegs
		for (let i = 0; i < pool.length; i++) {
			const s = pool[i]!
			if (this.fuseSegTaken[i] === this.fuseStamp) continue
			let held = false
			for (let o = 0; o < this.open.length && !held; o++)
				held = this.open[o]!.lastSeg === s
			if (held) continue
			this.fuseSegTaken[i] = this.fuseStamp
			return s
		}
		const s: Segment = {
			startBin: 0,
			endBin: 0,
			peakBin: 0,
			peakDb: 0,
			centroidBin: 0,
			flags: { truncated: false, skirt: false, edge: false },
		}
		pool.push(s)
		this.fuseSegTaken.push(this.fuseStamp)
		return s
	}

	/** `fusePairs` new-segment state of `s` (2, 1 or 0, see there). */
	private freshState(s: Segment): number {
		let state = 2
		for (let o = 0; o < this.open.length; o++) {
			const t = this.open[o]!
			if (
				Math.min(s.endBin + MATCH_TOLERANCE_BINS, matchHi(t)) <=
				Math.max(s.startBin - MATCH_TOLERANCE_BINS, matchLo(t))
			)
				continue
			// Young only past the epoch's first block, where every carrier opens at once.
			if (t.paired || t.openedAtBlock !== this.blockNo || this.epochBlocks < 3)
				return 0
			state = 1
		}
		return state
	}

	/** Sorted position `j` exists, is new and joined no group yet. */
	private fuseFree(j: number): boolean {
		return (
			j >= 0 &&
			j < this.fuseSorted.length &&
			this.fuseFresh[j]! > 0 &&
			this.fuseGroup[j]! < 0
		)
	}

	private reachOf(x: Segment): number {
		return this.fuseReach[x.peakBin] ?? 0
	}

	/** Sorted positions `i` and `j` peak within each other's reach. */
	private spans(i: number, j: number): boolean {
		const x = this.fuseSorted[i]!
		const y = this.fuseSorted[j]!
		return (
			Math.abs(x.peakBin - y.peakBin) <
			Math.min(this.reachOf(x), this.reachOf(y))
		)
	}

	/** Both peaks within each other's reach, similar level and width. */
	private pairs(x: Segment, y: Segment): boolean {
		return (
			Math.abs(x.peakBin - y.peakBin) <
				Math.min(this.reachOf(x), this.reachOf(y)) && pairLevel(x, y)
		)
	}

	private bestMatch(
		s: Segment,
		taken: ReadonlySet<OpenTrack>,
	): OpenTrack | undefined {
		let best: OpenTrack | undefined
		let bestOverlap = 0
		for (const t of this.open) {
			if (taken.has(t)) continue
			// A paired track takes a lone tone anywhere in its span, never a far weaker or far
			// narrower emitter.
			if (
				t.paired &&
				!this.fuseParts.has(s) &&
				(s.peakDb < t.lastSeg.peakDb - FSK_PAIR_DB ||
					farNarrower(s, t.toneBins))
			)
				continue
			const overlap =
				Math.min(s.endBin + MATCH_TOLERANCE_BINS, matchHi(t)) -
				Math.max(s.startBin - MATCH_TOLERANCE_BINS, matchLo(t))
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
			gateBurstAlso: false,
			paired: false,
			partCentre: 0,
			partObw: 0,
			partBlock: -1,
			toneBins: 0,
			partSpans: NO_SPANS,
			partCount: 0,
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

	/** Holds the whole-span reading while `stepObserved` reads a fused track's strongest part. */
	private readonly wholeReading: GateReading = {
		channelSnrDb: Number.NEGATIVE_INFINITY,
		kDb: 0,
		marginDb: 0,
		minDurationMs: 0,
		valid: false,
	}

	/**
	 * A fused FSK track is also measured on this block's strongest tone, as that tone's own track
	 * would have been: the whole span counts the empty valley between the tones as noise (a 10 dB
	 * ISM pair 60 kHz apart reads about 3 dB less over its 85 kHz). The better valid reading wins.
	 */
	private stepObserved(
		t: OpenTrack,
		gateOf: (centreHz: number, obwHz: number) => GateReading,
	): void {
		this.ensureGeometry(t)
		const reading = gateOf(t.geomCentre, t.geomObw)
		if (t.partBlock !== this.blockNo) {
			this.stepReading(t, reading, t.lastSample)
			return
		}
		const whole = this.wholeReading
		whole.channelSnrDb = reading.channelSnrDb
		whole.kDb = reading.kDb
		whole.marginDb = reading.marginDb
		whole.minDurationMs = reading.minDurationMs
		whole.valid = reading.valid
		if (reading.peakChannelSnrDb !== undefined)
			whole.peakChannelSnrDb = reading.peakChannelSnrDb
		else delete whole.peakChannelSnrDb
		if (reading.burstCovered !== undefined)
			whole.burstCovered = reading.burstCovered
		else delete whole.burstCovered
		const part = gateOf(t.partCentre, t.partObw)
		const ok = (r: GateReading): boolean =>
			r.valid && Number.isFinite(r.channelSnrDb)
		const usePart =
			ok(part) && (!ok(whole) || part.channelSnrDb > whole.channelSnrDb)
		this.stepReading(t, usePart ? part : whole, t.lastSample)
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
		this.stepAlive(
			t,
			snr,
			k,
			margin,
			minMs,
			true,
			endSample,
			reading.burstCovered === true,
		)
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
			t.gateBurstAlso,
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
		burstAlso: boolean,
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
			t.gateBurstAlso = burstAlso
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
		const strongMs = t.gateStrongBlocks * this.opts.blockMs
		const best = t.gateBest + Tracker.MARGIN_SLACK_DB
		const own = strongMs >= t.gateMinMs && best >= t.gateK + t.gateMargin
		// A burst range overlapped by a non-burst one: a short strong burst passes by the
		// burst rule, a long weak carrier still by the standard one.
		const asBurst =
			t.gateBurstAlso &&
			strongMs >= CHANNEL_GATE_BURST_MIN_DURATION_MS &&
			best >= t.gateK + CHANNEL_GATE_BURST_MARGIN_DB
		if (!own && !asBurst) return
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
		next.gateBurstAlso = prev.gateBurstAlso
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
			obw6Hz: obwAtDb(mean, a, e, binHz, 6),
			binHz,
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
		if (
			twoTone(
				mean,
				a,
				e,
				Math.max(3, Math.ceil(FSK2_MIN_SPACING_HZ / binHz)),
				FSK_PAIR_DB,
				FSK2_DIP_DB,
			)
		)
			snap.fsk2 = true
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

/**
 * One segment from FSK pair parts (sorted by peak bin), written into `out`: their whole span,
 * the strongest peak, the excess-power centroid of the parts' own bins (not the hole between
 * them) and the union of their flags.
 */
function joinSegments(
	parts: readonly Segment[],
	powerDb: Float32Array,
	floorDb: Float32Array,
	out: Segment,
): Segment {
	let start = Infinity
	let end = -Infinity
	let peak = parts[0]!
	let num = 0
	let den = 0
	const flags = out.flags
	flags.truncated = false
	flags.skirt = false
	flags.edge = false
	for (const p of parts) {
		start = Math.min(start, p.startBin)
		end = Math.max(end, p.endBin)
		if (p.peakDb > peak.peakDb) peak = p
		for (let i = p.startBin; i < p.endBin; i++) {
			const excess =
				10 ** ((powerDb[i] ?? -200) / 10) - 10 ** ((floorDb[i] ?? -200) / 10)
			if (excess <= 0) continue
			num += i * excess
			den += excess
		}
		flags.truncated ||= p.flags.truncated
		flags.skirt ||= p.flags.skirt
		flags.edge ||= p.flags.edge
	}
	out.startBin = start
	out.endBin = end
	out.peakBin = peak.peakBin
	out.peakDb = peak.peakDb
	out.centroidBin = den > 0 ? num / den : peak.peakBin
	return out
}

/** `s` is far narrower than a `toneBins`-wide tone (`FSK_PAIR_WIDTH_RATIO`, one bin of slack). */
function farNarrower(s: Segment, toneBins: number): boolean {
	return FSK_PAIR_WIDTH_RATIO * (s.endBin - s.startBin) + 1 < toneBins
}

/** Within `FSK_PAIR_DB` in level and `FSK_PAIR_WIDTH_RATIO` in width: two tones of one pair. */
function pairLevel(a: Segment, b: Segment): boolean {
	return Math.abs(a.peakDb - b.peakDb) <= FSK_PAIR_DB && similarWidth(a, b)
}

/** A paired track matches over its whole span: one tone may key alone on a block. */
function matchLo(t: OpenTrack): number {
	return t.paired ? t.onMin : t.startBin
}

function matchHi(t: OpenTrack): number {
	return t.paired ? t.onMax : t.endBin
}

/** Widths within `FSK_PAIR_WIDTH_RATIO` of each other, one bin of slack. */
function similarWidth(a: Segment, b: Segment): boolean {
	const wa = a.endBin - a.startBin
	const wb = b.endBin - b.startBin
	return Math.max(wa, wb) <= FSK_PAIR_WIDTH_RATIO * Math.min(wa, wb) + 1
}
