/**
 * Tuner leases for sweep jobs (spec § 10.3, § 10.4). The scanner sends tuner
 * commands only through here; each carries origin "scanner". Test-mode
 * markers bracket every retune and are never accepted state (§ 4.6).
 */
import { EventEmitter } from "node:events"
import type {
	TunerCommandOrigin,
	TunerControlMode,
	TunerState,
} from "@wavekit/api-types"
import type { DecoderManager } from "../../decoders/manager.js"
import type { DigitalVoiceService } from "../digital-voice.js"
import type { LiveDemodulator } from "../live-demodulator.js"
import type { SourceManager } from "../source-manager.js"
import type { TunerController, TunerWriteOptions } from "../tuner-controller.js"
import { createComponentLogger, type Logger } from "../../utils/logger.js"
import { WaveKitError } from "../../utils/errors.js"
import { gainKeyOf, type EpochClock } from "../spectrum/spectrum-engine.js"
import type { LeaseTunerFields, PersistedLease } from "./store/persistence.js"
import type { Impact, NormalisedJobSpec, ScannerSettings } from "./types.js"
import type { PendingEpoch } from "../spectrum/types.js"
import { ConstructorListenerRegistration } from "./channel/consumer-lifecycle.js"

export type TunerFieldValues = LeaseTunerFields
export type LeaseLostReason =
	| "preempted-operator"
	| "preempted-relay"
	| "preempted-job"

export interface Lease {
	sourceId: string
	jobId: string
	acquiredAt: number
	snapshot: Partial<TunerFieldValues>
	changedFields: Set<keyof TunerFieldValues>
}

/**
 * API `details.reason` of every `SCANNER_SOURCE_BUSY` (S1-B final review, finding 4). The first three
 * clear by themselves (worth a retry); `relay` and `held` last until the relay or the holder lets go.
 */
export type SourceBusyReason =
	| "releasing"
	| "recovery-pending"
	| "holder-starting"
	| "relay"
	| "held"

export interface AcquireRefusal {
	ok: false
	code: "SCANNER_SOURCE_BUSY" | "SCANNER_NO_TUNER_CONTROL"
	detail: string
	/** Set on every `SCANNER_SOURCE_BUSY` (API `details.reason`). */
	reason?: SourceBusyReason
	/** The job holding the lease, when one does (API `details.holderJobId`). */
	holderJobId?: string
}

export type ArbiterTuner = Pick<
	TunerController,
	| "getState"
	| "setFrequency"
	| "setSampleRate"
	| "setGainMode"
	| "setGain"
	| "setAgcMode"
	| "setTestMode"
	| "on"
	| "off"
>

export interface ArbiterDeps {
	tuner: ArbiterTuner
	sources: Pick<SourceManager, "on" | "off" | "isRtlTcpSource">
	epochs: (sourceId: string) => EpochClock | undefined
	settings: () => ScannerSettings
	/** Timer-mode settle class of the source's transport (§ 4.6). */
	link: (sourceId: string) => "local" | "network"
	persistLease: (
		sourceId: string,
		lease: PersistedLease | null,
	) => Promise<void>
	impactSources: {
		liveDemod: Pick<LiveDemodulator, "getStatus"> | null
		digitalVoice: Pick<DigitalVoiceService, "getStatus"> | null
		decoders: Pick<DecoderManager, "getAllStatus">
	}
	/** Ids of active scanner jobs on the source (other than `exceptJobId`). */
	scannerJobsOn: (sourceId: string, exceptJobId?: string) => string[]
	/**
	 * Whether the holder may lose the lease to a higher-priority job now. ScannerService answers
	 * `state !== "starting"`: `preempted-job` is invalid from `starting` (ruling R1).
	 */
	canHandOver: (jobId: string) => boolean
	logger: Logger
	now?: () => number
	/** Captures each of the six exact removers before constructor registration can throw. */
	ownConstructorListener?: (removeExact: () => void) => boolean
}

const FIELDS: readonly (keyof TunerFieldValues)[] = [
	"sampleRate",
	"frequency",
	"gainMode",
	"gain",
	"agcMode",
]

function toError(err: unknown): Error {
	return err instanceof Error
		? err
		: new WaveKitError(String(err), "SCANNER_TUNER_WRITE")
}

export class TunerArbiter extends EventEmitter {
	private readonly constructorListeners: ConstructorListenerRegistration[] = []
	private readonly log: Logger
	private readonly now: () => number
	private readonly leases = new Map<string, Lease>()
	private readonly priorities = new Map<string, number>()
	private readonly lost = new WeakSet<Lease>()
	private readonly recovering = new Map<string, PersistedLease>()
	/** Sources whose recovery is running; the record stays in `recovering` until it completes. */
	private readonly recoveryRunning = new Set<string>()
	/** Sources with a payload-started since their last disconnect. */
	private readonly connected = new Set<string>()
	/** Leases carrying a crashed sweep's record (adopted, or handed over from an adopted lease). */
	private readonly adopted = new WeakSet<Lease>()
	/** Sources whose released lease is still sending TEST_MODE 0 and the restore. */
	private readonly releasing = new Set<string>()
	private readonly lastOperatorAt = new Map<string, number>()
	/** Sources with TEST_MODE 1 sent and no successful TEST_MODE 0 since. */
	private readonly markerOpen = new Set<string>()

	constructor(private readonly deps: ArbiterDeps) {
		super()
		this.log = createComponentLogger(deps.logger, "TunerArbiter")
		this.now = deps.now ?? Date.now
		try {
			this.listen(deps.tuner, "command-sent", this.onCommandSent,
				() => { deps.tuner.on("command-sent", this.onCommandSent) },
				() => { deps.tuner.off("command-sent", this.onCommandSent) })
			this.listen(deps.tuner, "control-mode-changed", this.onControlMode,
				() => { deps.tuner.on("control-mode-changed", this.onControlMode) },
				() => { deps.tuner.off("control-mode-changed", this.onControlMode) })
			this.listen(deps.sources, "disconnected", this.onDisconnected,
				() => { deps.sources.on("disconnected", this.onDisconnected) },
				() => { deps.sources.off("disconnected", this.onDisconnected) })
			this.listen(deps.sources, "removed", this.onRemoved,
				() => { deps.sources.on("removed", this.onRemoved) },
				() => { deps.sources.off("removed", this.onRemoved) })
			this.listen(deps.sources, "source-removed", this.onRemoved,
				() => { deps.sources.on("source-removed", this.onRemoved) },
				() => { deps.sources.off("source-removed", this.onRemoved) })
			this.listen(deps.sources, "payload-started", this.onPayloadStarted,
				() => { deps.sources.on("payload-started", this.onPayloadStarted) },
				() => { deps.sources.off("payload-started", this.onPayloadStarted) })
		} catch (error: unknown) {
			// Parent captured every remover before effects. Cleanup failure cannot replace the
			// original exception; that parent's retained inventory can attempt the failed remover.
			try { this.dispose() } catch { /* retained by the external construction owner */ }
			throw error
		}
	}

	private listen(
		emitter: object,
		event: string,
		listener: (...args: never[]) => void,
		install: () => void,
		remove: () => void,
	): void {
		const registration = new ConstructorListenerRegistration(install, remove,
			() => emitter instanceof EventEmitter && !emitter.listeners(event).includes(listener))
		this.constructorListeners.push(registration)
		registration.register(this.deps.ownConstructorListener)
	}

	dispose(): void {
		let first: unknown
		let failed = false
		for (const registration of this.constructorListeners) {
			try { registration.remove() } catch (error: unknown) {
				if (!failed) first = error
				failed = true
			}
		}
		if (failed) throw first
	}

	holder(sourceId: string): Lease | undefined {
		return this.leases.get(sourceId)
	}

	/** The holder's priority: an acquire above it hands the lease over, at or below it is refused. */
	holderPriority(sourceId: string): number | undefined {
		return this.leases.has(sourceId)
			? (this.priorities.get(sourceId) ?? 0)
			: undefined
	}

	acquire(
		jobId: string,
		sourceId: string,
		priority: number,
	): { ok: true; lease: Lease } | AcquireRefusal {
		const state = this.deps.tuner.getState(sourceId)
		if (!state || !this.deps.sources.isRtlTcpSource(sourceId)) {
			return {
				ok: false,
				code: "SCANNER_NO_TUNER_CONTROL",
				detail: `Source ${sourceId} has no rtl_tcp tuner control`,
			}
		}
		if (state.controlMode === "external") {
			return {
				ok: false,
				code: "SCANNER_SOURCE_BUSY",
				detail: "A tuner relay client controls the tuner",
				reason: "relay",
			}
		}
		if (this.releasing.has(sourceId)) {
			// The restore of the previous lease is still writing: a snapshot now would catch its last hop.
			return {
				ok: false,
				code: "SCANNER_SOURCE_BUSY",
				detail: "releasing",
				reason: "releasing",
			}
		}
		const current = this.leases.get(sourceId)
		if (current?.jobId === jobId) return { ok: true, lease: current }
		if (current) {
			if ((this.priorities.get(sourceId) ?? 0) >= priority) {
				return {
					ok: false,
					code: "SCANNER_SOURCE_BUSY",
					detail: `Lease held by scanner job ${current.jobId}`,
					reason: "held",
					holderJobId: current.jobId,
				}
			}
			if (!this.deps.canHandOver(current.jobId)) {
				return {
					ok: false,
					code: "SCANNER_SOURCE_BUSY",
					detail: "holder is starting",
					reason: "holder-starting",
					holderJobId: current.jobId,
				}
			}
			// Hand-over: the new job keeps the snapshot (§ 10.1 preempted-job row).
			const lease: Lease = {
				sourceId,
				jobId,
				acquiredAt: this.now(),
				snapshot: { ...current.snapshot },
				changedFields: new Set(current.changedFields),
			}
			if (this.adopted.has(current)) this.adopted.add(lease)
			this.lost.add(current)
			this.leases.set(sourceId, lease)
			this.priorities.set(sourceId, priority)
			void this.persist(lease)
			this.emit("lease-lost", current, "preempted-job")
			return { ok: true, lease }
		}
		const pending = this.recovering.get(sourceId)
		if (pending && !this.connected.has(sourceId)) {
			// Writes fail until the source connects; adopting now could drop the record on rollback.
			return {
				ok: false,
				code: "SCANNER_SOURCE_BUSY",
				detail: "recovery pending",
				reason: "recovery-pending",
			}
		}
		if (pending)
			return { ok: true, lease: this.adopt(pending, jobId, priority) }
		const lease: Lease = {
			sourceId,
			jobId,
			acquiredAt: this.now(),
			snapshot: this.snapshotOf(state),
			changedFields: new Set(),
		}
		this.leases.set(sourceId, lease)
		this.priorities.set(sourceId, priority)
		void this.persist(lease)
		this.log.info(
			{ sourceId, jobId, snapshot: lease.snapshot },
			"Tuner lease acquired",
		)
		return { ok: true, lease }
	}

	async retune(
		lease: Lease,
		target: {
			centreHz: number
			gainTenthsDb: number | null
			sampleRateHz: number | null
		},
	): Promise<PendingEpoch> {
		this.assertHeld(lease)
		const { sourceId } = lease
		const clock = this.deps.epochs(sourceId)
		if (!clock)
			throw new WaveKitError(
				`No spectrum engine for ${sourceId}`,
				"SCANNER_ENGINE_MISSING",
			)
		const s = this.deps.settings()
		const opts: TunerWriteOptions = { origin: "scanner" }
		let state = this.requireState(sourceId)
		let rateChanged = false
		if (
			target.sampleRateHz !== null &&
			(target.sampleRateHz !== state.sampleRate ||
				(state.unknownFields ?? []).includes("sampleRate"))
		) {
			await this.markChanged(lease, ["sampleRate"])
			this.assertHeld(lease)
			clock.suppressExternal(true)
			try {
				await this.deps.tuner.setSampleRate(sourceId, target.sampleRateHz, opts)
			} catch (err) {
				throw new WaveKitError(
					`Sample rate write failed: ${toError(err).message}`,
					"SCANNER_TUNER_WRITE",
					toError(err),
				)
			} finally {
				clock.suppressExternal(false)
			}
			this.assertHeld(lease)
			state = this.requireState(sourceId)
			rateChanged = true
		}
		const fs = state.sampleRate
		// unknownFields values are placeholders (controller: gainMode "agc", gain 0), never a reason to skip a write.
		const unknown = new Set(state.unknownFields ?? [])
		const needsGainMode = unknown.has("gainMode") || state.gainMode !== "manual"
		const gainChange =
			target.gainTenthsDb !== null &&
			(needsGainMode ||
				unknown.has("gain") ||
				state.gain !== target.gainTenthsDb)
		// Persisted before the epoch and the first command: a crash mid-sequence keeps them for recovery.
		const changing: (keyof TunerFieldValues)[] = ["frequency"]
		if (gainChange)
			changing.push(
				...(needsGainMode
					? (["gainMode", "gain"] as const)
					: (["gain"] as const)),
			)
		await this.markChanged(lease, changing)
		this.assertHeld(lease)
		// The engine restarts the stream on a rate change and drops this hop's epoch, so no
		// marker would ever be expected for it: the hop runs unbracketed.
		const markers =
			s.sweep.markers && clock.markerSupported !== false && !rateChanged
		const { commandSample, bufferedSamples } = clock.sampleClock()
		const pending: PendingEpoch = {
			epoch: clock.allocateEpoch(),
			commandSample,
			bufferedSamples,
			settleSamples: Math.round(
				(s.sweep.settleMs[this.deps.link(sourceId)] * fs) / 1000,
			),
			expectMarker: markers,
			markerTimeoutSamples: Math.round((s.sweep.markerTimeoutMs * fs) / 1000),
			pllSettleSamples: Math.round((s.sweep.pllSettleMs * fs) / 1000),
			centreHz: target.centreHz,
			sampleRateHz: fs,
			gainKey:
				target.gainTenthsDb !== null
					? `m:${target.gainTenthsDb}`
					: gainKeyOf(state),
			tuningTrust: "commanded",
			centreChanged: target.centreHz !== clock.currentEpoch().centreHz,
		}
		clock.suppressExternal(true)
		clock.submitEpoch(pending)
		let failure: unknown = null
		try {
			if (markers) {
				this.markerOpen.add(sourceId)
				await this.deps.tuner.setTestMode(sourceId, true, {
					origin: "scanner",
					accept: false,
				})
				this.assertHeld(lease)
			}
			await this.deps.tuner.setFrequency(sourceId, target.centreHz, opts)
			if (gainChange && target.gainTenthsDb !== null) {
				this.assertHeld(lease)
				if (needsGainMode) {
					await this.deps.tuner.setGainMode(sourceId, "manual", opts)
					this.assertHeld(lease)
				}
				await this.deps.tuner.setGain(sourceId, target.gainTenthsDb, opts)
			}
		} catch (err) {
			failure = err
		} finally {
			if (markers) await this.testModeOff(sourceId)
			clock.suppressExternal(false)
		}
		if (failure !== null) {
			if (
				failure instanceof WaveKitError &&
				failure.code === "SCANNER_LEASE_LOST"
			)
				throw failure
			throw new WaveKitError(
				`Retune failed: ${toError(failure).message}`,
				"SCANNER_TUNER_WRITE",
				toError(failure),
			)
		}
		return pending
	}

	/** Job `tuner.agc` (sent once, inside the lease). */
	async setAgc(lease: Lease, enabled: boolean): Promise<void> {
		this.assertHeld(lease)
		await this.markChanged(lease, ["agcMode"])
		this.assertHeld(lease)
		await this.deps.tuner.setAgcMode(lease.sourceId, enabled, {
			origin: "scanner",
		})
	}

	async release(
		lease: Lease,
		opts: { restore: boolean },
	): Promise<{ restored: string[]; unrestorable: string[] }> {
		const held =
			this.leases.get(lease.sourceId) === lease && !this.lost.has(lease)
		this.lost.add(lease)
		if (!held) return { restored: [], unrestorable: [] }
		this.leases.delete(lease.sourceId)
		this.priorities.delete(lease.sourceId)
		this.releasing.add(lease.sourceId)
		try {
			return await this.releaseHeld(lease, opts)
		} finally {
			this.releasing.delete(lease.sourceId)
		}
	}

	private async releaseHeld(
		lease: Lease,
		opts: { restore: boolean },
	): Promise<{ restored: string[]; unrestorable: string[] }> {
		// § 4.6: TEST_MODE 0 on every release of a held lease, before any restore.
		await this.testModeOff(lease.sourceId)
		let result: { restored: string[]; unrestorable: string[] } = {
			restored: [],
			unrestorable: [],
		}
		// Changed fields with a known snapshot value that this release leaves unrestored.
		let missed: string[] = [...lease.changedFields].filter(
			f => lease.snapshot[f] !== undefined,
		)
		if (opts.restore) {
			const r = await this.restoreFields(lease.sourceId, lease.snapshot, [
				...lease.changedFields,
			])
			result = {
				restored: r.restored,
				unrestorable: [...r.unknown, ...r.failed],
			}
			missed = r.failed
		}
		if (missed.length > 0 && (opts.restore || this.adopted.has(lease))) {
			// The scan state is still on the tuner (a restore that failed, e.g. while the source is
			// disconnected, or a crashed sweep's record): recovery takes it back on the next connection,
			// after the controller's replay of the last hop (H4).
			const record = this.recordOf(lease)
			this.recovering.set(lease.sourceId, record)
			await this.deps
				.persistLease(lease.sourceId, record)
				.catch((err: unknown) => {
					this.log.warn(
						{ err, sourceId: lease.sourceId },
						"Re-persisting the crash recovery record failed",
					)
				})
			this.log.warn(
				{ sourceId: lease.sourceId, jobId: lease.jobId, missed },
				"Released a lease without a full restore; recovery re-queued for the next connection",
			)
		} else {
			await this.deps
				.persistLease(lease.sourceId, null)
				.catch((err: unknown) => {
					this.log.warn(
						{ err, sourceId: lease.sourceId },
						"Clearing the persisted lease failed",
					)
				})
		}
		this.log.info(
			{ sourceId: lease.sourceId, jobId: lease.jobId, ...result },
			"Tuner lease released",
		)
		return result
	}

	recoverPersistedLeases(persisted: PersistedLease[]): void {
		for (const lease of persisted) this.recovering.set(lease.sourceId, lease)
	}

	/** Since when nobody but the scanner touched the tuner (null while a relay holds control). */
	operatorIdleSince(sourceId: string): number | null {
		const state = this.deps.tuner.getState(sourceId)
		if (!state || state.controlMode === "external") return null
		return this.lastOperatorAt.get(sourceId) ?? 0
	}

	/** § 10.4. `exceptJobId`: the job asking, never counted among `scannerJobs`. */
	impact(
		sourceId: string,
		spec: NormalisedJobSpec,
		exceptJobId?: string,
	): Impact {
		const { liveDemod, digitalVoice, decoders } = this.deps.impactSources
		const statuses = decoders.getAllStatus()
		const onSource = statuses.filter(
			s => s.sourceId === sourceId && s.owner !== "scanner",
		)
		const ids = new Set(onSource.map(s => s.id))
		const live = liveDemod?.getStatus()
		const dv = digitalVoice?.getStatus()
		const state = this.deps.tuner.getState(sourceId)
		const unknown = new Set(state?.unknownFields ?? [])
		const changes: (keyof TunerFieldValues)[] = ["frequency"]
		if (spec.tuner.sampleRateHz !== null) changes.push("sampleRate")
		if (spec.tuner.gainTenthsDb !== null) changes.push("gainMode", "gain")
		if (spec.tuner.agc !== null) changes.push("agcMode")
		return {
			liveAudioClients:
				live?.running && live.sourceId === sourceId ? live.clientCount : 0,
			digitalVoiceListeners: (dv?.decoders ?? [])
				.filter(d => ids.has(d.decoderId))
				.reduce((sum, d) => sum + d.clientCount, 0),
			runningDecoders: onSource
				.filter(s => s.running && !s.suspended)
				.map(s => s.id),
			pinnedDecoders: onSource
				.filter(s => s.startMode === "operator")
				.map(s => s.id),
			scannerJobs: this.deps.scannerJobsOn(sourceId, exceptJobId),
			unrestorable: changes.filter(f => unknown.has(f)),
		}
	}

	// === internals ===

	private requireState(sourceId: string): TunerState {
		const state = this.deps.tuner.getState(sourceId)
		if (!state)
			throw new WaveKitError(
				`Tuner source ${sourceId} is gone`,
				"SCANNER_NO_TUNER_CONTROL",
			)
		return state
	}

	private assertHeld(lease: Lease): void {
		if (this.lost.has(lease) || this.leases.get(lease.sourceId) !== lease) {
			throw new WaveKitError(
				`Tuner lease for ${lease.sourceId} was lost`,
				"SCANNER_LEASE_LOST",
			)
		}
	}

	private snapshotOf(state: TunerState): Partial<TunerFieldValues> {
		const unknown = new Set(state.unknownFields ?? [])
		const snapshot: Partial<TunerFieldValues> = {}
		if (!unknown.has("frequency")) snapshot.frequency = state.frequency
		if (!unknown.has("sampleRate")) snapshot.sampleRate = state.sampleRate
		if (!unknown.has("gainMode")) snapshot.gainMode = state.gainMode
		if (!unknown.has("gain")) snapshot.gain = state.gain
		if (!unknown.has("agcMode")) snapshot.agcMode = state.agcMode
		return snapshot
	}

	/** Adds fields about to be written and persists the lease (awaited) when the set grew. */
	private async markChanged(
		lease: Lease,
		fields: (keyof TunerFieldValues)[],
	): Promise<void> {
		const before = lease.changedFields.size
		for (const field of fields) lease.changedFields.add(field)
		if (lease.changedFields.size > before) await this.persist(lease)
	}

	private recordOf(lease: Lease): PersistedLease {
		return {
			sourceId: lease.sourceId,
			jobId: lease.jobId,
			acquiredAt: lease.acquiredAt,
			snapshot: { ...lease.snapshot },
			changedFields: [...lease.changedFields],
		}
	}

	/** Never rejects: a failed persist is logged. */
	private async persist(lease: Lease): Promise<void> {
		await this.deps
			.persistLease(lease.sourceId, this.recordOf(lease))
			.catch((err: unknown) => {
				this.log.warn(
					{ err, sourceId: lease.sourceId },
					"Persisting the tuner lease failed",
				)
			})
	}

	/** Never accepted state, so idempotent; the setTestMode call itself is issued synchronously. */
	private async testModeOff(sourceId: string): Promise<void> {
		try {
			await this.deps.tuner.setTestMode(sourceId, false, {
				origin: "scanner",
				accept: false,
			})
			this.markerOpen.delete(sourceId)
		} catch (err) {
			this.log.error(
				{ err, sourceId },
				"TEST_MODE 0 failed; the engine reports stuckTestMode if counters persist",
			)
		}
	}

	private async restoreFields(
		sourceId: string,
		snapshot: Partial<TunerFieldValues>,
		changed: (keyof TunerFieldValues)[],
		abort: () => boolean = () => false,
	): Promise<{ restored: string[]; unknown: string[]; failed: string[] }> {
		const restored: string[] = []
		const unknown: string[] = []
		const failed: string[] = []
		const opts: TunerWriteOptions = { origin: "scanner" }
		const tuner = this.deps.tuner
		for (const field of FIELDS) {
			if (!changed.includes(field)) continue
			const value = snapshot[field]
			if (value === undefined) {
				unknown.push(field)
				continue
			}
			if (abort()) break
			try {
				switch (field) {
					case "sampleRate":
						await tuner.setSampleRate(sourceId, value as number, opts)
						break
					case "frequency":
						await tuner.setFrequency(sourceId, value as number, opts)
						break
					case "gainMode":
						await tuner.setGainMode(
							sourceId,
							value as TunerFieldValues["gainMode"],
							opts,
						)
						break
					case "gain":
						await tuner.setGain(sourceId, value as number, opts)
						break
					case "agcMode":
						await tuner.setAgcMode(sourceId, value as boolean, opts)
						break
				}
				restored.push(field)
			} catch (err) {
				this.log.warn(
					{ err, sourceId, field },
					"Restoring a tuner field failed",
				)
				failed.push(field)
			}
		}
		return { restored, unknown, failed }
	}

	private lose(lease: Lease, reason: LeaseLostReason): void {
		if (this.leases.get(lease.sourceId) !== lease) return
		this.leases.delete(lease.sourceId)
		this.priorities.delete(lease.sourceId)
		this.lost.add(lease)
		void this.deps.persistLease(lease.sourceId, null).catch((err: unknown) => {
			this.log.warn(
				{ err, sourceId: lease.sourceId },
				"Clearing the persisted lease failed",
			)
		})
		this.log.warn(
			{ sourceId: lease.sourceId, jobId: lease.jobId, reason },
			"Tuner lease lost; no restore",
		)
		this.emit("lease-lost", lease, reason)
	}

	private readonly onCommandSent = (
		sourceId: string,
		_command: string,
		_value: number,
		origin?: TunerCommandOrigin,
	): void => {
		if (origin === "scanner") return
		if (origin === "replay") {
			this.emit("replay", sourceId)
			return
		}
		this.lastOperatorAt.set(sourceId, this.now())
		const lease = this.leases.get(sourceId)
		if (lease) this.lose(lease, "preempted-operator")
	}

	private readonly onControlMode = (
		sourceId: string,
		mode: TunerControlMode,
	): void => {
		this.lastOperatorAt.set(sourceId, this.now())
		if (mode === "internal") {
			// Control is back: retry a recovery the relay blocked and close a marker it kept open.
			if (
				!this.deps.sources.isRtlTcpSource(sourceId) ||
				!this.connected.has(sourceId)
			) {
				return
			}
			if (!this.startRecovery(sourceId) && this.markerOpen.has(sourceId)) {
				void this.testModeOff(sourceId)
			}
			return
		}
		const lease = this.leases.get(sourceId)
		if (lease) this.lose(lease, "preempted-relay")
	}

	private readonly onDisconnected = (sourceId: string): void => {
		this.connected.delete(sourceId)
		this.emit("source-down", sourceId)
	}

	/** "removed" (teardown, also on reconnect) and "source-removed" (gone for good): no longer connected. */
	private readonly onRemoved = (sourceId: string): void => {
		this.connected.delete(sourceId)
	}

	private readonly onPayloadStarted = (sourceId: string): void => {
		this.connected.add(sourceId)
		// recover() sends TEST_MODE 0 as its first step.
		if (
			this.deps.sources.isRtlTcpSource(sourceId) &&
			!this.startRecovery(sourceId) &&
			(this.markerOpen.has(sourceId) || this.leases.has(sourceId))
		) {
			// A connection dropped mid-bracket can leave the dongle in test mode; replay never clears it.
			void this.testModeOff(sourceId)
		}
		this.emit("source-up", sourceId)
	}

	/** Starts the pending recovery of a source; false when there is none or one is running. */
	private startRecovery(sourceId: string): boolean {
		const persisted = this.recovering.get(sourceId)
		if (!persisted || this.recoveryRunning.has(sourceId)) return false
		this.recoveryRunning.add(sourceId)
		void this.recover(persisted)
			.catch((err: unknown) => {
				this.log.error({ err, sourceId }, "Lease recovery failed")
			})
			.finally(() => {
				this.recoveryRunning.delete(sourceId)
			})
		return true
	}

	/**
	 * A job acquiring a source whose crash recovery has not run takes the persisted lease over:
	 * its release restores the pre-crash state, and recover() leaves the source alone.
	 */
	private adopt(
		persisted: PersistedLease,
		jobId: string,
		priority: number,
	): Lease {
		const { sourceId } = persisted
		this.recovering.delete(sourceId)
		const lease: Lease = {
			sourceId,
			jobId,
			acquiredAt: this.now(),
			snapshot: { ...persisted.snapshot },
			// Frequency always, as in recover(): the stale last hop is the H4 hazard.
			changedFields: new Set([...persisted.changedFields, "frequency"]),
		}
		this.adopted.add(lease)
		this.leases.set(sourceId, lease)
		this.priorities.set(sourceId, priority)
		void this.persist(lease)
		this.log.info(
			{
				sourceId,
				jobId,
				crashedJobId: persisted.jobId,
				snapshot: lease.snapshot,
			},
			"Tuner lease acquired; adopted the persisted lease of a crashed sweep",
		)
		// Recovery is settled (the holder restores on release); deferred so no listener runs inside acquire.
		const result = { restored: [] as string[], unrestorable: [] as string[] }
		queueMicrotask(() => {
			try {
				this.emit("recovered", sourceId, result)
			} catch (err) {
				this.log.error({ err, sourceId }, "A recovered listener failed")
			}
			// A "recovered" listener may drop its copy of the persisted lease; the holder's must stay.
			if (this.leases.get(sourceId) === lease) void this.persist(lease)
		})
		return lease
	}

	private async recover(persisted: PersistedLease): Promise<void> {
		const { sourceId } = persisted
		// A lease that adopted the record owns its restore and its persistence from then on.
		const superseded = () =>
			this.recovering.get(sourceId) !== persisted || this.leases.has(sourceId)
		if (superseded()) return
		await this.testModeOff(sourceId)
		// Frequency always: a stale last-hop centre is the H4 hazard, whatever changedFields says.
		const fields = new Set<keyof TunerFieldValues>([
			...persisted.changedFields,
			"frequency",
		])
		const r = await this.restoreFields(
			sourceId,
			persisted.snapshot,
			[...fields],
			superseded,
		)
		if (superseded()) return
		if (r.failed.length > 0) {
			// A write failed (for example relay control): the record stays in `recovering`, and the
			// next connection or the return of control retries. Unknown snapshot values can never be
			// written, so they alone never cause a retry.
			return
		}
		this.recovering.delete(sourceId)
		const result = { restored: r.restored, unrestorable: r.unknown }
		await this.deps
			.persistLease(persisted.sourceId, null)
			.catch((err: unknown) => {
				this.log.warn(
					{ err, sourceId: persisted.sourceId },
					"Clearing the recovered lease failed",
				)
			})
		this.log.info(
			{ sourceId: persisted.sourceId, jobId: persisted.jobId, ...result },
			"Restored the tuner after a crash during a sweep",
		)
		this.emit("recovered", persisted.sourceId, result)
	}
}
