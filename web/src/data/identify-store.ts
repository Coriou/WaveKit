/**
 * Identify: POST /api/scanner/identify (201 ScanJob), then `scanner:identify` progress on the
 * `scanner` channel: waiting-for-signal → trying → identified | candidate | unidentified.
 */
import type {
	ScanJob,
	ScannerIdentifyEventData,
	ScannerIdentifyRequest,
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
}

export interface IdentifyOptions {
	sourceId?: string
	bandwidthHz?: number
	timeoutMs?: number
	protocols?: ScannerProtocol[]
}

const FINAL: ReadonlySet<ScannerIdentifyState> = new Set([
	"identified",
	"candidate",
	"unidentified",
])

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
}

export class IdentifyStore extends Store<IdentifyState> {
	private readonly api: ApiClient
	private readonly cleanup: (() => void)[]
	/** Events that arrive before the POST answer, by job id (the last one wins). */
	private readonly early = new Map<string, ScannerIdentifyEventData>()
	private generation = 0

	constructor(api: ApiClient, events: EventsClient) {
		super(INITIAL)
		this.api = api
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
		const generation = ++this.generation
		this.early.clear()
		this.set({ ...INITIAL, targetHz: hz, starting: true })
		const body: ScannerIdentifyRequest = {
			target:
				options.bandwidthHz !== undefined
					? { frequencyHz: hz, bandwidthHz: options.bandwidthHz }
					: { frequencyHz: hz },
		}
		if (options.sourceId !== undefined) body.sourceId = options.sourceId
		if (options.timeoutMs !== undefined) body.timeoutMs = options.timeoutMs
		if (options.protocols !== undefined) body.protocols = options.protocols
		try {
			const job = await this.api.post<ScanJob>("/api/scanner/identify", body)
			if (generation !== this.generation) return job
			const event = this.early.get(job.id) ?? job.identify?.targets[0] ?? null
			this.early.clear()
			this.update(s => ({ ...s, job, event, starting: false }))
			return job
		} catch (error) {
			if (generation === this.generation)
				this.update(s => ({
					...s,
					starting: false,
					error: errorMessage(error),
					errorCode: isApiError(error) ? error.code : null,
				}))
			throw error
		}
	}

	/** Forgets the current identify (the job itself runs to its end on the core). */
	reset(): void {
		this.generation += 1
		this.early.clear()
		this.set(INITIAL)
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
		} catch (error) {
			this.update(s => ({ ...s, error: errorMessage(error) }))
		}
	}

	dispose(): void {
		for (const fn of this.cleanup.splice(0)) fn()
	}

	private onEvent(event: ScannerIdentifyEventData): void {
		const s = this.get()
		if (s.job === null) {
			if (s.starting) this.early.set(event.jobId, event)
			return
		}
		if (event.jobId !== s.job.id) return
		this.update(x => ({ ...x, event }))
	}
}
