/**
 * The web app's data layer: one ApiClient, one EventsClient and the domain stores wired to
 * them. createDataLayer() is the only place that builds them; nothing here is global.
 */
import type { AccessDeviceKind, AccessSessionDto } from "@wavekit/api-types"

import type { AccessState, ApiClientOptions, FetchLike } from "./api-client.ts"
import { ApiClient, errorMessage, isApiError } from "./api-client.ts"
import type { ConnectionState, SocketFactory } from "./events-client.ts"
import { EventsClient } from "./events-client.ts"
import type { WorkerLike } from "./events-relay.ts"
import { workerSocketFactory } from "./events-relay.ts"
import type { Fleets } from "./fleets.ts"
import { createFleets } from "./fleets.ts"
import { BandplanStore } from "./bandplan-store.ts"
import { BandplanStackStore } from "./bandplan-stack-store.ts"
import { CoverageStore } from "./coverage-store.ts"
import { TrailHistoryStore } from "./trail-history-store.ts"
import { DecoderSettingsStore } from "./decoder-settings-store.ts"
import { AccessDevicesStore } from "./access-devices-store.ts"
import { IdentifyStore } from "./identify-store.ts"
import { LiveAudioStore } from "./live-audio-store.ts"
import { PreferencesStore } from "./preferences-store.ts"
import { ReceiverStore } from "./receiver-store.ts"
import { RecordingsStore } from "./recordings-store.ts"
import { SavedFrequenciesStore } from "./saved-frequencies-store.ts"
import { ScanPresetsStore } from "./scan-presets-store.ts"
import { ScannerStore } from "./scanner-store.ts"
import { SourcesStore } from "./sources-store.ts"
import { StationStore } from "./station-store.ts"
import { Store } from "./store.ts"
import { SpectrumLimitsStore } from "./spectrum-limits-store.ts"
import { SystemStore } from "./system-store.ts"
import { TunerStore } from "./tuner-store.ts"

export interface AccessStoreState {
	access: AccessState | null
	error: string | null
	/** This browser's session on a protected core (null: not paired, or a legacy core). */
	session: AccessSessionDto | null
}

/** Half the time left, at least a minute, within what setTimeout can hold. */
export function refreshDelayMs(expiresAt: number, now: number): number {
	return Math.min(Math.max((expiresAt - now) / 2, 60_000), 2 ** 31 - 1)
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
	/** Settings › Band plans: the stack, packs and writes. */
	bandplanStack: BandplanStackStore
	scanPresets: ScanPresetsStore
	identify: IdentifyStore
	/** Saved frequencies (core operator data; protected mode only). */
	savedFrequencies: SavedFrequenciesStore
	/** Scanner status, jobs (sweep, passive, progress) and band plans; discoveries load on first refreshDiscoveries(). */
	scanner: ScannerStore
	/** Station identity with provenance; writes when `writable` (protected core). */
	station: StationStore
	/** Decoder types and option descriptors (loaded at start); settings views load per decoder. */
	decoderSettings: DecoderSettingsStore
	/** Version, uptime and storage report; loads on first load() (the Settings drawer). */
	system: SystemStore
	/** The core's spectrum limits (most bins a client may ask for); loaded at start. */
	spectrumLimits: SpectrumLimitsStore
	/** Recording inventory, Keep and delete (protected core); loads on first refresh() (the Recordings drawer). */
	recordings: RecordingsStore
	/** Operator preferences, derived from the saved-frequencies operator-data read. */
	preferences: PreferencesStore
	/** Aircraft, vessels, APRS and mesh current state; each attaches on demand (the Map view). */
	fleets: Fleets
	/** ADS-B and AIS coverage per bearing; attaches on demand. */
	coverage: CoverageStore
	/** Stored position history for the Map's trails; attaches on demand. */
	trailHistory: TrailHistoryStore
	/** Detects the access mode, reads this browser's session, opens /ws and loads every store. Never rejects. */
	start(): Promise<void>
	/** Pairs this browser with a one-time code, then reconnects and reloads. Rejects with an ApiError. */
	pair(input: {
		code: string
		name?: string
		kind?: AccessDeviceKind
	}): Promise<void>
	/** Ends this browser's session (read-only until paired again). */
	logout(): Promise<void>
	/** Settings › Devices: the remembered devices (a browser session only); loads on first load(). */
	devices: AccessDevicesStore
	/** Signs out every remembered device, this browser too (read-only until paired again). */
	revokeAllDevices(): Promise<void>
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
	// the /ws socket lives in a worker that coalesces fleet updates (events-relay.ts)
	const createSocket =
		options.createSocket ??
		workerSocketFactory(
			() =>
				new Worker(new URL("./events.worker.ts", import.meta.url), {
					type: "module",
					name: "wavekit-events",
				}) as unknown as WorkerLike,
		)
	const events = new EventsClient({
		...(options.wsUrl !== undefined ? { url: options.wsUrl } : {}),
		...(createSocket !== null ? { createSocket } : {}),
	})
	const access = new Store<AccessStoreState>({
		access: null,
		error: null,
		session: null,
	})
	const devices = new AccessDevicesStore(api)
	let refreshTimer: ReturnType<typeof setTimeout> | null = null
	const setSession = (session: AccessSessionDto | null) => {
		if (refreshTimer) clearTimeout(refreshTimer)
		refreshTimer = null
		access.set({ ...access.get(), session })
		if (session === null) {
			devices.clear()
			return
		}
		refreshTimer = setTimeout(
			() => {
				api.refreshSession().then(setSession, (error: unknown) => {
					// 401 already cleared the session (onSessionLost); a network error retries later
					if (isApiError(error) && error.status === 401) return
					setSession(access.get().session)
				})
			},
			refreshDelayMs(session.expiresAt, Date.now()),
		)
	}
	const offSessionLost = api.onSessionLost(() => setSession(null))
	const connection = new Store<ConnectionState>(events.state)
	const offState = events.onState(state => connection.set(state))
	const tuner = new TunerStore(api, events)
	const receiver = new ReceiverStore(api, events, {
		tunerState: id => tuner.get().bySource[id],
		onState: state => tuner.receive(state),
	})
	const savedFrequencies = new SavedFrequenciesStore(api, events)
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
		bandplanStack: new BandplanStackStore(api, events, () => {
			void layer.bandplan.load()
			void layer.scanner.loadBandplans()
			void layer.scanPresets.load()
		}),
		scanPresets: new ScanPresetsStore(api, events, () => {
			if (layer.bandplanStack.get().loaded) void layer.bandplanStack.load()
		}),
		identify: new IdentifyStore(api, events),
		savedFrequencies,
		scanner: new ScannerStore(api, events),
		station: new StationStore(api),
		decoderSettings: new DecoderSettingsStore(api),
		system: new SystemStore(api),
		spectrumLimits: new SpectrumLimitsStore(api),
		recordings: new RecordingsStore(api),
		preferences: new PreferencesStore(api, savedFrequencies),
		fleets: createFleets(api, events),
		coverage: new CoverageStore(api),
		trailHistory: new TrailHistoryStore(api, events),
		async start() {
			try {
				const state = await api.bootstrap()
				access.set({ access: state, error: null, session: null })
				if (
					state.mode === "protected" &&
					state.bootstrap.access.sessionAvailable
				)
					setSession(await api.getSession())
			} catch (error) {
				access.set({ access: null, error: errorMessage(error), session: null })
			}
			events.connect()
			await loadAll()
		},
		async pair(input) {
			setSession(await api.pair(input))
			// the socket opened before pairing had no cookie: reopen it, then reload with the session
			events.disconnect()
			events.connect()
			await loadAll()
		},
		async logout() {
			try {
				await api.logout()
			} finally {
				setSession(null)
			}
		},
		devices,
		async revokeAllDevices() {
			try {
				await api.revokeAllDevices()
			} finally {
				setSession(null)
			}
		},
		dispose() {
			offState()
			offSessionLost()
			if (refreshTimer) clearTimeout(refreshTimer)
			layer.sources.dispose()
			layer.tuner.dispose()
			layer.receiver.dispose()
			layer.liveAudio.dispose()
			layer.bandplan.dispose()
			layer.bandplanStack.dispose()
			layer.scanPresets.dispose()
			layer.identify.dispose()
			layer.savedFrequencies.dispose()
			layer.scanner.dispose()
			layer.decoderSettings.dispose()
			layer.preferences.dispose()
			layer.recordings.dispose()
			events.disconnect()
		},
	}
	async function loadAll(): Promise<void> {
		await Promise.all([
			layer.sources.load(),
			layer.tuner.load(),
			layer.liveAudio.load(),
			layer.bandplan.load(),
			layer.receiver.loadRelay(),
			layer.savedFrequencies.load(),
			layer.scanner.load(),
			layer.station.load(),
			layer.decoderSettings.loadTypes(),
			layer.spectrumLimits.load(),
		])
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
export { FleetStore } from "./fleet-store.ts"
export type {
	FleetEntry,
	FleetSpec,
	FleetState,
	FleetStatus,
	FleetStoreOptions,
	TrailPoint,
} from "./fleet-store.ts"
export {
	AIRCRAFT_SPEC,
	APRS_SPEC,
	MESH_SPEC,
	VESSEL_SPEC,
	createFleets,
} from "./fleets.ts"
export type { Aircraft, Aprs, Fleets, Mesh, Vessel } from "./fleets.ts"
export { CoverageStore } from "./coverage-store.ts"
export { TrailHistoryStore, withHistory } from "./trail-history-store.ts"
export type { TrailHistoryState } from "./trail-history-store.ts"
export type { Coverage, CoverageState } from "./coverage-store.ts"
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
export {
	BandplanStackStore,
	bandplanWriteError,
} from "./bandplan-stack-store.ts"
export type {
	BandplanStackState,
	ImportCommit,
	ImportFile,
} from "./bandplan-stack-store.ts"
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
	OperatorDataDto,
	SavedFrequenciesState,
	SavedFrequenciesStatus,
	SavedFrequencyRow,
} from "./saved-frequencies-store.ts"
export type { IdentifyOptions, IdentifyState } from "./identify-store.ts"
export type {
	SettingWriteError,
	SettingWriteOk,
	SettingWriteResult,
} from "./setting-write.ts"
export { STATION_FIELD_RULES, StationStore } from "./station-store.ts"
export type { StationState } from "./station-store.ts"
export {
	DECODER_LOG_LINES,
	DecoderSettingsStore,
	decoderFieldErrors,
} from "./decoder-settings-store.ts"
export type {
	DecoderAction,
	DecoderSettingsState,
} from "./decoder-settings-store.ts"
export { SpectrumLimitsStore } from "./spectrum-limits-store.ts"
export { SystemStore } from "./system-store.ts"
export {
	RECORDING_DELETE_GRACE_MS,
	RecordingsStore,
} from "./recordings-store.ts"
export type { RecordingsState } from "./recordings-store.ts"
export type { SpectrumLimitsState } from "./spectrum-limits-store.ts"
export type { SystemState } from "./system-store.ts"
export {
	PREFERENCE_DEFAULTS,
	PREFERENCE_KEYS,
	PreferencesStore,
} from "./preferences-store.ts"
export type { PreferenceSource, PreferencesState } from "./preferences-store.ts"
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
