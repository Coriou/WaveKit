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
import { tuningTrustOf } from "../tuning-trust.js"
import type { TrustVerdict, TuningLedger } from "../tuning-ledger.js"
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
	TuningTrust,
	UntrackedRetuneEvent,
} from "./types.js"
import { bytesPerSample } from "./frame-source.js"
import type { ArtefactMasks } from "./artefacts.js"
import { IqRing } from "./iq-ring.js"
import type { WorkerPipelineInput } from "./worker-protocol.js"
import {
	blockSamplesOf,
	frameTrust,
	mergeTrust,
	operatorRetuneTiming,
} from "./retune-settle.js"
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
	tuningTrust: TuningTrust
	settleMode: SettleMode | null
	/**
	 * On an `epoch-started` event only, never in `currentEpoch()`: the id its poster was given
	 * (`allocateEpoch`, or a scanner hop's id when it was held through a restart and re-posted)
	 * when the pipeline started it as another. The label is still the one posted for it.
	 */
	requestedEpoch?: number
	/**
	 * On an `epoch-started` event only: the id its poster was given (`requestedEpoch`) for a scanner
	 * hop held through a restart whose rate was not the restarted stream's. Such a hop is re-posted
	 * `unverified` at the stream's real centre and rate (never on the rate it asked for); this names
	 * it on its own start, or on the first start after it was dropped unstarted (a newer post
	 * replaced it), so its poster learns its hop was superseded and re-sends it (no dwell credit).
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

/** What the engine reads from the tuning ledger (shadow label) and the doubts it raises. */
export type EngineLedger = Pick<
	TuningLedger,
	"trustAt" | "position" | "raiseDoubt"
>

/**
 * Tuning-ledger shadow (trust step 1): every block summary is labelled by the ledger beside the
 * engine's own label, and the two are counted. Nothing reads the ledger label yet.
 * `ledgerStricter`: the ledger says `unverified` where the engine trusts; `ledgerLooser`: the
 * ledger trusts where the engine says `unverified`; `mismatch`: both trust, with another label,
 * centre or rate.
 */
export interface EngineTrustShadow {
	agree: number
	ledgerStricter: number
	ledgerLooser: number
	mismatch: number
	/** The last SHADOW_DISAGREEMENTS disagreements, oldest first. */
	disagreements: EngineTrustDisagreement[]
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

/**
 * Disagreements kept for status. The step-1 acceptance explains every disagreement of a 30 min
 * run line by line from the status poll (1 s): disagreements come in bursts of one per block
 * summary around a tuning event (integration 100 ms default: 10 per second over a ≤ 1 s settle),
 * so 32 holds a whole burst plus its neighbours between two polls; older ones stay in the counters.
 */
export const SHADOW_DISAGREEMENTS = 32

/** Where a ledger session's position 0 lies in a branch's offered bytes, as bounds. */
interface LedgerAnchor {
	session: number
	oLow: number
	oHigh: number
	/** The absorber's lost bytes when anchored (bytes lost after it break the map). */
	lost: number | null
}

/** A shadow read: the ledger's verdict and where it was read (null: not mapped). */
interface ShadowRead {
	verdict: Pick<
		TrustVerdict,
		"trust" | "frequency" | "sampleRate" | "doubtReason"
	> & { reason?: string }
	session: number | null
	posA: number | null
	posB: number | null
}

function unmappedRead(reason: string): ShadowRead {
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
	 * WG9 req 3.2: `tuningWrittenOnConnection` is present on the real TunerController
	 * (SpectrumService passes it through); when present and false, a label the state rule
	 * would make `commanded`/`relay` is demoted to `unverified`.
	 */
	tuner:
		| (Pick<TunerController, "getState"> &
				Partial<Pick<TunerController, "tuningWrittenOnConnection">> &
				Pick<EventEmitter, "on" | "off">)
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
	trust: TuningTrust
	/** Its place among epoch triggers (`SpectrumEngine.ticket`). */
	ticket: number
}

/** Something that happens when the engine's branch byte counter reaches `atBranchByte`. */
type BranchMark =
	| { kind: "gap"; atBranchByte: number; droppedBytes: number }
	| StreamMark

/** An operator, relay or reconnect command's epoch still to be posted (`queueExternal`). */
interface ExternalCommand {
	trust: TuningTrust
	/** WG9 req 3.3: the centre a set-frequency command wrote (one epoch per retune). */
	centreHz?: number
	/**
	 * WG9 req 3.1/3.2: merge the shared state rule into `trust` at flush, after the
	 * tuner finished the update that fired the event (a relay command updates caps
	 * before it records the accepted value; reconnect reconciliation before replay events).
	 */
	checkState: boolean
	/** Its place among epoch triggers (`SpectrumEngine.ticket`): the first command it merges. */
	ticket: number
	/**
	 * The ticket of the newest command merged into it (absent: `ticket`). Its label and centre are
	 * that command's, so it is ordered against a held scanner hop by this one (postCarried).
	 */
	newest?: number
	/**
	 * Posted from `carried` into a later stream: an explicit centre is only a claim about the
	 * tuner when the command was written, so it must still agree with caps when posted.
	 */
	kept?: boolean
}

/** A scanner hop submitted while the pipeline restarted, re-posted into the stream that follows. */
interface HeldHop {
	pending: PendingEpoch
	ticket: number
	/** The id the arbiter returned for it (the re-post takes a new one). */
	requested: number
}

/**
 * A pending epoch posted to the host whose start has not arrived yet, in post order. The
 * pipeline numbers it `max(key, last id + 1)` (SpectrumPipeline.onPending), so an untracked
 * epoch the engine had not heard of yet moves it, and the ones after it, to later ids: its
 * start is found by replaying that numbering over the queue, never by its key.
 */
interface PendingStart {
	/** The id posted (`PendingEpoch.epoch`). */
	key: number
	/** The id its caller was given (`key`, or a held hop's original). */
	requested: number
	/** WG9 req 3.4: a non-scanner epoch's first sample past the network settle. */
	verifiedFrom: number | null
	/** A held hop re-posted on another rate than its own (EngineEpoch.supersededEpoch). */
	superseded?: true
	meta: EngineEpoch
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
	/**
	 * Orders epoch triggers: each command's epoch, stream boundary and source disconnect takes the
	 * next value, so a command can tell whether it came after a boundary or a disconnect.
	 */
	private ticket = 0
	/** The ticket of the source's last disconnect (0: none since start). */
	private disconnectTicket = 0
	/**
	 * Commands that came while the pipeline restarted, or after a stream boundary the delivered
	 * bytes have not reached yet: they belong to a stream that starts later, and are posted into
	 * it once it has started (beginStream), never dropped. One entry per stream, in ticket order:
	 * commands for the same stream share an entry, a queued boundary between two keeps them
	 * apart. A command older than the source's last disconnect tuned a connection that is gone,
	 * and is dropped.
	 */
	private readonly carried: ExternalCommand[] = []
	/**
	 * The newest scanner hop submitted during a restart (only the newest: an older hop's epoch
	 * would end where the next one starts). The old host can no longer take it, and the job's
	 * own re-send may already be spent on the reconnect that preceded the restart.
	 */
	private heldHop: HeldHop | null = null
	/** Pending epochs posted to the current host whose start has not arrived (PendingStart). */
	private readonly starts: PendingStart[] = []
	/** A superseded held hop's requested id dropped unstarted; the next start names it (PendingStart.superseded). */
	private supersededLost: number | null = null
	/** The current host's last epoch id, from the events it has delivered (they arrive in order). */
	private startedThrough = 0
	/** The label of the untracked epoch the pipeline just announced, until its own start. */
	private untrackedStart: EngineEpoch | null = null
	/** A stream whose posted epochs no longer match the host's starts (takeStart): none is named. */
	private unnamedStream: number | null = null
	/**
	 * The current epoch's `PendingStart.verifiedFrom` (null: no unverified window). Events whose
	 * data starts before it are `unverified` for the whole epoch.
	 */
	private currentVerifiedFrom: number | null = null
	/** The epoch `currentVerifiedFrom` belongs to. */
	private currentVerifiedEpoch: number | null = null
	/** Status reads `unverified` until the first data-bound event at or past the current epoch's settle. */
	private statusWindowOpen = false
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
	// Tuning-ledger shadow (trust step 1). Positions are mapped through the branch's offered bytes
	// (`totalBytesWritten`: accepted plus dropped, in source order), always as a lower bound for a
	// block's first byte and an upper bound for its end, so the ledger can only be stricter.
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
	 * the chunk-start value there for its existing readers): the shadow's stream map reads this.
	 */
	private shadowBranchByte = 0
	/** Ledger position at the last host-centre poll that matched caps (lower bound of a move). */
	private hostCentreOkAt: { session: number; pos: number } | null = null
	/** Dropped branch bytes applied as gaps since the branch was created. */
	private appliedDropBytes = 0
	private readonly shadow: EngineTrustShadow = {
		agree: 0,
		ledgerStricter: 0,
		ledgerLooser: 0,
		mismatch: 0,
		disagreements: [],
	}

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
		// A command carried by an earlier run tuned before this branch existed.
		this.carried.length = 0
		this.heldHop = null
		this.beginStream(this.initialTrust())
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

	submitEpoch(pending: PendingEpoch): void {
		this.postEpoch(pending, pending.epoch)
	}

	/**
	 * `requested`: the id the epoch's caller was given (a held hop's is the arbiter's own).
	 * `superseded`: a held hop re-posted on the stream's rate instead of its own (takeHeldHop).
	 */
	private postEpoch(
		pending: PendingEpoch,
		requested: number,
		superseded = false,
	): void {
		if (!this.running || !this.host) return
		if (this.restarting) {
			// Only the scanner submits here during a restart (external commands are carried before).
			this.heldHop = {
				pending: { ...pending },
				ticket: ++this.ticket,
				requested,
			}
			return
		}
		if (pending.sampleRateHz !== this.cfg?.sampleRateHz) {
			this.log.info(
				{ from: this.cfg?.sampleRateHz, to: pending.sampleRateHz },
				"Sample rate change starts a new stream",
			)
			this.restartInBackground(pending.tuningTrust)
			return
		}
		this.flushBatch()
		this.starts.push({
			key: pending.epoch,
			requested,
			verifiedFrom: pending.verifiedFromSample ?? null,
			...(superseded ? { superseded: true as const } : {}),
			meta: {
				stream: this.stream,
				epoch: pending.epoch,
				startSample: null,
				centreHz: pending.centreHz,
				sampleRateHz: pending.sampleRateHz,
				gainKey: pending.gainKey,
				tuningTrust: pending.tuningTrust,
				settleMode: null,
			},
		})
		this.send({ kind: "pending-epoch", pending })
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
	 * matches: the queue no longer describes the host, so it is dropped (fail closed).
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
		if (i > 0) this.unnamedStream = this.current.stream
		this.dropStarts(i)
		return null
	}

	/** Drops the first `count` pending starts, which never start; a superseded hop among them is named on the next start. */
	private dropStarts(count: number): void {
		for (const entry of this.starts.splice(0, count))
			if (entry.superseded === true) this.supersededLost = entry.requested
	}

	/**
	 * WG9 (tt minor): status agrees with the frames: while a non-scanner retune's unverified
	 * window is open (no block, track or transient at or past the network settle yet), the
	 * epoch reads `unverified`.
	 */
	currentEpoch(): EngineEpoch {
		if (
			this.statusWindowOpen &&
			this.currentVerifiedFrom !== null &&
			this.currentVerifiedEpoch === this.current.epoch
		)
			return { ...this.current, tuningTrust: "unverified" }
		return { ...this.current }
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

	/** Applies new tuning (fftSize, integration, k) by recreating the pipeline. */
	async reconfigure(): Promise<void> {
		await this.restartPipeline(this.current.tuningTrust)
	}

	// === Internals: hosts and streams ===

	private createHost(sampleRateHz: number): PipelineHost {
		const tuning = this.deps.tuning?.() ?? DEFAULT_TUNING
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
		this.log.error({ err }, "Spectrum pipeline unavailable")
		if (this.listenerCount("error") > 0) this.emit("error", err)
		this.emit("fatal", err)
		void this.stop().catch((error: unknown) =>
			this.log.warn({ err: error }, "Fatal pipeline cleanup failed"),
		)
	}

	private async restartPipeline(trust: TuningTrust): Promise<void> {
		if (this.failed || this.restarting || !this.host) return
		this.restarting = true
		this.flushBatch()
		const old = this.host
		const since = this.ticket
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
			// A disconnect during the restart: its boundary was discarded with the old bytes, so the
			// stream that starts now is a new connection's, which nothing proved yet. The replay
			// that proves it was carried (flushExternal) and follows as this stream's next epoch.
			// A command or hop kept for this stream likewise: the bytes still buffered can predate
			// it, so only its own epoch, after its settle, may carry its label.
			const kept =
				this.carried.length > 0 ||
				this.externalPending !== null ||
				this.heldHop !== null
			this.beginStream(
				this.disconnectTicket > since || kept ? "unverified" : trust,
			)
		} finally {
			this.restarting = false
		}
	}

	/** Restart from an event handler: a failure (e.g. the host cannot be created) becomes "error". */
	private restartInBackground(trust: TuningTrust): void {
		this.restartPipeline(trust).catch((err: unknown) => {
			const error =
				err instanceof Error
					? err
					: new WaveKitError(String(err), "SCANNER_PIPELINE_ERROR")
			this.fail(error)
		})
	}

	private initialTrust(): TuningTrust {
		return this.stateTrust()
	}

	/**
	 * WG9 req 3.1/3.2: the shared fail-closed rule on the current tuner state, demoted to
	 * `unverified` when the tuner reports no frequency and sample-rate write on this connection.
	 */
	private stateTrust(): TuningTrust {
		const tuner = this.deps.tuner
		if (!tuner) return "unverified"
		const trust = tuningTrustOf(tuner.getState(this.sourceId))
		if (trust === "unverified") return trust
		const written = tuner.tuningWrittenOnConnection
		if (
			typeof written === "function" &&
			written.call(tuner, this.sourceId) !== true
		)
			return "unverified"
		return trust
	}

	/**
	 * `boundaryTicket`: the queued boundary this stream starts at; absent for a start or a restart,
	 * whose commands still pending all came after the stream they replace stopped taking epochs.
	 */
	private beginStream(trust: TuningTrust, boundaryTicket?: number): void {
		this.flushBatch()
		const caps = this.deps.sources.getCaps(this.sourceId)
		const sampleRateHz = this.cfg?.sampleRateHz ?? caps?.sampleRate ?? 0
		this.stream += 1
		this.nextSample = 0
		this.remainder = new Uint8Array(0)
		this.skipBytes = 0
		this.mapStream()
		// The old stream's pending starts stay until this stream's own epoch-started (onEvents).
		// A command queued before the boundary was the old stream's; one after it is this one's.
		const pending = this.externalPending
		this.externalPending = null
		if (
			pending &&
			(boundaryTicket === undefined || pending.ticket > boundaryTicket)
		)
			this.carry(pending)
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
			tuningTrust: trust,
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
			tuningTrust: trust,
		})
		this.postCarried(boundaryTicket)
	}

	/**
	 * Posts the carried commands into the stream that just started, in order, each as an epoch
	 * timed from this stream's clock; one still behind a queued boundary is carried again
	 * (flushExternal). Each label is the newest command's own, merged with the state rule when it
	 * is posted (checkState), so a value really unknown then keeps it `unverified`.
	 */
	private postCarried(boundaryTicket?: number): void {
		const hop = this.takeHeldHop(boundaryTicket)
		if (this.carried.length === 0) return
		const carried = this.carried.splice(0)
		for (const command of carried) {
			if (command.ticket < this.disconnectTicket) continue
			// A command older than the hop posted just now would end where the hop starts. A merged
			// entry carries its newest command's state, so that command's ticket orders it: an
			// operator write after the hop is posted after it, even folded into an older write.
			if (hop && (command.newest ?? command.ticket) < hop.ticket) continue
			this.queueExternal(
				command.trust,
				command.centreHz,
				true,
				command.ticket,
				true,
				command.newest,
			)
		}
	}

	/**
	 * m3: re-posts the scanner hop held during a restart into this stream, before any newer kept
	 * command, under the scanner's own rules: its label (the hop's state rule), its settle and
	 * gain, timed from this stream's clock with every buffered byte counted (never earlier than
	 * the hop's writes), and no marker (its bytes went with the old stream). Its centre is the
	 * hop's target only while caps holds it: caps follows the frequency write, so a hop whose
	 * write has not landed, or one another writer moved since, is `unverified` at the caps centre
	 * (the write landing later gets the suppression-window epoch, checkSuppressedCentre).
	 * It takes a new epoch id (an id is only ever the next one allocated, so the pipeline numbers
	 * it as asked or later, never onto another's); the job learns it from `requestedEpoch`.
	 * A hop whose rate is not this stream's (the source rate changed again before the restart
	 * completed) is never trusted on the wrong rate nor lost: it starts `unverified` at the
	 * stream's real centre and rate, settles scaled to that rate, and its start (or, if a newer
	 * post replaces it first, the start that did) names it in `supersededEpoch`, so the job sees
	 * its hop superseded, gets no dwell credit and re-sends it (JobRunner).
	 * Returns the hop posted, or null.
	 */
	private takeHeldHop(boundaryTicket?: number): HeldHop | null {
		const held = this.heldHop
		if (!held) return null
		// A hop before the last disconnect, or before this boundary, tuned a stream that is gone.
		if (
			held.ticket < this.disconnectTicket ||
			(boundaryTicket !== undefined && held.ticket < boundaryTicket)
		) {
			this.heldHop = null
			return null
		}
		// Behind a boundary still queued: it belongs to the stream that starts there.
		if (this.boundaryAhead(held.ticket)) return null
		this.heldHop = null
		const caps = this.deps.sources.getCaps(this.sourceId)
		const hop = held.pending
		const clock = this.sampleClock()
		const superseded = hop.sampleRateHz !== clock.sampleRateHz
		const inPlace =
			!superseded &&
			caps?.centerFreq === hop.centreHz &&
			this.centreOverride === null
		const centreHz = inPlace
			? hop.centreHz
			: (this.centreOverride ?? caps?.centerFreq ?? hop.centreHz)
		const scale = (samples: number) =>
			superseded && hop.sampleRateHz > 0
				? Math.round((samples * clock.sampleRateHz) / hop.sampleRateHz)
				: samples
		this.postEpoch(
			{
				...hop,
				epoch: this.allocateEpoch(),
				commandSample: clock.commandSample,
				bufferedSamples: clock.bufferedSamples,
				settleSamples: scale(hop.settleSamples),
				pllSettleSamples: scale(hop.pllSettleSamples),
				expectMarker: false,
				markerTimeoutSamples: 0,
				centreHz,
				sampleRateHz: clock.sampleRateHz,
				tuningTrust: inPlace
					? hop.tuningTrust
					: mergeTrust(hop.tuningTrust, "unverified"),
				centreChanged: centreHz !== (caps?.centerFreq ?? 0),
			},
			held.requested,
			superseded,
		)
		return held
	}

	/** Keeps a command that cannot be posted now for the stream it belongs to, which starts later. */
	private carry(command: ExternalCommand): void {
		if (command.ticket < this.disconnectTicket) return
		const held = this.carried[this.carried.length - 1]
		if (
			held &&
			held.ticket >= this.disconnectTicket &&
			!this.boundaryBetween(
				Math.min(held.ticket, command.ticket),
				Math.max(held.ticket, command.ticket),
			)
		) {
			this.supersede(held, command)
			return
		}
		// Entries from before the last disconnect tuned a connection that is gone. Dropping them here
		// bounds the list by the stream boundaries queued since that disconnect.
		let kept = 0
		for (const entry of this.carried)
			if (entry.ticket >= this.disconnectTicket) this.carried[kept++] = entry
		this.carried.length = kept
		this.carried.push({
			trust: command.trust,
			...(command.centreHz !== undefined ? { centreHz: command.centreHz } : {}),
			checkState: command.checkState,
			ticket: command.ticket,
			...(command.newest !== undefined ? { newest: command.newest } : {}),
		})
	}

	/**
	 * Folds `command` into `held`, a command for the same stream. The newer one's label and centre
	 * win: an older command's weaker label described a state the newer one superseded. The state
	 * rule is always applied when the result is posted (checkState), so an upgrade never survives
	 * a value still unknown or only declared then, and a host-centre mismatch still demotes it.
	 */
	private supersede(held: ExternalCommand, command: ExternalCommand): void {
		// The newer command's centre wins even when it names none: an older explicit centre may be
		// one another writer (a relay) has since moved away from, so the posting then reads the
		// source's own centre. An older command never adds a centre to a newer one.
		if (command.ticket >= held.ticket) {
			held.trust = command.trust
			if (command.centreHz !== undefined) held.centreHz = command.centreHz
			else delete held.centreHz
		}
		held.checkState = true
		const newest = Math.max(
			held.newest ?? held.ticket,
			command.newest ?? command.ticket,
		)
		held.ticket = Math.min(held.ticket, command.ticket)
		if (newest !== held.ticket) held.newest = newest
		else delete held.newest
		// Either side kept makes the merge kept: its centre check is never lost by folding.
		if (command.kept === true) held.kept = true
	}

	/** True when a stream boundary still queued in the branch took a ticket between `from` and `to`. */
	private boundaryBetween(from: number, to: number): boolean {
		return this.branchQueue.some(
			mark => mark.kind === "stream" && mark.ticket > from && mark.ticket < to,
		)
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
		else this.beginStream(mark.trust, mark.ticket)
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
	private queueStreamBoundary(trust: TuningTrust): void {
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
		this.branchQueue.push({
			kind: "stream",
			atBranchByte: at,
			trust,
			ticket: ++this.ticket,
		})
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
		for (const ev of events) {
			if (ev.kind === "epoch-started") {
				this.lastEpoch = Math.max(this.lastEpoch, ev.epoch)
				let meta: EngineEpoch | null = null
				let start: PendingStart | null = null
				if (this.untrackedStart?.epoch === ev.epoch) {
					// The untracked retune announced just before (below), under the pipeline's own id.
					meta = this.untrackedStart
					this.untrackedStart = null
				} else if (ev.settleMode !== "none") {
					// A posted pending epoch's start, found by the pipeline's numbering, never by key.
					start = this.takeStart(ev.epoch)
					// None matches while this stream has posts the host may still start: the engine
					// cannot name it, so it trusts it with nothing. With none posted it keeps the label.
					meta =
						start?.meta ??
						(this.unnamedStream === this.current.stream
							? { ...this.current, tuningTrust: "unverified" }
							: null)
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
				// Late old-stream events keep the old stream's labels (thread host).
				this.current = {
					...(meta ?? this.current),
					stream: meta?.stream ?? this.current.stream,
					epoch: ev.epoch,
					startSample: ev.startSample,
					settleMode: ev.settleMode,
				}
				if (ev.settleMode === "marker") this.marker = true
				this.currentVerifiedFrom = start?.verifiedFrom ?? null
				this.currentVerifiedEpoch = ev.epoch
				this.statusWindowOpen = this.currentVerifiedFrom !== null
				const superseded =
					start?.superseded === true ? start.requested : this.supersededLost
				this.supersededLost = null
				if (start && start.requested !== ev.epoch) {
					// The caller knows this epoch by the id it was given: say so on its start only
					// (never in `current`). The label above is still the one posted for it.
					this.emit("pipeline", ev, {
						...this.epochFor(ev),
						requestedEpoch: start.requested,
						...(superseded !== null ? { supersededEpoch: superseded } : {}),
					})
					continue
				}
				if (superseded !== null) {
					this.emit("pipeline", ev, {
						...this.epochFor(ev),
						supersededEpoch: superseded,
					})
					continue
				}
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
			} else if (ev.kind === "stats") {
				this.lastStats = ev.stats
				if (ev.stats.stuckTestMode) this.marker = false
			}
			const epoch = this.epochFor(ev)
			if (ev.kind === "block-summary") this.shadowBlock(ev, epoch)
			this.emit("pipeline", ev, epoch)
		}
	}

	/**
	 * WG9 req 3.4: an event of the current non-scanner epoch whose data starts before the
	 * retune's network settle is `unverified`: a block summary by its first sample, a track
	 * (open, update, close) by its start sample (the pipeline labels the snapshot the same way,
	 * from `PendingEpoch.verifiedFromSample`), a transient by its sample. Other events and
	 * other epochs keep the epoch's label.
	 */
	private epochFor(ev: PipelineEvent): EngineEpoch {
		// The raw epoch: non-block events keep the epoch's own label, as before.
		const epoch = { ...this.current }
		const from = this.currentVerifiedFrom
		if (from === null || this.currentVerifiedEpoch !== epoch.epoch) return epoch
		const start = this.eventStart(ev, epoch.epoch)
		if (start === null) return epoch
		// The first block, track or transient whose data starts at or past the settle closes
		// the window for status (the pipeline emits a block's tracks before its summary).
		// Each event keeps its own data-start label.
		if (start >= from) this.statusWindowOpen = false
		return { ...epoch, tuningTrust: frameTrust(epoch.tuningTrust, start, from) }
	}

	/** The first sample of a current-epoch event's data, or null (not sample-bound or another epoch). */
	private eventStart(ev: PipelineEvent, epoch: number): number | null {
		switch (ev.kind) {
			case "block-summary":
				if (ev.summary.epoch !== epoch || !this.cfg) return null
				return (
					ev.summary.endSample -
					blockSamplesOf(
						this.cfg.integrationMs,
						this.cfg.sampleRateHz,
						this.cfg.fftSize,
					)
				)
			case "track-open":
			case "track-update":
			case "track-close":
				return ev.track.epoch === epoch ? ev.track.startSample : null
			case "transient":
				return ev.epoch === epoch ? ev.sample : null
			default:
				return null
		}
	}

	// === Internals: epoch triggers (§ 4.6, § 4.7) ===

	private subscribe(): void {
		this.deps.sources.on("disconnected", this.onDisconnected)
		this.deps.sources.on("payload-started", this.onPayloadStarted)
		this.deps.sources.on("session-started", this.onSessionStarted)
		this.deps.sources.on("caps-changed", this.onCapsChanged)
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
		this.deps.tuner?.off("command-sent", this.onCommandSent)
		this.deps.tuner?.off("state-changed", this.onStateChanged)
	}

	private readonly onDisconnected = (sourceId: string): void => {
		if (sourceId !== this.sourceId || !this.running) return
		this.awaitingPayload = true
		this.disconnectTicket = ++this.ticket
		this.queueStreamBoundary("unverified")
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
		if (accepted > this.streamStartByte) this.queueStreamBoundary("unverified")
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
		const trust =
			this.stateTrust() === "unverified" ? "unverified" : "commanded"
		this.queueExternal(
			trust,
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
		if (state.controlMode === "external")
			this.queueExternal("relay", undefined, true)
	}

	private readonly onCapsChanged = (
		sourceId: string,
		caps: SourceCaps,
	): void => {
		if (sourceId !== this.sourceId || !this.running) return
		if (caps.sampleRate !== this.cfg?.sampleRateHz) {
			if (this.suppressed === 0)
				this.queueExternal("commanded", undefined, true)
			return
		}
		if (this.suppressed > 0) return
		if (
			caps.centerFreq !== undefined &&
			caps.centerFreq !== this.expectedCentre()
		) {
			this.queueExternal("commanded", undefined, true)
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
		if (caps.centerFreq !== this.expectedCentre())
			this.queueExternal("commanded", undefined, true)
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
			this.centreOverride = null
			// The host matched now: a later move lies past what the core had forwarded by now.
			this.hostCentreOkAt = ledger?.position(this.sourceId) ?? null
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
		this.queueExternal("unverified")
	}

	/** Captures the command position now; posts at its microtask or at the next branch delivery, whichever comes first. */
	private queueExternal(
		trust: TuningTrust,
		centreHz?: number,
		checkState = false,
		ticket?: number,
		kept = false,
		newest?: number,
	): void {
		if (!this.running) return
		const own = ticket ?? ++this.ticket
		const held = this.externalPending
		if (held) {
			// Never merge across a stream boundary or a disconnect: the held command belongs to the
			// stream before it and is posted into that stream now, as its microtask would (carried
			// instead during a restart, and then dropped if a disconnect came since); this one takes
			// its own entry, ticket and clock, so it can never inherit the old stream's place.
			if (!this.boundaryBetween(held.ticket, own)) {
				this.supersede(held, {
					trust,
					...(centreHz !== undefined ? { centreHz } : {}),
					checkState,
					ticket: own,
					...(kept ? { kept } : {}),
					...(newest !== undefined ? { newest } : {}),
				})
				return
			}
			this.flushExternal()
			// Flushing can restart the pipeline, which takes this command as a carried one.
			if (!this.running) return
		}
		const clock = this.sampleClock()
		this.externalPending = {
			trust,
			commandSample: clock.commandSample,
			bufferedSamples: clock.bufferedSamples,
			...(centreHz !== undefined ? { centreHz } : {}),
			checkState,
			ticket: own,
			...(kept ? { kept } : {}),
			...(newest !== undefined ? { newest } : {}),
		}
		queueMicrotask(() => this.flushExternal())
	}

	/** True while a stream boundary queued before the command `ticket` is still ahead in the branch. */
	private boundaryAhead(ticket: number): boolean {
		return this.branchQueue.some(
			mark => mark.kind === "stream" && mark.ticket < ticket,
		)
	}

	private flushExternal(): void {
		const pending = this.externalPending
		this.externalPending = null
		if (!pending || !this.running) return
		// A restart or a boundary still ahead in the branch: the command's epoch belongs to the
		// stream that starts next (its clock is not this one's). Dropping it would leave that stream
		// on the label it started with, `unverified` after a reconnect, until another command.
		if (this.restarting || this.boundaryAhead(pending.ticket)) {
			this.carry(pending)
			return
		}
		if (pending.checkState)
			pending.trust = mergeTrust(pending.trust, this.stateTrust())
		const caps = this.deps.sources.getCaps(this.sourceId)
		if (!caps) return
		if (caps.sampleRate !== this.cfg?.sampleRateHz) {
			this.restartInBackground(pending.trust)
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
		// B1: a kept command's explicit centre was the tuner's when it was written; the scanner (its
		// writes post no external epoch), a relay or a later reconnect may have moved it before
		// this stream posted it. Caps follows every frequency write, so the label is only kept
		// when both still name the same centre; otherwise the epoch reads caps, `unverified`.
		// Fail closed by construction: a stale centre, a caps that lags the command, or a caps
		// without a centre all disagree, and each demotes rather than trusts either witness.
		if (
			pending.kept === true &&
			pending.centreHz !== undefined &&
			pending.centreHz !== caps.centerFreq
		) {
			pending.trust = mergeTrust(pending.trust, "unverified")
			delete pending.centreHz
		}
		// A host-reported centre that disagrees with ours is never `commanded` or `relay`.
		if (this.centreOverride !== null)
			pending.trust = mergeTrust(pending.trust, "unverified")
		const centreHz =
			this.centreOverride ??
			pending.centreHz ??
			caps.centerFreq ??
			this.current.centreHz
		const epoch = this.allocateEpoch()
		this.submitEpoch({
			epoch,
			commandSample: pending.commandSample,
			bufferedSamples: pending.bufferedSamples,
			settleSamples: timing.settleSamples,
			expectMarker: false,
			markerTimeoutSamples: 0,
			pllSettleSamples: 0,
			centreHz,
			sampleRateHz: fs,
			gainKey: gainKeyOf(this.deps.tuner?.getState(this.sourceId)),
			tuningTrust: pending.trust,
			centreChanged: centreHz !== this.current.centreHz,
			staleMaxMs: timing.staleMaxMs,
			...(timing.verifiedFromSample !== null
				? { verifiedFromSample: timing.verifiedFromSample }
				: {}),
		})
	}

	// === Tuning-ledger shadow (trust step 1) ===

	/** The shadow counters; null when the engine has no ledger. */
	trustShadow(): EngineTrustShadow | null {
		if (!this.ledger()) return null
		return {
			...this.shadow,
			disagreements: this.shadow.disagreements.map(d => ({ ...d })),
		}
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

	private shadowBlock(
		ev: Extract<PipelineEvent, { kind: "block-summary" }>,
		epoch: EngineEpoch,
	): void {
		const ledger = this.ledger()
		if (!ledger) return
		const map = this.streamMaps.find(m => m.stream === ev.summary.stream)
		if (map) map.summarised = Math.max(map.summarised, ev.summary.endSample)
		let read: ShadowRead
		try {
			read = this.ledgerVerdict(ledger, ev)
		} catch {
			read = unmappedRead("lookup-failed")
		}
		const verdict = read.verdict
		const engineTrust = epoch.tuningTrust
		const ledgerTrust = verdict.trust
		let kind: EngineTrustDisagreement["kind"] | null = null
		if (engineTrust !== "unverified" && ledgerTrust === "unverified")
			kind = "ledger-stricter"
		else if (engineTrust === "unverified" && ledgerTrust !== "unverified")
			kind = "ledger-looser"
		else if (
			engineTrust !== "unverified" &&
			(engineTrust !== ledgerTrust ||
				verdict.frequency !== epoch.centreHz ||
				verdict.sampleRate !== epoch.sampleRateHz)
		)
			kind = "mismatch"
		if (kind === null) {
			this.shadow.agree += 1
			return
		}
		if (kind === "ledger-stricter") this.shadow.ledgerStricter += 1
		else if (kind === "ledger-looser") this.shadow.ledgerLooser += 1
		else this.shadow.mismatch += 1
		const ring = this.shadow.disagreements
		ring.push({
			kind,
			at: this.now(),
			session: read.session,
			posA: read.posA,
			posB: read.posB,
			engineTrust,
			ledgerTrust,
			engineCentreHz: epoch.centreHz,
			ledgerCentreHz: verdict.frequency,
			engineSampleRateHz: epoch.sampleRateHz,
			ledgerSampleRateHz: verdict.sampleRate,
			...(verdict.reason !== undefined ? { reason: verdict.reason } : {}),
			...(verdict.doubtReason !== undefined
				? { doubtReason: verdict.doubtReason }
				: {}),
		})
		if (ring.length > SHADOW_DISAGREEMENTS) ring.shift()
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

	/** Bytes the absorber lost since the anchor break the offered-byte map. */
	private upstreamLost(anchor: LedgerAnchor): boolean {
		if (anchor.lost === null) return false
		const lost =
			this.deps.routing.ingestCounters?.(this.sourceId)?.lostBytesTotal ?? null
		return lost !== anchor.lost
	}

	/**
	 * The ledger's label of a block summary's samples, mapped through the block's own stream (its
	 * bytes per sample and block length), fail closed on every missing map. A block whose lower
	 * bound falls before the session's position 0 may hold the previous session's bytes:
	 * `before-session`.
	 */
	private ledgerVerdict(
		ledger: EngineLedger,
		ev: Extract<PipelineEvent, { kind: "block-summary" }>,
	): ShadowRead {
		const anchor = this.ledgerAnchor
		if (!anchor) return unmappedRead("no-anchor")
		if (this.upstreamLost(anchor)) return unmappedRead("upstream-loss")
		const map = this.streamMaps.find(m => m.stream === ev.summary.stream)
		if (!map || map.blockSamples === null) return unmappedRead("no-stream-map")
		const end = ev.summary.endSample
		const start = end - map.blockSamples
		// Lower bound of the first byte: each applied gap can round its samples up by one.
		const posA = map.oLow0 + (start - map.gaps - 1) * map.bps - anchor.oHigh
		const posB = map.oHigh0 + end * map.bps - anchor.oLow
		const live = ledger.position(this.sourceId)
		if (!live || live.session !== anchor.session)
			return unmappedRead("session-ended")
		// Never past what the source manager handed out (a valid upper bound too).
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
