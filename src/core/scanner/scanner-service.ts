/**
 * Composition root of the scanner (spec § 3): engines per source, the
 * arbiter, the probe pool, ambient evidence, the discovery/evidence stores
 * and persistence, job drivers, passive jobs, runtime settings, boot restore
 * and shutdown. Routes and WS (Tasks 36, 37) use only the public methods and
 * events listed in the plan. Events: "job", "progress", "activity",
 * "discovery", "status" and "identify"(ScannerIdentifyEventData, Task 35a).
 */
import { EventEmitter } from "node:events"
import { readdir, rm } from "node:fs/promises"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { ZodError } from "zod"
import type {
	Bandplan as BandplanDto,
	ScanJob,
	ScannerActivityEventData,
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
import type { DigitalVoiceService } from "../digital-voice.js"
import type { LiveDemodulator } from "../live-demodulator.js"
import type { SourceFanoutRouter } from "../source-fanout-router.js"
import type { SourceConfig, SourceManager } from "../source-manager.js"
import type { TunerController } from "../tuner-controller.js"
import { sourceScannerConfig } from "../../config.js"
import {
	bandplansFor,
	priorsFor,
	type BandRegionCode,
} from "./bandplan/index.js"
import { classifySpectral, leakOrIntermod } from "./classify/classifier.js"
import { ScannerApiError } from "./errors.js"
import { ulid } from "./ids.js"
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
	planForSpec,
	previewPlan,
	toJobSpec,
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
	NormalisedJobSpec,
	Observation,
	PlanIssue,
	PlanPreview,
	ScanJobSpec,
	ScannerConfidence,
	ScannerProtocol,
	ScannerSettings,
	UndecodedReason,
} from "./types.js"

export interface ScannerServiceDeps {
	settings: ScannerSettings
	sourceConfigs: readonly SourceConfig[]
	decoderConfigs: readonly DecoderConfig[]
	region: BandRegionCode
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
	hostCentre?: HostCentreReader
}

const SNAPSHOT_EVERY_MS = 10_000
const MAINTENANCE_EVERY_MS = 5 * 60_000
const STATUS_EVERY_MS = 1_000
const RECENT_KEEP_MS = 10_000
const RECONFIRM_AFTER_MS = 15 * 60_000
const RESTORE_TIMEOUT_MS = 2_000
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
		settings: {},
		engines: {},
		droppedLines: 0,
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

function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
	return new Promise(resolve => {
		const timer = setTimeout(() => resolve(fallback), ms)
		timer.unref()
		p.then(
			v => {
				clearTimeout(timer)
				resolve(v)
			},
			() => {
				clearTimeout(timer)
				resolve(fallback)
			},
		)
	})
}

export class ScannerService extends EventEmitter {
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
	private readonly jobs = new Map<string, JobRecord>()
	private readonly drivers = new Map<string, JobDriver>()
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
	private started = false

	constructor(private readonly deps: ScannerServiceDeps) {
		super()
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
				writeOccupancy: (sourceId, state) =>
					this.persistence.writeOccupancy(sourceId, state),
				loadOccupancy: sourceId => this.persistence.loadOccupancy(sourceId),
			},
			logger: deps.logger,
			now: this.now,
			engineHost: deps.engineHost ?? "thread",
			...(deps.hostCentre ? { hostCentre: deps.hostCentre } : {}),
			// From the open, so the pool's lag guard sees every stream boundary (Task 34).
			engineCreated: (sourceId, engine) =>
				this.probes.watchEngine(sourceId, engine),
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
		})
		this.arbiter = new TunerArbiter({
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
	}

	get enabled(): boolean {
		return this.settings().enabled
	}

	settings(): ScannerSettings {
		return this.effective.settings
	}

	// === lifecycle ===

	async start(): Promise<void> {
		if (this.started) return
		this.started = true
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
		this.store.restore({
			discoveries: loaded.discoveries,
			observations: loaded.observations,
			corrections: loaded.corrections,
		})
		for (const entry of loaded.entries) this.store.replay(entry)
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
		// Probes are never persisted: recordings/dv/probe-* folders are crash leftovers (before any probe starts).
		await this.evidence
			.removeOrphanProbeDirs()
			.catch((err: unknown) =>
				this.log.warn({ err }, "Orphaned probe folder cleanup failed"),
			)
		this.store.on("mutation", this.onStoreMutation)
		this.store.on("change", this.onStoreChange)
		this.spectrum.on("pipeline", this.onSpectrumPipeline)
		this.spectrum.on("stream", this.onEngineStream)
		this.spectrum.on("released", this.onEngineReleased)
		await this.spectrum.start()
		this.arbiter.on("lease-lost", this.onLeaseLost)
		this.arbiter.on("source-down", this.onSourceDown)
		this.arbiter.on("source-up", this.onSourceUp)
		this.arbiter.on("recovered", this.onRecovered)
		this.deps.sources.on("source-removed", this.onSourceRemoved)
		// Boot-time caps are absent until SourceManager.connect(): passive jobs are (re)built when a source becomes usable.
		this.deps.sources.on("connected", this.onSourceAvailable)
		this.deps.sources.on("caps-changed", this.onSourceAvailable)
		this.probes.on("evidence", this.onProbeEvidence)
		this.probes.on("recordings", this.onProbeRecordings)
		this.probes.on("probe-state", this.onProbeState)
		this.ambient.on("evidence", this.onAmbientEvidence)
		const leases = loaded.jobs.flatMap(j => (j.lease ? [j.lease] : []))
		for (const lease of leases) this.persistedLeases.set(lease.sourceId, lease)
		this.arbiter.recoverPersistedLeases(leases)
		for (const pj of loaded.jobs) await this.restoreJob(pj)
		this.disk = await this.evidence.diskState().catch((err: unknown) => {
			this.log.warn({ err }, "Free disk check failed")
			return "ok" as const
		})
		// Disabled: jobs are listed (paused core-restart) but nothing resumes, ticks or touches the tuner.
		if (this.settings().enabled) {
			await this.ensurePassiveJobs()
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

	async stop(): Promise<void> {
		if (!this.started) return
		this.started = false
		if (this.timer) clearInterval(this.timer)
		this.timer = null
		this.deps.sources.off("connected", this.onSourceAvailable)
		this.deps.sources.off("caps-changed", this.onSourceAvailable)
		await this.passiveChain
		await Promise.all([...this.drivers.values()].map(d => d.idle()))
		await Promise.all(this.arbitrations.values())
		for (const sourceId of this.spectrum.sourceIds()) {
			const lease = this.arbiter.holder(sourceId)
			if (lease) {
				const res = await withTimeout(
					this.arbiter.release(lease, { restore: true }),
					RESTORE_TIMEOUT_MS,
					{ restored: [], unrestorable: [] },
				)
				// Decoder holds are released below (dispose): let them resume on the restored tuning.
				if (res.restored.length > 0)
					await this.awaitRestoredCaps(sourceId, lease.snapshot, res.restored)
			}
		}
		await this.probes.destroy()
		// One failing driver never stops the shutdown before the engines, the snapshot and jobs.json.
		for (const d of this.drivers.values())
			await d
				.dispose()
				.catch((err: unknown) =>
					this.log.warn({ err, jobId: d.record.id }, "Disposing a job failed"),
				)
		this.ambient.stop()
		this.deps.cpuMeter?.stop()
		await this.spectrum.stop()
		this.spectrum.off("pipeline", this.onSpectrumPipeline)
		this.spectrum.off("stream", this.onEngineStream)
		this.spectrum.off("released", this.onEngineReleased)
		this.arbiter.dispose()
		this.deps.sources.off("source-removed", this.onSourceRemoved)
		if (this.stateLoaded) {
			await this.persistence
				.writeSnapshot(this.store.snapshot())
				.catch((err: unknown) =>
					this.log.warn({ err }, "Snapshot write failed"),
				)
		}
		await this.persistJobs()
		this.log.info("Scanner stopped")
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
		return bandplansFor(this.deps.region)
	}

	recordMeasurement(m: Partial<PreviewMeasured>): void {
		this.measured = { ...this.measured, ...m }
	}

	// === jobs ===

	preview(spec: ScanJobSpec): PlanPreview {
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
		}
		const driver = this.createDriver(record)
		this.jobs.set(record.id, record)
		this.drivers.set(record.id, driver)
		try {
			await driver.start()
		} catch (err) {
			this.jobs.delete(record.id)
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
		]
		const merged: ScanJobSpec = { ...toJobSpec(record.spec) }
		for (const key of allowed)
			if (patch[key] !== undefined) Object.assign(merged, { [key]: patch[key] })
		const preview = this.preview(merged)
		this.rejectErrors(preview.issues)
		record.rawSpec = { ...record.rawSpec, ...merged }
		record.issues = preview.issues
		record.updatedAt = this.now()
		this.requireDriver(id).replan(preview.spec, preview.plan)
		this.updateMasks(record.spec.sourceId)
		await this.persistJobs()
		const job = this.toDto(record)
		this.emit("job", job)
		return { job, plan: preview.plan, issues: preview.issues }
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
				{ holderJobId: holder.jobId },
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
		try {
			await driver.start()
		} catch (err) {
			this.jobs.delete(record.id)
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
		return d
	}

	async deleteDiscovery(id: string): Promise<boolean> {
		requireDiscoveryIdFormat(id)
		const discovery = this.store.get(id)
		if (!discovery || !this.store.delete(id)) return false
		this.emit("discovery", {
			change: "deleted",
			discovery,
		} satisfies ScannerDiscoveryEventData)
		await rm(join(this.storageDir, "evidence", id), {
			recursive: true,
			force: true,
		})
		await rm(join(this.storageDir, "recordings", "dv", id), {
			recursive: true,
			force: true,
		})
		await rm(join(this.storageDir, "recordings", "analog", id), {
			recursive: true,
			force: true,
		})
		return true
	}

	recordingPath(recordingId: string): string | null {
		return this.evidence.recordingPath(recordingId)
	}

	async evidencePath(
		discoveryId: string,
		kind: "psd" | "iq",
	): Promise<string | null> {
		// Before any path join: an id is never a path fragment (Task 36 review).
		requireDiscoveryIdFormat(discoveryId)
		const dir = join(this.storageDir, "evidence", discoveryId)
		if (kind === "psd") {
			const path = join(dir, "psd.json")
			return existsSync(path) ? path : null
		}
		const files = await readdir(dir).catch(() => [] as string[])
		const iq = files
			.filter(f => f.startsWith("iq-") && f.endsWith(".cu8"))
			.sort()
		return iq.length > 0 ? join(dir, iq[iq.length - 1]!) : null
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
		const ranges = specs.flatMap(s => s.ranges)
		engine.setMasks({
			exclusions: intersectRanges(specs.map(s => s.exclusions)),
			cfarRanges: ranges.map(r => ({ startHz: r.startHz, endHz: r.endHz })),
			burstRanges: ranges
				.filter(r => (r.protocols ?? []).some(p => BURST_PROTOCOLS.has(p)))
				.map(r => ({ startHz: r.startHz, endHz: r.endHz })),
			rasters: ranges.flatMap(r => r.rasters ?? []),
			obwHz: [...new Set(ranges.flatMap(r => r.obwHz ?? []))],
			// § 6.2: in-window while no sweep lease holds the source (truncated segments → `edge`).
			inWindow: this.arbiter.holder(sourceId) === undefined,
		})
	}

	private rastersAt(sourceId: string, hz: number) {
		return [...this.jobs.values()]
			.filter(j => j.spec.sourceId === sourceId && !isTerminal(j.state))
			.flatMap(j => j.spec.ranges)
			.filter(r => hz >= r.startHz && hz <= r.endHz)
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
		if (!closing) return
		this.rememberClosed(track.trackId)
		for (const jobId of live.jobIds)
			this.drivers.get(jobId)?.onTrackClosed(track.trackId)
		this.probes.trackClosed(track.trackId)
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

	private ingest(
		live: LiveObservation,
		track: TrackSnapshot,
		endReason?: ObservationEndReason,
	): void {
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
			return
		}
		if (live.discoveryId === null) {
			for (const id of live.jobIds) {
				const r = this.jobs.get(id)
				if (r) r.counts.observations += 1
			}
		}
		live.discoveryId = res.discoveryId
		live.decoded = this.store.get(res.discoveryId)?.confidence === "decoded"
		if (live.undecodedReason) {
			this.markUndecoded(live, live.undecodedReason)
			delete live.undecodedReason
		}
		this.dirty = true
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
		const all = specs.length === 0 || specs.some(s => s.protocols.length === 0)
		const protocols = all ? [] : [...new Set(specs.flatMap(s => s.protocols))]
		const priors: Partial<Record<ScannerProtocol, number>> = {}
		const bandProtocols = specs
			.flatMap(s => s.ranges)
			.filter(
				r =>
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

	private protocolsFor(live: LiveObservation): ScannerProtocol[] {
		const specs = live.jobIds
			.map(id => this.jobs.get(id)?.spec)
			.filter((s): s is NormalisedJobSpec => s !== undefined)
		if (specs.length === 0 || specs.some(s => s.protocols.length === 0))
			return []
		return [...new Set(specs.flatMap(s => s.protocols))]
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
			probeModesFor(live.classification.class, this.protocolsFor(live))
				.length === 0
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
				e.ev.at >= o.startedAt - 2000 && e.ev.at <= (o.endedAt ?? now) + 2000
			)
		})
		for (const live of candidates) this.applyEvidence(live, e.ev)
	}

	private applyEvidence(live: LiveObservation, ev: DecodeEvidence): void {
		if (ev.metadata.talkgroups?.[0]) live.talkgroup = ev.metadata.talkgroups[0]
		if (ev.metadata.sources?.[0]) live.source = ev.metadata.sources[0]
		if (ev.encrypted) live.encrypted = true
		if (!live.discoveryId && live.lastTrack) this.ingest(live, live.lastTrack)
		const discoveryId = live.discoveryId
		if (!discoveryId) return
		// § 7.1: the observation keeps its own accepted evidence (Observation.decode; A1/A3 metrics).
		if (this.store.appendObservationEvidence(live.observationId, ev))
			this.dirty = true
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
		return leakOrIntermod(
			track,
			others,
			id => this.decodedAt(id, live.sourceId),
			{
				identity,
				...(cfg ? { rbwHz: cfg.sampleRateHz / cfg.fftSize } : {}),
			},
		)
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
		sourceId: string,
	): { centreHz: number; peakDbfs: number }[] {
		return this.store
			.list({ sourceId, minConfidence: "decoded", limit: 500 })
			.items.filter(
				d =>
					d.identity?.kind === identity.kind &&
					d.identity.value === identity.value,
			)
			.map(d => ({ centreHz: d.frequencyHz, peakDbfs: d.signal.best.peakDbfs }))
	}

	private readonly onProbeRecordings = (r: ProbeRecordings): void => {
		const observations = [...this.live.values(), ...this.recent].filter(
			o =>
				o.trackId === r.req.trackId &&
				o.sourceId === r.req.sourceId &&
				o.discoveryId !== null,
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
		this.evidence
			.linkProbeRecordings(r.probeDir, candidates)
			.then(res => {
				for (const l of res.linked)
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
	}

	private readonly onProbeState = (
		probeId: string,
		state: string,
		req: ProbeRequest,
	): void => {
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

	private readonly onSourceDown = (sourceId: string): void => {
		for (const d of this.driversOn(sourceId)) {
			if (d.record.state === "running" || d.record.state === "holding")
				d.dispatch({ type: "source-down" }).catch((err: unknown) =>
					this.log.warn({ err, jobId: d.record.id }, "source-down failed"),
				)
		}
	}

	private readonly onSourceUp = (sourceId: string): void => {
		for (const d of this.driversOn(sourceId)) {
			if (d.record.state === "paused" && d.record.reason === "source-down")
				d.dispatch({ type: "source-up" }).catch((err: unknown) =>
					this.log.warn({ err, jobId: d.record.id }, "source-up failed"),
				)
		}
		if (!this.persistedLeases.has(sourceId)) this.runBootResumes(sourceId)
		this.onSourceAvailable()
	}

	private readonly onSourceAvailable = (): void => {
		if (!this.started || !this.settings().enabled) return
		// refreshPassive logs a failure on the chain itself.
		this.refreshPassive().catch(() => undefined)
	}

	/** ensurePassiveJobs, serialised on passiveChain (stop() awaits it). */
	private refreshPassive(): Promise<void> {
		const run = this.passiveChain.then(() => this.ensurePassiveJobs())
		this.passiveChain = run.catch((err: unknown) =>
			this.log.warn({ err }, "Refreshing passive jobs failed"),
		)
		return run
	}

	/** Recovery settled (restored, or adopted by a job's acquire with empty lists, Task 33). */
	private readonly onRecovered = (sourceId: string): void => {
		// An adopting holder's lease stays persisted (its release restores the pre-crash state).
		if (!this.arbiter.holder(sourceId)) this.persistedLeases.delete(sourceId)
		this.runBootResumes(sourceId)
	}

	private readonly onSourceRemoved = (sourceId: string): void => {
		for (const d of this.driversOn(sourceId)) {
			if (!isTerminal(d.record.state))
				d.dispatch({ type: "source-removed" }).catch((err: unknown) =>
					this.log.warn({ err, jobId: d.record.id }, "source-removed failed"),
				)
		}
	}

	private runBootResumes(sourceId: string): void {
		if (!this.settings().enabled) return
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
			arbiter: this.arbiter,
			probes: this.probes,
			decoders: this.deps.decoders,
			settings: () => this.settings(),
			openEngine: sourceId => this.openEngine(sourceId, record.id),
			closeEngine: sourceId => this.closeEngine(sourceId, record.id),
			engine: sourceId => this.spectrum.engine(sourceId),
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
		const ranges = bandplansFor(this.deps.region).flatMap(b => b.ranges)
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
						{ holderJobId: holder.jobId },
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
						{ waiter: best },
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
		let failed = false
		try {
			plan = planForSpec(pj.spec, this.previewContext())
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
		}
		const driver = this.createDriver(record)
		this.jobs.set(record.id, record)
		this.drivers.set(record.id, driver)
		if (isTerminal(record.state)) return
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

	private async ensurePassiveJobs(): Promise<void> {
		const s = this.settings()
		for (const cfg of this.deps.sourceConfigs) {
			const id = `passive-${cfg.id}`
			const caps = this.deps.sources.getCaps(cfg.id) ?? cfg.caps
			const eligible =
				s.enabled &&
				s.passive.enabled &&
				this.effective.passiveBySource[cfg.id] === true &&
				isScannerIqFormat(caps) &&
				!this.passiveDisabled.has(cfg.id)
			let existing = this.jobs.get(id)
			if (existing && isTerminal(existing.state)) {
				// An ended passive job (e.g. its source was removed) is rebuilt once the source is eligible again.
				this.jobs.delete(id)
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
			tunerRange: () => ({ startHz: 24_000_000, endHz: 1_766_000_000 }),
		}
	}

	private rejectErrors(issues: PlanIssue[]): void {
		const errors = issues.filter(i => i.severity === "error")
		if (errors.length === 0) return
		const busy = errors.find(i => i.code === "source-busy")
		if (busy)
			throw new ScannerApiError(busy.message, "SCANNER_SOURCE_BUSY", 409, {
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

	private toDto(record: JobRecord): ScanJob {
		const driver = this.drivers.get(record.id)
		return {
			id: record.id,
			name: record.name,
			state: record.state,
			...(record.reason ? { reason: record.reason } : {}),
			passive: record.passive,
			spec: record.spec,
			plan: record.plan,
			issues: record.issues,
			impact: record.impact,
			unrestorable: record.unrestorable,
			progress: driver
				? driver.progress()
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

	private emitJob(record: JobRecord): void {
		this.emit("job", this.toDto(record))
	}

	private emitProgressFor(record: JobRecord | null): void {
		const records = record
			? [record]
			: [...this.jobs.values()].filter(r => !isTerminal(r.state))
		for (const r of records) {
			const p = this.drivers.get(r.id)?.progress()
			if (!p) continue
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
		this.persistence
			.append(entry)
			.catch((err: unknown) => this.log.warn({ err }, "Journal append failed"))
	}

	private readonly onStoreChange = (
		id: string,
		change: ScannerDiscoveryEventData["change"] | "transient",
	): void => {
		if (change === "transient") return
		const discovery = this.store.get(id)
		if (!discovery) return
		this.emit("discovery", {
			change,
			discovery,
		} satisfies ScannerDiscoveryEventData)
	}

	/** Never rejects (a failed write is logged). */
	private async persistJobs(): Promise<void> {
		if (!this.configLoaded) return
		// Identify jobs are never persisted: a 15 s question does not survive a restart (§ 10.8).
		const jobs: PersistedJob[] = [...this.jobs.values()]
			.filter(r => !r.passive && r.spec.kind !== "identify")
			.map(r => {
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
		await this.persistence
			.writeJobs(jobs)
			.catch((err: unknown) => this.log.warn({ err }, "jobs.json write failed"))
	}

	private tick(): void {
		const now = this.now()
		for (const d of this.drivers.values()) d.tick(now)
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
			this.checkPassiveCost(now).catch((err: unknown) =>
				this.log.warn({ err }, "Passive cost check failed"),
			)
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
			this.maintenance().catch((err: unknown) =>
				this.log.warn({ err }, "Scanner maintenance failed"),
			)
		}
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

/** Paused by a lease loss (§ 10.1 preempted-*): waits for the lease. */
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
