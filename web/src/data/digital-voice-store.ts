/**
 * Decoded digital voice (dsd-fme): GET /api/digital-voice/status, start, and the `digital-voice` channel
 * (status and call edges). Listen › What you hear plays a decoder's stream from here.
 */
import type { DigitalVoiceStatus } from "@wavekit/api-types"
import type { ApiClient } from "./api-client.ts"
import { errorMessage } from "./api-client.ts"
import type { EventsClient } from "./events-client.ts"
import { Store } from "./store.ts"

export interface DigitalVoiceState {
	/** Null before the first load, or on a core without the route. */
	status: DigitalVoiceStatus | null
	loaded: boolean
	error: string | null
}

export class DigitalVoiceStore extends Store<DigitalVoiceState> {
	private readonly api: ApiClient
	private readonly cleanup: (() => void)[]

	constructor(api: ApiClient, events: EventsClient) {
		super({ status: null, loaded: false, error: null })
		this.api = api
		this.cleanup = [
			events.subscribe(["digital-voice"]),
			events.on("digital-voice:status", status =>
				this.update(s => ({ ...s, status })),
			),
			// a call edge: the status carries the call per decoder, read it again
			events.on("digital-voice:call", () => void this.load()),
			events.onReconnected(() => void this.load()),
		]
	}

	/** Never rejects: a failure lands in `error`. */
	async load(): Promise<void> {
		try {
			const status = await this.api.get<DigitalVoiceStatus>(
				"/api/digital-voice/status",
			)
			this.set({ status, loaded: true, error: null })
		} catch (error) {
			this.update(s => ({ ...s, loaded: true, error: errorMessage(error) }))
		}
	}

	/** Starts the decoded voice stream when it is not running; rejects with the core's error (409: no decoder streams voice). */
	async ensureRunning(): Promise<void> {
		if (this.get().status?.running) return
		await this.api.post<{ success: boolean }>("/api/digital-voice/start")
		await this.load()
	}

	dispose(): void {
		for (const fn of this.cleanup.splice(0)) fn()
	}
}
