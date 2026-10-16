/**
 * The web app's data layer: one ApiClient, one EventsClient and the domain stores wired to
 * them. createDataLayer() is the only place that builds them; nothing here is global.
 */
import type { AccessState, ApiClientOptions, FetchLike } from "./api-client.ts"
import { ApiClient, errorMessage } from "./api-client.ts"
import type { ConnectionState, SocketFactory } from "./events-client.ts"
import { EventsClient } from "./events-client.ts"
import { BandplanStore } from "./bandplan-store.ts"
import { IdentifyStore } from "./identify-store.ts"
import { LiveAudioStore } from "./live-audio-store.ts"
import { SourcesStore } from "./sources-store.ts"
import { Store } from "./store.ts"
import { TunerStore } from "./tuner-store.ts"

export interface AccessStoreState {
	access: AccessState | null
	error: string | null
}

export interface DataLayer {
	api: ApiClient
	events: EventsClient
	/** Legacy or protected core (from the bootstrap), null before start(). */
	access: Store<AccessStoreState>
	connection: Store<ConnectionState>
	sources: SourcesStore
	tuner: TunerStore
	liveAudio: LiveAudioStore
	bandplan: BandplanStore
	identify: IdentifyStore
	/** Detects the access mode, opens /ws and loads every store. Never rejects. */
	start(): Promise<void>
	dispose(): void
}

export interface DataLayerOptions {
	baseUrl?: string
	wsUrl?: string
	fetch?: FetchLike
	createSocket?: SocketFactory
}

export function createDataLayer(options: DataLayerOptions = {}): DataLayer {
	const apiOptions: ApiClientOptions = {}
	if (options.baseUrl !== undefined) apiOptions.baseUrl = options.baseUrl
	if (options.fetch !== undefined) apiOptions.fetch = options.fetch
	const api = new ApiClient(apiOptions)
	const events = new EventsClient({
		...(options.wsUrl !== undefined ? { url: options.wsUrl } : {}),
		...(options.createSocket !== undefined
			? { createSocket: options.createSocket }
			: {}),
	})
	const access = new Store<AccessStoreState>({ access: null, error: null })
	const connection = new Store<ConnectionState>(events.state)
	const offState = events.onState(state => connection.set(state))
	const layer: DataLayer = {
		api,
		events,
		access,
		connection,
		sources: new SourcesStore(api, events),
		tuner: new TunerStore(api, events),
		liveAudio: new LiveAudioStore(api, events),
		bandplan: new BandplanStore(api, events),
		identify: new IdentifyStore(api, events),
		async start() {
			try {
				access.set({ access: await api.bootstrap(), error: null })
			} catch (error) {
				access.set({ access: null, error: errorMessage(error) })
			}
			events.connect()
			await Promise.all([
				layer.sources.load(),
				layer.tuner.load(),
				layer.liveAudio.load(),
				layer.bandplan.load(),
			])
		},
		dispose() {
			offState()
			layer.sources.dispose()
			layer.tuner.dispose()
			layer.liveAudio.dispose()
			layer.bandplan.dispose()
			layer.identify.dispose()
			events.disconnect()
		},
	}
	return layer
}

export {
	ApiClient,
	ApiError,
	CSRF_HEADER,
	errorMessage,
	isApiError,
} from "./api-client.ts"
export type {
	AccessState,
	ApiClientOptions,
	FetchLike,
	RequestOptions,
} from "./api-client.ts"
export { EventsClient, backoffDelay } from "./events-client.ts"
export type {
	ConnectionState,
	EventChannel,
	EventHandler,
	EventMap,
	EventType,
	ServerEnvelope,
	SocketFactory,
	SocketLike,
	SubscribeOptions,
} from "./events-client.ts"
export { Store, useStore } from "./store.ts"
export type { ReadableStore } from "./store.ts"
export { SourcesStore } from "./sources-store.ts"
export type { SourcesState } from "./sources-store.ts"
export { TunerStore } from "./tuner-store.ts"
export type { TunerStoreState } from "./tuner-store.ts"
export { LiveAudioStore, tunedHz } from "./live-audio-store.ts"
export type {
	LiveAudioConfigPatch,
	LiveAudioState,
} from "./live-audio-store.ts"
export { BandplanStore, bandAt, bandsAt, channelAt } from "./bandplan-store.ts"
export type { BandplanState } from "./bandplan-store.ts"
export { IdentifyStore, isIdentifyFinal } from "./identify-store.ts"
export type { IdentifyOptions, IdentifyState } from "./identify-store.ts"
