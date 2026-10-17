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
import { ReceiverStore } from "./receiver-store.ts"
import { SavedFrequenciesStore } from "./saved-frequencies-store.ts"
import { ScannerStore } from "./scanner-store.ts"
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
	/** Receiver settings: capabilities, relay status and per-control writes. */
	receiver: ReceiverStore
	liveAudio: LiveAudioStore
	bandplan: BandplanStore
	identify: IdentifyStore
	/** Saved frequencies (core operator data; protected mode only). */
	savedFrequencies: SavedFrequenciesStore
	/** Scanner status, jobs (sweep, passive, progress) and band plans; discoveries load on first refreshDiscoveries(). */
	scanner: ScannerStore
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
	const tuner = new TunerStore(api, events)
	const receiver = new ReceiverStore(api, events, {
		tunerState: id => tuner.get().bySource[id],
		onState: state => tuner.receive(state),
	})
	const layer: DataLayer = {
		api,
		events,
		access,
		connection,
		sources: new SourcesStore(api, events),
		tuner,
		receiver,
		liveAudio: new LiveAudioStore(api, events),
		bandplan: new BandplanStore(api, events),
		identify: new IdentifyStore(api, events),
		savedFrequencies: new SavedFrequenciesStore(api, events),
		scanner: new ScannerStore(api, events),
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
				layer.receiver.loadRelay(),
				layer.savedFrequencies.load(),
				layer.scanner.load(),
			])
		},
		dispose() {
			offState()
			layer.sources.dispose()
			layer.tuner.dispose()
			layer.receiver.dispose()
			layer.liveAudio.dispose()
			layer.bandplan.dispose()
			layer.identify.dispose()
			layer.savedFrequencies.dispose()
			layer.scanner.dispose()
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
	validated,
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
export { ReceiverStore, toControlError } from "./receiver-store.ts"
export type {
	CapsEntry,
	ControlError,
	ControlStatus,
	ReceiverStoreState,
} from "./receiver-store.ts"
export { createReceiverApi, settingRequest } from "./receiver-api.ts"
export type {
	ReceiverApi,
	ReceiverCaps,
	ReceiverControlCaps,
	ReceiverGainTableCaps,
	ReceiverSetting,
	ReceiverSettingKey,
	TunerRelayView,
} from "./receiver-api.ts"
export type { TunerStoreState } from "./tuner-store.ts"
export { LiveAudioStore, tunedHz } from "./live-audio-store.ts"
export type {
	LiveAudioConfigPatch,
	LiveAudioState,
} from "./live-audio-store.ts"
export { BandplanStore, bandAt, bandsAt, channelAt } from "./bandplan-store.ts"
export type { BandplanState } from "./bandplan-store.ts"
export { IdentifyStore, isIdentifyFinal } from "./identify-store.ts"
export {
	SavedFrequenciesStore,
	applyOps,
	checkInput,
	compareSaved,
	inputOf,
	isPendingId,
} from "./saved-frequencies-store.ts"
export type {
	SavedFrequenciesState,
	SavedFrequenciesStatus,
	SavedFrequencyRow,
} from "./saved-frequencies-store.ts"
export type { IdentifyOptions, IdentifyState } from "./identify-store.ts"
export {
	ScannerStore,
	absorbedBy,
	deriveJobs,
	discoveryComparator,
	matchesDiscoveryQuery,
	planIssues,
	progressOfJob,
	takeoverImpact,
} from "./scanner-store.ts"
export type {
	DiscoveryOperatorPatch,
	DiscoveryPage,
	DiscoveryQuery,
	DiscoverySort,
	PatchJobResult,
	ScannerDiscoveriesState,
	ScannerListenResult,
	ScannerState,
	ScannerStoreOptions,
} from "./scanner-store.ts"
export {
	confidenceCapText,
	confidenceRank,
	confidenceText,
	discoveryTitle,
	formatWait,
	heldFrequencyHz,
	identityQuery,
	identityText,
	isJobActive,
	jobStateLine,
	jobTone,
	protocolName,
	sweepProgress,
	trialOutcomeText,
	undecodedReasonText,
} from "./scanner-format.ts"
export type {
	JobStateLineOptions,
	JobTone,
	SweepProgress,
} from "./scanner-format.ts"
