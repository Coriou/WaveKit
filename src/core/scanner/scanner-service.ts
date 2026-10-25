import { narrowestPriors, withScannerOverlays } from "./classify/priors.js"
import { judgeAnalogResult } from "../iq-capture/analog-result.js"
import { AnalogAdmission } from "./analog-admission.js"
import { buildCoverageIndex } from "./discovery-coverage.js"
import type { CoverageIndex } from "./discovery-coverage.js"
import {
	ConsolidationEventQueue,
	applyConsolidationSlices,
	emitWhenListened,
} from "./consolidation-events.js"
import { protocolsForFrequency } from "./plan/protocols.js"
import { applyRangePatch } from "./plan/range-edits.js"
import {
	isRangeEnabled,
	type ScanRangeLive,
	type StoredRangeLive,
	type StoredScanJobSpec,
} from "./plan/range-contract.js"
import {
	ResumeActivity,
	type OperatorActivityPort,
	type ResumeStatus,
} from "./auto-resume.js"
/**
 * Composition root of the scanner (spec § 3): engines per source, the
 * arbiter, the probe pool, ambient evidence, the discovery/evidence stores
 * and persistence, job drivers, passive jobs, runtime settings, boot restore
 * and shutdown. Routes and WS (Tasks 36, 37) use only the public methods and
 * events listed in the plan. Events: "job", "progress", "activity",
 * "discovery", "status" and "identify"(ScannerIdentifyEventData, Task 35a).
 */
import { EventEmitter } from "node:events"
import { readdir } from "node:fs/promises"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { ZodError } from "zod"
import type {
	Bandplan as BandplanDto,
	ScanJob,
	ScanJobHit,
	ScanJobHitStats,
	ScanJobHitsResponse,
	ScannerActivityEventData,
	ScannerCapture,
	DiscoveryStoreMeta,
	ScannerDiscoveryEventData,
	ScannerEngineStatus,
	ScannerIdentifyRequest,
	ScannerProgressEventData,
	ScannerSettingsView,
	ScannerStatus,
	SpectrumBinsCapView,
	SpectrumFrameTrackScanner,
	SpectrumSourceStatus,
	ScannerProbeDecoderType,
	ScannerTrialOutcome,
} from "@wavekit/api-types"
import {
	SCANNER_AMBIENT_PROTOCOLS,
	SCANNER_AMBIENT_TARGET_TOLERANCE_HZ,
	SCANNER_DISCOVERY_HOLDS_KEPT_CODE,
} from "@wavekit/api-types"
import type {
	RecordingProtection,
	ScannerRecordingDeleter,
} from "../recordings/contract.js"
import { createScannerRecordingDeleter } from "./recording-delete.js"
import { holdsKeptWithAliases } from "./recording-aliases.js"
import type { SourceCaps } from "../../config.js"
import type { DecoderConfig } from "../../decoders/types.js"
import type { DecoderManager } from "../../decoders/manager.js"
import { createComponentLogger, type Logger } from "../../utils/logger.js"
import { WaveKitError } from "../../utils/errors.js"
import type { DigitalVoiceService } from "../digital-voice.js"
import type { LiveDemodulator } from "../live-demodulator.js"
import type { SourceFanoutRouter } from "../source-fanout-router.js"
import type { SourceConfig, SourceManager } from "../source-manager.js"
import type { TunerController } from "../tuner-controller.js"
import { sourceScannerConfig } from "../../config.js"
import {
	bandplansFor,
	priorsFor,
	type Bandplan,
	type BandRegionCode,
} from "./bandplan/index.js"
import {
	createBandRangeCache,
	withBandBurstPrior,
} from "./band-scan-burst-prior.js"
import { classifySpectral, leakOrIntermod } from "./classify/classifier.js"
import { ScannerApiError } from "./errors.js"
import {
	CaptureRecorder,
	type CaptureCloseInfo,
} from "./evidence/capture-recorder.js"
import { CaptureStore } from "./evidence/capture-store.js"
import { ulid } from "./ids.js"
import {
	IQ_CAPTURE_ORPHAN_TTL_MS,
	IQ_CAPTURE_PREROLL_MAX_MS,
} from "./iq-capture-contract.js"
import type {
	IqCaptureDiscardReason,
	IqCapturePort,
	IqCaptureRefusal,
	IqCaptureRequest,
	IqCaptureView,
	IqReplayPlanInput,
	IqReplayTrial,
	IqReplayResult,
} from "./iq-capture-contract.js"
import {
	createPoolReplayProbes,
	type ReplayPoolAdapter,
} from "../iq-capture/pool-adapter.js"
import { safeErrorFields } from "../../decoders/safe-error-fields.js"
import { probeReplayShapes } from "../iq-capture/shapes.js"
import type { IqReplayShapes } from "../iq-capture/service.js"
import {
	createIqReplayQueue,
	IQ_REPLAY_QUEUE_HOLDER,
	type IqReplayQueue,
} from "../iq-capture/replay-queue.js"
import {
	captureRemovedRelease,
	captureServiceIsOn,
	gatePassCapture,
	needsLiveConfirm,
	replayConfirmInput,
	replayEvidenceCalls,
	replayOutcomeSummary,
} from "../iq-capture/replay-first.js"
import type {
	AnalogTrialRunner,
	ProofTrialInput,
} from "./scanner-redesign-contract.js"
import { replayMissEligible } from "../iq-capture/replay-miss.js"
import { createKnownProtocolMemory } from "./known-protocol.js"
import { narrowRasterAt } from "./narrow-digital.js"
import { planReplayTrials } from "./replay-plan.js"
import type { AnalogEvidenceLog } from "./analog-evidence.js"
import {
	createLiveAudioEvidence,
	type LiveAudioEvidence,
} from "./live-audio-evidence.js"
import type { JobActivityView } from "./scanner-redesign-contract.js"
import { tuningTrustOf } from "../tuning-trust.js"
import { JobHits, emptyHitStats } from "./job-hits.js"
import {
	IDENTIFY_KEEP_JOBS,
	IdentifyRunner,
	inWindow,
	normaliseIdentify,
	type NormalisedIdentify,
} from "./identify.js"
import { artefactOf, type ArtefactKind } from "../spectrum/artefacts.js"
import { isTerminal } from "./job-state.js"
import {
	liveAudioListen,
	type ListenResult,
	type ListenStrategy,
} from "./listen.js"
import {
	JobRunner,
	jobTrialModes,
	chooseLeaseHolder,
	impactGrew,
	undecodedForProbe,
	type JobDriver,
	type JobRecord,
	type LiveObservation,
	type ProbeOutcome,
} from "./job-runner.js"
import { CPU_COST } from "./plan/cost.js"
import {
	planJob,
	previewPlan,
	type PreviewContext,
	type PreviewMeasured,
} from "./plan/plan-preview.js"
import {
	AmbientEvidence,
	type AmbientEvidenceEvent,
	type AmbientTarget,
} from "./probes/ambient.js"
import { resolveAmbientTargets } from "./probes/ambient-target.js"
import { pickChannelObservation } from "./probes/ambient-channel.js"
import {
	ProbePool,
	REPLAY_PROBE_PRIORITY,
	offsetTransport,
	probeModesFor,
	type ProbeMode,
	type ProbeRecordings,
	type ProbeRequest,
	type ProbeUnavailableStop,
	type TransportStrategy,
} from "./probes/probe-pool.js"
import { createReplayTransport } from "./probes/replay-transport.js"
import {
	DEFAULT_TUNING,
	USABLE_FRACTION,
	faTargetForSensitivity,
	isScannerIqFormat,
	type EngineEpoch,
	type EngineStreamReason,
	type EngineTuning,
	type HostCentreReader,
	type SpectrumEngine,
} from "../spectrum/spectrum-engine.js"
import { SpectrumService } from "../spectrum/spectrum-service.js"
import {
	DiscoveryStore,
	estimateFrequencyError,
	type DiscoveryFilter,
	type StoreChange,
} from "./store/discovery-store.js"
import {
	DISCOVERY_ID,
	EvidenceStore,
	type StorageCaps,
} from "./store/evidence-store.js"
import {
	SCANNER_JOURNAL_BACKLOG_CODE,
	ScannerPersistence,
	type ConsolidationPlanFile,
	type LoadedState,
	type PersistedJob,
	type PersistedLease,
	type RuntimeSettingsOverrides,
} from "./store/persistence.js"
import { PassiveGuard } from "./passive-guard.js"
import { PASSIVE_COST_LIMIT_DEFAULT } from "./passive-cost-contract.js"
import {
	SCANNER_SETTINGS_BOUNDS,
	applySettingsPatch,
	mergeScannerSettings,
	type EffectiveScannerSettings,
} from "./settings.js"
import {
	TunerArbiter,
	type Lease,
	type LeaseLostReason,
} from "./tuner-arbiter.js"
import type {
	BlockSummary,
	EngineState,
	FreqRange,
	ObservationEndReason,
	PipelineEvent,
	TrackSnapshot,
	TuningTrust,
} from "../spectrum/types.js"
import type {
	Classification,
	DecodeEvidence,
	Discovery,
	Hop,
	HopPlan,
	Identity,
	Impact,
	BandPlanSkipRange,
	BandPlanSkipSource,
	DecodedElsewhereRange,
	DecoderCoverageView,
	LockoutExclusion,
	NormalisedJobSpec,
	Observation,
	PlanIssue,
	PlanPreview,
	ScanJobSpec,
	ScanRange,
	ScannerProtocol,
	ScannerSettings,
	UndecodedReason,
} from "./types.js"
import { AMBIENT_PAIR_MS } from "./types.js"
import {
	coverageFingerprint,
	createCoverageRefresh,
	type CoverageRefresh,
} from "./plan/coverage-refresh.js"

import type { ChannelProvider } from "../channelizer/types.js"
import type { CleanupOutcome } from "../channelizer/settlement-observer.js"
import {
	ScannerLifecycleOwner,
	type ScannerStopHandle,
} from "./channel/consumer-lifecycle.js"
import { ChannelTaps, type ChannelTapHandle } from "./channel/channel-tap.js"
import {
	RecordingProducers,
	type RecordingGrantIdentity,
	type RecordingNativeOutcome,
	type RecordingProducerHandle,
} from "./channel/recording-producer.js"
import type {
	ObservedDecoderEligibility,
	ScannerChannelOwnership,
	ScannerChannelProfile,
	ScannerChannelTier,
} from "./channel/consumer-types.js"
import { recordingEngineInstanceId } from "./store/recording-operation.js"
import { extractChannelFeatures } from "./classify/channel-features.js"
import { refineChannelClassification } from "./classify/channel-tier.js"
import { updateChannelAdmission } from "./plan/resource-admission.js"
import type { AnalogCut } from "./store/analog-operations.js"
import type { IdentifyAnalogEvidence } from "./identify-analog-contract.js"
import {
	CHANNEL_GATE_DEFAULT_WIDTH_HZ,
	CHANNEL_GATE_MAX_WIDTH_HZ,
	CHANNEL_GATE_MIN_WIDTH_HZ,
	type ChannelPlan,
	type ChannelPlanEntry,
} from "./scanner-redesign-contract.js"

/**
 * WG11 req 6: the IQ capture service as the scanner uses it (the port plus the epoch flush). The
 * scanner hands it the replay shapes (from the probe channel requests) when it is constructed, so
 * the composition root never imports the probe channel modules.
 */
export type ScannerIqCapture = IqCapturePort & {
	/** Review M2: a capture held for `holder` from the start (identify's own request). */
	captureFor(
		req: IqCaptureRequest,
		holder: string,
	): { captureId: string } | { refused: IqCaptureRefusal }
	/** A ready capture's view (any holder), else null. */
	view(captureId: string): IqCaptureView | null
	/** The replay queue's port (the scanner owns the queue): finished captures, holders, discard. */
	onFinished(listener: (view: IqCaptureView) => void): () => void
	/** Safety: a capture left the store (any reason). */
	onRemoved(
		listener: (captureId: string, observationId: string | null) => void,
	): () => void
	holderOf(captureId: string): string | null | undefined
	discard(
		captureId: string,
		reason: IqCaptureDiscardReason,
		holder?: string,
	): boolean
	counters?(): NonNullable<ScannerStatus["iqCapture"]>
	setShapes(shapes: IqReplayShapes): void
	flush(
		sourceId: string,
		next?: { epoch?: number; centerHz?: number; sampleRateHz?: number },
	): void
	attachSource(
		sourceId: string,
		source: {
			sampleRateHz: number
			centerHz: number
			epoch: number
			engine: Pick<SpectrumEngine, "tap" | "liveEdge">
		},
	): void
	detachSource(sourceId: string): void
	/**
	 * WG12: `"on"` while capture runs. Absent, or any other state, means capture
	 * is not running (off, legacy, missing binary), so confirm keeps today's path.
	 */
	state?(): "idle" | "off" | "not-protected" | "unavailable" | "on" | "stopped"
}

/** Review m3: planned replay trials kept per capture (the queue holds one at a time; slack for races). */
const REPLAY_PLANS_MAX = 64
/** closed observation spans kept for late replay results. */
const REPLAY_SPANS_MAX = 1024

export interface ScannerServiceDeps {
	settings: ScannerSettings
	/** WG11 req 6: IQ capture on detection and replay; absent keeps today's behaviour. */
	readonly analogTrial?: AnalogTrialRunner
	readonly iqCapture?: ScannerIqCapture
	/** WG10 req 3: the live demodulator's transmission evidence for identify; absent keeps today's behaviour. */
	readonly analogEvidence?: IdentifyAnalogEvidence
	/** WG9 req 2.5-2.6: the recording deletion decision; absent keeps today's behaviour. */
	readonly recordingProtection?: RecordingProtection
	readonly construction?: ScannerLifecycleOwner
	readonly channels?: ChannelProvider | null
	readonly channelUsableFraction?: number
	readonly channelTier?: ScannerChannelTier
	readonly channelProfile?: ScannerChannelProfile | null
	readonly channelOwnership?: ScannerChannelOwnership
	readonly observedDecoderEligible?: ObservedDecoderEligibility
	sourceConfigs: readonly SourceConfig[]
	decoderConfigs: readonly DecoderConfig[]
	region: BandRegionCode
	/** Effective plans from the band-plan stack, read per call. Absent: bandplansFor(region). */
	bandplans?: () => readonly Bandplan[]
	stateDir: string
	sources: SourceManager
	routing: SourceFanoutRouter
	tuner: TunerController
	decoders: DecoderManager
	digitalVoice: DigitalVoiceService | null
	liveDemod: LiveDemodulator | null
	logger: Logger
	now?: () => number
	engineHost?: "thread" | "inline"
	transports?: readonly TransportStrategy[]
	/** Default liveAudioListen; Task 46 passes the monitor strategy. */
	listen?: ListenStrategy
	cpuMeter?: {
		start(): void
		stop(): void
		readonly normalisedPercent: number | null
		readonly mode?: "os" | "cgroup"
	}
	tickMs?: number
	operatorActivity?: OperatorActivityPort
	hostCentre?: HostCentreReader
	/**
	 * WG6 req 1.1: the decoders plans may treat as covering frequencies elsewhere, read once per
	 * plan. Absent: no `decodedElsewhere` and plans exactly as before. A throw counts as none.
	 */
	decoderCoverage?: () => readonly DecoderCoverageView[]
	/**
	 * WG8 req 5.4: the host bins cap resolved once at startup, handed to the spectrum service
	 * (client bound, `limits.binsCap`, engine summary budget). Absent: the frozen 2048 floor.
	 */
	spectrumBinsCap?: () => SpectrumBinsCapView
	/**
	 * WG7 req 6.2: the skip-marked band-plan segments, read once per plan. Absent: no
	 * `bandPlanSkips` and plans exactly as before. A throw counts as none.
	 */
	bandPlanSkips?: () => readonly BandPlanSkipSource[]
	/**
	 * WG7 req 1.3: reception trust of a config-owned ambient decoder whose decode at `hz` lies
	 * on `sourceId` (the source its ambient target names). Absent: ambient AIS, ACARS, VDL2 and
	 * LoRa decodes are never evidence. Only `commanded`/`relay` count; a throw counts as none.
	 */
	ambientTrust?: (
		decoderId: string,
		hz: number,
		sourceId: string,
	) => TuningTrust | undefined
}

/** WG7 req 7.1: decoder manager events after which decoded-elsewhere ranges are refreshed. */
const COVERAGE_EVENTS = [
	"decoder:created",
	"decoder:started",
	"decoder:stopped",
	"decoder:error",
	"decoder:restarting",
	"decoder:max-restarts",
	"decoder:removed",
	"decoder:health",
	"decoder:status-changed",
] as const

const SNAPSHOT_EVERY_MS = 10_000
/** Fastest on-demand snapshot after a journal hole (a full-store clone + stringify each). */
const SNAPSHOT_REQUEST_MIN_MS = 1_000
const MAINTENANCE_EVERY_MS = 5 * 60_000
const STATUS_EVERY_MS = 1_000
/** WG15 DQ 7.8: consolidation groups applied per event-loop turn at start-up. */
const CONSOLIDATE_SLICE_GROUPS = 16
const RECENT_KEEP_MS = 10_000
const RECONFIRM_AFTER_MS = 15 * 60_000
/** Task 29 review, finding 6: bound on waiting for the source caps to show a restored tuning. */
const RESTORE_CAPS_TIMEOUT_MS = 1_000
/** Track ids closed by the service (real or synthesized), kept to ignore their late events (R2). */
const CLOSED_TRACKS_KEEP = 4096
const BURST_PROTOCOLS: ReadonlySet<ScannerProtocol> = new Set([
	"ism",
	"pocsag",
	"aprs",
])
/** § 7.4: re-key when the estimate moves by more than half the smallest raster tolerance (rasterToleranceHz ≥ 1 kHz). */
const REKEY_MIN_CHANGE_HZ = 500

function storageCaps(s: ScannerSettings): StorageCaps {
	return {
		maxRecordingsMb: s.storage.maxRecordingsMb,
		maxEvidenceMb: s.storage.maxEvidenceMb,
		maxAgeDays: s.storage.maxAgeDays,
		minFreeDiskMb: s.storage.minFreeDiskMb,
	}
}

function emptyLoadedState(): LoadedState {
	return {
		discoveries: [],
		observations: [],
		corrections: [],
		lastSeq: 0,
		entries: [],
		jobs: [],
		leases: [],
		settings: {},
		engines: {},
		droppedLines: 0,
		recoveryHealth: "degraded",
	}
}

function intersectRanges(sets: FreqRange[][]): FreqRange[] {
	if (sets.length === 0) return []
	let acc = sets[0]!
	for (const set of sets.slice(1)) {
		const next: FreqRange[] = []
		for (const a of acc) {
			for (const b of set) {
				const startHz = Math.max(a.startHz, b.startHz)
				const endHz = Math.min(a.endHz, b.endHz)
				if (startHz < endHz) next.push({ startHz, endHz })
			}
		}
		acc = next
	}
	return acc
}

function linkOf(cfg: SourceConfig): "local" | "network" {
	const host = cfg.host ?? "127.0.0.1"
	return host === "127.0.0.1" || host === "localhost" || host === "::1"
		? "local"
		: "network"
}

export class ScannerService extends EventEmitter {
	private readonly consumerLifecycle: ScannerLifecycleOwner
	private readonly channelTaps: ChannelTaps | undefined
	private readonly channelProducers: RecordingProducers
	// Effective producer adoption requires Main's exact assembled runtime acceptance.
	private readonly channelProducerAdopted: boolean = false
	private readonly channelRecordingOwners = new Map<
		object,
		{
			readonly identity: RecordingGrantIdentity
			readonly tap: ChannelTapHandle
			readonly observationId: string
			producer: RecordingProducerHandle | undefined
			offProof: (() => void) | undefined
			nativeClosed: boolean
			componentClosed: boolean
			inspect: (() => void) | undefined
		}
	>()
	private readonly channelSubscriptions: (() => void)[] = []
	private probeComponentDrain: Promise<void> | undefined
	private channelAdmissionRevision = 0
	private readonly channelEngineStarts = new Map<string, SpectrumEngine>()
	/** Six arbiter registrations plus the pool's sole constructor registration. */
	private readonly constructorListeners: {
		remove: () => void
		settled: boolean
	}[] = []
	private readonly ownConstructorListener = (remove: () => void): boolean => {
		if (
			this.consumerLifecycle.admissionSealed ||
			this.constructorListeners.length >= 7
		)
			return false
		this.constructorListeners.push({ remove, settled: false })
		return true
	}
	private readonly channelTier: ScannerChannelTier
	private readonly log: Logger
	/** Band inspection UX req 3.2: consolidation events raised before a listener attached. */
	private readonly consolidationEvents = new ConsolidationEventQueue()
	/** Band inspection UX req 1.4: over-long decoder ids already logged (bounded). */
	private readonly coverageSkipLogged = new Set<string>()
	private readonly now: () => number
	private readonly storageDir: string
	private readonly persistence: ScannerPersistence
	private readonly store: DiscoveryStore
	private readonly evidence: EvidenceStore
	/** WG10 req 1.1: the scanner side of a `scan:` recording delete. */
	private readonly recordingDeleter: ScannerRecordingDeleter
	private readonly arbiter: TunerArbiter
	private readonly probes: ProbePool
	private readonly ambient: AmbientEvidence
	/** Core spectrum service (engines, frames, occupancy); also served at /api/spectrum. */
	readonly spectrum: SpectrumService
	private readonly analogAttempted = new WeakSet<LiveObservation>()
	private readonly analogCounts = new Map<string, number>()
	private readonly analogJobs = new Map<
		string,
		{
			controller: AbortController
			channelKey: string
			discoveryId: string | null
			sourceId: string
		}
	>()
	/** At most 128 held captures; each expires with the capture store's ten-minute TTL. */
	private readonly analogDeferred = new Map<
		string,
		{
			live: LiveObservation
			track: TrackSnapshot
			captureId: string | null
			at: number
		}
	>()
	private readonly analogRefusals = new Map<
		string,
		{ at: number; suppressed: number; total: number }
	>()

	private refuseAnalog(
		live: {
			sourceId: string
			observationId: string | null
			discoveryId: string | null
		},
		reason: string,
	): void {
		const safeId = (id: string | null): string | null =>
			id !== null && /^[a-zA-Z0-9_-]{1,128}$/.test(id) ? id : null
		const now = this.now()
		const prior = this.analogRefusals.get(reason)
		if (prior) prior.total++
		if (prior && now - prior.at < 60_000) {
			prior.suppressed++
			this.log.debug(
				{
					sourceId: safeId(live.sourceId),
					observationId: safeId(live.observationId),
					discoveryId: safeId(live.discoveryId),
					reason,
					total: prior.total,
				},
				"Analog trial refusal suppressed",
			)
			return
		}
		this.analogRefusals.set(reason, {
			at: now,
			suppressed: 0,
			total: prior?.total ?? 1,
		})
		this.log.info(
			{
				sourceId: safeId(live.sourceId),
				observationId: safeId(live.observationId),
				discoveryId: safeId(live.discoveryId),
				reason,
				activeSource: this.analogCounts.get(live.sourceId) ?? 0,
				activeTotal: this.analogJobs.size,
				activeDiscovery: [...this.analogJobs.values()].filter(
					trial =>
						trial.sourceId === live.sourceId &&
						trial.discoveryId === live.discoveryId,
				).length,
				total: prior?.total ?? 1,
				deferred: this.analogDeferred.size,
				suppressed: prior?.suppressed ?? 0,
			},
			"Analog trial refused",
		)
	}

	private deferAnalog(live: LiveObservation, track: TrackSnapshot): void {
		const pending = this.analogDeferred.get(live.observationId)
		if (pending?.captureId != null) return
		const port = this.deps.iqCapture
		if (!port) {
			this.refuseAnalog(live, "capture-unavailable")
			return
		}
		if (!pending && this.analogDeferred.size >= 128) {
			this.refuseAnalog(live, "deferred-full")
			return
		}
		const result = port.captureFor(
			{
				sourceId: live.sourceId,
				observationId: live.observationId,
				epoch: track.epoch,
				rfHz: track.centreHz,
				tuningTrust: track.tuningTrust,
				fromSample: track.startSample,
				reason: "detection",
			},
			`analog-${live.observationId}`,
		)
		if ("refused" in result) {
			this.refuseAnalog(live, `capture-${result.refused}`)
			if (["busy", "full", "rate-limited"].includes(result.refused))
				this.analogDeferred.set(live.observationId, {
					live,
					track,
					captureId: null,
					at: pending?.at ?? this.now(),
				})
			return
		}
		this.analogDeferred.set(live.observationId, {
			live,
			track,
			captureId: result.captureId,
			at: this.now(),
		})
		if (live.endedAt !== undefined) port.end(result.captureId)
	}

	private retryAnalog(): void {
		if (this.consumerLifecycle.admissionSealed) return
		for (const [id, pending] of this.analogDeferred) {
			const port = this.deps.iqCapture
			if (pending.captureId === null) {
				if (
					this.now() - pending.at >= IQ_CAPTURE_PREROLL_MAX_MS ||
					(pending.live.endReason !== undefined &&
						pending.live.endReason !== "quiet" &&
						pending.live.endReason !== "max-duration") ||
					this.discoveryLockedOut(pending.live.discoveryId)
				) {
					this.analogDeferred.delete(id)
					this.refuseAnalog(
						pending.live,
						this.discoveryLockedOut(pending.live.discoveryId)
							? "lockout"
							: "capture-preroll-expired",
					)
				} else this.deferAnalog(pending.live, pending.track)
				continue
			}
			if (
				!port ||
				port.holderOf(pending.captureId) === undefined ||
				this.now() - pending.at >= IQ_CAPTURE_ORPHAN_TTL_MS ||
				this.discoveryLockedOut(pending.live.discoveryId) ||
				(pending.live.endReason !== undefined &&
					pending.live.endReason !== "quiet" &&
					pending.live.endReason !== "max-duration")
			) {
				const reason =
					!port || port.holderOf(pending.captureId) === undefined
						? "capture-gone"
						: this.discoveryLockedOut(pending.live.discoveryId)
							? "lockout"
							: this.now() - pending.at >= IQ_CAPTURE_ORPHAN_TTL_MS
								? "deferred-ttl"
								: "observation-ended"
				this.analogDeferred.delete(id)
				port?.settle(pending.captureId, `analog-${id}`)
				this.refuseAnalog(pending.live, reason)
			} else if (port.view(pending.captureId))
				this.requestJobAnalog(pending.live, pending.track)
		}
	}
	private readonly captures: CaptureStore
	private readonly recorder: CaptureRecorder
	private readonly jobs = new Map<string, JobRecord>()
	private readonly drivers = new Map<string, JobDriver>()
	/** WG2 req 13: per-job hit statistics (in memory; reset on start, dropped with the job). */
	private readonly hits = new Map<string, JobHits>()
	/** Store changes raised inside one ingest, emitted after its hits are counted (WG2 req 13.2). */
	private ingestChanges:
		| [string, StoreChange, readonly string[] | undefined][]
		| null = null
	/** WG15 DQ 8: the passive guard's windows, baselines and trials per source. */
	private readonly passiveGuard = new PassiveGuard()
	private readonly live = new Map<string, LiveObservation>()
	private recent: LiveObservation[] = []
	private readonly bestPsd = new Map<
		string,
		{ startHz: number; binHz: number; bins: number[]; snrDb: number }
	>()
	private readonly lastConfirm = new Map<string, number>()
	/** WG11 req 1.7: the known protocol is the store's decoded protocol (`get` clones: no cheaper read). */
	private readonly knownProtocols = createKnownProtocolMemory({
		discovery: id => {
			const d = this.store.get(id)
			return d ? { protocol: d.protocol, confidence: d.confidence } : undefined
		},
	})
	/** WG11 req 1.4: the band-plan ranges of the sweep ISM fill, rebuilt only when the plans change. */
	private readonly bandBurstRanges = createBandRangeCache()
	private readonly persistedLeases = new Map<string, PersistedLease>()
	private readonly bootResume = new Map<string, string[]>()
	private readonly passiveDisabled = new Map<string, string>()
	private readonly probeOutcomes = new Map<string, ProbeTrialBook>()
	/** WG11 req 6.3: observations a detection capture was tried for (once each) and their capture ids. */
	private readonly iqTried = new Set<string>()
	private readonly iqCaptureLifecycle = new Map<
		string,
		{ captureId: string; sourceId: string }
	>()
	private readonly iqCaptureOf = new Map<
		string,
		{ captureId: string; sourceId: string }
	>()
	/** WG12: detection captures the port refused, or that were dropped before a result. */
	private readonly iqRefused = new Set<string>()
	/** WG12: replay applied for an observation, and whether that result decoded. */
	private readonly replaySettled = new Map<string, boolean>()
	/** True while a replay result is applied: its decode is not a live confirmation. */
	private applyingReplay = false
	/** Review m3: each queued capture's planned trials until its result (bounded, oldest evicted). */
	private readonly replayPlans = new Map<string, readonly IqReplayTrial[]>()
	/** The engine each source is attached to in the capture service. */
	private readonly iqEngines = new Map<string, SpectrumEngine>()
	private readonly frequencyErrors = new Map<
		string,
		{ hz: number; ppm: number; n: number }
	>()
	/** Latest block summary per source (identify measurements when no track resolved, § 10.8). */
	private readonly lastSummaries = new Map<string, BlockSummary>()
	/** Per source: track events of streams below this one are late (the stream ended, R2). */
	private readonly streamFloor = new Map<string, number>()
	private readonly closedTracks = new Set<string>()
	private passiveChain: Promise<void> = Promise.resolve()
	/** Maintenance and passive-cost checks started by the tick (finding 5). */
	private readonly background = new Set<Promise<void>>()
	private overrides: RuntimeSettingsOverrides = {}
	private effective: EffectiveScannerSettings
	private measured: PreviewMeasured = {
		settleMs: { local: null, network: null },
		markerSupported: {},
		probeStartMs: null,
	}
	private disk: "ok" | "disk-low" = "ok"
	private dirty = false
	/** False when the persisted state could not be read: the journal and snapshot are not written this run. */
	private stateLoaded = false
	private recordingRecoveryHealthy = false
	/** Exact prepared/inverse entries only; the normal mutation listener remains the sole writer. */
	private readonly recordingAppends = new Map<
		Parameters<ScannerPersistence["append"]>[0],
		Promise<number> | null
	>()
	/**
	 * False when even jobs, settings and engine state could not be read (`loadConfig` rejected): their
	 * files are never written this run, and sweeps and settings changes are refused (503).
	 */
	private configLoaded = true
	/** Lease arbitration per source, serialised (P16). */
	private readonly arbitrations = new Map<string, Promise<void>>()
	/** Queued arbitration per source and its candidate filter; null = all waiters (R3). */
	private readonly arbitrationQueued = new Map<
		string,
		((r: JobRecord) => boolean) | null
	>()
	/** Jobs whose lease an operator or relay write took: their end is not handed over at once. */
	private readonly operatorLost = new Set<string>()
	private timer: NodeJS.Timeout | null = null
	private lastSnapshotAt = 0
	/** The periodic snapshot still being written: no second clone + stringify while it lags. */
	private snapshotInFlight = false
	/** A journal hole asked for a snapshot sooner than the periodic interval. */
	private snapshotRequested = false
	private snapshotFailed = false
	/** Maintenance still running behind a slow disk: the next one waits for it. */
	private maintenanceInFlight = false
	private lastMaintenanceAt = 0
	private lastStatusAt = 0
	private lastStatusJson = ""
	private startupAttempted = false
	private started = false
	private startPromise: Promise<void> | null = null

	constructor(private readonly deps: ScannerServiceDeps) {
		super()
		// WG11 req 6.7: the replay shapes come from the probe channel requests this module owns.
		deps.iqCapture?.setShapes(probeReplayShapes())
		if (
			deps.construction &&
			deps.channelOwnership &&
			deps.construction !== deps.channelOwnership.construction
		)
			throw new WaveKitError(
				"Scanner construction owner mismatch",
				"SCANNER_OWNER_MISMATCH",
			)
		const external = deps.construction ?? deps.channelOwnership?.construction
		this.consumerLifecycle = external ?? new ScannerLifecycleOwner()
		this.channelTier = Object.freeze({
			enabled: deps.channelTier?.enabled ?? false,
			minMs: deps.channelTier?.minMs ?? 500,
		})
		if (
			!Number.isInteger(this.channelTier.minMs) ||
			this.channelTier.minMs < 300 ||
			this.channelTier.minMs > 2000
		)
			throw new WaveKitError(
				"Invalid scanner channel tier",
				"SCANNER_CHANNEL_TIER_INVALID",
			)
		if (
			!this.consumerLifecycle.ownCleanup("service", () =>
				this.cleanupServiceComponents(),
			) ||
			!this.consumerLifecycle.ownCleanup("probes", async () => {
				await this.drainProbeComponents()
				return { ok: true }
			}) ||
			!this.consumerLifecycle.ownCleanup(
				"tap",
				async () => this.channelTaps?.stop() ?? { ok: true },
			) ||
			!this.consumerLifecycle.ownCleanup("producer", async () => {
				const results = (await this.channelProducers?.stop()) ?? []
				return results.some(result => !result.componentClosed)
					? {
							ok: false,
							state: "failed",
							detail: "Scanner analog producer cleanup failed",
						}
					: { ok: true }
			}) ||
			!this.consumerLifecycle.ownCleanup("grants", async () => {
				let outcome: CleanupOutcome = { ok: true }
				try {
					if (this.channelTaps) outcome = await this.channelTaps.stop()
				} catch {
					outcome = {
						ok: false,
						state: "unknown",
						detail: "Scanner channel component cleanup unknown",
					}
				}
				const retained: (() => void)[] = []
				for (const off of this.channelSubscriptions) {
					try {
						off()
					} catch {
						retained.push(off)
						if (outcome.ok)
							outcome = {
								ok: false,
								state: "unknown",
								detail: "Scanner channel subscription cleanup unknown",
							}
					}
				}
				this.channelSubscriptions.splice(
					0,
					this.channelSubscriptions.length,
					...retained,
				)
				return outcome
			})
		)
			throw new WaveKitError(
				"Scanner cleanup ownership unavailable",
				"SCANNER_OWNER_UNAVAILABLE",
			)
		try {
			this.log = createComponentLogger(deps.logger, "ScannerService")
			this.now = deps.now ?? Date.now
			this.storageDir =
				deps.settings.storage.dir || join(deps.stateDir, "scanner")
			this.effective = mergeScannerSettings({
				config: deps.settings,
				sources: deps.sourceConfigs,
				overrides: {},
			})
			this.persistence = new ScannerPersistence({
				dir: this.storageDir,
				logger: deps.logger,
				now: this.now,
			})
			this.spectrum = new SpectrumService({
				sources: deps.sources,
				routing: deps.routing,
				tuner: deps.tuner,
				sourceConfigs: deps.sourceConfigs,
				settings: () => this.settings(),
				tuning: sourceId => this.engineTuning(sourceId),
				// Engine state keeps the config-load gate (Task 35): never written when jobs and settings could not be read.
				persistence: {
					writeEngine: (sourceId, state) =>
						this.writeEngineState(sourceId, state),
					loadEngine: sourceId => this.persistence.loadEngine(sourceId),
					// Occupancy keeps the same gate (S1-B final review, Info 2).
					writeOccupancy: (sourceId, state) =>
						this.configLoaded
							? this.persistence.writeOccupancy(sourceId, state)
							: Promise.resolve(),
					loadOccupancy: sourceId => this.persistence.loadOccupancy(sourceId),
				},
				logger: deps.logger,
				now: this.now,
				engineHost: deps.engineHost ?? "thread",
				...(deps.hostCentre ? { hostCentre: deps.hostCentre } : {}),
				...(deps.spectrumBinsCap ? { binsCap: deps.spectrumBinsCap } : {}),
				// From the open, so the pool's lag guard sees every stream boundary (Task 34).
				engineCreated: (sourceId, engine) => {
					// This hook runs BEFORE engine.start; revoke queued capabilities before extra work.
					this.channelEngineStarts.set(sourceId, engine)
					this.invalidateChannelAdmission()
					this.probes.watchEngine(sourceId, engine)
					// WG11 batch review R1 3: any stop of this engine (job release, display close, source
					// removal) detaches it from the capture service, not only a fatal failure.
					if (deps.iqCapture)
						engine.on("stream", (_stream: number, reason: string) => {
							if (reason === "stop") this.detachIqEngine(sourceId, engine)
						})
				},
			})
			// WG11 req 5.3: frame tracks carry the scanner's identity of a live track (null-safe,
			// owned here so the entry-point composition is unchanged).
			this.spectrum.setTrackIdentityLookup((sourceId, trackId) =>
				this.trackIdentity(sourceId, trackId),
			)
			this.store = new DiscoveryStore({
				maxDiscoveries: deps.settings.storage.maxDiscoveries,
				now: this.now,
				newId: () => ulid(this.now()),
				minSurfaceBlocks: deps.settings.detection.minSurfaceBlocks,
				rasters: (sourceId, hz) => this.rastersAt(sourceId, hz),
				hintScope: () => ({
					region: this.deps.region,
					ranges: withScannerOverlays(
						(this.deps.bandplans?.() ?? bandplansFor(this.deps.region)).flatMap(
							p => p.ranges,
						),
					),
				}),
				logger: this.log,
				...(deps.recordingProtection
					? {
							discoveryHoldsKept: (id: string) =>
								deps.recordingProtection
									? holdsKeptWithAliases(
											deps.recordingProtection,
											alias => this.store.aliasesOf(alias),
											id,
										)
									: true,
						}
					: {}),
			})
			this.evidence = new EvidenceStore({
				dir: this.storageDir,
				caps: storageCaps(deps.settings),
				logger: deps.logger,
				now: this.now,
				isDiscoveryLive: id => this.store.get(id) !== undefined,
				aliases: {
					aliasOwner: id => this.store.aliasOwner(id),
					aliasesOf: id => this.store.aliasesOf(id),
					releaseAliases: id => this.store.releaseAliases(id),
				},
				...(deps.recordingProtection
					? { protection: deps.recordingProtection }
					: {}),
			})
			// WG10 req 1.6: a capacity eviction removes the evicted folders like an inactive prune.
			this.store.on("evicted", this.onStoreEvicted)
			this.recordingDeleter = createScannerRecordingDeleter({
				evidence: this.evidence,
				discovery: this.store,
				logger: deps.logger,
			})
			this.evidence.configureAnalog({
				authorityHealthy: () =>
					this.stateLoaded && this.recordingRecoveryHealthy,
				// Effective channel consumer adoption is separately gated. No grant is inferred here.
				bindingLive: binding =>
					this.channelProducerAdopted &&
					this.channelProducers?.bindingLive(binding) === true,
				association: (discoveryId, observationId, binding) =>
					this.store.recordingAssociation(discoveryId, observationId, binding),
				prepare: metadata =>
					this.acknowledgeRecordingMutation(beforeEmit => {
						this.store.prepareRecording(metadata, beforeEmit)
					}),
				inverse: operationId =>
					this.acknowledgeRecordingMutation(beforeEmit => {
						this.store.removePreparedRecording(operationId, beforeEmit)
					}),
				buildCommitPlan: operationId =>
					this.store.buildRecordingCommitPlan(operationId),
				commitPlanCurrent: plan => this.store.recordingCommitPlanCurrent(plan),
				publishCommit: plan => this.store.publishRecordingCommit(plan),
			})
			this.captures = new CaptureStore({
				dir: join(this.storageDir, "captures"),
				logger: deps.logger,
				now: this.now,
			})
			this.recorder = new CaptureRecorder({
				store: this.captures,
				engines: sourceId => this.spectrum.engine(sourceId),
				diskOk: () => this.disk === "ok",
				logger: deps.logger,
				now: this.now,
			})
			// Each capture can be ~100 MB: enforce the cap at once, not only at the 5 min maintenance.
			this.recorder.on("captured", () => {
				this.captures
					.retention(this.settings().storage.maxCapturesMb * 1024 * 1024)
					.catch((err: unknown) =>
						this.log.warn({ err }, "Capture retention failed"),
					)
			})
			this.arbiter = new TunerArbiter({
				ownConstructorListener: this.ownConstructorListener,
				tuner: deps.tuner,
				sources: deps.sources,
				epochs: sourceId => this.spectrum.engine(sourceId),
				settings: () => this.settings(),
				link: sourceId => {
					const cfg = deps.sourceConfigs.find(c => c.id === sourceId)
					return cfg ? linkOf(cfg) : "network"
				},
				persistLease: (sourceId, lease) => this.onPersistLease(sourceId, lease),
				impactSources: {
					liveDemod: deps.liveDemod,
					digitalVoice: deps.digitalVoice,
					decoders: deps.decoders,
				},
				scannerJobsOn: (sourceId, except) =>
					[...this.jobs.values()]
						.filter(
							j =>
								j.spec.sourceId === sourceId &&
								!j.passive &&
								j.id !== except &&
								!isTerminal(j.state),
						)
						.map(j => j.id),
				// Ruling R1: `preempted-job` is invalid from `starting`; the new job gets 409 and retries.
				canHandOver: jobId => this.jobs.get(jobId)?.state !== "starting",
				logger: deps.logger,
				now: this.now,
			})
			this.probes = new ProbePool({
				ownConstructorListener: this.ownConstructorListener,
				decoders: deps.decoders,
				digitalVoice: deps.digitalVoice,
				engines: sourceId => this.spectrum.engine(sourceId),
				settings: () => this.settings(),
				transports: [
					...(deps.transports ?? [offsetTransport]),
					...(deps.iqCapture ? [createReplayTransport(deps.iqCapture)] : []),
				],
				cpu: {
					get normalisedPercent() {
						return deps.cpuMeter?.normalisedPercent ?? null
					},
				},
				engineCount: () => this.spectrum.sourceIds().length,
				storageDir: this.storageDir,
				allocatePort: () => this.allocatePort(),
				logger: deps.logger,
				now: this.now,
			})
			this.ambient = new AmbientEvidence({
				decoders: deps.decoders,
				targetOf: id => this.ambientTarget(id),
				epochOf: sourceId =>
					this.spectrum.engine(sourceId)?.currentEpoch().epoch ?? null,
				logger: deps.logger,
				now: this.now,
				sampleRateOf: sourceId => deps.sources.getCaps(sourceId)?.sampleRate,
				...(deps.ambientTrust ? { tuningTrustOf: deps.ambientTrust } : {}),
			})
			this.channelTaps = deps.channelOwnership
				? new ChannelTaps({
						channels: deps.channels,
						ownership: deps.channelOwnership,
						profile: deps.channelProfile,
						maxSources: Math.max(1, deps.sourceConfigs.length),
						now: () => performance.now(),
					})
				: undefined
			this.channelProducers = new RecordingProducers({
				enabled: this.channelTier.enabled,
				profileReady: Boolean(
					deps.channelProfile && deps.channelOwnership?.ledger,
				),
				adoptionReady: this.channelProducerAdopted,
				maxOwners: Math.max(1, deps.sourceConfigs.length),
				isCurrentCommitted: identity => {
					const owner = this.channelRecordingOwners.get(identity.token)
					return (
						owner !== undefined &&
						owner.identity.provider === identity.provider &&
						identity.provider === deps.channels &&
						owner.tap.current &&
						Object.entries(owner.identity.binding).every(
							([key, value]) => Reflect.get(identity.binding, key) === value,
						)
					)
				},
				beginAnalogComponent: identity =>
					this.channelRecordingOwners.get(identity.token)?.tap.beginAnalog() ===
					true,
				beginAnalog: input => this.evidence.beginAnalog(input),
				releaseLogical: identity =>
					this.channelRecordingOwners
						.get(identity.token)
						?.tap.releaseLogical() ??
					Promise.reject(
						new WaveKitError(
							"Scanner recording owner missing",
							"SCANNER_CHANNEL_CLEANUP_PENDING",
						),
					),
			})
			if (deps.channelOwnership) {
				this.channelSubscriptions.push(
					deps.channelOwnership.observer.subscribeGrants(handle => {
						if (this.consumerLifecycle.admissionSealed) handle.cancel()
					}),
				)
				this.channelSubscriptions.push(
					deps.channelOwnership.observer.subscribeEnded(() => {
						this.channelTaps?.tick()
					}),
				)
			}
			if (!external) this.consumerLifecycle.completeConstruction({ ok: true })
		} catch (error) {
			if (!external) {
				this.consumerLifecycle.completeConstruction({
					ok: false,
					state: "failed",
					detail: "Scanner construction failed",
				})
				void this.consumerLifecycle
					.beginStop()
					.producerSettled.catch(() => undefined)
			}
			throw error
		}
	}

	get enabled(): boolean {
		return this.settings().enabled
	}

	settings(): ScannerSettings {
		return this.effective.settings
	}

	// === lifecycle ===

	start(): Promise<void> {
		if (this.consumerLifecycle.admissionSealed)
			return Promise.reject(
				new WaveKitError("Scanner admission is sealed", "SCANNER_STOPPED"),
			)
		if (this.startPromise) return this.startPromise
		if (this.started) return Promise.resolve()
		this.startupAttempted = true
		this.started = true
		this.startPromise = this.startUp()
			.then(() => this.startReplayQueue())
			.catch((err: unknown) => {
				// The caller stops a scanner whose start failed, which disposes the arbiter (S1-B final
				// review, Info 3): say plainly that no persisted lease is restored this boot (H4).
				this.log.error(
					{ err, pendingLeases: [...this.persistedLeases.keys()] },
					"Scanner start failed: crash recovery of persisted tuner leases does not run this boot; a tuner may stay on a scan frequency until the next start",
				)
				throw err
			})
		return this.startPromise
	}

	private async startUp(): Promise<void> {
		this.startLiveAudioEvidence()
		// A restarted service must not publish during its new recovery barrier.
		this.store.off("change", this.onStoreChange)
		let loaded: LoadedState
		try {
			loaded = await this.persistence.load()
			this.stateLoaded = true
		} catch (err) {
			// The spectrum service and new jobs still start (S1-A Task 16 carry). The persistence refuses
			// journal and snapshot writes until a load succeeds, which keeps the unread files intact.
			this.log.error(
				{ err, storageDir: this.storageDir },
				"Reading the scanner state failed; starting without discoveries, and without the discovery journal and snapshot this run",
			)
			loaded = emptyLoadedState()
			try {
				loaded = { ...loaded, ...(await this.persistence.loadConfig()) }
			} catch (configErr) {
				this.configLoaded = false
				this.log.error(
					{ err: configErr, storageDir: this.storageDir },
					"Reading the scanner jobs and settings failed; they are not written this run, and sweeps and settings changes are refused",
				)
			}
		}
		this.recordingRecoveryHealthy =
			this.stateLoaded && loaded.recoveryHealth === "healthy"
		const publicSnapshot = {
			discoveries: loaded.discoveries,
			observations: loaded.observations,
			corrections: loaded.corrections,
			...(loaded.aliases ? { aliases: loaded.aliases } : {}),
		}
		try {
			this.store.restore({
				...publicSnapshot,
				...(loaded.recordingOperations
					? { recordingOperations: loaded.recordingOperations }
					: {}),
			})
		} catch (err: unknown) {
			this.recordingRecoveryHealthy = false
			this.log.warn(
				{ err },
				"Scanner recording authority could not be restored",
			)
			// Preserve S1's public fallback; it is never evidence of Task42 authority.
			this.store.restore(publicSnapshot)
		}
		for (const entry of loaded.entries) {
			try {
				this.store.replay(entry)
			} catch (err: unknown) {
				this.recordingRecoveryHealthy = false
				this.log.warn(
					{ err },
					"Scanner recording journal authority is unavailable",
				)
			}
		}
		// Recovery inverses need the sole append writer before any public change listener.
		this.store.off("mutation", this.onStoreMutation)
		this.store.on("mutation", this.onStoreMutation)
		// WG15 DQ 7.3 to 7.6: consolidate legacy duplicates before any ingest (journaled, resumable).
		if (this.stateLoaded) await this.consolidateAtLoad()
		if (loaded.droppedLines > 0)
			this.log.warn(
				{ droppedLines: loaded.droppedLines },
				"Dropped torn journal lines",
			)
		this.overrides = loaded.settings
		this.recomputeSettings()
		// § 7.4: report the restored estimate; re-keying waits for the next decoded upgrade (rasters need the jobs).
		for (const cfg of this.deps.sourceConfigs)
			this.updateFrequencyError(cfg.id, { rekey: false })
		await this.evidence
			.recoverAnalog()
			.then(results => {
				const quarantined = results.filter(
					result => result.status === "quarantined",
				).length
				if (quarantined > 0)
					this.log.warn(
						{ quarantined },
						"Scanner recording recovery quarantined artifacts",
					)
				if (!this.evidence.analogAuthorityReady)
					this.log.warn(
						"Scanner recording inventory or authority is unavailable",
					)
			})
			.catch((err: unknown) => {
				this.recordingRecoveryHealthy = false
				this.log.warn({ err }, "Scanner recording recovery is unavailable")
			})
		// Probes are never persisted: recordings/dv/probe-* folders are crash leftovers (before any probe starts).
		await this.evidence
			.removeOrphanProbeDirs()
			.catch((err: unknown) =>
				this.log.warn({ err }, "Orphaned probe folder cleanup failed"),
			)
		this.store.on("change", this.onStoreChange)
		this.spectrum.on("pipeline", this.onSpectrumPipeline)
		this.spectrum.on("stream", this.onEngineStream)
		this.spectrum.on("released", this.onEngineReleased)
		this.spectrum.on("fatal", this.onEngineFatal)
		await this.spectrum.start()
		await this.captures
			.init()
			.catch((err: unknown) =>
				this.log.warn({ err }, "Reading the burst captures failed"),
			)
		this.arbiter.on("lease-lost", this.onLeaseLost)
		this.arbiter.on("source-down", this.onSourceDown)
		this.arbiter.on("source-up", this.onSourceUp)
		this.arbiter.on("recovered", this.onRecovered)
		this.deps.sources.on("source-removed", this.onSourceRemoved)
		// Boot-time caps are absent until SourceManager.connect(): passive jobs are (re)built when a source becomes usable.
		this.deps.sources.on("connected", this.onSourceConnected)
		this.deps.sources.on("caps-changed", this.onCapsChanged)
		this.probes.on("evidence", this.onProbeEvidence)
		this.probes.on("recordings", this.onProbeRecordings)
		this.probes.on("probe-state", this.onProbeState)
		this.probes.on("replay-end", this.onReplayEnd)
		this.ambient.on("evidence", this.onAmbientEvidence)
		this.startCoverageRefresh()
		// A lease whose job was deleted is persisted unattached: its recovery still runs (H4).
		const leases = [
			...loaded.jobs.flatMap(j => (j.lease ? [j.lease] : [])),
			...loaded.leases,
		]
		for (const lease of leases) this.persistedLeases.set(lease.sourceId, lease)
		this.arbiter.recoverPersistedLeases(leases)
		for (const pj of loaded.jobs) await this.restoreJob(pj)
		this.disk = await this.evidence.diskState().catch((err: unknown) => {
			this.log.warn({ err }, "Free disk check failed")
			return "ok" as const
		})
		// Disabled: jobs are listed (paused core-restart) but nothing resumes, ticks or touches the tuner.
		if (!this.consumerLifecycle.admissionSealed && this.settings().enabled) {
			await this.ensurePassiveJobs()
			if (this.consumerLifecycle.admissionSealed) return
			this.operatorActivityOff = this.deps.operatorActivity?.onChange(() => {
				for (const record of this.jobs.values()) this.emitResumeChange(record)
			})
			this.ambient.start()
			this.deps.cpuMeter?.start()
			this.timer = setInterval(() => this.tick(), this.deps.tickMs ?? 100)
			this.timer.unref()
		}
		this.log.info(
			{
				jobs: this.jobs.size,
				discoveries: loaded.discoveries.length,
				storageDir: this.storageDir,
			},
			"Scanner started",
		)
	}

	/**
	 * WG15 DQ 7.6: resumes an interrupted plan, or plans and applies a new one; the plan file is
	 * removed only after a snapshot written after the last group is durable. Never throws.
	 */
	private async consolidateAtLoad(): Promise<void> {
		try {
			const read = await this.persistence.readConsolidationPlan()
			// An invalid file was moved aside by the reader: no resume and no new plan this load (7.9).
			if (read.kind === "invalid") return
			let groups: ConsolidationPlanFile["groups"]
			let resumed = false
			let truncated = 0
			if (read.kind === "ok") {
				groups = read.plan.groups
				resumed = true
			} else {
				const plan = this.store.consolidationPlan()
				truncated = plan.truncated
				if (plan.groups.length === 0) return
				groups = plan.groups
				await this.persistence.writeConsolidationPlan({
					createdAt: new Date(this.now()).toISOString(),
					groups,
				})
			}
			// DQ 7.8: slices of 16 groups, yielding between them (no ingest runs yet). Band inspection
			// UX req 3.2: per-group merged events, or one resync past 256 groups.
			const applied = await applyConsolidationSlices({
				groups,
				sliceGroups: CONSOLIDATE_SLICE_GROUPS,
				apply: slice => this.store.applyConsolidation({ groups: slice }),
				survivor: id => this.store.get(id),
				emit: e =>
					emitWhenListened(
						this,
						this.consolidationEvents,
						e.event === "discovery"
							? { ...e, data: this.stampDiscoveryEvent(e.data) }
							: e,
					),
				yieldTurn: () => new Promise<void>(resolve => setImmediate(resolve)),
			})
			this.log.info(
				{
					resumed,
					planned: groups.length,
					groups: applied.groups,
					absorbed: applied.absorbed,
					truncated,
				},
				"Consolidated duplicate discoveries",
			)
			await this.persistence.writeSnapshotOf(this.store)
			await this.persistence.removeConsolidationPlan()
		} catch (err: unknown) {
			this.log.warn(
				{ err },
				"Discovery consolidation did not complete; the plan resumes at the next start",
			)
		}
	}

	sealAdmission(
		_reason: "shutdown" | "source-loss" | "provider-change" = "shutdown",
	): void {
		this.consumerLifecycle.sealAdmission()
		for (const [id, pending] of this.analogDeferred)
			if (pending.captureId !== null)
				this.deps.iqCapture?.settle(pending.captureId, `analog-${id}`)
		this.analogDeferred.clear()
		for (const { controller } of this.analogJobs.values()) controller.abort()
		this.started = false
		if (this.timer) clearInterval(this.timer)
		this.timer = null
		this.channelTaps?.sealAdmission()
		this.probes?.sealAdmission()
	}

	beginStop(): Readonly<ScannerStopHandle> {
		this.sharedAnalog?.stop()
		this.replayStopped = true
		this.sealAdmission()
		return this.consumerLifecycle.beginStop()
	}

	finalizeStopNative(): Promise<void> {
		return this.consumerLifecycle.finalizeStopNative(
			this.deps.channelOwnership?.observer,
			this.deps.channelOwnership?.lifetime,
			() => {
				// The owner invokes this once AFTER phase40 and BEFORE its immutable core inspection.
				// Each synchronous sweep is independent; unknown facts keep their exact reference.
				let unknown = false
				for (const owner of this.channelRecordingOwners.values()) {
					try {
						owner.inspect?.()
					} catch {
						unknown = true
					}
				}
				try {
					this.channelTaps?.sweepSettledReferences()
				} catch {
					unknown = true
				}
				return unknown
					? {
							ok: false,
							state: "unknown",
							detail: "Scanner final references remain unknown",
						}
					: { ok: true }
			},
		)
	}

	async stop(): Promise<void> {
		this.stopLiveAudioEvidence()
		const handle = this.beginStop()
		await handle.producerSettled.catch(() => undefined)
		await this.finalizeStopNative()
		await handle.completed
	}

	/** EACH independent actual component settles before an aggregate failure; no native66 wait. */
	private async cleanupServiceComponents(): Promise<CleanupOutcome> {
		this.stopLiveAudioEvidence()
		let failed = false
		const attempt = async (
			cleanup: () => unknown | Promise<unknown>,
		): Promise<void> => {
			try {
				await cleanup()
			} catch {
				failed = true
			}
		}
		await attempt(async () => {
			await this.startPromise
		})
		this.startPromise = null
		// These owned components do not depend on probe publication, lease restoration or native66.
		// Initiate EACH before waiting for any of those independent original owners.
		const independentStops = [
			attempt(() => this.ambient?.stop()),
			attempt(() => this.deps.cpuMeter?.stop()),
			attempt(() => this.recorder?.stop()),
		]
		for (const registration of this.constructorListeners) {
			if (registration.settled) continue
			await attempt(() => {
				registration.remove()
				registration.settled = true
			})
		}
		await attempt(() => this.stopCoverageRefresh())
		await attempt(() =>
			this.deps.sources.off("connected", this.onSourceConnected),
		)
		await attempt(() =>
			this.deps.sources.off("caps-changed", this.onCapsChanged),
		)
		await attempt(() =>
			this.deps.sources.off("source-removed", this.onSourceRemoved),
		)
		if (this.arbiter) {
			await attempt(() => this.arbiter.off("source-down", this.onSourceDown))
			await attempt(() => this.arbiter.off("source-up", this.onSourceUp))
			await attempt(() => this.arbiter.off("recovered", this.onRecovered))
		}
		// Probe teardown may emit cleanup-only recording settlement. Wait that actual component
		// before snapshotting its publication chains; this never depends on native phase66.
		await attempt(() => {
			this.operatorActivityOff?.()
			this.operatorActivityOff = undefined
		})
		await attempt(() => this.drainProbeComponents())
		for (const outcome of await Promise.allSettled([
			...this.background,
			this.passiveChain,
			...[...this.drivers.values()].map(driver => attempt(() => driver.idle())),
			...this.arbitrations.values(),
		]))
			if (outcome.status === "rejected") failed = true
		if (this.spectrum && this.arbiter) {
			await Promise.all(
				this.spectrum.sourceIds().map(sourceId =>
					attempt(async () => {
						const lease = this.arbiter.holder(sourceId)
						if (!lease) return
						const result = await this.arbiter.release(lease, { restore: true })
						if (result.restored.length > 0)
							await this.awaitRestoredCaps(
								sourceId,
								lease.snapshot,
								result.restored,
							)
					}),
				),
			)
		}
		if (this.evidence) await attempt(() => this.evidence.stopAnalog())
		await Promise.all(independentStops)
		await Promise.all(
			[...this.drivers.values()].map(driver => attempt(() => driver.dispose())),
		)
		if (this.spectrum) {
			await attempt(() => this.spectrum.stop())
			await attempt(() =>
				this.spectrum.off("pipeline", this.onSpectrumPipeline),
			)
			await attempt(() => this.spectrum.off("stream", this.onEngineStream))
			await attempt(() => this.spectrum.off("released", this.onEngineReleased))
			await attempt(() => this.spectrum.off("fatal", this.onEngineFatal))
		}
		if (this.arbiter) await attempt(() => this.arbiter.dispose())
		if (this.stateLoaded)
			await attempt(() => this.persistence.writeSnapshotOf(this.store))
		await attempt(() => this.persistence.closeSnapshotWorker())
		if (this.startupAttempted && this.persistence)
			await attempt(() => this.persistJobs())
		return failed
			? {
					ok: false,
					state: this.constructorListeners.some(
						registration => !registration.settled,
					)
						? "unknown"
						: "failed",
					detail: "Scanner component cleanup failed",
				}
			: { ok: true }
	}

	private drainProbeComponents(): Promise<void> {
		this.probeComponentDrain ??= Promise.resolve().then(async () => {
			// WG11 req 6.4: the replay queue stops (its replay cancelled) before the probes drain.
			await this.stopReplayQueue()
			if (this.probes) await this.probes.destroy()
		})
		return this.probeComponentDrain
	}

	// === status and settings ===

	status(): ScannerStatus {
		const captureCounters = this.deps.iqCapture?.counters?.()
		const s = this.settings()
		const probes = this.probes.status()
		const spectrum = this.spectrum.status().sources
		const engines: ScannerEngineStatus[] = this.deps.sourceConfigs.map(cfg =>
			this.engineStatus(
				cfg,
				spectrum.find(x => x.sourceId === cfg.id),
			),
		)
		return {
			...(captureCounters
				? {
						iqCapture: {
							...(captureCounters.trialCaptures
								? { trialCaptures: captureCounters.trialCaptures }
								: {}),
							toolFailures: captureCounters.toolFailures,
							lastToolFailure: captureCounters.lastToolFailure,
						},
					}
				: {}),
			enabled: s.enabled,
			channelizerAvailable: false,
			engines,
			budgets: {
				cpuBudgetCores: s.cpuBudgetCores,
				cpuCoresInUse:
					this.spectrum.sourceIds().length * CPU_COST.engine +
					probes.reduce((sum, p) => sum + p.cores, 0),
				maxProbes: { offset: s.maxProbes.offset, channel: s.maxProbes.channel },
				probesInUse: {
					offset: probes.filter(p => p.transport === "offset").length,
					channel: probes.filter(p => p.transport === "channel").length,
				},
			},
			cpuGuard: {
				percent: this.deps.cpuMeter?.normalisedPercent ?? null,
				limitPercent: s.cpuGuardPercent,
				source: this.deps.cpuMeter?.mode ?? "os",
			},
			disk: this.disk,
			jobs: {
				active: [...this.jobs.values()].filter(j => !isTerminal(j.state))
					.length,
				total: this.jobs.size,
			},
		}
	}

	settingsView(): ScannerSettingsView {
		return {
			effective: this.effective.settings,
			passiveBySource: this.effective.passiveBySource,
			provenance: this.effective.provenance,
			bounds: SCANNER_SETTINGS_BOUNDS,
		}
	}

	async patchSettings(
		patch: RuntimeSettingsOverrides,
	): Promise<ScannerSettingsView> {
		if (!this.configLoaded) throw this.stateUnavailable()
		let next: RuntimeSettingsOverrides
		try {
			next = applySettingsPatch(this.overrides, patch)
		} catch (err) {
			if (err instanceof ZodError)
				throw new ScannerApiError(
					"Invalid scanner settings patch",
					"SCANNER_SETTINGS_INVALID",
					400,
					{ issues: err.issues },
				)
			throw err
		}
		const previous = this.overrides
		this.overrides = next
		this.recomputeSettings()
		try {
			await this.persistence.writeSettings(next)
		} catch (err) {
			// Never keep a change in memory that the next boot would not see.
			this.overrides = previous
			this.recomputeSettings()
			this.log.warn({ err }, "Writing settings.json failed; patch not applied")
			throw new ScannerApiError(
				"Saving the scanner settings failed",
				"SCANNER_SETTINGS_WRITE_FAILED",
				500,
			)
		}
		await this.refreshPassive()
		this.emitStatus(true)
		return this.settingsView()
	}

	bandplans(): BandplanDto[] {
		return this.deps.bandplans
			? [...this.deps.bandplans()]
			: bandplansFor(this.deps.region)
	}

	recordMeasurement(m: Partial<PreviewMeasured>): void {
		this.measured = { ...this.measured, ...m }
	}

	// === jobs ===

	preview(spec: StoredScanJobSpec): PlanPreview {
		return previewPlan(spec, this.previewContext())
	}

	async createJob(spec: ScanJobSpec): Promise<ScanJob> {
		if (!this.settings().enabled)
			throw new ScannerApiError(
				"The scanner is disabled",
				"SCANNER_DISABLED",
				503,
			)
		if (spec.kind === "identify")
			throw new ScannerApiError(
				"Identify jobs are created with POST /api/scanner/identify",
				"SCANNER_IDENTIFY_VIA_JOBS",
				400,
			)
		if (spec.kind === "monitor") {
			throw new ScannerApiError(
				"Listen-scan jobs need the channelizer",
				"SCANNER_MONITOR_UNAVAILABLE",
				400,
			)
		}
		const preview = this.preview(spec)
		this.rejectErrors(preview.issues)
		const n = preview.spec
		if (n.mode === "sweep" && !this.configLoaded) throw this.stateUnavailable()
		if (n.mode === "sweep") {
			const impact = this.arbiter.impact(n.sourceId, n)
			if (this.impactNonEmpty(impact) && !n.takeover) {
				throw new ScannerApiError(
					"This sweep disturbs other consumers; resend with takeover",
					"SCANNER_TAKEOVER_REQUIRED",
					409,
					{ impact },
				)
			}
		}
		const now = this.now()
		const record: JobRecord = {
			id: `j_${ulid(now)}`,
			name: spec.name ?? null,
			passive: false,
			rawSpec: spec,
			spec: n,
			plan: preview.plan,
			issues: preview.issues,
			impact: n.mode === "sweep" ? this.arbiter.impact(n.sourceId, n) : null,
			consentedImpact:
				n.mode === "sweep" && n.takeover
					? this.arbiter.impact(n.sourceId, n)
					: null,
			state: "pending",
			createdAt: now,
			updatedAt: now,
			unrestorable: [],
			counts: { observations: 0, transients: 0 },
			...(preview.lockoutExclusions
				? { lockoutExclusions: preview.lockoutExclusions }
				: {}),
			...(preview.decodedElsewhere
				? { decodedElsewhere: preview.decodedElsewhere }
				: {}),
			...(preview.bandPlanSkips
				? { bandPlanSkips: preview.bandPlanSkips }
				: {}),
		}
		const driver = this.createDriver(record)
		this.jobs.set(record.id, record)
		this.drivers.set(record.id, driver)
		// WG2 req 13.4: hit counts start with the job (a resume keeps them).
		this.hits.delete(record.id)
		try {
			await driver.start()
		} catch (err) {
			this.jobs.delete(record.id)
			this.hits.delete(record.id)
			this.drivers.delete(record.id)
			// The start's own error is what the caller gets.
			await driver
				.dispose()
				.catch((disposeErr: unknown) =>
					this.log.warn(
						{ err: disposeErr, jobId: record.id },
						"Disposing a job that failed to start failed",
					),
				)
			// A start that took the lease by hand-over and then failed frees it: the preempted job gets it back (P16).
			await this.arbitrate(n.sourceId)
			throw err
		}
		this.updateMasks(n.sourceId)
		await this.persistJobs()
		const dto = this.toDto(record)
		this.emit("job", dto)
		return dto
	}

	listJobs(): ScanJob[] {
		return [...this.jobs.values()].map(r => this.toDto(r))
	}

	getJob(id: string): ScanJob | undefined {
		const r = this.jobs.get(id)
		return r ? this.toDto(r) : undefined
	}

	async patchJob(
		id: string,
		patch: ScanJobSpec,
	): Promise<{ job: ScanJob; plan: HopPlan; issues: PlanIssue[] }> {
		const record = this.requireJob(id)
		if (isTerminal(record.state))
			throw new ScannerApiError("Job has ended", "SCANNER_JOB_TERMINAL", 409)
		if (record.spec.kind === "identify")
			throw new ScannerApiError(
				"Identify jobs cannot be edited",
				"SCANNER_IDENTIFY_NOT_EDITABLE",
				409,
			)
		const allowed: (keyof ScanJobSpec)[] = [
			"thresholdDb",
			"sensitivity",
			"exclusions",
			"hold",
			"revisit",
			"record",
			"protocols",
			"capture",
			"signalsOnly",
			"skipDecodedElsewhere",
			"skipBandPlanSkips",
		]
		// S1-B final review, finding 7: the operator's own input, not the normalised spec, so derived
		// fields (integration, dwell, …) follow the patch and keep honest provenance. Only the source
		// and the mode are pinned (`auto` never flips a running job's mode).
		const merged: StoredScanJobSpec = {
			...record.rawSpec,
			sourceId: record.spec.sourceId,
			mode: record.spec.mode,
		}
		for (const key of allowed)
			if (patch[key] !== undefined) Object.assign(merged, { [key]: patch[key] })
		// SF1 req 1: `ranges` is the full state of the effective ranges; only their live fields change,
		// stored as `rangeLive` (never merged into the operator's `ranges`, so band-plan ranges and the
		// plan-id re-check stay as admitted). Without `ranges`, an earlier `rangeLive` is kept (6.3).
		if (patch.ranges !== undefined) {
			const edited = applyRangePatch(record.spec.ranges, patch.ranges)
			this.rejectErrors(edited.issues)
			// The locked identity of each range goes with its entry (R1 finding 1).
			merged.rangeLive = withIdentity(edited.rangeLive, record.spec.ranges)
		}
		let preview = this.preview(merged)
		this.rejectErrors(preview.issues)
		// Reported with this PATCH's answer only, never stored on the job.
		const notices: PlanIssue[] = []
		const stale = staleRangeLive(preview.issues)
		if (stale) {
			// R2 finding 1: the band plan under the job changed since the client read its ranges, so
			// an edit this PATCH sent would land nowhere. Refuse; the client re-reads and retries.
			if (patch.ranges !== undefined)
				this.rejectErrors([
					{
						code: "range-locked",
						severity: "error",
						message:
							"the job's ranges changed since they were read; read the job again and resend",
						details: {
							reason: "range-plan-changed",
							dropped: stale.dropped,
							expected: stale.expected,
							received: stale.received,
						},
					},
				])
			// R2 finding 2: keep what still applies, aligned with the current list, so the warning
			// is reported once rather than on every later PATCH.
			merged.rangeLive = withIdentity(
				applyRangePatch(preview.spec.ranges, preview.spec.ranges).rangeLive,
				preview.spec.ranges,
			)
			preview = this.preview(merged)
			this.rejectErrors(preview.issues)
			notices.push(stale.issue)
		}
		record.rawSpec = merged
		record.issues = preview.issues
		record.updatedAt = this.now()
		setLockouts(record, preview.lockoutExclusions)
		setDecodedElsewhere(record, preview.decodedElsewhere)
		setBandPlanSkips(record, preview.bandPlanSkips)
		this.requireDriver(id).replan(preview.spec, preview.plan)
		const { sourceId } = record.spec
		// The lease holder's tuning drives the engine (finding 2); its scheduler follows on the next own epoch.
		if (this.arbiter.holder(sourceId)?.jobId === id)
			await this.spectrum.refreshTuning(sourceId)
		this.updateMasks(sourceId)
		await this.persistJobs()
		const job = this.toDto(record)
		this.emit("job", job)
		return {
			job,
			plan: preview.plan,
			issues: [...preview.issues, ...notices],
		}
	}

	async pauseJob(id: string): Promise<ScanJob> {
		return this.lifecycle(id, { type: "pause" })
	}

	async resumeJob(id: string, opts: { takeover: boolean }): Promise<ScanJob> {
		const record = this.requireJob(id)
		if (record.spec.mode === "sweep" && !this.configLoaded)
			throw this.stateUnavailable()
		if (record.spec.mode === "sweep" && isPreempted(record))
			return this.resumePreempted(record, opts.takeover)
		return this.lifecycle(id, { type: "resume", takeover: opts.takeover })
	}

	async cancelJob(id: string): Promise<ScanJob> {
		return this.lifecycle(id, { type: "cancel" })
	}

	deleteJob(id: string): void {
		const record = this.requireJob(id)
		if (!isTerminal(record.state))
			throw new ScannerApiError(
				"Only ended jobs can be deleted",
				"SCANNER_JOB_NOT_TERMINAL",
				409,
			)
		this.jobs.delete(id)
		this.hits.delete(id)
		this.resumeViews.delete(id)
		this.drivers.delete(id)
		void this.persistJobs()
	}

	// === identify (spec § 10.8) ===

	async identify(req: ScannerIdentifyRequest): Promise<ScanJob> {
		if (!this.settings().enabled)
			throw new ScannerApiError(
				"The scanner is disabled",
				"SCANNER_DISABLED",
				503,
			)
		const identify = normaliseIdentify(req)
		const rawSpec: ScanJobSpec = {
			...(req.sourceId !== undefined ? { sourceId: req.sourceId } : {}),
			mode: "in-window",
			kind: "identify",
			protocols: [],
			priority: 100,
			record: {
				voice: identify.record,
				analog: identify.record,
				data: identify.record,
			},
			stop: { onFirstDecoded: false },
			resume: { autoAfterIdleMs: null, onBoot: false },
		}
		const preview = this.preview(rawSpec)
		this.rejectErrors(preview.issues)
		const n = preview.spec
		// Identify never acquires a lease (in-window), so the arbiter's refusal details do not apply; the holder does.
		const holder = this.arbiter.holder(n.sourceId)
		if (holder) {
			throw new ScannerApiError(
				`A sweep (scanner job ${holder.jobId}) holds this source's tuner; identify works in a still window`,
				"SCANNER_SOURCE_BUSY",
				409,
				{ reason: "held", holderJobId: holder.jobId },
			)
		}
		const target = identify.target
		if (!("all" in target)) {
			const window = this.identifyWindow(n.sourceId)
			if (
				!window ||
				!inWindow(
					target.frequencyHz,
					target.bandwidthHz ?? 0,
					window,
					USABLE_FRACTION,
				)
			) {
				const half = window ? (window.sampleRateHz * USABLE_FRACTION) / 2 : 0
				throw new ScannerApiError(
					"The target is outside the tuned window; tune first",
					"OUT_OF_WINDOW",
					409,
					window
						? {
								window: {
									startHz: window.centreHz - half,
									endHz: window.centreHz + half,
								},
							}
						: undefined,
				)
			}
		}
		const now = this.now()
		const record: JobRecord = {
			id: `j_${ulid(now)}`,
			name:
				"all" in target
					? "Identify (window)"
					: `Identify ${(target.frequencyHz / 1e6).toFixed(5)} MHz`,
			passive: false,
			rawSpec,
			spec: n,
			plan: preview.plan,
			issues: preview.issues,
			impact: null,
			consentedImpact: null,
			state: "pending",
			createdAt: now,
			updatedAt: now,
			unrestorable: [],
			counts: { observations: 0, transients: 0 },
		}
		const driver = this.createIdentifyDriver(record, identify)
		this.jobs.set(record.id, record)
		this.drivers.set(record.id, driver)
		// WG2 req 13.4: hit counts start with the job (a resume keeps them).
		this.hits.delete(record.id)
		try {
			await driver.start()
		} catch (err) {
			this.jobs.delete(record.id)
			this.hits.delete(record.id)
			this.drivers.delete(record.id)
			await driver.dispose()
			throw err
		}
		this.pruneIdentifyJobs()
		const dto = this.toDto(record)
		this.emit("job", dto)
		return dto
	}

	// === discoveries and evidence ===

	listDiscoveries(filter: DiscoveryFilter): {
		items: Discovery[]
		nextCursor: string | null
	} & DiscoveryStoreMeta {
		return { ...this.store.list(filter), ...this.storeMeta() }
	}

	/** Band inspection UX req 3.3: the store's epoch and its revision now. */
	storeMeta(): DiscoveryStoreMeta {
		return {
			storeEpoch: this.store.storeEpoch,
			storeRevision: this.store.currentRevision(),
		}
	}

	getDiscovery(id: string): Discovery | undefined {
		const d = this.store.get(id)
		return d ? { ...d, ...this.storeMeta() } : undefined
	}

	/**
	 * Band inspection UX req 3.1: the live record of `id`, or of the survivor a merge absorbed
	 * `id` into (recording aliases first, then the bounded absorbed-id index), with
	 * `absorbedInto`/`requestedId`. Undefined for an unknown or evicted id.
	 */
	resolveDiscovery(id: string): Discovery | undefined {
		const live = this.store.get(id)
		if (live) return { ...live, ...this.storeMeta() }
		const survivor = this.store.survivorOf(id)
		if (survivor === undefined) return undefined
		const record = this.store.get(survivor)
		return record
			? {
					...record,
					absorbedInto: survivor,
					requestedId: id,
					...this.storeMeta(),
				}
			: undefined
	}

	/**
	 * Band inspection UX req 1.4: one coverage index over every decoder placement, built per
	 * request. Null when decoder status is unavailable (the field is then omitted).
	 */
	discoveryCoverage(): CoverageIndex | null {
		let statuses: unknown
		try {
			statuses = this.deps.decoders.getAllStatus()
		} catch (err: unknown) {
			this.log.debug(
				{ err },
				"Decoder status unavailable for discovery coverage",
			)
			return null
		}
		return buildCoverageIndex(statuses, {
			onSkippedDecoderId: decoderId => {
				if (this.coverageSkipLogged.has(decoderId)) return
				if (this.coverageSkipLogged.size >= 64) return
				this.coverageSkipLogged.add(decoderId)
				this.log.warn(
					{ decoderIdLength: decoderId.length },
					"Decoder id is not 1-64 characters; left out of discovery coverage",
				)
			},
		})
	}

	discoveryObservations(
		id: string,
		cursor: string | null,
		limit: number,
	): { items: Observation[]; nextCursor: string | null } {
		if (!this.store.get(id))
			throw new ScannerApiError(
				`Discovery ${id} not found`,
				"SCANNER_DISCOVERY_NOT_FOUND",
				404,
			)
		return this.store.observations(id, cursor, limit)
	}

	async patchDiscovery(
		id: string,
		patch: Partial<NonNullable<Discovery["operator"]>>,
	): Promise<Discovery> {
		if (!this.store.get(id))
			throw new ScannerApiError(
				`Discovery ${id} not found`,
				"SCANNER_DISCOVERY_NOT_FOUND",
				404,
			)
		// band inspection UX req 3.3: the answer carries the revision of this edit, taken now
		const d: Discovery = {
			...this.store.setOperator(id, patch),
			...this.storeMeta(),
		}
		if (patch.lockout) {
			for (const trial of this.analogJobs.values())
				if (trial.discoveryId === id) trial.controller.abort()
			await Promise.all(
				this.probes
					.status()
					.filter(p => p.discoveryId === id)
					.map(p => this.probes.release(p.probeId)),
			)
		}
		// WG2 req 12.1, 12.5: Ignore skips sweeps; setting or clearing it replans the sweeps it touches.
		if (patch.lockout !== undefined) await this.replanLockouts(d.sourceIds)
		return d
	}

	private lockoutReplanQueued = false

	/** WG7 req 7: decoded-elsewhere refresh on decoder changes (only with a coverage view). */
	private coverageRefresh: CoverageRefresh | null = null

	private readonly onCoverageEvent = (): void => {
		this.coverageRefresh?.notify()
	}

	private startCoverageRefresh(): void {
		const coverage = this.deps.decoderCoverage
		if (!coverage || this.coverageRefresh) return
		this.coverageRefresh = createCoverageRefresh({
			fingerprint: () => coverageFingerprint(coverage()),
			onRefresh: () => this.scheduleLockoutReplan(),
			onError: err =>
				this.log.warn(
					{ errName: err instanceof Error ? err.name : typeof err },
					"Decoded-elsewhere refresh failed",
				),
		})
		for (const event of COVERAGE_EVENTS)
			this.deps.decoders.on(event, this.onCoverageEvent)
	}

	private stopCoverageRefresh(): void {
		for (const event of COVERAGE_EVENTS)
			this.deps.decoders.off(event, this.onCoverageEvent)
		this.coverageRefresh?.dispose()
		this.coverageRefresh = null
	}

	private scheduleLockoutReplan(): void {
		if (this.lockoutReplanQueued) return
		this.lockoutReplanQueued = true
		queueMicrotask(() => {
			this.lockoutReplanQueued = false
			this.replanLockouts().catch((err: unknown) =>
				this.log.warn({ err }, "Lockout replan after a store change failed"),
			)
		})
	}

	/**
	 * WG2 req 12: replans every live sweep job on one of `sourceIds` (all sources when omitted)
	 * whose lockout exclusions
	 * changed, through the same driver replan a live exclusion PATCH uses. The stored spec is not
	 * touched (12.2), so nothing is persisted.
	 */
	private async replanLockouts(sourceIds?: readonly string[]): Promise<void> {
		const ctx = this.previewContext()
		const touched = new Set<string>()
		const retune = new Set<string>()
		for (const record of [...this.jobs.values()]) {
			if (
				record.passive ||
				record.spec.mode !== "sweep" ||
				record.spec.kind === "identify" ||
				isTerminal(record.state) ||
				(sourceIds !== undefined && !sourceIds.includes(record.spec.sourceId))
			)
				continue
			const driver = this.drivers.get(record.id)
			if (!driver) continue
			let next: ReturnType<typeof planJob>
			try {
				next = planJob(record.spec, ctx)
			} catch (err) {
				this.log.warn(
					{ err, jobId: record.id },
					"Lockout replan failed; the job keeps its plan",
				)
				continue
			}
			const lockoutsSame =
				JSON.stringify(next.lockoutExclusions ?? []) ===
				JSON.stringify(record.lockoutExclusions ?? [])
			if (
				lockoutsSame &&
				JSON.stringify(next.decodedElsewhere ?? []) ===
					JSON.stringify(record.decodedElsewhere ?? []) &&
				JSON.stringify(next.bandPlanSkips ?? []) ===
					JSON.stringify(record.bandPlanSkips ?? [])
			)
				continue
			setLockouts(record, next.lockoutExclusions)
			setDecodedElsewhere(record, next.decodedElsewhere)
			setBandPlanSkips(record, next.bandPlanSkips)
			record.updatedAt = this.now()
			// WG6/WG7: only the decoded-elsewhere or band-plan skip list changed and the plan did not
			// (skip off, or not applied): reported only, the job keeps its hop position.
			if (
				lockoutsSame &&
				JSON.stringify(next.plan) === JSON.stringify(record.plan)
			) {
				this.emitJob(record)
				continue
			}
			driver.replan(record.spec, next.plan)
			const { sourceId } = record.spec
			touched.add(sourceId)
			if (this.arbiter.holder(sourceId)?.jobId === record.id)
				retune.add(sourceId)
			this.emitJob(record)
		}
		// As patchJob: the lease holder's tuning drives the engine.
		for (const sourceId of retune) await this.spectrum.refreshTuning(sourceId)
		for (const sourceId of touched) this.updateMasks(sourceId)
	}

	async deleteDiscovery(id: string): Promise<boolean> {
		requireDiscoveryIdFormat(id)
		const discovery = this.store.get(id)
		if (!discovery) {
			try {
				if (!(await this.evidence.hasAnalogCleanup(id))) return false
			} catch {
				throw this.recordingCleanupPending()
			}
			this.refuseIfHoldsKept(id)
			try {
				await this.evidence.removeDiscovery(id)
				return true
			} catch (err: unknown) {
				// The per-file deletion decision refused (a Keep committed after the pre-check).
				if (err instanceof ScannerApiError) throw err
				throw this.recordingCleanupPending()
			}
		}
		// WG9 req 2.6: refuse before any mutation; no cascade to kept media.
		this.refuseIfHoldsKept(id)
		// Fence producer intake before the deletion mutation can notify reentrant readers.
		for (const owner of this.channelRecordingOwners.values()) {
			if (this.store.discoveryIdOf(owner.observationId) === id) {
				owner.producer?.cancel("discovery-deleted")
				owner.tap.cancel()
			}
		}
		if (!this.store.delete(id)) return false
		this.lastConfirm.delete(id)
		this.emitDiscovery(
			{ change: "deleted", discovery },
			this.store.currentRevision(),
		)
		for (const o of [...this.live.values(), ...this.recent])
			if (o.discoveryId === id) {
				o.discoveryId = null
				o.evidenceDeleted = true
			}
		// WG2 req 12.5: a deleted lockout no longer skips sweeps.
		if (discovery.operator?.lockout === true)
			await this.replanLockouts(discovery.sourceIds)
		try {
			await this.evidence.removeDiscovery(id)
		} catch (err: unknown) {
			if (
				err instanceof Error &&
				"code" in err &&
				err.code === "SCANNER_EVIDENCE_CLEANUP_PENDING"
			)
				throw this.recordingCleanupPending()
			throw err
		}
		return true
	}

	/** WG10 req 1.1: what Main passes to the keep service as `scannerDeleter`. */
	scannerRecordingDeleter(): ScannerRecordingDeleter {
		return this.recordingDeleter
	}

	recordingPath(recordingId: string): string | null {
		if (
			/~analog-[0-9a-f-]{36}\.wav$/i.test(recordingId) &&
			!this.evidence.analogAuthorityReady
		)
			throw this.recordingEvidenceUnavailable()
		return this.evidence.recordingPath(recordingId)
	}

	async evidencePath(
		discoveryId: string,
		kind: "psd" | "iq",
	): Promise<string | null> {
		// Before any path join: an id is never a path fragment (Task 36 review).
		requireDiscoveryIdFormat(discoveryId)
		if (!this.store.get(discoveryId)) return null
		const dir = join(this.storageDir, "evidence", discoveryId)
		if (kind === "psd") {
			const path = join(dir, "psd.json")
			return existsSync(path) ? path : null
		}
		const files = await readdir(dir).catch(() => [] as string[])
		if (!this.store.get(discoveryId)) return null
		const iq = files
			.filter(f => f.startsWith("iq-") && f.endsWith(".cu8"))
			.sort()
		return iq.length > 0 ? join(dir, iq[iq.length - 1]!) : null
	}

	listCaptures(): ScannerCapture[] {
		return this.captures.list()
	}

	capturePath(id: string, kind: "cu8" | "json"): string | null {
		return this.captures.path(id, kind)
	}

	deleteCapture(id: string): Promise<boolean> {
		return this.captures.delete(id)
	}

	/**
	 * WG11 req 5.3: the scanner identity of a live track of `sourceId`, for the spectrum service's
	 * frame tracks. O(1): one `live` map lookup, then `discoveryIdOf` (the merge survivor) and
	 * `identityOf` (scalars, no clone). Never throws; null when the track is unknown, of another source, ended, or has no discovery. `trackId` is the full
	 * tracker id of the chain's current track (after a max-duration rollover, the successor's).
	 * Keyed on it with the same-source check, two sources' equal suffixes never cross-match.
	 */
	trackIdentity(
		sourceId: string,
		trackId: string,
	): SpectrumFrameTrackScanner | null {
		try {
			const live = this.live.get(trackId)
			if (
				!live ||
				live.sourceId !== sourceId ||
				live.endedAt !== undefined ||
				!live.discoveryId
			)
				return null
			const id = this.store.discoveryIdOf(live.observationId)
			if (id === undefined) return null
			const d = this.store.identityOf(id)
			if (!d || !d.protocol || !d.confidence) return null
			return {
				discoveryId: d.id,
				protocol: d.protocol,
				confidence: d.confidence,
			}
		} catch {
			return null
		}
	}

	async listen(discoveryId: string): Promise<ListenResult> {
		const discovery = this.store.get(discoveryId)
		if (!discovery)
			throw new ScannerApiError(
				`Discovery ${discoveryId} not found`,
				"SCANNER_DISCOVERY_NOT_FOUND",
				404,
			)
		if (discovery.operator?.lockout) {
			throw new ScannerApiError(
				"The discovery is locked out",
				"SCANNER_DISCOVERY_LOCKED_OUT",
				409,
			)
		}
		const sourceId = discovery.sourceIds[0]
		const caps = sourceId ? this.deps.sources.getCaps(sourceId) : undefined
		const strategy = this.deps.listen ?? liveAudioListen
		return strategy(discovery, {
			caps,
			usableHalfSpanHz: caps ? (caps.sampleRate * USABLE_FRACTION) / 2 : 0,
			liveDemod: this.deps.liveDemod,
		})
	}

	// === engines (SpectrumService consumers) ===

	private async openEngine(
		sourceId: string,
		jobId: string,
	): Promise<SpectrumEngine> {
		const engine = await this.spectrum.acquire(sourceId, `job:${jobId}`)
		// A display-opened engine emitted no stream event to the scanner (R2): the floor would still
		// hold an earlier instance's stop. Never above the live stream, so this is safe unconditionally.
		this.streamFloor.set(sourceId, engine.accounting().stream)
		await this.spectrum.refreshTuning(sourceId)
		this.updateMasks(sourceId)
		return engine
	}

	/** The engine's re-emitted "stop" (last consumer) or "released" (it stays up) closes the job's observations (R2). */
	private async closeEngine(sourceId: string, jobId: string): Promise<void> {
		await this.spectrum.release(sourceId, `job:${jobId}`)
	}

	/**
	 * R2 / I3: a new stream (restart, reconnect boundary, rate change, reconfigure) or the engine's
	 * stop ends every open track of the old stream. A recreated pipeline never closes them itself.
	 */
	private readonly onEngineStream = (
		sourceId: string,
		stream: number,
		reason: EngineStreamReason,
	): void => {
		this.cancelChannelSource(sourceId)
		if (reason === "stop") this.detachIqEngine(sourceId)
		this.streamFloor.set(sourceId, reason === "stop" ? stream + 1 : stream)
		// A summary of an ended stream never measures for identify.
		this.lastSummaries.delete(sourceId)
		this.closeLiveOn(sourceId, reason === "stop" ? "job-end" : "gap")
	}

	/** R2: a job released an engine that stays up (display or other jobs): observations end with the last job. */
	private readonly onEngineReleased = (sourceId: string): void => {
		const jobs =
			this.spectrum.allocation().consumers[sourceId]?.jobs.length ?? 0
		if (jobs === 0) this.closeLiveOn(sourceId, "job-end")
	}

	private readonly onSpectrumPipeline = (
		sourceId: string,
		ev: PipelineEvent,
		epoch: EngineEpoch,
	): void => this.onPipelineEvent(sourceId, ev, epoch)

	/**
	 * Synthesizes `track-close` from `live.lastTrack` for every live observation of the source.
	 * Idempotent: a closed track's later events are ignored (`closedTracks`).
	 */
	private closeLiveOn(sourceId: string, endReason: ObservationEndReason): void {
		for (const live of [...this.live.values()]) {
			if (live.sourceId !== sourceId || !live.lastTrack) continue
			this.onTrack(
				sourceId,
				{ kind: "track-close", track: live.lastTrack, endReason },
				true,
			)
		}
	}

	private engineTuning(sourceId: string): EngineTuning {
		const holder = this.arbiter.holder(sourceId)
		const spec = holder ? this.jobs.get(holder.jobId)?.spec : undefined
		if (!spec) return DEFAULT_TUNING
		return {
			fftSize: spec.fftSize,
			integrationMs: spec.integrationMs,
			thresholdDb: spec.thresholdDb,
			sensitivity: spec.sensitivity,
		}
	}

	private updateMasks(sourceId: string): void {
		const engine = this.spectrum.engine(sourceId)
		if (!engine) return
		const specs = [...this.jobs.values()]
			.filter(j => j.spec.sourceId === sourceId && !isTerminal(j.state))
			.map(j => j.spec)
		const ranges = specs.flatMap(s => s.ranges.filter(isRangeEnabled))
		const targets = this.cfarTargets(sourceId, ranges)
		engine.setMasks({
			exclusions: intersectRanges(specs.map(s => s.exclusions)),
			cfarRanges: ranges.map(r => {
				const fa = targets.get(`${r.startHz}:${r.endHz}`)
				return {
					startHz: r.startHz,
					endHz: r.endHz,
					...(fa !== undefined ? { faTargetPerMhzMin: fa } : {}),
				}
			}),
			burstRanges: ranges
				.filter(r => (r.protocols ?? []).some(p => BURST_PROTOCOLS.has(p)))
				.map(r => ({ startHz: r.startHz, endHz: r.endHz })),
			rasters: ranges.flatMap(r => r.rasters ?? []),
			obwHz: [...new Set(ranges.flatMap(r => r.obwHz ?? []))],
			// § 6.2: in-window while no sweep lease holds the source (truncated segments → `edge`).
			inWindow: this.arbiter.holder(sourceId) === undefined,
		})
		// WG12 R 2.1: the channel gate follows every mask change (start, stop, range edit, lease).
		this.spectrum.setChannelPlan(sourceId, this.channelPlanOf(sourceId))
		this.updateRing(sourceId)
	}

	/**
	 * WG12 R 2.1: one channel-plan entry per enabled range of the source's running jobs, plus
	 * the band-plan view's ranges while the source's passive job runs (the gate clips entries
	 * to the tuned window). Null when no job runs on the source.
	 */
	channelPlanOf(sourceId: string): ChannelPlan | null {
		const records = [...this.jobs.values()].filter(
			j => j.spec.sourceId === sourceId && !isTerminal(j.state),
		)
		if (records.length === 0) return null
		const ranges = records.flatMap(j => j.spec.ranges.filter(isRangeEnabled))
		if (records.some(j => j.passive))
			for (const b of this.deps.bandplans?.() ?? bandplansFor(this.deps.region))
				ranges.push(...b.ranges.filter(isRangeEnabled))
		const entries = ranges.map((r): ChannelPlanEntry => {
			const raster = r.rasters?.[0]
			const width =
				r.obwHz?.[0] ?? raster?.spacingHz ?? CHANNEL_GATE_DEFAULT_WIDTH_HZ
			return {
				startHz: r.startHz,
				endHz: r.endHz,
				widthHz: Math.min(
					CHANNEL_GATE_MAX_WIDTH_HZ,
					Math.max(CHANNEL_GATE_MIN_WIDTH_HZ, width),
				),
				rasterHz: raster?.spacingHz ?? null,
				firstChannelHz: raster?.firstChannelHz ?? null,
				// A11: the same burst rule as the masks' burstRanges.
				burst: (r.protocols ?? []).some(p => BURST_PROTOCOLS.has(p)),
				rangeKey: `${Math.round(r.startHz)}:${Math.round(r.endHz)}`,
			}
		})
		return { sourceId, entries, defaultWidthHz: CHANNEL_GATE_DEFAULT_WIDTH_HZ }
	}

	/**
	 * SF1 req 2.5: the CFAR false-alarm target per `start:end` of the enabled ranges that set a
	 * sensitivity. Ranges sharing a span take the largest target (the most sensitive); a range
	 * without one counts as the pipeline target. A span whose target equals the pipeline's gets
	 * no entry, so jobs without per-range sensitivity send exactly today's masks.
	 */
	private cfarTargets(
		sourceId: string,
		ranges: readonly ScanRange[],
	): Map<string, number> {
		const settingsFa = this.settings().detection.faTargetPerMhzMin
		const pipelineFa = faTargetForSensitivity(
			this.engineTuning(sourceId).sensitivity ??
				this.settings().detection.sensitivity,
			settingsFa,
		)
		const spans = new Map<string, { fa: number; set: boolean }>()
		for (const r of ranges) {
			const key = `${r.startHz}:${r.endHz}`
			const set = r.sensitivity !== undefined
			const fa = r.sensitivity
				? faTargetForSensitivity(r.sensitivity, settingsFa)
				: pipelineFa
			const prev = spans.get(key)
			spans.set(key, {
				fa: prev ? Math.max(prev.fa, fa) : fa,
				set: set || (prev?.set ?? false),
			})
		}
		const out = new Map<string, number>()
		for (const [key, span] of spans)
			if (span.set && span.fa !== pipelineFa) out.set(key, span.fa)
		return out
	}

	private rastersAt(sourceId: string, hz: number) {
		return [...this.jobs.values()]
			.filter(j => j.spec.sourceId === sourceId && !isTerminal(j.state))
			.flatMap(j => j.spec.ranges)
			.filter(r => isRangeEnabled(r) && hz >= r.startHz && hz <= r.endHz)
			.flatMap(r => r.rasters ?? [])
	}

	// === pipeline events → observations ===

	private onPipelineEvent(
		sourceId: string,
		ev: PipelineEvent,
		epoch: EngineEpoch,
	): void {
		const drivers = this.driversOn(sourceId)
		switch (ev.kind) {
			case "epoch-started":
				this.recorder.epochChanged(sourceId, ev.epoch, ev.startSample)
				this.store.clearPending(sourceId) // DQ 1.5: a retune drops pending evidence
				this.syncIqCapture(sourceId, epoch)
				this.probes
					.onEpoch(sourceId, ev.epoch, epoch.centreHz)
					.catch((err: unknown) =>
						this.log.warn({ err }, "Probe epoch change failed"),
					)
				for (const d of drivers) d.onEpochStarted(epoch)
				return
			case "stale-discard":
				for (const d of drivers) d.onStale(ev.blocks)
				return
			case "track-open":
			case "track-update":
			case "track-close":
				this.onTrack(sourceId, ev)
				return
			case "transient":
				for (const d of drivers)
					if (d.covers(sourceId, ev.centreHz)) d.record.counts.transients += 1
				return
			case "block-summary":
				this.lastSummaries.set(sourceId, ev.summary)
				this.onBlockSummary(sourceId, ev.summary)
				for (const d of drivers)
					d.onBlock(ev.summary.endSample, ev.summary.overload)
				return
			case "untracked-retune":
				// § 4.7: the engine already marked the epoch unverified; sweeps re-send their hop,
				// in-window jobs continue with unverified observations.
				// DT (R 1.2): the holder's next same-centre retune must write, not no-op.
				this.arbiter.distrust(sourceId)
				for (const d of drivers) d.onUntrackedRetune()
				return
			case "stats":
				return
		}
	}

	/**
	 * `synthetic`: a close built by closeLiveOn (no probe decisions). An event of a stream that
	 * already ended (late, thread host) never reopens anything: a track seen first there is closed
	 * right away like the rest of its stream (R2).
	 */
	private onTrack(
		sourceId: string,
		ev: Extract<
			PipelineEvent,
			{ kind: "track-open" | "track-update" | "track-close" }
		>,
		synthetic = false,
	): void {
		const track = ev.track
		if (this.closedTracks.has(track.trackId)) return
		const now = this.now()
		const covering = this.driversOn(sourceId).filter(d =>
			d.covers(sourceId, track.centreHz),
		)
		let live = this.live.get(track.trackId)
		const opened = !live
		if (!live) {
			if (covering.length === 0) return
			// Only gate-accepted emissions become observations and receive trials.
			if (track.gate !== undefined && track.gate !== "passed") {
				this.refuseAnalog(
					{ sourceId, observationId: null, discoveryId: null },
					`gate-${track.gate}`,
				)
				if (ev.kind === "track-close" && track.gate === "below")
					for (const d of covering) d.record.counts.transients += 1
				return
			}
			live = {
				observationId: `o_${ulid(now)}`,
				sourceId,
				trackId: track.trackId,
				epoch: track.epoch,
				jobIds: [],
				discoveryId: null,
				startedAt: now,
				classification: this.classify(track, sourceId),
				probeIds: new Set(),
				lastActivityAt: now,
				lastIngestAt: 0,
				lastTrack: track,
				decoded: false,
				encrypted: false,
			}
			this.live.set(track.trackId, live)
			this.emitActivity(live, track, true)
		}
		if (
			track.gate === "passed" &&
			live.epoch === track.epoch &&
			live.gatePassedAt === undefined
		)
			live.gatePassedAt = now
		for (const d of covering)
			if (!live.jobIds.includes(d.record.id)) live.jobIds.push(d.record.id)
		// After the job ids: the capture-enabled covering job decides (Task 34a).
		if (opened) this.openCapture(live, track)
		live.lastTrack = track
		live.lastActivityAt = now
		if (ev.kind !== "track-open")
			live.classification = this.classify(track, sourceId)
		const late = track.stream < (this.streamFloor.get(sourceId) ?? 0)
		const endReason: ObservationEndReason | undefined =
			ev.kind === "track-close"
				? this.endReason(sourceId, ev.endReason)
				: late
					? "gap"
					: undefined
		const closing = endReason !== undefined
		const throttledIngest =
			closing ||
			(now - live.startedAt >= 1000 && now - live.lastIngestAt >= 1000)
		const everIngested = live.lastIngestAt !== 0
		if (throttledIngest) this.ingest(live, track, endReason)
		// WG12 req 4.3: first gate pass. Inside the first second the throttle has
		// not materialized a discovery, so ingest once, then ask. A later pass
		// does not ask again. WG11 6.3 bounds stay inside requestIqCapture.
		const captureAtGate = gatePassCapture({
			synthetic,
			late,
			closing,
			gate: track.gate,
			hasDiscovery: live.discoveryId !== null,
			ingestedThisSnapshot: throttledIngest,
			everIngested: everIngested || throttledIngest,
			alreadyRequested: this.iqTried.has(live.observationId),
		})
		if (captureAtGate.materialize) this.ingest(live, track)
		if (
			!synthetic &&
			!late &&
			(!closing || endReason === "quiet" || endReason === "max-duration") &&
			(track.gate === undefined || track.gate === "passed")
		)
			this.requestJobAnalog(live, track)
		else if (!synthetic && !late && track.gate !== undefined)
			this.refuseAnalog(live, `gate-${track.gate}`)
		if (captureAtGate.request && !this.analogDeferred.has(live.observationId)) {
			this.requestIqCapture(live, track)
		}
		const needs =
			!synthetic && !late && this.needsConfirm(live, track, !closing)
		for (const d of covering) d.onTrack(live, track, needs)
		if (!closing) {
			this.refineLiveChannel(live, track)
			return
		}
		if (
			(endReason !== "quiet" && endReason !== "max-duration") ||
			!this.finishChannelRecording(live.observationId)
		)
			this.cancelChannelObservation(
				sourceId,
				live.observationId,
				endReason === "gap" ? "stream-changed" : "cancelled",
			)
		if (endReason !== "quiet" && endReason !== "max-duration")
			this.analogJobs.get(live.observationId)?.controller.abort()
		this.rememberClosed(track.trackId)
		const deferredAnalog = this.analogDeferred.get(live.observationId)
		if (deferredAnalog?.captureId != null)
			this.deps.iqCapture?.end(deferredAnalog.captureId)
		this.endIqCapture(live)
		for (const jobId of live.jobIds)
			this.drivers.get(jobId)?.onTrackClosed(track.trackId)
		this.probes.trackClosed(track.trackId)
		const closed = live
		this.recorder.close(live.observationId, track.lastSample, () =>
			this.captureCloseInfo(closed, track),
		)
		this.live.delete(track.trackId)
		live.endedAt = now
		if (endReason !== undefined) live.endReason = endReason
		this.recent.push(live)
		this.emitActivity(live, track, false)
		if (live.probeIds.size === 0 && live.discoveryId)
			this.markRecording(live.observationId, "none")
		this.writePsdEvidence(live).catch((err: unknown) =>
			this.log.warn(
				{ err, observationId: live.observationId },
				"PSD evidence write failed",
			),
		)
	}

	private rememberClosed(trackId: string): void {
		this.closedTracks.add(trackId)
		if (this.closedTracks.size > CLOSED_TRACKS_KEEP) {
			const oldest = this.closedTracks.values().next()
			if (oldest.done !== true) this.closedTracks.delete(oldest.value)
		}
	}

	private endReason(
		sourceId: string,
		reason: ObservationEndReason,
	): ObservationEndReason {
		if (reason !== "retune") return reason
		const holder = this.arbiter.holder(sourceId)
		return holder && this.jobs.get(holder.jobId)?.spec.mode === "sweep"
			? "hop"
			: "retune"
	}

	/**
	 * WG2 req 13.2: the store's discovery changes raised by this ingest are emitted once its hits are
	 * counted, so the event of the attributed discovery carries `jobHits`.
	 */
	private ingest(
		live: LiveObservation,
		track: TrackSnapshot,
		endReason?: ObservationEndReason,
		decode?: DecodeEvidence,
	): void {
		const outer = this.ingestChanges
		const changes: [string, StoreChange, readonly string[] | undefined][] = []
		this.ingestChanges = changes
		let reported = new Map<string, Set<string>>()
		try {
			reported = this.ingestTracked(live, track, endReason, decode)
		} finally {
			this.ingestChanges = outer
			for (const [id, change, mergedIds] of changes) {
				const jobIds = reported.get(id)
				this.emitDiscoveryChange(
					id,
					change,
					jobIds ? this.jobHitsOf([...jobIds], id) : [],
					mergedIds,
				)
			}
		}
	}

	/**
	 * Returns, per discovery, the jobs whose hits its events report: the observation's jobs on the
	 * discovery it is attributed to, plus every job the store newly credited in this ingest.
	 */
	private ingestTracked(
		live: LiveObservation,
		track: TrackSnapshot,
		endReason?: ObservationEndReason,
		decode?: DecodeEvidence,
	): Map<string, Set<string>> {
		const reported = new Map<string, Set<string>>()
		const now = this.now()
		const sweep = live.jobIds.some(
			id => this.jobs.get(id)?.spec.mode === "sweep",
		)
		const res = this.store.ingest(
			{
				id: live.observationId,
				sourceId: live.sourceId,
				jobIds: live.jobIds,
				track,
				classification: live.classification,
				startedAt: live.startedAt,
				...(endReason ? { endedAt: live.endedAt ?? now, endReason } : {}),
				...(live.hopIndex !== undefined ? { hopIndex: live.hopIndex } : {}),
				singleBlockSurfacingAllowed: sweep,
			},
			decode ? { decode } : {},
		)
		live.lastIngestAt = now
		if (res.change === "transient" || res.discoveryId === null) {
			// A re-ingest that raised truncated/iqImage unlinks the observation (StoreMutation.removedObservations):
			// drop the link so evidence, recordings and activity events no longer point at the discovery.
			live.discoveryId = null
			if (endReason)
				for (const id of live.jobIds) {
					const r = this.jobs.get(id)
					if (r) r.counts.transients += 1
				}
			return reported
		}
		if (live.discoveryId === null) {
			for (const id of live.jobIds) {
				const r = this.jobs.get(id)
				if (r) r.counts.observations += 1
			}
		}
		const report = (discoveryId: string, jobIds: readonly string[]): void => {
			let set = reported.get(discoveryId)
			if (!set) {
				set = new Set()
				reported.set(discoveryId, set)
			}
			for (const j of jobIds) set.add(j)
		}
		report(res.discoveryId, live.jobIds)
		// WG2 req 13.1: one hit per (observation, job) the store newly credits, including jobs joining
		// a placed observation and every pending observation a single-block promotion attaches.
		for (const a of res.attributed ?? []) {
			for (const jobId of a.jobIds) {
				if (!this.jobs.has(jobId)) continue
				const hits = this.hitsOf(jobId)
				hits.record(a.observationId, a.discoveryId, now, a.created)
				// WG6 req 2.1: an observation credited after it ended (a single-block promotion
				// attaching closed pending hits, or this ingest's own close) has its duration now.
				const ended = this.store.endedDurationOf(a.observationId)
				if (ended !== undefined)
					hits.ended(a.observationId, a.discoveryId, ended)
			}
			report(a.discoveryId, a.jobIds)
		}
		// WG6 req 2.1: a closing observation sets its duration on every job entry it is the
		// latest credit of (JobHits ignores jobs whose entry moved on or never credited it).
		if (endReason) {
			const durationMs =
				this.store.endedDurationOf(live.observationId) ?? now - live.startedAt
			for (const jobId of live.jobIds)
				this.hits
					.get(jobId)
					?.ended(live.observationId, res.discoveryId, durationMs)
		}
		live.discoveryId = res.discoveryId
		// A discovery proof belongs to its original transmission.
		live.decoded = live.acceptedIdentity !== undefined
		if (live.undecodedReason) {
			this.markUndecoded(live, live.undecodedReason)
			delete live.undecodedReason
		}
		this.dirty = true
		return reported
	}

	private hitsOf(jobId: string): JobHits {
		let h = this.hits.get(jobId)
		if (!h) {
			h = new JobHits(jobId)
			this.hits.set(jobId, h)
		}
		return h
	}

	/** One entry per job of the observation that tracks the discovery (WG2 req 13.2). */
	private jobHitsOf(
		jobIds: readonly string[],
		discoveryId: string,
	): ScanJobHit[] {
		const out: ScanJobHit[] = []
		for (const id of jobIds) {
			const hit = this.hits.get(id)?.entry(discoveryId)
			if (hit) out.push(hit)
		}
		return out
	}

	/** WG2 req 13.3: GET /api/scanner/jobs/:id/hits, most recent first. */
	jobHits(id: string, limit: number): ScanJobHitsResponse {
		this.requireJob(id)
		const h = this.hits.get(id)
		return {
			jobId: id,
			stats: h ? h.stats() : emptyHitStats(),
			hits: h ? h.list(limit) : [],
		}
	}

	private classifierContext(
		sourceId: string,
		centreHz: number,
	): {
		priors: Partial<Record<ScannerProtocol, number>>
		protocols: ScannerProtocol[]
	} {
		const specs = this.driversOn(sourceId)
			.filter(d => d.covers(sourceId, centreHz))
			.map(d => d.record.spec)
		const selections = specs.map(s => protocolsForFrequency(s, centreHz))
		const all = selections.length === 0 || selections.some(p => p.length === 0)
		const protocols = all ? [] : [...new Set(selections.flat())]
		const priors: Partial<Record<ScannerProtocol, number>> = {}
		const bandProtocols = specs
			.flatMap(s => s.ranges)
			.filter(
				r =>
					isRangeEnabled(r) &&
					centreHz >= r.startHz &&
					centreHz <= r.endHz &&
					(r.protocols ?? []).length > 0,
			)
			.flatMap(r => r.protocols ?? [])
		if (bandProtocols.length > 0) {
			for (const p of probeProtocols)
				if (!bandProtocols.includes(p)) priors[p] = 0.5
		}
		if (!all)
			for (const p of probeProtocols) if (!protocols.includes(p)) priors[p] = 0
		// WG11 req 1.4: a sweep silent at this frequency takes the band plan's ISM prior, so a young
		// land-mobile track is not an ISM burst (no probe) at the sweep's dwell decision.
		return {
			priors: withBandBurstPrior(
				{
					hz: centreHz,
					priors,
					protocols,
					rangesListProtocols: bandProtocols.length > 0,
					sweep: specs.some(s => s.mode === "sweep"),
				},
				() =>
					priorsFor(
						this.bandBurstRanges(
							this.deps.bandplans?.() ?? bandplansFor(this.deps.region),
						),
						centreHz,
					),
			),
			protocols,
		}
	}

	private classify(track: TrackSnapshot, sourceId: string): Classification {
		const c = classifySpectral(
			track,
			this.classifierContext(sourceId, track.centreHz),
		)
		// § 4.7: unverified RF: spectral evidence alone never lifts a discovery past `candidate`.
		return track.tuningTrust === "unverified" ? { ...c, tier: "spectral" } : c
	}

	private refineLiveChannel(live: LiveObservation, track: TrackSnapshot): void {
		const ownership = this.deps.channelOwnership,
			profile = this.deps.channelProfile
		if (
			!this.channelTier.enabled ||
			!this.channelTaps ||
			!ownership?.ledger ||
			!profile ||
			this.consumerLifecycle.admissionSealed ||
			live.encrypted ||
			track.tuningTrust === "unverified" ||
			!Number.isFinite(track.obwHz) ||
			track.obwHz > 16_000 ||
			track.flags.truncated ||
			track.flags.edge ||
			track.flags.iqImage ||
			track.flags.spur
		)
			return
		const source = this.deps.sourceConfigs.find(
			config => config.id === live.sourceId,
		)
		if (!source || source.type === "recording") return
		const engine = this.spectrum.engine(live.sourceId)
		if (!engine || engine.format !== "U8_IQ") return
		const epoch = engine.currentEpoch()
		const caps = this.deps.sources.getCaps(live.sourceId)
		if (
			!caps ||
			caps.kind !== "iq" ||
			caps.format !== "U8_IQ" ||
			caps.sampleRate !== epoch.sampleRateHz ||
			caps.centerFreq !== epoch.centreHz
		)
			return
		const offsetCount = this.probes
			.status()
			.filter(probe => probe.transport === "offset").length
		if (
			!this.probes.channelBaselineKnown ||
			profile.baselineEngineCount !== this.spectrum.sourceIds().length ||
			profile.baselineOffsetCount !== offsetCount ||
			![...this.channelEngineStarts].every(
				([id, started]) => this.spectrum.engine(id) === started,
			)
		)
			return
		const admission = ownership.ledger.admissionSnapshot()
		if (
			!updateChannelAdmission(
				ownership.ledger,
				admission.version,
				profile.baseline,
				{
					cpu: Math.min(profile.limits.cpu, this.settings().cpuBudgetCores),
					bytes: profile.limits.bytes,
				},
			)
		)
			return
		const identity = Object.freeze({})
		const admissionRevision = this.channelAdmissionRevision
		const captureCurrent = (): boolean => {
			const now = engine.currentEpoch()
			const currentCaps = this.deps.sources.getCaps(live.sourceId)
			return (
				this.channelAdmissionRevision === admissionRevision &&
				this.probes.channelBaselineKnown &&
				profile.baselineEngineCount === this.spectrum.sourceIds().length &&
				profile.baselineOffsetCount ===
					this.probes.status().filter(probe => probe.transport === "offset")
						.length &&
				currentCaps?.kind === "iq" &&
				currentCaps.format === "U8_IQ" &&
				currentCaps.sampleRate === epoch.sampleRateHz &&
				currentCaps.centerFreq === epoch.centreHz &&
				!this.consumerLifecycle.admissionSealed &&
				this.spectrum.engine(live.sourceId) === engine &&
				now.stream === epoch.stream &&
				now.epoch === epoch.epoch &&
				now.sampleRateHz === epoch.sampleRateHz &&
				now.centreHz === epoch.centreHz &&
				now.gainKey === epoch.gainKey &&
				now.tuningTrust === epoch.tuningTrust &&
				!live.encrypted
			)
		}
		const current = (): boolean =>
			captureCurrent() &&
			this.live.get(live.trackId) === live &&
			!live.evidenceDeleted
		this.channelTaps.begin({
			attempt: Object.freeze({
				observationId: live.observationId,
				trackId: live.trackId,
				identity,
				sourceId: live.sourceId,
				decoderId: `scanner-tap-${ulid(this.now())}`,
				engine,
				engineInstanceId: recordingEngineInstanceId(engine),
				stream: epoch.stream,
				epoch: epoch.epoch,
				captureRateHz: epoch.sampleRateHz,
				captureCentreHz: epoch.centreHz,
				targetHz: track.centreHz,
				tuningTrust: epoch.tuningTrust,
				gainKey: epoch.gainKey,
			}),
			current: captureCurrent,
			minMs: this.channelTier.minMs,
			collected: (result, tap) => {
				try {
					if (!current() || !tap.current) return
					const features = extractChannelFeatures(result.samples, {
						outputRateHz: result.outputRateHz,
						format: result.format,
						snrDb: track.snrDb,
						minMs: this.channelTier.minMs,
						gaps: result.gaps,
					})
					const refined = refineChannelClassification(
						live.classification,
						features,
						{
							...this.classifierContext(live.sourceId, track.centreHz),
							rfTrusted: epoch.tuningTrust !== "unverified",
							obwHz: track.obwHz,
						},
					)
					const discoveryId = this.store.discoveryIdOf(live.observationId)
					if (
						refined.kind !== "refined" ||
						!discoveryId ||
						!current() ||
						!tap.current
					)
						return
					this.store.applyClassification(discoveryId, refined.classification)
					if (
						current() &&
						tap.current &&
						this.store.discoveryIdOf(live.observationId) === discoveryId
					)
						live.classification = refined.classification
				} finally {
					// Classifier F is settled by ChannelTaps after this callback returns.
					void Promise.resolve()
						.then(() => this.startChannelRecording(live, tap, current))
						.catch(() => {
							tap.cancel()
						})
				}
			},
		})
	}

	private async startChannelRecording(
		live: LiveObservation,
		tap: ChannelTapHandle,
		current: () => boolean,
	): Promise<void> {
		const binding = tap.prepared.lifecycle.binding
		const channels = this.deps.channels
		const job = live.jobIds
			.map(id => this.jobs.get(id)?.spec)
			.find(spec => spec?.record.analog)
		const discoveryId = this.store.discoveryIdOf(live.observationId)
		if (
			!this.channelProducerAdopted ||
			!current() ||
			!binding ||
			!channels ||
			!job ||
			!discoveryId ||
			live.classification.class !== "analog-fm" ||
			live.encrypted
		) {
			await tap.finish()
			return
		}
		const attempt = tap.prepared.lifecycle.attempt
		const token = tap.prepared.handle.requestToken
		const identity: RecordingGrantIdentity = Object.freeze({
			provider: channels,
			token,
			binding: Object.freeze({
				sourceId: attempt.sourceId,
				engineInstanceId: attempt.engineInstanceId,
				stream: attempt.stream,
				epoch: attempt.epoch,
				channelId: binding.channelId,
				channelGeneration: binding.generation,
				inputFormat: "cf32" as const,
				inputSampleRateHz: 48000,
				groupDelayInputSamples: binding.realised.groupDelaySamples,
				targetHz: attempt.targetHz,
				captureCentreHz: attempt.captureCentreHz,
				tuningTrust: attempt.tuningTrust,
			}),
		})
		let resolveNative!: (outcome: RecordingNativeOutcome) => void
		const nativeOwnershipSettled = new Promise<RecordingNativeOutcome>(
			resolve => {
				resolveNative = resolve
			},
		)
		const owner = {
			identity,
			tap,
			observationId: live.observationId,
			producer: undefined as RecordingProducerHandle | undefined,
			offProof: undefined as (() => void) | undefined,
			nativeClosed: false,
			componentClosed: false,
			inspect: undefined as (() => void) | undefined,
		}
		// One source slot already owns this exact token, including its pending/closing liabilities.
		if (this.channelRecordingOwners.has(token)) {
			tap.cancel()
			return
		}
		this.channelRecordingOwners.set(token, owner)
		const inspect = (): void => {
			const state = tap.prepared.handle.snapshot()
			if (
				!owner.nativeClosed &&
				state.logical === "terminal" &&
				state.native === "settled"
			) {
				owner.nativeClosed = true
				resolveNative(
					Object.freeze({ status: "released", provider: channels, token }),
				)
			}
			if (
				owner.nativeClosed &&
				owner.componentClosed &&
				state.local === "settled" &&
				Object.values(state.components).every(value => value === "settled")
			) {
				owner.offProof?.()
				owner.offProof = undefined
				if (this.channelRecordingOwners.get(token) === owner)
					this.channelRecordingOwners.delete(token)
			}
		}
		owner.inspect = inspect
		owner.offProof = tap.prepared.handle.onChange(inspect)
		try {
			if (!current() || !tap.current)
				throw new WaveKitError(
					"Scanner recording grant ended",
					"SCANNER_CHANNEL_UNAVAILABLE",
				)
			const producer = this.channelProducers.begin({
				...identity,
				discoveryId,
				observationId: live.observationId,
				recordAudio: true,
				analogFm: true,
				encrypted: false,
				thresholdDbfs: job.thresholdDb,
				nativeOwnershipSettled,
			})
			owner.producer = producer
			const settled = producer.settled.then(result => {
				owner.componentClosed = result.componentClosed
				inspect()
				return result.componentClosed
					? { ok: true as const }
					: {
							ok: false as const,
							state: "failed" as const,
							detail: "Scanner analog producer cleanup failed",
						}
			})
			if (
				!tap.attachAnalog({
					push: samples => {
						void producer.push(samples).catch(() => {
							producer.cancel("channel-invalidated")
							tap.cancel()
						})
					},
					cancel: () => producer.cancel("channel-invalidated"),
					settled,
					filesystemSettled: producer.settled.then(result => result.filesystem),
					operationSettled: producer.settled.then(result => result.operation),
				})
			)
				producer.cancel("channel-invalidated")
			inspect()
		} catch {
			tap.cancel()
			// No manufactured component/native proof: a begun but missing owner remains unknown.
		}
	}

	private finishChannelRecording(observationId: string): boolean {
		for (const owner of this.channelRecordingOwners.values()) {
			if (owner.observationId !== observationId || !owner.producer) continue
			owner.tap.sealIntake()
			void owner.producer.finish("track-ended").catch(() => owner.tap.cancel())
			return true
		}
		return false
	}

	private cancelChannelSource(
		sourceId: string,
		cut: AnalogCut = "source-lost",
	): void {
		this.channelProducers?.cancelSource(sourceId, cut)
		this.channelTaps?.cancelSource(sourceId)
	}

	private cancelChannelObservation(
		sourceId: string,
		observationId: string,
		cut: AnalogCut,
	): void {
		for (const owner of this.channelRecordingOwners.values()) {
			if (
				owner.observationId !== observationId ||
				owner.identity.binding.sourceId !== sourceId
			)
				continue
			owner.producer?.cancel(cut)
			owner.tap.cancel()
		}
		this.channelTaps?.cancelObservation(sourceId, observationId)
	}

	/** Revoke before newly uncovered workload/limits can reach an atomic core dequeue. */
	private invalidateChannelAdmission(): void {
		this.channelAdmissionRevision++
		this.channelTaps?.invalidateCoverage()
		for (const owner of this.channelRecordingOwners.values())
			owner.producer?.cancel("cancelled")
		const ledger = this.deps.channelOwnership?.ledger
		const profile = this.deps.channelProfile
		if (!ledger || !profile || !this.effective) return
		// No unknown coefficient or reduced baseline credit: retain the last conservative baseline.
		const state = ledger.admissionSnapshot()
		updateChannelAdmission(ledger, state.version, state.baseline, {
			cpu: Math.min(profile.limits.cpu, this.settings().cpuBudgetCores),
			bytes: profile.limits.bytes,
		})
	}

	private protocolsFor(
		live: LiveObservation,
		centreHz: number,
	): ScannerProtocol[] {
		const specs = live.jobIds
			.map(id => this.jobs.get(id)?.spec)
			// SF1 req 3.3: a signals-only job never widens the probe protocols of the others.
			.filter(
				(s): s is NormalisedJobSpec =>
					s !== undefined && s.signalsOnly !== true,
			)
		const selections = specs.map(s => protocolsForFrequency(s, centreHz))
		if (selections.length === 0 || selections.some(p => p.length === 0))
			return []
		return [...new Set(selections.flat())]
	}

	private discoveryLockedOut(discoveryId: string | null): boolean {
		return Boolean(
			discoveryId && this.store.get(discoveryId)?.operator?.lockout,
		)
	}

	private needsConfirm(
		live: LiveObservation,
		track: TrackSnapshot,
		open = true,
	): boolean {
		// § 10.8: an active identify job owns the confirmation of the tracks it is identifying.
		const identifying = live.jobIds.some(id => {
			const d = this.drivers.get(id)
			return (
				d instanceof IdentifyRunner && d.owns(live.sourceId, track.centreHz)
			)
		})
		if (identifying) return false
		// WG12 R 4.1: confirm candidates are gated tracks only (absent gate: no plan, today's rule).
		if (track.gate !== undefined && track.gate !== "passed") return false
		if (
			track.flags.truncated ||
			track.flags.edge ||
			track.flags.iqImage ||
			track.flags.spur
		)
			return false
		const d = live.discoveryId ? this.store.get(live.discoveryId) : undefined
		if (this.discoveryLockedOut(live.discoveryId)) return false
		if (
			jobTrialModes(
				live.classification.class,
				this.protocolsFor(live, track.centreHz),
				track.obwHz,
			).length === 0
		)
			return false
		// WG12 req 4.1–4.2: a live hold only for a passed gate, and only in the
		// replay-first cases. The reconfirm interval below is today's path once
		// needsLiveConfirm allows it.
		const onAir = open && live.endedAt === undefined
		if (
			!needsLiveConfirm(
				replayConfirmInput({
					serviceOn: this.iqCaptureOn(),
					refused: this.iqRefused.has(live.observationId),
					pendingCapture:
						this.iqCaptureLifecycle.has(live.observationId) ||
						this.iqCaptureOf.has(live.observationId),
					replaySettled: this.replaySettled.has(live.observationId),
					replayDecoded: this.replaySettled.get(live.observationId) === true,
					acceptedIdentity: live.acceptedIdentity !== undefined,
					gate: track.gate,
					trackOpen: onAir,
					discoveryDecoded: d?.confidence === "decoded",
					emitterOnAir: onAir,
				}),
			)
		)
			return false
		if (!d || d.confidence !== "decoded") return true
		const last = this.lastConfirm.get(d.id) ?? 0
		return (
			this.now() - last >= RECONFIRM_AFTER_MS ||
			d.class !== live.classification.class
		)
	}

	/** `port.state()`, not a detached method: the service reads `this.st`. */
	private iqCaptureOn(): boolean {
		return captureServiceIsOn(this.deps.iqCapture, err => {
			this.log.warn({ err: safeErrorFields(err) }, "IQ capture state failed")
		})
	}

	/** No replay is coming, so live confirm may use today's path. */
	private giveUpIqCapture(observationId: string): void {
		this.iqCaptureLifecycle.delete(observationId)
		if (!this.replaySettled.has(observationId))
			this.iqRefused.add(observationId)
	}

	/**
	 * A capture left the store with no replay result (native abort or error).
	 * Drop that pending entry and give up, so the next confirm sees capture
	 * not running and falls back to today's live path.
	 */
	private releaseRemovedCapture(
		captureId: string,
		observationId: string | null,
	): void {
		const release = captureRemovedRelease({
			removedCaptureId: captureId,
			removedObservationId: observationId,
			pending: [
				...new Map([...this.iqCaptureOf, ...this.iqCaptureLifecycle]),
			].map(([id, hit]) => ({
				observationId: id,
				captureId: hit.captureId,
			})),
			settledObservationIds: this.replaySettled,
		})
		if (release === null) return
		this.iqCaptureOf.delete(release)
		this.iqCaptureLifecycle.delete(release)
		this.giveUpIqCapture(release)
	}

	private noteReplaySettled(observationId: string, decoded: boolean): void {
		this.iqCaptureLifecycle.delete(observationId)
		this.replaySettled.delete(observationId)
		this.replaySettled.set(observationId, decoded)
		while (this.replaySettled.size > REPLAY_SPANS_MAX) {
			const oldest = this.replaySettled.keys().next().value
			if (oldest === undefined) break
			this.replaySettled.delete(oldest)
		}
	}

	/** Best-SNR PSD slice per open observation (§ 8 evidence). */
	private onBlockSummary(sourceId: string, summary: BlockSummary): void {
		for (const live of this.live.values()) {
			const t = live.lastTrack
			if (live.sourceId !== sourceId || !t) continue
			const best = this.bestPsd.get(live.observationId)
			if (best && best.snrDb >= t.snrDb) continue
			const lo = Math.max(
				0,
				Math.floor(
					(t.centreHz - 2 * t.obwHz - summary.startHz) / summary.binHz,
				),
			)
			const hi = Math.min(
				summary.bins.length,
				Math.ceil(
					(t.centreHz + 2 * t.obwHz - summary.startHz) / summary.binHz,
				) + 1,
			)
			if (hi - lo < 2) continue
			this.bestPsd.set(live.observationId, {
				startHz: summary.startHz + lo * summary.binHz,
				binHz: summary.binHz,
				bins: summary.bins.slice(lo, hi),
				snrDb: t.snrDb,
			})
		}
	}

	private async writePsdEvidence(live: LiveObservation): Promise<void> {
		const best = this.bestPsd.get(live.observationId)
		this.bestPsd.delete(live.observationId)
		if (!best || !live.discoveryId) return
		const wants = live.jobIds.some(id => this.jobs.get(id)?.spec.evidence.psd)
		if (!wants) return
		const written = await this.evidence
			.writePsd(live.discoveryId, best)
			.catch((err: unknown) => {
				this.log.warn(
					{ err, discoveryId: live.discoveryId },
					"PSD evidence write failed",
				)
				return false
			})
		if (written) this.store.setEvidenceFlags(live.discoveryId, { psd: true })
	}

	private markRecording(
		observationId: string,
		state: "linked" | "cut" | "encrypted-dropped" | "none",
		recordingIds: string[] = [],
	): void {
		this.store.attachRecordings(observationId, recordingIds, state)
	}

	/** Task 34a: a burst capture for a new observation of a capture-enabled covering job. */
	private openCapture(live: LiveObservation, track: TrackSnapshot): void {
		const job = live.jobIds
			.map(id => this.jobs.get(id))
			.find(j => j?.spec.capture.enabled)
		if (!job) return
		const discovery = live.discoveryId
			? this.store.get(live.discoveryId)
			: undefined
		if (discovery?.operator?.lockout) return
		this.recorder.open({
			observationId: live.observationId,
			jobId: job.id,
			sourceId: live.sourceId,
			stream: track.stream,
			epoch: track.epoch,
			startSample: track.startSample,
			targetHz: track.centreHz,
			spec: job.spec.capture,
		})
	}

	/**
	 * Evaluated when a capture is kept (after a late decode too). The expected payload comes from
	 * this observation's own accepted evidence (CaptureRecorder.evidence); the discovery-wide
	 * metadata LRU is never used, since its values may belong to other transmissions.
	 */
	private captureCloseInfo(
		live: LiveObservation,
		track: TrackSnapshot,
	): CaptureCloseInfo {
		const d = live.discoveryId ? this.store.get(live.discoveryId) : undefined
		const protocol =
			d?.protocol ?? live.classification.hypotheses[0]?.protocol ?? "unknown"
		const mode = probeModesFor(
			d?.class ?? live.classification.class,
			protocol === "unknown" ? [] : [protocol],
		)[0]
		return {
			discoveryId: live.discoveryId,
			protocol,
			...(d?.identity ? { identity: d.identity } : {}),
			metadata: {
				talkgroups: live.talkgroup ? [live.talkgroup] : [],
				sources: live.source ? [live.source] : [],
				capcodes: [],
				callsigns: [],
				ismModels: [],
			},
			encrypted: live.encrypted,
			tuningTrust: track.tuningTrust,
			decoderType: mode?.decoderType ?? null,
			decoderOptions: mode?.options ?? {},
		}
	}

	/** Ring ≥ max(ringSeconds, preMs/1000 + 1) while a capture job is active on the source. */
	private updateRing(sourceId: string): void {
		const engine = this.spectrum.engine(sourceId)
		if (!engine) return
		const capturing = [...this.jobs.values()].filter(
			j =>
				j.spec.sourceId === sourceId &&
				!isTerminal(j.state) &&
				j.spec.capture.enabled,
		)
		const preMs = capturing.reduce(
			(max, j) => Math.max(max, j.spec.capture.preMs),
			0,
		)
		engine.setRingSeconds(capturing.length > 0 ? preMs / 1000 + 1 : 0)
	}

	private emitActivity(
		live: LiveObservation,
		track: TrackSnapshot,
		active: boolean,
	): void {
		const top = live.classification.hypotheses[0]
		const data: ScannerActivityEventData = {
			sourceId: live.sourceId,
			observationId: live.observationId,
			...(live.discoveryId ? { discoveryId: live.discoveryId } : {}),
			jobIds: live.jobIds,
			frequencyHz: track.centreHz,
			active,
			peakDbfs: track.peakDbfs,
			...(top ? { hypothesis: top } : {}),
		}
		this.emit("activity", data)
	}

	// === evidence ===

	private readonly onProbeEvidence = (
		probeId: string,
		req: ProbeRequest,
		ev: DecodeEvidence,
	): void => {
		const outcome = this.probeOutcomes.get(probeId)
		if (outcome) {
			outcome.output = true
			if (!ev.crcClean) outcome.crcFailures += 1
			if (ev.identity || ev.encrypted !== undefined) outcome.confirmed = true
			const trial = outcome.modes.at(-1)
			if (trial && !trial.closed) {
				trial.output = true
				if (!ev.crcClean) trial.crcFailures += 1
				if (ev.identity || ev.encrypted !== undefined) trial.confirmed = true
				if (ev.identity) trial.identity = true
			}
		}
		// WG11 req 6.4: a queue replay's decode lands once, through the queue's sink (applyReplayResult).
		if (req.replay && req.jobId === IQ_REPLAY_QUEUE_HOLDER) return
		const found = this.findObservation(req.observationId)
		if (req.replay) {
			// a replay's evidence carries the capture's time, not the processing time.
			ev = {
				...ev,
				at: this.replayEvidenceAt(
					req.replay.captureId,
					found,
					req.observationId,
				),
				transport: "replay",
			}
			if (!found) {
				// the observation left live/recent: its stored discovery takes it, once.
				const discoveryId = this.store.discoveryIdOf(req.observationId)
				if (discoveryId)
					this.applyStoredReplay(req.observationId, discoveryId, ev)
				return
			}
		}
		const live = found
		if (!live || ev.epoch !== live.epoch) return
		live.probeIds.add(probeId)
		// An identify replay is applied here (identify has no other path to the store) but is no live confirmation.
		const wasReplaying = this.applyingReplay
		if (req.replay) this.applyingReplay = true
		try {
			this.applyEvidence(live, ev)
		} finally {
			this.applyingReplay = wasReplaying
		}
		for (const jobId of live.jobIds)
			this.drivers.get(jobId)?.onEvidence(probeId, ev)
	}

	private readonly onAmbientEvidence = (e: AmbientEvidenceEvent): void => {
		const now = this.now()
		const ambientOnly = SCANNER_AMBIENT_PROTOCOLS.includes(e.ev.protocol)
		const observations = [...this.live.values(), ...this.recent]
		// A channel decode (rtl433) names one observation inside its passband.
		const picked = e.passband
			? pickChannelObservation(
					observations,
					{ sourceId: e.sourceId, passband: e.passband, at: e.ev.at },
					now,
					AMBIENT_PAIR_MS,
				)
			: null
		const candidates = e.passband
			? picked
				? [picked]
				: []
			: observations.filter(o => {
					const t = o.lastTrack
					if (o.sourceId !== e.sourceId || !t) return false
					// WG7: an ambient-only decode (AIS, ACARS, VDL2, LoRa) names only a track within the
					// 1 kHz decode tolerance, so a wide track near its channel is never named by it.
					const tolHz = ambientOnly
						? SCANNER_AMBIENT_TARGET_TOLERANCE_HZ
						: Math.max(1500, t.obwHz / 2)
					if (Math.abs(t.centreHz - e.hz) > tolHz) return false
					return (
						e.ev.at >= o.startedAt - AMBIENT_PAIR_MS &&
						e.ev.at <= (o.endedAt ?? now) + AMBIENT_PAIR_MS
					)
				})
		// WG11 batch review R1 4 (req 1.8): an ambient identity the observation accepted on a decoded
		// discovery resets its miss count, once per discovery for this evidence item (identify's ambient
		// trials leave the count to this path).
		const counted = new Set<string>()
		for (const live of candidates) {
			const before = live.acceptedIdentity
			const accepted = this.applyEvidence(live, e.ev)
			const discoveryId = live.discoveryId
			if (
				accepted &&
				e.ev.identity &&
				discoveryId &&
				live.acceptedIdentity !== before &&
				!counted.has(discoveryId)
			) {
				counted.add(discoveryId)
				this.knownProtocols.recordDecode(discoveryId)
			}
			// WG7 req 1.5: identify jobs pairing this observation may decode an ambient trial.
			for (const jobId of live.jobIds)
				this.drivers.get(jobId)?.onAmbientEvidence?.(live.observationId, e.ev)
		}
	}

	/** Returns whether the observation accepted the evidence (§ 7.1; replay results count only then). */
	private applyEvidence(live: LiveObservation, ev: DecodeEvidence): boolean {
		if (live.evidenceDeleted) return false
		if (ev.metadata.talkgroups?.[0]) live.talkgroup = ev.metadata.talkgroups[0]
		if (ev.metadata.sources?.[0]) live.source = ev.metadata.sources[0]
		if (ev.encrypted) live.encrypted = true
		// An accepted identity decode places a track whose gate has not passed
		// (a short AIS, VDL2 or LoRa burst never passes the burst gate).
		if (!live.discoveryId && live.lastTrack)
			this.ingest(live, live.lastTrack, live.endReason, ev)
		const discoveryId = live.discoveryId
		if (!discoveryId) return false
		// § 7.1: the observation keeps its own accepted evidence (Observation.decode; A1/A3 metrics).
		const accepted = this.store.appendObservationEvidence(
			live.observationId,
			ev,
		)
		if (accepted) {
			this.dirty = true
			this.recorder.evidence(live.observationId, ev)
		}
		// § 6.2: leak/intermod caps are decided before the decode is applied, so a capped decode never reaches `decoded`.
		const cap = ev.identity ? this.capFor(live, ev.identity) : undefined
		const wasDecoded = this.store.get(discoveryId)?.confidence === "decoded"
		const wasLiveDecoded = live.decoded
		this.store.applyEvidence(discoveryId, ev, cap ? { cap } : {})
		// The decode may have merged the discovery (identity key): follow the survivor.
		const survivor = this.store.discoveryIdOf(live.observationId) ?? discoveryId
		live.discoveryId = survivor
		this.dirty = true
		if (!ev.identity || this.store.get(survivor)?.confidence !== "decoded")
			return accepted
		live.decoded = true
		if (!wasLiveDecoded && !this.applyingReplay) this.confirmIqLive(live)
		if (accepted && live.lastTrack)
			live.acceptedIdentity = {
				identity: ev.identity,
				stream: live.lastTrack.stream,
				epoch: ev.epoch,
			}
		this.recorder.decoded(live.observationId)
		this.lastConfirm.set(survivor, this.now())
		if (!wasDecoded) this.updateFrequencyError(live.sourceId, { rekey: true })
		return accepted
	}

	private capFor(
		live: LiveObservation,
		identity: Identity,
	): Classification["cap"] {
		const track = live.lastTrack
		if (!track) return undefined
		const others = [...this.live.values()]
			.filter(
				o =>
					o !== live &&
					o.sourceId === live.sourceId &&
					o.epoch === live.epoch &&
					o.lastTrack,
			)
			.map(o => o.lastTrack!)
		const cfg = this.spectrum.engine(live.sourceId)?.config()
		return leakOrIntermod(track, others, id => this.decodedAt(id, live), {
			identity,
			...(cfg ? { rbwHz: cfg.sampleRateHz / cfg.fftSize } : {}),
		})
	}

	/**
	 * § 7.4: per-source frequency error (median measured offset over ≥ 5 agreeing decoded
	 * discoveries). Reported in engine status; when it moves by more than REKEY_MIN_CHANGE_HZ the
	 * store re-keys the source's discoveries with the new correction (subtracted before snapping).
	 */
	private updateFrequencyError(
		sourceId: string,
		opts: { rekey: boolean },
	): void {
		const est = estimateFrequencyError(
			this.allDiscoveries({ sourceId, minConfidence: "decoded" }),
			sourceId,
		)
		if (!est) {
			this.frequencyErrors.delete(sourceId)
			return
		}
		this.frequencyErrors.set(sourceId, est)
		if (
			!opts.rekey ||
			Math.abs(est.hz - this.store.correction(sourceId)) <= REKEY_MIN_CHANGE_HZ
		)
			return
		const { merged } = this.store.rekey(sourceId, est.hz)
		for (const o of [...this.live.values(), ...this.recent]) {
			if (o.sourceId === sourceId)
				o.discoveryId =
					this.store.discoveryIdOf(o.observationId) ?? o.discoveryId
		}
		this.dirty = true
		this.log.info(
			{
				sourceId,
				correctionHz: est.hz,
				ppm: est.ppm,
				n: est.n,
				merged: merged.length,
			},
			"Frequency error estimate moved; discoveries re-keyed",
		)
	}

	/** H3: the discovery stays at its classification tier with an explicit `undecodedReason`. */
	private markUndecoded(live: LiveObservation, reason: UndecodedReason): void {
		if (live.decoded) return
		if (live.discoveryId === null) {
			live.undecodedReason = reason
			return
		}
		if (this.store.setUndecodedReason(live.discoveryId, reason))
			this.dirty = true
	}

	private decodedAt(
		identity: Identity,
		live: LiveObservation,
	): { centreHz: number; peakDbfs: number }[] {
		const target = live.lastTrack
		const engine = this.spectrum.engine(live.sourceId)
		const epoch = engine?.currentEpoch()
		const cfg = engine?.config()
		if (
			!target ||
			!epoch ||
			!cfg ||
			target.stream !== epoch.stream ||
			target.epoch !== epoch.epoch
		)
			return []
		// Track updates within one integration block can arrive together in a worker batch. No
		// retained best-power/identity, closed track or older sample window proves simultaneous RF.
		const blockSamples = Math.max(
			cfg.fftSize,
			Math.round((cfg.sampleRateHz * cfg.integrationMs) / 1000),
		)
		const half = (cfg.sampleRateHz * USABLE_FRACTION) / 2
		return [...this.live.values()].flatMap(o => {
			const t = o.lastTrack
			const accepted = o.acceptedIdentity
			if (
				o === live ||
				o.evidenceDeleted ||
				o.endedAt !== undefined ||
				o.sourceId !== live.sourceId ||
				o.epoch !== live.epoch ||
				!t ||
				!accepted ||
				accepted.identity.kind !== identity.kind ||
				accepted.identity.value !== identity.value ||
				accepted.stream !== epoch.stream ||
				accepted.epoch !== epoch.epoch ||
				t.stream !== epoch.stream ||
				t.epoch !== epoch.epoch ||
				t.flags.gap ||
				Math.abs(t.lastSample - target.lastSample) > blockSamples ||
				t.lastSample < target.startSample ||
				target.lastSample < t.startSample ||
				Math.abs(t.centreHz - epoch.centreHz) > half ||
				!Number.isFinite(t.peakDbfs)
			)
				return []
			return [{ centreHz: t.centreHz, peakDbfs: t.peakDbfs }]
		})
	}

	private readonly onProbeRecordings = (r: ProbeRecordings): void => {
		const observations = [...this.live.values(), ...this.recent].filter(
			o =>
				o.trackId === r.req.trackId &&
				o.sourceId === r.req.sourceId &&
				!o.evidenceDeleted &&
				o.discoveryId !== null &&
				this.store.get(o.discoveryId) !== undefined,
		)
		const candidates = observations.map(o => ({
			observationId: o.observationId,
			discoveryId: o.discoveryId!,
			...(o.talkgroup ? { talkgroup: o.talkgroup } : {}),
			...(o.source ? { source: o.source } : {}),
			startedAt: o.startedAt,
			endedAt: o.endedAt ?? this.now(),
			encrypted: o.encrypted,
		}))
		const publication = this.evidence
			.linkProbeRecordings(r.probeDir, candidates)
			.then(res => {
				for (const l of res.linked)
					if (this.evidence.recordingPath(l.recordingId))
						this.markRecording(l.observationId, "linked", [l.recordingId])
				for (const id of res.cut) this.markRecording(id, "cut")
				for (const id of res.droppedEncrypted)
					this.markRecording(id, "encrypted-dropped")
			})
			.catch((err: unknown) =>
				this.log.warn(
					{ err, probeId: r.probeId },
					"Linking probe recordings failed",
				),
			)
		this.track(publication, "Probe recording settlement failed")
	}

	private readonly onProbeState = (
		probeId: string,
		state: string,
		req: ProbeRequest,
		terminal?: ProbeUnavailableStop,
	): void => {
		// "starting" occurs synchronously before launch's first allocation/effect.
		if (state === "starting" || state === "stopped")
			this.invalidateChannelAdmission()
		if (req.replay && this.replayOrders.has(req.replay.captureId)) {
			this.emitProgressFor(null)
			return
		}
		// Mode stepping re-emits "starting" on the same probe id. The request hold
		// stays on the first start; each mode takes its own trial.
		if (state === "starting") {
			let book = this.probeOutcomes.get(probeId)
			if (book === undefined) {
				book = {
					startedAt: this.now(),
					holdMs: req.holdMs,
					output: false,
					crcFailures: 0,
					confirmed: false,
					modes: [],
				}
				this.probeOutcomes.set(probeId, book)
			}
			const rows: ProofTrialInput[] = []
			this.finishMode(req, book, "step", rows)
			this.openMode(req, book, rows)
			this.store.recordTrials(req.observationId, rows)
		}
		// `confirming` is emitted after the decoder process exists. `following`
		// is only reached from there. `starting` is before launch.
		if (state === "confirming" || state === "following")
			this.markDecoderStarted(probeId)
		if (state === "stopped") {
			const book = this.probeOutcomes.get(probeId)
			this.probeOutcomes.delete(probeId)
			if (book) {
				const unavailable =
					terminal?.outcome === "unsupported" &&
					terminal.reason === "decoder-unavailable"
				// A missing program is not a decode failure and not a known-protocol miss.
				this.finishMode(req, book, unavailable ? "unavailable" : "stop")
				if (!unavailable) {
					const reason = undecodedForProbe(book, this.now())
					const live = reason
						? this.findObservation(req.observationId)
						: undefined
					if (live && reason) this.markUndecoded(live, reason)
				}
			}
		}
		this.emitProgressFor(null)
	}

	/** The pool emits this before "stopped" when a replay decoder finished cleanly. */
	private readonly onReplayEnd = (probeId: string): void => {
		const trial = this.probeOutcomes.get(probeId)?.modes.at(-1)
		if (trial && !trial.closed) trial.replayEnded = true
	}

	/** The open mode's decoder process exists (`confirming` or `following`). */
	private markDecoderStarted(probeId: string): void {
		const trial = this.probeOutcomes.get(probeId)?.modes.at(-1)
		if (trial !== undefined && !trial.closed) trial.decoderStarted = true
	}

	/** One trial for the mode that is starting. `running` is replaced when it ends. */
	private openMode(
		req: ProbeRequest,
		book: ProbeTrialBook,
		rows: ProofTrialInput[],
	): void {
		const mode = probeModeAt(req, book.modes.length)
		if (mode === undefined) return
		const driver = this.drivers.get(req.jobId)
		if (driver instanceof JobRunner) driver.noteTrialStarted(req, mode)
		const trial: ProbeModeTrial = {
			order: this.store.nextTrialOrder(),
			protocol: mode.protocol,
			decoder: mode.decoderType,
			output: false,
			crcFailures: 0,
			confirmed: false,
			identity: false,
			replayEnded: false,
			decoderStarted: false,
			closed: false,
		}
		book.modes.push(trial)
		this.recordProbeTrial(req.observationId, trial, "running", rows)
	}

	/** Close the mode that is open. A later row for its order replaces `running`. */
	private finishMode(
		req: ProbeRequest,
		book: ProbeTrialBook,
		how: "step" | "stop" | "unavailable",
		rows?: ProofTrialInput[],
	): void {
		const trial = book.modes.at(-1)
		if (trial === undefined || trial.closed) return
		trial.closed = true
		if (how === "unavailable") {
			this.recordProbeTrial(req.observationId, trial, "unsupported")
			const type = probeDecoderType(trial.decoder)
			if (type !== undefined)
				this.store.recordUnavailable(req.observationId, type)
			return
		}
		const outcome =
			req.replay !== undefined
				? replayTrialOutcome(trial)
				: how === "step"
					? completedModeOutcome(trial)
					: liveStopOutcome(book, trial, this.now())
		this.recordProbeTrial(req.observationId, trial, outcome, rows)
	}

	/** One trial row. A later outcome replaces `running` on the same order. */
	private recordProbeTrial(
		observationId: string,
		trial: ProbeModeTrial,
		outcome: ScannerTrialOutcome,
		rows?: ProofTrialInput[],
	): void {
		const row: ProofTrialInput = {
			protocol: trial.protocol,
			decoder: trial.decoder,
			outcome,
			order: trial.order,
			at: this.now(),
		}
		if (rows) rows.push(row)
		else this.store.recordTrial(observationId, row)
	}

	// === WG11 req 6: IQ capture on detection, replay results ===

	/** A18: classification and measured bandwidth never exclude an allowed analog trial. */
	private requestJobAnalog(live: LiveObservation, track: TrackSnapshot): void {
		const runner = this.admittedAnalog()
		const protocols = this.protocolsFor(live, track.centreHz)
		const eligible = live.jobIds.some(id => {
			const job = this.jobs.get(id)
			return (
				job !== undefined &&
				!isTerminal(job.state) &&
				job.spec.signalsOnly !== true
			)
		})
		// A historical discovery can contain several measured channels after overload.
		// Ownership follows this emission's centre, never that merged median.
		const raster = this.rastersAt(live.sourceId, track.centreHz).sort(
			(a, b) => a.spacingHz - b.spacingHz,
		)[0]
		const spacingHz = raster?.spacingHz ?? 6250
		const originHz = raster?.firstChannelHz ?? 0
		const channelHz =
			originHz + Math.round((track.centreHz - originHz) / spacingHz) * spacingHz
		const channelKey = `${spacingHz}:${channelHz}`
		const owned = [...this.analogJobs.values()].some(
			trial =>
				trial.sourceId === live.sourceId &&
				live.discoveryId !== null &&
				trial.discoveryId === live.discoveryId &&
				trial.channelKey === channelKey,
		)
		const reason = !eligible
			? "not-allowed"
			: this.discoveryLockedOut(live.discoveryId)
				? "lockout"
				: live.discoveryId === null
					? "no-discovery"
					: track.flags.spur || track.flags.iqImage
						? "spur-image"
						: !runner?.runLive
							? "runner-unavailable"
							: protocols.length > 0 && !protocols.includes("analog-fm")
								? "not-allowed"
								: this.analogAttempted.has(live)
									? "attempted"
									: owned
										? "discovery-owned"
										: (this.analogCounts.get(live.sourceId) ?? 0) >= 2
											? "capacity"
											: undefined
		if (reason) {
			this.refuseAnalog(live, reason)
			if (reason !== "capacity" && reason !== "discovery-owned") {
				const pending = this.analogDeferred.get(live.observationId)
				this.analogDeferred.delete(live.observationId)
				if (pending?.captureId != null)
					this.deps.iqCapture?.settle(
						pending.captureId,
						`analog-${live.observationId}`,
					)
			}
			if (reason === "capacity" || reason === "discovery-owned")
				this.deferAnalog(live, track)
			return
		}
		if (!runner?.runLive) return
		const deferred = this.analogDeferred.get(live.observationId)
		const deferredCaptureId = deferred?.captureId ?? undefined
		if (
			deferred &&
			(deferredCaptureId === undefined ||
				!this.deps.iqCapture?.view(deferredCaptureId))
		)
			return
		this.analogDeferred.delete(live.observationId)
		this.analogCounts.set(
			live.sourceId,
			(this.analogCounts.get(live.sourceId) ?? 0) + 1,
		)
		this.analogAttempted.add(live)
		const controller = new AbortController()
		this.analogJobs.set(live.observationId, {
			controller,
			channelKey,
			discoveryId: live.discoveryId,
			sourceId: live.sourceId,
		})
		const order = this.store.nextTrialOrder()
		const row = {
			protocol: "analog-fm" as const,
			decoder: "analog-demod",
			order,
			at: this.now(),
		}
		this.store.recordTrial(live.observationId, { ...row, outcome: "running" })
		controller.signal.addEventListener(
			"abort",
			() => {
				this.store.recordTrial(live.observationId, {
					...row,
					at: this.now(),
					outcome: "cancelled",
				})
			},
			{ once: true },
		)
		const run = (
			deferredCaptureId !== undefined
				? runner.run(deferredCaptureId, "nfm", controller.signal)
				: runner.runLive(
						{
							sourceId: live.sourceId,
							observationId: live.observationId,
							epoch: track.epoch,
							rfHz: track.centreHz,
							tuningTrust: track.tuningTrust,
							fromSample: track.startSample,
							reason: "detection",
						},
						"nfm",
						controller.signal,
					)
		)
			.then(raw => {
				if (controller.signal.aborted) return
				const judged = judgeAnalogResult(raw, "nfm")
				this.store.recordTrial(live.observationId, {
					...row,
					at: this.now(),
					outcome: judged.outcome,
				})
				const analog = judged.analog
				if (analog)
					this.store.recordAnalog(live.observationId, {
						outcome: analog.outcome,
						mode: "nfm",
						voice: analog.voice,
						tone: analog.tones,
						transport: "live",
						at: this.now(),
					})
			})
			.catch(() => {
				this.store.recordTrial(live.observationId, {
					...row,
					outcome: "cancelled",
				})
			})
			.finally(() => {
				if (deferredCaptureId !== undefined)
					this.deps.iqCapture?.settle(
						deferredCaptureId,
						`analog-${live.observationId}`,
					)
				this.analogJobs.delete(live.observationId)
				const remaining = (this.analogCounts.get(live.sourceId) ?? 1) - 1
				if (remaining === 0) this.analogCounts.delete(live.sourceId)
				else this.analogCounts.set(live.sourceId, remaining)
				this.retryAnalog()
				if (!this.consumerLifecycle.admissionSealed)
					for (const pending of this.live.values())
						if (
							pending.sourceId === live.sourceId &&
							pending.lastTrack !== null &&
							(pending.lastTrack.gate === undefined ||
								pending.lastTrack.gate === "passed")
						)
							this.requestJobAnalog(pending, pending.lastTrack)
			})
		this.track(run, "Analog trial settlement failed")
	}

	/**
	 * Req 6.3: once per observation, when its track surfaced (it has a discovery), has no confirmed result
	 * for this transmission, is no spur or image and lies in the usable span. The caller asks on the first
	 * gate pass (WG12 req 4.3). The port enforces the per-source rate, the concurrency, the cap and protected mode.
	 */
	private requestIqCapture(live: LiveObservation, track: TrackSnapshot): void {
		const port = this.deps.iqCapture
		if (
			!port ||
			live.discoveryId === null ||
			live.acceptedIdentity !== undefined ||
			track.flags.iqImage ||
			track.flags.spur ||
			this.iqTried.has(live.observationId)
		)
			return
		const epoch = this.spectrum.engine(live.sourceId)?.currentEpoch()
		if (
			!epoch ||
			epoch.epoch !== track.epoch ||
			!inWindow(track.centreHz, track.obwHz, epoch, USABLE_FRACTION)
		)
			return
		this.iqTried.add(live.observationId)
		try {
			const res = port.capture({
				sourceId: live.sourceId,
				observationId: live.observationId,
				epoch: track.epoch,
				rfHz: track.centreHz,
				tuningTrust: track.tuningTrust,
				fromSample: track.startSample,
				reason: "detection",
			})
			if ("captureId" in res) {
				this.iqCaptureLifecycle.set(live.observationId, {
					captureId: res.captureId,
					sourceId: live.sourceId,
				})
				this.iqCaptureOf.set(live.observationId, {
					captureId: res.captureId,
					sourceId: live.sourceId,
				})
			} else this.giveUpIqCapture(live.observationId)
		} catch (err: unknown) {
			this.giveUpIqCapture(live.observationId)
			this.log.warn({ err: safeErrorFields(err) }, "IQ capture request failed")
		}
	}

	/** The captured track closed: the capture finishes now. */
	private endIqCapture(live: LiveObservation): void {
		const hit = this.iqCaptureOf.get(live.observationId)
		this.iqCaptureOf.delete(live.observationId)
		this.iqTried.delete(live.observationId)
		this.iqRefused.delete(live.observationId)
		if (!hit) return
		try {
			this.deps.iqCapture?.end(hit.captureId)
		} catch (err: unknown) {
			this.log.warn({ err: safeErrorFields(err) }, "IQ capture end failed")
		}
	}

	/**
	 * Epoch change: open captures end with the old epoch (the bookkeeping of the source goes with them). The
	 * first epoch of an engine (or a recreated engine) attaches the source to the capture service; later ones
	 * flush it with the new epoch, centre and rate. Only IQ engines are attached.
	 */
	private syncIqCapture(sourceId: string, epoch: EngineEpoch): void {
		const port = this.deps.iqCapture
		if (!port) return
		for (const [observationId, hit] of this.iqCaptureOf)
			if (hit.sourceId === sourceId) {
				this.iqCaptureOf.delete(observationId)
				this.giveUpIqCapture(observationId)
			}
		try {
			const engine = this.spectrum.engine(sourceId)
			const next = {
				epoch: epoch.epoch,
				centerHz: epoch.centreHz,
				sampleRateHz: epoch.sampleRateHz,
			}
			if (!engine || engine.format !== "U8_IQ") {
				if (this.iqEngines.delete(sourceId)) port.detachSource(sourceId)
			} else if (this.iqEngines.get(sourceId) !== engine) {
				this.iqEngines.set(sourceId, engine)
				port.attachSource(sourceId, { ...next, engine })
			} else port.flush(sourceId, next)
		} catch (err: unknown) {
			this.log.warn(
				{ err: safeErrorFields(err) },
				"IQ capture epoch sync failed",
			)
		}
	}

	/**
	 * WG11 batch review R1 3: the source leaves the capture service (its capture child, slot and ring go)
	 * when its engine stops or the source is removed. With `engine`, only while that engine is the attached
	 * one (a replacement already attached stays).
	 */
	private detachIqEngine(sourceId: string, engine?: SpectrumEngine): void {
		const port = this.deps.iqCapture
		if (!port) return
		const attached = this.iqEngines.get(sourceId)
		if (!attached || (engine !== undefined && attached !== engine)) return
		this.iqEngines.delete(sourceId)
		for (const [observationId, hit] of this.iqCaptureOf)
			if (hit.sourceId === sourceId) {
				this.iqCaptureOf.delete(observationId)
				this.giveUpIqCapture(observationId)
			}
		try {
			port.detachSource(sourceId)
		} catch (err: unknown) {
			this.log.warn({ err: safeErrorFields(err) }, "IQ capture detach failed")
		}
	}

	/** A live decode on the observation: its captures whose replay has not started are discarded. */
	private confirmIqLive(live: LiveObservation): void {
		try {
			this.deps.iqCapture?.confirmLive(live.sourceId, live.observationId)
		} catch (err: unknown) {
			this.log.warn(
				{ err: safeErrorFields(err) },
				"IQ capture live confirmation failed",
			)
		}
	}

	/**
	 * The replay queue's sink (requirement 6.4): decode evidence on the capture's observation in the capture's
	 * epoch (through the normal evidence path, so H2 and the P17 rules apply), otherwise the undecoded reason.
	 * The known-protocol memory counts the decode or the known protocol's full-hold miss (requirements 1.7, 1.8).
	 */
	/** WG11 req 6.4: the replay queue and its pool adapter, owned here (created at start, stopped first). */
	private replayQueue: IqReplayQueue | null = null
	private replayAdapter: ReplayPoolAdapter | null = null
	private sharedAnalog: AnalogAdmission | null = null

	private admittedAnalog(): AnalogAdmission | undefined {
		if (!this.deps.analogTrial) return undefined
		this.sharedAnalog ??= new AnalogAdmission(this.deps.analogTrial, cores =>
			this.probes.reserveExternal(cores),
		)
		return this.sharedAnalog
	}

	private readonly replayTrialHooks: {
		analog?: AnalogTrialRunner
		reserveCores?: (cores: number) => (() => void) | null
	} = {}
	/** WG12 req 6.3: closed live-audio transmissions recorded onto nearby discoveries. */
	private liveAudio: LiveAudioEvidence | null = null

	/** set by stop; a start still pending then never creates the queue. */
	private replayStopped = false

	private startReplayQueue(): void {
		const port = this.deps.iqCapture
		if (
			!port ||
			this.replayQueue ||
			this.replayStopped ||
			this.consumerLifecycle.admissionSealed
		)
			return
		const probes = this.replayProbes()
		if (this.deps.analogTrial)
			this.replayTrialHooks.analog = this.deps.analogTrial
		this.replayTrialHooks.reserveCores = cores =>
			this.admittedAnalog()?.reserve(cores) ?? null
		const { analog, reserveCores } = this.replayTrialHooks
		const queue = createIqReplayQueue({
			port,
			probes,
			planner: input => this.planReplay(input),
			progress: (capture, trials, done, running) =>
				this.recordReplayProgress(capture, trials, done, running),
			sink: result => this.applyReplayResult(result),
			planInput: capture => this.replayPlanInput(capture),
			skip: capture => this.replaySkip(capture),
			logger: this.deps.logger,
			// Analog trials share the probe pool core budget.
			...(analog ? { analog } : {}),
			reserveCores,
		})
		this.replayAdapter = probes
		this.replayQueue = queue
		const offFinished = port.onFinished(view => this.pinSpan(view))
		const offRemoved = port.onRemoved((captureId, observationId) => {
			this.releaseRemovedCapture(captureId, observationId)
			this.unpinSpan(captureId, observationId)
		})
		this.offSpanPins = () => {
			offFinished()
			offRemoved()
		}
		this.setReplayRecheck(() => queue.recheck())
		queue.start()
	}

	private async stopReplayQueue(): Promise<void> {
		this.replayStopped = true
		this.offSpanPins?.()
		this.offSpanPins = null
		this.replayTracks.clear()
		const queue = this.replayQueue
		const probes = this.replayAdapter
		this.replayQueue = null
		this.replayAdapter = null
		this.setReplayRecheck(null)
		try {
			await queue?.stop()
		} finally {
			probes?.dispose()
			this.replayPlans.clear()
			this.replayOrders.clear()
		}
	}

	/** The replay queue's view of the probe pool (WG11 req 6.4): replay probes under the queue's own job. */
	replayProbes(): ReplayPoolAdapter {
		return createPoolReplayProbes(this.probes, {
			priority: REPLAY_PROBE_PRIORITY,
			jobId: IQ_REPLAY_QUEUE_HOLDER,
		})
	}

	/**
	 * The replay queue's planner (WG11 req 6.4): lane ID's `planReplayTrials`, reached through the scanner so
	 * the index bundle gains no identify/probe runtime module.
	 */
	private readonly replayOrders = new Map<string, number[]>()

	private recordReplayProgress(
		capture: IqCaptureView,
		trials: readonly IqReplayTrial[],
		done: IqReplayResult["trials"],
		running: number | null,
	): void {
		if (!capture.observationId) return
		const orders = this.replayOrders.get(capture.captureId)
		if (!orders) return
		this.store.recordTrials(
			capture.observationId,
			trials.map((trial, index) => ({
				protocol: trial.protocol,
				decoder:
					trial.kind === "analog" ? "analog-demod" : trial.mode.decoderType,
				order: orders[index]!,
				at: this.now(),
				outcome:
					done[index]?.outcome ??
					(running === index
						? "running"
						: running === null
							? "cancelled"
							: "pending"),
			})),
		)
	}

	planReplay(input: IqReplayPlanInput): readonly IqReplayTrial[] {
		const trials = planReplayTrials(input)
		const id = input.capture.captureId
		this.replayPlans.delete(id)
		this.replayPlans.set(id, trials)
		const orders = trials.map(() => this.store.nextTrialOrder())
		this.replayOrders.set(id, orders)
		if (input.capture.observationId)
			this.store.recordTrials(
				input.capture.observationId,
				trials.map((trial, index) => ({
					protocol: trial.protocol,
					decoder:
						trial.kind === "analog" ? "analog-demod" : trial.mode.decoderType,
					order: orders[index]!,
					at: this.now(),
					outcome: "pending",
				})),
			)
		while (this.replayPlans.size > REPLAY_PLANS_MAX) {
			const oldest = this.replayPlans.keys().next().value
			if (oldest === undefined) break
			this.replayPlans.delete(oldest)
			this.replayOrders.delete(oldest)
		}
		return trials
	}

	/**
	 * spans of observations that left `recent`, so a replay result arriving later is
	 * still stamped inside its observation. Bounded (oldest evicted); a replay comes within the 10 min
	 * orphan TTL of its capture, far fewer than REPLAY_SPANS_MAX observations close in that time.
	 */
	private readonly replaySpans = new Map<
		string,
		{ startedAt: number; endedAt?: number }
	>()

	private rememberReplaySpan(o: LiveObservation): void {
		this.replaySpans.delete(o.observationId)
		this.replaySpans.set(o.observationId, {
			startedAt: o.startedAt,
			...(o.endedAt !== undefined ? { endedAt: o.endedAt } : {}),
		})
		// the oldest span no stored capture needs goes; pinned ones stay.
		while (this.replaySpans.size > REPLAY_SPANS_MAX) {
			let evicted = false
			for (const id of this.replaySpans.keys())
				if (!this.spanPinned(id)) {
					this.replaySpans.delete(id)
					evicted = true
					break
				}
			if (!evicted) break
		}
	}

	/**
	 * observations whose finished captures are still stored (pinned by the capture
	 * service's finished events, released by its removal events, r7 B4; `spanPinned` also drops a
	 * pin whose capture `holderOf` no longer knows). Bound:
	 * one pin per stored capture; a finished capture holds ≥ 4 800 samples × 8 B = 38 400 B, so at
	 * most 256 MiB / 38 400 B = 6 990 pins at the largest cap (174 full 4 s captures); the detection
	 * rate (6 per minute per source over the 10 min orphan TTL: 60 per source) keeps it far lower.
	 */
	private readonly spanPins = new Map<string, Set<string>>()
	/**
	 * WG11 batch review R1 1: the track of each stored finished capture, taken when it finished and
	 * released with its removal (same bound as the pins), so a capture queued past its observation's
	 * `recent` life is still planned from its track (bandplan priors, alternative trials).
	 */
	private readonly replayTracks = new Map<string, TrackSnapshot>()
	private offSpanPins: (() => void) | null = null

	/**
	 * r7 B4: a removed capture releases its pin at once, so pins ≤ stored captures at all times
	 * (a pin is only taken for a capture still stored; every removal is announced).
	 */
	private unpinSpan(captureId: string, observationId: string | null): void {
		this.forgetWritingCapture(captureId)
		this.replayTracks.delete(captureId)
		if (!observationId) return
		const set = this.spanPins.get(observationId)
		if (!set) return
		set.delete(captureId)
		if (set.size === 0) this.spanPins.delete(observationId)
	}

	private pinSpan(view: IqCaptureView): void {
		if (view.observationId) {
			const hit = this.iqCaptureOf.get(view.observationId)
			if (hit?.captureId === view.captureId)
				this.iqCaptureLifecycle.set(view.observationId, hit)
		}
		this.forgetWritingCapture(view.captureId)
		if (!view.observationId) return
		let stored = false
		try {
			stored = this.deps.iqCapture?.holderOf(view.captureId) !== undefined
		} catch {
			stored = false
		}
		if (!stored) return
		const set = this.spanPins.get(view.observationId) ?? new Set<string>()
		set.add(view.captureId)
		this.spanPins.set(view.observationId, set)
		// WG11 batch review R1 1: the captured track stays with the stored capture for its planning.
		const track = this.findObservation(view.observationId)?.lastTrack
		if (track) this.replayTracks.set(view.captureId, track)
	}

	private spanPinned(observationId: string): boolean {
		const set = this.spanPins.get(observationId)
		if (!set) return false
		for (const captureId of [...set]) {
			let stored = false
			try {
				stored = this.deps.iqCapture?.holderOf(captureId) !== undefined
			} catch {
				stored = false
			}
			if (!stored) set.delete(captureId)
		}
		if (set.size === 0) this.spanPins.delete(observationId)
		return set.size > 0
	}

	/** the replay queue's re-check of the captures it parked for identify. */
	private replayRecheck: (() => void) | null = null

	setReplayRecheck(fn: (() => void) | null): void {
		this.replayRecheck = fn
	}

	private recheckReplays(): void {
		try {
			this.replayRecheck?.()
		} catch (err: unknown) {
			this.log.warn({ err: safeErrorFields(err) }, "Replay recheck failed")
		}
	}

	/**
	 * Review M2: the replay queue leaves a capture alone while an identify job works on its
	 * observation (that job claims it); a throw is answered true by the queue (fail closed).
	 */
	replaySkip(capture: IqCaptureView): boolean {
		for (const d of this.drivers.values())
			if (d instanceof IdentifyRunner && d.worksOn(capture)) return true
		return false
	}

	/**
	 * Review m3: a known protocol's replay trial without a decode is a miss only when the capture
	 * holds the decoder's whole hold without a gap: gapSamples 0 and durationMs ≥ the trial mode's
	 * holdMs (e.g. DMR on dsd-fme auto: 1 800 ms of the at most 4 000 ms capture). A shorter or
	 * gapped capture, or a capture whose plan or view is gone, is no miss.
	 */
	private replayFullHold(
		captureId: string,
		trial: IqReplayResult["trials"][number],
	): boolean {
		const view = this.deps.iqCapture?.view(captureId)
		const planned = this.replayPlans
			.get(captureId)
			?.find(
				p =>
					p.known &&
					p.protocol === trial.protocol &&
					p.mode.decoderType === trial.decoderType,
			)
		return replayMissEligible(view, planned?.mode.holdMs)
	}

	/** The planner input of a finished capture: the captured track when the scanner still holds it. */
	replayPlanInput(capture: IqCaptureView): IqReplayPlanInput {
		const live = capture.observationId
			? this.findObservation(capture.observationId)
			: undefined
		const ranges = (
			this.deps.bandplans?.() ?? bandplansFor(this.deps.region)
		).flatMap(b => b.ranges)
		// Minor: the stored discovery once the observation left live/recent.
		const discoveryId =
			live?.discoveryId ??
			(capture.observationId
				? (this.store.discoveryIdOf(capture.observationId) ?? null)
				: null)
		return {
			capture,
			track:
				live?.lastTrack ?? this.replayTracks.get(capture.captureId) ?? null,
			knownProtocol: discoveryId
				? this.knownProtocols.known(discoveryId)
				: null,
			priors: narrowestPriors(withScannerOverlays(ranges), capture.rfHz),
			narrowRaster: narrowRasterAt(ranges, capture.rfHz),
		}
	}

	applyReplayResult(result: IqReplayResult): void {
		const summary = replayOutcomeSummary(result)
		const live = result.observationId
			? this.findObservation(result.observationId)
			: undefined
		if (result.observationId) {
			this.noteReplaySettled(result.observationId, summary.replayDecoded)
			try {
				replayEvidenceCalls(
					result,
					result.observationId,
					this.replayOrders.has(result.captureId)
						? {
								nextTrialOrder: () => this.store.nextTrialOrder(),
								recordTrial: () => false,
								recordAnalog: (id, row) => this.store.recordAnalog(id, row),
								recordUnavailable: (id, type) =>
									this.store.recordUnavailable(id, type),
							}
						: this.store,
					this.replayEvidenceAt(result.captureId, live, result.observationId),
				)
			} catch (err: unknown) {
				this.log.warn({ err: safeErrorFields(err) }, "Replay evidence failed")
			}
		}
		const discoveryId =
			live?.discoveryId ??
			(result.observationId
				? this.store.discoveryIdOf(result.observationId)
				: undefined) ??
			null
		if (result.decoded) {
			const ev: DecodeEvidence = {
				protocol: result.decoded.protocol,
				identity: result.decoded.identity,
				metadata: {},
				crcClean: true,
				at: this.now(),
				epoch: result.epoch,
				origin: "probe",
				transport: "replay",
			}
			let applied = false
			ev.at = this.replayEvidenceAt(
				result.captureId,
				live,
				result.observationId,
			)
			if (live) {
				if (live.epoch === result.epoch) {
					this.applyingReplay = true
					try {
						// Only evidence the observation accepted counts.
						applied = this.applyEvidence(live, ev)
					} finally {
						this.applyingReplay = false
					}
				}
			} else if (result.observationId && discoveryId)
				// the observation closed and left `recent` (10 s) before its replay
				// ended; the discovery it fed is still stored: the decode lands there.
				applied = this.applyStoredReplay(result.observationId, discoveryId, ev)
			// The memory counts a decode only where it was applied.
			const counted = live?.discoveryId ?? discoveryId
			if (applied && counted) this.knownProtocols.recordDecode(counted)
			this.replayPlans.delete(result.captureId)
			this.replayOrders.delete(result.captureId)
			return
		}
		const ran = summary.unsuccessful
		if (discoveryId)
			for (const t of ran)
				if (t.known && this.replayFullHold(result.captureId, t))
					this.knownProtocols.recordMiss(discoveryId, t.protocol)
		this.replayPlans.delete(result.captureId)
		this.replayOrders.delete(result.captureId)
		if (
			live &&
			live.epoch === result.epoch &&
			ran.length > 0 &&
			!summary.replayDecoded
		) {
			const reason = ran.some(t => t.outcome === "crc-errors")
				? "crc-errors"
				: ran.some(t => t.outcome === "timeout")
					? "timeout"
					: "no-sync"
			this.markUndecoded(live, reason)
		}
	}

	/**
	 * A replay decode of an observation the scanner no longer holds (closed and out of `recent`): the
	 * observation's evidence and the stored discovery take it, in the capture's epoch (carried by the
	 * evidence). False when the discovery is gone (nothing applied).
	 */
	private applyStoredReplay(
		observationId: string,
		discoveryId: string,
		ev: DecodeEvidence,
	): boolean {
		if (!this.store.get(discoveryId)) return false
		// The observation's own rules decide (epoch, not after a retune/hop end): refused, nothing lands.
		if (!this.store.appendObservationEvidence(observationId, ev)) return false
		this.store.applyEvidence(discoveryId, ev, {})
		this.dirty = true
		return true
	}

	/**
	 * a replay decode's timestamp is the capture's: its finish (`capturedAtMs` is the
	 * finish time, so the decoded signal lies at or before it), clamped inside the observation's span
	 * [startedAt, endedAt) when the scanner still holds it. The processing time when the view is gone.
	 */
	private replayEvidenceAt(
		captureId: string,
		live: LiveObservation | undefined,
		observationId: string | null,
	): number {
		let at = this.now()
		try {
			const view = this.deps.iqCapture?.view(captureId)
			if (view && Number.isFinite(view.capturedAtMs)) at = view.capturedAtMs
		} catch {
			// keep the processing time
		}
		const span =
			live ?? (observationId ? this.replaySpans.get(observationId) : undefined)
		if (span) {
			at = Math.max(at, span.startedAt)
			// The store refuses at >= endedAt (retune/hop end, strict): the last ms inside is endedAt - 1.
			if (span.endedAt !== undefined) at = Math.min(at, span.endedAt - 1)
		}
		return at
	}

	private findObservation(observationId: string): LiveObservation | undefined {
		for (const o of this.live.values())
			if (o.observationId === observationId) return o
		return this.recent.find(o => o.observationId === observationId)
	}

	/**
	 * The ambient target of a config-owned decoder (WG7 resolveAmbientTargets; the existing types
	 * unchanged). The manager's current config wins, so decoders created after start resolve; the
	 * startup configs remain the fallback for managers without that view.
	 */
	private ambientTarget(decoderId: string): AmbientTarget | null {
		const cfg =
			this.liveDecoderConfig(decoderId) ??
			this.deps.decoderConfigs.find(c => c.id === decoderId)
		if (!cfg) return null
		return resolveAmbientTargets(cfg, {
			defaultSourceId: () => this.deps.routing.getDefaultSourceId(),
			caps: sourceId => this.deps.sources.getCaps(sourceId),
			inputKind: id => this.deps.decoders.getDecoder(id)?.caps.input,
		})
	}

	private liveDecoderConfig(decoderId: string): DecoderConfig | undefined {
		const decoders = this.deps.decoders as Partial<
			Pick<DecoderManager, "getConfiguredDecoderConfigs">
		>
		if (typeof decoders.getConfiguredDecoderConfigs !== "function")
			return undefined
		return decoders.getConfiguredDecoderConfigs().find(c => c.id === decoderId)
	}

	// === arbiter and source events ===

	private readonly onLeaseLost = (
		lease: Lease,
		reason: LeaseLostReason,
	): void => {
		// S1-B final review, finding 3: the operator or a relay owns the tuner now; jobs waiting for the
		// preemptor's lease free the configured decoders until the lease comes back.
		if (reason !== "preempted-job") {
			for (const d of this.driversOn(lease.sourceId)) {
				if (
					d.record.id === lease.jobId ||
					d.record.state !== "paused" ||
					d.record.reason !== "preempted-job"
				)
					continue
				d.dispatch({ type: "preemptor-lost" }).catch((err: unknown) =>
					this.log.debug(
						{ err, jobId: d.record.id },
						"preemptor-lost could not be applied",
					),
				)
			}
		}
		// SF1 req 4.3: the arbiter recorded the new holder before this event; jobs that stay preempted
		// show their new preemptor now rather than on the next tick.
		for (const d of this.driversOn(lease.sourceId))
			if (
				d.record.id !== lease.jobId &&
				d.record.state === "paused" &&
				d.record.reason === "preempted-job"
			)
				this.emitResumeChange(d.record)
		const driver = this.drivers.get(lease.jobId)
		if (!driver) return
		// An operator or relay write is not handed to a waiting job at once (operator-idle tick).
		if (reason !== "preempted-job") this.operatorLost.add(lease.jobId)
		// The event is chosen inside the job's dispatch chain, from its state then (R1).
		driver
			.leaseLost(lease, reason)
			.catch((err: unknown) => {
				const invalid =
					err instanceof ScannerApiError &&
					err.code === "SCANNER_INVALID_TRANSITION"
				this.log[invalid ? "debug" : "warn"](
					{ err, jobId: lease.jobId, reason },
					"Lease loss could not be applied to the job",
				)
			})
			.finally(() => {
				this.operatorLost.delete(lease.jobId)
				this.updateMasks(lease.sourceId)
			})
	}

	private readonly onEngineFatal = (sourceId: string, err: Error): void => {
		if (this.iqEngines.delete(sourceId))
			this.deps.iqCapture?.detachSource(sourceId)
		this.cancelChannelSource(sourceId, "engine-failed")
		if (!this.started) return
		this.lastSummaries.delete(sourceId)
		this.closeLiveOn(sourceId, "gap")
		for (const d of this.driversOn(sourceId))
			if (!isTerminal(d.record.state))
				void d
					.dispatch({ type: "engine-failed" })
					.catch((error: unknown) =>
						this.log.warn(
							{ err: error, cause: err, jobId: d.record.id },
							"Failed engine job cleanup failed",
						),
					)
	}

	private readonly onSourceDown = (sourceId: string): void => {
		this.cancelChannelSource(sourceId)
		if (!this.started) return
		for (const o of this.live.values())
			if (o.sourceId === sourceId) delete o.acceptedIdentity
		for (const d of this.driversOn(sourceId)) {
			if (
				d.record.state === "starting" ||
				d.record.state === "running" ||
				d.record.state === "holding"
			)
				d.dispatch({
					type: d.record.state === "starting" ? "engine-failed" : "source-down",
				}).catch((err: unknown) =>
					this.log.warn({ err, jobId: d.record.id }, "source-down failed"),
				)
		}
	}

	private readonly onSourceUp = (sourceId: string): void => {
		if (!this.started) return
		for (const d of this.driversOn(sourceId)) {
			if (d.record.state === "paused" && d.record.reason === "source-down")
				d.dispatch({ type: "source-up" }).catch((err: unknown) =>
					this.log.warn({ err, jobId: d.record.id }, "source-up failed"),
				)
		}
		if (!this.persistedLeases.has(sourceId)) this.runBootResumes(sourceId)
		this.onSourceAvailable(sourceId)
	}

	/** Boot-time caps are absent until SourceManager.connect(): the source's passive job is (re)built then. */
	private readonly onSourceConnected = (sourceId: string): void => {
		this.onSourceAvailable(sourceId)
	}

	/**
	 * S1-B final review, finding 6: the scanner's own retunes change the caps on every sweep hop; the
	 * source's passive job is not re-evaluated while the scanner holds its lease.
	 */
	private readonly onCapsChanged = (sourceId: string): void => {
		this.cancelChannelSource(sourceId, "epoch-changed")
		if (this.arbiter.holder(sourceId)) return
		this.onSourceAvailable(sourceId)
	}

	/** Re-evaluates one source's passive job (finding 6: only the source the event is about). */
	private onSourceAvailable(sourceId: string): void {
		if (!this.started || !this.settings().enabled) return
		// refreshPassive logs a failure on the chain itself.
		this.refreshPassive(sourceId).catch(() => undefined)
	}

	/** ensurePassiveJobs (of one source, or all), serialised on passiveChain (stop() awaits it). */
	private refreshPassive(sourceId?: string): Promise<void> {
		const run = this.passiveChain.then(() => this.ensurePassiveJobs(sourceId))
		this.passiveChain = run.catch((err: unknown) =>
			this.log.warn({ err }, "Refreshing passive jobs failed"),
		)
		return run
	}

	/** Recovery settled (restored, or adopted by a job's acquire with empty lists, Task 33). */
	private readonly onRecovered = (sourceId: string): void => {
		if (!this.started) return
		// An adopting holder's lease stays persisted (its release restores the pre-crash state).
		if (!this.arbiter.holder(sourceId)) this.persistedLeases.delete(sourceId)
		this.runBootResumes(sourceId)
	}

	private readonly onSourceRemoved = (sourceId: string): void => {
		this.cancelChannelSource(sourceId)
		this.detachIqEngine(sourceId)
		this.store.clearPending(sourceId) // DQ 1.5
		if (!this.started) return
		for (const d of this.driversOn(sourceId)) {
			if (!isTerminal(d.record.state))
				d.dispatch({ type: "source-removed" }).catch((err: unknown) =>
					this.log.warn({ err, jobId: d.record.id }, "source-removed failed"),
				)
		}
	}

	private runBootResumes(sourceId: string): void {
		if (!this.started || !this.settings().enabled) return
		const ids = this.bootResume.get(sourceId)
		if (!ids) return
		this.bootResume.delete(sourceId)
		for (const id of ids) {
			this.lifecycle(id, { type: "resume", takeover: false }).catch(
				(err: unknown) =>
					this.log.warn({ err, jobId: id }, "Boot resume refused"),
			)
		}
	}

	private async onPersistLease(
		sourceId: string,
		lease: PersistedLease | null,
	): Promise<void> {
		if (lease) this.persistedLeases.set(sourceId, lease)
		else this.persistedLeases.delete(sourceId)
		await this.persistJobs()
	}

	/** Task 29 review, finding 6: resolves once the caps show the restored fields, or after a bounded wait. */
	private awaitRestoredCaps(
		sourceId: string,
		snapshot: Lease["snapshot"],
		restored: readonly string[],
	): Promise<void> {
		const want: { centerFreq?: number; sampleRate?: number } = {}
		if (restored.includes("frequency") && snapshot.frequency !== undefined)
			want.centerFreq = snapshot.frequency
		if (restored.includes("sampleRate") && snapshot.sampleRate !== undefined)
			want.sampleRate = snapshot.sampleRate
		const matches = (caps: SourceCaps | undefined): boolean =>
			caps !== undefined &&
			(want.centerFreq === undefined || caps.centerFreq === want.centerFreq) &&
			(want.sampleRate === undefined || caps.sampleRate === want.sampleRate)
		if (matches(this.deps.sources.getCaps(sourceId))) return Promise.resolve()
		return new Promise(resolve => {
			const done = (): void => {
				clearTimeout(timer)
				this.deps.sources.off("caps-changed", onCaps)
				resolve()
			}
			const onCaps = (id: string, caps: SourceCaps): void => {
				if (id === sourceId && matches(caps)) done()
			}
			const timer = setTimeout(() => {
				this.log.warn(
					{ sourceId, want, caps: this.deps.sources.getCaps(sourceId) },
					"Source caps did not show the restored tuning in time; releasing the decoder hold anyway",
				)
				done()
			}, RESTORE_CAPS_TIMEOUT_MS)
			timer.unref()
			this.deps.sources.on("caps-changed", onCaps)
		})
	}

	// === job plumbing ===

	private createDriver(record: JobRecord): JobDriver {
		return new JobRunner({
			record,
			leaseAnalogSession: sourceId =>
				this.deps.analogTrial?.leaseSession?.(sourceId),
			autoResumeReady: () => this.autoResumeReady(record),
			knownProtocols: this.knownProtocols,
			arbiter: this.arbiter,
			probes: this.probes,
			decoders: this.deps.decoders,
			settings: () => this.settings(),
			openEngine: sourceId => this.openEngine(sourceId, record.id),
			closeEngine: sourceId => this.closeEngine(sourceId, record.id),
			engine: sourceId => this.spectrum.engine(sourceId),
			refreshTuning: sourceId => this.spectrum.refreshTuning(sourceId),
			activitySeed: (() => {
				const seed = this.spectrum.activitySeed(record.spec.sourceId)
				return (hop: Hop) => seed(hop.covered)
			})(),
			impact: () =>
				this.arbiter.impact(record.spec.sourceId, record.spec, record.id),
			undecoded: (live, reason) => this.markUndecoded(live, reason),
			discoveryCounts: jobId => this.store.countsByJob(jobId),
			awaitRestoredCaps: (sourceId, snapshot, restored) =>
				this.awaitRestoredCaps(sourceId, snapshot, restored),
			persist: () => void this.persistJobs(),
			changed: kind => {
				if (kind !== "state") {
					this.emitProgressFor(record)
					return
				}
				this.emitJob(record)
				// P16: a sweep that ended (stop condition, tuner error, source removed, cancel) frees the
				// lease; a waiting preempted job gets it. Not after an operator or relay write.
				if (
					record.spec.mode === "sweep" &&
					isTerminal(record.state) &&
					!this.operatorLost.has(record.id)
				)
					this.queueArbitration(record.spec.sourceId)
			},
			logger: this.deps.logger,
			now: this.now,
			activity: jobId => this.jobActivity(jobId),
		})
	}

	/**
	 * WG12 req 7. Open detection captures, the running replay probe, and the
	 * captures waiting on or held by the replay queue for a discovery of this job.
	 * The queue exposes the active analog or digital trial; span pins give per-job depth.
	 */
	private jobActivity(jobId: string): JobActivityView {
		return {
			capturing: this.capturingOf(jobId),
			replaying: this.replayingOf(jobId),
			replayQueueDepth: this.replayQueueDepthOf(jobId),
		}
	}

	private capturingOf(jobId: string): number {
		let count = 0
		for (const observationId of this.iqCaptureOf.keys()) {
			try {
				const live = this.findObservation(observationId)
				if (live?.jobIds.includes(jobId)) {
					count += 1
					continue
				}
				const discoveryId =
					live?.discoveryId ?? this.store.discoveryIdOf(observationId)
				if (!discoveryId) continue
				if (this.store.get(discoveryId)?.jobIds.includes(jobId)) count += 1
			} catch {
				// One unreadable observation does not zero the activity view.
			}
		}
		return count
	}

	/**
	 * The earliest running replay probe whose observation belongs to a discovery
	 * of this job, including an active analog trial.
	 */
	private replayingOf(jobId: string): JobActivityView["replaying"] {
		const active = this.replayQueue?.active()
		if (active?.observationId) {
			const discoveryId = this.discoveryIdForActivity(active.observationId)
			if (discoveryId && this.discoveryInJob(discoveryId, jobId))
				return {
					protocol: active.protocol,
					decoder: active.decoder,
					discoveryId,
				}
		}
		let probes: ReturnType<ProbePool["status"]>
		try {
			probes = this.probes.status()
		} catch {
			return null
		}
		const running = probes
			.filter(
				probe =>
					probe.transport === "replay" &&
					probe.jobId === IQ_REPLAY_QUEUE_HOLDER &&
					probe.state !== "stopping",
			)
			.sort(
				(a, b) =>
					a.startedAt - b.startedAt || a.probeId.localeCompare(b.probeId),
			)
		for (const probe of running) {
			const discoveryId = this.discoveryIdForActivity(probe.observationId)
			if (!discoveryId || !this.discoveryInJob(discoveryId, jobId)) continue
			return {
				protocol: probe.protocol,
				decoder: probe.decoderType,
				discoveryId,
			}
		}
		return null
	}

	/**
	 * Finished captures still stored for a discovery of this job, waiting (no
	 * holder, including parked for identify) or held by the replay queue.
	 * Identify's own holder and a capture the store has dropped are excluded.
	 */
	private replayQueueDepthOf(jobId: string): number {
		const port = this.deps.iqCapture
		if (!port) return 0
		let count = 0
		for (const [observationId, captures] of this.spanPins) {
			const discoveryId = this.discoveryIdForActivity(observationId)
			if (!discoveryId || !this.discoveryInJob(discoveryId, jobId)) continue
			for (const captureId of captures) {
				let holder: string | null | undefined
				try {
					holder = port.holderOf(captureId)
				} catch {
					continue
				}
				if (holder === null || holder === IQ_REPLAY_QUEUE_HOLDER) count += 1
			}
		}
		return count
	}

	private discoveryIdForActivity(observationId: string): string | null {
		if (!observationId) return null
		try {
			const live = this.findObservation(observationId)
			return (
				live?.discoveryId ?? this.store.discoveryIdOf(observationId) ?? null
			)
		} catch {
			return null
		}
	}

	private discoveryInJob(discoveryId: string, jobId: string): boolean {
		try {
			return this.store.get(discoveryId)?.jobIds.includes(jobId) === true
		} catch {
			return false
		}
	}

	/** A finished or removed capture is no longer an open detection writer. */
	private forgetWritingCapture(captureId: string): void {
		for (const [observationId, hit] of this.iqCaptureOf)
			if (hit.captureId === captureId) this.iqCaptureOf.delete(observationId)
	}

	/**
	 * WG12 req 6.3: subscribe the in-memory analog evidence sink to closed
	 * live-audio transmissions. A log without `subscribe` (older fakes) is skipped.
	 * The store is passed as-is; `near` and `recordAnalog` land with the evidence lane.
	 */
	private startLiveAudioEvidence(): void {
		if (this.liveAudio) return
		const log = this.deps.analogEvidence
		if (!log || !("subscribe" in log) || typeof log.subscribe !== "function")
			return
		this.liveAudio = createLiveAudioEvidence({
			store: this.store,
			analogLog: log as AnalogEvidenceLog,
			trust: sourceId => this.liveAudioTrust(sourceId),
			logger: this.deps.logger,
		})
		this.liveAudio.start()
	}

	private stopLiveAudioEvidence(): void {
		this.liveAudio?.stop()
		this.liveAudio = null
	}

	/** Fail closed: unknown tuner state, an unwritten connection, or a throw. */
	private liveAudioTrust(sourceId: string): TuningTrust {
		try {
			const trust = tuningTrustOf(this.deps.tuner.getState(sourceId))
			if (trust === "unverified") return trust
			if (this.deps.tuner.tuningWrittenOnConnection(sourceId) !== true)
				return "unverified"
			return trust
		} catch {
			return "unverified"
		}
	}

	/**
	 * WG12 req 6.1: an open track of this source whose gate passed within
	 * `toleranceHz` of `hz`. A track gated at or after `jobStartedMs` is preferred
	 * over a nearer track that gated earlier, so an old carrier cannot hide a
	 * transmission that opened with this job. Within that set the nearest centre
	 * wins, and a distance tie breaks toward the smaller track id. At most 256
	 * open tracks of this source are scanned. `startSample` is the gate-passed
	 * sample. `atMs` is the wall-clock receipt of the first gate pass.
	 */
	private gatedTransmission(
		sourceId: string,
		hz: number,
		toleranceHz: number,
		jobStartedMs: number,
	): { startSample: number; atMs: number } | null {
		if (
			!Number.isFinite(hz) ||
			!Number.isFinite(toleranceHz) ||
			toleranceHz < 0
		)
			return null
		let scanned = 0
		const jobStart = Number.isFinite(jobStartedMs) ? jobStartedMs : null
		let best: {
			trackId: string
			distance: number
			startSample: number
			atMs: number
			fresh: boolean
		} | null = null
		for (const live of this.live.values()) {
			if (live.sourceId !== sourceId || live.endedAt !== undefined) continue
			const track = live.lastTrack
			if (!track) continue
			scanned += 1
			if (scanned > 256) break
			if (track.gate !== "passed") continue
			const sample = track.gatePassedSample
			if (typeof sample !== "number" || !Number.isFinite(sample) || sample < 0)
				continue
			if (!Number.isFinite(track.centreHz)) continue
			const distance = Math.abs(track.centreHz - hz)
			if (distance > toleranceHz) continue
			const atMs = live.gatePassedAt
			if (atMs === undefined || live.epoch !== track.epoch) continue
			if (!Number.isFinite(atMs)) continue
			const fresh = jobStart !== null && atMs >= jobStart
			const nearer =
				best !== null &&
				(distance < best.distance ||
					(distance === best.distance && track.trackId < best.trackId))
			if (
				best === null ||
				(fresh && !best.fresh) ||
				(fresh === best.fresh && nearer)
			) {
				best = {
					trackId: track.trackId,
					distance,
					startSample: sample,
					atMs,
					fresh,
				}
			}
		}
		return best === null
			? null
			: { startSample: best.startSample, atMs: best.atMs }
	}

	private createIdentifyDriver(
		record: JobRecord,
		identify: NormalisedIdentify,
	): IdentifyRunner {
		const ranges = (
			this.deps.bandplans?.() ?? bandplansFor(this.deps.region)
		).flatMap(b => b.ranges)
		return new IdentifyRunner({
			record,
			identify,
			inner: this.createDriver(record),
			probes: this.probes,
			engine: sourceId => this.identifyEngine(sourceId),
			artefactAt: (sourceId, hz) => this.artefactAt(sourceId, hz),
			liveTracks: sourceId =>
				[...this.live.values()].flatMap(o =>
					o.sourceId === sourceId && o.lastTrack
						? [
								{
									observationId: o.observationId,
									trackId: o.trackId,
									epoch: o.epoch,
									discoveryId: o.discoveryId,
									track: o.lastTrack,
								},
							]
						: [],
				),
			// Only a summary of the current epoch measures the target's window (never a former one).
			lastSummary: sourceId => {
				const summary = this.lastSummaries.get(sourceId)
				const epoch = this.identifyEngine(sourceId)?.currentEpoch().epoch
				return summary && summary.epoch === epoch ? summary : null
			},
			discoveryOf: observationId => {
				const id = this.store.discoveryIdOf(observationId)
				return id ? this.store.get(id) : undefined
			},
			priorsAt: hz => narrowestPriors(withScannerOverlays(ranges), hz),
			narrowRasterAt: hz => narrowRasterAt(ranges, hz),
			knownProtocols: this.knownProtocols,
			format: sourceId =>
				this.identifyEngine(sourceId)?.format ??
				this.deps.sources.getCaps(sourceId)?.format ??
				"",
			// [S2] Task 40 replaces this with Boolean(this.deps.channels): parallel channel trials.
			channelizer: () => false,
			// WG7 req 1.5: running config-owned ambient decoders covering the target. Without a trust
			// source no ambient decode can ever count, so no ambient trial is planned (as before WG7).
			...(this.deps.ambientTrust
				? {
						ambient: (sourceId: string, hz: number, toleranceHz: number) =>
							this.ambient.coverageAt(sourceId, hz, toleranceHz),
					}
				: {}),
			...(this.deps.analogEvidence
				? { analogEvidence: this.deps.analogEvidence }
				: {}),
			...(this.deps.analogTrial ? { analogTrial: this.admittedAnalog()! } : {}),
			...(this.deps.iqCapture ? { iqCapture: this.deps.iqCapture } : {}),
			settings: () => this.settings(),
			gatedAt: (sourceId, hz, toleranceHz) =>
				this.gatedTransmission(
					sourceId,
					hz,
					toleranceHz,
					record.startedAt ?? record.createdAt,
				),
			emit: data => {
				this.emit("identify", data)
				// a target or job that ended may release captures the queue parked.
				this.recheckReplays()
			},
			logger: this.deps.logger,
			now: this.now,
		})
	}

	/** The source's spectrum engine for identify. */
	private identifyEngine(sourceId: string): SpectrumEngine | undefined {
		return this.spectrum.engine(sourceId)
	}

	/**
	 * § 4.9: `artefactOf` on the worker's current masks (Task 32's request/response message). Right after a retune
	 * the main-thread epoch runs ahead of the worker's masks: "stale" makes the runner ask again on a later tick.
	 */
	private async artefactAt(
		sourceId: string,
		hz: number,
	): Promise<ArtefactKind | null | "stale"> {
		const engine = this.identifyEngine(sourceId)
		if (!engine) return null
		const masks = await engine.artefactMasks()
		if (!masks) return null
		const epoch = engine.currentEpoch().epoch
		return masks.epoch === epoch ? artefactOf(hz, epoch, masks) : "stale"
	}

	/** The tuned window: the engine's epoch, or the source caps before any engine is open. */
	private identifyWindow(
		sourceId: string,
	): { centreHz: number; sampleRateHz: number } | null {
		const epoch = this.identifyEngine(sourceId)?.currentEpoch()
		if (epoch)
			return { centreHz: epoch.centreHz, sampleRateHz: epoch.sampleRateHz }
		const caps = this.deps.sources.getCaps(sourceId)
		const centreHz = caps?.centerFreq
		const sampleRateHz = caps?.sampleRate
		return typeof centreHz === "number" && typeof sampleRateHz === "number"
			? { centreHz, sampleRateHz }
			: null
	}

	/** Identify jobs are not persisted; only the newest IDENTIFY_KEEP_JOBS ended ones stay listed. */
	private pruneIdentifyJobs(): void {
		const ended = [...this.jobs.values()]
			.filter(j => j.spec.kind === "identify" && isTerminal(j.state))
			.sort((a, b) => a.createdAt - b.createdAt)
		for (const j of ended.slice(
			0,
			Math.max(0, ended.length - IDENTIFY_KEEP_JOBS),
		)) {
			this.jobs.delete(j.id)
			this.hits.delete(j.id)
			this.drivers.delete(j.id)
		}
	}

	private async lifecycle(
		id: string,
		e: Parameters<JobDriver["dispatch"]>[0],
	): Promise<ScanJob> {
		const record = this.requireJob(id)
		// WG11 req 1.6: cancelling an ended job changes nothing, so it skips arbitration and masks.
		if (e.type === "cancel" && isTerminal(record.state)) {
			this.requireDriver(id)
			return this.toDto(record)
		}
		await this.requireDriver(id).dispatch(e)
		await this.arbitrate(record.spec.sourceId)
		this.updateMasks(record.spec.sourceId)
		return this.toDto(record)
	}

	/** Runs arbitrateLeases on the source's serialised chain; never rejects. */
	private arbitrate(
		sourceId: string,
		eligible?: (r: JobRecord) => boolean,
	): Promise<void> {
		return this.onArbitrationChain(sourceId, () =>
			this.arbitrateLeases(sourceId, eligible),
		).catch((err: unknown) =>
			this.log.warn({ err, sourceId }, "Lease arbitration failed"),
		)
	}

	/** Runs `fn` on the source's serialised arbitration chain; its result or error goes to the caller only. */
	private onArbitrationChain<T>(
		sourceId: string,
		fn: () => Promise<T>,
	): Promise<T> {
		const run = (this.arbitrations.get(sourceId) ?? Promise.resolve()).then(fn)
		this.arbitrations.set(
			sourceId,
			run.then(
				() => undefined,
				() => undefined,
			),
		)
		return run
	}

	/**
	 * Like arbitrate, from a callback; coalesced while one is queued for the source. An unfiltered
	 * request widens a queued filtered one (R3).
	 */
	private queueArbitration(
		sourceId: string,
		eligible?: (r: JobRecord) => boolean,
	): void {
		if (!this.started) return
		if (this.arbitrationQueued.has(sourceId)) {
			if (!eligible) this.arbitrationQueued.set(sourceId, null)
			return
		}
		this.arbitrationQueued.set(sourceId, eligible ?? null)
		void this.onArbitrationChain(sourceId, () => {
			const filter = this.arbitrationQueued.get(sourceId) ?? null
			this.arbitrationQueued.delete(sourceId)
			return this.arbitrateLeases(sourceId, filter ?? undefined)
		}).catch((err: unknown) =>
			this.log.warn({ err, sourceId }, "Lease arbitration failed"),
		)
	}

	/**
	 * Explicit resume of a preempted sweep: on the arbitration chain, at once (no idle
	 * wait; the resume is the consent). It gets the lease only when no job holds it and it is the
	 * best waiter (`chooseLeaseHolder`, P16); otherwise 409 with its state unchanged.
	 */
	private async resumePreempted(
		record: JobRecord,
		takeover: boolean,
	): Promise<ScanJob> {
		const { sourceId } = record.spec
		await this.onArbitrationChain(sourceId, async () => {
			await Promise.all(this.driversOn(sourceId).map(d => d.idle()))
			if (isPreempted(record)) {
				const holder = this.arbiter.holder(sourceId)
				if (holder)
					throw new ScannerApiError(
						`Lease held by scanner job ${holder.jobId}`,
						"SCANNER_SOURCE_BUSY",
						409,
						{ reason: "held", holderJobId: holder.jobId },
					)
				const best = chooseLeaseHolder(
					[...this.jobs.values()]
						.filter(
							j =>
								j.spec.sourceId === sourceId &&
								j.spec.mode === "sweep" &&
								isPreempted(j),
						)
						.map(j => ({
							jobId: j.id,
							priority: j.spec.priority,
							createdAt: j.createdAt,
						})),
				)
				if (best !== record.id)
					throw new ScannerApiError(
						`Scanner job ${best} waits for the lease with a better claim`,
						"SCANNER_SOURCE_BUSY",
						409,
						{ reason: "held", waiter: best },
					)
			}
			await this.requireDriver(record.id).dispatch({ type: "resume", takeover })
		})
		this.updateMasks(sourceId)
		return this.toDto(record)
	}

	/**
	 * P16: hand a free lease to the best runnable job that lost it to another job. Waits for the
	 * source's jobs to apply what is already queued (a preempted-job dispatch may still be pending).
	 * `eligible` narrows the candidates (operator-idle tick).
	 */
	private async arbitrateLeases(
		sourceId: string,
		eligible?: (r: JobRecord) => boolean,
	): Promise<void> {
		if (!this.started) return
		await Promise.all(this.driversOn(sourceId).map(d => d.idle()))
		if (this.arbiter.holder(sourceId)) return
		const waiting = [...this.jobs.values()].filter(
			j =>
				j.spec.sourceId === sourceId &&
				j.spec.mode === "sweep" &&
				j.state === "paused" &&
				j.reason === "preempted-job" &&
				(eligible?.(j) ?? true),
		)
		const best = chooseLeaseHolder(
			waiting.map(j => ({
				jobId: j.id,
				priority: j.spec.priority,
				createdAt: j.createdAt,
			})),
		)
		if (!best) return
		const record = this.jobs.get(best)!
		await this.requireDriver(best)
			.dispatch({
				type: "preemptor-idle",
				impactGrew: impactGrew(
					this.arbiter.impact(sourceId, record.spec, record.id),
					record.consentedImpact,
				),
			})
			.catch((err: unknown) =>
				this.log.warn({ err, jobId: best }, "Lease hand-back refused"),
			)
		this.updateMasks(sourceId)
	}

	/**
	 * § 10.3 auto-resume for jobs waiting on another job's lease: when the lease is free after an
	 * operator or relay write, the best `preempted-job` waiter whose `resume.autoAfterIdleMs` has
	 * elapsed since the operator's last command gets it.
	 */
	private resumeIdleWaiters(now: number): void {
		const sources = new Set(
			[...this.jobs.values()]
				.filter(
					j =>
						j.spec.mode === "sweep" &&
						j.state === "paused" &&
						j.reason === "preempted-job",
				)
				.map(j => j.spec.sourceId),
		)
		for (const sourceId of sources) {
			if (this.arbiter.holder(sourceId)) continue
			const idleSince = this.arbiter.operatorIdleSince(sourceId)
			if (idleSince === null) continue
			const ready = (r: JobRecord): boolean =>
				r.spec.resume.autoAfterIdleMs !== null &&
				now - idleSince >= r.spec.resume.autoAfterIdleMs
			const any = [...this.jobs.values()].some(
				j =>
					j.spec.sourceId === sourceId &&
					j.state === "paused" &&
					j.reason === "preempted-job" &&
					ready(j),
			)
			if (any) this.queueArbitration(sourceId, ready)
		}
	}

	private async restoreJob(pj: PersistedJob): Promise<void> {
		if (pj.id.startsWith("passive-")) return
		let plan: HopPlan
		let lockoutExclusions: LockoutExclusion[] | undefined
		let decodedElsewhere: DecodedElsewhereRange[] | undefined
		let bandPlanSkips: BandPlanSkipRange[] | undefined
		let failed = false
		try {
			;({ plan, lockoutExclusions, decodedElsewhere, bandPlanSkips } = planJob(
				pj.spec,
				this.previewContext(),
			))
		} catch (err) {
			this.log.warn(
				{ err, jobId: pj.id },
				"Persisted job no longer plans; marking failed",
			)
			plan = { hops: [], usableHalfSpanHz: 0, dcGuardHz: 0, ppmMarginHz: 0 }
			failed = true
		}
		const record: JobRecord = {
			id: pj.id,
			name: pj.rawSpec.name ?? null,
			passive: false,
			rawSpec: pj.rawSpec,
			spec: pj.spec,
			plan,
			issues: [],
			impact: null,
			consentedImpact: null,
			...(failed
				? { state: "failed" as const, reason: "invalid" as const }
				: { state: pj.state, ...(pj.reason ? { reason: pj.reason } : {}) }),
			createdAt: Date.parse(pj.createdAt),
			updatedAt: failed ? this.now() : Date.parse(pj.updatedAt),
			...(failed ? { endedAt: this.now() } : {}),
			unrestorable: [],
			counts: { observations: 0, transients: 0 },
			...(lockoutExclusions && !failed ? { lockoutExclusions } : {}),
			...(decodedElsewhere && !failed ? { decodedElsewhere } : {}),
			...(bandPlanSkips && !failed ? { bandPlanSkips } : {}),
		}
		const driver = this.createDriver(record)
		this.jobs.set(record.id, record)
		this.drivers.set(record.id, driver)
		if (isTerminal(record.state)) return
		// An explicit Stay-here choice survives restart, even with onBoot enabled.
		if (record.state === "paused" && record.reason === "operator") return
		await driver
			.dispatch({ type: "boot" })
			.catch((err: unknown) =>
				this.log.warn({ err, jobId: pj.id }, "Boot transition failed"),
			)
		if (record.spec.resume.onBoot && this.settings().enabled) {
			const list = this.bootResume.get(record.spec.sourceId) ?? []
			list.push(record.id)
			this.bootResume.set(record.spec.sourceId, list)
		}
	}

	private async ensurePassiveJobs(only?: string): Promise<void> {
		const s = this.settings()
		for (const cfg of this.deps.sourceConfigs) {
			// Finding 5: never (re)start a passive job once stop() began.
			if (!this.started) return
			if (only !== undefined && cfg.id !== only) continue
			const id = `passive-${cfg.id}`
			const caps = this.deps.sources.getCaps(cfg.id) ?? cfg.caps
			const eligible =
				s.enabled &&
				s.passive.enabled &&
				this.effective.passiveBySource[cfg.id] === true &&
				isScannerIqFormat(caps) &&
				// Finding 6: a permanently removed source (M1) until it connects again.
				this.spectrum.eligibleSources().includes(cfg.id) &&
				!this.passiveDisabled.has(cfg.id)
			let existing = this.jobs.get(id)
			if (existing && isTerminal(existing.state)) {
				// An ended passive job (e.g. its source was removed) is rebuilt once the source is eligible again.
				this.jobs.delete(id)
				this.hits.delete(id)
				this.drivers.delete(id)
				existing = undefined
			}
			if (!eligible && existing) {
				if (!isTerminal(existing.state))
					await this.requireDriver(id)
						.dispatch({ type: "cancel" })
						.catch((err: unknown) =>
							this.log.warn(
								{ err, jobId: id },
								"Cancelling a passive job failed",
							),
						)
				this.jobs.delete(id)
				this.hits.delete(id)
				this.drivers.delete(id)
				continue
			}
			if (!eligible || existing) continue
			// WG10 req 4.2: without caps (boot, ahead of `connected`) the engine cannot start; the
			// `connected` event rebuilds the job.
			if (this.deps.sources.getCaps(cfg.id) === undefined) {
				this.log.debug(
					{ sourceId: cfg.id },
					"Passive job skipped until the source has caps",
				)
				continue
			}
			const rawSpec: ScanJobSpec = {
				name: `Passive ${cfg.id}`,
				sourceId: cfg.id,
				mode: "in-window",
				protocols: [],
				priority: 0,
				resume: { onBoot: true },
			}
			const preview = this.preview(rawSpec)
			if (preview.issues.some(i => i.severity === "error")) {
				this.log.info(
					{ sourceId: cfg.id, issues: preview.issues },
					"Passive job not created",
				)
				continue
			}
			const now = this.now()
			const record: JobRecord = {
				id,
				name: rawSpec.name ?? null,
				passive: true,
				rawSpec,
				spec: preview.spec,
				plan: preview.plan,
				issues: preview.issues,
				impact: null,
				consentedImpact: null,
				state: "pending",
				createdAt: now,
				updatedAt: now,
				unrestorable: [],
				counts: { observations: 0, transients: 0 },
			}
			const driver = this.createDriver(record)
			this.jobs.set(id, record)
			this.drivers.set(id, driver)
			this.hits.delete(id)
			try {
				await driver.start()
			} catch (err) {
				// The start rolled back (no lease, hold or engine kept). Drop the job so the next
				// connected / caps-changed / source-up rebuilds it (boot-time caps are often absent).
				this.log.warn(
					{ err, sourceId: cfg.id },
					"Passive job failed to start; retrying when the source changes",
				)
				this.jobs.delete(id)
				this.hits.delete(id)
				this.drivers.delete(id)
				await driver.dispose()
			}
		}
	}

	private recomputeSettings(): void {
		this.effective = mergeScannerSettings({
			config: this.deps.settings,
			sources: this.deps.sourceConfigs,
			overrides: this.overrides,
		})
		this.invalidateChannelAdmission()
		// Runtime storage/detection settings reach the stores (§ 12.1 PATCH settings).
		const s = this.effective.settings
		this.store.setLimits({
			maxDiscoveries: s.storage.maxDiscoveries,
			minSurfaceBlocks: s.detection.minSurfaceBlocks,
		})
		this.evidence.setCaps(storageCaps(s))
	}

	private previewContext(): PreviewContext {
		const tuner = this.deps.tuner
		return {
			sources: this.deps.sourceConfigs.map(cfg => {
				const caps = this.deps.sources.getCaps(cfg.id) ?? cfg.caps
				const state = tuner.getState(cfg.id)
				return {
					id: cfg.id,
					kind: caps.kind,
					format: caps.format,
					sampleRateHz: caps.sampleRate,
					centreHz: caps.centerFreq ?? null,
					controllable:
						this.deps.sources.isRtlTcpSource(cfg.id) && state !== undefined,
					controlMode: state?.controlMode ?? null,
					role: sourceScannerConfig(cfg).role,
					link: linkOf(cfg),
				}
			}),
			channelizerAvailable: false,
			usableFraction: USABLE_FRACTION,
			settings: this.settings(),
			measured: {
				...this.measured,
				markerSupported: Object.fromEntries(
					this.spectrum
						.sourceIds()
						.map(id => [id, this.spectrum.engine(id)?.markerSupported ?? null]),
				),
			},
			impactFor: (sourceId, spec) => this.arbiter.impact(sourceId, spec),
			region: this.deps.region,
			bandplans: this.deps.bandplans?.() ?? bandplansFor(this.deps.region),
			tunerRange: () => ({ startHz: 24_000_000, endHz: 1_766_000_000 }),
			lockouts: sourceId => this.store.lockouts(sourceId),
			...(this.deps.decoderCoverage
				? { decoderCoverage: this.deps.decoderCoverage }
				: {}),
			...(this.deps.bandPlanSkips
				? { bandPlanSkips: this.bandPlanSkipsRead }
				: {}),
		}
	}

	/** WG7 req 6.6: a throwing band-plan view counts as none (fail closed: nothing skipped). */
	private readonly bandPlanSkipsRead = (): readonly BandPlanSkipSource[] => {
		try {
			return this.deps.bandPlanSkips?.() ?? []
		} catch (err) {
			this.log.warn(
				{ errName: err instanceof Error ? err.name : typeof err },
				"Band-plan skip view failed; planning without band-plan skips",
			)
			return []
		}
	}

	private rejectErrors(issues: PlanIssue[]): void {
		const errors = issues.filter(i => i.severity === "error")
		if (errors.length === 0) return
		const busy = errors.find(i => i.code === "source-busy")
		if (busy)
			throw new ScannerApiError(busy.message, "SCANNER_SOURCE_BUSY", 409, {
				reason: "relay",
				issues,
			})
		const control = errors.find(i => i.code === "no-tuner-control")
		if (control)
			throw new ScannerApiError(
				control.message,
				"SCANNER_NO_TUNER_CONTROL",
				409,
				{ issues },
			)
		throw new ScannerApiError(
			"The job spec has errors",
			"SCANNER_PLAN_INVALID",
			400,
			{ issues },
		)
	}

	private impactNonEmpty(i: Impact): boolean {
		return (
			i.liveAudioClients > 0 ||
			i.digitalVoiceListeners > 0 ||
			i.runningDecoders.length > 0 ||
			i.pinnedDecoders.length > 0 ||
			i.scannerJobs.length > 0 ||
			i.unrestorable.length > 0
		)
	}

	private requireJob(id: string): JobRecord {
		const r = this.jobs.get(id)
		if (!r)
			throw new ScannerApiError(
				`Job ${id} not found`,
				"SCANNER_JOB_NOT_FOUND",
				404,
			)
		return r
	}

	private requireDriver(id: string): JobDriver {
		const d = this.drivers.get(id)
		if (!d)
			throw new ScannerApiError(
				`Job ${id} not found`,
				"SCANNER_JOB_NOT_FOUND",
				404,
			)
		return d
	}

	private driversOn(sourceId: string): JobDriver[] {
		return [...this.drivers.values()].filter(
			d => d.record.spec.sourceId === sourceId,
		)
	}

	private allDiscoveries(filter: DiscoveryFilter): Discovery[] {
		const out: Discovery[] = []
		let cursor: string | null = null
		do {
			const page = this.store.list({ ...filter, limit: 500, cursor })
			out.push(...page.items)
			cursor = page.nextCursor
		} while (cursor)
		return out
	}

	private readonly resumeActivities = new Map<string, ResumeActivity>()
	private readonly resumeViews = new Map<string, string>()
	private operatorActivityOff: (() => void) | undefined

	private resumeStatus(record: JobRecord, prospective = false): ResumeStatus {
		const sourceId = record.spec.sourceId
		let operator: ReturnType<OperatorActivityPort["current"]> = {
			audio: false,
			recording: false,
		}
		try {
			operator = this.deps.operatorActivity?.current() ?? operator
		} catch {
			operator = { audio: false, recording: true }
		}
		if (
			operator.sourceId !== undefined &&
			operator.sourceId !== null &&
			operator.sourceId !== sourceId
		)
			operator = { audio: false, recording: false }
		const identify = [...this.drivers.values()].some(
			driver =>
				driver instanceof IdentifyRunner &&
				driver.record.spec.sourceId === sourceId &&
				driver
					.view()
					.targets.some(target =>
						target.trials.some(
							trial =>
								trial.outcome === "running" || trial.outcome === "pending",
						),
					),
		)
		let activity = this.resumeActivities.get(sourceId)
		if (!activity) {
			activity = new ResumeActivity()
			this.resumeActivities.set(sourceId, activity)
		}
		const status = activity.status(
			{ ...operator, identify },
			this.arbiter.operatorIdleSince(sourceId),
			record.spec.resume.autoAfterIdleMs ?? 0,
			this.now(),
		)
		return prospective ||
			(record.state === "paused" &&
				(record.reason === "preempted-operator" ||
					record.reason === "preempted-relay") &&
				record.spec.resume.autoAfterIdleMs !== null)
			? status
			: { resumeAt: null, resumeHeldBy: null }
	}

	private autoResumeReady(record: JobRecord): boolean {
		// External control remains an arbiter refusal, rather than a new activity hold.
		if (this.arbiter.operatorIdleSince(record.spec.sourceId) === null)
			return true
		const status = this.resumeStatus(record, true)
		return (
			status.resumeHeldBy === null &&
			(record.spec.resume.autoAfterIdleMs === null ||
				(status.resumeAt !== null && this.now() >= Date.parse(status.resumeAt)))
		)
	}

	private toDto(record: JobRecord): ScanJob {
		const driver = this.drivers.get(record.id)
		return {
			id: record.id,
			...this.resumeStatus(record),
			name: record.name,
			state: record.state,
			...(record.reason ? { reason: record.reason } : {}),
			...this.preemptedByOf(record),
			passive: record.passive,
			spec: record.spec,
			plan: record.plan,
			issues: record.issues,
			impact: record.impact,
			unrestorable: record.unrestorable,
			...(record.lockoutExclusions
				? { lockoutExclusions: record.lockoutExclusions }
				: {}),
			...(record.decodedElsewhere
				? { decodedElsewhere: record.decodedElsewhere }
				: {}),
			...(record.bandPlanSkips ? { bandPlanSkips: record.bandPlanSkips } : {}),
			progress: driver
				? { ...driver.progress(), hitStats: this.hitStatsOf(record.id) }
				: {
						sweepIndex: 0,
						hopIndex: 0,
						hopCount: 0,
						sweepPeriodMs: null,
						coverage: 0,
						holdingOn: null,
						settleMode: null,
						probes: [],
						counts: {
							observations: 0,
							transients: 0,
							discoveries: {
								activity: 0,
								candidate: 0,
								classified: 0,
								decoded: 0,
							},
						},
					},
			createdAt: new Date(record.createdAt).toISOString(),
			updatedAt: new Date(record.updatedAt).toISOString(),
			...(record.startedAt !== undefined
				? { startedAt: new Date(record.startedAt).toISOString() }
				: {}),
			...(record.endedAt !== undefined
				? { endedAt: new Date(record.endedAt).toISOString() }
				: {}),
			...(driver instanceof IdentifyRunner ? { identify: driver.view() } : {}),
		}
	}

	private hitStatsOf(jobId: string): ScanJobHitStats {
		return this.hits.get(jobId)?.stats() ?? emptyHitStats()
	}

	private preemptedByOf(record: JobRecord): Pick<ScanJob, "preemptedBy"> {
		return preemptedByFor(
			record,
			this.arbiter.holder(record.spec.sourceId)?.jobId,
			id => this.jobs.get(id)?.name,
		)
	}

	/** The parts of a job view that change without a job event of their own (resume hold, preemptor). */
	private derivedView(
		dto: Pick<ScanJob, "resumeAt" | "resumeHeldBy" | "preemptedBy">,
	): string {
		return JSON.stringify({
			resumeAt: dto.resumeAt,
			resumeHeldBy: dto.resumeHeldBy,
			preemptedBy: dto.preemptedBy ?? null,
		})
	}

	/** A deleted (or replaced) job emits nothing more (S1-B final review, finding 4). */
	private emitJob(record: JobRecord): void {
		if (this.jobs.get(record.id) !== record) return
		const dto = this.toDto(record)
		this.resumeViews.set(record.id, this.derivedView(dto))
		this.emit("job", dto)
	}

	private emitProgressFor(record: JobRecord | null): void {
		const records = record
			? [record]
			: [...this.jobs.values()].filter(r => !isTerminal(r.state))
		for (const r of records) {
			const p = this.drivers.get(r.id)?.progress()
			if (!p) continue
			const stats = this.hitStatsOf(r.id)
			const hop = r.plan.hops[p.hopIndex]
			const data: ScannerProgressEventData = {
				jobId: r.id,
				state: r.state,
				sweepIndex: p.sweepIndex,
				hopIndex: p.hopIndex,
				hopCount: p.hopCount,
				centerHz:
					hop?.centreHz ??
					this.spectrum.engine(r.spec.sourceId)?.currentEpoch().centreHz ??
					0,
				...(p.holdingOn ? { holdingOn: p.holdingOn } : {}),
				coverage: p.coverage,
				probes: p.probes.length,
				hits: stats.hits,
				newDiscoveries: stats.newDiscoveries,
				...(p.phase !== undefined ? { phase: p.phase } : {}),
				...(p.parked !== undefined ? { parked: p.parked } : {}),
				...(p.holding !== undefined ? { holding: p.holding } : {}),
				...(p.trial !== undefined ? { trial: p.trial } : {}),
				...(p.replayQueueDepth !== undefined
					? { replayQueueDepth: p.replayQueueDepth }
					: {}),
			}
			this.emit("progress", data)
		}
	}

	private engineStatus(
		cfg: SourceConfig,
		spectrumStatus: SpectrumSourceStatus | undefined,
	): ScannerEngineStatus {
		const s = this.settings()
		const engine = this.spectrum.engine(cfg.id)
		const pc = engine?.config() ?? null
		const stats = engine?.stats() ?? null
		const link = linkOf(cfg)
		const frequencyError = this.frequencyErrors.get(cfg.id)
		const disabledReason = this.passiveDisabled.get(cfg.id)
		const error = spectrumStatus?.lastError
		return {
			sourceId: cfg.id,
			state: engine
				? engine.isRunning
					? "running"
					: "stopped"
				: error
					? "error"
					: "idle",
			rbwHz: pc ? pc.sampleRateHz / pc.fftSize : null,
			fftSize: pc?.fftSize ?? null,
			kByRange: (stats?.kByRange ?? []).map(k => ({
				startHz: k.range.startHz,
				endHz: k.range.endHz,
				k: k.k,
				faPerMhzMin: k.faPerMhzMin,
			})),
			floorDbfs: stats?.floorDbfs ?? null,
			floorOccupied: spectrumStatus?.floorOccupied ?? false,
			// The latest block, not the pipeline's cumulative count (Task 37a review finding 2).
			overload: this.lastSummaries.get(cfg.id)?.overload ?? false,
			settleMode: engine?.currentEpoch().settleMode ?? null,
			settleMs: s.sweep.settleMs[link],
			settleMeasured: this.measured.settleMs[link] !== null,
			markerSupported: engine?.markerSupported ?? null,
			stuckTestMode: stats?.stuckTestMode ?? false,
			staleAfterSettle: stats?.staleAfterSettle ?? 0,
			blankedFrames: stats?.blankedFrames ?? 0,
			broadbandRfi: stats?.broadbandRfi ?? null,
			passive: {
				enabled: this.jobs.has(`passive-${cfg.id}`),
				...(disabledReason ? { disabledReason } : {}),
			},
			frequencyError: frequencyError
				? {
						hz: frequencyError.hz,
						ppm: frequencyError.ppm,
						discoveries: frequencyError.n,
					}
				: null,
			...(error ? { lastError: error } : {}),
		}
	}

	private emitStatus(force: boolean): void {
		const status = this.status()
		const json = JSON.stringify(status)
		if (!force && json === this.lastStatusJson) return
		this.lastStatusJson = json
		this.emit("status", status)
	}

	// === persistence and cadence ===

	private readonly onStoreMutation = (
		entry: Parameters<ScannerPersistence["append"]>[0],
	): void => {
		this.dirty = true
		if (!this.stateLoaded) return
		// Recording operations (at most 16 in flight) are reserved: never refused by the byte cap.
		const recording = this.recordingAppends.has(entry)
		const appended = this.persistence.append(
			entry,
			recording ? { reserved: true } : {},
		)
		if (recording) this.recordingAppends.set(entry, appended)
		void appended.catch((err: unknown) => {
			// Persistence logs a refusal episode once and a failed batch once; a snapshot carries
			// the mutation, so request it now rather than warn per line.
			if (
				err instanceof WaveKitError &&
				(err.code === SCANNER_JOURNAL_BACKLOG_CODE ||
					err.code === "SCANNER_PERSIST_FAILED")
			) {
				this.requestSnapshot()
				return
			}
			this.log.warn({ err }, "Journal append failed")
		})
	}

	private async acknowledgeRecordingMutation(
		mutate: (
			beforeEmit: (entry: Parameters<ScannerPersistence["append"]>[0]) => void,
		) => void,
	): Promise<void> {
		if (!this.stateLoaded || !this.recordingRecoveryHealthy)
			throw this.recordingEvidenceUnavailable()
		let registered: Parameters<ScannerPersistence["append"]>[0] | null = null
		try {
			mutate(entry => {
				if (registered !== null || this.recordingAppends.size >= 16)
					throw this.recordingEvidenceUnavailable()
				registered = entry
				this.recordingAppends.set(entry, null)
			})
			const appended =
				registered === null ? null : this.recordingAppends.get(registered)
			if (!appended) throw this.recordingEvidenceUnavailable()
			await appended
		} finally {
			if (registered !== null) this.recordingAppends.delete(registered)
		}
	}

	/** Fail closed: a throwing port refuses. Fixed text; the id is not echoed. */
	private refuseIfHoldsKept(id: string): void {
		const port = this.deps.recordingProtection
		if (!port) return
		// WG10 req 1.5: any merge alias holding a kept key counts (fail closed).
		const holds = holdsKeptWithAliases(port, a => this.store.aliasesOf(a), id)
		if (holds)
			throw new ScannerApiError(
				"Discovery holds kept recordings",
				SCANNER_DISCOVERY_HOLDS_KEPT_CODE,
				409,
			)
	}

	private recordingCleanupPending(): ScannerApiError {
		return new ScannerApiError(
			"Scanner evidence cleanup is pending",
			"SCANNER_EVIDENCE_CLEANUP_PENDING",
			503,
		)
	}

	private recordingEvidenceUnavailable(): ScannerApiError {
		return new ScannerApiError(
			"Scanner recording evidence is unavailable",
			"SCANNER_EVIDENCE_UNAVAILABLE",
			503,
		)
	}

	/** WG10 req 1.6: as `maintenance` does for pruned ids (kept holders are never evicted). */
	private readonly onStoreEvicted = (evicted: Discovery[]): void => {
		for (const discovery of evicted) {
			this.lastConfirm.delete(discovery.id)
			this.knownProtocols.forget(discovery.id)
			// the store stamped each copy with the revision of its removal
			this.emitDiscovery({ change: "deleted", discovery })
		}
		this.dirty = true
		this.track(
			(async () => {
				let failed = 0
				for (const discovery of evicted)
					await this.evidence.removeDiscovery(discovery.id).catch(() => {
						failed++
					})
				if (failed > 0)
					this.log.warn({ failed }, "Removing evicted evidence failed")
			})(),
			"Removing evicted evidence failed",
		)
	}

	private readonly onStoreChange = (
		id: string,
		change: StoreChange,
		mergedIds?: readonly string[],
	): void => {
		// WG11 req 1.7: a deleted discovery drops its known-protocol miss count. A merge reports
		// the merged-away discovery as `deleted` and the survivor (which keeps its count) as `merged`.
		if (change === "deleted") this.knownProtocols.forget(id)
		// WG2: eviction and age pruning never remove a lockout, and operator deletion
		// replans itself; a merge can move one (the survivor inherits `lockout`), so only a
		// locked survivor schedules a replan (no-op when no job's lockout list changes).
		if (change === "merged" && this.store.get(id)?.operator?.lockout === true)
			this.scheduleLockoutReplan()
		const absorbed = mergedIds === undefined ? undefined : [...mergedIds]
		if (this.ingestChanges) {
			this.ingestChanges.push([id, change, absorbed])
			return
		}
		this.emitDiscoveryChange(id, change, [], absorbed)
	}

	private emitDiscoveryChange(
		id: string,
		change: StoreChange,
		jobHits: ScanJobHit[],
		mergedIds?: readonly string[],
	): void {
		if (change === "transient") return
		const discovery = this.store.get(id)
		if (!discovery) return
		this.emitDiscovery({
			change,
			discovery,
			...(jobHits.length > 0 ? { jobHits } : {}),
			...(change === "merged" && mergedIds !== undefined
				? { mergedIds: [...mergedIds] }
				: {}),
		})
	}

	/**
	 * Band inspection UX req 3.3: every `discovery` event carries the store's epoch and the
	 * revision of its change: `revision` when given (a removal), else the record's own.
	 */
	private stampDiscoveryEvent(
		data: ScannerDiscoveryEventData,
		revision?: number,
	): ScannerDiscoveryEventData {
		return {
			...data,
			revision:
				revision ?? data.discovery.revision ?? this.store.currentRevision(),
			storeEpoch: this.store.storeEpoch,
		}
	}

	private emitDiscovery(
		data: ScannerDiscoveryEventData,
		revision?: number,
	): void {
		this.emit("discovery", this.stampDiscoveryEvent(data, revision))
	}

	/** Never rejects (a failed write is logged). */
	private async persistJobs(): Promise<void> {
		if (!this.configLoaded) return
		// Identify jobs are never persisted: a 15 s question does not survive a restart (§ 10.8).
		const persisted = [...this.jobs.values()].filter(
			r => !r.passive && r.spec.kind !== "identify",
		)
		const jobs: PersistedJob[] = persisted.map(r => {
			const lease = this.persistedLeases.get(r.spec.sourceId)
			return {
				id: r.id,
				spec: r.spec,
				rawSpec: r.rawSpec,
				state: r.state,
				...(r.reason ? { reason: r.reason } : {}),
				createdAt: new Date(r.createdAt).toISOString(),
				updatedAt: new Date(r.updatedAt).toISOString(),
				...(lease && lease.jobId === r.id ? { lease } : {}),
			}
		})
		// H4 (S1-B final review, finding 1): the lease of a deleted job keeps its recovery record.
		const ids = new Set(persisted.map(r => r.id))
		const unattached = [...this.persistedLeases.values()].filter(
			l => !ids.has(l.jobId),
		)
		await this.persistence
			.writeJobs(jobs, unattached)
			.catch((err: unknown) => this.log.warn({ err }, "jobs.json write failed"))
	}

	/** Re-emits a job whose resume hold or preemptor changed while its state did not (SF1 req 4.3). */
	private emitResumeChange(record: JobRecord): void {
		const view = this.derivedView({
			...this.resumeStatus(record),
			...this.preemptedByOf(record),
		})
		if (this.resumeViews.get(record.id) === view) return
		this.resumeViews.set(record.id, view)
		this.emitJob(record)
	}

	private tick(): void {
		this.retryAnalog()
		if (this.consumerLifecycle.admissionSealed) return
		this.channelTaps?.tick()
		const now = this.now()
		for (const d of this.drivers.values()) {
			this.emitResumeChange(d.record)
			d.tick(now)
		}
		this.resumeIdleWaiters(now)
		// cpu- and budget-deferred probe requests start once the meter drops, not only when another probe stops
		this.probes.pump()
		this.recent = this.recent.filter(o => {
			const keep = (o.endedAt ?? now) > now - RECENT_KEEP_MS
			// a late replay decode still needs the span to stamp inside it.
			if (!keep && this.deps.iqCapture) this.rememberReplaySpan(o)
			return keep
		})
		if (now - this.lastStatusAt >= STATUS_EVERY_MS) {
			this.lastStatusAt = now
			this.emitStatus(false)
			this.emitProgressFor(null)
			this.track(this.checkPassiveCost(now), "Passive cost check failed")
		}
		if (this.dirty && now - this.lastSnapshotAt >= this.snapshotInterval())
			this.startSnapshot(now)
		if (
			!this.maintenanceInFlight &&
			now - this.lastMaintenanceAt >= MAINTENANCE_EVERY_MS
		) {
			this.lastMaintenanceAt = now
			this.maintenanceInFlight = true
			this.track(
				this.maintenance().finally(() => {
					this.maintenanceInFlight = false
				}),
				"Scanner maintenance failed",
			)
		}
	}

	/**
	 * Single-flight periodic snapshot: no second clone + stringify while one is being written. A
	 * failed write leaves the state dirty, so it is retried.
	 */
	private startSnapshot(now: number): void {
		if (!this.stateLoaded || this.snapshotInFlight) return
		this.lastSnapshotAt = now
		this.dirty = false
		this.snapshotRequested = false
		this.snapshotInFlight = true
		this.persistence
			.writeSnapshotOf(this.store)
			.then(
				() => {
					this.snapshotFailed = false
				},
				(err: unknown) => {
					// Refused journal lines rely on a later snapshot: retry.
					this.dirty = true
					this.snapshotFailed = true
					this.log.warn({ err }, "Snapshot write failed")
				},
			)
			.finally(() => {
				this.snapshotInFlight = false
			})
	}

	/**
	 * A journal hole (refused or failed lines) blocks every append, recording operations
	 * included, until a snapshot covers it: snapshot now instead of at the next 10 s interval,
	 * still single-flight and at most once per SNAPSHOT_REQUEST_MIN_MS (the tick picks a
	 * deferred request up), or per SNAPSHOT_EVERY_MS after a failed snapshot.
	 */
	private requestSnapshot(): void {
		this.dirty = true
		this.snapshotRequested = true
		const now = this.now()
		if (now - this.lastSnapshotAt >= this.snapshotInterval())
			this.startSnapshot(now)
	}

	/** A failing disk falls back to the periodic interval: no full-store stringify every second. */
	private snapshotInterval(): number {
		return this.snapshotRequested && !this.snapshotFailed
			? SNAPSHOT_REQUEST_MIN_MS
			: SNAPSHOT_EVERY_MS
	}

	/** Tick work stop() awaits (S1-B final review, finding 5). Never rejects. */
	private track(work: Promise<void>, failure: string): void {
		const run: Promise<void> = work
			.catch((err: unknown) => this.log.warn({ err }, failure))
			.finally(() => this.background.delete(run))
		this.background.add(run)
	}

	private async maintenance(): Promise<void> {
		const s = this.settings()
		await this.spectrum.persist()
		// § 8 storage.discoveryMaxAgeDays (never operator `keep` or `lockout`)
		const all = new Map(this.allDiscoveries({}).map(d => [d.id, d] as const))
		const pruned = this.store.pruneInactive(s.storage.discoveryMaxAgeDays)
		// band inspection UX req 3.3: one operation removed them all, at this revision
		const prunedAt = this.store.currentRevision()
		for (const id of pruned) {
			const discovery = all.get(id)
			all.delete(id)
			this.lastConfirm.delete(id)
			if (discovery)
				this.emitDiscovery({ change: "deleted", discovery }, prunedAt)
			await this.evidence
				.removeDiscovery(id)
				.catch((err: unknown) =>
					this.log.warn(
						{ err, discoveryId: id },
						"Removing pruned evidence failed",
					),
				)
		}
		if (pruned.length > 0) {
			this.dirty = true
			this.log.info(
				{ pruned: pruned.length, maxAgeDays: s.storage.discoveryMaxAgeDays },
				"Pruned inactive discoveries",
			)
		}
		const keep = new Set(
			[...all.values()].filter(d => d.operator?.keep).map(d => d.id),
		)
		await this.evidence
			.retention(keep)
			.catch((err: unknown) => this.log.warn({ err }, "Retention failed"))
		await this.captures
			.retention(s.storage.maxCapturesMb * 1024 * 1024)
			.catch((err: unknown) =>
				this.log.warn({ err }, "Capture retention failed"),
			)
		if (this.stateLoaded) {
			await this.persistence
				.pruneJournal({
					maxBytes: s.storage.maxJournalMb * 1024 * 1024,
					maxAgeDays: s.storage.maxAgeDays,
				})
				.catch((err: unknown) => this.log.warn({ err }, "Journal prune failed"))
		}
		this.disk = await this.evidence.diskState().catch((err: unknown) => {
			this.log.warn({ err }, "Free disk check failed")
			return this.disk
		})
	}

	/**
	 * § 10.7 / WG11 req 2 / WG15 DQ 8: the passive cost guard, on every status tick (1 s). A sole
	 * passive engine is judged on its whole utilization (WG11); a shared one on passive's marginal
	 * cost over a measured baseline, with the saturation and baseline-window rules of DQ 8.4.
	 */
	private async checkPassiveCost(now: number): Promise<void> {
		const limit =
			this.settings().passive.maxEngineUtilization ?? PASSIVE_COST_LIMIT_DEFAULT
		const sources = new Set<string>(this.spectrum.sourceIds())
		for (const sourceId of this.passiveDisabled.keys()) sources.add(sourceId)
		const consumers = this.spectrum.allocation().consumers
		for (const sourceId of sources) {
			const engine = this.spectrum.engine(sourceId)
			const worker = engine?.eluSample() ?? null
			const action = this.passiveGuard.tick(
				sourceId,
				{
					engine: engine ?? null,
					openedAt: engine ? this.spectrum.openedAt(sourceId) : null,
					consumers: consumers[sourceId] ?? null,
					sample:
						worker === null
							? null
							: {
									idle: worker.elu.idle,
									active: worker.elu.active,
									generation: worker.generation,
								},
					tracked: this.jobs.has(`passive-${sourceId}`),
				},
				now,
				limit,
			)
			if (action.kind === "none") continue
			if (action.kind === "disable") {
				this.passiveDisabled.set(sourceId, action.reason)
				this.log.warn(
					{ sourceId, row: action.result.row, value: action.result.value },
					"Passive scanning disabled: passive costs too much of the spectrum engine on this host",
				)
			} else if (action.kind === "measure") {
				this.passiveDisabled.set(sourceId, action.reason)
				this.log.info(
					{ sourceId },
					"Passive scanning paused for one minute to measure the spectrum engine without it",
				)
			} else {
				this.passiveDisabled.delete(sourceId)
				this.log.info(
					{ sourceId, why: action.why },
					"Passive scanning re-enabled",
				)
			}
			await this.refreshPassive()
		}
	}

	/** Engine state is never written when the persisted state could not be read at all. */
	private async writeEngineState(
		sourceId: string,
		state: EngineState,
	): Promise<void> {
		if (!this.configLoaded) return
		await this.persistence
			.writeEngine(sourceId, state)
			.catch((err: unknown) =>
				this.log.warn({ err, sourceId }, "Engine state write failed"),
			)
	}

	private stateUnavailable(): ScannerApiError {
		return new ScannerApiError(
			"The scanner state could not be read; sweeps and settings changes are unavailable until a restart reads it",
			"SCANNER_STATE_UNAVAILABLE",
			503,
		)
	}

	private allocatePort(): Promise<number> {
		return new Promise((resolve, reject) => {
			import("node:net").then(net => {
				const server = net.createServer()
				server.on("error", reject)
				server.listen(0, "127.0.0.1", () => {
					const address = server.address()
					const port = typeof address === "object" && address ? address.port : 0
					server.close(() => resolve(port))
				})
			}, reject)
		})
	}
}

/** A discovery id becomes a folder name: anything but the S1-A `DISCOVERY_ID` format is not found. */
function requireDiscoveryIdFormat(id: string): void {
	if (!DISCOVERY_ID.test(id))
		throw new ScannerApiError(
			`Discovery ${id} not found`,
			"SCANNER_DISCOVERY_NOT_FOUND",
			404,
		)
}

/** Tags each stored range edit with the locked identity of its range (SF1 R1 finding 1). */
function withIdentity(
	live: readonly ScanRangeLive[],
	ranges: readonly ScanRange[],
): StoredRangeLive[] {
	return live.map((entry, i) => {
		const range = ranges[i]
		return range
			? {
					...entry,
					startHz: range.startHz,
					endHz: range.endHz,
					...(range.bandplanId !== undefined
						? { bandplanId: range.bandplanId }
						: {}),
				}
			: { ...entry }
	})
}

interface StaleRangeLive {
	issue: PlanIssue
	dropped: unknown
	expected: unknown
	received: unknown
}

/** The preview's stale range-edit warning (`range-live-stale`), when there is one. */
function staleRangeLive(
	issues: readonly PlanIssue[],
): StaleRangeLive | undefined {
	const issue = issues.find(
		i =>
			i.code === "range-locked" && i.details?.["reason"] === "range-live-stale",
	)
	if (!issue?.details) return undefined
	return {
		issue,
		dropped: issue.details["dropped"],
		expected: issue.details["expected"],
		received: issue.details["received"],
	}
}

/**
 * SF1 req 4.1-4.2 (Property 11): the job holding a `paused(preempted-job)` job's source lease, as
 * the DTO's `preemptedBy`. Absent in every other state or reason, when nobody else holds the lease,
 * and when the holder is not a known job. Derived at read time, never persisted (4.3).
 */
export function preemptedByFor(
	record: Pick<JobRecord, "id" | "state" | "reason">,
	holderJobId: string | undefined,
	nameOf: (jobId: string) => string | null | undefined,
): Pick<ScanJob, "preemptedBy"> {
	if (
		record.state !== "paused" ||
		record.reason !== "preempted-job" ||
		holderJobId === undefined ||
		holderJobId === record.id
	)
		return {}
	const name = nameOf(holderJobId)
	return name === undefined ? {} : { preemptedBy: { jobId: holderJobId, name } }
}

/** WG2 req 12.2: the record's runtime lockout exclusions follow its current plan. */
function setLockouts(
	record: JobRecord,
	lockoutExclusions: LockoutExclusion[] | undefined,
): void {
	if (lockoutExclusions) record.lockoutExclusions = lockoutExclusions
	else delete record.lockoutExclusions
}

/** WG6 req 1.2: the record's runtime decoded-elsewhere ranges follow its current plan. */
function setDecodedElsewhere(
	record: JobRecord,
	decodedElsewhere: DecodedElsewhereRange[] | undefined,
): void {
	if (decodedElsewhere) record.decodedElsewhere = decodedElsewhere
	else delete record.decodedElsewhere
}

/** WG7 req 6.3: the record's runtime band-plan skip ranges follow its current plan. */
function setBandPlanSkips(
	record: JobRecord,
	bandPlanSkips: BandPlanSkipRange[] | undefined,
): void {
	if (bandPlanSkips) record.bandPlanSkips = bandPlanSkips
	else delete record.bandPlanSkips
}

/** Paused by a lease loss (§ 10.1 preempted-*): waits for the lease. */
function isPreempted(r: JobRecord): boolean {
	return (
		r.state === "paused" &&
		(r.reason === "preempted-job" ||
			r.reason === "preempted-operator" ||
			r.reason === "preempted-relay")
	)
}

/** One decoder run inside a probe. The request hold stays on the book, not here. */
interface ProbeModeTrial {
	order: number
	protocol: ScannerProtocol
	decoder: string
	output: boolean
	crcFailures: number
	confirmed: boolean
	/** Accepted identity. Replay's decoded outcome needs this, not only encryption. */
	identity: boolean
	/** The pool reported `replay-end` while this mode was the open one. */
	replayEnded: boolean
	/**
	 * Pool `confirming` or `following` for this mode. The pool emits `confirming`
	 * only after the decoder process exists. `starting` is before that.
	 */
	decoderStarted: boolean
	closed: boolean
}

/** Request-hold bookkeeping for markUndecoded, plus one trial per mode that started. */
interface ProbeTrialBook extends ProbeOutcome {
	modes: ProbeModeTrial[]
}

/** The mode a probe is starting. The pool reuses the probe id as it steps. */
function probeModeAt(req: ProbeRequest, index: number): ProbeMode | undefined {
	const modes = req.modes ?? probeModesFor(req.cls, req.protocols)
	return modes[index]
}

/**
 * A mode the pool stepped off has run its hold. A failure row still needs
 * `decoderStarted`: the step's predecessor is `confirming`, and a mode that
 * never reached it did not run.
 */
function completedModeOutcome(trial: ProbeModeTrial): ScannerTrialOutcome {
	if (trial.confirmed) return "decoded"
	if (!trial.decoderStarted) return "cancelled"
	if (trial.crcFailures > 0) return "crc-errors"
	if (trial.output) return "timeout"
	return "no-sync"
}

/**
 * Live stop keeps the request-hold gate, measured from the probe's first start.
 * Counts are this mode's. `no-sync`, `crc-errors` and `timeout` need this mode's
 * decoder process (`confirming` or `following`) and the hold elapsed. A mode
 * that never started is cancelled. A stop before the hold is cancelled.
 */
function liveStopOutcome(
	book: ProbeTrialBook,
	trial: ProbeModeTrial,
	now: number,
): ScannerTrialOutcome {
	if (trial.confirmed) return "decoded"
	if (!trial.decoderStarted) return "cancelled"
	const reason = undecodedForProbe(
		{
			startedAt: book.startedAt,
			holdMs: book.holdMs,
			output: trial.output,
			crcFailures: trial.crcFailures,
			confirmed: false,
		},
		now,
	)
	if (reason === "no-sync" || reason === "crc-errors" || reason === "timeout")
		return reason
	return "cancelled"
}

/**
 * A replay row follows the pool's clean end, not elapsed time. `replay-end`
 * is that end (decoded, no-sync, crc-errors, or timeout). A run that never
 * ends cleanly, including a grace release, is cancelled.
 */
function replayTrialOutcome(trial: ProbeModeTrial): ScannerTrialOutcome {
	if (!trial.replayEnded) return "cancelled"
	if (trial.identity) return "decoded"
	if (trial.crcFailures > 0) return "crc-errors"
	if (trial.output) return "timeout"
	return "no-sync"
}

function probeDecoderType(
	decoder: string | undefined,
): ScannerProbeDecoderType | undefined {
	if (
		decoder === "dsd-fme" ||
		decoder === "multimon-ng" ||
		decoder === "direwolf" ||
		decoder === "rtl433"
	)
		return decoder
	return undefined
}

/** Protocols a prior can be set on (every ScannerProtocol except the generic ones). */
const probeProtocols: readonly ScannerProtocol[] = [
	"analog-fm",
	"analog-am",
	"dmr",
	"p25p1",
	"p25p2",
	"nxdn48",
	"nxdn96",
	"ysf",
	"dstar",
	"dpmr",
	"pocsag",
	"flex",
	"aprs",
	"ism",
]
