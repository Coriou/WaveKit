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
	"runTunerCommand" | "isTunerUsable" | "waitUntilTunerUsable" | "getStatus"
>

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
	timer: NodeJS.Timeout | undefined
}

interface ActiveTune {
	/** The temporary tune has started writing: its own writes cancel nothing. */
	owned: boolean
	/** Another actor wrote while it ran, or the restore was cancelled before it armed. */
	overriddenBy: RestoreRecord["view"]["cancelledBy"]
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
	private readonly lastTunes = new Map<string, TunerLastTune>()
	private closed = false

	constructor(
		logger: Logger,
		private readonly controller: TunerController,
		private readonly source: TuneSource,
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
		const run: ActiveTune = { owned: false, overriddenBy: undefined }
		this.active.set(sourceId, run)
		const settings = settingsOf(values)
		const applied = new Set<TuneSetting>()
		const deadline = Date.now() + TUNE_DEADLINE_MS
		const temporary = request.restoreAfterS !== undefined
		let expired = false
		let started = false
		let error: unknown
		let carried: RestoreRecord | undefined
		let snapshot: TuneSnapshot | undefined

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
			if (this.controller.getState(sourceId) !== undefined) {
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
			if (this.closed || this.controller.getState(sourceId) === undefined)
				return
			if (run.overriddenBy !== undefined) {
				this.endWithoutRestore(sourceId, carried, snapshot, run.overriddenBy)
				return
			}
			if (applied.size > 0)
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
				!held &&
				(await this.source.waitUntilTunerUsable(sourceId, TUNE_DEADLINE_MS))
			if (!usable) {
				settle()
				return finish(false)
			}
		}

		const command = this.source.runTunerCommand(sourceId, async () => {
			if (expired) throw new TuneStopped()
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
			await this.controller.applyTune(sourceId, values, opts, setting => {
				applied.add(setting)
				// A tune that stays is the newest word: nothing goes back over it.
				if (!temporary)
					this.cancel(sourceId, opts.actor ?? "unknown", "tuner-write")
				if (expired) throw new TuneStopped()
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
		const deadlineReached = new Promise<"deadline">(resolve => {
			timer = setTimeout(
				() => resolve("deadline"),
				Math.max(0, deadline - Date.now()),
			)
			timer.unref()
		})
		const first = await Promise.race([settled, deadlineReached])
		clearTimeout(timer)
		if (first === "deadline") {
			expired = true
			const outcome = finish(false)
			if (!started) return outcome
			return { ...outcome, inFlight: true }
		}
		// A recovery that ran out of its own window still counts if the source returns in time.
		if (error !== undefined && codeOf(error) !== "SOURCE_RECONNECTING")
			return finish(this.source.isTunerUsable(sourceId))
		const usable = await this.source.waitUntilTunerUsable(
			sourceId,
			deadline - Date.now(),
		)
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

	/** Shutdown: drops every pending restore and writes nothing. The tuner keeps its tuning. */
	close(): void {
		if (this.closed) return
		this.closed = true
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

	/** The timer's work: one attempt, whatever the outcome; a failure is reported, not retried. */
	private async fire(sourceId: string, record: RestoreRecord): Promise<void> {
		const { view } = record
		if (
			this.closed ||
			this.restores.get(sourceId) !== record ||
			view.status !== "pending"
		)
			return
		record.timer = undefined
		view.status = "restoring"
		view.restored = []
		this.controller.publishState(sourceId)
		const deadline = Date.now() + TUNE_DEADLINE_MS
		const running = () => view.status === "restoring"
		try {
			if (!(await this.source.waitUntilTunerUsable(sourceId, TUNE_DEADLINE_MS)))
				throw this.notUsable()
			await this.source.runTunerCommand(sourceId, async () => {
				if (!running()) return
				// A reconnect may have left it elsewhere with no write to say who did.
				if (this.movedFromExpected(sourceId, record, true)) {
					this.cancel(sourceId, this.lastActor(sourceId), "state-changed")
					return
				}
				await this.controller.applyTune(
					sourceId,
					view.state,
					{ origin: "rest", restore: true },
					setting => {
						view.restored?.push(setting)
						if (!running()) throw new TuneStopped()
					},
					record.wroteGain,
				)
				this.controller.noteTuneRestored(sourceId, record.snapshot)
			})
			if (!running()) return
			const usable = await this.source.waitUntilTunerUsable(
				sourceId,
				deadline - Date.now(),
			)
			if (!running()) return
			if (!usable) throw this.notUsable()
			view.status = "restored"
			this.log.info({ sourceId }, "Temporary tune put back")
		} catch (err) {
			if (err instanceof TuneStopped || !running()) return
			view.status = "failed"
			view.failure = codeOf(err)
			this.log.warn(
				{ sourceId, code: view.failure },
				"Putting a temporary tune back failed; it is not retried",
			)
		} finally {
			if (this.restores.get(sourceId) === record)
				this.controller.publishState(sourceId)
		}
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
		const record = this.restores.get(sourceId)
		if (record !== undefined) this.stop(record)
		this.restores.delete(sourceId)
		this.lastTunes.delete(sourceId)
	}
}
