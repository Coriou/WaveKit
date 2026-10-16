/** Sources: GET /api/sources, then `source:status` / `source:removed` on the `sources` channel. */
import type { ExtendedSourceStatus } from "@wavekit/api-types"
import type { ApiClient } from "./api-client.ts"
import { errorMessage } from "./api-client.ts"
import type { EventsClient } from "./events-client.ts"
import { Store } from "./store.ts"

export interface SourcesState {
	sources: readonly ExtendedSourceStatus[]
	loaded: boolean
	error: string | null
}

export class SourcesStore extends Store<SourcesState> {
	private readonly api: ApiClient
	private readonly cleanup: (() => void)[]

	constructor(api: ApiClient, events: EventsClient) {
		super({ sources: [], loaded: false, error: null })
		this.api = api
		this.cleanup = [
			events.subscribe(["sources"]),
			events.on("source:status", status => this.upsert(status)),
			events.on("source:removed", ({ sourceId }) =>
				this.update(s => ({
					...s,
					sources: s.sources.filter(x => x.id !== sourceId),
				})),
			),
			events.onReconnected(() => void this.load()),
		]
	}

	byId(id: string): ExtendedSourceStatus | undefined {
		return this.get().sources.find(s => s.id === id)
	}

	/** Never rejects: a failure lands in `error`. */
	async load(): Promise<void> {
		try {
			const sources = await this.api.get<ExtendedSourceStatus[]>("/api/sources")
			this.set({ sources, loaded: true, error: null })
		} catch (error) {
			this.update(s => ({ ...s, error: errorMessage(error) }))
		}
	}

	dispose(): void {
		for (const fn of this.cleanup.splice(0)) fn()
	}

	private upsert(status: ExtendedSourceStatus): void {
		this.update(s => {
			const index = s.sources.findIndex(x => x.id === status.id)
			const sources =
				index < 0
					? [...s.sources, status]
					: s.sources.map((x, i) => (i === index ? status : x))
			return { ...s, sources }
		})
	}
}
