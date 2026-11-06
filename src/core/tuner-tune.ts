/**
 * POST /api/tuner/:sourceId/tune: rate, centre and gain in one call that answers only when the
 * source is usable again, and the temporary tune that puts them back later unless someone else
 * has touched the tuner since.
 */

import { WaveKitError } from "../utils/errors.js"
import { createComponentLogger, type Logger } from "../utils/logger.js"
import { TUNE_SETTINGS } from "@wavekit/api-types"
import type {
	SourceVerdict,
	TuneRequest,
	TuneRestore,
	TuneRestoreCancelReason,
	TuneSetting,
	TunerChangeActor,
	TunerLastChange,
	TunerLastTune,
	TunerState,
} from "@wavekit/api-types"
import type { SourceManager } from "./source-manager.js"
import { TUNER_COMMAND_TIMEOUT_MS } from "./source-manager.js"
import { sourceVerdict } from "./source-verdict.js"
import {
	TunerControlModeError,
	TunerControllerError,
	TunerSourceNotFoundError,
	TunerValidationError,
	type TuneSnapshot,
	type TuneValues,
	type TunerController,
	type TunerWriteOptions,
} from "./tuner-controller.js"

/**
 * How long a tune may take before it answers 503: one command (at most TUNER_COMMAND_TIMEOUT_MS,
 * 9 s) and one rate-change recovery (at most 9 s: <= 4 s first-retry backoff + 5 s connect
 * timeout), so 2 × 9 s = 18 s. A wait for the source at the start and time queued behind other
 * commands spend the same budget. No write starts after it.
 */
export const TUNE_DEADLINE_MS = 2 * TUNER_COMMAND_TIMEOUT_MS

export type TuneSource = Pick<
	SourceManager,
	"runTunerCommand" | "isTunerUsable" | "getStatus" | "on" | "off"
>

/** The job holding a source's tuner lease, else null. Only a core with a scanner has one. */
export type TunerLeaseHolder = (sourceId: string) => string | null

export interface TuneOutcome {
	usable: boolean
	applied: TuneSetting[]
	notApplied: TuneSetting[]
	state: TunerState | undefined
	/** Why the tune did not fully apply; absent on success. */
	error?: unknown
	/** The source's verdict when it is not usable. */
	sourceVerdict?: SourceVerdict
	/** A setting was being written when the deadline passed: it may still land. */
	inFlight?: true
}

interface RestoreRecord {
	view: TuneRestore
	snapshot: TuneSnapshot
	/** The tuning the temporary tune left: anything else means someone moved the tuner. */
	expected: TuneValues
	/** The temporary tune wrote a gain: rtl_tcp then left AGC whatever the state shows. */
	wroteGain: boolean
	/** While pending, the time it is due; while restoring, its deadline. */
	timer: NodeJS.Timeout | undefined
	/** Ends its usability waits once it is over, however it ended. */
	abort: AbortController
}

interface ActiveTune {
	/** The temporary tune has started writing: its own writes cancel nothing. */
	owned: boolean
	/** Another actor wrote while it ran, or the restore was cancelled before it armed. */
	overriddenBy: RestoreRecord["view"]["cancelledBy"]
	/** Shutdown or the source's removal: no frame goes out, every wait ends. */
	abort: AbortController
}

/** A restore or tune stopped between settings; never reaches a client as itself. */
class TuneStopped extends Error {}

function valuesOf(request: TuneRequest): TuneValues {
	return {
		...(request.sampleRateHz !== undefined
			? { sampleRate: request.sampleRateHz }
			: {}),
		...(request.frequencyHz !== undefined
			? { frequency: request.frequencyHz }
			: {}),
		...(request.gainMode !== undefined ? { gainMode: request.gainMode } : {}),
		...(request.gain !== undefined ? { gain: request.gain } : {}),
	}
}

function settingsOf(values: TuneValues): TuneSetting[] {
	return TUNE_SETTINGS.filter(setting => valueOf(values, setting) !== undefined)
}

function valueOf(
	values: TuneValues,
	setting: TuneSetting,
): number | string | undefined {
	switch (setting) {
		case "sampleRateHz":
			return values.sampleRate
		case "frequencyHz":
			return values.frequency
		case "gainMode":
			return values.gainMode
		case "gain":
			return values.gain
	}
}

const STATE_FIELD = {
	sampleRateHz: "sampleRate",
	frequencyHz: "frequency",
	gainMode: "gainMode",
	gain: "gain",
} as const

/** The state shows the setting's value, as a value the core knows. */
function holds(
	state: TunerState | undefined,
	values: TuneValues,
	setting: TuneSetting,
): boolean {
	if (state === undefined) return false
	const field = STATE_FIELD[setting]
	return (
		state[field] === valueOf(values, setting) &&
		state.unknownFields?.includes(field) !== true
	)
}

function codeOf(err: unknown): string {
	const code = (err as { code?: unknown } | null)?.code
	return typeof code === "string" ? code : "TUNER_ERROR"
}

export class TunerTuning {
	private readonly log: Logger
	/** One per source: the pending restore, or how the last one ended. */
	private readonly restores = new Map<string, RestoreRecord>()
	/** One per source, at most: the tune answering 409 to a second one. */
	private readonly active = new Map<string, ActiveTune>()
	/** Tunes past their writes, still waiting for the source. At most one per request. */
	private readonly finalWaits = new Set<AbortController>()
	private readonly lastTunes = new Map<string, TunerLastTune>()
	private closed = false

	constructor(
		logger: Logger,
		private readonly controller: TunerController,
		private readonly source: TuneSource,
		private readonly leaseHolder?: TunerLeaseHolder,
	) {
		this.log = createComponentLogger(logger, "TunerTuning")
		controller.on("last-change", this.onLastChange)
		controller.on("state-changed", this.onStateChanged)
		controller.on("control-mode-changed", this.onControlMode)
		controller.on("source-removed", this.onSourceRemoved)
		controller.setTuneStatus(sourceId => {
			const restore = this.restores.get(sourceId)?.view
			const lastTune = this.lastTunes.get(sourceId)
			return {
				...(restore ? { restore: this.copyView(restore) } : {}),
				...(lastTune ? { lastTune } : {}),
			}
		})
	}

	private copyView(view: TuneRestore): TuneRestore {
		return {
			...view,
			state: { ...view.state },
			...(view.restored ? { restored: [...view.restored] } : {}),
		}
	}

	/**
	 * Applies the settings and answers when the source is usable again, or with what was and was
	 * not applied. A refusal with nothing written throws. The work does not depend on the caller:
	 * a client that goes away still gets the whole tune, `lastTune` and the log say how it ended.
	 */
	async tune(
		sourceId: string,
		request: TuneRequest,
		opts: TunerWriteOptions,
	): Promise<TuneOutcome> {
		const current = this.controller.getState(sourceId)
		if (current === undefined || this.closed)
			throw new TunerSourceNotFoundError(sourceId)
		const values = valuesOf(request)
		this.validate(values)
		if (current.controlMode === "external")
			throw new TunerControlModeError(sourceId)
		if (
			this.active.has(sourceId) ||
			this.restores.get(sourceId)?.view.status === "restoring"
		)
			throw new TunerControllerError(
				"Another tune of this source is running; retry when it answers",
				"TUNER_TUNE_BUSY",
				409,
			)
		const run: ActiveTune = {
			owned: false,
			overriddenBy: undefined,
			abort: new AbortController(),
		}
		const { signal } = run.abort
		this.active.set(sourceId, run)
		const settings = settingsOf(values)
		const applied = new Set<TuneSetting>()
		const deadline = Date.now() + TUNE_DEADLINE_MS
		const temporary = request.restoreAfterS !== undefined
		let expired = false
		let started = false
		let wrote = false
		let error: unknown
		let carried: RestoreRecord | undefined
		let snapshot: TuneSnapshot | undefined
		// Timers can run late: the clock decides as well as `expired`, in the frame's own section.
		const stopIfHalted = () => {
			if (expired || signal.aborted || Date.now() >= deadline)
				throw new TuneStopped()
		}

		const finish = (usable: boolean, stateNow = this.state(sourceId)) => {
			if (stateNow === undefined) error = new TunerSourceNotFoundError(sourceId)
			const done = settings.filter(setting => {
				if (!applied.has(setting)) return false
				return holds(stateNow, values, setting)
			})
			const notApplied = settings.filter(setting => !done.includes(setting))
			if (usable && error === undefined && notApplied.length > 0)
				error = new WaveKitError(
					"The source came back without some settings; read notApplied and the tuner state",
					"TUNER_TUNE_PARTIAL",
				)
			if (!usable && error === undefined) error = this.notUsable()
			if (!signal.aborted && this.controller.getState(sourceId) !== undefined) {
				this.lastTunes.set(sourceId, {
					at: new Date().toISOString(),
					usable,
					applied: done,
					notApplied,
					...(error !== undefined ? { code: codeOf(error) } : {}),
				})
				this.controller.publishState(sourceId)
			}
			const verdict = usable ? undefined : this.verdict(sourceId)
			this.log.info(
				{
					sourceId,
					usable,
					applied: done,
					notApplied,
					...(error !== undefined ? { code: codeOf(error) } : {}),
				},
				"Tune finished",
			)
			return {
				usable,
				applied: done,
				notApplied,
				state: this.state(sourceId),
				...(error !== undefined ? { error } : {}),
				...(verdict ? { sourceVerdict: verdict } : {}),
			}
		}

		// Once the writes are over: arm, keep or end the temporary tune's restore.
		const settle = () => {
			if (this.active.get(sourceId) === run) this.active.delete(sourceId)
			if (!temporary || !run.owned || snapshot === undefined) return
			if (signal.aborted || this.controller.getState(sourceId) === undefined)
				return
			if (run.overriddenBy !== undefined) {
				this.endWithoutRestore(sourceId, carried, snapshot, run.overriddenBy)
				return
			}
			// With a restore pending, only a frame that went out takes the new time. A tune that
			// finds its values in place changed nothing and leaves the pending restore's time.
			if (applied.size > 0 && (carried === undefined || wrote))
				this.arm(
					sourceId,
					snapshot,
					request.restoreAfterS! * 1_000,
					applied.has("gain") || carried?.wroteGain === true,
				)
			else if (carried !== undefined)
				this.rearm(sourceId, carried, Date.parse(carried.view.at) - Date.now())
		}

		if (!this.source.isTunerUsable(sourceId)) {
			const held = this.source.getStatus(sourceId)?.feed?.state === "paused"
			const usable =
				!held && (await this.waitUsable(sourceId, TUNE_DEADLINE_MS, signal))
			if (!usable) {
				settle()
				return finish(false)
			}
		}

		const command = this.source.runTunerCommand(sourceId, async () => {
			stopIfHalted()
			started = true
			if (temporary) {
				const prior = this.restores.get(sourceId)
				if (prior?.view.status === "pending") carried = prior
				const taken =
					carried?.snapshot ?? this.controller.tuneSnapshot(sourceId)
				const unknown = this.unknownPrior(taken, settings)
				if (unknown.length > 0)
					throw new TunerControllerError(
						`The tuning before this tune is unknown, so a restore could not put it back: ${unknown.join(", ")}. Set it first, or tune without restoreAfterS`,
						"TUNER_RESTORE_PRIOR_UNKNOWN",
						409,
					)
				snapshot = taken
				run.owned = true
				if (carried?.timer !== undefined) {
					clearTimeout(carried.timer)
					carried.timer = undefined
				}
			}
			const writing: TunerWriteOptions = {
				...opts,
				beforeWrite: stopIfHalted,
				afterWrite: () => {
					wrote = true
				},
			}
			await this.controller.applyTune(sourceId, values, writing, setting => {
				applied.add(setting)
				// A tune that stays is the newest word: nothing goes back over it.
				if (!temporary)
					this.cancel(sourceId, opts.actor ?? "unknown", "tuner-write")
				stopIfHalted()
			})
		})
		const settled = command.then(
			() => undefined,
			(err: unknown) => {
				if (!(err instanceof TuneStopped)) error = err
			},
		)
		void settled.then(() => {
			settle()
			// The deadline answered first: `lastTune` still ends on what really happened.
			if (expired) finish(this.source.isTunerUsable(sourceId))
		})

		let timer: NodeJS.Timeout | undefined
		let onAbort: () => void = () => {}
		const halted = new Promise<"deadline" | "stopped">(resolve => {
			onAbort = () => resolve("stopped")
			if (signal.aborted) onAbort()
			else signal.addEventListener("abort", onAbort, { once: true })
			timer = setTimeout(
				() => resolve("deadline"),
				Math.max(0, deadline - Date.now()),
			)
			timer.unref()
		})
		const first = await Promise.race([settled, halted])
		clearTimeout(timer)
		signal.removeEventListener("abort", onAbort)
		// No frame goes out from here: `stopIfHalted` guards each one.
		if (first === "stopped") return finish(false)
		if (first === "deadline") {
			expired = true
			const outcome = finish(false)
			if (!started) return outcome
			return { ...outcome, inFlight: true }
		}
		// A recovery that ran out of its own window still counts if the source returns in time.
		if (error !== undefined && codeOf(error) !== "SOURCE_RECONNECTING")
			return finish(this.source.isTunerUsable(sourceId))
		// `settle` took the run off `active`, so close and removal reach this wait through its own set.
		this.finalWaits.add(run.abort)
		const usable = await this.waitUsable(
			sourceId,
			deadline - Date.now(),
			signal,
		).finally(() => this.finalWaits.delete(run.abort))
		error = usable ? undefined : this.notUsable()
		return finish(usable)
	}

	/** DELETE /api/tuner/:sourceId/tune/restore. */
	cancelRestore(
		sourceId: string,
		actor: TunerChangeActor,
	): TunerState | undefined {
		if (this.controller.getState(sourceId) === undefined)
			throw new TunerSourceNotFoundError(sourceId)
		const run = this.active.get(sourceId)
		if (run?.owned === true) {
			run.overriddenBy = this.cancelledBy(actor, "cancel-request")
			return this.state(sourceId)
		}
		if (!this.cancel(sourceId, actor, "cancel-request"))
			throw new TunerControllerError(
				"No restore is pending for this source",
				"TUNER_RESTORE_NOT_PENDING",
				404,
			)
		return this.state(sourceId)
	}

	/**
	 * Shutdown: drops every pending restore, aborts every running tune and restore, and writes
	 * nothing more. Their waits give back their listeners and timers at once. The tuner keeps its
	 * tuning. A frame already sent stays sent; a tune still in the command queue finds itself
	 * aborted when its turn comes.
	 */
	close(): void {
		if (this.closed) return
		this.closed = true
		for (const run of this.active.values()) run.abort.abort()
		this.active.clear()
		for (const abort of this.finalWaits) abort.abort()
		for (const record of this.restores.values()) this.stop(record)
		this.restores.clear()
		this.lastTunes.clear()
		this.controller.off("last-change", this.onLastChange)
		this.controller.off("state-changed", this.onStateChanged)
		this.controller.off("control-mode-changed", this.onControlMode)
		this.controller.off("source-removed", this.onSourceRemoved)
		this.controller.setTuneStatus(null)
	}

	private state(sourceId: string): TunerState | undefined {
		return this.controller.getState(sourceId)
	}

	/**
	 * Waits for the source's first payload on a usable connection (after the reconnect restore,
	 * whose listener registered first), writing nothing. False at the deadline, when the source
	 * goes away, or on abort; every way out gives back the listeners and the timer.
	 */
	private waitUsable(
		sourceId: string,
		timeoutMs: number,
		signal: AbortSignal,
	): Promise<boolean> {
		if (signal.aborted) return Promise.resolve(false)
		if (this.source.isTunerUsable(sourceId)) return Promise.resolve(true)
		if (timeoutMs <= 0) return Promise.resolve(false)
		return new Promise<boolean>(resolve => {
			const finish = (usable: boolean) => {
				clearTimeout(timer)
				this.source.off("payload-started", started)
				this.source.off("source-removed", removed)
				signal.removeEventListener("abort", aborted)
				resolve(usable)
			}
			const started = (id: string) => {
				if (id === sourceId && this.source.isTunerUsable(sourceId)) finish(true)
			}
			const removed = (id: string) => {
				if (id === sourceId) finish(false)
			}
			const aborted = () => finish(false)
			const timer = setTimeout(() => finish(false), timeoutMs)
			timer.unref()
			this.source.on("payload-started", started)
			this.source.on("source-removed", removed)
			signal.addEventListener("abort", aborted, { once: true })
		})
	}

	/**
	 * An automatic restore never preempts anyone, so a held lease ends it for good. Without a
	 * lease view the core has no scanner, so no lease exists. A view that fails says nothing about
	 * a lease: no restore then either.
	 */
	private yieldToLease(sourceId: string): boolean {
		if (this.leaseHolder === undefined) return false
		let holder: string | null
		try {
			holder = this.leaseHolder(sourceId)
		} catch (err) {
			this.log.warn(
				{ sourceId, code: codeOf(err) },
				"The scanner lease could not be read; the temporary tune stays",
			)
			holder = "unknown"
		}
		if (holder === null) return false
		this.cancel(sourceId, "scanner-job", "scanner-lease")
		return true
	}

	private verdict(sourceId: string): SourceVerdict | undefined {
		const status = this.source.getStatus(sourceId)
		return status ? sourceVerdict(status, undefined, Date.now()) : undefined
	}

	private notUsable(): WaveKitError {
		return new WaveKitError(
			"The source is not usable yet; the settings below say what was applied",
			"TUNER_NOT_USABLE",
		)
	}

	/** A value check names the field as this route's body does, never the value. */
	private validate(values: TuneValues): void {
		try {
			this.controller.validateTune(values)
		} catch (err) {
			if (!(err instanceof TunerValidationError)) throw err
			const setting = TUNE_SETTINGS.find(
				known => STATE_FIELD[known] === err.field,
			)
			throw new TunerValidationError(
				"Invalid tuner value",
				setting ?? err.field,
			)
		}
	}

	/** The asked settings a restore could not put back: nothing known to write. */
	private unknownPrior(
		snapshot: TuneSnapshot | undefined,
		settings: readonly TuneSetting[],
	): TuneSetting[] {
		const known = snapshot?.state ?? {}
		return settings.filter(setting => {
			// In AGC the gain is the receiver's own: going back to AGC restores it.
			if (setting === "gain" && known.gainMode === "agc") return false
			return valueOf(known, setting) === undefined
		})
	}

	private cancelledBy(
		actor: TunerChangeActor,
		reason: TuneRestoreCancelReason,
	): NonNullable<TuneRestore["cancelledBy"]> {
		return { actor, reason, at: new Date().toISOString() }
	}

	/** The timer goes, and a restore already running writes nothing more. */
	private stop(record: RestoreRecord): void {
		clearTimeout(record.timer)
		record.timer = undefined
		record.abort.abort()
		if (record.view.status === "restoring") record.view.status = "cancelled"
	}

	/** Ends a pending or running restore for good; false when none is. */
	private cancel(
		sourceId: string,
		actor: TunerChangeActor,
		reason: TuneRestoreCancelReason,
	): boolean {
		const record = this.restores.get(sourceId)
		if (
			record === undefined ||
			(record.view.status !== "pending" && record.view.status !== "restoring")
		)
			return false
		clearTimeout(record.timer)
		record.timer = undefined
		record.abort.abort()
		record.view.status = "cancelled"
		record.view.cancelledBy = this.cancelledBy(actor, reason)
		this.log.info({ sourceId, actor, reason }, "Temporary tune stays")
		this.controller.publishState(sourceId)
		return true
	}

	/** A temporary tune overridden before it armed: the block says so, nothing will fire. */
	private endWithoutRestore(
		sourceId: string,
		carried: RestoreRecord | undefined,
		snapshot: TuneSnapshot,
		cancelledBy: NonNullable<TuneRestore["cancelledBy"]>,
	): void {
		clearTimeout(carried?.timer)
		this.restores.set(sourceId, {
			view: {
				at: carried?.view.at ?? new Date().toISOString(),
				status: "cancelled",
				state: snapshot.state,
				cancelledBy,
			},
			snapshot,
			expected: {},
			wroteGain: false,
			timer: undefined,
			abort: new AbortController(),
		})
		this.controller.publishState(sourceId)
	}

	private arm(
		sourceId: string,
		snapshot: TuneSnapshot,
		delayMs: number,
		wroteGain: boolean,
	): void {
		const state = this.controller.tuneSnapshot(sourceId)?.state ?? {}
		const record: RestoreRecord = {
			view: {
				at: new Date(Date.now() + delayMs).toISOString(),
				status: "pending",
				state: snapshot.state,
			},
			snapshot,
			expected: state,
			wroteGain,
			timer: undefined,
			abort: new AbortController(),
		}
		this.restores.set(sourceId, record)
		this.rearm(sourceId, record, delayMs)
		this.controller.publishState(sourceId)
	}

	private rearm(
		sourceId: string,
		record: RestoreRecord,
		delayMs: number,
	): void {
		record.timer = setTimeout(
			() => {
				void this.fire(sourceId, record)
			},
			Math.max(0, delayMs),
		)
		record.timer.unref()
	}

	/**
	 * The timer's work: one attempt, whatever the outcome; a failure is reported, not retried.
	 * TUNE_DEADLINE_MS bounds all of it, time queued behind other commands included. Each frame
	 * checks in its own synchronous section that the restore still runs, its budget is not spent
	 * and no lease is held, so no frame goes out after a cancel, late or over a lease.
	 */
	private async fire(sourceId: string, record: RestoreRecord): Promise<void> {
		const { view } = record
		if (
			this.closed ||
			this.restores.get(sourceId) !== record ||
			view.status !== "pending"
		)
			return
		record.timer = undefined
		if (this.yieldToLease(sourceId)) return
		view.status = "restoring"
		view.restored = []
		this.controller.publishState(sourceId)
		const deadline = Date.now() + TUNE_DEADLINE_MS
		const { signal } = record.abort
		const running = () => view.status === "restoring"
		// Timers can run late: the deadline timer ends a restore stuck in a wait or the command
		// queue, and `stopIfOver` still refuses a frame that comes before that timer has run.
		const late = () =>
			new WaveKitError(
				"The restore's time ran out before all of it was written",
				"TUNER_RESTORE_DEADLINE",
			)
		record.timer = setTimeout(() => {
			if (!running()) return
			this.failRestore(
				sourceId,
				record,
				this.source.isTunerUsable(sourceId) ? late() : this.notUsable(),
			)
			this.controller.publishState(sourceId)
		}, TUNE_DEADLINE_MS)
		record.timer.unref()
		const stopIfOver = () => {
			if (!running() || this.yieldToLease(sourceId)) throw new TuneStopped()
			if (Date.now() >= deadline) throw late()
		}
		try {
			if (!(await this.waitUsable(sourceId, TUNE_DEADLINE_MS, signal)))
				throw this.notUsable()
			await this.source.runTunerCommand(sourceId, async () => {
				stopIfOver()
				// A reconnect may have left it elsewhere with no write to say who did.
				if (this.movedFromExpected(sourceId, record, true)) {
					this.cancel(sourceId, this.lastActor(sourceId), "state-changed")
					return
				}
				await this.controller.applyTune(
					sourceId,
					view.state,
					{ origin: "rest", restore: true, beforeWrite: stopIfOver },
					setting => {
						// A frame sent and then overwritten by someone else is not back.
						if (holds(this.state(sourceId), view.state, setting))
							view.restored?.push(setting)
						if (!running()) throw new TuneStopped()
					},
					record.wroteGain,
				)
				if (running())
					this.controller.noteTuneRestored(sourceId, record.snapshot)
			})
			if (!running()) return
			const remaining = deadline - Date.now()
			if (remaining <= 0) throw late()
			const usable = await this.waitUsable(sourceId, remaining, signal)
			if (!running()) return
			if (!usable) throw this.notUsable()
			view.status = "restored"
			this.log.info({ sourceId }, "Temporary tune put back")
		} catch (err) {
			if (err instanceof TuneStopped || !running()) return
			this.failRestore(sourceId, record, err)
		} finally {
			clearTimeout(record.timer)
			record.timer = undefined
			if (this.restores.get(sourceId) === record)
				this.controller.publishState(sourceId)
		}
	}

	private failRestore(
		sourceId: string,
		record: RestoreRecord,
		err: unknown,
	): void {
		record.view.status = "failed"
		record.view.failure = codeOf(err)
		record.abort.abort()
		this.log.warn(
			{ sourceId, code: record.view.failure },
			"Putting a temporary tune back failed; it is not retried",
		)
	}

	private lastActor(sourceId: string): TunerChangeActor {
		return this.controller.getState(sourceId)?.lastChange?.actor ?? "unknown"
	}

	/**
	 * The tuning the temporary tune left has moved. `proven` also counts a field that has become
	 * unknown: not on every state change, as a reconnect makes a configured gain unknown until
	 * its first payload writes it again.
	 */
	private movedFromExpected(
		sourceId: string,
		record: RestoreRecord,
		proven: boolean,
	): boolean {
		const state = this.controller.getState(sourceId)
		if (state === undefined) return false
		return TUNE_SETTINGS.some(setting => {
			const value = valueOf(record.expected, setting)
			if (value === undefined) return false
			const field = STATE_FIELD[setting]
			return (
				state[field] !== value ||
				(proven && state.unknownFields?.includes(field) === true)
			)
		})
	}

	private readonly onLastChange = (
		sourceId: string,
		change: TunerLastChange,
	): void => {
		// A reconnect puts back what is already accepted, and a configured value yields to an
		// operator's: neither is somebody choosing a new tuning.
		if (
			change.reason === "reconnect-replay" ||
			change.reason === "source-config"
		)
			return
		const run = this.active.get(sourceId)
		const own =
			run?.owned === true &&
			(change.reason === "rest-command" || change.actor === "decoder-rate")
		if (run?.owned === true && !own && change.reason !== "tune-restore")
			run.overriddenBy ??= this.cancelledBy(change.actor, "tuner-write")
		const record = this.restores.get(sourceId)
		if (record === undefined) return
		if (record.view.status === "restoring" && change.reason === "tune-restore")
			return
		if (record.view.status === "pending" && own) return
		this.cancel(sourceId, change.actor, "tuner-write")
	}

	private readonly onStateChanged = (sourceId: string): void => {
		const record = this.restores.get(sourceId)
		if (record?.view.status !== "pending") return
		if (this.active.get(sourceId)?.owned === true) return
		if (this.yieldToLease(sourceId)) return
		if (this.movedFromExpected(sourceId, record, false))
			this.cancel(sourceId, this.lastActor(sourceId), "state-changed")
	}

	private readonly onControlMode = (
		sourceId: string,
		mode: TunerState["controlMode"],
	): void => {
		if (mode !== "external") return
		const run = this.active.get(sourceId)
		if (run?.owned === true)
			run.overriddenBy ??= this.cancelledBy("relay", "external-control")
		this.cancel(sourceId, "relay", "external-control")
	}

	private readonly onSourceRemoved = (sourceId: string): void => {
		// A source re-added under this id is another source: nothing of this one writes to it.
		this.active.get(sourceId)?.abort.abort()
		this.active.delete(sourceId)
		const record = this.restores.get(sourceId)
		if (record !== undefined) this.stop(record)
		this.restores.delete(sourceId)
		this.lastTunes.delete(sourceId)
	}
}
