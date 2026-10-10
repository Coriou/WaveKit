/**
 * One discovery job (spec § 10.1–§ 10.5): the transition table, the sweep
 * scheduler, the lease and decoder hold, probe requests and progress.
 * Observations are owned by ScannerService; the runner gets per-job callbacks.
 */
import type { ScanJobProgress, ScanJobProbe } from "@wavekit/api-types"
import type { DecoderManager } from "../../decoders/manager.js"
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
import type { ProbePool, ProbeRequest } from "./probes/probe-pool.js"
import { SweepScheduler, type SchedulerAction } from "./scheduler.js"
import type {
	EngineEpoch,
	SpectrumEngine,
} from "../spectrum/spectrum-engine.js"
import type { Lease, TunerArbiter } from "./tuner-arbiter.js"
import type {
	Classification,
	DecodeEvidence,
	FailReason,
	HopPlan,
	Impact,
	JobState,
	NormalisedJobSpec,
	PauseReason,
	PlanIssue,
	ScanJobSpec,
	ScannerConfidence,
	ScannerSettings,
	UndecodedReason,
} from "./types.js"
import type { TrackSnapshot } from "../spectrum/types.js"

export interface JobRecord {
	id: string
	name: string | null
	passive: boolean
	rawSpec: ScanJobSpec
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
}

export interface LiveObservation {
	observationId: string
	sourceId: string
	trackId: string
	epoch: number
	jobIds: string[]
	discoveryId: string | null
	startedAt: number
	endedAt?: number
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
	record: JobRecord
	arbiter: Pick<
		TunerArbiter,
		"acquire" | "retune" | "release" | "setAgc" | "holder" | "operatorIdleSince"
	>
	probes: Pick<
		ProbePool,
		| "request"
		| "release"
		| "releaseJob"
		| "follow"
		| "status"
		| "startLatencyMs"
	>
	decoders: Pick<DecoderManager, "holdSource" | "releaseSource">
	settings: () => ScannerSettings
	openEngine: (sourceId: string) => Promise<SpectrumEngine>
	closeEngine: (sourceId: string) => Promise<void>
	engine: (sourceId: string) => SpectrumEngine | undefined
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
}

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

function inRange(hz: number, r: { startHz: number; endHz: number }): boolean {
	return hz >= r.startHz && hz <= r.endHz
}

export class JobRunner implements JobDriver {
	readonly record: JobRecord
	private readonly log: Logger
	private scheduler: SweepScheduler | null = null
	private lease: Lease | null = null
	private holdingDecoders = false
	private engineOpened = false
	private ownEpochs = new Set<number>()
	private epochOwn = false
	/** Retunes awaiting the arbiter (their epoch may start before `retune()` resolves). */
	private retunes = 0
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
		{ probeId: string; timer: NodeJS.Timeout | null; following: boolean }
	>()

	constructor(private readonly deps: JobRunnerDeps) {
		this.record = deps.record
		this.log = createComponentLogger(deps.logger, `Job:${deps.record.id}`)
	}

	private get sweep(): boolean {
		return this.record.spec.mode === "sweep"
	}

	private get sourceId(): string {
		return this.record.spec.sourceId
	}

	async start(): Promise<void> {
		await this.dispatch({ type: "start" })
	}

	dispatch(e: JobEvent): Promise<void> {
		const run = this.chain.then(() => this.apply(e))
		this.chain = run.catch(() => undefined)
		return run
	}

	idle(): Promise<void> {
		return Promise.all([this.chain, this.actionChain]).then(() => undefined)
	}

	covers(sourceId: string, hz: number): boolean {
		const { spec, state } = this.record
		if (sourceId !== spec.sourceId || !ACTIVE.has(state)) return false
		if (spec.ranges.length > 0 && !spec.ranges.some(r => inRange(hz, r)))
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
		const probes: ScanJobProbe[] = this.deps.probes
			.status()
			.filter(s => s.jobId === this.record.id)
			.map(s => ({
				probeId: s.probeId,
				decoderId: s.decoderId,
				trackId: s.trackId,
				targetHz: s.targetHz,
				protocol: s.protocol,
				transport: s.transport,
				state: s.state === "starting" ? "confirming" : s.state,
				startedAt: new Date(s.startedAt).toISOString(),
			}))
		return {
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
	}

	tick(now: number): void {
		const { state, reason, spec } = this.record
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
		if (this.record.state === "starting" && (!this.sweep || own))
			this.queueEvent({ type: "engine-ready" })
		if (!this.sweep) return
		this.epochOwn = own && epoch.tuningTrust === "commanded"
		if (this.epochOwn && epoch.startSample !== null && this.scheduler) {
			this.exec(this.scheduler.onEpochStarted(epoch.startSample))
		}
	}

	onBlock(endSample: number, overload: boolean): void {
		if (!this.sweep || !this.epochOwn || !this.scheduler) return
		if (overload && this.hopIndex !== undefined)
			this.scheduler.onOverload(this.hopIndex)
		this.exec(this.scheduler.onBlock(endSample))
	}

	onStale(blocks: number): void {
		if (this.sweep && this.epochOwn) this.scheduler?.onStale(blocks)
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
		if (this.sweep && this.scheduler) {
			const holdMs = needsConfirm ? this.confirmHoldMs(live) : 0
			this.exec(
				this.scheduler.onTrack(
					track,
					needsConfirm && policy !== "never",
					holdMs,
				),
			)
			return
		}
		if (
			!needsConfirm ||
			policy === "never" ||
			this.windowHolds.has(track.trackId)
		)
			return
		const holdMs = this.confirmHoldMs(live)
		const res = this.requestProbe(live, track, holdMs)
		if (!res || !("started" in res)) return
		const timer = setTimeout(() => {
			const hold = this.windowHolds.get(track.trackId)
			if (hold && !hold.following) {
				this.windowHolds.delete(track.trackId)
				this.releaseProbe(hold.probeId)
			}
		}, holdMs)
		timer.unref()
		this.windowHolds.set(track.trackId, {
			probeId: res.started,
			timer,
			following: false,
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
		this.scheduler?.replan(plan, spec)
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
		await this.idle()
		await this.teardown()
	}

	// === internals ===

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
			await this.deps.decoders.releaseSource(this.sourceId, this.record.id)
		}
		if (this.engineOpened) {
			this.engineOpened = false
			await this.deps.closeEngine(this.sourceId)
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
		// The arbiter has already revoked the lease, whatever this job's state: never keep a stale one.
		if (LOST_EVENTS.has(e.type)) this.lease = null
		const from =
			record.reason === undefined
				? { state: record.state }
				: { state: record.state, reason: record.reason }
		const t = transition(from, e)
		if ("invalid" in t) {
			throw new ScannerApiError(
				`Job ${record.id} cannot handle "${e.type}" in state ${record.state}`,
				"SCANNER_INVALID_TRANSITION",
				409,
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
			if (!r.ok) throw new ScannerApiError(r.detail, r.code, 409)
			this.lease = r.lease
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
			for (const action of this.ordered(actions)) await this.run(action)
		} catch (err) {
			// A failed action (e.g. the engine cannot start before the source has caps) must not
			// leave the job in "starting" holding a lease or a decoder hold.
			await this.rollback(before, prev)
			throw err
		}
		if (isTerminal(t.state)) {
			record.endedAt = now
			await this.teardown()
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

	private async openEngine(): Promise<void> {
		const engine = await this.deps.openEngine(this.sourceId)
		this.engineOpened = true
		if (!this.sweep) {
			if (engine.currentEpoch().startSample !== null)
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
		const frames = Math.max(
			1,
			Math.round((cfg.integrationMs * cfg.sampleRateHz) / (cfg.fftSize * 1000)),
		)
		this.scheduler = new SweepScheduler(this.record.plan, this.record.spec, {
			blockSamples: frames * cfg.fftSize,
			sampleRateHz: cfg.sampleRateHz,
			now: this.deps.now,
			probeStartMs: this.deps.probes.startLatencyMs("dsd-fme", "offset"),
			minSurfaceBlocks: this.deps.settings().detection.minSurfaceBlocks,
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
					if (!t) break
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
		this.retunes += 1
		try {
			const pending = await this.deps.arbiter.retune(lease, {
				centreHz: a.centreHz,
				gainTenthsDb: a.gainTenthsDb,
				sampleRateHz: this.record.spec.tuner.sampleRateHz,
			})
			this.addOwnEpoch(pending.epoch)
		} catch (err) {
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

	private requestProbe(
		live: LiveObservation,
		track: TrackSnapshot,
		holdMs: number,
	) {
		const s = this.deps.settings()
		if (this.record.passive && !s.passive.offsetProbes) return null
		const engine = this.deps.engine(this.sourceId)
		const fs = engine?.currentEpoch().sampleRateHz ?? 0
		const req: ProbeRequest = {
			jobId: this.record.id,
			priority: this.record.spec.priority,
			sourceId: this.sourceId,
			trackId: track.trackId,
			observationId: live.observationId,
			discoveryId: live.discoveryId,
			targetHz: track.centreHz,
			epoch: live.epoch,
			cls: live.classification.class,
			protocols: this.record.spec.protocols,
			preRollFromSample: Math.max(
				0,
				track.startSample - Math.round((s.hold.preRollMs * fs) / 1000),
			),
			holdMs,
			record: this.record.spec.record.voice,
			admission: {
				kind:
					this.record.spec.protocols.length > 0
						? "protocol-target"
						: live.decoded
							? "reconfirm"
							: "undecoded",
				snrDb: track.snrDb,
			},
		}
		const res = this.deps.probes.request(req)
		if ("started" in res) live.probeIds.add(res.started)
		else {
			const reason = undecodedForDeferral(res.deferred)
			if (reason) this.deps.undecoded(live, reason)
		}
		return res
	}
}
