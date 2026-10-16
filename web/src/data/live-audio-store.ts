/**
 * Live audio: GET /api/live-audio/status, start/stop, PATCH config (modulation, bandwidth,
 * squelch, offsetHz...), and the `live-audio` channel (status, config, level).
 */
import type {
	LiveAudioConfig,
	LiveAudioLevel,
	LiveAudioStatus,
	TunerState,
} from "@wavekit/api-types"
import type { ApiClient } from "./api-client.ts"
import { errorMessage } from "./api-client.ts"
import type { EventsClient } from "./events-client.ts"
import { Store } from "./store.ts"

export interface LiveAudioState {
	status: LiveAudioStatus | null
	level: LiveAudioLevel | null
	loaded: boolean
	busy: boolean
	error: string | null
}

/** PATCH body: any config field; `agc: null` returns to the modulation default. */
export type LiveAudioConfigPatch = Partial<Omit<LiveAudioConfig, "agc">> & {
	agc?: LiveAudioConfig["agc"] | null
}

/** The app's tuned frequency: the hardware centre plus the live-audio channel offset. */
export function tunedHz(
	tuner: TunerState | undefined,
	status: LiveAudioStatus | null,
): number | null {
	if (!tuner) return null
	return tuner.frequency + (status?.config.offsetHz ?? 0)
}

export class LiveAudioStore extends Store<LiveAudioState> {
	private readonly api: ApiClient
	private readonly cleanup: (() => void)[]

	constructor(api: ApiClient, events: EventsClient) {
		super({
			status: null,
			level: null,
			loaded: false,
			busy: false,
			error: null,
		})
		this.api = api
		this.cleanup = [
			events.subscribe(["live-audio"]),
			events.on("live-audio:status", status =>
				this.update(s => ({ ...s, status })),
			),
			events.on("live-audio:config", config =>
				this.update(s =>
					s.status ? { ...s, status: { ...s.status, config } } : s,
				),
			),
			events.on("live-audio:level", level =>
				this.update(s => ({ ...s, level })),
			),
			events.onReconnected(() => void this.load()),
		]
	}

	/** Never rejects: a failure lands in `error`. */
	async load(): Promise<void> {
		try {
			const status = await this.api.get<LiveAudioStatus>(
				"/api/live-audio/status",
			)
			this.update(s => ({ ...s, status, loaded: true, error: null }))
		} catch (error) {
			this.update(s => ({ ...s, error: errorMessage(error) }))
		}
	}

	start(): Promise<void> {
		return this.action(() =>
			this.api.post<{ success: boolean }>("/api/live-audio/start"),
		)
	}

	stop(): Promise<void> {
		return this.action(() =>
			this.api.post<{ success: boolean }>("/api/live-audio/stop"),
		)
	}

	/** Applies a config change; resolves with the new status. Rejects with the ApiError. */
	async setConfig(patch: LiveAudioConfigPatch): Promise<LiveAudioStatus> {
		this.update(s => ({ ...s, busy: true }))
		try {
			const status = await this.api.patch<LiveAudioStatus>(
				"/api/live-audio/config",
				patch,
			)
			this.update(s => ({ ...s, status, error: null }))
			return status
		} catch (error) {
			this.update(s => ({ ...s, error: errorMessage(error) }))
			throw error
		} finally {
			this.update(s => ({ ...s, busy: false }))
		}
	}

	dispose(): void {
		for (const fn of this.cleanup.splice(0)) fn()
	}

	private async action(run: () => Promise<unknown>): Promise<void> {
		this.update(s => ({ ...s, busy: true }))
		try {
			await run()
			const status = await this.api.get<LiveAudioStatus>(
				"/api/live-audio/status",
			)
			this.update(s => ({ ...s, status, error: null }))
		} catch (error) {
			this.update(s => ({ ...s, error: errorMessage(error) }))
			throw error
		} finally {
			this.update(s => ({ ...s, busy: false }))
		}
	}
}
