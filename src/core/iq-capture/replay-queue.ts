/**
 * Replay queue (WG11 req 6.4, 6.5, 6.8; Property 15): capture → queue → replay trials → result →
 * discard, off-air and without a user identify job.
 *
 * FIFO of finished captures. For the head entry the queue takes the capture over (`claim` as
 * IQ_REPLAY_QUEUE_HOLDER; a capture already claimed or reserved by an identify job, one whose
 * observation an identify target works on (`skip`: parked, kept queued and re-checked),
 * discarded, expired or confirmed live is skipped), asks the injected planner for its trials
 * (known protocol first, at most IQ_REPLAY_MAX_TRIALS, the analog trial counted), and runs them
 * one at a time. A `kind: "analog"` trial calls the injected `analog` runner (holding
 * ANALOG_TRIAL_CORES) instead of a probe; after a valid analog `decoded` or `heard` the
 * remaining digital trials end `not-needed`. A runner value that is not a well-formed result,
 * that carries `error`, or whose outcome disagrees with its fields (decoded without a qualified
 * tone or DCS, heard without stats) ends `cancelled`, or `unsupported` for `unavailable` /
 * `analyze-failed`, and the digital trials still run. The first accepted digital decode ends
 * the trials. Exactly one `sink(result)` per capture that
 * reached its trials, then `settle` discards it. A probe request deferred for a transient reason
 * (IQ_REPLAY_RETRIABLE_DEFERRALS) waits in place: it is retried on the pool's next slot release or
 * after 1 s, never in a loop, and for at most IQ_REPLAY_DEFER_MAX_MS per capture, after which its
 * remaining trials end `cancelled`. Any other deferral (no transport, format, stale epoch, a thrown
 * request, an unknown reason: fail closed) ends that trial `cancelled` at once, so a head that can
 * never run does not hold the captures of other sources behind it. `stop()` cancels the
 * running replay and discards every queued capture without a result.
 */
import type { Logger } from "../../utils/logger.js"
import { createComponentLogger } from "../../utils/logger.js"
import {
	IQ_REPLAY_MAX_TRIALS,
	type IqCaptureDiscardReason,
	type IqCapturePort,
	type IqCaptureView,
	type IqReplayPlanInput,
	type IqReplayPlanner,
	type IqReplayResult,
	type IqReplaySink,
	type IqReplayTrial,
	type IqReplayTrialOutcome,
} from "../scanner/iq-capture-contract.js"
import type {
	ProbeDecoderType,
	ProbeMode,
} from "../scanner/probes/probe-pool.js"
import {
	ANALOG_TRIAL_CORES,
	type AnalogTrialResult,
	type AnalogTrialRunner,
} from "../scanner/scanner-redesign-contract.js"
import type { Identity, ScannerProtocol } from "../scanner/types.js"
import { safeErrorFields } from "../../decoders/safe-error-fields.js"
import { judgeAnalogResult } from "./analog-result.js"

export const IQ_REPLAY_QUEUE_HOLDER = "iq-replay-queue"
/** Retry delay of a deferred replay request when no slot release arrives first. */
export const IQ_REPLAY_DEFER_RETRY_MS = 1_000
/**
 * Longest a capture's trials wait on transient deferrals (from its first one). Arithmetic: a head
 * is held by deferrals at most 60 s + one 1 s retry = 61 s, a tenth of the 600 s orphan TTL, so the
 * capture behind it is not expired by one blocked head.
 */
export const IQ_REPLAY_DEFER_MAX_MS = 60_000
/** The probe pool's transient deferrals (probe-pool.ts `Deferral`): a slot, the budget or the CPU guard frees up. */
export const IQ_REPLAY_RETRIABLE_DEFERRALS: ReadonlySet<string> = new Set([
	"max-probes",
	"budget",
	"cpu",
])

/** One replay probe the queue asks the probe pool for (Main maps it to `ProbeRequest.replay`). */
export interface IqReplayProbeRequest {
	captureId: string
	sourceId: string
	epoch: number
	observationId: string | null
	rfHz: number
	protocol: ScannerProtocol
	mode: ProbeMode
}

export interface IqReplayProbeAnswer {
	outcome: IqReplayTrialOutcome
	/** The accepted (H2) decode of this run, or null. */
	decoded: { protocol: ScannerProtocol; identity: Identity } | null
	/**
	 * WG12 req 4.5: the decoder program could not run before any output.
	 * Set only together with outcome `unsupported`.
	 */
	reason?: "decoder-unavailable"
	/**
	 * WG12 req 4.5: the probe decoder type that could not run.
	 * Set only together with outcome `unsupported`.
	 */
	unavailable?: ProbeDecoderType[]
}

export interface IqReplayProbeRun {
	/** Settles when the probe ended; a rejection counts as `cancelled`. */
	result: Promise<IqReplayProbeAnswer>
	/** Stops the probe (the result then settles, typically `cancelled`). */
	cancel(): void
}

/** The probe pool as the queue sees it (Main adapts `ProbePool.request` / its slot events). */
export interface IqReplayProbes {
	request(
		req: IqReplayProbeRequest,
	): { run: IqReplayProbeRun } | { deferred: string }
	/** A probe slot was released (any probe stopped); returns the unsubscribe. */
	onSlotRelease(listener: () => void): () => void
}

/** The capture service surface the queue needs (`IqCaptureService` satisfies it). */
export interface IqReplayQueuePort extends Pick<
	IqCapturePort,
	"claim" | "settle"
> {
	onFinished(listener: (view: IqCaptureView) => void): () => void
	view(captureId: string): IqCaptureView | null
	holderOf(captureId: string): string | null | undefined
	discard(
		captureId: string,
		reason: IqCaptureDiscardReason,
		holder?: string,
	): boolean
}

export interface IqReplayQueueTimers {
	setTimeout(fn: () => void, ms: number): unknown
	clearTimeout(handle: unknown): void
}

export interface IqReplayQueueDeps {
	port: IqReplayQueuePort
	probes: IqReplayProbes
	planner: IqReplayPlanner
	sink: IqReplaySink
	/**
	 * Review M2: true when another holder works on the capture's observation (an identify target):
	 * the capture is skipped unclaimed, for that job to claim. A throw counts as true (fail closed).
	 */
	skip?: (capture: IqCaptureView) => boolean
	/** Composes the planner input from the scanner; null when it cannot (no trials then). */
	planInput: (capture: IqCaptureView) => IqReplayPlanInput | null
	now?: () => number
	logger: Logger
	timers?: IqReplayQueueTimers
	/**
	 * WG12: the analog replay trial. Absent: a `kind: "analog"` trial ends `unsupported` and the
	 * digital trials still run (no analog dep keeps probe-only plans on today's path).
	 */
	analog?: AnalogTrialRunner
	/**
	 * WG12: reserve `ANALOG_TRIAL_CORES` for the analog trial. Null refuses it (`skipped-budget`).
	 * Absent: the trial runs with no extra reservation. The returned function releases the cores.
	 */
	reserveCores?: (cores: number) => (() => void) | null
}

export interface IqReplayQueueCounters {
	enqueued: number
	skipped: number
	results: number
	decoded: number
	trials: number
	deferrals: number
	/** Captures whose trials gave up on transient deferrals after IQ_REPLAY_DEFER_MAX_MS. */
	deferGiveUps: number
	/** Times a capture was parked because an identify job works on its observation. */
	parked: number
	sinkErrors: number
	plannerErrors: number
}

export interface IqReplayQueue {
	/** Subscribes to finished captures. */
	start(): void
	/** Cancels the running replay and discards every queued capture (no result). */
	stop(): Promise<void>
	/** Adds a finished capture (also done by the `onFinished` subscription). */
	enqueue(view: IqCaptureView): void
	/**
	 * Re-checks the parked captures (`skip` was true) now; the scanner calls it when an identify job
	 * ends. Parked captures are also re-checked every IQ_REPLAY_DEFER_RETRY_MS (one timer at most).
	 */
	recheck(): void
	size(): number
	counters(): IqReplayQueueCounters
	/** Resolves when the queue is empty and idle (tests, bench). */
	idle(): Promise<void>
}

const OUTCOMES: ReadonlySet<string> = new Set<IqReplayTrialOutcome>([
	"decoded",
	"no-sync",
	"crc-errors",
	"timeout",
	"cancelled",
	"heard",
	"data-like",
	"carrier-only",
	"unsupported",
])

const SPEC_OUTCOMES: ReadonlySet<string> = new Set<string>([
	...OUTCOMES,
	"not-needed",
	"skipped-budget",
])

/**
 * Narrows `outcome` to the amended `IqReplayTrialOutcome` union (`not-needed`,
 * `skipped-budget`). A string outside that union becomes `cancelled`.
 */
function specOutcome(outcome: string): IqReplayTrialOutcome {
	return (
		SPEC_OUTCOMES.has(outcome) ? outcome : "cancelled"
	) as IqReplayTrialOutcome
}

const defaultTimers: IqReplayQueueTimers = {
	setTimeout: (fn, ms) => {
		const t = setTimeout(fn, ms)
		t.unref()
		return t
	},
	clearTimeout: h => clearTimeout(h as NodeJS.Timeout),
}

interface Current {
	view: IqCaptureView
	trials: readonly IqReplayTrial[]
	index: number
	done: IqReplayResult["trials"][number][]
	run: IqReplayProbeRun | null
	waitTimer: unknown
	waitOff: (() => void) | null
	/** Clock ms of the capture's first transient deferral, null before any. */
	deferSince: number | null
	/** Releases ANALOG_TRIAL_CORES, once, when the analog trial ends. */
	analogRelease: (() => void) | null
	/** The runner's result, when the analog trial actually returned one. */
	analogResult: AnalogTrialResult | null
	/** Probe decoder types that ended `unsupported`. */
	unavailable: ProbeDecoderType[]
}

export function createIqReplayQueue(deps: IqReplayQueueDeps): IqReplayQueue {
	return new Queue(deps)
}

class Queue implements IqReplayQueue {
	private readonly log: Logger
	private readonly timers: IqReplayQueueTimers
	private readonly now: () => number
	private readonly fifo: string[] = []
	/** Review MAJOR c: captures left for an identify job; they stay queued until it lets go. */
	private readonly parked: string[] = []
	private parkTimer: unknown = null
	private readonly known = new Set<string>()
	private current: Current | null = null
	private stopped = false
	private started = false
	private off: (() => void) | null = null
	private idleWaiters: (() => void)[] = []
	private readonly c: IqReplayQueueCounters = {
		enqueued: 0,
		skipped: 0,
		results: 0,
		decoded: 0,
		trials: 0,
		deferrals: 0,
		deferGiveUps: 0,
		parked: 0,
		sinkErrors: 0,
		plannerErrors: 0,
	}

	constructor(private readonly d: IqReplayQueueDeps) {
		this.log = createComponentLogger(d.logger, "IqReplayQueue")
		this.timers = d.timers ?? defaultTimers
		this.now = d.now ?? Date.now
	}

	start(): void {
		if (this.started || this.stopped) return
		this.started = true
		this.off = this.d.port.onFinished(view => this.enqueue(view))
	}

	enqueue(view: IqCaptureView): void {
		if (this.stopped || this.known.has(view.captureId)) return
		this.known.add(view.captureId)
		this.fifo.push(view.captureId)
		this.c.enqueued++
		this.pump()
	}

	size(): number {
		return this.fifo.length + this.parked.length + (this.current ? 1 : 0)
	}

	recheck(): void {
		if (this.stopped) return
		if (this.parkTimer !== null) this.timers.clearTimeout(this.parkTimer)
		this.parkTimer = null
		// Parked captures go back to the head, in their order: they finished before the others.
		this.fifo.unshift(...this.parked.splice(0))
		this.pump()
		this.armPark()
	}

	private armPark(): void {
		if (this.stopped || this.parked.length === 0 || this.parkTimer !== null)
			return
		this.parkTimer = this.timers.setTimeout(() => {
			this.parkTimer = null
			this.recheck()
		}, IQ_REPLAY_DEFER_RETRY_MS)
	}

	counters(): IqReplayQueueCounters {
		return { ...this.c }
	}

	idle(): Promise<void> {
		if (this.size() === 0) return Promise.resolve()
		return new Promise(resolve => this.idleWaiters.push(resolve))
	}

	async stop(): Promise<void> {
		if (this.stopped) return
		this.stopped = true
		this.off?.()
		this.off = null
		if (this.parkTimer !== null) this.timers.clearTimeout(this.parkTimer)
		this.parkTimer = null
		this.fifo.push(...this.parked.splice(0))
		const cur = this.current
		this.current = null
		if (cur) {
			this.clearWait(cur)
			cur.run?.cancel()
			this.releaseAnalog(cur)
			this.d.port.discard(
				cur.view.captureId,
				"shutdown",
				IQ_REPLAY_QUEUE_HOLDER,
			)
			this.known.delete(cur.view.captureId)
		}
		for (const id of this.fifo.splice(0)) {
			this.known.delete(id)
			if (this.d.port.holderOf(id) === null) this.d.port.discard(id, "shutdown")
		}
		this.notifyIdle()
		await Promise.resolve()
	}

	private notifyIdle(): void {
		if (this.size() !== 0) return
		const waiters = this.idleWaiters
		this.idleWaiters = []
		for (const w of waiters) w()
	}

	/** Takes the next live head over and starts its trials. Never recursive on itself. */
	private pump(): void {
		while (!this.stopped && !this.current) {
			const id = this.fifo.shift()
			if (id === undefined) {
				this.armPark()
				this.notifyIdle()
				return
			}
			this.known.delete(id)
			const view = this.d.port.view(id)
			if (!view || this.d.port.holderOf(id) !== null) {
				this.c.skipped++
				continue
			}
			if (this.isSkipped(view)) {
				// Left for the identify job; re-checked on recheck() or the retry timer.
				this.known.add(id)
				this.parked.push(id)
				this.c.parked++
				continue
			}
			if (!this.d.port.claim(id, IQ_REPLAY_QUEUE_HOLDER)) {
				this.c.skipped++
				continue
			}
			this.current = {
				view,
				trials: this.plan(view),
				index: 0,
				done: [],
				run: null,
				waitTimer: null,
				waitOff: null,
				deferSince: null,
				analogRelease: null,
				analogResult: null,
				unavailable: [],
			}
			this.next()
		}
	}

	private isSkipped(view: IqCaptureView): boolean {
		if (!this.d.skip) return false
		try {
			return this.d.skip(view)
		} catch {
			return true
		}
	}

	private plan(view: IqCaptureView): readonly IqReplayTrial[] {
		try {
			const input = this.d.planInput(view)
			if (!input) return []
			const trials = this.d.planner(input)
			if (!Array.isArray(trials)) return []
			const known = trials.filter(t => t.known)
			const rest = trials.filter(t => !t.known)
			return [...known, ...rest].slice(0, IQ_REPLAY_MAX_TRIALS)
		} catch (err: unknown) {
			this.c.plannerErrors++
			this.log.warn({ err: safeErrorFields(err) }, "Replay planner failed")
			return []
		}
	}

	/** Requests the current trial or finishes the entry. */
	private next(): void {
		const cur = this.current
		if (!cur || this.stopped) return
		if (!this.d.port.view(cur.view.captureId) && cur.done.length === 0) {
			// Gone before any trial ran (live confirmation, orphan TTL, invalid): no result.
			this.clearWait(cur)
			this.current = null
			this.c.skipped++
			this.pump()
			return
		}
		// All trials ran, or gone after some ran (orphan TTL): the result of what ran.
		if (
			cur.index >= cur.trials.length ||
			!this.d.port.view(cur.view.captureId)
		) {
			this.finish(cur, null)
			return
		}
		const trial = cur.trials[cur.index]
		if (!trial) {
			this.finish(cur, null)
			return
		}
		if (trial.kind === "analog") {
			this.startAnalog(cur, trial)
			return
		}
		let answer: { run: IqReplayProbeRun } | { deferred: string }
		try {
			answer = this.d.probes.request({
				captureId: cur.view.captureId,
				sourceId: cur.view.sourceId,
				epoch: cur.view.epoch,
				observationId: cur.view.observationId,
				rfHz: cur.view.rfHz,
				protocol: trial.protocol,
				mode: trial.mode,
			})
		} catch {
			answer = { deferred: "error" }
		}
		if ("deferred" in answer) {
			this.c.deferrals++
			if (!IQ_REPLAY_RETRIABLE_DEFERRALS.has(answer.deferred)) {
				// Fail closed: this trial cannot run; the next one (or the next capture) goes.
				this.cancelTrials(cur, cur.index + 1)
				return
			}
			const now = this.now()
			cur.deferSince ??= now
			if (now - cur.deferSince >= IQ_REPLAY_DEFER_MAX_MS) {
				this.c.deferGiveUps++
				this.cancelTrials(cur, cur.trials.length)
				return
			}
			this.waitForSlot(cur)
			return
		}
		cur.run = answer.run
		this.c.trials++
		answer.run.result.then(
			a => this.onAnswer(cur, trial, a),
			() => this.onAnswer(cur, trial, { outcome: "cancelled", decoded: null }),
		)
	}

	/** Records the trials from the current one up to `end` (exclusive) as `cancelled` and moves on. */
	private cancelTrials(cur: Current, end: number): void {
		for (; cur.index < end; cur.index++) {
			const t = cur.trials[cur.index]
			if (t)
				cur.done.push({
					protocol: t.protocol,
					decoderType: t.mode.decoderType,
					known: t.known,
					outcome: "cancelled",
				})
		}
		this.next()
	}

	private waitForSlot(cur: Current): void {
		const retry = () => {
			if (this.current !== cur || cur.waitOff === null) return
			this.clearWait(cur)
			this.next()
		}
		cur.waitOff = this.d.probes.onSlotRelease(retry)
		cur.waitTimer = this.timers.setTimeout(retry, IQ_REPLAY_DEFER_RETRY_MS)
	}

	private clearWait(cur: Current): void {
		cur.waitOff?.()
		cur.waitOff = null
		if (cur.waitTimer !== null) this.timers.clearTimeout(cur.waitTimer)
		cur.waitTimer = null
	}

	private onAnswer(cur: Current, trial: IqReplayTrial, raw: unknown): void {
		if (this.current !== cur || this.stopped) return
		cur.run = null
		const a = sanitize(raw)
		const done: IqReplayResult["trials"][number] = {
			protocol: trial.protocol,
			decoderType: trial.mode.decoderType,
			known: trial.known,
			outcome: a.outcome,
		}
		if (a.outcome === "unsupported" && a.reason === "decoder-unavailable")
			done.reason = "decoder-unavailable"
		cur.done.push(done)
		if (a.outcome === "unsupported")
			this.noteUnavailable(cur, trial.mode.decoderType)
		if (a.outcome === "decoded" && a.decoded) {
			this.finish(cur, a.decoded)
			return
		}
		cur.index++
		this.next()
	}

	private finish(cur: Current, decoded: IqReplayResult["decoded"]): void {
		if (this.current !== cur) return
		this.clearWait(cur)
		this.current = null
		const result: IqReplayResult = {
			captureId: cur.view.captureId,
			sourceId: cur.view.sourceId,
			observationId: cur.view.observationId,
			epoch: cur.view.epoch,
			trials: cur.done,
			decoded,
		}
		if (cur.analogResult) result.analog = cur.analogResult
		if (cur.unavailable.length > 0)
			result.unavailable = [...new Set(cur.unavailable)].sort()
		this.c.results++
		if (decoded) this.c.decoded++
		try {
			this.d.sink(result)
		} catch (err: unknown) {
			this.c.sinkErrors++
			this.log.warn({ err: safeErrorFields(err) }, "Replay result sink failed")
		}
		this.d.port.settle(cur.view.captureId, IQ_REPLAY_QUEUE_HOLDER)
		this.pump()
	}

	/** One analog trial: no runner → unsupported; reservation refused → skipped-budget; else `analog.run`. */
	private startAnalog(cur: Current, trial: IqReplayTrial): void {
		const runner = this.d.analog
		if (!runner) {
			this.recordAnalog(cur, trial, "unsupported", null)
			return
		}
		if (this.d.reserveCores) {
			let release: (() => void) | null
			try {
				release = this.d.reserveCores(ANALOG_TRIAL_CORES)
			} catch (err: unknown) {
				this.log.warn(
					{ err: safeErrorFields(err) },
					"Analog core reservation failed",
				)
				release = null
			}
			if (!release) {
				this.recordAnalog(cur, trial, specOutcome("skipped-budget"), null)
				return
			}
			cur.analogRelease = release
		}
		const abort = new AbortController()
		const mode = trial.analogMode ?? "nfm"
		let pending: Promise<AnalogTrialResult>
		try {
			pending = runner.run(cur.view.captureId, mode, abort.signal)
		} catch (err: unknown) {
			this.log.warn({ err: safeErrorFields(err) }, "Analog trial failed")
			abort.abort()
			this.releaseAnalog(cur)
			this.recordAnalog(cur, trial, "cancelled", null)
			return
		}
		this.c.trials++
		cur.run = {
			result: Promise.resolve(pending).then(
				() => ({ outcome: "cancelled", decoded: null }),
				() => ({ outcome: "cancelled", decoded: null }),
			),
			cancel: () => abort.abort(),
		}
		void Promise.resolve(pending).then(
			result => this.onAnalog(cur, trial, result),
			() => this.onAnalog(cur, trial, null),
		)
	}

	private onAnalog(cur: Current, trial: IqReplayTrial, raw: unknown): void {
		let judged: {
			outcome: IqReplayTrialOutcome
			analog: AnalogTrialResult | null
		}
		try {
			judged = judgeAnalogResult(raw)
		} catch (err: unknown) {
			this.log.warn(
				{ err: safeErrorFields(err) },
				"Analog trial result rejected",
			)
			judged = { outcome: "cancelled", analog: null }
		}
		this.recordAnalog(cur, trial, judged.outcome, judged.analog)
	}

	private recordAnalog(
		cur: Current,
		trial: IqReplayTrial,
		outcome: IqReplayTrialOutcome,
		result: AnalogTrialResult | null,
	): void {
		this.releaseAnalog(cur)
		if (this.current !== cur || this.stopped) return
		cur.run = null
		if (result) cur.analogResult = result
		cur.done.push({
			protocol: trial.protocol,
			decoderType: trial.mode.decoderType,
			known: trial.known,
			outcome,
			decoder: "analog-demod",
			mode: trial.analogMode ?? result?.mode ?? "nfm",
		})
		cur.index++
		if (outcome === "decoded" || outcome === "heard") {
			this.markRestNotNeeded(cur)
			this.finish(cur, null)
			return
		}
		this.next()
	}

	/** Digital trials that do not run after analog `decoded` or `heard`. */
	private markRestNotNeeded(cur: Current): void {
		for (; cur.index < cur.trials.length; cur.index++) {
			const t = cur.trials[cur.index]
			if (!t) continue
			cur.done.push({
				protocol: t.protocol,
				decoderType: t.mode.decoderType,
				known: t.known,
				outcome: specOutcome("not-needed"),
			})
		}
	}

	private noteUnavailable(cur: Current, type: ProbeDecoderType): void {
		if (!cur.unavailable.includes(type)) cur.unavailable.push(type)
	}

	private releaseAnalog(cur: Current): void {
		const release = cur.analogRelease
		cur.analogRelease = null
		if (!release) return
		try {
			release()
		} catch (err: unknown) {
			this.log.warn({ err: safeErrorFields(err) }, "Analog core release failed")
		}
	}
}

/** A probe answer is untrusted: an unknown outcome is `cancelled`, a decode needs `decoded`. */
function sanitize(raw: unknown): IqReplayProbeAnswer {
	if (typeof raw !== "object" || raw === null)
		return { outcome: "cancelled", decoded: null }
	const r = raw as { outcome?: unknown; decoded?: unknown; reason?: unknown }
	const outcome =
		typeof r.outcome === "string" && OUTCOMES.has(r.outcome)
			? (r.outcome as IqReplayTrialOutcome)
			: "cancelled"
	const d = r.decoded as
		| { protocol?: unknown; identity?: { kind?: unknown; value?: unknown } }
		| null
		| undefined
	const decoded =
		outcome === "decoded" &&
		d &&
		typeof d.protocol === "string" &&
		d.identity &&
		typeof d.identity.kind === "string" &&
		typeof d.identity.value === "string"
			? (d as IqReplayProbeAnswer["decoded"])
			: null
	const answer: IqReplayProbeAnswer = {
		outcome: outcome === "decoded" && !decoded ? "no-sync" : outcome,
		decoded,
	}
	if (answer.outcome === "unsupported" && r.reason === "decoder-unavailable")
		answer.reason = "decoder-unavailable"
	return answer
}
