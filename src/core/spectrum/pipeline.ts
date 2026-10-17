import { WaveKitError } from "../../utils/errors.js"
import { segment } from "./emissions/segmenter.js"
import type { Segment, SegmentOptions } from "./emissions/segmenter.js"
import { Tracker } from "./emissions/tracker.js"
import type { TrackerBlock } from "./emissions/tracker.js"
import { blockTrackOf, isFrameTrackId } from "./frame-tracks.js"
import type { TrackAssociation } from "./frame-tracks.js"
import { createComponentLogger, createLogger } from "../../utils/logger.js"
import type { Logger } from "../../utils/logger.js"
import { flagIqImages } from "./emissions/iq-image.js"
import type {
	BlockSummary,
	EngineState,
	FreqRange,
	PendingEpoch,
	PipelineConfig,
	PipelineEvent,
	PipelineInput,
	PipelineStats,
	SettleMode,
	TrackSnapshot,
	TuningTrust,
} from "./types.js"
import { dcGuardBins, Detector, shortK, usableEdgeBins } from "./detector.js"
import type { CfarRange } from "./detector.js"
import { accumulateShiftedPower, Fft, powerToDb } from "./fft.js"
import { bytesPerSample, FrameSource } from "./frame-source.js"
import type { Frame } from "./frame-source.js"
import { NoiseFloor } from "./noise-floor.js"
import { SpurMap } from "./spur-map.js"
import { ACTIVITY_HOLD_MS } from "./artefacts.js"
import type { ArtefactMasks, ArtefactSpurLine } from "./artefacts.js"
import { ImpulseBlanker } from "./impulse-blanker.js"
import { PROVISIONAL_WINDOW_MS, ProvisionalSpurs } from "./provisional-spurs.js"
import type { BinRange } from "./provisional-spurs.js"
import {
	classifyAlarm,
	untrackedRetuneAlarm,
	vanishedFeatures,
} from "./retune-alarm.js"
import type { AlarmSuspect } from "./retune-alarm.js"
import type { PersistentFeature, SegmentRange } from "./retune-alarm.js"

/**
 * The whole tier-1 pipeline for one source (decision D1): bytes → frames → blocks → floor →
 * detector → segmenter → tracker, with epoch resolution (marker / timer, spec §4.6), the stale
 * check, gap accounting (§4.1), block summaries and periodic stats. Pure and synchronous: every
 * input returns the events it caused. Runs inside the spectrum worker (Task 32) and in tests.
 */

type MasksInput = Omit<Extract<PipelineInput, { kind: "masks" }>, "kind">

const SKIRT_DB = 30
/** Far skirts (§6.2, P18): regrowth and phase noise sit ≥ 50 dB down one or two channels out; intermod products (≈ 40 dBc) stay. */
const FAR_SKIRT_DB = 50
const FAR_SKIRT_REACH_HZ = 31_250 // ±2 channels of a 12.5 kHz raster plus half a channel
const STATS_INTERVAL_S = 5
const STALE_MAX_MS = 1000
const STUCK_TEST_MODE_S = 0.5
const FLOOR_TAU_S = 30
const SPUR_MIN_OBSERVED_MS = 600_000
const SPUR_ON_FRACTION = 0.95
const SPUR_MAX_WIDTH_BINS = 3
const CFAR_BUCKET_HZ = 2_000_000
const KNOWN_RF_MAX = 1024
const GAP_TOLERANCE_HZ = 2000
const NO_FLOOR_DBFS = -200
const DEFAULT_SHORT_INTEGRATION_MS = 5
const BURST_DILUTION_DB = 6 // long-path peak this far below the short max-hold → energy in ≤ ¼ of the block
const BURST_MAX_ON_MS = 15 // a burst block has the short path on for at most this long
const SPEC_PAD_BINS = 2
const OVERLAP_EDOF_GAIN = 1.89 // Welch equivalent independent frames, Hann at 50 % overlap
const PERSISTENT_TRACK_S = 10
/** WG10 req 2.9: a track this far above the floor (best block SNR) is a strong transmission. */
export const ALARM_STRONG_SNR_DB = 30
/** WG10 req 2.9: tracks starting within this of a strong track's start are its images/IM lines. */
export const ALARM_CO_BIRTH_S = 1
const IMAGE_TOLERANCE_HZ = 1000
const IMAGE_MIN_REJECTION_DB = 20
const IMAGE_MAX_REJECTION_DB = 65

interface EpochState {
	epoch: number
	stream: number
	centreHz: number
	tuningTrust: TuningTrust
	absKey: string
	settledStart: number | null
	settleMode: SettleMode
	staleLeft: number
	staleRef: Uint8Array | null
}

/**
 * Id prefixes of the main and the wideband tracker. Ids are prefix + base-36 sequence, so the wideband prefix
 * extends the main one with a character outside base 36 ("w" alone made main track 1153 "…-w1").
 */
export function trackIdPrefixes(
	sourceId: string,
	atMs: number,
): { main: string; wideband: string } {
	const main = `${sourceId}-${atMs.toString(36)}-`
	return { main, wideband: `${main}w-` }
}

function parseKey(key: string): FreqRange {
	const [a, b] = key.split(":")
	return { startHz: Number(a ?? 0), endHz: Number(b ?? 0) }
}

/** Maximal runs of 1s in a bin mask. */
function runsOf(mask: Uint8Array): BinRange[] {
	const out: BinRange[] = []
	for (let i = 0; i < mask.length; ) {
		if (mask[i] !== 1) {
			i++
			continue
		}
		let j = i
		while (j < mask.length && mask[j] === 1) j++
		out.push({ startBin: i, endBin: j })
		i = j
	}
	return out
}

export class SpectrumPipeline {
	private readonly n: number
	private readonly fs: number
	private readonly binHz: number
	private readonly framesPerBlock: number
	private readonly hop: number
	private readonly expectedFrames: number
	private readonly framesPerShort: number
	private readonly burstMaxOnFrames: number
	private readonly shortK: number
	private readonly shortDetector: Detector | null
	private readonly blockSamples: number
	private readonly blockMs: number
	private readonly bytesPerSample: number
	private readonly gapBins: number
	private readonly edgeBins: number
	private readonly dcBins: number
	private readonly dcGuardHz: number
	private readonly maxStaleBlocks: number
	private readonly hangSamples: number
	private readonly fft: Fft
	private readonly floor: NoiseFloor
	private readonly spurs: SpurMap
	private readonly detector: Detector
	private readonly tracker: Tracker
	private readonly wideband: Tracker
	private frames: FrameSource

	private readonly frameAcc: Float64Array
	private readonly blockAcc: Float64Array
	private readonly frameDb: Float32Array
	private readonly powerDb: Float32Array
	private readonly floorDb: Float32Array
	private readonly on: Uint8Array
	private readonly extra: Uint8Array
	private readonly learnMask: Uint8Array
	private readonly joined: Uint8Array
	private readonly lastTrackBins: Uint8Array
	private readonly exclusionMask: Uint8Array
	private readonly shortAcc: Float64Array
	private readonly shortRing: Float64Array
	private shortSlot = 0
	private shortFill = 0
	private shortNext = -1
	private readonly shortDb: Float32Array
	private readonly shortOn: Uint8Array
	private readonly burstCount: Uint8Array
	private readonly burstPeakDb: Float32Array
	private readonly burstCountDone: Uint8Array
	private readonly burstPeakDone: Float32Array
	private readonly burstOn: Uint8Array
	private readonly mergedDb: Float32Array
	private floorReady = false
	private prevPersistent: PersistentFeature[] = []
	/** WG10 req 2.9: open and just-closed tracks for the transmission-end classifier. */
	private readonly trackInfo = new Map<
		string,
		{
			centreHz: number
			obwHz: number
			startSample: number
			maxSnrDb: number
			closedBlock: number | null
		}
	>()
	/** WG10 req 2.9: blocks finished (monotonic; ages trackInfo closes). */
	private blocksSeen = 0
	/**
	 * WG10 R1 M2: consecutive alarm blocks held while a strong track that would explain them is
	 * still open (in its hang). Past alarmWaitBlocks the alarm is external-control.
	 */
	private alarmWaitedBlocks = 0
	private readonly alarmWaitBlocks: number
	private exclusionEdges: number[] = []
	private rasterEdges: number[] = []
	private masks: MasksInput = {
		exclusions: [],
		cfarRanges: [],
		burstRanges: [],
		rasters: [],
		obwHz: [],
		inWindow: true,
	}
	private feed = false

	private ep: EpochState | null = null
	private resolving: PendingEpoch | null = null
	private epochCounter = 0
	private stream = 0
	private gaps: { start: number; end: number }[] = []
	private knownRf: { rfHz: number; obwHz: number }[] = []

	private blockIndex = -1
	private blockFrames = 0
	private blockClipped = 0
	/** Index of the epoch's last block that recorded noise edges; the detector's history is valid only for the next one. */
	private noiseEdgeBlock = -1

	private overloadedBlocks = 0
	private gapSamples = 0
	private staleAfterSettle = 0
	private settledSamples = 0
	private observedSamples = 0
	private nextStatsAt: number
	private stuck = false
	private lastFloorDbfs = NO_FLOOR_DBFS
	// artefact rejection (spec § 4.9, Task 7a)
	private readonly blanker: ImpulseBlanker
	private readonly provisional: ProvisionalSpurs
	private readonly lineMask: Uint8Array
	/** This block's spur + provisional + comb core bins (withoutLines); the summary reports them. */
	private readonly lineScratch: Uint8Array
	private readonly lastActive: Float64Array
	private lastActivityEnd = 0
	/** IQ-image tracks of the last block, for artefactMasks() and the block summary's `iqImage` (emitWithImages). */
	private imageTracks: { centreHz: number; obwHz: number }[] = []
	private out: PipelineEvent[] = []
	private logger: Logger | null
	private warnedTrackId = false

	constructor(
		private readonly cfg: PipelineConfig,
		/** `provisionalWindowMs` (default 30 s) is a test knob: P24 runs the comb property at 3 s. */
		deps: {
			now?: () => number
			provisionalWindowMs?: number
			logger?: Logger
		} = {},
	) {
		this.logger = deps.logger ?? null
		const now = deps.now ?? Date.now
		this.n = cfg.fftSize
		this.fs = cfg.sampleRateHz
		this.binHz = this.fs / this.n
		const overlap = cfg.overlap ?? 0
		this.hop = this.n * (1 - overlap)
		this.framesPerBlock = Math.max(
			1,
			Math.round((cfg.integrationMs * this.fs) / (this.n * 1000)),
		)
		this.blockSamples = this.framesPerBlock * this.n
		this.expectedFrames = this.blockSamples / this.hop
		const shortMs =
			cfg.shortIntegrationMs === undefined
				? DEFAULT_SHORT_INTEGRATION_MS
				: cfg.shortIntegrationMs
		this.framesPerShort =
			shortMs === null
				? 0
				: Math.max(1, Math.round((shortMs * this.fs) / (this.hop * 1000)))
		// a burst of ≤ BURST_MAX_ON_MS keeps the sliding window on for at most its length + T_short − 1 frame
		this.burstMaxOnFrames =
			shortMs === null
				? 0
				: Math.round((BURST_MAX_ON_MS * this.fs) / (this.hop * 1000)) +
					this.framesPerShort -
					1
		this.shortK = shortK(this.fs / this.n)
		this.blockMs = (this.blockSamples / this.fs) * 1000
		this.bytesPerSample = bytesPerSample(cfg.format)
		this.gapBins = Math.max(1, Math.round(GAP_TOLERANCE_HZ / this.binHz))
		this.edgeBins = usableEdgeBins(this.n, cfg.usableFraction)
		this.dcBins = dcGuardBins(cfg.dcGuardHz, this.binHz, this.binHz)
		this.dcGuardHz = Math.max(cfg.dcGuardHz, 2 * this.binHz)
		this.maxStaleBlocks = Math.ceil(STALE_MAX_MS / this.blockMs)
		const hangBlocks = Math.max(1, Math.round(cfg.trackHangMs / this.blockMs))
		this.hangSamples = hangBlocks * this.blockSamples
		// The strong track closes one hang after it vanished; its close is visible a block later.
		this.alarmWaitBlocks = hangBlocks + 2
		this.fft = new Fft(this.n)
		this.frames = new FrameSource({
			format: cfg.format,
			fftSize: this.n,
			overlap,
		})
		this.floor = new NoiseFloor({
			fftSize: this.n,
			framesPerBlock:
				overlap > 0
					? Math.round(OVERLAP_EDOF_GAIN * this.framesPerBlock)
					: this.framesPerBlock,
			tauBlocks: Math.max(1, Math.round((FLOOR_TAU_S * 1000) / this.blockMs)),
		})
		this.spurs = new SpurMap({
			fftSize: this.n,
			minObservedMs: SPUR_MIN_OBSERVED_MS,
			onFraction: SPUR_ON_FRACTION,
			maxWidthBins: SPUR_MAX_WIDTH_BINS,
		})
		this.detector = new Detector({
			fftSize: this.n,
			hysteresisDb: cfg.hysteresisDb,
			faTargetPerMhzMin: cfg.faTargetPerMhzMin,
			pinnedK: cfg.thresholdDb,
			rbwHz: this.binHz,
			integrationMs: cfg.integrationMs,
		})
		this.shortDetector =
			shortMs === null
				? null
				: new Detector({
						fftSize: this.n,
						hysteresisDb: cfg.hysteresisDb,
						faTargetPerMhzMin: cfg.faTargetPerMhzMin,
						pinnedK: this.shortK,
						rbwHz: this.binHz,
						integrationMs: shortMs,
					})
		const idPrefix = trackIdPrefixes(cfg.sourceId, now())
		const maxTrackBlocks = Math.max(1, Math.ceil(cfg.maxTrackMs / this.blockMs))
		this.tracker = new Tracker({
			sourceId: cfg.sourceId,
			binHz: this.binHz,
			blockMs: this.blockMs,
			hangBlocks,
			maxTracks: Math.max(1, cfg.maxTracks - 1), // one slot is the wideband tracker's (P11)
			maxTrackBlocks,
			idPrefix: idPrefix.main,
		})
		this.wideband = new Tracker({
			sourceId: cfg.sourceId,
			binHz: this.binHz,
			blockMs: this.blockMs,
			hangBlocks,
			maxTracks: 1,
			maxTrackBlocks,
			idPrefix: idPrefix.wideband,
		})
		this.frameAcc = new Float64Array(this.n)
		this.blockAcc = new Float64Array(this.n)
		this.frameDb = new Float32Array(this.n)
		this.powerDb = new Float32Array(this.n)
		this.floorDb = new Float32Array(this.n)
		this.on = new Uint8Array(this.n)
		this.extra = new Uint8Array(this.n)
		this.learnMask = new Uint8Array(this.n)
		this.joined = new Uint8Array(this.n)
		this.lastTrackBins = new Uint8Array(this.n)
		this.exclusionMask = new Uint8Array(this.n)
		this.shortAcc = new Float64Array(this.n)
		this.shortRing = new Float64Array(this.n * Math.max(1, this.framesPerShort))
		this.shortDb = new Float32Array(this.n)
		this.shortOn = new Uint8Array(this.n)
		this.burstCount = new Uint8Array(this.n)
		this.burstPeakDb = new Float32Array(this.n).fill(NO_FLOOR_DBFS)
		this.burstCountDone = new Uint8Array(this.n)
		this.burstPeakDone = new Float32Array(this.n).fill(NO_FLOOR_DBFS)
		this.burstOn = new Uint8Array(this.n)
		this.mergedDb = new Float32Array(this.n)
		this.nextStatsAt = STATS_INTERVAL_S * this.fs
		this.blanker = new ImpulseBlanker({
			fftSize: this.n,
			usableStartBin: this.edgeBins,
			usableEndBin: this.n - this.edgeBins + 1,
			sampleRateHz: this.fs,
		})
		this.provisional = new ProvisionalSpurs({
			fftSize: this.n,
			windowMs: deps.provisionalWindowMs ?? PROVISIONAL_WINDOW_MS,
		})
		this.lineMask = new Uint8Array(this.n)
		this.lineScratch = new Uint8Array(this.n)
		this.lastActive = new Float64Array(this.n).fill(Number.NEGATIVE_INFINITY)
		const persisted = cfg.persistedEngine
		if (persisted) {
			this.floor.importState({ absoluteFloors: persisted.absoluteFloors })
			this.spurs.importState({ spurs: persisted.spurs })
			this.detector.importK(
				persisted.kByRange.map(e => ({
					key: `${e.startHz}:${e.endHz}`,
					k: e.k,
				})),
			)
			this.provisional.importState(persisted)
		}
	}

	handle(input: PipelineInput): PipelineEvent[] {
		this.out = []
		switch (input.kind) {
			case "bytes":
				this.onBytes(input.startSample, input.bytes)
				break
			case "gap":
				this.onGap(input.startSample, input.samples)
				break
			case "pending-epoch":
				this.onPending(input.pending)
				break
			case "new-stream":
				this.onNewStream(input)
				break
			case "masks": {
				const { kind: _kind, ...masks } = input
				this.masks = masks
				this.applyMasks()
				break
			}
			case "spectrum-feed":
				this.feed = input.enabled
				break
		}
		return this.out
	}

	exportEngineState(): EngineState {
		return {
			version: 1,
			absoluteFloors: this.floor.exportState().absoluteFloors,
			spurs: this.spurs.exportState().spurs,
			provisionalSpurs: this.provisional.exportState().provisionalSpurs,
			kByRange: this.detector.stats().map(s => {
				const r = parseKey(s.key)
				return { startHz: r.startHz, endHz: r.endHz, k: s.k }
			}),
		}
	}

	/**
	 * Spec § 4.9: the current epoch's artefacts as plain data (structured-clone safe, so the worker can
	 * post them) for the pure `artefactOf` (identify mode, § 10.8; Task 35a carries them to the main thread).
	 */
	artefactMasks(): ArtefactMasks {
		const report = this.blanker.rfi()
		const rfi = {
			active: report.active,
			periodMs: report.periodMs,
			blankedFrames: this.blanker.blankedFrames,
		}
		const base = {
			sourceId: this.cfg.sourceId,
			binHz: this.binHz,
			dcGuardHz: this.dcGuardHz,
			rfi,
		}
		const ep = this.ep
		if (!ep)
			return {
				...base,
				epoch: 0,
				centreHz: 0,
				usable: { startHz: 0, endHz: 0 },
				spurs: [],
				images: [],
				activity: [],
			}
		const n = this.n
		const lines = this.provisional.lines(ep.absKey)
		const spurs = lines.map(
			(l): ArtefactSpurLine => ({
				startHz: this.rfLow(ep, Math.max(0, l.startBin - 1)),
				endHz: this.rfLow(ep, Math.min(n, l.endBin + 1)),
				origin: l.comb ? "comb" : "provisional",
			}),
		)
		const baseband = new Uint8Array(n)
		this.spurs.mask(ep.absKey, baseband)
		for (const run of runsOf(baseband)) {
			// a promoted comb tooth is listed once, as its comb line
			if (
				lines.some(
					l =>
						l.comb &&
						l.startBin - 1 < run.endBin &&
						l.endBin + 1 > run.startBin,
				)
			)
				continue
			spurs.push({
				startHz: this.rfLow(ep, run.startBin),
				endHz: this.rfLow(ep, run.endBin),
				origin: "baseband",
			})
		}
		const horizon = this.lastActivityEnd - (ACTIVITY_HOLD_MS * this.fs) / 1000
		const active = new Uint8Array(n)
		for (let i = 0; i < n; i++)
			active[i] =
				(this.lastActive[i] ?? Number.NEGATIVE_INFINITY) >= horizon ? 1 : 0
		return {
			...base,
			epoch: ep.epoch,
			centreHz: ep.centreHz,
			usable: {
				startHz: this.rfLow(ep, this.edgeBins),
				endHz: this.rfLow(ep, n - this.edgeBins + 1),
			},
			spurs,
			images: this.imageTracks.map(t => ({
				centreHz: t.centreHz,
				obwHz: t.obwHz,
				partnerHz: 2 * ep.centreHz - t.centreHz,
			})),
			activity: runsOf(active).map(r => ({
				startHz: this.rfLow(ep, r.startBin),
				endHz: this.rfLow(ep, r.endBin),
			})),
		}
	}

	// ---- inputs ----

	private onBytes(startSample: number, bytes: Uint8Array): void {
		const samples = Math.floor(bytes.length / this.bytesPerSample)
		this.observedSamples += samples
		if (this.ep) {
			this.frames.push(startSample, bytes)
			this.drain()
			this.checkMarkerTimeout(startSample + samples)
			const run = this.frames.activeCounterRun
			if (run && run.samples > STUCK_TEST_MODE_S * this.fs) this.stuck = true
		}
		this.maybeStats()
	}

	private onGap(startSample: number, samples: number): void {
		this.observedSamples += samples
		this.gapSamples += samples
		this.frames.gap(startSample, samples)
		this.gaps.push({ start: startSample, end: startSample + samples })
		if (samples >= this.hangSamples) {
			this.emit(this.tracker.closeAll("gap"))
			this.emit(this.wideband.closeAll("gap"))
		}
		this.drain()
		this.checkMarkerTimeout(startSample + samples)
		this.maybeStats()
	}

	private onPending(p: PendingEpoch): void {
		this.checkRate(p.sampleRateHz)
		this.discardBlock()
		const staleRef =
			this.ep && p.centreChanged ? Uint8Array.from(this.lastTrackBins) : null
		this.lastTrackBins.fill(0)
		const epoch = p.epoch > this.epochCounter ? p.epoch : this.epochCounter + 1
		this.epochCounter = epoch
		const info = {
			stream: this.stream,
			epoch,
			centreHz: p.centreHz,
			tuningTrust: p.tuningTrust,
			...(p.verifiedFromSample !== undefined
				? { verifiedFromSample: p.verifiedFromSample }
				: {}),
		}
		this.emit(this.tracker.beginEpoch(info))
		this.emit(this.wideband.beginEpoch(info))
		this.ep = {
			epoch,
			stream: this.stream,
			centreHz: p.centreHz,
			tuningTrust: p.tuningTrust,
			absKey: this.absKey(p.gainKey),
			settledStart: null,
			settleMode: p.expectMarker ? "marker" : "timer",
			staleLeft: staleRef ? this.staleBlocksFor(p) : 0,
			staleRef,
		}
		this.startEpochState()
		this.resolving = p
		if (!p.expectMarker)
			this.resolve(
				p.commandSample + p.bufferedSamples + p.settleSamples,
				"timer",
			)
	}

	/** WG9 req 3.4: a non-scanner retune caps the stale discard at its own `staleMaxMs`. */
	private staleBlocksFor(p: PendingEpoch): number {
		if (p.staleMaxMs === undefined) return this.maxStaleBlocks
		return Math.min(this.maxStaleBlocks, Math.ceil(p.staleMaxMs / this.blockMs))
	}

	private onNewStream(
		input: Extract<PipelineInput, { kind: "new-stream" }>,
	): void {
		this.checkRate(input.sampleRateHz)
		this.discardBlock()
		this.emit(this.tracker.closeAll("gap"))
		this.emit(this.wideband.closeAll("gap"))
		this.frames = new FrameSource({
			format: this.cfg.format,
			fftSize: this.n,
			overlap: this.cfg.overlap ?? 0,
		})
		this.gaps = []
		this.resolving = null
		this.stream = input.stream
		this.lastTrackBins.fill(0)
		const epoch = ++this.epochCounter
		const info = {
			stream: input.stream,
			epoch,
			centreHz: input.centreHz,
			tuningTrust: input.tuningTrust,
		}
		this.emit(this.tracker.beginEpoch(info))
		this.emit(this.wideband.beginEpoch(info))
		this.ep = {
			epoch,
			stream: input.stream,
			centreHz: input.centreHz,
			tuningTrust: input.tuningTrust,
			absKey: this.absKey(input.gainKey),
			settledStart: 0,
			settleMode: "none",
			staleLeft: 0,
			staleRef: null,
		}
		this.startEpochState()
		this.out.push({
			kind: "epoch-started",
			epoch,
			startSample: 0,
			settleMode: "none",
		})
	}

	// ---- epoch resolution ----

	private checkRate(sampleRateHz: number): void {
		if (sampleRateHz !== this.fs) {
			throw new WaveKitError(
				`spectrum pipeline built for ${this.fs} S/s cannot take ${sampleRateHz} S/s`,
				"SCANNER_PIPELINE_RATE",
			)
		}
	}

	private absKey(gainKey: string): string {
		return `${this.fs}:${gainKey}:${this.n}`
	}

	private startEpochState(): void {
		const ep = this.ep
		if (!ep) return
		this.detector.reset()
		this.shortDetector?.reset()
		this.resetShort()
		this.resetArtefacts()
		this.floorReady = false
		this.prevPersistent = []
		this.alarmWaitedBlocks = 0
		this.floor.useKey(ep.absKey)
		this.applyMasks()
	}

	private checkMarkerTimeout(atSample: number): void {
		const p = this.resolving
		if (!p?.expectMarker || atSample < p.commandSample + p.markerTimeoutSamples)
			return
		this.resolve(
			Math.max(p.commandSample + p.bufferedSamples + p.settleSamples, atSample),
			"timer",
		)
	}

	private resolve(
		startSample: number,
		mode: SettleMode,
		markerRunSamples?: number,
	): void {
		this.resolving = null
		const ep = this.ep
		if (!ep) return
		ep.settledStart = startSample
		ep.settleMode = mode
		this.discardBlock()
		this.out.push(
			markerRunSamples === undefined
				? {
						kind: "epoch-started",
						epoch: ep.epoch,
						startSample,
						settleMode: mode,
					}
				: {
						kind: "epoch-started",
						epoch: ep.epoch,
						startSample,
						settleMode: mode,
						markerRunSamples,
					},
		)
	}

	private drain(): void {
		this.frames.drain(
			f => this.onFrame(f),
			r => this.onCounterRun(r),
		)
	}

	private onCounterRun(run: { startSample: number; endSample: number }): void {
		const samples = run.endSample - run.startSample
		this.gapSamples += samples
		if (samples > STUCK_TEST_MODE_S * this.fs) this.stuck = true
		const p = this.resolving
		if (p?.expectMarker && run.startSample >= p.commandSample) {
			this.resolve(run.endSample + p.pllSettleSamples, "marker", samples)
			return
		}
		this.gaps.push({ start: run.startSample, end: run.endSample }) // another engine's marker
	}

	// ---- frames and blocks ----

	private onFrame(f: Frame): void {
		const ep = this.ep
		if (!ep) return
		if (this.resolving) {
			this.checkMarkerTimeout(f.startSample)
			if (this.resolving) return
		}
		const s0 = ep.settledStart
		if (s0 === null || f.startSample < s0) return
		// A frame belongs to the block it starts in. After a seam (or with overlap) the last frame of a block
		// may overhang into the next one (same epoch only: frames before s0 are dropped above, and nothing
		// past a command is ever pushed before it).
		const bi = Math.floor((f.startSample - s0) / this.blockSamples)
		const blockEnd = s0 + (bi + 1) * this.blockSamples
		if (bi !== this.blockIndex) {
			if (this.blockFrames > 0) this.finishBlock()
			if (this.ep !== ep) {
				this.onFrame(f) // finishBlock raised an untracked-retune epoch that starts at or before f
				return
			}
			this.blockIndex = bi
		}
		this.fft.transform(f.re, f.im)
		this.frameAcc.fill(0)
		accumulateShiftedPower(f.re, f.im, this.frameAcc)
		this.blockClipped += f.clipped
		this.blockFrames++
		// § 4.9 (Task 7a): a blanked frame, or a pending one in an epoch's first block, is neither integrated,
		// short-pathed nor enveloped; the frame after it is a seam for shortFrame, so the 5 ms window restarts
		if (this.blanker.offer(this.frameAcc, f.startSample) === "keep") {
			for (let i = 0; i < this.n; i++)
				this.blockAcc[i] = (this.blockAcc[i] ?? 0) + (this.frameAcc[i] ?? 0)
			this.shortFrame(f.startSample)
			if (this.tracker.openCount > 0) {
				powerToDb(this.frameAcc, 1, this.frameDb)
				this.tracker.frame(this.frameDb, f.startSample)
			}
		}
		if (f.startSample + this.hop >= blockEnd) this.finishBlock()
	}

	/**
	 * Short path (spec § 4.10): the same frame powers (no extra FFT) summed over a sliding T_short window
	 * that is evaluated on every frame, so a burst is integrated whole wherever it starts, across a block
	 * edge too (fixed sub-blocks would split a straddling burst and dilute each half by up to 3 dB).
	 * O(N) per frame: a ring of the last framesPerShort frame powers and a running sum. The window
	 * restarts on a seam (a frame that does not follow its predecessor) and at each epoch.
	 */
	private shortFrame(startSample: number): void {
		const d = this.shortDetector
		if (!d) return
		if (startSample !== this.shortNext) this.resetShort()
		this.shortNext = startSample + this.hop
		const w = this.framesPerShort
		const base = this.shortSlot * this.n
		for (let i = 0; i < this.n; i++) {
			const p = this.frameAcc[i] ?? 0
			this.shortAcc[i] =
				(this.shortAcc[i] ?? 0) + p - (this.shortRing[base + i] ?? 0)
			this.shortRing[base + i] = p
		}
		this.shortSlot = (this.shortSlot + 1) % w
		if (this.shortSlot === 0) this.resumShort() // exact once per window: the running sum never drifts
		if (this.shortFill < w) this.shortFill++
		if (this.shortFill < w || !this.floorReady) return
		powerToDb(this.shortAcc, w, this.shortDb)
		d.detect(this.shortDb, this.floorDb, this.shortOn)
		for (let i = 0; i < this.n; i++) {
			const p = this.shortDb[i] ?? NO_FLOOR_DBFS
			if (p > (this.burstPeakDb[i] ?? NO_FLOOR_DBFS)) this.burstPeakDb[i] = p
			// on-window frames of this block (saturating; only the comparison with burstMaxOnFrames matters)
			if (this.shortOn[i] === 1 && (this.burstCount[i] ?? 0) < 255)
				this.burstCount[i] = (this.burstCount[i] ?? 0) + 1
		}
	}

	private resetShort(): void {
		this.shortRing.fill(0)
		this.shortAcc.fill(0)
		this.shortSlot = 0
		this.shortFill = 0
	}

	private resumShort(): void {
		this.shortAcc.fill(0)
		for (let s = 0; s < this.framesPerShort; s++) {
			const base = s * this.n
			for (let i = 0; i < this.n; i++)
				this.shortAcc[i] =
					(this.shortAcc[i] ?? 0) + (this.shortRing[base + i] ?? 0)
		}
	}

	private resetBlock(): void {
		this.blockAcc.fill(0)
		this.blockFrames = 0
		this.blockClipped = 0
		this.burstCount.fill(0) // the sliding window (shortAcc, shortRing) spans blocks and is not reset here
		this.burstPeakDb.fill(NO_FLOOR_DBFS)
		this.blanker.dropBlock()
	}

	private discardBlock(): void {
		this.resetBlock()
		this.blockIndex = -1
		this.noiseEdgeBlock = -1
	}

	private finishBlock(): void {
		const ep = this.ep
		const s0 = ep?.settledStart
		const frames = this.blockFrames
		if (!ep || s0 === null || s0 === undefined || frames === 0) {
			this.resetBlock()
			return
		}
		const blockStart = s0 + this.blockIndex * this.blockSamples
		const blockEnd = blockStart + this.blockSamples
		this.blocksSeen++
		for (const [id, t] of this.trackInfo) {
			if (t.closedBlock !== null && t.closedBlock < this.blocksSeen - 1)
				this.trackInfo.delete(id)
		}
		const gap =
			frames < this.expectedFrames ||
			this.gaps.some(g => g.start < blockEnd && g.end > blockStart)
		const overload =
			this.blockClipped / (frames * this.n) > this.cfg.clipFraction
		const blanking = this.blanker.endBlock(this.blockAcc) // § 4.9: blanked frames are not integrated
		powerToDb(this.blockAcc, blanking.integrated, this.powerDb)
		this.burstCountDone.set(this.burstCount)
		this.burstPeakDone.set(this.burstPeakDb)
		this.resetBlock()
		this.gaps = this.gaps.filter(g => g.end > blockEnd)

		this.extra.set(this.exclusionMask)
		this.spurs.mask(ep.absKey, this.extra)
		const masks = {
			dcGuardBins: this.dcBins,
			edgeBins: this.edgeBins,
			extra: this.extra,
		}
		this.detector.setMasks(masks)
		this.shortDetector?.setMasks(masks)
		const unmasked = this.detector.unmasked()
		const blockFloor = this.floor.blockFloor(this.powerDb, unmasked)
		const effective = this.floor.effectiveFloor(blockFloor, ep.absKey)
		this.floor.perBinFloor(this.floorDb, effective)
		this.floorReady = true
		// recordNoiseEdges assumes adjacent blocks: after a skipped, stale, gap, overload or excluded block, start afresh
		if (this.blockIndex !== this.noiseEdgeBlock + 1) this.detector.reset()
		this.detector.detect(this.powerDb, this.floorDb, this.on)
		const k = this.detector.kFor(this.n / 2)
		const floorOccupied = this.floor.occupied(blockFloor, k, ep.absKey)
		const segOpts: SegmentOptions = {
			gapBins: this.gapBins,
			usableStartBin: this.edgeBins,
			usableEndBin: this.n - this.edgeBins + 1,
			exclusionEdges: this.exclusionEdges,
			rasterBinEdges: this.rasterEdges,
			skirtDb: SKIRT_DB,
			inWindow: this.masks.inWindow,
			farSkirt: {
				reachBins: Math.floor(FAR_SKIRT_REACH_HZ / this.binHz),
				minDb: FAR_SKIRT_DB,
				dcBin: this.n / 2,
			},
		}
		const segs = this.withoutLines(
			ep,
			segment(this.on, this.powerDb, this.floorDb, segOpts),
		)

		if (ep.staleLeft > 0) {
			if (this.isStale(segs, ep)) {
				ep.staleLeft--
				this.staleAfterSettle++
				this.detector.reset()
				this.shortDetector?.reset()
				// the sliding short window spans blocks and frames stay contiguous through a stale discard: restart it,
				// or the first accepted block opens a burst ghost at the previous hop's emitters (spec § 4.6)
				this.resetShort()
				this.out.push({ kind: "stale-discard", epoch: ep.epoch, blocks: 1 })
				return
			}
			ep.staleLeft = 0
			ep.staleRef = null
		}

		const segRanges = segs.map(s => this.segmentRf(s, ep))
		let holdPersistent = false
		if (
			!gap &&
			!overload &&
			!blanking.excluded &&
			this.prevPersistent.length > 0
		) {
			const alarm = untrackedRetuneAlarm(this.prevPersistent, segRanges, {
				toleranceHz: this.binHz,
				visible: hz => this.visibleRf(hz, ep),
			})
			if (!alarm) this.alarmWaitedBlocks = 0
			else {
				let suspected = this.classify(ep, segRanges, alarm.deltaHz)
				if (suspected === "pending") {
					this.alarmWaitedBlocks++
					if (this.alarmWaitedBlocks > this.alarmWaitBlocks)
						suspected = "external-control"
				}
				if (suspected !== "pending") this.alarmWaitedBlocks = 0
				if (suspected === "pending") {
					// WG10 R1 M2: wait for the strong track's close (positive end evidence); the old
					// features stay the reference so the next block is judged against them.
					holdPersistent = true
				} else if (suspected === "signal-change") {
					// No new epoch: the ended transmission's features leave the persistent set
					// (held through this block so its trailing edge does not fire again).
					holdPersistent = true
					const gone = new Set(
						vanishedFeatures(this.prevPersistent, segRanges, {
							toleranceHz: this.binHz,
							visible: hz => this.visibleRf(hz, ep),
						}),
					)
					this.prevPersistent = this.prevPersistent.filter(f => !gone.has(f))
					this.out.push({
						kind: "untracked-retune",
						epoch: ep.epoch,
						startSample: blockEnd,
						deltaHz: null,
						suspected,
						newEpoch: false,
					})
				} else {
					// WG10 R1 M1: a suspected byte slip is only a label. A dense-band retune can look
					// mirrored, and an automatic one-byte re-align on an aligned stream would swap
					// I/Q for good: every alarm but signal-change is the frozen untracked epoch.
					this.startUntrackedEpoch(ep, blockEnd, alarm.deltaHz, suspected)
					return
				}
			}
		}

		const learn = !gap && !overload
		if (learn && !blanking.excluded) {
			for (let i = 0; i < this.n; i++)
				this.learnMask[i] = unmasked[i] === 1 && this.on[i] !== 1 ? 1 : 0
			this.floor.update(
				this.powerDb,
				this.learnMask,
				segs.length === 0,
				ep.absKey,
			)
			this.spurs.observe(
				ep.absKey,
				{ epoch: ep.epoch, centreHz: ep.centreHz, binHz: this.binHz },
				this.on,
				this.blockMs,
			)
			this.observeLines(ep)
		}
		const { trackSegs, burstSet } = this.mergeBursts(segs, segOpts)
		const block: TrackerBlock = {
			endSample: blockEnd,
			powerDb: burstSet.size > 0 ? this.mergedPower(burstSet) : this.powerDb,
			floorDb: this.floorDb,
			blockFloorDb: effective,
			thresholdDb: k,
			gap,
			overload,
			burstSegments: burstSet,
		}
		this.emit(this.tracker.flagSpurs(this.lineMask))
		this.noteActivity(trackSegs, blockEnd)
		this.emitWithImages(this.tracker.block(trackSegs, block), ep)
		this.emit(
			this.wideband.block(floorOccupied ? [this.widebandSegment()] : [], {
				...block,
				powerDb: this.powerDb,
			}),
		)
		this.tracker.trackBinsMask(this.lastTrackBins, 1)
		if (!gap && !overload && !blanking.excluded && !holdPersistent)
			this.prevPersistent = this.persistentFeatures(segRanges, ep)
		if (learn) {
			this.tracker.trackBinsMask(this.joined, 2)
			let usable = 0
			for (let i = 0; i < this.n; i++) usable += unmasked[i] ?? 0
			if (!blanking.excluded) {
				this.detector.recordNoiseEdges(
					this.on,
					this.joined,
					this.blockMs / 60_000,
					(usable * this.binHz) / 1e6,
				)
				this.noiseEdgeBlock = this.blockIndex
			}
			this.settledSamples += this.blockSamples
		}
		if (overload) this.overloadedBlocks++
		this.lastFloorDbfs = effective
		if (this.feed) {
			this.out.push({
				kind: "block-summary",
				summary: this.summary(
					ep,
					blockEnd,
					effective,
					k,
					trackSegs,
					floorOccupied,
					overload,
					burstSet,
				),
			})
		}
	}

	/**
	 * Spec § 4.10: short-path segments that were on for ≤ BURST_MAX_ON_MS (≤ burstMaxOnFrames on-window
	 * frames in the block) and are either unseen by the long path or ≥ BURST_DILUTION_DB stronger than its
	 * peak replace the overlapping long segments and are marked as bursts; everything else stays with the long path.
	 */
	private mergeBursts(
		segs: Segment[],
		segOpts: SegmentOptions,
	): { trackSegs: Segment[]; burstSet: Set<Segment> } {
		const burstSet = new Set<Segment>()
		if (!this.shortDetector) return { trackSegs: segs, burstSet }
		for (let i = 0; i < this.n; i++)
			this.burstOn[i] = (this.burstCountDone[i] ?? 0) > 0 ? 1 : 0
		const candidates = segment(
			this.burstOn,
			this.burstPeakDone,
			this.floorDb,
			segOpts,
		)
		if (candidates.length === 0) return { trackSegs: segs, burstSet }
		const replaced = new Set<Segment>()
		for (const b of candidates) {
			let onFrames = 0
			for (let i = b.startBin; i < b.endBin; i++)
				onFrames = Math.max(onFrames, this.burstCountDone[i] ?? 0)
			if (onFrames > this.burstMaxOnFrames) continue
			const overlapping = segs.filter(
				s => s.startBin < b.endBin && s.endBin > b.startBin,
			)
			const longPeak = overlapping.reduce(
				(m, s) => Math.max(m, s.peakDb),
				-Infinity,
			)
			if (longPeak > b.peakDb - BURST_DILUTION_DB) continue
			for (const s of overlapping) replaced.add(s)
			burstSet.add(b)
		}
		if (burstSet.size === 0) return { trackSegs: segs, burstSet }
		const trackSegs = [...segs.filter(s => !replaced.has(s)), ...burstSet].sort(
			(a, b) => a.startBin - b.startBin,
		)
		return { trackSegs, burstSet }
	}

	/** Block PSD for the tracker: long-path power, with the short-path max-hold over burst segments. */
	private mergedPower(burstSet: ReadonlySet<Segment>): Float32Array {
		this.mergedDb.set(this.powerDb)
		for (const b of burstSet) {
			for (
				let i = Math.max(0, b.startBin - SPEC_PAD_BINS);
				i < Math.min(this.n, b.endBin + SPEC_PAD_BINS);
				i++
			) {
				this.mergedDb[i] = this.burstPeakDone[i] ?? NO_FLOOR_DBFS
			}
		}
		return this.mergedDb
	}

	/** Spec §4.6: a segment at the baseband bins of a pre-epoch track that no known emitter explains. */
	private isStale(segs: Segment[], ep: EpochState): boolean {
		const ref = ep.staleRef
		if (!ref) return false
		for (const s of segs) {
			let overlaps = false
			for (let i = s.startBin; i < s.endBin && !overlaps; i++)
				overlaps = ref[i] === 1
			if (!overlaps) continue
			const rf = ep.centreHz + (s.centroidBin - this.n / 2) * this.binHz
			const explained = this.knownRf.some(
				k => Math.abs(k.rfHz - rf) <= Math.max(2 * this.binHz, k.obwHz / 2),
			)
			if (!explained) return true
		}
		return false
	}

	private segmentRf(s: Segment, ep: EpochState): SegmentRange {
		const rf = (bin: number): number =>
			ep.centreHz + (bin - this.n / 2) * this.binHz
		return {
			startHz: rf(s.startBin - 0.5),
			endHz: rf(s.endBin - 0.5),
			centreHz: rf(s.centroidBin),
		}
	}

	/**
	 * Inside the usable span, not masked (DC, exclusions, baseband spurs) and not on this block's spur lines:
	 * withoutLines drops provisional lines from the segments without masking them in the detector.
	 */
	private visibleRf(hz: number, ep: EpochState): boolean {
		const bin = Math.round((hz - ep.centreHz) / this.binHz + this.n / 2)
		if (bin < this.edgeBins || bin > this.n - this.edgeBins) return false
		return this.detector.unmasked()[bin] === 1 && this.lineMask[bin] !== 1
	}

	/** WG10 req 2.9: remembers each track's start and best SNR; closes age out after two blocks. */
	private noteTrack(t: TrackSnapshot, closed: boolean): void {
		const prev = this.trackInfo.get(t.trackId)
		this.trackInfo.set(t.trackId, {
			centreHz: t.centreHz,
			obwHz: t.obwHz,
			startSample: t.startSample,
			maxSnrDb: Math.max(prev?.maxSnrDb ?? -Infinity, t.maxBlockSnrDb),
			closedBlock: closed ? this.blocksSeen : null,
		})
	}

	/**
	 * WG10 req 2.9: classify a fired alarm. A vanished feature "ended" when it is a strong track
	 * that closed (WG10 R1 M2: an open track is no end evidence) or a track born within
	 * ALARM_CO_BIRTH_S of one (its images and intermodulation lines). Features without a track
	 * (RF carriers) never count. `pending`: signal-change once the open strong tracks near the
	 * vanished features close; the caller waits (bounded) for that close.
	 */
	private classify(
		ep: EpochState,
		segRanges: SegmentRange[],
		deltaHz: number | null,
	): AlarmSuspect | "pending" {
		const tol = this.binHz
		const visible = (hz: number): boolean => this.visibleRf(hz, ep)
		const vanished = vanishedFeatures(this.prevPersistent, segRanges, {
			toleranceHz: tol,
			visible,
		})
		const near = (f: PersistentFeature) =>
			[...this.trackInfo.values()].filter(
				t => Math.abs(t.centreHz - f.rfHz) <= Math.max(tol, t.obwHz / 2),
			)
		const tracks = [...this.trackInfo.values()]
		const closed = tracks.filter(
			t => t.maxSnrDb >= ALARM_STRONG_SNR_DB && t.closedBlock !== null,
		)
		const open = tracks.filter(
			t =>
				t.maxSnrDb >= ALARM_STRONG_SNR_DB &&
				t.closedBlock === null &&
				vanished.some(f => near(f).includes(t)),
		)
		const coBirth = ALARM_CO_BIRTH_S * this.fs
		// Co-birth is measured from the strong track's own start. A closed strong track always
		// credits its co-born tracks; an open one (only for `pending`) never when it was born in
		// the epoch's first ALARM_CO_BIRTH_S (everything opens then).
		const startup = (ep.settledStart ?? 0) + coBirth
		const credits = (s: (typeof tracks)[number]): boolean =>
			s.closedBlock !== null || s.startSample > startup
		const judge = (strong: typeof tracks): AlarmSuspect =>
			classifyAlarm({
				features: this.prevPersistent,
				segments: segRanges,
				centreHz: ep.centreHz,
				toleranceHz: tol,
				visible,
				deltaHz,
				ended: f =>
					near(f).some(
						t =>
							strong.includes(t) ||
							strong.some(
								s =>
									credits(s) &&
									t.startSample >= s.startSample - coBirth &&
									t.startSample <= s.startSample + coBirth,
							),
					),
			})
		const now = judge(closed)
		if (now !== "external-control" || open.length === 0) return now
		return judge([...closed, ...open]) === "signal-change" ? "pending" : now
	}

	/** Long-lived tracks and RF-fixed carriers present in this block (spec § 4.7). */
	private persistentFeatures(
		segRanges: SegmentRange[],
		ep: EpochState,
	): PersistentFeature[] {
		const tol = this.binHz
		const out: PersistentFeature[] = this.tracker.longLived(
			PERSISTENT_TRACK_S * this.fs,
		)
		for (const c of this.spurs.rfCarriers()) {
			if (!this.visibleRf(c.rfHz, ep)) continue
			if (
				!segRanges.some(
					s => c.rfHz >= s.startHz - tol && c.rfHz <= s.endHz + tol,
				)
			)
				continue
			if (out.some(f => Math.abs(f.rfHz - c.rfHz) <= tol)) continue
			out.push({ rfHz: c.rfHz, widthHz: c.widthBins * this.binHz })
		}
		return out
	}

	/**
	 * Spec § 4.7: the scene moved without a command we saw. Close tracks ("retune"), start an
	 * unverified epoch at the end of the alarm block with the caps centre unchanged (Δ is reported,
	 * not applied), and announce it. Persistent features re-arm only after new 10 s tracks.
	 */
	private startUntrackedEpoch(
		ep: EpochState,
		startSample: number,
		deltaHz: number | null,
		suspected: AlarmSuspect,
	): void {
		const epoch = ++this.epochCounter
		const info = {
			stream: ep.stream,
			epoch,
			centreHz: ep.centreHz,
			tuningTrust: "unverified" as const,
		}
		this.emit(this.tracker.beginEpoch(info))
		this.emit(this.wideband.beginEpoch(info))
		this.ep = {
			...ep,
			epoch,
			tuningTrust: "unverified",
			settledStart: startSample,
			settleMode: "none",
			staleLeft: 0,
			staleRef: null,
		}
		this.blockIndex = -1
		this.noiseEdgeBlock = -1
		this.lastTrackBins.fill(0)
		this.startEpochState()
		this.out.push({
			kind: "untracked-retune",
			epoch,
			startSample,
			deltaHz,
			suspected,
		})
		this.out.push({
			kind: "epoch-started",
			epoch,
			startSample,
			settleMode: "none",
		})
	}

	/**
	 * Spec § 4.9: drops segments that lie wholly on a spur line (baseband, provisional or comb), ±1 bin of Hann skirt.
	 * Also drops segments that only hysteresis holds on (§ 4.5): no bin over floor + k in this block.
	 */
	private withoutLines(ep: EpochState, segs: Segment[]): Segment[] {
		this.lineScratch.fill(0)
		this.spurs.mask(ep.absKey, this.lineScratch)
		this.provisional.mask(ep.absKey, this.lineScratch)
		this.lineMask.fill(0)
		for (let i = 0; i < this.n; i++) {
			if (this.lineScratch[i] === 1)
				this.lineMask.fill(1, Math.max(0, i - 1), Math.min(this.n, i + 2))
		}
		return segs.filter(s => {
			if (!this.crossesK(s)) return false
			for (let i = s.startBin; i < s.endBin; i++)
				if (this.lineMask[i] !== 1) return true
			return false
		})
	}

	/**
	 * Hysteresis keeps an emission's bins on through a dip; it does not make an emission. Without this, the
	 * held noise bins just after an emission ends extend its track (diluting its mean PSD and OBW) or open
	 * ghost tracks that never crossed k (P4).
	 */
	private crossesK(s: Segment): boolean {
		for (let i = s.startBin; i < s.endBin; i++) {
			if (
				this.on[i] === 1 &&
				(this.powerDb[i] ?? -Infinity) >
					(this.floorDb[i] ?? 0) + this.detector.kFor(i)
			)
				return true
		}
		return false
	}

	/** Spec § 4.9 fast path: lines on ≥ 95 % for 30 s become provisional spurs; combs become baseband spurs at once. */
	private observeLines(ep: EpochState): void {
		const promoted = this.provisional.observe(
			ep.absKey,
			this.on,
			this.powerDb,
			this.detector.unmasked(),
			this.blockMs,
		)
		if (promoted.length > 0) this.spurs.promote(ep.absKey, this.binHz, promoted)
	}

	/** Bins of this block's tracked segments (after blanking and line filtering), for artefactMasks().activity. */
	private noteActivity(segs: readonly Segment[], blockEnd: number): void {
		for (const s of segs) this.lastActive.fill(blockEnd, s.startBin, s.endBin)
		this.lastActivityEnd = blockEnd
	}

	/** Epoch start: the blanker's reference, the activity and the image list describe the old window. */
	private resetArtefacts(): void {
		this.blanker.reset()
		this.lastActive.fill(Number.NEGATIVE_INFINITY)
		this.imageTracks = []
	}

	private rfiStats(): PipelineStats["broadbandRfi"] {
		const r = this.blanker.rfi()
		return r.active && r.periodMs !== null ? { periodMs: r.periodMs } : null
	}

	private widebandSegment(): Segment {
		const start = this.edgeBins
		const end = this.n - this.edgeBins + 1
		let peakBin = start
		let peakDb = -Infinity
		for (let i = start; i < end; i++) {
			const p = this.powerDb[i] ?? -Infinity
			if (p > peakDb) {
				peakDb = p
				peakBin = i
			}
		}
		return {
			startBin: start,
			endBin: end,
			peakBin,
			peakDb,
			centroidBin: this.n / 2,
			flags: { truncated: false, skirt: false, edge: true },
		}
	}

	private emit(events: PipelineEvent[]): void {
		const ep = this.ep
		for (const e of events) {
			if (
				ep &&
				(e.kind === "track-open" ||
					e.kind === "track-update" ||
					e.kind === "track-close")
			) {
				const t = e.track
				const bin = Math.round(
					(t.centreHz - ep.centreHz) / this.binHz + this.n / 2,
				)
				t.thresholdDb = t.flags.burst
					? this.shortK
					: this.detector.kFor(Math.min(this.n - 1, Math.max(0, bin)))
				if (Math.abs(t.centreHz - ep.centreHz) - t.obwHz / 2 < this.dcGuardHz)
					t.flags.obwBiased = true
				this.noteTrack(t, e.kind === "track-close")
				if (e.kind === "track-close" && t.blocks >= 2) {
					this.knownRf.push({ rfHz: t.centreHz, obwHz: t.obwHz })
					if (this.knownRf.length > KNOWN_RF_MAX) this.knownRf.shift()
				}
			}
			this.out.push(e)
		}
	}

	/**
	 * Spec § 4.9: flag IQ images among the open tracks in the block where both are open, so every
	 * snapshot of an image carries `iqImage` (events of this block are patched; tracks flagged now
	 * that emitted nothing this block get an immediate track-update).
	 */
	private emitWithImages(events: PipelineEvent[], ep: EpochState): void {
		const candidates = this.tracker.openCandidates()
		const images = flagIqImages(candidates, ep.centreHz, {
			rbwHz: this.binHz,
			toleranceHz: IMAGE_TOLERANCE_HZ,
			minRejectionDb: IMAGE_MIN_REJECTION_DB,
			maxRejectionDb: IMAGE_MAX_REJECTION_DB,
			dcGuardHz: this.dcGuardHz,
		})
		this.imageTracks = candidates
			.filter(c => images.has(c.trackId))
			.map(c => ({ centreHz: c.centreHz, obwHz: c.obwHz })) // § 4.9 artefact masks (Task 7a)
		if (images.size === 0) {
			this.emit(events)
			return
		}
		const raised = this.tracker.raiseFlag(images, "iqImage")
		const reported = new Set<string>()
		for (const e of events) {
			if (
				e.kind !== "track-open" &&
				e.kind !== "track-update" &&
				e.kind !== "track-close"
			)
				continue
			if (images.has(e.track.trackId)) e.track.flags.iqImage = true
			reported.add(e.track.trackId)
		}
		this.emit(events)
		for (const id of raised) {
			if (reported.has(id)) continue
			const track = this.tracker.snapshotOf(id)
			if (track) this.emit([{ kind: "track-update", track }])
		}
	}

	// ---- masks, summaries, stats ----

	private applyMasks(): void {
		const ep = this.ep
		if (!ep) return
		const n = this.n
		const c = ep.centreHz
		const binOf = (hz: number): number => (hz - c) / this.binHz + n / 2
		this.exclusionMask.fill(0)
		this.exclusionEdges = []
		for (const x of this.masks.exclusions) {
			const first = Math.max(0, Math.ceil(binOf(x.startHz)))
			const last = Math.min(n - 1, Math.floor(binOf(x.endHz)))
			if (first > last) continue
			this.exclusionMask.fill(1, first, last + 1)
			this.exclusionEdges.push(first, last + 1)
		}
		const lo = this.edgeBins
		const hi = n - this.edgeBins + 1
		const edges = new Set<number>()
		const half = this.fs / 2
		for (const r of this.masks.rasters) {
			if (r.spacingHz <= 0) continue
			const kFirst = Math.floor((c - half - r.firstChannelHz) / r.spacingHz) - 1
			const kLast = Math.ceil((c + half - r.firstChannelHz) / r.spacingHz) + 1
			for (let k = kFirst; k <= kLast; k++) {
				const b = Math.ceil(binOf(r.firstChannelHz + (k + 0.5) * r.spacingHz))
				if (b > lo && b < hi) edges.add(b)
			}
		}
		this.rasterEdges = [...edges].sort((a, b) => a - b)
		this.detector.setMasks({
			dcGuardBins: this.dcBins,
			edgeBins: this.edgeBins,
			extra: this.exclusionMask,
		})
		this.shortDetector?.setMasks({
			dcGuardBins: this.dcBins,
			edgeBins: this.edgeBins,
			extra: this.exclusionMask,
		})
		this.detector.setCfarRanges(this.cfarRanges(c))
	}

	/** Per-range CFAR buckets over the usable span: bandplan/job ranges first, else 2 MHz RF buckets. */
	private cfarRanges(centreHz: number): CfarRange[] {
		const out: CfarRange[] = []
		for (let i = this.edgeBins; i < this.n - this.edgeBins + 1; i++) {
			const rf = centreHz + (i - this.n / 2) * this.binHz
			const r = this.masks.cfarRanges.find(x => rf >= x.startHz && rf < x.endHz)
			const bucket = Math.floor(rf / CFAR_BUCKET_HZ) * CFAR_BUCKET_HZ
			const key = r
				? `${Math.round(r.startHz)}:${Math.round(r.endHz)}`
				: `${bucket}:${bucket + CFAR_BUCKET_HZ}`
			const burst = this.masks.burstRanges.some(
				x => rf >= x.startHz && rf < x.endHz,
			)
			const faTarget = r?.faTargetPerMhzMin
			const last = out.at(-1)
			if (
				last &&
				last.key === key &&
				last.burst === burst &&
				last.endBin === i &&
				last.faTarget === faTarget
			)
				last.endBin = i + 1
			else
				out.push({
					startBin: i,
					endBin: i + 1,
					key,
					burst,
					...(faTarget !== undefined ? { faTarget } : {}),
				})
		}
		return out
	}

	/** RF of the low edge of FFT-shifted `bin` in `ep` (a bin's centre sits half a bin above it). */
	private rfLow(ep: EpochState, bin: number): number {
		return ep.centreHz + (bin - this.n / 2 - 0.5) * this.binHz
	}

	private summary(
		ep: EpochState,
		endSample: number,
		floorDbfs: number,
		k: number,
		segs: Segment[],
		floorOccupied: boolean,
		overload: boolean,
		burstSet: ReadonlySet<Segment> = new Set(),
	): BlockSummary {
		const lo = this.edgeBins
		const hi = this.n - this.edgeBins + 1
		const d = Math.max(1, Math.ceil((hi - lo) / this.cfg.spectrumBins))
		const bins: number[] = []
		for (let a = lo; a < hi; a += d) {
			let m = -Infinity
			for (let i = a; i < Math.min(hi, a + d); i++)
				m = Math.max(m, this.powerDb[i] ?? -Infinity)
			bins.push(Math.round(m * 2) / 2)
		}
		// Baseband, provisional and comb spur bins as RF ranges (display only): the mask withoutLines built for this block.
		const spurRanges: FreqRange[] = runsOf(this.lineScratch).map(r => ({
			startHz: this.rfLow(ep, r.startBin),
			endHz: this.rfLow(ep, r.endBin),
		}))
		return {
			sourceId: this.cfg.sourceId,
			stream: ep.stream,
			epoch: ep.epoch,
			endSample,
			centreHz: ep.centreHz,
			sampleRateHz: this.fs,
			binHz: d * this.binHz,
			startHz: this.rfLow(ep, lo),
			bins,
			floorDbfs,
			thresholdDb: k,
			// WG11 req 5.1: the tracker's own association of each segment in this block (no geometry).
			tracks: segs.map(s => {
				const assoc = this.frameAssociation(s)
				// Surfaced rule uses the spectrum detection config's minSurfaceBlocks (the scanner may use runtime settings).
				return blockTrackOf(
					this.rfLow(ep, s.startBin),
					this.rfLow(ep, s.endBin),
					{
						burst: burstSet.has(s),
						iqImage: this.imageTracks.some(
							t =>
								t.centreHz >= this.rfLow(ep, s.startBin) &&
								t.centreHz <= this.rfLow(ep, s.endBin),
						),
						edge: s.flags.edge,
					},
					assoc,
					this.fs,
					this.cfg.minSurfaceBlocks,
				)
			}),
			masks: { dcHz: ep.centreHz, dcGuardHz: this.dcGuardHz, spurRanges },
			floorOccupied,
			overload,
		}
	}

	/**
	 * The tracker's association of a segment with the frame `trackId`: the tracker id without
	 * this pipeline's own `${sourceId}-` prefix (ids are `${sourceId}-${ms base36}-${seq base36}`,
	 * trackIdPrefixes), cut by its known length, never by a search in the id. The rest is
	 * `<8 base36>-<seq base36>` (8 chars until 2059), ≤ FRAME_TRACK_ID_MAX_CHARS = 30 while
	 * seq < 36^21, in the frame id charset. The spectrum service rebuilds the chain's current full id as
	 * `${frame.sourceId}-${trackerId ?? trackId}` for the identity lookup.
	 */
	private frameAssociation(s: Segment): TrackAssociation | null {
		const a = this.tracker.associationOf(s)
		if (a === null) return null
		a.trackId = a.trackId.slice(this.cfg.sourceId.length + 1)
		a.trackerId = a.trackerId.slice(this.cfg.sourceId.length + 1)
		if (
			!this.warnedTrackId &&
			(!isFrameTrackId(a.trackId) || !isFrameTrackId(a.trackerId))
		)
			this.warnTrackIdBound()
		return a
	}

	/** One fixed-text warning per pipeline (unreachable by the bound above); never echoes the id. */
	private warnTrackIdBound(): void {
		this.warnedTrackId = true
		this.logger ??= createComponentLogger(
			createLogger({ level: "warn" }),
			"SpectrumPipeline",
		)
		this.logger.warn(
			"track id suffixes exceed the frame track id bound; frame track fields omitted",
		)
	}

	private maybeStats(): void {
		if (this.observedSamples < this.nextStatsAt) return
		while (this.nextStatsAt <= this.observedSamples)
			this.nextStatsAt += STATS_INTERVAL_S * this.fs
		const stats: PipelineStats = {
			sourceId: this.cfg.sourceId,
			floorDbfs: this.lastFloorDbfs,
			absoluteFloorDbfs: this.ep
				? this.floor.absoluteFloor(this.ep.absKey)
				: null,
			kByRange: this.detector.stats().map(s => ({
				range: parseKey(s.key),
				k: s.k,
				faPerMhzMin: s.faPerMhzMin,
			})),
			overloadedBlocks: this.overloadedBlocks,
			gapSamples: this.gapSamples,
			staleAfterSettle: this.staleAfterSettle,
			stuckTestMode: this.stuck,
			settledSamples: this.settledSamples,
			observedSamples: this.observedSamples,
			blankedFrames: this.blanker.blankedFrames,
			broadbandRfi: this.rfiStats(),
		}
		this.out.push({ kind: "stats", stats })
		const run = this.frames.activeCounterRun
		this.stuck = run !== null && run.samples > STUCK_TEST_MODE_S * this.fs
	}
}
