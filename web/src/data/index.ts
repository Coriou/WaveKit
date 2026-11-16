/**
 * The web app's data layer: one ApiClient, one EventsClient and the domain stores wired to
 * them. createDataLayer() is the only place that builds them; nothing here is global.
 */
import type { AccessDeviceKind, AccessSessionDto } from "@wavekit/api-types"

import type { AccessState, ApiClientOptions, FetchLike } from "./api-client.ts"
import { ApiClient, errorMessage, isApiError } from "./api-client.ts"
import type { ConnectionState, SocketFactory } from "./events-client.ts"
import { EventsClient, backoffDelay } from "./events-client.ts"
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
import { NearDiscoveryStore } from "./near-discovery-store.ts"
import { LiveAudioStore } from "./live-audio-store.ts"
import { DigitalVoiceStore } from "./digital-voice-store.ts"
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
	/**
	 * The core's own code when it answered the bootstrap with a refusal (HOST_FORBIDDEN: it does
	 * not accept the page's address); null or absent for anything else, a network error included.
	 */
	code?: string | null
	/** This browser's session on a protected core (null: not paired, or a legacy core). */
	session: AccessSessionDto | null
	/**
	 * This browser was paired and its session ended without a sign-out here: it expired, or was
	 * signed out from another device. The pairing prompt then says "Session expired, pair again".
	 */
	sessionExpired?: boolean
}

/** Half the time left, at least a minute, within what setTimeout can hold. */
export function refreshDelayMs(expiresAt: number, now: number): number {
	return Math.min(Math.max((expiresAt - now) / 2, 60_000), 2 ** 31 - 1)
}

/** A browser session's lifetime: the core's default and largest `ttlMs` (src/access/schema.ts, 30 days). */
export const SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000
/**
 * Launch and focus refresh the session once less than this is left: the lifetime less one day, so 29 days.
 * A refresh gives a full 30 days again, so a browser used daily refreshes at most once a day of use and its
 * session never runs out (the timer below only fires while the page stays open for half the time left).
 */
export const SESSION_REFRESH_BELOW_MS =
	SESSION_LIFETIME_MS - 24 * 60 * 60 * 1000
/**
 * At most one launch or focus refresh per hour: with a core configured for a shorter lifetime (every
 * session then has less than 29 days left) or a refresh that fails, focus would otherwise ask on every
 * window switch. 24 asks a day at worst, one a day in the usual case.
 */
export const SESSION_REFRESH_MIN_GAP_MS = 60 * 60 * 1000

/**
 * Whether launch or focus should refresh a session expiring at `expiresAt`: less than 29 days left, not yet
 * expired (the core refuses an expired one), and no such refresh asked in the last hour (`lastAt`).
 */
export function shouldRefreshSession(
	expiresAt: number,
	now: number,
	lastAt: number | null,
): boolean {
	const left = expiresAt - now
	if (left <= 0 || left >= SESSION_REFRESH_BELOW_MS) return false
	return lastAt === null || now - lastAt >= SESSION_REFRESH_MIN_GAP_MS
}

/** Where this browser remembers it was paired (the session's expiry only; never the CSRF token). */
export const PAIRED_KEY = "wavekit.access.paired"

/** The first wait before start() asks an unanswering core again (ms); it doubles up to START_RETRY_MAX_MS. */
export const START_RETRY_BASE_MS = 1000
/** The longest wait between two such asks (ms): the event socket's own reconnect cap. */
export const START_RETRY_MAX_MS = 10_000

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
	/** Decoded digital voice streams (dsd-fme) and their calls. */
	digitalVoice: DigitalVoiceStore
	bandplan: BandplanStore
	/** Settings › Band plans: the stack, packs and writes. */
	bandplanStack: BandplanStackStore
	scanPresets: ScanPresetsStore
	identify: IdentifyStore
	/** The nearest proven discovery at the tuned frequency (WG12 nearHz); follows what the tuned card shows. */
	nearDiscovery: NearDiscoveryStore
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
	/**
	 * Detects the access mode, reads this browser's session, opens /ws and loads every store. Never
	 * rejects. When the core does not answer the access question (down, restarting, or refusing the
	 * page's address) it asks again with a growing wait (up to START_RETRY_MAX_MS) and loads the
	 * stores once it answers, so a page opened during a core restart does not stay empty.
	 */
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
	/** The clock for session refresh decisions (tests); Date.now by default. */
	now?: () => number
	/** Where "this browser was paired" is remembered; localStorage by default, null for none. */
	storage?: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null
	/** Fires `focus` when the app comes back to the front; the window by default. */
	focusTarget?: Pick<
		EventTarget,
		"addEventListener" | "removeEventListener"
	> | null
}

/** The browser's localStorage, or null (no window, or storage blocked). */
function localStorageOrNull(): Storage | null {
	try {
		return typeof window === "undefined" ? null : window.localStorage
	} catch {
		return null
	}
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
	const now = options.now ?? Date.now
	const storage =
		options.storage === undefined ? localStorageOrNull() : options.storage
	const focusTarget =
		options.focusTarget === undefined
			? typeof window === "undefined"
				? null
				: window
			: options.focusTarget
	let refreshTimer: ReturnType<typeof setTimeout> | null = null
	let startTimer: ReturnType<typeof setTimeout> | null = null
	let lastRefreshAt: number | null = null
	let refreshing = false
	let disposed = false
	const remember = (session: AccessSessionDto | null) => {
		try {
			if (session) storage?.setItem(PAIRED_KEY, String(session.expiresAt))
			else storage?.removeItem(PAIRED_KEY)
		} catch {
			// blocked site data: an expired session then reads as not paired
		}
	}
	const wasPaired = (): boolean => {
		try {
			return (storage?.getItem(PAIRED_KEY) ?? null) !== null
		} catch {
			return false
		}
	}
	/** `ended`: the session ended by itself (expired, or signed out elsewhere), not by a sign-out here. */
	const setSession = (session: AccessSessionDto | null, ended = false) => {
		if (refreshTimer) clearTimeout(refreshTimer)
		refreshTimer = null
		// an answer that arrives after dispose() must not arm a refresh on a layer nobody holds
		if (disposed) return
		access.set({
			...access.get(),
			session,
			sessionExpired: session === null && ended,
		})
		if (session === null) {
			devices.clear()
			if (!ended) remember(null)
			return
		}
		remember(session)
		refreshTimer = setTimeout(
			() => {
				api.refreshSession().then(setSession, (error: unknown) => {
					// 401 already cleared the session (onSessionLost); a network error retries later
					if (isApiError(error) && error.status === 401) return
					setSession(access.get().session)
				})
			},
			refreshDelayMs(session.expiresAt, now()),
		)
	}
	/** Launch and focus: refresh a session with less than 29 days left, at most once an hour. */
	const refreshIfDue = () => {
		const session = access.get().session
		if (disposed || refreshing || session === null) return
		if (!shouldRefreshSession(session.expiresAt, now(), lastRefreshAt)) return
		lastRefreshAt = now()
		refreshing = true
		api.refreshSession().then(
			next => {
				refreshing = false
				setSession(next)
			},
			() => {
				// 401 already cleared the session (onSessionLost); otherwise the old one stands, asked again in an hour
				refreshing = false
			},
		)
	}
	const onFocus = () => refreshIfDue()
	focusTarget?.addEventListener("focus", onFocus)
	const offSessionLost = api.onSessionLost(() => setSession(null, true))
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
		digitalVoice: new DigitalVoiceStore(api, events),
		bandplan: new BandplanStore(api, events),
		bandplanStack: new BandplanStackStore(api, events, () => {
			void layer.bandplan.load()
			void layer.scanner.loadBandplans()
			void layer.scanPresets.load()
		}),
		scanPresets: new ScanPresetsStore(api, events, () => {
			if (layer.bandplanStack.get().loaded) void layer.bandplanStack.load()
		}),
		identify: new IdentifyStore(api, events, localStorageOrNull()),
		nearDiscovery: new NearDiscoveryStore(api, events),
		savedFrequencies,
		scanner: new ScannerStore(api, events),
		station: new StationStore(api),
		decoderSettings: new DecoderSettingsStore(api),
		system: new SystemStore(api),
		spectrumLimits: new SpectrumLimitsStore(api),
		recordings: new RecordingsStore(api, events),
		preferences: new PreferencesStore(api, savedFrequencies),
		fleets: createFleets(api, events),
		coverage: new CoverageStore(api),
		trailHistory: new TrailHistoryStore(api, events),
		async start() {
			const answered = await readAccess()
			events.connect()
			// before the stores load: against a core that is down their requests can take long to fail
			if (!answered) retryStart(0)
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
			disposed = true
			offState()
			offSessionLost()
			focusTarget?.removeEventListener("focus", onFocus)
			if (refreshTimer) clearTimeout(refreshTimer)
			if (startTimer) clearTimeout(startTimer)
			layer.sources.dispose()
			layer.tuner.dispose()
			layer.receiver.dispose()
			layer.liveAudio.dispose()
			layer.digitalVoice.dispose()
			layer.bandplan.dispose()
			layer.bandplanStack.dispose()
			layer.scanPresets.dispose()
			layer.identify.dispose()
			layer.nearDiscovery.dispose()
			layer.savedFrequencies.dispose()
			layer.scanner.dispose()
			layer.decoderSettings.dispose()
			layer.preferences.dispose()
			layer.recordings.dispose()
			events.disconnect()
		},
	}
	/** Reads the access mode and this browser's session; false when the core gave no usable answer. */
	async function readAccess(): Promise<boolean> {
		try {
			const state = await api.bootstrap()
			access.set({ access: state, error: null, code: null, session: null })
			if (
				state.mode === "protected" &&
				state.bootstrap.access.sessionAvailable
			) {
				const session = await api.getSession()
				// no session, yet this browser was paired: it expired (or was signed out from another device)
				setSession(session, session === null && wasPaired())
				refreshIfDue()
			}
			return true
		} catch (error) {
			access.set({
				access: null,
				error: errorMessage(error),
				code: isApiError(error) && error.status !== 0 ? error.code : null,
				session: null,
			})
			return false
		}
	}
	/** Asks again after the backoff; once the core answers, the stores load as at a first start. */
	function retryStart(attempt: number): void {
		if (disposed) return
		startTimer = setTimeout(
			() => {
				startTimer = null
				void readAccess().then(answered => {
					if (disposed) return
					if (!answered) {
						retryStart(attempt + 1)
						return
					}
					// the event socket has been retrying by itself all along: only the stores are due
					void loadAll()
				})
			},
			backoffDelay(
				attempt,
				START_RETRY_BASE_MS,
				START_RETRY_MAX_MS,
				Math.random,
			),
		)
	}
	async function loadAll(): Promise<void> {
		await Promise.all([
			layer.sources.load(),
			layer.tuner.load(),
			layer.liveAudio.load(),
			layer.digitalVoice.load(),
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
export {
	endedWithNothingHeard,
	IdentifyStore,
	isIdentifyFinal,
	knownAt,
} from "./identify-store.ts"
export {
	isProven,
	NearDiscoveryStore,
	proofKind,
} from "./near-discovery-store.ts"
export type { NearDiscoveryState } from "./near-discovery-store.ts"
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
export type {
	IdentifyOptions,
	IdentifyState,
	KnownSignal,
} from "./identify-store.ts"
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
	RECORDINGS_WINDOW_MAX,
	RecordingsStore,
	recordingsUnavailable,
} from "./recordings-store.ts"
export type {
	RecordingMarks,
	RecordingsMeta,
	RecordingsQuery,
	RecordingsState,
} from "./recordings-store.ts"
export {
	FEED_BUSY_MS,
	FEED_RETRY_MS,
	FEED_STALL_MS,
	PagedFeed,
} from "./paged-feed.ts"
export type { FeedPage, FeedStatus, PagedFeedState } from "./paged-feed.ts"
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
	CLASS_WORDS,
	confidenceCapText,
	confidenceRank,
	confidenceText,
	discoveryTitle,
	formatWait,
	heldFrequencyHz,
	hintText,
	identityQuery,
	identityText,
	isJobActive,
	isVerified,
	jobStateLine,
	jobTone,
	likelyText,
	nextStepText,
	protocolName,
	protocolSlotText,
	sweepProgress,
	trialOutcomeText,
	undecodedReasonText,
	whatIsThis,
} from "./scanner-format.ts"
export type {
	JobStateLineOptions,
	WhatIsThis,
	JobTone,
	SweepProgress,
} from "./scanner-format.ts"
