/**
 * Identify: POST /api/scanner/identify (201 ScanJob), then `scanner:identify` progress on the
 * `scanner` channel: waiting-for-signal → trying → identified | candidate | unidentified.
 *
 * "Until a transmission" (Ben, 2026-10-17): the core bounds the wait for a signal (timeoutMs ≤ 120 s), so with
 * the option on each job asks for the longest wait and, when it ends with nothing heard, the store starts the next
 * one, until a transmission is tried, Stop, or an error (docs/web/CORE-GAPS.md asks the core for an open wait).
 */
import type {
	ScanJob,
	ScannerIdentifyEventData,
	ScannerIdentifyRequest,
	ScannerIdentifyResult,
	ScannerIdentifyState,
	ScannerProtocol,
} from "@wavekit/api-types"
import type { ApiClient } from "./api-client.ts"
import { errorMessage, isApiError } from "./api-client.ts"
import type { EventsClient } from "./events-client.ts"
import { Store } from "./store.ts"

export interface IdentifyState {
	/** The frequency asked about; set from start() until reset(). */
	targetHz: number | null
	job: ScanJob | null
	/** Latest progress for the target. */
	event: ScannerIdentifyEventData | null
	/** True while the POST is in flight. */
	starting: boolean
	error: string | null
	/** The core's code, e.g. OUT_OF_WINDOW. */
	errorCode: string | null
	/** The protocols asked for ("Decode as…"); empty tries every plausible one. */
	protocols: readonly ScannerProtocol[]
	/** Keep listening until a transmission comes (remembered per browser; outlives reset()). */
	untilSignal: boolean
	/** While waiting until a transmission: when the wait began (epoch ms), across the jobs it took. */
	waitSince: number | null
	/** Started by the card on its own, when a transmission began on a frequency nothing decodes. */
	auto: boolean
	/** What was identified this session, newest first (outlives reset(), so the card keeps saying it). */
	known: readonly KnownSignal[]
}

/** A frequency Identify answered with a protocol. */
export interface KnownSignal {
	hz: number
	result: ScannerIdentifyResult
	/** When it was identified (epoch ms). */
	at: number
}

/** The answers kept for the session. */
const KNOWN_MAX = 32

/** The latest answer within `toleranceHz` of `hz`. */
export function knownAt(
	known: readonly KnownSignal[],
	hz: number,
	toleranceHz: number,
): KnownSignal | null {
	return known.find(k => Math.abs(k.hz - hz) <= toleranceHz) ?? null
}

export interface IdentifyOptions {
	sourceId?: string
	/** Started by the card on its own (not sent to the core). */
	auto?: boolean
	bandwidthHz?: number
	timeoutMs?: number
	protocols?: ScannerProtocol[]
}

const FINAL: ReadonlySet<ScannerIdentifyState> = new Set([
	"identified",
	"candidate",
	"unidentified",
])

/** The core's longest wait for a signal (POST /api/scanner/identify timeoutMs maximum). */
export const IDENTIFY_MAX_WAIT_MS = 120_000
/** Before starting the next job of a wait, and before the one retry of a refused start. */
const NEXT_JOB_DELAY_MS = 500
const RETRY_DELAY_MS = 2_000
export const UNTIL_SIGNAL_KEY = "wk.identify.untilSignal"

/** Minimal storage (localStorage, or a fake in tests). */
export interface IdentifyPrefStorage {
	getItem(key: string): string | null
	setItem(key: string, value: string): void
}

/**
 * The job ended because nothing transmitted: no emission resolved at the target (the measurement is the
 * spectrum's, not a track's), no live-audio transmission matched, no trial ran, and it was not an artefact
 * or a retune.
 */
export function endedWithNothingHeard(
	event: ScannerIdentifyEventData | null | undefined,
): boolean {
	if (!event || event.state !== "unidentified") return false
	const r = event.result
	if (event.trials.length > 0) return false
	if (!r) return true
	return (
		r.artefact === undefined &&
		r.ended === undefined &&
		r.analog === undefined &&
		r.measurements.source === "spectrum"
	)
}

export function isIdentifyFinal(
	state: ScannerIdentifyState | null | undefined,
): boolean {
	return state !== null && state !== undefined && FINAL.has(state)
}

const INITIAL: IdentifyState = {
	targetHz: null,
	job: null,
	event: null,
	starting: false,
	error: null,
	errorCode: null,
	protocols: [],
	untilSignal: false,
	waitSince: null,
	auto: false,
	known: [],
}

export class IdentifyStore extends Store<IdentifyState> {
	private readonly api: ApiClient
	private readonly cleanup: (() => void)[]
	/** Events that arrive before the POST answer, by job id (the last one wins). */
	private readonly early = new Map<string, ScannerIdentifyEventData>()
	private generation = 0
	private readonly storage: IdentifyPrefStorage | null
	private readonly now: () => number
	/** What start() was asked, so a wait can start its next job the same way. */
	private asked: { hz: number; options: IdentifyOptions } | null = null
	private timer: ReturnType<typeof setTimeout> | null = null

	constructor(
		api: ApiClient,
		events: EventsClient,
		storage: IdentifyPrefStorage | null = null,
		now: () => number = Date.now,
	) {
		super({ ...INITIAL, untilSignal: readPref(storage) })
		this.api = api
		this.storage = storage
		this.now = now
		this.cleanup = [
			events.subscribe(["scanner"]),
			events.on("scanner:identify", event => this.onEvent(event)),
			events.on("scanner:job", job => {
				if (this.get().job?.id === job.id) this.update(s => ({ ...s, job }))
			}),
			events.onReconnected(() => void this.refresh()),
		]
	}

	/** True while a job runs and has no final answer yet. */
	get active(): boolean {
		const s = this.get()
		return s.starting || (s.job !== null && !isIdentifyFinal(s.event?.state))
	}

	/** Starts identifying `hz`. Rejects with the ApiError (also kept in `error`/`errorCode`). */
	async start(hz: number, options: IdentifyOptions = {}): Promise<ScanJob> {
		this.asked = { hz, options }
		const { untilSignal, known } = this.get()
		this.set({
			...INITIAL,
			untilSignal,
			known,
			// one started on its own answers the transmission that started it, never waits on and on
			waitSince: untilSignal && options.auto !== true ? this.now() : null,
			targetHz: hz,
			starting: true,
			protocols: options.protocols ?? [],
			auto: options.auto === true,
		})
		return this.launch(hz, options, false)
	}

	/**
	 * Turns "until a transmission" on or off (remembered per browser). On during a wait, the job running now
	 * is followed by the next when it ends with nothing heard; off, it ends at its own timeout.
	 */
	setUntilSignal(on: boolean): void {
		try {
			this.storage?.setItem(UNTIL_SIGNAL_KEY, on ? "1" : "0")
		} catch {
			// private mode or a full quota: the choice still holds for this page
		}
		const s = this.get()
		const waiting = this.active && s.event?.state !== "trying"
		const since = s.job
			? Date.parse(s.job.startedAt ?? s.job.createdAt)
			: this.now()
		this.update(x => ({
			...x,
			untilSignal: on,
			waitSince:
				on && waiting ? (Number.isFinite(since) ? since : this.now()) : null,
		}))
		if (!on) this.clearTimer()
		else this.continueIfNothingHeard()
	}

	private async launch(
		hz: number,
		options: IdentifyOptions,
		next: boolean,
	): Promise<ScanJob> {
		const generation = ++this.generation
		this.early.clear()
		const untilSignal = this.get().waitSince !== null
		const body: ScannerIdentifyRequest = {
			target:
				options.bandwidthHz !== undefined
					? { frequencyHz: hz, bandwidthHz: options.bandwidthHz }
					: { frequencyHz: hz },
		}
		if (options.sourceId !== undefined) body.sourceId = options.sourceId
		if (options.timeoutMs !== undefined) body.timeoutMs = options.timeoutMs
		else if (untilSignal) body.timeoutMs = IDENTIFY_MAX_WAIT_MS
		if (options.protocols !== undefined) body.protocols = options.protocols
		try {
			const job = await this.api.post<ScanJob>("/api/scanner/identify", body)
			if (generation !== this.generation) return job
			const event = this.early.get(job.id) ?? job.identify?.targets[0] ?? null
			this.early.clear()
			this.update(s => ({ ...s, job, event, starting: false }))
			this.remember()
			this.continueIfNothingHeard()
			return job
		} catch (error) {
			// the next job of a wait is refused (the last one still closing on the core): try once more
			if (
				next &&
				generation === this.generation &&
				this.get().waitSince !== null
			) {
				this.later(RETRY_DELAY_MS, () =>
					this.launch(hz, options, false).catch(() => undefined),
				)
				throw error
			}
			if (generation === this.generation)
				this.update(s => ({
					...s,
					starting: false,
					error: errorMessage(error),
					errorCode: isApiError(error) ? error.code : null,
					waitSince: null,
				}))
			throw error
		}
	}

	/**
	 * Forgets the current identify. The job itself runs to its end on the core, except a wait until a
	 * transmission (up to 2 min), which is cancelled.
	 */
	reset(): void {
		const s = this.get()
		if (
			s.waitSince !== null &&
			s.job !== null &&
			!isIdentifyFinal(s.event?.state)
		)
			void this.api
				.post(`/api/scanner/jobs/${encodeURIComponent(s.job.id)}/cancel`)
				.catch(() => undefined)
		this.generation += 1
		this.early.clear()
		this.clearTimer()
		this.asked = null
		const { untilSignal, known } = this.get()
		this.set({ ...INITIAL, untilSignal, known })
	}

	/** Refetches the job after a reconnect (progress sent while offline is not replayed). */
	async refresh(): Promise<void> {
		const id = this.get().job?.id
		if (!id) return
		try {
			const job = await this.api.get<ScanJob>(
				`/api/scanner/jobs/${encodeURIComponent(id)}`,
			)
			if (this.get().job?.id !== id) return
			const event =
				job.identify?.targets.find(t => t.targetHz === this.get().targetHz) ??
				job.identify?.targets[0] ??
				null
			this.update(s => ({ ...s, job, event: event ?? s.event }))
			this.remember()
			this.continueIfNothingHeard()
		} catch (error) {
			if (this.get().job?.id !== id) return
			// A restarted core has lost the job (404 SCANNER_NOT_FOUND). A final answer already shown
			// stays; one still in progress ends as an error instead of "Trying decoders" forever.
			if (isApiError(error) && error.status === 404) {
				if (isIdentifyFinal(this.get().event?.state)) return
				this.update(s => ({
					...s,
					job: null,
					event: null,
					error:
						"The receiver restarted and this identify was lost. Try again.",
					errorCode: error.code,
					waitSince: null,
				}))
				return
			}
			this.update(s => ({ ...s, error: errorMessage(error) }))
		}
	}

	dispose(): void {
		this.clearTimer()
		for (const fn of this.cleanup.splice(0)) fn()
	}

	/** While waiting until a transmission, a job that ended with nothing heard is followed by the next. */
	private continueIfNothingHeard(): void {
		const s = this.get()
		const asked = this.asked
		if (s.waitSince === null || asked === null || this.timer !== null) return
		if (!endedWithNothingHeard(s.event)) {
			// a transmission came (or another end): the wait is over, the answer shows as usual
			if (isIdentifyFinal(s.event?.state))
				this.update(x => ({ ...x, waitSince: null }))
			return
		}
		// the next job's progress may come before its POST answer: no job held, so early events are kept
		this.update(x => ({ ...x, job: null, event: null, starting: true }))
		this.later(NEXT_JOB_DELAY_MS, () =>
			this.launch(asked.hz, asked.options, true).catch(() => undefined),
		)
	}

	private later(ms: number, fn: () => Promise<unknown>): void {
		this.clearTimer()
		const generation = this.generation
		this.timer = setTimeout(() => {
			this.timer = null
			if (generation === this.generation && this.get().waitSince !== null)
				void fn()
		}, ms)
	}

	private clearTimer(): void {
		if (this.timer === null) return
		clearTimeout(this.timer)
		this.timer = null
	}

	private onEvent(event: ScannerIdentifyEventData): void {
		const s = this.get()
		if (s.job === null) {
			if (s.starting) this.early.set(event.jobId, event)
			return
		}
		if (event.jobId !== s.job.id) return
		this.update(x => ({ ...x, event }))
		this.remember()
		this.continueIfNothingHeard()
	}

	/** Keeps an identified answer for the session, one per frequency. */
	private remember(): void {
		const s = this.get()
		const result = s.event?.result
		if (s.event?.state !== "identified" || !result?.protocol) return
		const hz = s.event.targetHz
		const first = s.known[0]
		if (first && first.hz === hz && first.result === result) return
		const known: KnownSignal[] = [
			{ hz, result, at: this.now() },
			...s.known.filter(k => k.hz !== hz),
		].slice(0, KNOWN_MAX)
		this.update(x => ({ ...x, known }))
	}
}

function readPref(storage: IdentifyPrefStorage | null): boolean {
	try {
		return storage?.getItem(UNTIL_SIGNAL_KEY) === "1"
	} catch {
		return false
	}
}
