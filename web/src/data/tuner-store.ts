/** Tuner state per source: GET /api/tuner, `tuner:state-changed`, and tune() via REST. */
import type { TunerState } from "@wavekit/api-types"
import type { ApiClient } from "./api-client.ts"
import { errorMessage } from "./api-client.ts"
import type { EventsClient } from "./events-client.ts"
import { Store } from "./store.ts"

export interface TunerStoreState {
	bySource: Readonly<Record<string, TunerState>>
	/** Frequencies being commanded, per source. */
	pending: Readonly<Record<string, number>>
	loaded: boolean
	error: string | null
}

export class TunerStore extends Store<TunerStoreState> {
	private readonly api: ApiClient
	private readonly cleanup: (() => void)[]

	constructor(api: ApiClient, events: EventsClient) {
		super({ bySource: {}, pending: {}, loaded: false, error: null })
		this.api = api
		this.cleanup = [
			events.subscribe(["tuner"]),
			events.on("tuner:state-changed", ({ sourceId, state }) =>
				this.put(sourceId, state),
			),
			events.onReconnected(() => void this.load()),
		]
	}

	/** The first tuner-controlled source, or null before load. */
	get defaultSourceId(): string | null {
		return Object.keys(this.get().bySource)[0] ?? null
	}

	state(sourceId?: string): TunerState | undefined {
		const id = sourceId ?? this.defaultSourceId
		return id === null ? undefined : this.get().bySource[id]
	}

	/** Never rejects: a failure lands in `error`. */
	async load(): Promise<void> {
		try {
			const states = await this.api.get<TunerState[]>("/api/tuner")
			const bySource: Record<string, TunerState> = {}
			for (const s of states) bySource[s.sourceId] = s
			this.update(s => ({ ...s, bySource, loaded: true, error: null }))
		} catch (error) {
			this.update(s => ({ ...s, error: errorMessage(error) }))
		}
	}

	/** Retunes the hardware centre. Rejects with the ApiError (also kept in `error`). */
	async tune(hz: number, sourceId?: string): Promise<TunerState> {
		const id = sourceId ?? this.defaultSourceId
		if (id === null) throw new Error("No tuner source")
		const target = Math.round(hz)
		this.update(s => ({ ...s, pending: { ...s.pending, [id]: target } }))
		try {
			const state = await this.api.post<TunerState>(
				`/api/tuner/${encodeURIComponent(id)}/frequency`,
				{ hz: target },
			)
			this.put(id, state)
			this.update(s => ({ ...s, error: null }))
			return state
		} catch (error) {
			this.update(s => ({ ...s, error: errorMessage(error) }))
			throw error
		} finally {
			this.update(s => {
				if (s.pending[id] !== target) return s
				const pending = { ...s.pending }
				delete pending[id]
				return { ...s, pending }
			})
		}
	}

	dispose(): void {
		for (const fn of this.cleanup.splice(0)) fn()
	}

	private put(sourceId: string, state: TunerState): void {
		this.update(s => ({ ...s, bySource: { ...s.bySource, [sourceId]: state } }))
	}
}
