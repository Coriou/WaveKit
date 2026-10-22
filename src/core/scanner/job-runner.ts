import { TrialRotation } from "./trial-rotation.js"
import { probeModesFor } from "./probes/probe-pool.js"
import type { ObservationEndReason } from "../spectrum/types.js"
import { protocolsForFrequency } from "./plan/protocols.js"
/**
 * One discovery job (spec § 10.1–§ 10.5): the transition table, the sweep
 * scheduler, the lease and decoder hold, probe requests and progress.
 * Observations are owned by ScannerService; the runner gets per-job callbacks.
 */
import type { ScanJobProgress, ScanJobProbe } from "@wavekit/api-types"
import type { DecoderManager } from "../../decoders/manager.js"
import { safeErrorFields } from "../../decoders/safe-error-fields.js"
import { createComponentLogger, type Logger } from "../../utils/logger.js"
import { WaveKitError } from "../../utils/errors.js"
import { ScannerApiError } from "./errors.js"
import {
	actionsForMode,
	isTerminal,
	transition,
	type JobAction,
	type JobEvent,
} from "./job-state.js"
import { DEFAULT_CONFIRM_HOLD_MS } from "./plan/plan-preview.js"
import type {
	ProbeMode,
	ProbePool,
	ProbeRequest,
	ProbeStatus,
} from "./probes/probe-pool.js"
import { jobProgressFields } from "./job-phase.js"
import type {
	JobActivityView,
	JobPhaseInput,
} from "./scanner-redesign-contract.js"
import { ScannerProtocolSchema } from "./store/schemas.js"
import type { KnownProtocolMemory } from "./known-protocol-contract.js"
import { SweepScheduler, type SchedulerAction } from "./scheduler.js"
import type {
	EngineEpoch,
	SpectrumEngine,
} from "../spectrum/spectrum-engine.js"
import type { Lease, LeaseLostReason, TunerArbiter } from "./tuner-arbiter.js"
import type {
	BandPlanSkipRange,
	Classification,
	DecodeEvidence,
	FailReason,
	Hop,
	HopPlan,
	Impact,
	Identity,
	JobState,
	DecodedElsewhereRange,
	LockoutExclusion,
	NormalisedJobSpec,
	PauseReason,
	PlanIssue,
	ScannerClass,
	ScannerProtocol,
	ScannerConfidence,
	ScannerSettings,
	UndecodedReason,
} from "./types.js"
import type { TrackSnapshot } from "../spectrum/types.js"
import { isRangeEnabled } from "./plan/range-contract.js"
import type { StoredScanJobSpec } from "./plan/range-contract.js"

/** Bounds first-IQ admission only; running jobs retain their existing stop contract. */
export const JOB_STARTUP_CAP_MS = 15_000

export interface JobRecord {
	id: string
	name: string | null
	passive: boolean
	rawSpec: StoredScanJobSpec
	spec: NormalisedJobSpec
	plan: HopPlan
	issues: PlanIssue[]
	impact: Impact | null
	consentedImpact: Impact | null
	state: JobState
	reason?: PauseReason | FailReason
	createdAt: number
	updatedAt: number
	startedAt?: number
	endedAt?: number
	unrestorable: string[]
	counts: { observations: number; transients: number }
	/** WG2 req 12.2: runtime lockout exclusions of the current plan (sweep jobs; never persisted). */
	lockoutExclusions?: LockoutExclusion[]
	/** WG6 req 1.2: runtime decoded-elsewhere ranges of the current plan (never persisted). */
	decodedElsewhere?: DecodedElsewhereRange[]
	/** WG7 req 6.3: runtime band-plan skip ranges of the current plan (never persisted). */
	bandPlanSkips?: BandPlanSkipRange[]
}

export interface LiveObservation {
	observationId: string
	sourceId: string
	trackId: string
	epoch: number
	jobIds: string[]
	discoveryId: string | null
	startedAt: number
	/** Wall-clock receipt of the first gate pass for this track and epoch. */
	gatePassedAt?: number
	endedAt?: number
	endReason?: ObservationEndReason
	classification: Classification
	probeIds: Set<string>
	hopIndex?: number
	lastActivityAt: number
	lastIngestAt: number
	lastTrack: TrackSnapshot | null
	decoded: boolean
	encrypted: boolean
	talkgroup?: string
	source?: string
	/** H3 reason recorded before the observation had a discovery; applied when it gets one. */
	undecodedReason?: UndecodedReason
	/** Explicit deletion invalidates late evidence from this bounded observation lifetime. */
	evidenceDeleted?: boolean
	/** Accepted identity of this observation, never borrowed from a retained discovery. */
	acceptedIdentity?: { identity: Identity; stream: number; epoch: number }
}

export interface JobDriver {
	readonly record: JobRecord
	start(): Promise<void>
	dispatch(e: JobEvent): Promise<void>
	idle(): Promise<void>
	covers(sourceId: string, hz: number): boolean
	progress(): ScanJobProgress
	tick(now: number): void
	onEpochStarted(epoch: EngineEpoch): void
	onBlock(endSample: number, overload: boolean): void
	onStale(blocks: number): void
	onTrack(
		live: LiveObservation,
		track: TrackSnapshot,
		needsConfirm: boolean,
	): void
	onTrackClosed(trackId: string): void
	/** § 4.7: the source moved without a command the core saw (pipeline `untracked-retune`). */
	onUntrackedRetune(): void
	onEvidence(probeId: string, ev: DecodeEvidence): void
	/**
	 * WG7 req 1.5: ambient evidence (origin `ambient`) paired with one of this job's live
	 * observations. Optional: drivers without it ignore ambient evidence (as before WG7).
	 */
	onAmbientEvidence?(observationId: string, ev: DecodeEvidence): void
	/**
	 * The arbiter revoked `lease`. The job event is chosen inside the dispatch chain from the state
	 * the job has then (R1: a REST or relay loss while `starting` is a `tuner-error`).
	 */
	leaseLost(lease: Lease, reason: LeaseLostReason): Promise<void>
	replan(spec: NormalisedJobSpec, plan: HopPlan): void
	dispose(): Promise<void>
}

export interface LeaseCandidate {
	jobId: string
	priority: number
	createdAt: number
}

/** P16: highest priority; ties go to the earliest job (then the smaller id). */
export function chooseLeaseHolder(
	candidates: readonly LeaseCandidate[],
): string | null {
	let best: LeaseCandidate | null = null
	for (const c of candidates) {
		if (
			!best ||
			c.priority > best.priority ||
			(c.priority === best.priority &&
				(c.createdAt < best.createdAt ||
					(c.createdAt === best.createdAt && c.jobId < best.jobId)))
		) {
			best = c
		}
	}
	return best?.jobId ?? null
}

/** True when `now` disturbs anything the operator did not consent to (§ 10.3 auto-resume). */
export function impactGrew(now: Impact, consented: Impact | null): boolean {
	const c = consented ?? {
		liveAudioClients: 0,
		digitalVoiceListeners: 0,
		runningDecoders: [],
		pinnedDecoders: [],
		scannerJobs: [],
		unrestorable: [],
	}
	const notIn = (xs: string[], ys: string[]) => xs.some(x => !ys.includes(x))
	return (
		now.liveAudioClients > c.liveAudioClients ||
		now.digitalVoiceListeners > c.digitalVoiceListeners ||
		notIn(now.runningDecoders, c.runningDecoders) ||
		notIn(now.pinnedDecoders, c.pinnedDecoders) ||
		notIn(now.scannerJobs, c.scannerJobs) ||
		notIn(now.unrestorable, c.unrestorable)
	)
}

type Deferral = Extract<
	ReturnType<ProbePool["request"]>,
	{ deferred: unknown }
>["deferred"]

/** H3: the undecoded reason a probe deferral leaves behind; null when the request was only stale. */
export function undecodedForDeferral(d: Deferral): UndecodedReason | null {
	switch (d) {
		case "budget":
		case "max-probes":
		case "cpu":
			return "budget"
		case "no-transport":
			return "no-probe-transport"
		case "format":
			return "unsupported-format"
		case "stale-epoch":
			return null
	}
}

/** What ScannerService saw of one probe between "starting" and "stopped". */
export interface ProbeOutcome {
	startedAt: number
	holdMs: number
	/** Any evidence at all (the decoder synced on something). */
	output: boolean
	crcFailures: number
	/** Accepted identity or encryption flag (the pool's `confirmed`). */
	confirmed: boolean
}

/** A probe stopped before this share of its hold was released early (track closed, epoch, preemption): not a decode failure. */
const HOLD_USED_FRACTION = 0.9

/** H3: why a probe that used its hold without accepted evidence did not decode; null when it confirmed or was cut short. */
export function undecodedForProbe(
	o: ProbeOutcome,
	stoppedAt: number,
): UndecodedReason | null {
	if (o.confirmed) return null
	if (stoppedAt - o.startedAt < o.holdMs * HOLD_USED_FRACTION) return null
	if (o.crcFailures > 0) return "crc-errors"
	return o.output ? "timeout" : "no-sync"
}

export interface JobRunnerDeps {
	leaseAnalogSession?: (sourceId: string) => (() => void) | undefined
	/** Rechecked on the serial dispatch chain before an automatic acquisition. */
	autoResumeReady?: () => boolean
	record: JobRecord
	arbiter: Pick<
		TunerArbiter,
		| "acquire"
		| "retune"
		| "release"
		| "setAgc"
		| "holder"
		| "holderPriority"
		| "operatorIdleSince"
	>
	probes: Pick<
		ProbePool,
		| "request"
		| "release"
		| "releaseJob"
		| "follow"
		| "status"
		| "startLatencyMs"
	> &
		/** WG11 1.8: the pool's per-mode full-hold record; absent (a fake): no miss is counted. */
		Partial<Pick<ProbePool, "fullHoldCovers">>
	decoders: Pick<DecoderManager, "holdSource" | "releaseSource">
	settings: () => ScannerSettings
	openEngine: (sourceId: string) => Promise<SpectrumEngine>
	closeEngine: (sourceId: string) => Promise<void>
	engine: (sourceId: string) => SpectrumEngine | undefined
	/**
	 * Re-applies the lease holder's engine tuning (the defaults with no holder) to an open engine
	 * (`SpectrumService.refreshTuning`; S1-B final review, finding 2).
	 */
	refreshTuning: (sourceId: string) => Promise<void>
	/** Sweep revisit seed from the occupancy history (§ 10.2, Task 37a); none = no seeding. */
	activitySeed?: (hop: Hop) => number
	/** Impact of this job's source excluding the job itself (`arbiter.impact(sourceId, spec, record.id)`). */
	impact: () => Impact
	/** H3: a probe request for this observation was deferred. */
	undecoded: (live: LiveObservation, reason: UndecodedReason) => void
	discoveryCounts: (jobId: string) => Record<ScannerConfidence, number>
	/**
	 * After a release with restore: resolves once the source caps show the restored `snapshot`
	 * fields (or a bounded timeout), so configured decoders resume on the restored tuning (Task 29
	 * review, finding 6). Never rejects.
	 */
	awaitRestoredCaps: (
		sourceId: string,
		snapshot: Lease["snapshot"],
		restored: readonly string[],
	) => Promise<void>
	persist: () => void
	changed: (kind: "state" | "progress") => void
	logger: Logger
	now: () => number
	/**
	 * WG11 requirements 1.7 and 1.8: the known-protocol memory. Absent: no miss or decode is
	 * counted (behaviour as before WG11).
	 */
	knownProtocols?: KnownProtocolMemory
	/**
	 * WG12 req 7: captures and replays of this job. Absent: `progress()` stays the
	 * pre-redesign object (no phase, parked, holding, trial or replayQueueDepth).
	 * The plan calls this `JobDriverDeps`; the runner's dependency bag is `JobRunnerDeps`.
	 */
	activity?: (jobId: string) => JobActivityView
}

/** Acquire refusals that clear by themselves: an operator-paused resume stays `paused(operator)` (R4). */
const TRANSIENT_REFUSALS: ReadonlySet<string> = new Set([
	"releasing",
	"recovery pending",
	"holder is starting",
])

const ACTIVE: ReadonlySet<JobState> = new Set([
	"starting",
	"running",
	"holding",
])
const LOST_EVENTS: ReadonlySet<JobEvent["type"]> = new Set([
	"rest-write",
	"relay-external",
	"preempted-job",
])

const ACTIVITY_LIMIT = 1_000_000
const EMPTY_ACTIVITY: JobActivityView = {
	capturing: 0,
	replaying: null,
	replayQueueDepth: 0,
}

function inRange(hz: number, r: { startHz: number; endHz: number }): boolean {
	return hz >= r.startHz && hz <= r.endHz
}

/** Samples per detection block of an engine config: whole FFT frames per integration. */
function blockSamplesOf(cfg: {
	integrationMs: number
	sampleRateHz: number
	fftSize: number
}): number {
	const frames = Math.max(
		1,
		Math.round((cfg.integrationMs * cfg.sampleRateHz) / (cfg.fftSize * 1000)),
	)
	return frames * cfg.fftSize
}

function countOf(value: unknown): number | null {
	if (typeof value !== "number" || !Number.isInteger(value)) return null
	if (value < 0 || value > ACTIVITY_LIMIT) return null
	return value
}

function recordOf(value: unknown): Record<string, unknown> | null {
	if (value === null || typeof value !== "object" || Array.isArray(value))
		return null
	return value as Record<string, unknown>
}

/** Null is a valid "not replaying". Undefined means the view is malformed. */
function replayOf(value: unknown): JobActivityView["replaying"] | undefined {
	if (value === null) return null
	const row = recordOf(value)
	if (!row) return undefined
	const protocol = ScannerProtocolSchema.safeParse(row["protocol"])
	if (!protocol.success) return undefined
	const decoder = row["decoder"]
	if (typeof decoder !== "string" || decoder.length === 0) return undefined
	const discoveryId = row["discoveryId"]
	if (discoveryId !== null && typeof discoveryId !== "string") return undefined
	return { protocol: protocol.data, decoder, discoveryId }
}

function parseActivity(value: unknown): JobActivityView | null {
	const row = recordOf(value)
	if (!row) return null
	const capturing = countOf(row["capturing"])
	const replayQueueDepth = countOf(row["replayQueueDepth"])
	if (capturing === null || replayQueueDepth === null) return null
	const replaying = replayOf(row["replaying"])
	if (replaying === undefined) return null
	return { capturing, replaying, replayQueueDepth }
}

function liveProbeView(
	raw: readonly ProbeStatus[],
): JobPhaseInput["liveProbe"] {
	const live = raw
		.filter(
			(s): s is ProbeStatus & { transport: "offset" | "channel" } =>
				s.transport === "offset" || s.transport === "channel",
		)
		.sort(
			(a, b) => a.startedAt - b.startedAt || a.probeId.localeCompare(b.probeId),
		)
	const s = live[0]
	if (!s) return null
	return {
		protocol: s.protocol,
		decoder: s.decoderType,
		transport: s.transport,
		discoveryId: s.discoveryId,
		frequencyHz: s.targetHz,
		trackId: s.trackId,
	}
}

/** Class evidence orders candidates; allowed protocols still get later turns. */
export function jobTrialModes(
	cls: ScannerClass,
	protocols: ScannerProtocol[],
	obwHz: number,
): ProbeMode[] {
	const key = (mode: ProbeMode) =>
		`${mode.decoderType}:${JSON.stringify(mode.options)}`
	const candidates = probeModesFor(cls, protocols)
	if (
		cls !== "ook-burst" &&
		Number.isFinite(obwHz) &&
		obwHz > 0 &&
		obwHz <= 22_500
	) {
		for (const alternative of [
			"fsk4-12k5",
			"fsk4-6k25",
			"gmsk-narrow",
			"fsk2-wide",
			"afsk-fm",
		] as const)
			for (const mode of probeModesFor(alternative, protocols))
				if (!candidates.some(candidate => key(candidate) === key(mode)))
					candidates.push(mode)
	}
	return candidates
}

export class JobRunner implements JobDriver {
	private releaseAnalogSession: (() => void) | undefined
	readonly record: JobRecord
	private readonly trialRotation = new TrialRotation()
	private readonly log: Logger
	private scheduler: SweepScheduler | null = null
	private lease: Lease | null = null
	private holdingDecoders = false
	private engineOpened = false
	private ownEpochs = new Set<number>()
	private epochOwn = false
	/** Retunes awaiting the arbiter (their epoch may start before `retune()` resolves). */
	private retunes = 0
	/**
	 * Stream whose opening epoch triggered the last hop re-send, until an own epoch starts (R1). A
	 * further foreign stream before that means the re-sent hop's epoch was dropped again (e.g. the caps
	 * never follow the tuner's rate): no re-send loop.
	 */
	private resendStream: number | null = null
	private hopIndex: number | undefined
	private hopCentre: number | null = null
	private chain: Promise<void> = Promise.resolve()
	private actionChain: Promise<void> = Promise.resolve()
	private readonly queued = new Set<JobEvent["type"]>()
	private readonly tracks = new Map<
		string,
		{ live: LiveObservation; track: TrackSnapshot }
	>()
	private readonly windowHolds = new Map<
		string,
		{
			probeId: string
			timer: NodeJS.Timeout | null
			following: boolean
			/** WG11 1.8: the observation's accepted identity when the probe started. */
			identityAtStart?: LiveObservation["acceptedIdentity"]
		}
	>()

	constructor(private readonly deps: JobRunnerDeps) {
		this.record = deps.record
		this.log = createComponentLogger(deps.logger, `Job:${deps.record.id}`)
	}

	private get sweep(): boolean {
		return this.record.spec.mode === "sweep"
	}

	private autoResumeGuardActive = false
	/** One log for a thrown or malformed activity view, for the life of the runner. */
	private activityFaultLogged = false

	private get sourceId(): string {
		return this.record.spec.sourceId
	}

	/** States that drive the scheduler and the tuner; a paused sweep holds still (§ 10.1 pause row). */
	private get driving(): boolean {
		return ACTIVE.has(this.record.state)
	}

	async start(): Promise<void> {
		this.releaseAnalogSession ??= this.deps.leaseAnalogSession?.(this.sourceId)
		try {
			await this.dispatch({ type: "start" })
		} catch (error) {
			this.releaseAnalogSession?.()
			this.releaseAnalogSession = undefined
			throw error
		}
	}

	dispatch(e: JobEvent): Promise<void> {
		// WG11 requirement 1.6: a cancel of an ended job is a no-op (no transition, action, event or
		// persistence write). Checked on the chain, so a cancel queued behind the event that ends
		// the job sees the terminal state and the job ends exactly once.
		const run = this.chain.then(() =>
			e.type === "cancel" && isTerminal(this.record.state)
				? undefined
				: this.apply(e),
		)
		this.chain = run.catch(() => undefined)
		return run
	}

	idle(): Promise<void> {
		return Promise.all([this.chain, this.actionChain]).then(() => undefined)
	}

	leaseLost(lease: Lease, reason: LeaseLostReason): Promise<void> {
		const run = this.chain.then(async () => {
			const held = this.lease === lease
			if (held) this.lease = null
			const type =
				this.record.state === "starting" && reason !== "preempted-job"
					? "tuner-error"
					: reason === "preempted-operator"
						? "rest-write"
						: reason === "preempted-relay"
							? "relay-external"
							: "preempted-job"
			try {
				await this.apply({ type })
			} finally {
				// Finding 2: no holder after an operator or relay write: the engine returns to the defaults
				// (a job that took the lease over has re-applied its own tuning).
				if (held && reason !== "preempted-job") await this.refreshTuning()
			}
		})
		this.chain = run.catch(() => undefined)
		return run
	}

	covers(sourceId: string, hz: number): boolean {
		const { spec, state } = this.record
		if (sourceId !== spec.sourceId || !ACTIVE.has(state)) return false
		if (
			spec.ranges.length > 0 &&
			!spec.ranges.some(r => isRangeEnabled(r) && inRange(hz, r))
		)
			return false
		if (spec.exclusions.some(x => inRange(hz, x))) return false
		if (this.sweep) return this.epochOwn
		const holder = this.deps.arbiter.holder(sourceId)
		return holder === undefined || holder.jobId === this.record.id
	}

	progress(): ScanJobProgress {
		const engine = this.deps.engine(this.sourceId)
		const p = this.scheduler?.progress()
		const stats = engine?.stats()
		const raw = this.deps.probes
			.status()
			.filter(s => s.jobId === this.record.id)
		const probes: ScanJobProbe[] = raw.map(s => ({
			probeId: s.probeId,
			decoderId: s.decoderId,
			trackId: s.trackId,
			targetHz: s.targetHz,
			protocol: s.protocol,
			transport: s.transport,
			state: s.state === "starting" ? "confirming" : s.state,
			startedAt: new Date(s.startedAt).toISOString(),
		}))
		const base: ScanJobProgress = {
			sweepIndex: p?.sweepIndex ?? 0,
			hopIndex: p?.hopIndex ?? 0,
			hopCount: p?.hopCount ?? this.record.plan.hops.length,
			sweepPeriodMs: p?.sweepPeriodMs ?? null,
			coverage:
				p?.coverage ??
				(stats && stats.observedSamples > 0
					? stats.settledSamples / stats.observedSamples
					: 0),
			holdingOn: p?.holdingOn ?? [...this.windowHolds.keys()][0] ?? null,
			settleMode: engine?.currentEpoch().settleMode ?? null,
			probes,
			counts: {
				...this.record.counts,
				discoveries: this.deps.discoveryCounts(this.record.id),
			},
		}
		// Req 1.3: a parked sweep reports no period. In-window already has none.
		const parked = this.jobParked()
		const sweepPeriodMs = parked ? null : base.sweepPeriodMs
		if (!this.deps.activity) {
			return sweepPeriodMs === base.sweepPeriodMs
				? base
				: { ...base, sweepPeriodMs }
		}
		const fields = jobProgressFields(
			{
				schedulerPhase: this.schedulerPhase(),
				parked,
				liveProbe: liveProbeView(raw),
				hold: this.holdView(raw),
				activity: this.readActivity(),
			},
			base.sweepPeriodMs,
		)
		return {
			...base,
			sweepPeriodMs: fields.sweepPeriodMs,
			phase: fields.phase,
			parked: fields.parked,
			replayQueueDepth: fields.replayQueueDepth,
			...(fields.holding ? { holding: fields.holding } : {}),
			...(fields.trial ? { trial: fields.trial } : {}),
		}
	}

	/**
	 * Parked when the job is in-window, or when the scheduler says so. A sweep
	 * counts as parked only when the scheduler exposes parked === true.
	 */
	private jobParked(): boolean {
		if (!this.sweep) return true
		const scheduler = this.scheduler
		if (!scheduler) return false
		const parked = (scheduler as { parked?: unknown }).parked
		return parked === true
	}

	/**
	 * `holdingOn` is set only while the scheduler phase is hold. Before this job's
	 * own epoch the hop is still tuning. Engine `settleMode` stays `"timer"` after
	 * the hop has settled, so it is not this phase. The contract's `"settling"` is
	 * accepted by `jobPhase` when a caller passes it; this runner has no separate
	 * settling signal yet.
	 */
	private schedulerPhase(): JobPhaseInput["schedulerPhase"] {
		if (!this.sweep || !this.scheduler) return null
		if (this.scheduler.progress().holdingOn !== null) return "hold"
		if (!this.epochOwn) return "tuning"
		return "dwell"
	}

	private holdView(raw: readonly ProbeStatus[]): JobPhaseInput["hold"] {
		if (!this.sweep || !this.scheduler) return null
		const trackId = this.scheduler.progress().holdingOn
		if (trackId === null) return null
		const held = this.tracks.get(trackId)
		if (held) {
			return {
				discoveryId: held.live.discoveryId,
				frequencyHz: held.track.centreHz,
				trackId,
			}
		}
		const probe = raw.find(s => s.trackId === trackId)
		// The held track and its probe are both gone. A made-up centre would
		// publish a holding phase at 0 Hz; null lets the phase fall back.
		if (!probe) return null
		return {
			discoveryId: probe.discoveryId ?? null,
			frequencyHz: probe.targetHz,
			trackId,
		}
	}

	private readActivity(): JobActivityView {
		const read = this.deps.activity
		if (!read) return EMPTY_ACTIVITY
		try {
			const parsed = parseActivity(read(this.record.id))
			if (parsed) return parsed
			this.logActivityFault(
				new WaveKitError(
					"Job activity view is malformed",
					"SCANNER_ACTIVITY_VIEW",
				),
			)
		} catch (err: unknown) {
			this.logActivityFault(err)
		}
		return EMPTY_ACTIVITY
	}

	private logActivityFault(err: unknown): void {
		if (this.activityFaultLogged) return
		this.activityFaultLogged = true
		this.log.warn(
			{ err: safeErrorFields(err) },
			"Scan job activity view failed",
		)
	}

	tick(now: number): void {
		const { state, reason, spec } = this.record
		if (
			state === "starting" &&
			now - this.record.createdAt >= JOB_STARTUP_CAP_MS
		)
			this.queueEvent({ type: "engine-failed" })
		if ((state === "running" || state === "holding") && this.scheduler)
			this.exec(this.scheduler.tick(now))
		if (
			(state === "running" || state === "holding") &&
			spec.stop.afterMs !== null &&
			this.record.startedAt !== undefined &&
			now - this.record.startedAt >= spec.stop.afterMs
		) {
			this.queueEvent({ type: "stop-condition" })
		}
		if (
			state === "paused" &&
			(reason === "preempted-operator" || reason === "preempted-relay") &&
			spec.resume.autoAfterIdleMs !== null
		) {
			const idleSince = this.deps.arbiter.operatorIdleSince(this.sourceId)
			if (
				idleSince !== null &&
				now - idleSince >= spec.resume.autoAfterIdleMs &&
				(this.deps.autoResumeReady?.() ?? true) &&
				!this.deps.arbiter.holder(this.sourceId)
			) {
				this.queueEvent({
					type: "preemptor-idle",
					impactGrew: impactGrew(
						this.deps.impact(),
						this.record.consentedImpact,
					),
				})
			}
		}
	}

	onEpochStarted(epoch: EngineEpoch): void {
		let own = this.ownEpochs.has(epoch.epoch)
		if (!own && this.inFlightEpoch(epoch)) {
			own = true
			this.addOwnEpoch(epoch.epoch)
		}
		if (
			this.record.state === "starting" &&
			(!this.sweep || own) &&
			(this.record.spec.kind !== "identify" ||
				this.hasCurrentIq(this.deps.engine(this.sourceId)))
		)
			this.queueEvent({ type: "engine-ready" })
		if (!this.sweep) return
		if (!this.driving) {
			this.epochOwn = false
			return
		}
		this.epochOwn = own && epoch.tuningTrust === "commanded"
		if (this.epochOwn && epoch.startSample !== null && this.scheduler) {
			this.resendStream = null
			// A reconfigured engine (holder change, PATCH, settings) blocks differently: dwell follows it.
			this.syncGeometry()
			this.exec(this.scheduler.onEpochStarted(epoch.startSample))
			return
		}
		// A new stream the job did not start (a rate-change restart dropped the hop's pending epoch,
		// a reconfigure, a reconnect): re-send the hop so it gets a normal pending epoch of its own.
		if (!own && epoch.settleMode === "none") this.resendForStream(epoch.stream)
	}

	/** At most one re-send until an own epoch starts (R1). */
	private resendForStream(stream: number): void {
		if (!this.lease || this.hopCentre === null) return
		if (this.resendStream !== null) {
			this.log.warn(
				{ stream, resentFor: this.resendStream, hopIndex: this.hopIndex },
				"A new stream dropped the re-sent hop's epoch again; not re-sending (do the source caps follow the tuner's sample rate?)",
			)
			return
		}
		this.resendStream = stream
		this.onUntrackedRetune()
	}

	onBlock(endSample: number, overload: boolean): void {
		if (this.record.state === "starting" && (!this.sweep || this.epochOwn))
			this.queueEvent({ type: "engine-ready" })
		if (!this.sweep || !this.driving || !this.epochOwn || !this.scheduler)
			return
		if (overload && this.hopIndex !== undefined)
			this.scheduler.onOverload(this.hopIndex)
		this.exec(this.scheduler.onBlock(endSample))
	}

	onStale(blocks: number): void {
		if (this.sweep && this.driving && this.epochOwn)
			this.scheduler?.onStale(blocks)
	}

	onTrack(
		live: LiveObservation,
		track: TrackSnapshot,
		needsConfirm: boolean,
	): void {
		if (
			this.hopIndex !== undefined &&
			live.hopIndex === undefined &&
			this.sweep
		)
			live.hopIndex = this.hopIndex
		this.tracks.set(track.trackId, { live, track })
		const policy = this.record.spec.hold.policy
		// A signals-only job takes the same path as a track that needs no confirmation.
		const confirm = needsConfirm && this.record.spec.signalsOnly !== true
		if (this.sweep && this.scheduler) {
			const holdMs = confirm ? this.confirmHoldMs(live) : 0
			this.exec(
				this.scheduler.onTrack(track, confirm && policy !== "never", holdMs),
			)
			return
		}
		if (!confirm || policy === "never" || this.windowHolds.has(track.trackId))
			return
		const holdMs = this.confirmHoldMs(live)
		const res = this.requestProbe(live, track, holdMs)
		if (!res || !("started" in res)) return
		const timer = setTimeout(() => {
			const hold = this.windowHolds.get(track.trackId)
			if (hold && !hold.following) {
				this.windowHolds.delete(track.trackId)
				this.recordFullHoldMiss(live, hold)
				this.releaseProbe(hold.probeId)
			}
		}, holdMs)
		timer.unref()
		this.windowHolds.set(track.trackId, {
			probeId: res.started,
			timer,
			following: false,
			...(this.deps.knownProtocols
				? { identityAtStart: live.acceptedIdentity }
				: {}),
		})
	}

	onTrackClosed(trackId: string): void {
		this.tracks.delete(trackId)
		if (this.scheduler) this.exec(this.scheduler.onTrackClosed(trackId))
		const hold = this.windowHolds.get(trackId)
		if (!hold) return
		if (hold.timer) clearTimeout(hold.timer)
		this.windowHolds.delete(trackId)
		const hangMs = this.record.spec.hold.hangMs
		const timer = setTimeout(
			() => this.releaseProbe(hold.probeId),
			hold.following ? hangMs : 0,
		)
		timer.unref()
	}

	onEvidence(probeId: string, ev: DecodeEvidence): void {
		if (!ev.identity && ev.encrypted === undefined) return
		const probe = this.deps.probes
			.status()
			.find(p => p.probeId === probeId && p.jobId === this.record.id)
		if (probe && ev.identity) this.recordAcceptedDecode(probe.trackId)
		if (probe) {
			const { spec } = this.record
			const follow = spec.hold.policy === "hold" && spec.record.voice
			this.deps.probes.follow(probeId, follow)
			if (this.scheduler)
				this.exec(this.scheduler.onConfirmed(probe.trackId, follow))
			const hold = this.windowHolds.get(probe.trackId)
			if (hold) {
				hold.following = follow
				if (!follow) {
					if (hold.timer) clearTimeout(hold.timer)
					this.windowHolds.delete(probe.trackId)
					this.releaseProbe(probeId)
				}
			}
		}
		if (this.record.spec.stop.onFirstDecoded && ev.identity)
			this.queueEvent({ type: "stop-condition" })
	}

	replan(spec: NormalisedJobSpec, plan: HopPlan): void {
		this.record.spec = spec
		this.record.plan = plan
		// DT (R 1.1): a parked one-hop plan that moves returns its stop-probes and one tune.
		if (this.scheduler) this.exec(this.scheduler.replan(plan, spec))
		for (const p of this.deps.probes.status()) {
			if (
				p.jobId === this.record.id &&
				spec.exclusions.some(x => inRange(p.targetHz, x))
			) {
				this.releaseProbe(p.probeId)
			}
		}
	}

	async dispose(): Promise<void> {
		this.releaseAnalogSession?.()
		this.releaseAnalogSession = undefined
		await this.idle()
		await this.teardown()
	}

	// === internals ===

	/**
	 * WG11 1.8: an identity on a probe of this job resets the discovery's miss count when the
	 * observation accepted it (ScannerService applies the evidence before the drivers see it).
	 * The passive job's reconfirm probes take this path too.
	 */
	private recordAcceptedDecode(trackId: string): void {
		const memory = this.deps.knownProtocols
		if (!memory) return
		const live = this.tracks.get(trackId)?.live
		if (live?.discoveryId && live.acceptedIdentity)
			try {
				memory.recordDecode(live.discoveryId)
			} catch {
				// The memory never throws by contract; a broken one changes nothing here.
			}
	}

	/**
	 * WG11 1.8: the confirm hold timer of a window probe expired without a confirmation. It counts
	 * a miss of the discovery's known protocol only when one of the probe's modes covering it ran
	 * its full mode hold (the pool's per-mode record: the probe's current mode says nothing, it
	 * may already have stepped on, or be stopping for the step), the probe is still this job's,
	 * the observation has a discovery and accepted no new identity during the hold. A mode cut
	 * short by the job hold, an unavailable or never-confirming mode, a track that closed, a
	 * cancel, a pause or a sweep hop (they release the probe elsewhere) is never a miss.
	 */
	private recordFullHoldMiss(
		live: LiveObservation,
		hold: {
			probeId: string
			identityAtStart?: LiveObservation["acceptedIdentity"]
		},
	): void {
		const memory = this.deps.knownProtocols
		if (!memory || !this.driving || live.discoveryId === null) return
		if (live.acceptedIdentity !== hold.identityAtStart) return
		try {
			const probes = this.deps.probes
			const probe = probes
				.status()
				.find(p => p.probeId === hold.probeId && p.jobId === this.record.id)
			if (!probe) return
			const known = memory.known(live.discoveryId)
			if (known === null) return
			const covers = probes.fullHoldCovers?.(hold.probeId) ?? []
			if (!covers.includes(known)) return
			memory.recordMiss(live.discoveryId, known)
		} catch {
			// As above: a throwing memory or pool must not escape the hold timer.
		}
	}

	/**
	 * The epoch of a retune still in flight. The engine can start it before `retune()` resolves
	 * (inline host, or a timer-settled epoch on a worker while the tuner writes are still pending),
	 * so `ownEpochs` does not have it yet: a commanded epoch at the hop centre while this job holds
	 * the lease is that retune's (an operator or relay command revokes the lease first, Task 33).
	 */
	private inFlightEpoch(epoch: EngineEpoch): boolean {
		return (
			this.retunes > 0 &&
			this.lease !== null &&
			// A new stream's opening epoch never settled: it takes the re-send path on every host (R2).
			epoch.settleMode !== "none" &&
			epoch.tuningTrust === "commanded" &&
			epoch.centreHz === this.hopCentre &&
			this.deps.arbiter.holder(this.sourceId) === this.lease
		)
	}

	private addOwnEpoch(epoch: number): void {
		this.ownEpochs.add(epoch)
		if (this.ownEpochs.size > 64)
			this.ownEpochs.delete(this.ownEpochs.values().next().value as number)
	}

	private releaseProbe(probeId: string): void {
		this.deps.probes
			.release(probeId)
			.catch((err: unknown) =>
				this.log.warn({ err, probeId }, "Releasing a probe failed"),
			)
	}

	/**
	 * Releases the lease. With restore, waits until the source caps show the restored tuning
	 * before returning, so a decoder hold released next resumes on it (Task 29 review, finding 6).
	 */
	private async releaseLease(
		lease: Lease,
		restore: boolean,
	): Promise<{ restored: string[]; unrestorable: string[] }> {
		const res = await this.deps.arbiter.release(lease, { restore })
		if (restore && res.restored.length > 0) {
			await this.deps.awaitRestoredCaps(
				this.sourceId,
				lease.snapshot,
				res.restored,
			)
		}
		return res
	}

	/**
	 * Drops everything the job holds: window holds, the lease (restored; a no-op when the
	 * arbiter already released or revoked it), the decoder hold and the engine reference.
	 * Called from `apply` for terminal states (inside the dispatch chain, so it must not
	 * await `idle()`) and from `dispose`.
	 */
	private async teardown(): Promise<void> {
		for (const hold of this.windowHolds.values())
			if (hold.timer) clearTimeout(hold.timer)
		this.windowHolds.clear()
		const lease = this.lease
		this.lease = null
		if (lease) {
			const res = await this.releaseLease(lease, true).catch((err: unknown) => {
				this.log.warn({ err }, "Releasing the lease on dispose failed")
				return null
			})
			if (res && res.unrestorable.length > 0)
				this.record.unrestorable = res.unrestorable
		}
		if (this.holdingDecoders) {
			this.holdingDecoders = false
			await this.deps.decoders
				.releaseSource(this.sourceId, this.record.id)
				.catch((err: unknown) =>
					this.log.warn(
						{ err },
						"Releasing the decoder hold on dispose failed",
					),
				)
		}
		if (this.engineOpened) {
			this.engineOpened = false
			await this.deps
				.closeEngine(this.sourceId)
				.catch((err: unknown) =>
					this.log.warn({ err }, "Closing the engine on dispose failed"),
				)
		}
	}

	/**
	 * Undoes the side effects of a transition whose actions failed and restores the previous state
	 * (§ 10.1). Order as teardown (delta note, Task 35 ruling): lease with the restore retune, then
	 * the decoder hold, then the engine reference.
	 */
	private async rollback(
		before: { lease: boolean; holding: boolean; engine: boolean },
		prev: {
			state: JobState
			reason?: PauseReason | FailReason
			startedAt?: number
		},
	): Promise<void> {
		const { record } = this
		const released = !before.lease && this.lease !== null
		if (!before.lease && this.lease) {
			const lease = this.lease
			this.lease = null
			await this.releaseLease(lease, true).catch((err: unknown) =>
				this.log.warn({ err }, "Releasing the lease on rollback failed"),
			)
		}
		if (!before.holding && this.holdingDecoders) {
			this.holdingDecoders = false
			await this.deps.decoders
				.releaseSource(this.sourceId, record.id)
				.catch((err: unknown) =>
					this.log.warn(
						{ err },
						"Releasing the decoder hold on rollback failed",
					),
				)
		}
		if (!before.engine && this.engineOpened) {
			this.engineOpened = false
			await this.deps
				.closeEngine(this.sourceId)
				.catch((err: unknown) =>
					this.log.warn({ err }, "Closing the engine on rollback failed"),
				)
		}
		if (released) await this.refreshTuning()
		record.state = prev.state
		if (prev.reason === undefined) delete record.reason
		else record.reason = prev.reason
		if (prev.startedAt === undefined) delete record.startedAt
		else record.startedAt = prev.startedAt
		record.updatedAt = this.deps.now()
		this.deps.changed("state")
	}

	private queueEvent(e: JobEvent): void {
		if (this.queued.has(e.type)) return
		this.queued.add(e.type)
		queueMicrotask(() => {
			this.queued.delete(e.type)
			this.dispatch(e).catch((err: unknown) => {
				if (
					err instanceof ScannerApiError &&
					err.code === "SCANNER_INVALID_TRANSITION"
				)
					return
				this.log.warn({ err, event: e.type }, "Queued job event failed")
			})
		})
	}

	private async apply(e: JobEvent): Promise<void> {
		const { record } = this
		const operatorAutoResume =
			e.type === "preemptor-idle" &&
			(record.reason === "preempted-operator" ||
				record.reason === "preempted-relay")
		if (operatorAutoResume && !(this.deps.autoResumeReady?.() ?? true)) return
		if (e.type === "resume" || e.type === "start")
			this.autoResumeGuardActive = false
		if (e.type === "preemptor-idle")
			this.autoResumeGuardActive = operatorAutoResume
		const heldBefore = this.lease !== null
		// The arbiter has already revoked the lease, whatever this job's state: never keep a stale one.
		if (LOST_EVENTS.has(e.type)) this.lease = null
		const from =
			record.reason === undefined
				? { state: record.state }
				: { state: record.state, reason: record.reason }
		const leaseHeld = this.lease !== null
		const t = transition(from, e, {
			leaseHeld,
			engineOpened: this.engineOpened,
		})
		if ("invalid" in t) {
			throw new ScannerApiError(
				`Job ${record.id} cannot handle "${e.type}" in state ${record.state}`,
				"SCANNER_INVALID_TRANSITION",
				409,
			)
		}
		// S1-B final review, finding 8 (and re-review R1): a lease-less operator resume re-takes the tuner
		// from the operator, or from a lower-priority holder by hand-over, so it needs consent as
		// createJob does. A holder of equal or higher priority refuses the acquire below (resume-blocked).
		if (
			this.sweep &&
			e.type === "resume" &&
			!e.takeover &&
			record.state === "paused" &&
			record.reason === "operator" &&
			!leaseHeld &&
			(this.deps.arbiter.holderPriority(this.sourceId) ?? -1) <
				record.spec.priority
		) {
			const impact = this.deps.impact()
			if (impactGrew(impact, record.consentedImpact))
				throw new ScannerApiError(
					"Resuming disturbs consumers started since the operator took the tuner; resend with takeover",
					"SCANNER_TAKEOVER_REQUIRED",
					409,
					{ impact },
				)
		}
		const actions = actionsForMode(record.spec.mode, t.actions)
		const before = {
			lease: this.lease !== null,
			holding: this.holdingDecoders,
			engine: this.engineOpened,
		}
		const prev = {
			state: record.state,
			...(record.reason !== undefined ? { reason: record.reason } : {}),
			...(record.startedAt !== undefined
				? { startedAt: record.startedAt }
				: {}),
		}
		if (actions.includes("acquire-lease")) {
			const r = this.deps.arbiter.acquire(
				record.id,
				this.sourceId,
				record.spec.priority,
			)
			if (!r.ok) {
				// An operator pause whose lease was revoked cannot go back to running without one.
				if (
					e.type === "resume" &&
					record.state === "paused" &&
					record.reason === "operator" &&
					!leaseHeld &&
					!TRANSIENT_REFUSALS.has(r.detail)
				)
					await this.blockResume()
				const details = {
					...(r.reason !== undefined ? { reason: r.reason } : {}),
					...(r.holderJobId !== undefined
						? { holderJobId: r.holderJobId }
						: {}),
				}
				throw new ScannerApiError(
					r.detail,
					r.code,
					409,
					Object.keys(details).length > 0 ? details : undefined,
				)
			}
			this.lease = r.lease
			// Finding 2: an open engine takes the new holder's tuning before the hop is re-sent (the
			// reconfigure starts a new stream, which would drop a hop already in flight).
			if (this.engineOpened) await this.refreshTuning()
		}
		const now = this.deps.now()
		record.state = t.state
		if (t.reason === undefined) delete record.reason
		else record.reason = t.reason
		record.updatedAt = now
		if (t.state === "running" && record.startedAt === undefined)
			record.startedAt = now
		if (e.type === "resume" && e.takeover)
			record.consentedImpact = this.deps.impact()
		try {
			for (const action of this.ordered(actions)) {
				await this.run(action)
			}
		} catch (err) {
			// A failed action (e.g. the engine cannot start before the source has caps) must not
			// leave the job in "starting" holding a lease or a decoder hold.
			await this.rollback(before, prev)
			throw err
		}
		if (!this.driving) this.epochOwn = false
		if (isTerminal(t.state)) {
			this.releaseAnalogSession?.()
			this.releaseAnalogSession = undefined
			record.endedAt = now
			await this.teardown()
		}
		// Finding 2: the remaining consumers return to the defaults (or the next holder's tuning).
		if (heldBefore && this.lease === null) await this.refreshTuning()
		this.deps.persist()
		this.deps.changed("state")
	}

	/** Finding 2: engine tuning follows the lease holder, the scheduler's block geometry the engine. Never rejects. */
	private async refreshTuning(): Promise<void> {
		if (!this.sweep) return
		await this.deps
			.refreshTuning(this.sourceId)
			.catch((err: unknown) =>
				this.log.warn({ err }, "Re-applying the engine tuning failed"),
			)
		this.syncGeometry()
	}

	private syncGeometry(): void {
		const cfg = this.deps.engine(this.sourceId)?.config()
		if (this.scheduler && cfg)
			this.scheduler.setBlockGeometry(blockSamplesOf(cfg), cfg.sampleRateHz)
	}

	/** Resume refused (another job holds the lease): `paused(resume-blocked)`, as a grown impact would. */
	private async blockResume(): Promise<void> {
		const { record } = this
		record.state = "paused"
		record.reason = "resume-blocked"
		record.impact = this.deps.impact()
		record.updatedAt = this.deps.now()
		if (this.holdingDecoders) {
			this.holdingDecoders = false
			await this.deps.decoders
				.releaseSource(this.sourceId, record.id)
				.catch((err: unknown) =>
					this.log.warn({ err }, "Releasing the decoder hold failed"),
				)
		}
		this.deps.persist()
		this.deps.changed("state")
	}

	/** `restore` must run before `release-lease` (it releases with restore). */
	private ordered(actions: JobAction[]): JobAction[] {
		return [...actions].sort(
			(a, b) => Number(b === "restore") - Number(a === "restore"),
		)
	}

	private async run(action: JobAction): Promise<void> {
		const { record } = this
		switch (action) {
			case "acquire-lease":
				return
			case "restore":
			case "release-lease": {
				const lease = this.lease
				this.lease = null
				if (!lease) return
				const res = await this.releaseLease(lease, action === "restore")
				record.unrestorable = res.unrestorable
				return
			}
			case "hold-decoders":
				// Awaited: configured decoders are suspended before open-engine / resend-hop retune (§ 10.4).
				await this.deps.decoders.holdSource(
					this.sourceId,
					"tuner-scanning",
					record.id,
				)
				this.holdingDecoders = true
				return
			case "release-decoders":
				if (this.holdingDecoders)
					await this.deps.decoders.releaseSource(this.sourceId, record.id)
				this.holdingDecoders = false
				return
			case "stop-probes":
				for (const hold of this.windowHolds.values())
					if (hold.timer) clearTimeout(hold.timer)
				this.windowHolds.clear()
				await this.deps.probes.releaseJob(record.id)
				return
			case "open-engine":
				await this.openEngine()
				return
			case "resend-hop":
				await this.resendHop()
				return
			case "report-impact":
				record.impact = this.deps.impact()
				return
		}
	}

	/** A new stream can retain old cumulative stats; only its ring proves current IQ admission. */
	private hasCurrentIq(engine: SpectrumEngine | undefined): boolean {
		if (!engine) return false
		const { stream, liveEdge } = engine.accounting()
		return (
			stream === engine.currentEpoch().stream &&
			liveEdge > 0 &&
			engine.readRing(liveEdge - 1, liveEdge) !== null
		)
	}

	private async openEngine(): Promise<void> {
		const engine = await this.deps.openEngine(this.sourceId)
		this.engineOpened = true
		if (!this.sweep) {
			if (
				engine.currentEpoch().startSample !== null &&
				(this.record.spec.kind !== "identify" || this.hasCurrentIq(engine))
			)
				this.queueEvent({ type: "engine-ready" })
			return
		}
		if (this.scheduler) {
			await this.resendHop()
			return
		}
		const cfg = engine.config()
		if (!cfg)
			throw new WaveKitError(
				"Spectrum engine has no pipeline",
				"SCANNER_ENGINE_MISSING",
			)
		this.scheduler = new SweepScheduler(this.record.plan, this.record.spec, {
			blockSamples: blockSamplesOf(cfg),
			sampleRateHz: cfg.sampleRateHz,
			now: this.deps.now,
			probeStartMs: this.deps.probes.startLatencyMs("dsd-fme", "offset"),
			minSurfaceBlocks: this.deps.settings().detection.minSurfaceBlocks,
			...(this.deps.activitySeed
				? { activitySeed: this.deps.activitySeed }
				: {}),
		})
		if (this.record.spec.tuner.agc !== null && this.lease) {
			await this.deps.arbiter.setAgc(this.lease, this.record.spec.tuner.agc)
		}
		this.exec(this.scheduler.start())
	}

	/** § 4.7: the source moved without a command we saw. A sweep re-asserts its hop (re-establishes `commanded`). */
	onUntrackedRetune(): void {
		if (!this.sweep || !this.lease) return
		this.epochOwn = false
		this.actionChain = this.actionChain
			.then(() => this.resendHop())
			.catch((err: unknown) =>
				this.log.warn(
					{ err },
					"Re-sending the hop after an untracked retune failed",
				),
			)
	}

	private async resendHop(): Promise<void> {
		if (!this.lease || this.hopCentre === null || this.hopIndex === undefined)
			return
		await this.tune({
			type: "tune",
			hopIndex: this.hopIndex,
			centreHz: this.hopCentre,
			gainTenthsDb: this.record.spec.tuner.gainTenthsDb,
		})
	}

	private exec(actions: SchedulerAction[]): void {
		if (actions.length === 0) return
		this.actionChain = this.actionChain
			.then(() => this.execNow(actions))
			.catch((err: unknown) =>
				this.log.warn({ err }, "Scheduler action failed"),
			)
	}

	private async execNow(actions: SchedulerAction[]): Promise<void> {
		for (const a of actions) {
			switch (a.type) {
				case "tune":
					await this.tune(a)
					break
				case "start-probe": {
					const t = this.tracks.get(a.trackId)
					if (!t || !this.driving) break
					// The scheduler committed this hold before a signals-only patch.
					// Do not request a probe or enter holding; leave the hop.
					if (this.record.spec.signalsOnly === true) {
						if (this.scheduler)
							this.exec(this.scheduler.abandonUnstartedConfirm())
						break
					}
					this.requestProbe(t.live, t.track, a.holdMs)
					if (this.record.state === "running") this.queueEvent({ type: "hold" })
					break
				}
				case "stop-probes":
					await this.deps.probes.releaseJob(this.record.id)
					if (this.record.state === "holding")
						this.queueEvent({ type: "hold-done" })
					break
				case "sweep-complete": {
					const after = this.record.spec.stop.afterSweeps
					if (after !== null && a.sweepIndex + 1 >= after)
						this.queueEvent({ type: "stop-condition" })
					this.deps.changed("progress")
					break
				}
			}
		}
	}

	private async tune(
		a: Extract<SchedulerAction, { type: "tune" }>,
	): Promise<void> {
		const lease = this.lease
		if (!lease) return
		this.hopIndex = a.hopIndex
		this.hopCentre = a.centreHz
		this.epochOwn = false
		// Paused: the hop is remembered and sent by the resume's resend-hop.
		if (!this.driving) return
		this.retunes += 1
		try {
			const pending = await this.deps.arbiter.retune(
				lease,
				{
					centreHz: a.centreHz,
					gainTenthsDb: a.gainTenthsDb,
					sampleRateHz: this.record.spec.tuner.sampleRateHz,
				},
				this.autoResumeGuardActive
					? () => this.deps.autoResumeReady?.() ?? true
					: undefined,
			)
			this.autoResumeGuardActive = false
			// R 1.2: only an explicit no-op has no epoch-started event to resume the visit.
			// A real retune can emit that event before its promise resolves.
			this.addOwnEpoch(pending.epoch)
			if (pending.skipped === true && this.driving && this.scheduler) {
				this.epochOwn = true
				this.exec(this.scheduler.onTuneSkipped())
			}
		} catch (err) {
			if (err instanceof WaveKitError && err.code === "SCANNER_RESUME_HELD") {
				this.queueEvent({ type: "rest-write" })
				return
			}
			if (err instanceof WaveKitError && err.code === "SCANNER_LEASE_LOST")
				return
			this.log.warn({ err, hopIndex: a.hopIndex }, "Retune failed")
			if (this.record.state === "starting")
				this.queueEvent({ type: "tuner-error" })
		} finally {
			this.retunes -= 1
		}
		this.deps.changed("progress")
	}

	private confirmHoldMs(live: LiveObservation): number {
		const cls = live.classification.class
		const configured = this.record.spec.hold.confirmHoldMs[cls]
		return (
			(configured ?? DEFAULT_CONFIRM_HOLD_MS[cls]) +
			this.deps.probes.startLatencyMs("dsd-fme", "offset")
		)
	}

	/** Called by the service for actual mode starts, including queued admissions and steps. */
	noteTrialStarted(req: ProbeRequest, mode: ProbeMode): void {
		if (req.jobId !== this.record.id || req.replay) return
		const key =
			req.discoveryId ?? `${req.sourceId}:${Math.round(req.targetHz / 6250)}`
		this.trialRotation.attempt(
			key,
			`${mode.decoderType}:${JSON.stringify(mode.options)}`,
		)
	}

	private requestProbe(
		live: LiveObservation,
		track: TrackSnapshot,
		holdMs: number,
	) {
		if (this.record.spec.signalsOnly === true) return null
		const s = this.deps.settings()
		if (this.record.passive && !s.passive.offsetProbes) return null
		const engine = this.deps.engine(this.sourceId)
		const fs = engine?.currentEpoch().sampleRateHz ?? 0
		const protocols = protocolsForFrequency(this.record.spec, track.centreHz)
		const modeKey = (mode: ProbeMode) =>
			`${mode.decoderType}:${JSON.stringify(mode.options)}`
		const classModes = probeModesFor(live.classification.class, protocols)
		const candidates = jobTrialModes(
			live.classification.class,
			protocols,
			track.obwHz,
		)
		const originalHead = classModes[0]
		if (originalHead) {
			const head = candidates.find(
				mode => modeKey(mode) === modeKey(originalHead),
			)
			if (head)
				head.holdMs = Math.max(
					head.holdMs,
					holdMs -
						classModes.slice(1).reduce((sum, mode) => sum + mode.holdMs, 0),
				)
		}
		const key =
			live.discoveryId ??
			`${this.sourceId}:${Math.round(track.centreHz / 6250)}`
		const modes = this.trialRotation.order(key, candidates, modeKey)
		const req: ProbeRequest = {
			jobId: this.record.id,
			priority: this.record.spec.priority,
			...(live.gatePassedAt !== undefined
				? { gatePassedAt: live.gatePassedAt }
				: {}),
			sourceId: this.sourceId,
			trackId: track.trackId,
			observationId: live.observationId,
			discoveryId: live.discoveryId,
			targetHz: track.centreHz,
			epoch: live.epoch,
			cls: live.classification.class,
			protocols,
			modes,
			preRollFromSample: Math.max(
				0,
				track.startSample - Math.round((s.hold.preRollMs * fs) / 1000),
			),
			holdMs,
			record: this.record.spec.record.voice,
			admission: {
				kind:
					protocols.length > 0
						? "protocol-target"
						: live.decoded
							? "reconfirm"
							: "undecoded",
				snrDb: track.snrDb,
			},
		}
		const res = this.deps.probes.request(req)
		if ("started" in res) {
			live.probeIds.add(res.started)
		} else {
			const reason = undecodedForDeferral(res.deferred)
			if (reason) this.deps.undecoded(live, reason)
		}
		return res
	}
}
