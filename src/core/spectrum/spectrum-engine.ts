/**
 * One per source with at least one consumer (scanner jobs, `spectrum` WS
 * subscribers; spec § 3, § 4.1).
 * Owns the fanout branch `scanner-${sourceId}`, the absolute sample index of
 * each stream (received + dropped samples), the IQ ring, the pipeline host
 * and the epoch triggers (§ 4.6). Implements EpochClock for the arbiter.
 */
import { EventEmitter } from "node:events"
import { performance } from "node:perf_hooks"
import type { Readable } from "node:stream"
import { SPECTRUM_WARNING_LOG_INTERVAL_MS } from "@wavekit/api-types"
import type {
	SpectrumWarningSuspect,
	TunerCommandOrigin,
	TunerState,
} from "@wavekit/api-types"
import type { SourceCaps } from "../../config.js"
import type { BranchTelemetry, FanoutManager } from "../fanout-manager.js"
import type { SourceFanoutRouter } from "../source-fanout-router.js"
import type { SourceManager } from "../source-manager.js"
import type { TunerController } from "../tuner-controller.js"
import type {
	LedgerListener,
	TrustVerdict,
	TuningLedger,
} from "../tuning-ledger.js"
import { RetuneDelayMeter, type RetuneDelayStatus } from "./retune-delay.js"
import { createComponentLogger, type Logger } from "../../utils/logger.js"
import type { ChannelPlan } from "../scanner/scanner-redesign-contract.js"
import { WaveKitError } from "../../utils/errors.js"
import { defaultFftSize } from "./fft.js"
import { spectrumMainSpanSink } from "./pipeline.js"
import { PROFILE_BINS_FLOOR } from "./subscribe-options.js"
import type {
	CfarMaskRange,
	EngineState,
	FreqRange,
	IqFormat,
	PendingEpoch,
	PipelineConfig,
	PipelineEvent,
	PipelineStats,
	MaskRaster,
	SpectrumSettings,
	SettleMode,
	TrackSnapshot,
	TuningTrust,
	UntrackedRetuneEvent,
} from "./types.js"
import { bytesPerSample } from "./frame-source.js"
import type { ArtefactMasks } from "./artefacts.js"
import { IqRing } from "./iq-ring.js"
import type { WorkerPipelineInput } from "./worker-protocol.js"
import { blockSamplesOf, operatorRetuneTiming } from "./retune-settle.js"
import { alarmWaitBlocksOf } from "./retune-alarm.js"
import {
	createPipelineHost,
	type PipelineHost,
	type PipelineHostHandlers,
	type PipelineHostMode,
	type WorkerEluSample,
} from "./pipeline-host.js"

/** Pre-channelizer usable fraction of the captured span (§ 5.3): windows, hop plans, probes. */
export const USABLE_FRACTION = 0.8
/**
 * Fraction of the captured span the detector, segmenter and channel gate see. 0.95 of Nyquist is
 * ±486.4 kHz at 1.024 Msps (0.95 × 1 024 000 / 2 = 486 400 Hz), against ±409.6 kHz for
 * `USABLE_FRACTION` (0.8 × 512 000). On a private RTL capture the median noise floor fell only
 * 1.9 dB from mid-band to 0.93–0.95 of Nyquist (2.4 dB over the last 0.97–1.0), so this band is
 * still the dongle's flat-topped passband shoulder, not its anti-alias transition: the outermost
 * 5 % (25.6 kHz a side at 1.024 Msps) stays masked, where energy from just past Nyquist folds
 * back. The per-bin floor follows the gentle roll-off, so an SNR there means what it means
 * mid-band. Segments reaching past `USABLE_FRACTION` keep the `edge` flag (§ 6.2).
 */
export const DETECTION_USABLE_FRACTION = 0.95
export const SCANNER_BRANCH_HWM = 262_144
export const MAX_INFLIGHT_BYTES = 4 * 1024 * 1024
const DEFAULT_BATCH_BYTES = 131_072
const BATCH_FLUSH_MS = 20

/** Commands that change what the samples mean (§ 4.6). */
const EPOCH_COMMANDS: ReadonlySet<string> = new Set([
	"set-frequency",
	"set-sample-rate",
	"set-gain-mode",
	"set-gain",
	"set-freq-correction",
	"set-if-gain",
	"set-agc-mode",
	"set-direct-sampling",
	"set-offset-tuning",
	"set-rtl-xtal",
	"set-tuner-xtal",
	"set-tuner-gain-index",
	"set-tuner-if-gain",
])

const IQ_FORMATS: ReadonlySet<string> = new Set([
	"U8_IQ",
	"S16_IQ",
	"FLOAT32LE",
])

export interface EngineTuning {
	fftSize: number | null
	integrationMs: number | null
	thresholdDb: number | null
	sensitivity: "low" | "normal" | "high" | null
}

export const DEFAULT_TUNING: EngineTuning = {
	fftSize: null,
	integrationMs: null,
	thresholdDb: null,
	sensitivity: null,
}

export interface EngineEpoch {
	stream: number
	epoch: number
	startSample: number | null
	centreHz: number
	sampleRateHz: number
	gainKey: string
	/**
	 * The tuning ledger's label (the only one): on a data event (block summary, track, transient)
	 * the label of the samples it was measured on (SpectrumEngine.stamp); in `currentEpoch()` the
	 * label of the current epoch's newest block summary (`unverified` before its first); on a
	 * posted epoch's `epoch-started` whether the ledger holds this session's receipts of its centre
	 * and rate (proven or settling; a scanner hop's own frequency receipt), so its poster knows the
	 * epoch is its own; `unverified` on a stream opening and an untracked epoch, which are not
	 * tuning events.
	 */
	tuningTrust: TuningTrust
	settleMode: SettleMode | null
	/**
	 * In `currentEpoch()` only: the first sample of the current trusted run of this epoch (the
	 * start of the first trusted block summary since its last `unverified` one, or since the label
	 * last changed), null while `tuningTrust` is `unverified`. Nothing before it is trusted: a
	 * consumer reading back from the ring (a recording's pre-roll) starts no earlier.
	 */
	trustedFromSample?: number | null
	/**
	 * In `currentEpoch()` only: the newest trusted run of this epoch that ended (its first sample
	 * `from`, the `trustedFromSample` it was read with, and `end`, the first sample after it: the
	 * start of the block that read `unverified` or changed the label), null before any ended. A
	 * consumer holding samples of run `from` keeps none at or past `end`, however late it sees the
	 * run change.
	 */
	runEnd?: { from: number; end: number } | null
	/**
	 * On an `epoch-started` event only, never in `currentEpoch()`: the id its poster was given
	 * (`allocateEpoch`) when the pipeline started it as another (it numbers a post
	 * `max(id, last + 1)`, so an untracked epoch it started first moves it).
	 */
	requestedEpoch?: number
	/**
	 * On a stream opening's `epoch-started` only: a scanner hop the pipeline restart before this
	 * stream dropped unstarted (submitted while the pipeline restarted, or still pending in the
	 * old pipeline). Its poster learns its hop never started and re-sends it (no dwell credit).
	 */
	supersededEpoch?: number
}

export interface EngineMasks {
	exclusions: FreqRange[]
	/** SF1: per-range false-alarm target optional (CfarMaskRange). */
	cfarRanges: CfarMaskRange[]
	burstRanges: FreqRange[]
	rasters: MaskRaster[]
	obwHz: number[]
	/** True while no sweep lease holds the source (§ 6.2: truncated segments report as `edge`). */
	inWindow: boolean
}

/** Trust warning (§ 4.7): the pipeline's untracked retune, or a host-reported centre mismatch. */
export interface EngineWarning {
	code: "untracked-retune" | "host-centre-mismatch"
	deltaHz: number | null
	at: number
	/** WG10 req 2.9: untracked-retune only. */
	suspected?: SpectrumWarningSuspect
	/** WG10 req 2.9: untracked-retune only; ms since this engine saw a command on the source, null when none. */
	lastCommandAgeMs?: number | null
}

const MAX_WARNINGS = 16

/** What the arbiter needs from the engine of a leased source (Task 33). */
export interface EpochClock {
	sampleClock(): {
		commandSample: number
		bufferedSamples: number
		sampleRateHz: number
	}
	allocateEpoch(): number
	submitEpoch(pending: PendingEpoch): void
	/**
	 * The frequency receipt (TuningLedger seq) of the scanner hop submitted as `epoch`, or null when
	 * its frame got none: that epoch's samples are trusted only on a proof by this receipt.
	 * Optional: a clock without it never trusts a hop's samples.
	 */
	noteHopReceipt?(epoch: number, seq: number | null): void
	suppressExternal(on: boolean): void
	currentEpoch(): EngineEpoch
	readonly markerSupported: boolean | null
}

/** Host-side truth about the tuner centre (sdr-host status); null = unknown. */
export interface HostCentreReader {
	read(sourceId: string): Promise<number | null>
}

export const nullHostCentreReader: HostCentreReader = {
	read: () => Promise.resolve(null),
}

const HOST_CENTRE_TOLERANCE_HZ = 1000

/** Why a `"stream"` event fired: a new stream starts, or the engine stopped (the last stream ended). */
export type EngineStreamReason = "restart" | "stop"

export interface SpectrumEngineEvents {
	pipeline: (ev: PipelineEvent, epoch: EngineEpoch) => void
	/**
	 * `"restart"`: stream `stream` starts; emitted before its first pipeline event
	 * (start, reconnect boundary, rate change, reconfigure). `"stop"`: emitted by
	 * stop() after the last pipeline event, with the stream that ended.
	 */
	stream: (stream: number, reason: EngineStreamReason) => void
	error: (err: Error) => void
	warning: (code: EngineWarning["code"], deltaHz: number | null) => void
}

/** What the engine reads from the tuning ledger (its labels) and the doubts it raises. */
export type EngineLedger = Pick<
	TuningLedger,
	"trustAt" | "position" | "raiseDoubt" | "fieldState"
> &
	// Receipts feed the retune-delay measurement; a ledger without it measures nothing. A
	// detected scanner marker moves its hop's boundary earlier (lowerBoundary); without it, none.
	// A hop's epoch starts at its proof boundary (proofBoundary); without it, at its timer start.
	Partial<Pick<TuningLedger, "subscribe" | "lowerBoundary" | "proofBoundary">>

/**
 * Tuning-ledger diagnostics. Since trust step 3 the ledger's label is the engine's only label, so
 * there is no second label to disagree with: `agree` counts the block summaries labelled, the
 * disagreement counters stay 0 and `disagreements` empty (kept for the status shape).
 */
export interface EngineTrustShadow {
	agree: number
	ledgerStricter: number
	ledgerLooser: number
	mismatch: number
	/** The last SHADOW_DISAGREEMENTS disagreements, oldest first. */
	disagreements: EngineTrustDisagreement[]
	/**
	 * Measured delay from a centre or rate frame's flush to the first block showing it
	 * (retune-delay.ts): diagnostics for the settle, which it never changes.
	 */
	retuneDelay: RetuneDelayStatus
	/**
	 * Block summaries labelled `unverified`, by the first failing check: the engine's own
	 * (`no-anchor`, `upstream-loss`, `before-session`, `no-stream-map`, `session-ended`,
	 * `bad-range`, `no-ledger`, `no-epoch-record`, `value-mismatch`, `hop-receipt`) or the
	 * ledger's (`settling`, `doubt`, `no-receipt`, ...). At most UNVERIFIED_REASONS keys.
	 */
	unverifiedBlocks: Record<string, number>
	/** Bytes the absorber lost while anchored, by which the anchor was widened (upstreamLost). */
	anchorWidenedBytes: number
	/** Scanner hop boundaries a detected marker moved earlier (TuningLedger.lowerBoundary). */
	markerBoundaries: number
}

export interface EngineTrustDisagreement {
	kind: "ledger-stricter" | "ledger-looser" | "mismatch"
	at: number
	/** The ledger session and position bounds the block was read at (null: not mapped). */
	session: number | null
	posA: number | null
	posB: number | null
	engineTrust: TuningTrust
	ledgerTrust: TuningTrust
	engineCentreHz: number
	ledgerCentreHz: number | null
	engineSampleRateHz: number
	ledgerSampleRateHz: number | null
	/** Fixed code of the ledger's first failing check. */
	reason?: string
	/** The doubt's own fixed reason when `reason` is `doubt`. */
	doubtReason?: string
}

/** Where a ledger session's position 0 lies in a branch's offered bytes, as bounds. */
interface LedgerAnchor {
	session: number
	oLow: number
	oHigh: number
	/**
	 * The absorber's lost bytes when anchored or last widened: bytes lost after it make later
	 * offered bytes sit further on in the session, so the anchor widens by them (upstreamLost).
	 */
	lost: number | null
}

/**
 * Distinct `trustShadow.unverifiedBlocks` keys kept: the engine's ten codes and the ledger's
 * thirteen UnverifiedReason codes are 23; 32 leaves room and bounds a stray code (counted as
 * `other` once full).
 */
const UNVERIFIED_REASONS = 32

/** A ledger read of a sample range: the verdict and where it was read (null: not mapped). */
interface LedgerRead {
	verdict: Pick<
		TrustVerdict,
		"trust" | "frequency" | "sampleRate" | "doubtReason"
	> & {
		reason?: string
		receipts?: TrustVerdict["receipts"]
	}
	session: number | null
	posA: number | null
	posB: number | null
}

function unmappedRead(reason: string): LedgerRead {
	return {
		verdict: {
			trust: "unverified",
			frequency: null,
			sampleRate: null,
			reason,
		},
		session: null,
		posA: null,
		posB: null,
	}
}

/**
 * Started epochs whose centre, rate and hop the labels of late events still read (a thread host
 * delivers an older epoch's events after a newer one started). An event of an epoch no longer
 * kept reads `unverified`. 16: the pipeline holds at most one settling epoch and one stream
 * opening at a time, and a late event trails its epoch by at most the in-flight budget
 * (MAX_INFLIGHT_BYTES 4 MiB ≈ 0.87 s at 2.4 Msps U8), in which a sweep at the fastest local
 * settle (300 ms) starts 3 epochs: 16 keeps five times that.
 */
const EPOCH_RECORDS = 16

/**
 * Scanner hops whose frequency receipt is kept (noteHopReceipt): 64, the arbiter's own-epoch
 * memory (JobRunner keeps its last 64 epoch ids), of which only the newest few still label data.
 */
const HOP_RECEIPTS = 64

/** A started epoch as the labels read it. `hop`: a scanner hop's posted id (its receipt key). */
interface EpochRecord {
	stream: number
	epoch: number
	centreHz: number
	sampleRateHz: number
	hop: number | null
	/**
	 * Start sample of this epoch's current trusted run of block summaries (null: its newest block
	 * read `unverified`, or none yet) and that run's label (`currentEpoch().trustedFromSample`).
	 */
	trustedFrom: number | null
	trustedLabel: TuningTrust
	/** End sample of the current trusted run's newest block (the run's exact end), or null. */
	trustedEnd: number | null
	/** The newest trusted run of this epoch that ended (`currentEpoch().runEnd`), or null. */
	runEnd: { from: number; end: number } | null
}

/**
 * Tracks whose frequency measurement the engine asked the pipeline to restart (measure-from):
 * the pipeline's track cap (buildPipelineConfig maxTracks 512), so every open track fits.
 */
const MEASURE_REQUESTS = 512

function writableBacklog(stream: Readable | undefined): number {
	const length = (stream as { writableLength?: unknown } | undefined)
		?.writableLength
	return typeof length === "number" && Number.isFinite(length) ? length : 0
}

/** Engine streams whose sample-to-branch-byte map is kept for late block summaries. */
const SHADOW_STREAM_MAPS = 4

export interface SpectrumEngineDeps {
	sourceId: string
	sources: Pick<SourceManager, "getCaps" | "getStream"> &
		Partial<Pick<SourceManager, "tuningLedger">> &
		Pick<EventEmitter, "on" | "off">
	routing: Pick<SourceFanoutRouter, "getFanout" | "releaseUnused"> &
		Partial<Pick<SourceFanoutRouter, "ingestCounters">>
	/** The tuning ledger; absent = `sources.tuningLedger` (the real SourceManager's), else none. */
	ledger?: EngineLedger | null
	/**
	 * Commands and relay changes post DSP epochs (a centre change resets tracks); gain keys come
	 * from its state. It never decides a label: labels are the tuning ledger's.
	 */
	tuner:
		| (Pick<TunerController, "getState"> & Pick<EventEmitter, "on" | "off">)
		| null
	settings: () => SpectrumSettings
	/** WG8: the resolved, validated bins cap (SpectrumService). Absent = the 2 048 floor. */
	binsCap?: () => number
	tuning?: () => EngineTuning
	logger: Logger
	host?: PipelineHostMode
	workerUrl?: URL
	persistedEngine?: EngineState
	createHost?: (
		cfg: PipelineConfig,
		handlers: PipelineHostHandlers,
	) => PipelineHost
	batchBytes?: number
	hostCentre?: HostCentreReader
	hostCentrePollMs?: number
	/** WG10 req 2.9: clock for warning times, command ages and the warn-log interval (default Date.now). */
	now?: () => number
	/** Opt-in worker stage profile. Absent: export-state has no `profile` key. */
	profile?: { sampleEvery: number }
}

/**
 * Process-wide opt-in for a bench that cannot pass `profile` through ScannerService.
 * Absent by default, so production hosts send the same init message as before.
 */
let installedProfile: { sampleEvery: number } | undefined
let installedWorkerUrl: URL | undefined

export function installSpectrumPipelineProfile(
	profile: { sampleEvery: number } | undefined,
): void {
	installedProfile = profile
}

/** Overrides the worker script URL when the caller cannot pass `workerUrl` on the engine. */
export function installSpectrumWorkerUrl(url: URL | undefined): void {
	installedWorkerUrl = url
}

export function isScannerIqFormat(
	caps: SourceCaps | undefined,
): caps is SourceCaps & { format: IqFormat } {
	return (
		caps !== undefined &&
		(caps.kind === "iq" || caps.kind === "recording") &&
		IQ_FORMATS.has(caps.format)
	)
}

export function gainKeyOf(state: TunerState | undefined): string {
	if (!state) return "na"
	return state.gainMode === "manual" ? `m:${state.gain}` : "agc"
}

/**
 * False-alarm target (per MHz per minute) for a sensitivity preset.
 * `normal` keeps `settingsFa`; `low` is 0.25 and `high` is 2.
 */
export function faTargetForSensitivity(
	sensitivity: SpectrumSettings["detection"]["sensitivity"],
	settingsFa: number,
): number {
	if (sensitivity === "low") return 0.25
	if (sensitivity === "high") return 2
	return settingsFa
}

export function buildPipelineConfig(
	sourceId: string,
	format: IqFormat,
	sampleRateHz: number,
	s: SpectrumSettings,
	tuning: EngineTuning,
	persisted?: EngineState,
	/** WG8: the host bins cap; the summary budget is min(ws.spectrumSummaryBins, cap). Default: the floor. */
	binsCap: number = PROFILE_BINS_FLOOR,
): PipelineConfig {
	const sensitivity = tuning.sensitivity ?? s.detection.sensitivity
	const fftSize =
		tuning.fftSize ??
		(s.detection.fftSize === "auto"
			? defaultFftSize(sampleRateHz)
			: s.detection.fftSize)
	const integrationMs =
		tuning.integrationMs ??
		(sensitivity === "high" ? 100 : s.detection.integrationMs)
	const faTargetPerMhzMin = faTargetForSensitivity(
		sensitivity,
		s.detection.faTargetPerMhzMin,
	)
	return {
		sourceId,
		format,
		sampleRateHz,
		fftSize,
		integrationMs,
		usableFraction: DETECTION_USABLE_FRACTION,
		edgeFraction: USABLE_FRACTION,
		dcGuardHz: s.detection.dcGuardHz,
		ppmMargin: s.detection.ppmMargin,
		hysteresisDb: s.detection.hysteresisDb,
		clipFraction: s.detection.clipFraction,
		minSurfaceBlocks: s.detection.minSurfaceBlocks,
		thresholdDb: tuning.thresholdDb,
		faTargetPerMhzMin,
		spectrumBins: Math.min(s.ws.spectrumSummaryBins, binsCap), // engine summary budget; client bins are applied by SpectrumService (Task 37a)
		trackHangMs: 500,
		maxTracks: 512,
		maxTrackMs: 120_000,
		shortIntegrationMs: s.detection.shortIntegrationMs,
		overlap: s.detection.overlap,
		...(persisted ? { persistedEngine: persisted } : {}),
	}
}

interface Batch {
	buf: ArrayBuffer
	used: number
	start: number
}

/** A stream boundary queued at `atBranchByte`. */
interface StreamMark {
	kind: "stream"
	atBranchByte: number
}

/** Something that happens when the engine's branch byte counter reaches `atBranchByte`. */
type BranchMark =
	| { kind: "gap"; atBranchByte: number; droppedBytes: number }
	| StreamMark

/**
 * An operator, relay or host-centre command's DSP epoch still to be posted (`queueExternal`): a
 * centre change resets tracks and discards stale blocks. It carries no label.
 */
interface ExternalCommand {
	/** The centre a set-frequency command wrote (absent: the source's centre when posted). */
	centreHz?: number
}

/**
 * A pending epoch posted to the host whose start has not arrived yet, in post order. The
 * pipeline numbers it `max(key, last id + 1)` (SpectrumPipeline.onPending), so an untracked
 * epoch the engine had not heard of yet moves it, and the ones after it, to later ids: its
 * start is found by replaying that numbering over the queue (takeStart), so its poster is told
 * the id it was given (`requestedEpoch`). Naming only: no label depends on it.
 */
interface PendingStart {
	/** The id posted (`PendingEpoch.epoch`). */
	key: number
	/** A scanner hop (submitEpoch): its samples need its own frequency receipt. */
	hop: boolean
	meta: EngineEpoch
	/** PendingEpoch.proofSlackSamples posted with a marker hop (0: none). */
	proofSlack: number
}

export class SpectrumEngine extends EventEmitter implements EpochClock {
	readonly sourceId: string
	private readonly log: Logger
	private readonly branchId: string
	private readonly batchBytes: number
	private host: PipelineHost | null = null
	private cfg: PipelineConfig | null = null
	private fanout: Pick<
		FanoutManager,
		"addBranch" | "removeBranch" | "getBranchTelemetry" | "on" | "off"
	> | null = null
	private branch: Readable | null = null
	private ring: IqRing | null = null
	/** The ring's sample rate and capacity (samples), set with the ring. */
	private ringRateHz = 0
	private ringCapacity = 0
	/** Floor on the ring length from setRingSeconds (burst capture pre-roll); 0 = settings only. */
	private ringSecondsMin = 0
	private bps = 2
	private fmt: IqFormat = "U8_IQ"
	private running = false
	private failed = false
	private generation = 0
	private stopping: Promise<EngineState | null> | null = null
	private restarting = false
	private persisted: EngineState | undefined
	/**
	 * Learned state queued by swapLearnedState for the next host (undefined: fresh).
	 * Applied in createHost, so a restart already in flight picks it up too.
	 */
	private learnedSwap: { state: EngineState | undefined } | null = null
	// Stream and sample accounting
	private stream = -1
	private nextSample = 0
	private branchBytes = 0
	/** Branch byte position where the current (or last queued) stream starts. */
	private streamStartByte = 0
	private remainder = new Uint8Array(0)
	private skipBytes = 0
	private awaitingPayload = false
	private gapSamplesTotal = 0
	private workerDroppedSamples = 0
	/** Gaps and stream boundaries, ordered by the branch byte where they apply. */
	private readonly branchQueue: BranchMark[] = []
	/** Open fanout drop episode: accepted bytes at its start, dropped total at its start. */
	private bpMark: { atBranchByte: number; droppedAt: number } | null = null
	// Batching
	private batch: Batch | null = null
	private readonly pool: ArrayBuffer[] = []
	private inflightBytes = 0
	private flushTimer: NodeJS.Timeout | null = null
	// Epochs
	private lastEpoch = 0
	private suppressed = 0
	private externalPending:
		| (ExternalCommand & { commandSample: number; bufferedSamples: number })
		| null = null
	/** Pending epochs posted to the current host whose start has not arrived (PendingStart). */
	private readonly starts: PendingStart[] = []
	/**
	 * The newest scanner hop a pipeline restart dropped unstarted (its posted id); the next stream
	 * opening names it (`supersededEpoch`) so its job re-sends it. Null: none.
	 */
	private supersededLost: number | null = null
	/** The current host's last epoch id, from the events it has delivered (they arrive in order). */
	private startedThrough = 0
	/** The untracked epoch the pipeline just announced, until its own start. */
	private untrackedStart: EngineEpoch | null = null
	/** Started epochs, newest last (EPOCH_RECORDS): what late events are labelled against. */
	private readonly epochRecords: EpochRecord[] = []
	/** Scanner hop id → its frequency receipt seq, or null when it got none (HOP_RECEIPTS). */
	private readonly hopReceipts = new Map<number, number | null>()
	/**
	 * A marker-settled hop epoch whose frequency receipt was not noted yet: its marker lowers the
	 * receipt's boundary once noteHopReceipt names it (one at a time: the newest hop's).
	 */
	private markerPending: {
		hop: number
		stream: number
		sample: number
	} | null = null
	/** Hop boundaries lowered by a detected marker (`trustShadow.markerBoundaries`). */
	private markerBoundaries = 0
	/** The label of the current epoch's newest block summary (currentEpoch()). */
	private liveLabel: TuningTrust = "unverified"
	/**
	 * The ledger's label of a track's newest block, per (stream, epoch, lastSample): the tracks of
	 * one block share it, so one batch of events reads the ledger once per block. Cleared per batch
	 * and on every ledger change (a later receipt or doubt can change the verdict).
	 */
	private newestLabel: {
		stream: number
		epoch: number
		lastSample: number
		trust: TuningTrust
	} | null = null
	/** Track id → the sample its measurement was asked to restart from (MEASURE_REQUESTS). */
	private readonly measureRequests = new Map<string, number>()
	/**
	 * A command's DSP epoch held behind a queued stream boundary (flushExternal): posted once the
	 * last queued boundary is applied, at its receipt in the new stream.
	 */
	private externalAfterBoundary: ExternalCommand | null = null
	/** The newest centre or rate receipt the engine saw (where a held command's epoch starts). */
	private lastTuningReceipt: { session: number; pos: number } | null = null
	/** Block summaries labelled (status `trustShadow.agree`). */
	private labelledBlocks = 0
	/** Block summaries labelled `unverified`, by reason (`trustShadow.unverifiedBlocks`). */
	private readonly unverifiedBlocks = new Map<string, number>()
	/** Bytes the anchor was widened by for absorber loss (`trustShadow.anchorWidenedBytes`). */
	private anchorWidenedBytes = 0
	/** Why the current epoch's newest block reads `unverified` (labelReason), or null. */
	private liveReason: string | null = null
	/**
	 * Streams posted to the host whose own `epoch-started` (settleMode "none")
	 * has not arrived yet, in post order. A thread host can still deliver the
	 * old stream's events after a new-stream was posted.
	 */
	private readonly openingStreams: EngineEpoch[] = []
	private current: EngineEpoch
	private lastTunerKey: string | null = null
	private marker: boolean | null = null
	// Consumers
	private readonly taps = new Set<
		(startSample: number, bytes: Uint8Array) => void
	>()
	private masks: EngineMasks | null = null
	private channelPlan: ChannelPlan | null = null
	private channelPlanSet = false
	private spectrumFeed = false
	private lastStats: PipelineStats | null = null
	private readonly warningList: EngineWarning[] = []
	/** WG10 req 2.9: when this engine last saw a tuner command on its source (any origin). */
	private lastCommandAt: number | null = null
	/** WG10 req 2.9: warn-log rate limit (one line per interval, suppressed lines counted). */
	private warnLoggedAt: number | null = null
	private warnSuppressed = 0
	private centreOverride: number | null = null
	private hostTimer: NodeJS.Timeout | null = null
	// Tuning-ledger labels. Positions are mapped through the branch's offered bytes
	// (`totalBytesWritten`: accepted plus dropped, in source order), always as a lower bound for a
	// range's first byte and an upper bound for its end, so a label can only be stricter.
	/** Where the live ledger session's position 0 lies in offered branch bytes, as bounds. */
	private ledgerAnchor: LedgerAnchor | null = null
	/**
	 * Per engine stream: offered-byte bounds of its sample 0, gaps applied in it, and its own
	 * bytes per sample and block length (a late block of an older stream maps by its stream's).
	 */
	private readonly streamMaps: {
		stream: number
		oLow0: number
		oHigh0: number
		gaps: number
		bps: number
		blockSamples: number | null
		/**
		 * Blocks a lost alarm can reach back from this stream's newest summary: the pipeline's
		 * alarm wait (alarmWaitBlocksOf of the stream's config) + 2. A pending alarm fires
		 * alarmWaitBlocks + 1 blocks after its reference block, and may follow that block's
		 * summary, so the reference block starts alarmWaitBlocks + 2 blocks before the summary's
		 * end. Null with blockSamples.
		 */
		alarmReachBlocks: number | null
		/** End sample of this stream's newest block summary (0: none yet). */
		summarised: number
	}[] = []
	/**
	 * Accepted branch bytes up to the byte being handled, also inside a chunk (branchBytes keeps
	 * the chunk-start value there for its existing readers): the stream map reads this.
	 */
	private shadowBranchByte = 0
	/** Ledger position at the last host-centre poll that matched caps (lower bound of a move). */
	private hostCentreOkAt: { session: number; pos: number } | null = null
	/** Dropped branch bytes applied as gaps since the branch was created. */
	private appliedDropBytes = 0
	private readonly retuneDelay = new RetuneDelayMeter()
	private unsubscribeLedger: (() => void) | null = null

	constructor(private readonly deps: SpectrumEngineDeps) {
		super()
		this.sourceId = deps.sourceId
		this.branchId = `scanner-${deps.sourceId}`
		this.batchBytes = deps.batchBytes ?? DEFAULT_BATCH_BYTES
		this.persisted = deps.persistedEngine
		this.log = createComponentLogger(
			deps.logger,
			`SpectrumEngine:${deps.sourceId}`,
		)
		this.current = {
			stream: 0,
			epoch: 0,
			startSample: null,
			centreHz: 0,
			sampleRateHz: 0,
			gainKey: "na",
			tuningTrust: "unverified",
			settleMode: null,
		}
	}

	get format(): IqFormat {
		return this.fmt
	}

	get isRunning(): boolean {
		return this.running && !this.failed
	}

	get markerSupported(): boolean | null {
		return this.marker
	}

	/** A0 / `stuckTestMode` outcome for this source's transport (§ 4.6). */
	setMarkerSupported(value: boolean | null): void {
		this.marker = value
	}

	async start(): Promise<void> {
		if (this.running) return
		if (this.failed)
			throw new WaveKitError(
				"Spectrum engine failed; acquire a new instance",
				"SCANNER_ENGINE_FAILED",
			)
		const caps = this.deps.sources.getCaps(this.sourceId)
		if (!isScannerIqFormat(caps)) {
			throw new WaveKitError(
				`Source ${this.sourceId} is not an IQ source the scanner can read`,
				"SCANNER_SOURCE_NOT_IQ",
			)
		}
		this.fmt = caps.format
		this.bps = bytesPerSample(this.fmt)
		this.host = this.createHost(caps.sampleRate)
		this.running = true
		this.subscribe()
		const fanout = this.deps.routing.getFanout(this.sourceId)
		this.fanout = fanout
		fanout.on("backpressure", this.onBackpressure)
		fanout.on("drain", this.onDrain)
		const branch = fanout.addBranch({
			id: this.branchId,
			sourceId: this.sourceId,
			highWaterMark: SCANNER_BRANCH_HWM,
		})
		branch.on("data", this.onData)
		branch.on("error", this.onBranchError)
		this.branch = branch
		// A fresh branch counts from byte 0.
		this.branchBytes = 0
		this.shadowBranchByte = 0
		this.appliedDropBytes = 0
		this.streamMaps.length = 0
		this.anchorAtBranchStart()
		this.branchQueue.length = 0
		this.bpMark = null
		this.awaitingPayload = false
		this.streamStartByte = 0
		this.starts.length = 0
		this.supersededLost = null
		this.untrackedStart = null
		this.openingStreams.length = 0
		this.epochRecords.length = 0
		this.hopReceipts.clear()
		this.markerPending = null
		this.liveLabel = "unverified"
		this.liveReason = null
		this.newestLabel = null
		this.measureRequests.clear()
		this.externalAfterBoundary = null
		// No label and no settle: an engine start is not a tuning event (the ledger labels it).
		this.beginStream()
		const reader = this.deps.hostCentre ?? nullHostCentreReader
		if (reader !== nullHostCentreReader) {
			this.hostTimer = setInterval(
				() => void this.checkHostCentre(reader),
				this.deps.hostCentrePollMs ?? 5000,
			)
			this.hostTimer.unref()
		}
		this.log.info(
			{ format: this.fmt, sampleRateHz: caps.sampleRate },
			"Spectrum engine started",
		)
	}

	/** Stops the engine; returns the pipeline's engine state for persistence. */
	stop(): Promise<EngineState | null> {
		if (this.stopping) return this.stopping
		const stopping = this.stopOnce()
		this.stopping = stopping
		void stopping
			.finally(() => {
				if (this.stopping === stopping) this.stopping = null
			})
			.catch(() => undefined)
		return stopping
	}

	private async stopOnce(): Promise<EngineState | null> {
		if (!this.running) return null
		this.running = false
		if (this.hostTimer) clearInterval(this.hostTimer)
		this.hostTimer = null
		this.flushBatch()
		this.unsubscribe()
		if (this.flushTimer) clearTimeout(this.flushTimer)
		this.flushTimer = null
		if (this.branch) {
			this.branch.off("data", this.onData)
			this.branch.off("error", this.onBranchError)
		}
		if (this.fanout) {
			this.fanout.off("backpressure", this.onBackpressure)
			this.fanout.off("drain", this.onDrain)
			this.fanout.removeBranch(this.branchId)
		}
		this.deps.routing.releaseUnused(this.sourceId)
		this.branch = null
		this.fanout = null
		this.taps.clear()
		// S1-B final review, finding 9: a stopped engine holds no IQ ring (MBs per source).
		this.ring = null
		const host = this.host
		this.host = null
		let state: EngineState | null = null
		if (host) {
			state = await host.exportState().catch((err: unknown) => {
				this.log.warn({ err }, "Engine state export failed")
				return this.persisted ?? null
			})
			await host.close()
		}
		// After close: a worker delivers its last events before it exits (R2).
		this.emit("stream", this.stream, "stop")
		this.log.info(
			{ gapSamples: this.gapSamplesTotal },
			"Spectrum engine stopped",
		)
		return state
	}

	// === EpochClock ===

	sampleClock(): {
		commandSample: number
		bufferedSamples: number
		sampleRateHz: number
	} {
		const telemetry = this.fanout?.getBranchTelemetry(this.branchId)
		const sourceBuffered =
			this.deps.sources.getStream(this.sourceId)?.readableLength ?? 0
		const bufferedBytes =
			(telemetry?.bufferBytes ?? 0) + sourceBuffered + this.remainder.length
		return {
			commandSample: this.nextSample,
			bufferedSamples: Math.ceil(bufferedBytes / this.bps),
			sampleRateHz: this.cfg?.sampleRateHz ?? 0,
		}
	}

	allocateEpoch(): number {
		this.lastEpoch += 1
		return this.lastEpoch
	}

	/** A scanner hop (the arbiter): its samples are trusted only on its own frequency receipt. */
	submitEpoch(pending: PendingEpoch): void {
		this.postEpoch(pending, true)
	}

	noteHopReceipt(epoch: number, seq: number | null): void {
		if (!Number.isSafeInteger(epoch)) return
		this.hopReceipts.delete(epoch)
		this.hopReceipts.set(
			epoch,
			typeof seq === "number" && Number.isSafeInteger(seq) ? seq : null,
		)
		if (this.hopReceipts.size > HOP_RECEIPTS)
			this.hopReceipts.delete(this.hopReceipts.keys().next().value as number)
		const marker = this.markerPending
		if (marker?.hop === epoch) {
			this.markerPending = null
			if (typeof seq === "number") this.lowerHopBoundary(marker, seq)
		}
		// After the socket callback that noted it: an inline pipeline starts the epoch at once.
		if (typeof seq === "number")
			queueMicrotask(() => this.postProofFloor(epoch, seq))
	}

	/**
	 * A posted hop not started yet gets its proof floor: the first sample of its stream whose
	 * lowest possible ledger position is at or past the boundary its frequency receipt `seq` proves
	 * from (TuningLedger.proofBoundary). A timer hop starts there, so its first block is proven
	 * (PendingEpoch.awaitProofFloor). Nothing when it cannot be placed: the pipeline then starts
	 * the hop at its timer start, and the ledger labels its blocks as ever.
	 */
	private postProofFloor(epoch: number, seq: number): void {
		if (!this.running || !this.host || this.restarting) return
		const start = this.starts.find(e => e.key === epoch && e.hop)
		if (!start || start.meta.stream !== this.stream) return
		const ledger = this.ledger()
		const anchor = this.ledgerAnchor
		if (!ledger?.proofBoundary || !anchor) return
		let boundary: number | null
		try {
			boundary = ledger.proofBoundary(this.sourceId, anchor.session, seq)
		} catch {
			return
		}
		if (boundary === null) return
		const sample = this.firstSampleFrom(start.meta.stream, boundary)
		if (sample === null) return
		this.send({ kind: "proof-floor", epoch, sample })
	}

	/**
	 * The first sample `s` of engine stream `stream` whose lowest possible ledger position (the
	 * lower bound ledgerRange takes, `oLow0 + (s − gaps − 1) × bps − oHigh`) is at or past `pos`:
	 * `ceil((pos + oHigh − oLow0) / bps) + gaps + 1`. Null when unmapped.
	 */
	private firstSampleFrom(stream: number, pos: number): number | null {
		const anchor = this.ledgerAnchor
		if (!anchor || this.upstreamLost(anchor) || !Number.isFinite(pos))
			return null
		const map = this.streamMaps.find(m => m.stream === stream)
		if (!map || !Number.isFinite(map.oLow0) || !(map.bps > 0)) return null
		const sample =
			Math.ceil((pos + anchor.oHigh - map.oLow0) / map.bps) + map.gaps + 1
		return Number.isSafeInteger(sample) ? Math.max(0, sample) : null
	}

	/**
	 * Samples between one sample's highest and lowest possible ledger positions on engine stream
	 * `stream`, rounded up: upper(s) − lower(s) = (oHigh0 − oLow0) + (anchor.oHigh − anchor.oLow)
	 * + (gaps + 1) × bps bytes (ledgerRange and lowerHopBoundary). A marker hop that starts this
	 * many samples past the sample its boundary is lowered to has its first block proven. Null
	 * when unmapped.
	 */
	private mappingWidth(stream: number): number | null {
		const anchor = this.ledgerAnchor
		if (!anchor || this.upstreamLost(anchor)) return null
		const map = this.streamMaps.find(m => m.stream === stream)
		if (!map || !Number.isFinite(map.oLow0) || !Number.isFinite(map.oHigh0))
			return null
		if (!(map.bps > 0)) return null
		const bytes = map.oHigh0 - map.oLow0 + (anchor.oHigh - anchor.oLow)
		const width = Math.ceil(bytes / map.bps) + map.gaps + 1
		return Number.isSafeInteger(width) && width >= 0 ? width : null
	}

	/**
	 * A marker-settled hop epoch started at `sample` of `stream`: the hop's frequency frame took
	 * effect by then (the marker bracket ends after it), so the ledger may trust the hop's blocks
	 * from that sample on instead of the receipt plus the settle. The sample's position is taken
	 * by its upper bound (a block is trusted only when its lowest possible position is past the
	 * highest possible marker position); the ledger never lowers below the receipt itself.
	 */
	private lowerHopBoundary(
		at: { stream: number; sample: number },
		seq: number,
	): void {
		const ledger = this.ledger()
		const anchor = this.ledgerAnchor
		if (!ledger?.lowerBoundary || !anchor) return
		if (this.upstreamLost(anchor)) return
		const map = this.streamMaps.find(m => m.stream === at.stream)
		if (!map || !Number.isFinite(map.oHigh0)) return
		const live = ledger.position(this.sourceId)
		if (!live || live.session !== anchor.session) return
		const pos = Math.min(
			live.pos,
			map.oHigh0 + at.sample * map.bps - anchor.oLow,
		)
		try {
			if (ledger.lowerBoundary(this.sourceId, anchor.session, seq, pos)) {
				this.markerBoundaries += 1
				this.newestLabel = null
			}
		} catch {
			// A failing ledger lowers nothing: the settle boundary stands (fail closed).
		}
	}

	/** `hop`: a scanner hop (submitEpoch); else an engine-posted DSP epoch (flushExternal). */
	private postEpoch(pending: PendingEpoch, hop: boolean): void {
		if (!this.running || !this.host) return
		if (this.restarting) {
			// The old host can no longer take it: the restarted stream's opening names it, so its
			// job re-sends it (no held copy: the ledger, not the engine, keeps what was written).
			if (hop) this.supersededLost = pending.epoch
			return
		}
		if (pending.sampleRateHz !== this.cfg?.sampleRateHz) {
			this.log.info(
				{ from: this.cfg?.sampleRateHz, to: pending.sampleRateHz },
				"Sample rate change starts a new stream",
			)
			this.restartInBackground()
			return
		}
		this.flushBatch()
		// A hop starts at its proof boundary: a timer hop at its receipt's (postProofFloor), a
		// marker hop the mapping width past the marker start its boundary is lowered to.
		const ledger = this.ledger()
		let posted = pending
		if (hop && !pending.expectMarker && ledger?.proofBoundary)
			posted = { ...pending, awaitProofFloor: true }
		else if (hop && pending.expectMarker && ledger?.lowerBoundary) {
			const width = this.mappingWidth(this.stream)
			if (width !== null) posted = { ...pending, proofSlackSamples: width }
		}
		this.starts.push({
			key: pending.epoch,
			hop,
			proofSlack: posted.proofSlackSamples ?? 0,
			meta: {
				stream: this.stream,
				epoch: pending.epoch,
				startSample: null,
				centreHz: pending.centreHz,
				sampleRateHz: pending.sampleRateHz,
				gainKey: pending.gainKey,
				tuningTrust: "unverified",
				settleMode: null,
			},
		})
		this.send({ kind: "pending-epoch", pending: posted })
	}

	suppressExternal(on: boolean): void {
		this.suppressed = Math.max(0, this.suppressed + (on ? 1 : -1))
		if (!on && this.suppressed === 0) this.checkSuppressedCentre()
	}

	/**
	 * Takes the pending epoch the pipeline started as `epoch`. The pipeline handles posts in order
	 * and numbers each `max(key, last + 1)`; one still settling when the next post (or a
	 * new-stream) arrives never starts, and no untracked epoch starts while one settles, so after
	 * the last id the host delivered the next starts follow the queue in order. Replaying that
	 * numbering from `startedThrough` names the entry exactly; the ones before it never start.
	 * Only the current stream's entries can start before its next opening. Null when none
	 * matches: the queue no longer describes the host, so it is dropped (its epoch then has no
	 * poster: not a hop, so a hop's samples are never trusted on another epoch's start).
	 */
	private takeStart(epoch: number): PendingStart | null {
		let id = this.startedThrough
		let i = 0
		for (; i < this.starts.length; i++) {
			const entry = this.starts[i]!
			if (entry.meta.stream !== this.current.stream) break
			id = Math.max(entry.key, id + 1)
			if (id < epoch) continue
			if (id > epoch) break
			this.dropStarts(i)
			this.starts.shift()
			return entry
		}
		while (this.starts[i]?.meta.stream === this.current.stream) i += 1
		this.dropStarts(i)
		return null
	}

	/** Drops the first `count` pending starts, which never start. */
	private dropStarts(count: number): void {
		this.starts.splice(0, count)
	}

	/**
	 * The current epoch, labelled by its newest block summary (`unverified` before the first), with
	 * the start of its trusted run (`trustedFromSample`).
	 */
	currentEpoch(): EngineEpoch {
		const record = this.epochRecord(this.current.stream, this.current.epoch)
		const from =
			this.liveLabel === "unverified" ||
			!record ||
			record.trustedLabel !== this.liveLabel
				? null
				: record.trustedFrom
		return {
			...this.current,
			tuningTrust: this.liveLabel,
			trustedFromSample: from,
			runEnd: record?.runEnd ? { ...record.runEnd } : null,
		}
	}

	/**
	 * Why the current epoch's newest block summary reads `unverified` (a fixed code, see
	 * `trustShadow.unverifiedBlocks`; `no-block` for an epoch that has labelled none yet), or null
	 * while it is trusted or the engine has labelled no block since it started.
	 */
	labelReason(): string | null {
		return this.liveLabel === "unverified" ? this.liveReason : null
	}

	// === Consumers ===

	/** Absolute index of the next sample (the live edge) in the current stream. */
	liveEdge(): number {
		return this.nextSample
	}

	readRing(
		fromSample: number,
		toSample: number,
	): { startSample: number; bytes: Uint8Array } | null {
		return this.ring?.read(fromSample, toSample) ?? null
	}

	/** Live bytes after they reach the ring; returns an unsubscribe function. */
	tap(listener: (startSample: number, bytes: Uint8Array) => void): () => void {
		this.taps.add(listener)
		return () => this.taps.delete(listener)
	}

	/**
	 * Keeps at least `seconds` of IQ (burst capture pre-roll; 0 = the `ringSeconds` setting only).
	 * Resizes the current ring in place, keeping its newest contiguous samples.
	 */
	setRingSeconds(seconds: number): void {
		this.ringSecondsMin = seconds
		if (!this.ring || this.ringRateHz === 0) return
		const capacity = Math.max(
			1,
			Math.round(
				Math.max(this.deps.settings().ringSeconds, seconds) * this.ringRateHz,
			),
		)
		if (capacity === this.ringCapacity) return
		const newest = this.ring.newestSample
		const next = new IqRing({
			bytesPerSample: this.bps,
			capacitySamples: capacity,
		})
		const keep = this.ring.read(
			Math.max(this.ring.oldestSample, newest - capacity),
			newest,
		)
		if (keep) next.write(keep.startSample, keep.bytes)
		this.ring = next
		this.ringCapacity = capacity
	}

	setMasks(masks: EngineMasks): void {
		this.masks = masks
		this.send({ kind: "masks", ...masks })
	}

	setChannelPlan(plan: ChannelPlan | null): void {
		this.channelPlan = plan
		this.channelPlanSet = true
		this.send({ kind: "channel-plan", plan })
	}

	setSpectrumFeed(enabled: boolean): void {
		if (this.spectrumFeed === enabled) return
		this.spectrumFeed = enabled
		this.send({ kind: "spectrum-feed", enabled })
	}

	stats(): PipelineStats | null {
		return this.lastStats
	}

	config(): PipelineConfig | null {
		return this.cfg
	}

	/** Trust warnings, newest last (§ 4.7). */
	warnings(): EngineWarning[] {
		return this.warningList.map(w => ({ ...w }))
	}

	async exportState(): Promise<EngineState | null> {
		if (!this.host) return this.persisted ?? null
		return this.host.exportState()
	}

	/** The pipeline's artefact masks (§ 4.9) for identify (Task 35a); null without a pipeline or on a host error. */
	async artefactMasks(): Promise<ArtefactMasks | null> {
		const host = this.host
		if (!host?.artefactMasks) return null
		return host.artefactMasks().catch(() => null)
	}

	/** Worker utilisation since the pipeline started (§ 10.7 passive cost rule). */
	utilization(): number | null {
		return this.host?.utilization() ?? null
	}

	/**
	 * WG11 req 2.2: the current pipeline worker's raw cumulative event-loop sample; null without a
	 * pipeline or when not measurable (inline). A recreated pipeline starts a new cumulative sample
	 * under a new worker generation.
	 */
	eluSample(): WorkerEluSample | null {
		return this.host?.eluSample?.() ?? null
	}

	/**
	 * Replaces the learned state (spur map, floors, k, provisional spurs) with another
	 * receiver's, or with nothing (fresh). Resolves the state it replaced (for persisting under
	 * the previous receiver), or null when there was none. A running pipeline is recreated.
	 */
	async swapLearnedState(
		next: EngineState | null,
	): Promise<EngineState | null> {
		const previous = await this.exportState().catch(
			() => this.persisted ?? null,
		)
		const swap = { state: next ?? undefined }
		this.learnedSwap = swap
		// A restart already in flight may be past its createHost: wait for it (bounded, 100 x 20 ms
		// = 2 s, far above a pipeline restart) and restart again until this swap was applied.
		for (let i = 0; i < 100 && this.learnedSwap === swap; i++) {
			if (!this.host || !this.running || this.failed) break
			if (!this.restarting) await this.restartPipeline()
			else await new Promise(resolve => setTimeout(resolve, 20))
		}
		if (this.learnedSwap === swap) {
			// No pipeline (stopped, failed or not started): the next one starts from it.
			this.persisted = swap.state
			this.learnedSwap = null
		}
		return previous
	}

	/** Applies new tuning (fftSize, integration, k) by recreating the pipeline. */
	async reconfigure(): Promise<void> {
		await this.restartPipeline()
	}

	// === Internals: hosts and streams ===

	private createHost(sampleRateHz: number): PipelineHost {
		const tuning = this.deps.tuning?.() ?? DEFAULT_TUNING
		if (this.learnedSwap) {
			this.persisted = this.learnedSwap.state
			this.learnedSwap = null
		}
		const cfg = buildPipelineConfig(
			this.sourceId,
			this.fmt,
			sampleRateHz,
			this.deps.settings(),
			tuning,
			this.persisted,
			this.deps.binsCap?.(),
		)
		this.cfg = cfg
		// A new host's pipeline numbers its epochs from zero.
		this.startedThrough = 0
		const generation = ++this.generation
		const handlers: PipelineHostHandlers = {
			events: events => {
				if (generation === this.generation && !this.failed)
					this.onEvents(events)
			},
			buffer: buffer => {
				if (generation === this.generation) this.onBuffer(buffer)
			},
			fatal: err => {
				if (generation === this.generation) this.fail(err)
			},
			error: err => {
				if (generation !== this.generation || this.failed) return
				// A pipeline error can lose an untracked-retune alarm (Main decision Q2) of any sample
				// not reported yet.
				this.raisePipelineDoubt()
				this.log.error({ err }, "Spectrum pipeline error")
				this.emit("error", err)
			},
		}
		if (this.deps.createHost) return this.deps.createHost(cfg, handlers)
		const profile = this.deps.profile ?? installedProfile
		const workerUrl = this.deps.workerUrl ?? installedWorkerUrl
		return createPipelineHost(this.deps.host ?? "thread", cfg, handlers, {
			...(workerUrl ? { workerUrl } : {}),
			...(profile ? { profile } : {}),
			logger: this.deps.logger,
		})
	}

	private fail(err: Error): void {
		if (this.failed || !this.running) return
		this.raisePipelineDoubt()
		this.failed = true
		this.generation++
		this.lastStats = null
		this.current = {
			...this.current,
			startSample: null,
			tuningTrust: "unverified",
			settleMode: null,
		}
		this.liveLabel = "unverified"
		this.log.error({ err }, "Spectrum pipeline unavailable")
		if (this.listenerCount("error") > 0) this.emit("error", err)
		this.emit("fatal", err)
		void this.stop().catch((error: unknown) =>
			this.log.warn({ err: error }, "Fatal pipeline cleanup failed"),
		)
	}

	private async restartPipeline(): Promise<void> {
		if (this.failed || this.restarting || !this.host) return
		this.restarting = true
		this.flushBatch()
		const old = this.host
		try {
			this.persisted =
				(await old.exportState().catch(() => this.persisted)) ?? this.persisted
			await old.close()
			const caps = this.deps.sources.getCaps(this.sourceId)
			if (!this.running) return
			if (!isScannerIqFormat(caps)) {
				// The old host is closed and no new one can start: report it rather than run dead.
				const err = new WaveKitError(
					`Source ${this.sourceId} is no longer an IQ source the scanner can read`,
					"SCANNER_SOURCE_NOT_IQ",
				)
				this.fail(err)
				return
			}
			this.inflightBytes = 0
			this.pool.length = 0
			// The old host's pending epochs and stream starts never arrive.
			this.dropStarts(this.starts.length)
			this.untrackedStart = null
			this.openingStreams.length = 0
			this.host = this.createHost(caps.sampleRate)
			if (this.masks) this.send({ kind: "masks", ...this.masks })
			if (this.channelPlanSet)
				this.send({ kind: "channel-plan", plan: this.channelPlan })
			if (this.spectrumFeed) this.send({ kind: "spectrum-feed", enabled: true })
			this.restarting = false
			this.dropStaleBranchMarks()
			// A command held behind a boundary the restart discarded tuned what this stream opens at.
			if (!this.branchQueue.some(mark => mark.kind === "stream"))
				this.externalAfterBoundary = null
			// A restart is not a tuning event: the stream opens at the source's centre, labelled by
			// the ledger's receipts of its samples (a command during the restart is in caps by now).
			this.externalPending = null
			this.beginStream()
		} finally {
			this.restarting = false
		}
	}

	/** Restart from an event handler: a failure (e.g. the host cannot be created) becomes "error". */
	private restartInBackground(): void {
		this.restartPipeline().catch((err: unknown) => {
			const error =
				err instanceof Error
					? err
					: new WaveKitError(String(err), "SCANNER_PIPELINE_ERROR")
			this.fail(error)
		})
	}

	/** A new stream (engine start, pipeline restart, reconnect boundary): no label, no settle. */
	private beginStream(): void {
		this.flushBatch()
		const caps = this.deps.sources.getCaps(this.sourceId)
		const sampleRateHz = this.cfg?.sampleRateHz ?? caps?.sampleRate ?? 0
		this.stream += 1
		this.nextSample = 0
		this.remainder = new Uint8Array(0)
		this.skipBytes = 0
		this.mapStream()
		// The old stream's pending starts stay until this stream's own epoch-started (onEvents).
		// A command still pending tuned the old stream: this one opens at the source's centre.
		this.externalPending = null
		const ringSeconds = Math.max(
			this.deps.settings().ringSeconds,
			this.ringSecondsMin,
		)
		this.ringRateHz = sampleRateHz
		this.ringCapacity = Math.max(1, Math.round(ringSeconds * sampleRateHz))
		this.ring = new IqRing({
			bytesPerSample: this.bps,
			capacitySamples: this.ringCapacity,
		})
		const gainKey = gainKeyOf(this.deps.tuner?.getState(this.sourceId))
		this.lastEpoch += 1
		this.openingStreams.push({
			stream: this.stream,
			epoch: this.lastEpoch,
			startSample: null,
			centreHz: caps?.centerFreq ?? 0,
			sampleRateHz,
			gainKey,
			tuningTrust: "unverified",
			settleMode: null,
		})
		// Before new-stream: an inline pipeline answers it synchronously (R2).
		this.emit("stream", this.stream, "restart")
		this.send({
			kind: "new-stream",
			stream: this.stream,
			centreHz: caps?.centerFreq ?? 0,
			sampleRateHz,
			gainKey,
			tuningTrust: "unverified",
		})
	}

	private send(input: WorkerPipelineInput, transfer?: ArrayBuffer): void {
		if (!this.host) {
			if (transfer) this.onBuffer(transfer)
			return
		}
		this.host.send(input, transfer)
	}

	// === Internals: bytes, gaps and batches ===

	private readonly onData = (chunk: Buffer): void => {
		const sink = spectrumMainSpanSink()
		if (!sink) {
			this.consumeBranchChunk(chunk)
			return
		}
		const t0 = performance.now()
		try {
			this.consumeBranchChunk(chunk)
		} finally {
			sink("tap-feed", performance.now() - t0)
		}
	}

	private consumeBranchChunk(chunk: Buffer): void {
		// A branch can deliver synchronously in the trigger's own tick, before its microtask.
		if (this.externalPending) this.flushExternal()
		if (!this.running || this.restarting) {
			this.branchBytes += chunk.length
			this.shadowBranchByte = this.branchBytes
			return
		}
		let pos = this.branchBytes
		let off = 0
		while (off < chunk.length) {
			const mark = this.branchQueue[0]
			if (mark && mark.atBranchByte <= pos) {
				this.branchQueue.shift()
				// The shadow's stream map sees the branch position the mark applies at.
				this.shadowBranchByte = pos
				this.applyMark(mark)
				continue
			}
			const limit = mark
				? Math.min(chunk.length, off + (mark.atBranchByte - pos))
				: chunk.length
			this.ingest(chunk.subarray(off, limit))
			pos += limit - off
			off = limit
		}
		this.branchBytes = pos
		this.shadowBranchByte = pos
		this.applyDueMarks()
	}

	/** Applies queued gaps and stream boundaries the delivered bytes have reached. */
	private applyDueMarks(): void {
		if (!this.running || this.restarting) return
		while (
			this.branchQueue[0] &&
			this.branchQueue[0].atBranchByte <= this.branchBytes
		) {
			this.applyMark(this.branchQueue.shift()!)
		}
	}

	private applyMark(mark: BranchMark): void {
		if (mark.kind === "gap") this.applyGap(mark.droppedBytes)
		else {
			this.beginStream()
			if (!this.branchQueue.some(m => m.kind === "stream"))
				this.postHeldExternal()
		}
	}

	/** Bytes the fanout accepted into the branch so far (written minus dropped). */
	private acceptedBranchBytes(t: BranchTelemetry | undefined): number {
		return t ? t.totalBytesWritten - t.droppedBytesTotal : this.branchBytes
	}

	/**
	 * Starts a new stream at the branch byte the fanout has accepted so far:
	 * bytes still buffered in the branch finish the old stream. An open drop
	 * episode is split there, so each stream gets only its own dropped bytes.
	 */
	private queueStreamBoundary(): void {
		const t = this.fanout?.getBranchTelemetry(this.branchId)
		const at = this.acceptedBranchBytes(t)
		if (this.bpMark && t) {
			const dropped = t.droppedBytesTotal - this.bpMark.droppedAt
			if (dropped > 0) {
				this.branchQueue.push({
					kind: "gap",
					atBranchByte: this.bpMark.atBranchByte,
					droppedBytes: dropped,
				})
			}
			this.bpMark = { atBranchByte: at, droppedAt: t.droppedBytesTotal }
		}
		this.branchQueue.push({ kind: "stream", atBranchByte: at })
		this.streamStartByte = at
		this.applyDueMarks()
	}

	/**
	 * A stream started directly (pipeline restart) after the bytes up to
	 * `branchBytes` were discarded: marks at or before that point, and drops an
	 * open episode already counted, belong to the discarded segment.
	 */
	private dropStaleBranchMarks(): void {
		while (
			this.branchQueue[0] &&
			this.branchQueue[0].atBranchByte <= this.branchBytes
		) {
			this.branchQueue.shift()
		}
		const t = this.fanout?.getBranchTelemetry(this.branchId)
		if (this.bpMark && t) {
			this.bpMark = {
				atBranchByte: this.acceptedBranchBytes(t),
				droppedAt: t.droppedBytesTotal,
			}
		}
		this.streamStartByte = this.branchBytes
	}

	private ingest(input: Uint8Array): void {
		let bytes = input
		if (this.skipBytes > 0) {
			const n = Math.min(this.skipBytes, bytes.length)
			this.skipBytes -= n
			bytes = bytes.subarray(n)
		}
		if (this.remainder.length > 0) {
			const joined = new Uint8Array(this.remainder.length + bytes.length)
			joined.set(this.remainder, 0)
			joined.set(bytes, this.remainder.length)
			bytes = joined
			this.remainder = new Uint8Array(0)
		}
		const usable = bytes.length - (bytes.length % this.bps)
		if (usable < bytes.length)
			this.remainder = Uint8Array.from(bytes.subarray(usable))
		if (usable === 0) return
		const piece = bytes.subarray(0, usable)
		const start = this.nextSample
		this.ring?.write(start, piece)
		for (const listener of this.taps) listener(start, piece)
		this.appendBatch(start, piece)
		this.nextSample += usable / this.bps
	}

	/** `droppedBytes` were lost at the current position (fanout drop-on-congestion). */
	private applyGap(droppedBytes: number): void {
		this.appliedDropBytes += droppedBytes
		const map = this.streamMaps.at(-1)
		if (map?.stream === this.stream) map.gaps += 1
		const lost = droppedBytes + this.remainder.length
		this.remainder = new Uint8Array(0)
		const rem = lost % this.bps
		const samples = Math.ceil(lost / this.bps)
		this.skipBytes = rem === 0 ? 0 : this.bps - rem
		if (samples === 0) return
		this.markGap(samples)
	}

	private markGap(samples: number): void {
		this.flushBatch()
		const start = this.nextSample
		this.send({ kind: "gap", startSample: start, samples })
		this.ring?.markGap(start, samples)
		this.nextSample += samples
		this.gapSamplesTotal += samples
	}

	private appendBatch(start: number, piece: Uint8Array): void {
		let off = 0
		while (off < piece.length) {
			if (!this.batch) {
				const buf = this.takeBuffer()
				if (!buf) {
					// Worker is behind (> 4 MiB in flight): the worker gets a gap for
					// these samples; the ring and probe taps already have the bytes.
					this.flushBatch()
					const samples = (piece.length - off) / this.bps
					this.send({
						kind: "gap",
						startSample: start + off / this.bps,
						samples,
					})
					this.workerDroppedSamples += samples
					return
				}
				this.batch = { buf, used: 0, start: start + off / this.bps }
			}
			const space = this.batch.buf.byteLength - this.batch.used
			const n = Math.min(space, piece.length - off)
			new Uint8Array(this.batch.buf, this.batch.used, n).set(
				piece.subarray(off, off + n),
			)
			this.batch.used += n
			off += n
			if (this.batch.used === this.batch.buf.byteLength) this.flushBatch()
		}
		if (this.batch && !this.flushTimer) {
			this.flushTimer = setTimeout(() => {
				this.flushTimer = null
				this.flushBatch()
			}, BATCH_FLUSH_MS)
			this.flushTimer.unref()
		}
	}

	private takeBuffer(): ArrayBuffer | null {
		const pooled = this.pool.pop()
		if (pooled) return pooled
		if (this.inflightBytes + this.batchBytes > MAX_INFLIGHT_BYTES) return null
		return new ArrayBuffer(this.batchBytes)
	}

	private flushBatch(): void {
		if (this.flushTimer) {
			clearTimeout(this.flushTimer)
			this.flushTimer = null
		}
		const batch = this.batch
		this.batch = null
		if (!batch) return
		if (batch.used === 0) {
			this.pool.push(batch.buf)
			return
		}
		this.inflightBytes += batch.buf.byteLength
		this.send(
			{
				kind: "bytes",
				startSample: batch.start,
				bytes: new Uint8Array(batch.buf, 0, batch.used),
			},
			batch.buf,
		)
	}

	private onBuffer(buffer: ArrayBuffer): void {
		this.inflightBytes = Math.max(0, this.inflightBytes - buffer.byteLength)
		if (buffer.byteLength === this.batchBytes && this.pool.length < 32)
			this.pool.push(buffer)
	}

	private readonly onBackpressure = (branchId: string): void => {
		if (branchId !== this.branchId || !this.fanout) return
		const t = this.fanout.getBranchTelemetry(branchId)
		if (!t) return
		this.bpMark = {
			atBranchByte: t.totalBytesWritten - t.droppedBytesTotal,
			droppedAt: t.droppedBytesTotal,
		}
	}

	private readonly onDrain = (branchId: string): void => {
		if (branchId !== this.branchId || !this.fanout || !this.bpMark) return
		const t = this.fanout.getBranchTelemetry(branchId)
		const mark = this.bpMark
		this.bpMark = null
		if (!t) return
		const dropped = t.droppedBytesTotal - mark.droppedAt
		if (dropped <= 0) return
		this.branchQueue.push({
			kind: "gap",
			atBranchByte: mark.atBranchByte,
			droppedBytes: dropped,
		})
		this.applyDueMarks()
	}

	private readonly onBranchError = (err: Error): void => {
		this.log.warn({ err }, "Scanner branch error")
	}

	// === Internals: pipeline events ===

	private onEvents(events: PipelineEvent[]): void {
		this.newestLabel = null
		for (const ev of events) {
			if (ev.kind === "epoch-started") {
				this.lastEpoch = Math.max(this.lastEpoch, ev.epoch)
				let meta: EngineEpoch | null = null
				let start: PendingStart | null = null
				let posted = false
				if (this.untrackedStart?.epoch === ev.epoch) {
					// The untracked retune announced just before (below), under the pipeline's own id.
					meta = this.untrackedStart
					this.untrackedStart = null
				} else if (ev.settleMode !== "none") {
					// A posted pending epoch's start, found by the pipeline's numbering, never by key.
					start = this.takeStart(ev.epoch)
					meta = start?.meta ?? null
					posted = true
				} else {
					// A stream's own start: each new-stream is answered by exactly one, in order.
					meta = this.openingStreams.shift() ?? null
					// Epochs the older stream still had pending can no longer start.
					const stream = meta?.stream
					if (stream !== undefined) {
						let stale = 0
						while (
							this.starts[stale] &&
							this.starts[stale]!.meta.stream < stream
						)
							stale += 1
						this.dropStarts(stale)
					}
				}
				this.startedThrough = ev.epoch
				// Late old-stream events keep the old stream's centre (thread host).
				this.current = {
					...(meta ?? this.current),
					stream: meta?.stream ?? this.current.stream,
					epoch: ev.epoch,
					startSample: ev.startSample,
					settleMode: ev.settleMode,
					tuningTrust: "unverified",
				}
				if (ev.settleMode === "marker") this.marker = true
				const markerHop =
					ev.settleMode === "marker" && start?.hop === true ? start.key : null
				const record: EpochRecord = {
					stream: this.current.stream,
					epoch: ev.epoch,
					centreHz: this.current.centreHz,
					sampleRateHz: this.current.sampleRateHz,
					hop: start?.hop === true ? start.key : null,
					trustedFrom: null,
					trustedLabel: "unverified",
					trustedEnd: null,
					runEnd: null,
				}
				this.rememberEpoch(record)
				if (markerHop !== null) {
					// The marker start (run end + PLL settle), before the slack the hop was posted with.
					const at = {
						hop: markerHop,
						stream: record.stream,
						sample: Math.max(0, ev.startSample - (start?.proofSlack ?? 0)),
					}
					const seq = this.hopReceipts.get(markerHop)
					if (typeof seq === "number") this.lowerHopBoundary(at, seq)
					else if (seq === undefined) this.markerPending = at
				}
				this.liveLabel = "unverified"
				// No block of the new epoch is labelled yet: the old epoch's reason is not its.
				this.liveReason = "no-block"
				// Openings and untracked epochs are not tuning events: no claim.
				const claim =
					posted && meta !== null ? this.epochClaim(record) : "unverified"
				const superseded = ev.settleMode === "none" ? this.supersededLost : null
				if (superseded !== null) this.supersededLost = null
				this.emit("pipeline", ev, {
					...this.current,
					tuningTrust: claim,
					...(start && start.key !== ev.epoch
						? { requestedEpoch: start.key }
						: {}),
					...(superseded !== null ? { supersededEpoch: superseded } : {}),
				})
				continue
			} else if (ev.kind === "untracked-retune" && ev.newEpoch === false) {
				// WG10 req 2.9: a strong transmission ended: no epoch, warn only; not forwarded
				// (the scanner would re-send its hop for a retune that did not happen).
				this.warn(
					"untracked-retune",
					ev.deltaHz,
					ev.suspected ?? "signal-change",
				)
				continue
			} else if (ev.kind === "untracked-retune") {
				// § 4.7: the pipeline already started an unverified epoch (Task 10b); record it, post nothing.
				this.lastEpoch = Math.max(this.lastEpoch, ev.epoch)
				this.startedThrough = ev.epoch
				const caps = this.deps.sources.getCaps(this.sourceId)
				this.untrackedStart = {
					...this.current,
					epoch: ev.epoch,
					startSample: null,
					centreHz:
						this.centreOverride ?? caps?.centerFreq ?? this.current.centreHz,
					tuningTrust: "unverified",
					settleMode: null,
				}
				// Lower bound: the move lies after the start of the alarm's reference block (held
				// through a pending wait), mapped through the alarm's own stream (a late alarm can
				// belong to an older one; unmapped: the session start).
				this.ledger()?.raiseDoubt(
					this.sourceId,
					"both",
					"untracked-retune",
					this.alarmLowerBound(ev),
				)
				this.warn(
					"untracked-retune",
					ev.deltaHz,
					ev.suspected ?? "external-control",
				)
				this.emit("pipeline", ev, {
					...this.current,
					tuningTrust: "unverified",
				})
				continue
			} else if (ev.kind === "stats") {
				this.lastStats = ev.stats
				if (ev.stats.stuckTestMode) this.marker = false
			}
			this.emitLabelled(ev)
		}
	}

	/**
	 * Emits a pipeline event with the ledger's label of the samples it was measured on: a block
	 * summary its block, a track (open, update, close) the blocks its frequency was measured on
	 * (trackLabel), a transient the blocks around its sample. A track snapshot carries the same
	 * label. Other events carry the current epoch's label.
	 */
	private emitLabelled(ev: PipelineEvent): void {
		const epoch = { ...this.current, tuningTrust: this.liveLabel }
		switch (ev.kind) {
			case "block-summary": {
				const trust = this.labelBlock(ev)
				this.emit("pipeline", ev, { ...epoch, tuningTrust: trust })
				return
			}
			case "track-open":
			case "track-update":
			case "track-close": {
				const t = ev.track
				const trust = this.trackLabel(ev)
				const labelled =
					t.tuningTrust === trust
						? ev
						: { ...ev, track: { ...t, tuningTrust: trust } }
				this.emit("pipeline", labelled, { ...epoch, tuningTrust: trust })
				return
			}
			case "transient": {
				const record = this.epochRecord(this.current.stream, ev.epoch)
				const block = this.streamBlockSamples(this.current.stream)
				const trust =
					record === null || block === null
						? "unverified"
						: this.stamp(record, ev.sample - block, ev.sample + block)
				this.emit("pipeline", ev, { ...epoch, tuningTrust: trust })
				return
			}
			default:
				this.emit("pipeline", ev, epoch)
		}
	}

	/**
	 * A track's label: the ledger's over the blocks its frequency was measured on, from its first
	 * block (or, once the pipeline restarted its measurement, `measuredFromSample`) to its newest.
	 * Q3: a track on air across a proof boundary is never back-dated: when its newest block is
	 * trusted but not its whole measurement, the pipeline is asked to measure it again from that
	 * block (measure-from), and it is trusted once its frequency comes from proven samples only.
	 */
	private trackLabel(
		ev: Extract<
			PipelineEvent,
			{ kind: "track-open" | "track-update" | "track-close" }
		>,
	): TuningTrust {
		const t = ev.track
		const record = this.epochRecord(t.stream, t.epoch)
		const block = this.streamBlockSamples(t.stream)
		if (record === null || block === null) return "unverified"
		const newestFrom = t.lastSample - block
		const cached = this.newestLabel
		let newest: TuningTrust
		if (
			cached?.stream === t.stream &&
			cached.epoch === t.epoch &&
			cached.lastSample === t.lastSample
		)
			newest = cached.trust
		else {
			newest = this.stamp(record, newestFrom, t.lastSample)
			this.newestLabel = {
				stream: t.stream,
				epoch: t.epoch,
				lastSample: t.lastSample,
				trust: newest,
			}
		}
		if (newest === "unverified") return "unverified"
		// A restarted measurement with no whole block accumulated since (a track closing on the
		// block its restart was asked at) measured nothing proven: its frequency is no claim.
		if (
			t.measuredFromSample !== undefined &&
			t.lastSample - t.measuredFromSample < block
		)
			return "unverified"
		const from = Math.max(t.startSample, t.measuredFromSample ?? t.startSample)
		if (from >= newestFrom) return newest
		const whole = this.stamp(record, from, t.lastSample)
		if (whole !== "unverified") return whole
		if (ev.kind !== "track-close") this.requestMeasure(t, newestFrom, from)
		return "unverified"
	}

	/**
	 * Asks the pipeline to restart track `t`'s frequency measurement from `sample` (a proven block's
	 * start), once per request: again only after the last one took effect (`from`, the track's
	 * measurement start now, reached it).
	 */
	private requestMeasure(t: TrackSnapshot, sample: number, from: number): void {
		const asked = this.measureRequests.get(t.trackId)
		if (asked !== undefined && from < asked) return
		if (asked !== undefined) this.measureRequests.delete(t.trackId)
		this.measureRequests.set(t.trackId, sample)
		if (this.measureRequests.size > MEASURE_REQUESTS)
			this.measureRequests.delete(
				this.measureRequests.keys().next().value as string,
			)
		this.send({
			kind: "measure-from",
			stream: t.stream,
			epoch: t.epoch,
			trackId: t.trackId,
			sample,
		})
	}

	// === Internals: epoch triggers (§ 4.6, § 4.7) ===

	private subscribe(): void {
		this.deps.sources.on("disconnected", this.onDisconnected)
		this.deps.sources.on("payload-started", this.onPayloadStarted)
		this.deps.sources.on("session-started", this.onSessionStarted)
		this.deps.sources.on("caps-changed", this.onCapsChanged)
		this.unsubscribeLedger?.()
		this.unsubscribeLedger =
			this.ledger()?.subscribe?.(this.onLedgerChange) ?? null
		const tuner = this.deps.tuner
		if (tuner) {
			tuner.on("command-sent", this.onCommandSent)
			tuner.on("state-changed", this.onStateChanged)
			this.lastTunerKey = this.tunerKey(tuner.getState(this.sourceId))
		}
	}

	private unsubscribe(): void {
		this.deps.sources.off("disconnected", this.onDisconnected)
		this.deps.sources.off("payload-started", this.onPayloadStarted)
		this.deps.sources.off("session-started", this.onSessionStarted)
		this.deps.sources.off("caps-changed", this.onCapsChanged)
		this.unsubscribeLedger?.()
		this.unsubscribeLedger = null
		this.deps.tuner?.off("command-sent", this.onCommandSent)
		this.deps.tuner?.off("state-changed", this.onStateChanged)
	}

	private readonly onDisconnected = (sourceId: string): void => {
		if (sourceId !== this.sourceId || !this.running) return
		this.awaitingPayload = true
		this.queueStreamBoundary()
	}

	private readonly onPayloadStarted = (sourceId: string): void => {
		if (sourceId !== this.sourceId || !this.running) return
		if (this.awaitingPayload) {
			this.awaitingPayload = false
			return
		}
		// No disconnect seen: a new stream only if bytes arrived since the last one started.
		const accepted = this.acceptedBranchBytes(
			this.fanout?.getBranchTelemetry(this.branchId),
		)
		if (accepted > this.streamStartByte) this.queueStreamBoundary()
	}

	private readonly onCommandSent = (
		sourceId: string,
		command: string,
		value: number,
		origin?: TunerCommandOrigin,
	): void => {
		if (sourceId === this.sourceId) this.lastCommandAt = this.now()
		if (
			sourceId !== this.sourceId ||
			this.suppressed > 0 ||
			origin === "scanner"
		)
			return
		if (!EPOCH_COMMANDS.has(command)) return
		this.queueExternal(
			command === "set-frequency" && Number.isFinite(value) ? value : undefined,
		)
	}

	private readonly onStateChanged = (
		sourceId: string,
		state: TunerState,
	): void => {
		if (sourceId !== this.sourceId) return
		const key = this.tunerKey(state)
		const previous = this.lastTunerKey
		this.lastTunerKey = key
		if (this.suppressed > 0 || previous === null || previous === key) return
		if (state.controlMode === "external") this.queueExternal()
	}

	private readonly onCapsChanged = (
		sourceId: string,
		caps: SourceCaps,
	): void => {
		if (sourceId !== this.sourceId || !this.running) return
		if (caps.sampleRate !== this.cfg?.sampleRateHz) {
			if (this.suppressed === 0) this.queueExternal()
			return
		}
		if (this.suppressed > 0) return
		if (
			caps.centerFreq !== undefined &&
			caps.centerFreq !== this.expectedCentre()
		) {
			this.queueExternal()
		}
	}

	/**
	 * A write that landed inside the scanner's suppression window (a REST write during a retune)
	 * posted no epoch: when the window closes, a caps centre other than the latest submitted one
	 * (or the current epoch's) gets an external epoch.
	 */
	private checkSuppressedCentre(): void {
		if (!this.running || this.restarting) return
		const caps = this.deps.sources.getCaps(this.sourceId)
		if (caps?.centerFreq === undefined) return
		if (caps.centerFreq !== this.expectedCentre()) this.queueExternal()
	}

	/** The latest centre submitted or queued (current, opening streams, pending epochs, a queued command). */
	private expectedCentre(): number {
		let expected = this.current.centreHz
		for (const meta of this.openingStreams) expected = meta.centreHz
		for (const start of this.starts) expected = start.meta.centreHz
		const queued = this.externalPending?.centreHz
		return queued ?? expected
	}

	private tunerKey(state: TunerState | undefined): string | null {
		return state
			? `${state.frequency}:${state.sampleRate}:${gainKeyOf(state)}:${state.ppm}`
			: null
	}

	private now(): number {
		return this.deps.now?.() ?? Date.now()
	}

	private warn(
		code: EngineWarning["code"],
		deltaHz: number | null,
		suspected?: SpectrumWarningSuspect,
	): void {
		const at = this.now()
		const warning: EngineWarning = { code, deltaHz, at }
		if (suspected !== undefined) {
			warning.suspected = suspected
			warning.lastCommandAgeMs =
				this.lastCommandAt === null
					? null
					: Math.max(0, at - this.lastCommandAt)
		}
		this.warningList.push(warning)
		if (this.warningList.length > MAX_WARNINGS) this.warningList.shift()
		// WG10 req 2.9: one line per source per interval; the list above keeps every warning.
		if (
			this.warnLoggedAt !== null &&
			at - this.warnLoggedAt < SPECTRUM_WARNING_LOG_INTERVAL_MS
		) {
			this.warnSuppressed++
		} else {
			const fields: Record<string, unknown> = { code, deltaHz }
			if (suspected !== undefined) {
				fields["suspected"] = suspected
				fields["lastCommandAgeMs"] = warning.lastCommandAgeMs
			}
			if (this.warnSuppressed > 0) fields["suppressed"] = this.warnSuppressed
			this.log.warn(fields, "Spectrum engine trust warning")
			this.warnLoggedAt = at
			this.warnSuppressed = 0
		}
		this.emit("warning", code, deltaHz)
	}

	/** § 4.7: a host-reported centre that disagrees with caps makes new data unverified. */
	private async checkHostCentre(reader: HostCentreReader): Promise<void> {
		if (!this.running) return
		const reported = await reader.read(this.sourceId).catch(() => null)
		if (reported === null || !this.running) return
		const caps = this.deps.sources.getCaps(this.sourceId)?.centerFreq
		if (caps === undefined) return
		const mismatch = Math.abs(reported - caps) > HOST_CENTRE_TOLERANCE_HZ
		const ledger = this.ledger()
		if (!mismatch) {
			const overridden = this.centreOverride !== null
			this.centreOverride = null
			// The host matched now: a later move lies past what the core had forwarded by now.
			this.hostCentreOkAt = ledger?.position(this.sourceId) ?? null
			// The epoch posted at the host's centre ends: the next one follows caps again (otherwise
			// every block stays labelled against the reported centre, unverified for good).
			if (overridden) this.queueExternal()
			return
		}
		if (this.centreOverride === reported) return
		this.centreOverride = reported
		// Lower bound: the last poll that matched in this session, else the session start.
		const live = ledger?.position(this.sourceId) ?? null
		const ok = this.hostCentreOkAt
		ledger?.raiseDoubt(
			this.sourceId,
			"frequency",
			"host-centre-mismatch",
			ok && live && ok.session === live.session ? ok.pos : 0,
		)
		this.warn("host-centre-mismatch", reported - caps)
		this.queueExternal()
	}

	/**
	 * Captures the command position now; posts its DSP epoch at its microtask or at the next branch
	 * delivery, whichever comes first. Commands before the post merge (the newest centre wins).
	 */
	private queueExternal(centreHz?: number): void {
		if (!this.running) return
		const held = this.externalPending
		if (held) {
			if (centreHz !== undefined) held.centreHz = centreHz
			else delete held.centreHz
			return
		}
		const clock = this.sampleClock()
		this.externalPending = {
			commandSample: clock.commandSample,
			bufferedSamples: clock.bufferedSamples,
			...(centreHz !== undefined ? { centreHz } : {}),
		}
		queueMicrotask(() => this.flushExternal())
	}

	/**
	 * Posts the queued command's DSP epoch. Not during a restart or with a stream boundary still
	 * ahead in the branch: the stream that starts there opens at the source's centre, its own
	 * reset. Its label is the ledger's, so nothing here decides trust.
	 */
	private flushExternal(): void {
		const pending = this.externalPending
		this.externalPending = null
		if (!pending || !this.running || this.restarting) return
		if (this.branchQueue.some(mark => mark.kind === "stream")) {
			// Its frame tuned the stream that starts at the boundary (a receipt on the new session):
			// its DSP epoch is posted there (postHeldExternal), the newest centre winning.
			const held: ExternalCommand = this.externalAfterBoundary ?? {}
			if (pending.centreHz !== undefined) held.centreHz = pending.centreHz
			else delete held.centreHz
			this.externalAfterBoundary = held
			return
		}
		const caps = this.deps.sources.getCaps(this.sourceId)
		if (!caps) return
		if (caps.sampleRate !== this.cfg?.sampleRateHz) {
			this.restartInBackground()
			return
		}
		const fs = caps.sampleRate
		const s = this.deps.settings()
		// WG9 req 3.4: never the scanner's own retune (the arbiter submits those directly).
		const timing = operatorRetuneTiming({
			commandSample: pending.commandSample,
			bufferedSamples: pending.bufferedSamples,
			sampleRateHz: fs,
			networkSettleMs: s.sweep.settleMs.network,
		})
		const centreHz =
			this.centreOverride ??
			pending.centreHz ??
			caps.centerFreq ??
			this.current.centreHz
		this.postEpoch(
			{
				epoch: this.allocateEpoch(),
				commandSample: pending.commandSample,
				bufferedSamples: pending.bufferedSamples,
				settleSamples: timing.settleSamples,
				expectMarker: false,
				markerTimeoutSamples: 0,
				pllSettleSamples: 0,
				centreHz,
				sampleRateHz: fs,
				gainKey: gainKeyOf(this.deps.tuner?.getState(this.sourceId)),
				tuningTrust: "unverified",
				centreChanged: centreHz !== this.current.centreHz,
				staleMaxMs: timing.staleMaxMs,
			},
			false,
		)
	}

	/**
	 * Posts the DSP epoch of a command held behind the stream boundary just applied: from its
	 * receipt's position in the new stream (an upper bound: never before the frame left), or, when
	 * the receipt cannot be mapped to this stream, from the bytes buffered upstream now.
	 */
	private postHeldExternal(): void {
		const held = this.externalAfterBoundary
		this.externalAfterBoundary = null
		if (!held || !this.running || this.restarting) return
		const clock = this.sampleClock()
		const at = this.receiptSample()
		this.externalPending = {
			...held,
			commandSample: clock.commandSample,
			bufferedSamples:
				at === null
					? clock.bufferedSamples
					: Math.max(0, at - clock.commandSample),
		}
		this.flushExternal()
	}

	/** Upper bound of the current stream's sample at the newest tuning receipt; null: unmapped. */
	private receiptSample(): number | null {
		const r = this.lastTuningReceipt
		const anchor = this.ledgerAnchor
		const map = this.streamMaps.at(-1)
		if (!r || !anchor || r.session !== anchor.session) return null
		if (!map || map.stream !== this.stream || !Number.isFinite(map.oLow0))
			return null
		if (this.upstreamLost(anchor)) return null
		const bytes = anchor.oHigh + r.pos - map.oLow0
		return Math.max(0, Math.ceil(bytes / map.bps) + map.gaps)
	}

	// === Tuning-ledger labels ===

	/** Ledger diagnostics; null when the engine has no ledger. */
	trustShadow(): EngineTrustShadow | null {
		if (!this.ledger()) return null
		return {
			agree: this.labelledBlocks,
			ledgerStricter: 0,
			ledgerLooser: 0,
			mismatch: 0,
			disagreements: [],
			retuneDelay: this.retuneDelay.status(),
			unverifiedBlocks: Object.fromEntries(this.unverifiedBlocks),
			anchorWidenedBytes: this.anchorWidenedBytes,
			markerBoundaries: this.markerBoundaries,
		}
	}

	/** A centre or rate frame flushed: the retune-delay measurement starts from it. */
	private readonly onLedgerChange: LedgerListener = (sourceId, change) => {
		if (sourceId !== this.sourceId) return
		// A later receipt or doubt can change a label: nothing cached outlives it.
		this.newestLabel = null
		if (change.kind !== "receipt") return
		const r = change.receipt
		if (r.field === "frequency" || r.field === "sampleRate")
			this.lastTuningReceipt = { session: r.session, pos: r.pos }
		const cfg = this.cfg
		if (r.field === "testMode") {
			// A scanner marker bracket: its frames and blocks are skipped (retune-delay.ts).
			// The window's length follows the rate in effect for the bracket (the session's last
			// receipted rate, the hop's own included), the engine's current one only without one.
			this.retuneDelay.onTestMode(
				{ session: r.session, on: r.value !== 0, pos: r.pos },
				cfg ? cfg.sampleRateHz : null,
				this.bps,
			)
			return
		}
		if (r.field !== "frequency" && r.field !== "sampleRate") return
		const epoch = this.running ? this.currentEpoch() : null
		this.retuneDelay.onReceipt(
			{ session: r.session, field: r.field, value: r.value, pos: r.pos },
			epoch
				? r.field === "frequency"
					? epoch.centreHz
					: epoch.sampleRateHz
				: null,
			cfg ? cfg.sampleRateHz * this.bps : null,
		)
	}

	private ledger(): EngineLedger | null {
		if (this.deps.ledger !== undefined) return this.deps.ledger
		return this.deps.sources.tuningLedger ?? null
	}

	/** Bytes between the source manager's write and this branch: source stream buffers and absorber. */
	private upstreamBuffered(): { bytes: number; lost: number | null } {
		const stream = this.deps.sources.getStream(this.sourceId)
		const ingest = this.deps.routing.ingestCounters?.(this.sourceId) ?? null
		return {
			bytes:
				(stream?.readableLength ?? 0) +
				// The source stream is a PassThrough: its writable side can hold bytes too.
				writableBacklog(stream) +
				(ingest?.heldBytes ?? 0),
			lost: ingest?.lostBytesTotal ?? null,
		}
	}

	/**
	 * A new branch (offered byte 0) during a live session at `pos`: the next byte offered has a
	 * position in [pos − buffered upstream, pos], so the session's position 0 lies at offered byte
	 * [−pos, buffered − pos].
	 */
	private anchorAtBranchStart(): void {
		this.ledgerAnchor = null
		const ledger = this.ledger()
		if (!ledger) return
		const at = ledger.position(this.sourceId)
		if (!at) return
		const upstream = this.upstreamBuffered()
		this.ledgerAnchor = {
			session: at.session,
			oLow: -at.pos,
			oHigh: upstream.bytes - at.pos,
			lost: upstream.lost,
		}
	}

	/**
	 * Emitted before the session's first byte is written: every byte offered to the branch so far,
	 * and every byte still upstream, is the old session's.
	 */
	private readonly onSessionStarted = (
		sourceId: string,
		session: number,
	): void => {
		if (sourceId !== this.sourceId || !this.running || !this.fanout) return
		const t = this.fanout.getBranchTelemetry(this.branchId)
		if (!t) {
			this.ledgerAnchor = null
			return
		}
		const upstream = this.upstreamBuffered()
		this.ledgerAnchor = {
			session,
			oLow: t.totalBytesWritten,
			oHigh: t.totalBytesWritten + upstream.bytes,
			lost: upstream.lost,
		}
	}

	/**
	 * Sample 0 of the stream that starts now is the next byte after `shadowBranchByte` accepted bytes,
	 * preceded by at least the drops applied so far and at most every drop counted so far.
	 */
	private mapStream(): void {
		const t = this.fanout?.getBranchTelemetry(this.branchId)
		const cfg = this.cfg
		const blockSamples = cfg
			? blockSamplesOf(cfg.integrationMs, cfg.sampleRateHz, cfg.fftSize)
			: null
		this.streamMaps.push({
			stream: this.stream,
			oLow0: this.shadowBranchByte + this.appliedDropBytes,
			oHigh0: t
				? this.shadowBranchByte + t.droppedBytesTotal
				: Number.POSITIVE_INFINITY,
			gaps: 0,
			summarised: 0,
			bps: this.bps,
			blockSamples,
			alarmReachBlocks:
				cfg && blockSamples !== null
					? alarmWaitBlocksOf(cfg.trackHangMs, blockSamples, cfg.sampleRateHz) +
						2
					: null,
		})
		if (this.streamMaps.length > SHADOW_STREAM_MAPS) this.streamMaps.shift()
	}

	/**
	 * The label of a block summary (its block's samples, against the summary's own centre and
	 * rate and its epoch's hop) and the retune-delay measurement it feeds. The current epoch's
	 * newest block labels `currentEpoch()`.
	 */
	private labelBlock(
		ev: Extract<PipelineEvent, { kind: "block-summary" }>,
	): TuningTrust {
		const summary = ev.summary
		const map = this.streamMaps.find(m => m.stream === summary.stream)
		if (map) map.summarised = Math.max(map.summarised, summary.endSample)
		const ledger = this.ledger()
		const record = this.epochRecord(summary.stream, summary.epoch)
		if (!ledger || !map || map.blockSamples === null) {
			// Unverified like any other: the epoch's trusted run ends here.
			const start = summary.endSample - (map?.blockSamples ?? 0)
			if (record !== null)
				this.noteRun(record, "unverified", start, summary.endSample)
			this.noteBlockLabel(
				summary,
				"unverified",
				!ledger ? "no-ledger" : "no-stream-map",
			)
			return "unverified"
		}
		const read = this.ledgerRange(
			ledger,
			summary.stream,
			summary.endSample - map.blockSamples,
			summary.endSample,
		)
		if (read.session !== null && read.posA !== null && read.posB !== null)
			this.retuneDelay.onBlock({
				session: read.session,
				posA: read.posA,
				posB: read.posB,
				bins: summary.bins,
				binHz: summary.binHz,
			})
		const label =
			record === null
				? { trust: "unverified" as const, reason: "no-epoch-record" }
				: this.labelWithReason(read, {
						centreHz: summary.centreHz,
						sampleRateHz: summary.sampleRateHz,
						hop: record.hop,
					})
		this.labelledBlocks += 1
		if (record !== null)
			this.noteRun(
				record,
				label.trust,
				summary.endSample - map.blockSamples,
				summary.endSample,
			)
		this.noteBlockLabel(summary, label.trust, label.reason)
		return label.trust
	}

	/**
	 * A block `[start, end)` labelled `trust`: the epoch's trusted run goes on, begins, or ends
	 * (`runEnd`: a block that reads `unverified` or changes the label ends the run, exactly where
	 * the run's last trusted block ended: samples between it and this block, if any, were never
	 * labelled, so they stay outside it).
	 */
	private noteRun(
		record: EpochRecord,
		trust: TuningTrust,
		start: number,
		end: number,
	): void {
		const ends =
			record.trustedFrom !== null &&
			(trust === "unverified" || record.trustedLabel !== trust)
		if (ends)
			record.runEnd = {
				from: record.trustedFrom!,
				end: Math.min(record.trustedEnd ?? start, start),
			}
		if (trust === "unverified") {
			record.trustedFrom = null
			record.trustedEnd = null
		} else {
			if (record.trustedFrom === null || record.trustedLabel !== trust)
				record.trustedFrom = start
			record.trustedEnd = end
		}
		record.trustedLabel = trust
	}

	private noteBlockLabel(
		summary: { stream: number; epoch: number },
		trust: TuningTrust,
		reason?: string,
	): void {
		if (trust === "unverified") {
			let key = reason ?? "unknown"
			// Bounded: once full, a code not seen yet is counted as `other`.
			if (
				!this.unverifiedBlocks.has(key) &&
				this.unverifiedBlocks.size >= UNVERIFIED_REASONS - 1
			)
				key = "other"
			this.unverifiedBlocks.set(key, (this.unverifiedBlocks.get(key) ?? 0) + 1)
		}
		if (
			summary.stream === this.current.stream &&
			summary.epoch === this.current.epoch
		) {
			this.liveLabel = trust
			this.liveReason = trust === "unverified" ? (reason ?? "unknown") : null
		}
	}

	/**
	 * The ledger's label of samples `[start, end)` of `record`'s stream: trusted only when the
	 * ledger proves both fields over the range, the proven centre and rate are the ones the
	 * event's frequencies were computed from (`claim`), and a scanner hop's samples are proven by
	 * its own frequency receipt. Fail closed on every missing map, record or receipt.
	 */
	private stamp(record: EpochRecord, start: number, end: number): TuningTrust {
		const ledger = this.ledger()
		if (!ledger) return "unverified"
		return this.labelOf(
			this.ledgerRange(ledger, record.stream, start, end),
			record,
		)
	}

	private labelOf(
		read: LedgerRead,
		claim: Pick<EpochRecord, "centreHz" | "sampleRateHz" | "hop">,
	): TuningTrust {
		return this.labelWithReason(read, claim).trust
	}

	/** labelOf with the first failing check when `unverified` (`trustShadow.unverifiedBlocks`). */
	private labelWithReason(
		read: LedgerRead,
		claim: Pick<EpochRecord, "centreHz" | "sampleRateHz" | "hop">,
	): { trust: TuningTrust; reason?: string } {
		const v = read.verdict
		if (v.trust === "unverified")
			return { trust: "unverified", reason: v.reason ?? "unknown" }
		if (v.frequency !== claim.centreHz || v.sampleRate !== claim.sampleRateHz)
			return { trust: "unverified", reason: "value-mismatch" }
		if (claim.hop !== null) {
			const seq = this.hopReceipts.get(claim.hop)
			if (typeof seq !== "number" || v.receipts?.frequency !== seq)
				return { trust: "unverified", reason: "hop-receipt" }
		}
		return { trust: v.trust }
	}

	/**
	 * A posted epoch's start claim (its `epoch-started` label): the ledger holds this session's
	 * receipts of the epoch's centre and rate, proven or still settling, with a writer and no doubt
	 * since; a scanner hop's by its own frequency receipt (or that receipt not noted yet: its frame
	 * is written right after the post; a hop whose frame got none, or whose receipt is no longer
	 * the proof, claims nothing). It tells the poster the epoch is its own; its samples are labelled
	 * one by one (stamp), so nothing before the boundary, and nothing without the hop's own
	 * receipt, is trusted.
	 */
	private epochClaim(record: EpochRecord): TuningTrust {
		try {
			const ledger = this.ledger()
			if (!ledger) return "unverified"
			const fields = ledger.fieldState(this.sourceId)
			const held = (f: (typeof fields)["frequency"], value: number): boolean =>
				(f.state === "proven" || f.state === "settling") &&
				f.writer !== null &&
				f.value === value
			const freq = fields.frequency
			const rate = fields.sampleRate
			if (!held(rate, record.sampleRateHz)) return "unverified"
			if (record.hop !== null) {
				const seq = this.hopReceipts.get(record.hop)
				// Not noted yet: the arbiter writes the hop's frame right after posting it, and the
				// pipeline can start a timer epoch before that write flushes. Its samples are stamped
				// by that receipt once it exists, never before, so the claim only names the owner.
				if (seq === undefined) return "commanded"
				if (
					seq === null ||
					freq.receipt !== seq ||
					!held(freq, record.centreHz)
				)
					return "unverified"
				return rate.writer === "relay" ? "relay" : "commanded"
			}
			if (!held(freq, record.centreHz)) return "unverified"
			return freq.writer === "relay" || rate.writer === "relay"
				? "relay"
				: "commanded"
		} catch {
			return "unverified"
		}
	}

	private rememberEpoch(record: EpochRecord): void {
		this.epochRecords.push(record)
		if (this.epochRecords.length > EPOCH_RECORDS) this.epochRecords.shift()
	}

	/** A started epoch still kept (EPOCH_RECORDS), or null. */
	private epochRecord(stream: number, epoch: number): EpochRecord | null {
		for (let i = this.epochRecords.length - 1; i >= 0; i--) {
			const r = this.epochRecords[i]!
			if (r.stream === stream && r.epoch === epoch) return r
		}
		return null
	}

	/** Block length (samples) of a kept stream, or null. */
	private streamBlockSamples(stream: number): number | null {
		return this.streamMaps.find(m => m.stream === stream)?.blockSamples ?? null
	}

	/**
	 * Lower bound of the ledger position of sample `sample` of engine stream `stream`, minus
	 * `blocksBefore` of that stream's blocks, clamped to 0; null when it cannot be mapped (no
	 * anchor, no map, upstream loss, another session).
	 */
	private ledgerLowerBound(
		stream: number,
		sample: number,
		blocksBefore = 0,
	): number | null {
		const ledger = this.ledger()
		const anchor = this.ledgerAnchor
		if (!ledger || !anchor || !Number.isFinite(sample)) return null
		if (this.upstreamLost(anchor)) return null
		const map = this.streamMaps.find(m => m.stream === stream)
		if (!map || map.blockSamples === null) return null
		const live = ledger.position(this.sourceId)
		if (!live || live.session !== anchor.session) return null
		const first = sample - blocksBefore * map.blockSamples
		const pos = map.oLow0 + (first - map.gaps - 1) * map.bps - anchor.oHigh
		return Math.max(0, pos)
	}

	/**
	 * A pipeline error doubts both fields from the oldest sample the pipeline may still owe an
	 * alarm for: per kept stream, its alarm reach (`alarmReachBlocks`: a pending alarm's reference
	 * block, however long it was held) before its newest summary's end, the minimum over streams;
	 * any unmappable stream or none kept: 0 (session start).
	 */
	private raisePipelineDoubt(): void {
		const ledger = this.ledger()
		if (!ledger) return
		let low = this.streamMaps.length === 0 ? 0 : Number.POSITIVE_INFINITY
		for (const map of this.streamMaps) {
			const pos =
				map.alarmReachBlocks === null
					? null
					: this.ledgerLowerBound(
							map.stream,
							map.summarised,
							map.alarmReachBlocks,
						)
			if (pos === null) {
				low = 0
				break
			}
			low = Math.min(low, pos)
		}
		ledger.raiseDoubt(this.sourceId, "both", "pipeline-error", low)
	}

	/**
	 * Lower bound of an untracked-retune alarm's move, mapped through its own stream: the start of
	 * the reference block it compared against (the move lies after it, however long the alarm was
	 * held pending); without one, the stream's alarm reach before the alarm's sample. Without a
	 * stream, or an unmappable or unkept one: 0 (session start).
	 */
	private alarmLowerBound(ev: UntrackedRetuneEvent): number {
		if (ev.stream === undefined) return 0
		if (ev.referenceStartSample !== undefined)
			return this.ledgerLowerBound(ev.stream, ev.referenceStartSample) ?? 0
		const map = this.streamMaps.find(m => m.stream === ev.stream)
		if (!map || map.alarmReachBlocks === null) return 0
		return (
			this.ledgerLowerBound(ev.stream, ev.startSample, map.alarmReachBlocks) ??
			0
		)
	}

	/**
	 * Bytes the absorber lost since the anchor: each lost byte puts every later offered byte one
	 * position further on in the session, so the anchor widens by the loss (position 0 may sit
	 * that much earlier in the offered bytes: `oLow` moves down, `oHigh` stays). Lower bounds stay
	 * lower bounds and upper bounds grow by the loss, so the map stays fail closed and blocks after
	 * the next proof are trusted again, without a reconnect. True (unmappable) only when the counter
	 * went backwards or disappeared (a router reset: nothing known of the loss).
	 */
	private upstreamLost(anchor: LedgerAnchor): boolean {
		if (anchor.lost === null) return false
		const lost =
			this.deps.routing.ingestCounters?.(this.sourceId)?.lostBytesTotal ?? null
		if (lost === anchor.lost) return false
		if (lost === null || lost < anchor.lost) return true
		const delta = lost - anchor.lost
		anchor.oLow -= delta
		anchor.lost = lost
		this.anchorWidenedBytes += delta
		return false
	}

	/**
	 * The ledger's verdict on samples `[start, end)` of engine stream `stream`, mapped through that
	 * stream's own map (its bytes per sample and gaps), fail closed on every missing map: the
	 * first byte by a lower bound, the end by an upper bound (never past what the source manager
	 * handed out). A range whose lower bound falls before the session's position 0 may hold the
	 * previous session's bytes: `before-session`.
	 */
	private ledgerRange(
		ledger: EngineLedger,
		stream: number,
		start: number,
		end: number,
	): LedgerRead {
		const anchor = this.ledgerAnchor
		if (!anchor) return unmappedRead("no-anchor")
		if (this.upstreamLost(anchor)) return unmappedRead("upstream-loss")
		if (!Number.isFinite(start) || !Number.isFinite(end))
			return unmappedRead("bad-range")
		const map = this.streamMaps.find(m => m.stream === stream)
		if (!map) return unmappedRead("no-stream-map")
		// Lower bound of the first byte: each applied gap can round its samples up by one.
		const posA = map.oLow0 + (start - map.gaps - 1) * map.bps - anchor.oHigh
		const posB = map.oHigh0 + end * map.bps - anchor.oLow
		const live = ledger.position(this.sourceId)
		if (!live || live.session !== anchor.session)
			return unmappedRead("session-ended")
		const upper = Math.min(posB, live.pos)
		const at = {
			session: anchor.session,
			posA: Math.max(0, posA),
			posB: Math.max(0, upper),
		}
		if (posA < 0)
			return {
				...at,
				verdict: { ...unmappedRead("before-session").verdict },
			}
		return {
			...at,
			verdict: ledger.trustAt(this.sourceId, anchor.session, posA, upper),
		}
	}

	/** Diagnostics for status (§ 12.1). */
	accounting(): {
		stream: number
		liveEdge: number
		gapSamples: number
		workerDroppedSamples: number
	} {
		return {
			stream: this.stream,
			liveEdge: this.nextSample,
			gapSamples: this.gapSamplesTotal,
			workerDroppedSamples: this.workerDroppedSamples,
		}
	}
}
