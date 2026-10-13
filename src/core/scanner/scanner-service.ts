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
	ScannerDiscoveryEventData,
	ScannerEngineStatus,
	ScannerIdentifyRequest,
	ScannerProgressEventData,
	ScannerSettingsView,
	ScannerStatus,
	SpectrumSourceStatus,
} from "@wavekit/api-types"
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
import { classifySpectral, leakOrIntermod } from "./classify/classifier.js"
import { ScannerApiError } from "./errors.js"
import {
	CaptureRecorder,
	type CaptureCloseInfo,
} from "./evidence/capture-recorder.js"
import { CaptureStore } from "./evidence/capture-store.js"
import { ulid } from "./ids.js"
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
import {
	ProbePool,
	offsetTransport,
	probeModesFor,
	type ProbeRecordings,
	type ProbeRequest,
	type TransportStrategy,
} from "./probes/probe-pool.js"
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
	ScannerPersistence,
	type LoadedState,
	type PersistedJob,
	type PersistedLease,
	type RuntimeSettingsOverrides,
} from "./store/persistence.js"
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
} from "../spectrum/types.js"
import type {
	Classification,
	DecodeEvidence,
	Discovery,
	Hop,
	HopPlan,
	Identity,
	Impact,
	LockoutExclusion,
	NormalisedJobSpec,
	Observation,
	PlanIssue,
	PlanPreview,
	ScanJobSpec,
	ScanRange,
	ScannerConfidence,
	ScannerProtocol,
	ScannerSettings,
	UndecodedReason,
} from "./types.js"
import { AMBIENT_PAIR_MS } from "./types.js"

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

export interface ScannerServiceDeps {
	settings: ScannerSettings
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
}

const SNAPSHOT_EVERY_MS = 10_000
const MAINTENANCE_EVERY_MS = 5 * 60_000
const STATUS_EVERY_MS = 1_000
const RECENT_KEEP_MS = 10_000
const RECONFIRM_AFTER_MS = 15 * 60_000
/** Task 29 review, finding 6: bound on waiting for the source caps to show a restored tuning. */
const RESTORE_CAPS_TIMEOUT_MS = 1_000
const PASSIVE_COST_WINDOW_MS = 60_000
const PASSIVE_COST_LIMIT = 0.25
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
	private readonly now: () => number
	private readonly storageDir: string
	private readonly persistence: ScannerPersistence
	private readonly store: DiscoveryStore
	private readonly evidence: EvidenceStore
	private readonly arbiter: TunerArbiter
	private readonly probes: ProbePool
	private readonly ambient: AmbientEvidence
	/** Core spectrum service (engines, frames, occupancy); also served at /api/spectrum. */
	readonly spectrum: SpectrumService
	private readonly captures: CaptureStore
	private readonly recorder: CaptureRecorder
	private readonly jobs = new Map<string, JobRecord>()
	private readonly drivers = new Map<string, JobDriver>()
	/** WG2 req 13: per-job hit statistics (in memory; reset on start, dropped with the job). */
	private readonly hits = new Map<string, JobHits>()
	/** Store changes raised inside one ingest, emitted after its hits are counted (WG2 req 13.2). */
	private ingestChanges: [string, StoreChange][] | null = null
	/** § 10.7: engine instances the passive cost rule already judged (once, at openedAt + 60 s). */
	private readonly costChecked = new WeakSet<SpectrumEngine>()
	private readonly live = new Map<string, LiveObservation>()
	private recent: LiveObservation[] = []
	private readonly bestPsd = new Map<
		string,
		{ startHz: number; binHz: number; bins: number[]; snrDb: number }
	>()
	private readonly lastConfirm = new Map<string, number>()
	private readonly persistedLeases = new Map<string, PersistedLease>()
	private readonly bootResume = new Map<string, string[]>()
	private readonly passiveDisabled = new Map<string, string>()
	private readonly probeOutcomes = new Map<string, ProbeOutcome>()
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
	private lastMaintenanceAt = 0
	private lastStatusAt = 0
	private lastStatusJson = ""
	private startupAttempted = false
	private started = false
	private startPromise: Promise<void> | null = null

	constructor(private readonly deps: ScannerServiceDeps) {
		super()
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
				// From the open, so the pool's lag guard sees every stream boundary (Task 34).
				engineCreated: (sourceId, engine) => {
					// This hook runs BEFORE engine.start; revoke queued capabilities before extra work.
					this.channelEngineStarts.set(sourceId, engine)
					this.invalidateChannelAdmission()
					this.probes.watchEngine(sourceId, engine)
				},
			})
			this.store = new DiscoveryStore({
				maxDiscoveries: deps.settings.storage.maxDiscoveries,
				now: this.now,
				newId: () => ulid(this.now()),
				minSurfaceBlocks: deps.settings.detection.minSurfaceBlocks,
				rasters: (sourceId, hz) => this.rastersAt(sourceId, hz),
			})
			this.evidence = new EvidenceStore({
				dir: this.storageDir,
				caps: storageCaps(deps.settings),
				logger: deps.logger,
				now: this.now,
				isDiscoveryLive: id => this.store.get(id) !== undefined,
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
				transports: deps.transports ?? [offsetTransport],
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
		this.startPromise = this.startUp().catch((err: unknown) => {
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
		this.ambient.on("evidence", this.onAmbientEvidence)
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

	sealAdmission(
		_reason: "shutdown" | "source-loss" | "provider-change" = "shutdown",
	): void {
		this.consumerLifecycle.sealAdmission()
		this.started = false
		if (this.timer) clearInterval(this.timer)
		this.timer = null
		this.channelTaps?.sealAdmission()
		this.probes?.sealAdmission()
	}

	beginStop(): Readonly<ScannerStopHandle> {
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
		const handle = this.beginStop()
		await handle.producerSettled.catch(() => undefined)
		await this.finalizeStopNative()
		await handle.completed
	}

	/** EACH independent actual component settles before an aggregate failure; no native66 wait. */
	private async cleanupServiceComponents(): Promise<CleanupOutcome> {
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
			await attempt(() => this.persistence.writeSnapshot(this.store.snapshot()))
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
			if (this.probes) await this.probes.destroy()
		})
		return this.probeComponentDrain
	}

	// === status and settings ===

	status(): ScannerStatus {
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
	} {
		return this.store.list(filter)
	}

	getDiscovery(id: string): Discovery | undefined {
		return this.store.get(id)
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
		const d = this.store.setOperator(id, patch)
		if (patch.lockout) {
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

	/**
	 * WG2 req 12: replans every live sweep job on one of `sourceIds` whose lockout exclusions
	 * changed, through the same driver replan a live exclusion PATCH uses. The stored spec is not
	 * touched (12.2), so nothing is persisted.
	 */
	private async replanLockouts(sourceIds: readonly string[]): Promise<void> {
		const ctx = this.previewContext()
		const touched = new Set<string>()
		const retune = new Set<string>()
		for (const record of [...this.jobs.values()]) {
			if (
				record.passive ||
				record.spec.mode !== "sweep" ||
				record.spec.kind === "identify" ||
				isTerminal(record.state) ||
				!sourceIds.includes(record.spec.sourceId)
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
			if (
				JSON.stringify(next.lockoutExclusions ?? []) ===
				JSON.stringify(record.lockoutExclusions ?? [])
			)
				continue
			setLockouts(record, next.lockoutExclusions)
			record.updatedAt = this.now()
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
				await this.evidence.removeDiscovery(id)
				return true
			} catch {
				throw this.recordingCleanupPending()
			}
		}
		// Fence producer intake before the deletion mutation can notify reentrant readers.
		for (const owner of this.channelRecordingOwners.values()) {
			if (this.store.discoveryIdOf(owner.observationId) === id) {
				owner.producer?.cancel("discovery-deleted")
				owner.tap.cancel()
			}
		}
		if (!this.store.delete(id)) return false
		this.lastConfirm.delete(id)
		this.emit("discovery", {
			change: "deleted",
			discovery,
		} satisfies ScannerDiscoveryEventData)
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
		this.updateRing(sourceId)
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
		if (
			closing ||
			(now - live.startedAt >= 1000 && now - live.lastIngestAt >= 1000)
		) {
			this.ingest(live, track, endReason)
		}
		const needs = !synthetic && !late && this.needsConfirm(live, track)
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
		this.rememberClosed(track.trackId)
		for (const jobId of live.jobIds)
			this.drivers.get(jobId)?.onTrackClosed(track.trackId)
		this.probes.trackClosed(track.trackId)
		const closed = live
		this.recorder.close(live.observationId, track.lastSample, () =>
			this.captureCloseInfo(closed, track),
		)
		this.live.delete(track.trackId)
		live.endedAt = now
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
	): void {
		const outer = this.ingestChanges
		const changes: [string, StoreChange][] = []
		this.ingestChanges = changes
		let reported = new Map<string, Set<string>>()
		try {
			reported = this.ingestTracked(live, track, endReason)
		} finally {
			this.ingestChanges = outer
			for (const [id, change] of changes) {
				const jobIds = reported.get(id)
				this.emitDiscoveryChange(
					id,
					change,
					jobIds ? this.jobHitsOf([...jobIds], id) : [],
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
	): Map<string, Set<string>> {
		const reported = new Map<string, Set<string>>()
		const now = this.now()
		const sweep = live.jobIds.some(
			id => this.jobs.get(id)?.spec.mode === "sweep",
		)
		const res = this.store.ingest({
			id: live.observationId,
			sourceId: live.sourceId,
			jobIds: live.jobIds,
			track,
			classification: live.classification,
			startedAt: live.startedAt,
			...(endReason ? { endedAt: now, endReason } : {}),
			...(live.hopIndex !== undefined ? { hopIndex: live.hopIndex } : {}),
			singleBlockSurfacingAllowed: sweep,
		})
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
				this.hitsOf(jobId).record(
					a.observationId,
					a.discoveryId,
					now,
					a.created,
				)
			}
			report(a.discoveryId, a.jobIds)
		}
		live.discoveryId = res.discoveryId
		live.decoded = this.store.get(res.discoveryId)?.confidence === "decoded"
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
		return { priors, protocols }
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

	private needsConfirm(live: LiveObservation, track: TrackSnapshot): boolean {
		// § 10.8: an active identify job owns the confirmation of the tracks it is identifying.
		const identifying = live.jobIds.some(id => {
			const d = this.drivers.get(id)
			return (
				d instanceof IdentifyRunner && d.owns(live.sourceId, track.centreHz)
			)
		})
		if (identifying) return false
		if (
			track.flags.truncated ||
			track.flags.edge ||
			track.flags.iqImage ||
			track.flags.spur
		)
			return false
		const d = live.discoveryId ? this.store.get(live.discoveryId) : undefined
		if (d?.operator?.lockout) return false
		if (
			probeModesFor(
				live.classification.class,
				this.protocolsFor(live, track.centreHz),
			).length === 0
		)
			return false
		if (!d || d.confidence !== "decoded") return true
		const last = this.lastConfirm.get(d.id) ?? 0
		return (
			this.now() - last >= RECONFIRM_AFTER_MS ||
			d.class !== live.classification.class
		)
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
		}
		const live = this.findObservation(req.observationId)
		if (!live || ev.epoch !== live.epoch) return
		live.probeIds.add(probeId)
		this.applyEvidence(live, ev)
		for (const jobId of live.jobIds)
			this.drivers.get(jobId)?.onEvidence(probeId, ev)
	}

	private readonly onAmbientEvidence = (e: AmbientEvidenceEvent): void => {
		const now = this.now()
		const candidates = [...this.live.values(), ...this.recent].filter(o => {
			const t = o.lastTrack
			if (o.sourceId !== e.sourceId || !t) return false
			if (Math.abs(t.centreHz - e.hz) > Math.max(1500, t.obwHz / 2))
				return false
			return (
				e.ev.at >= o.startedAt - AMBIENT_PAIR_MS &&
				e.ev.at <= (o.endedAt ?? now) + AMBIENT_PAIR_MS
			)
		})
		for (const live of candidates) this.applyEvidence(live, e.ev)
	}

	private applyEvidence(live: LiveObservation, ev: DecodeEvidence): void {
		if (live.evidenceDeleted) return
		if (ev.metadata.talkgroups?.[0]) live.talkgroup = ev.metadata.talkgroups[0]
		if (ev.metadata.sources?.[0]) live.source = ev.metadata.sources[0]
		if (ev.encrypted) live.encrypted = true
		if (!live.discoveryId && live.lastTrack) this.ingest(live, live.lastTrack)
		const discoveryId = live.discoveryId
		if (!discoveryId) return
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
		this.store.applyEvidence(discoveryId, ev, cap ? { cap } : {})
		// The decode may have merged the discovery (identity key): follow the survivor.
		const survivor = this.store.discoveryIdOf(live.observationId) ?? discoveryId
		live.discoveryId = survivor
		this.dirty = true
		if (!ev.identity || this.store.get(survivor)?.confidence !== "decoded")
			return
		live.decoded = true
		if (accepted && live.lastTrack)
			live.acceptedIdentity = {
				identity: ev.identity,
				stream: live.lastTrack.stream,
				epoch: ev.epoch,
			}
		this.recorder.decoded(live.observationId)
		this.lastConfirm.set(survivor, this.now())
		if (!wasDecoded) this.updateFrequencyError(live.sourceId, { rekey: true })
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
	): void => {
		// "starting" occurs synchronously before launch's first allocation/effect.
		if (state === "starting" || state === "stopped")
			this.invalidateChannelAdmission()
		// Mode stepping re-emits "starting" for the same probe: keep the first start (the hold covers all modes).
		if (state === "starting" && !this.probeOutcomes.has(probeId)) {
			this.probeOutcomes.set(probeId, {
				startedAt: this.now(),
				holdMs: req.holdMs,
				output: false,
				crcFailures: 0,
				confirmed: false,
			})
		}
		if (state === "stopped") {
			const outcome = this.probeOutcomes.get(probeId)
			this.probeOutcomes.delete(probeId)
			const reason = outcome ? undecodedForProbe(outcome, this.now()) : null
			const live = reason ? this.findObservation(req.observationId) : undefined
			if (live && reason) this.markUndecoded(live, reason)
		}
		this.emitProgressFor(null)
	}

	private findObservation(observationId: string): LiveObservation | undefined {
		for (const o of this.live.values())
			if (o.observationId === observationId) return o
		return this.recent.find(o => o.observationId === observationId)
	}

	private ambientTarget(decoderId: string): AmbientTarget | null {
		const cfg = this.deps.decoderConfigs.find(c => c.id === decoderId)
		if (!cfg) return null
		const sourceId = cfg.sourceId ?? this.deps.routing.getDefaultSourceId()
		if (!sourceId) return null
		// The NXDN flavour of a dsd-fme decoder comes from its mode (Task 34 carry).
		const nxdn =
			cfg.type === "dsd-fme"
				? cfg.options["mode"] === "nxdn48"
					? ("nxdn48" as const)
					: ("nxdn96" as const)
				: undefined
		const withNxdn = (hz: number): AmbientTarget =>
			nxdn ? { sourceId, hz, nxdn } : { sourceId, hz }
		const listed =
			cfg.frequencies?.[0] ??
			(typeof cfg.options["frequency"] === "number"
				? cfg.options["frequency"]
				: undefined)
		if (listed !== undefined) return withNxdn(listed)
		const centre = this.deps.sources.getCaps(sourceId)?.centerFreq
		if (centre === undefined) return null
		const offset =
			typeof cfg.options["offsetHz"] === "number" ? cfg.options["offsetHz"] : 0
		return withNxdn(centre + offset)
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
			autoResumeReady: () => this.autoResumeReady(record),
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
			discoveryCounts: jobId => this.discoveryCounts(jobId),
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
		})
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
			priorsAt: hz => priorsFor(ranges, hz),
			format: sourceId =>
				this.identifyEngine(sourceId)?.format ??
				this.deps.sources.getCaps(sourceId)?.format ??
				"",
			// [S2] Task 40 replaces this with Boolean(this.deps.channels): parallel channel trials.
			channelizer: () => false,
			settings: () => this.settings(),
			emit: data => this.emit("identify", data),
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
	 * Explicit resume of a preempted sweep (fix round 2): on the arbitration chain, at once (no idle
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
		let failed = false
		try {
			;({ plan, lockoutExclusions } = planJob(pj.spec, this.previewContext()))
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

	private discoveryCounts(jobId: string): Record<ScannerConfidence, number> {
		const counts = { activity: 0, candidate: 0, classified: 0, decoded: 0 }
		for (const d of this.allDiscoveries({ jobId })) counts[d.confidence] += 1
		return counts
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
		const appended = this.persistence.append(entry)
		if (this.recordingAppends.has(entry))
			this.recordingAppends.set(entry, appended)
		void appended.catch((err: unknown) =>
			this.log.warn({ err }, "Journal append failed"),
		)
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

	private readonly onStoreChange = (id: string, change: StoreChange): void => {
		if (this.ingestChanges) {
			this.ingestChanges.push([id, change])
			return
		}
		this.emitDiscoveryChange(id, change, [])
	}

	private emitDiscoveryChange(
		id: string,
		change: StoreChange,
		jobHits: ScanJobHit[],
	): void {
		if (change === "transient") return
		const discovery = this.store.get(id)
		if (!discovery) return
		this.emit("discovery", {
			change,
			discovery,
			...(jobHits.length > 0 ? { jobHits } : {}),
		} satisfies ScannerDiscoveryEventData)
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
		this.recent = this.recent.filter(
			o => (o.endedAt ?? now) > now - RECENT_KEEP_MS,
		)
		if (now - this.lastStatusAt >= STATUS_EVERY_MS) {
			this.lastStatusAt = now
			this.emitStatus(false)
			this.emitProgressFor(null)
			this.track(this.checkPassiveCost(now), "Passive cost check failed")
		}
		if (
			this.stateLoaded &&
			this.dirty &&
			now - this.lastSnapshotAt >= SNAPSHOT_EVERY_MS
		) {
			this.lastSnapshotAt = now
			this.dirty = false
			this.persistence
				.writeSnapshot(this.store.snapshot())
				.catch((err: unknown) =>
					this.log.warn({ err }, "Snapshot write failed"),
				)
		}
		if (now - this.lastMaintenanceAt >= MAINTENANCE_EVERY_MS) {
			this.lastMaintenanceAt = now
			this.track(this.maintenance(), "Scanner maintenance failed")
		}
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
		// § 8 storage.discoveryMaxAgeDays (never operator `keep`)
		const all = new Map(this.allDiscoveries({}).map(d => [d.id, d] as const))
		const pruned = this.store.pruneInactive(s.storage.discoveryMaxAgeDays)
		for (const id of pruned) {
			const discovery = all.get(id)
			all.delete(id)
			this.lastConfirm.delete(id)
			if (discovery)
				this.emit("discovery", {
					change: "deleted",
					discovery,
				} satisfies ScannerDiscoveryEventData)
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
	 * § 10.7: passive off for a source whose engine costs > 25 % of a core over its first minute.
	 * Evaluated once per engine instance, at openedAt + 60 s (later load from sweeps never counts).
	 */
	private async checkPassiveCost(now: number): Promise<void> {
		for (const sourceId of this.spectrum.sourceIds()) {
			const openedAt = this.spectrum.openedAt(sourceId)
			const engine = this.spectrum.engine(sourceId)
			if (
				!engine ||
				openedAt === null ||
				this.costChecked.has(engine) ||
				now - openedAt < PASSIVE_COST_WINDOW_MS
			)
				continue
			this.costChecked.add(engine)
			if (this.passiveDisabled.has(sourceId)) continue
			if (!this.jobs.has(`passive-${sourceId}`)) continue
			const utilization = engine.utilization()
			if (utilization === null || utilization <= PASSIVE_COST_LIMIT) continue
			this.passiveDisabled.set(
				sourceId,
				`engine-cpu ${(utilization * 100).toFixed(0)} % of a core`,
			)
			this.log.warn(
				{ sourceId, utilization },
				"Passive scanning disabled: spectrum engine too costly on this host",
			)
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

/** Paused by a lease loss (§ 10.1 preempted-*): waits for the lease. */
/** WG2 req 12.2: the record's runtime lockout exclusions follow its current plan. */
function setLockouts(
	record: JobRecord,
	lockoutExclusions: LockoutExclusion[] | undefined,
): void {
	if (lockoutExclusions) record.lockoutExclusions = lockoutExclusions
	else delete record.lockoutExclusions
}

function isPreempted(r: JobRecord): boolean {
	return (
		r.state === "paused" &&
		(r.reason === "preempted-job" ||
			r.reason === "preempted-operator" ||
			r.reason === "preempted-relay")
	)
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
