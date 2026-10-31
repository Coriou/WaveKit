/**
 * WaveKit mock core: the routes and `/ws` messages the web app's slice uses, answered with the
 * canvas data (./data.ts). Legacy mode (no access bootstrap route). Run:
 *   pnpm --filter @wavekit/web mock   (node --experimental-strip-types ./mock/server.ts)
 * Listens on 127.0.0.1:3101 (WAVEKIT_MOCK_PORT) and serves synthetic audio on 3102
 * (WAVEKIT_MOCK_AUDIO_PORT). Type stripping only: no enums, parameter properties or namespaces.
 */
import { randomUUID } from "node:crypto"
import type { Server } from "node:http"
import type { AddressInfo } from "node:net"
import { pathToFileURL } from "node:url"
import fastifyWebsocket from "@fastify/websocket"
import Fastify from "fastify"
import type { FastifyError, FastifyInstance, FastifyReply } from "fastify"
import type { WebSocket } from "ws"
import {
	LIVE_AUDIO_NOISE_QUIETING_DB,
	LIVE_AUDIO_NOISE_SQUELCH_MODULATIONS,
} from "@wavekit/api-types"
import type {
	ActivityLifecycleStatus,
	ActivityQuery,
	ActivityRecord,
	ActivitySearchPage,
	ActivitySummary,
	DecoderInfo,
	DigitalVoiceStatus,
	DiscoveryMetadata,
	ExtendedSourceStatus,
	JsonValue,
	LiveAudioConfig,
	LiveAudioLevel,
	LiveAudioStatus,
	ScanJob,
	ScannerIdentifyEventData,
	ScannerIdentifyResult,
	ScannerIdentifyTrial,
	ScannerProtocol,
	SpectrumProfileEventData,
	TunerState,
} from "@wavekit/api-types"
import type { FloodEvent } from "./activity-floods.ts"
import { floodEvents } from "./activity-floods.ts"
import { createAudioServer } from "./audio.ts"
import { buildDecoderSummaries, withAdsbBudget } from "./decoder-summary.ts"
import { registerReceiverMock } from "./receiver.ts"
import { registerSourceFeedMock, withSourcePaused } from "./source-feed.ts"
import type { SourceFeedMock } from "./source-feed.ts"
import type { ReceiverMockControls } from "./receiver.ts"
import { registerScannerMock } from "./scanner.ts"
import {
	type Activity429Mode,
	activity429RetryAfter,
	BAND_FIXTURE_BOOKMARK,
	isActivity429Mode,
} from "./band-fixtures.ts"
import type { ScannerMock } from "./scanner.ts"
import {
	RETUNE_SWEEP_BOOKMARK,
	RETUNE_SWEEP_SIGNALS,
	RETUNE_SWEEP_STEP_MS,
	RETUNE_SWEEP_STEPS,
} from "./retune-sweep.ts"
import {
	MOCK_VERSION,
	createDecoderLifecycle,
	registerSettingsMock,
} from "./settings.ts"
import type { SettingsMock } from "./settings.ts"
import {
	DECODER_SEEDS,
	DEFAULT_CENTER_HZ,
	MOCK_MESSAGES,
	MOCK_SAVED_FREQUENCIES,
	MOCK_SECOND_SOURCE_ID,
	MOCK_SOURCE_ID,
	MOCK_TRANSMISSIONS,
	NOISE_FLOOR_DBFS,
	SAMPLE_RATE_HZ,
	USABLE_FRACTION,
	buildDecoders,
	decoderInBand,
	identifyPlanFor,
	onlyProtocols,
	signalActive,
	signalAt,
} from "./data.ts"
import type { MockMessage, MockSignal } from "./data.ts"
import { registerMapMock } from "./map.ts"
import type { MapMock } from "./map.ts"
import { registerRecordingsMock } from "./recordings.ts"
import { registerOperatorData } from "./operator-data.ts"
import { registerBandPlansMock } from "./bandplans.ts"
import {
	normaliseSpectrumOptions,
	SPECTRUM_BACKFILL_MAX_FRAMES,
	SPECTRUM_BACKFILL_MAX_MS,
	SPECTRUM_SUMMARY_BINS,
	synthFrame,
} from "./spectrum.ts"

export interface MockServerOptions {
	host?: string
	/** API port; 0 picks a free one. Default 3101. */
	port?: number
	/** Audio port; 0 picks a free one. Default port + 1 (3102). */
	audioPort?: number
	/** Origin advertised in live-audio URLs; default http://localhost:<audio port>. */
	audioOrigin?: string
	/** Interval between mock decoder messages, ms. Default 3000. */
	messageIntervalMs?: number
	/** Load multiplier for performance work: fleets × load, decoder messages × load. Default 1. */
	load?: number
	/** Aircraft updates per aircraft per second (WAVEKIT_MOCK_ADSB_RATE). Default 1. */
	adsbRate?: number
	/**
	 * The engine's summary budget, scanner.ws.spectrumSummaryBins (WAVEKIT_MOCK_SPECTRUM_BINS, 512–8192):
	 * the most bins a client gets, served as `limits.bins.max`. Default 2048, like the shipped config.
	 */
	spectrumBins?: number
	/**
	 * Delay before a REST retune takes effect and answers, ms (WAVEKIT_MOCK_RETUNE_MS). Default 0; about
	 * 300 is what the core measured from a retune to the first frame at the new centre (ROADMAP §8).
	 */
	retuneMs?: number
	/** Seeds the band inspection UX discoveries (./band-fixtures.ts; WAVEKIT_MOCK_BAND_FIXTURES=1). */
	bandFixtures?: boolean
	/**
	 * Retunes through the multi-band sequence of ./retune-sweep.ts, then parks at 431.0125 MHz at
	 * 1.024 MS/s; frames follow the tuner's sample rate (WAVEKIT_MOCK_RETUNE_SWEEP=1).
	 */
	retuneSweep?: boolean
	/**
	 * Every other Activity read (GET /api/activity…, POST /api/activity/facets) answers 429 with this
	 * Retry-After: "1", "30", an HTTP date 2 s ahead ("date") or a malformed value (WAVEKIT_MOCK_ACTIVITY_429).
	 */
	activity429?: Activity429Mode
	/**
	 * Activity floods (./activity-floods.ts): an aircraft at 2.5 decodes/s, a pager tone-only beacon every
	 * ~45 s and a 24-row DMR call (12 call_start / call_end overs) every 3 min, in the seeded history and
	 * live. On for `pnpm mock` (WAVEKIT_MOCK_ACTIVITY_FLOODS=0 turns them off), off by default in
	 * buildMockServer().
	 */
	activityFloods?: boolean
	/** The scanner engine starts with its front-end overload hint (WAVEKIT_MOCK_OVERLOAD_HINT=1). */
	overloadHint?: boolean
	/** How long a receiver resume dials before it answers, ms (./source-feed.ts). Default 400. */
	resumeMs?: number
	/** The next this many receiver resumes fail with 503 (WAVEKIT_MOCK_RESUME_FAILURES). Default 0. */
	resumeFailures?: number
	/**
	 * After a plain resume the core measures this sample rate from the stream and adopts it
	 * (WAVEKIT_MOCK_MEASURED_RATE=<hz>): the tuner state shows it with `measuredFields: ["sampleRate"]`.
	 * Without it the rate stays at its last known value, unverified.
	 */
	measuredRateHz?: number
	/** The next this many receiver pauses / resumes answer `persisted: false` (WAVEKIT_MOCK_PERSIST_FAILURES). */
	persistFailures?: number
	/**
	 * `source:status` on the socket leaves `feed` out, as a core older than the pause feature's socket
	 * field (WAVEKIT_MOCK_SOCKET_OMITS_FEED=1); `GET /api/sources` still carries it.
	 */
	socketOmitsFeed?: boolean
	/**
	 * A second receiver, `rtl-1`, after `rtl-0` (WAVEKIT_MOCK_SECOND_SOURCE=1): its source row, tuner state and
	 * pause / resume only (no decoders, spectrum or tuner writes), to try which receiver the UI acts on.
	 */
	secondSource?: boolean
	/**
	 * The Activity store is not open yet: Activity reads answer the core's 503 and
	 * `GET /api/activity/status` reports `opening` (WAVEKIT_MOCK_ACTIVITY_STORE=opening) or
	 * `retrying` with a next attempt every 5 s (=retrying). It opens `openAfterMs` after start
	 * (WAVEKIT_MOCK_ACTIVITY_OPEN_MS); without it, never.
	 */
	activityStore?: { state: "opening" | "retrying"; openAfterMs?: number }
}

export interface MockServer {
	app: FastifyInstance
	audio: Server
	listen(): Promise<{
		apiUrl: string
		audioUrl: string
		port: number
		audioPort: number
	}>
	close(): Promise<void>
	/** Receiver controls (./receiver.ts): simulate a relay client taking the tuner. */
	receiver: ReceiverMockControls
	/** Scanner mock (./scanner.ts). */
	scanner: ScannerMock
	/** Settings routes (./settings.ts): station, decoder settings, storage, export. */
	settings: SettingsMock
	/** Map fleets and coverage (./map.ts). */
	map: MapMock
	/** Receiver feed pause / resume (./source-feed.ts). */
	feed: SourceFeedMock
}

/**
 * Seeded flood history: 30 min of beacons and calls (30 min / 45 s = 40 beacons, 30 min / 3 min = 10 calls of
 * 24 rows), 3 min of aircraft (180 s × 2.5/s, about 450 rows): enough for every kind of stack on the first page.
 */
const FLOOD_HISTORY_MS = 30 * 60_000
const FLOOD_AIRCRAFT_HISTORY_MS = 3 * 60_000

/** What a plain resume of the feed leaves unverified (the core's PLAIN_RESUME_UNVERIFIED). */
const PLAIN_RESUME_UNVERIFIED: NonNullable<TunerState["unknownFields"]> = [
	"frequency",
	"sampleRate",
	"gainMode",
	"gain",
]

/** The core's rtl_tcp frequency range (TunerValidationError beyond it). */
const TUNER_MIN_HZ = 24_000_000
const TUNER_MAX_HZ = 1_900_000_000

const CHANNELS = new Set([
	"decoders",
	"metrics",
	"sources",
	"health",
	"fanout",
	"live-audio",
	"digital-voice",
	"resources",
	"tuner",
	"aircraft",
	"scanner",
	"spectrum",
	"operator-data",
	"bandplans",
	"vessels",
	"aprs",
	"mesh",
])

const MODULATIONS = new Set([
	"nfm",
	"wfm",
	"am",
	"usb",
	"lsb",
	"dsb",
	"cw",
	"raw",
])
const ACTIVITY_PARAMS = new Set([
	"kinds",
	"sourceIds",
	"decoderIds",
	"protocols",
	"categories",
	"frequencyMin",
	"frequencyMax",
	"producedFrom",
	"producedTo",
	"entityKey",
	"text",
	"order",
	"limit",
	"pageToken",
])
const ACTIVITY_ID = /^[A-Za-z0-9_-]{1,64}$/
const WORD = /[\p{L}\p{N}]+/gu

interface SpectrumSub {
	sourceId: string
	hz: number
	bins: number
	explicit: boolean
	timer: ReturnType<typeof setInterval>
}

interface Client {
	socket: WebSocket
	channels: Set<string>
	spectrum: SpectrumSub | null
	activity: Map<string, ActivityQuery>
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

function asStrings(value: unknown): string[] {
	const list = Array.isArray(value) ? value : [value]
	return list
		.flatMap(v => (typeof v === "string" ? v.split(",") : []))
		.map(v => v.trim())
		.filter(v => v.length > 0)
}

function matchesQuery(item: ActivitySummary, q: ActivityQuery): boolean {
	if (q.kinds && !q.kinds.includes(item.kind)) return false
	if (
		q.sourceIds &&
		(item.sourceId === null || !q.sourceIds.includes(item.sourceId))
	)
		return false
	if (
		q.decoderIds &&
		(item.decoderId === null || !q.decoderIds.includes(item.decoderId))
	)
		return false
	if (
		q.protocols &&
		(item.protocol === null || !q.protocols.includes(item.protocol))
	)
		return false
	if (q.categories && !q.categories.includes(item.category)) return false
	if (q.entityKey !== undefined && item.entityKey !== q.entityKey) return false
	if (q.frequencyHz) {
		if (item.frequencyHz === null) return false
		if (q.frequencyHz.min !== undefined && item.frequencyHz < q.frequencyHz.min)
			return false
		if (q.frequencyHz.max !== undefined && item.frequencyHz > q.frequencyHz.max)
			return false
	}
	if (q.producedAt?.from !== undefined && item.producedAt < q.producedAt.from)
		return false
	if (q.producedAt?.to !== undefined && item.producedAt > q.producedAt.to)
		return false
	if (q.text !== undefined) {
		// The core's FTS: every word of the text must be a whole word of the event (AND).
		const words = q.text.toLowerCase().match(WORD) ?? []
		if (words.length > 0) {
			const hay = new Set(
				[
					item.title ?? "",
					item.protocol ?? "",
					item.entityKey ?? "",
					...item.fields.map(f => String(f.value)),
				]
					.join(" ")
					.toLowerCase()
					.match(WORD) ?? [],
			)
			if (!words.every(w => hay.has(w))) return false
		}
	}
	return true
}

class QueryError extends Error {
	readonly code = "ACTIVITY_QUERY_INVALID"
}

function queryFromParams(params: Record<string, unknown>): ActivityQuery {
	for (const key of Object.keys(params))
		if (!ACTIVITY_PARAMS.has(key))
			throw new QueryError(`Unknown activity query parameter ${key}`)
	const q: ActivityQuery = {}
	const list = (name: string) => {
		const v = params[name]
		if (v === undefined) return undefined
		const s = asStrings(v)
		return s.length > 0 ? s : undefined
	}
	const kinds = list("kinds")
	const sourceIds = list("sourceIds")
	const decoderIds = list("decoderIds")
	const protocols = list("protocols")
	const categories = list("categories")
	if (kinds) q.kinds = kinds as ActivitySummary["kind"][]
	if (sourceIds) q.sourceIds = sourceIds
	if (decoderIds) q.decoderIds = decoderIds
	if (protocols) q.protocols = protocols
	if (categories) q.categories = categories as ActivitySummary["category"][]
	const num = (name: string) => {
		const v = params[name]
		if (v === undefined) return undefined
		const n = Number(v)
		if (!Number.isFinite(n)) throw new QueryError(`${name} must be a number`)
		return n
	}
	const min = num("frequencyMin")
	const max = num("frequencyMax")
	if (min !== undefined || max !== undefined) {
		const f: { min?: number; max?: number } = {}
		if (min !== undefined) f.min = min
		if (max !== undefined) f.max = max
		q.frequencyHz = f
	}
	const from = params["producedFrom"]
	const to = params["producedTo"]
	if (typeof from === "string" || typeof to === "string") {
		const p: { from?: string; to?: string } = {}
		if (typeof from === "string") p.from = from
		if (typeof to === "string") p.to = to
		q.producedAt = p
	}
	if (typeof params["entityKey"] === "string") q.entityKey = params["entityKey"]
	if (typeof params["text"] === "string") q.text = params["text"]
	return q
}

function queryFromWire(raw: unknown): ActivityQuery {
	if (raw === undefined) return {}
	if (!isRecord(raw)) throw new QueryError("query must be an object")
	return raw as ActivityQuery
}

/** The stored record behind a mock summary (GET /api/activity/:eventId). */
function recordOf(item: ActivitySummary, decoded?: JsonValue): ActivityRecord {
	const base = {
		version: 1 as const,
		eventId: item.eventId,
		commitSeq: item.commitSeq,
		producedAt: item.producedAt,
		receivedAt: item.receivedAt,
	}
	const field = (key: string) => item.fields.find(f => f.key === key)?.value
	if (item.kind === "ingestion-gap") {
		const dropped = field("dropped")
		return {
			...base,
			kind: "ingestion-gap",
			payload: {
				reason: "rate-limited",
				dropped: typeof dropped === "number" ? dropped : 0,
				decoderIds: item.decoderId ? [item.decoderId] : [],
				fromReceivedAt: item.receivedAt,
				toReceivedAt: item.receivedAt,
			},
		}
	}
	if (item.kind === "analog-transmission") {
		const ms = field("durationMs")
		const durationMs = typeof ms === "number" ? ms : 0
		const ctcss = field("ctcssHz")
		const mod = field("modulation")
		const dtmf = field("dtmf")
		return {
			...base,
			kind: "analog-transmission",
			payload: {
				transmissionId: item.eventId,
				sourceId: item.sourceId ?? MOCK_SOURCE_ID,
				startedAt: new Date(
					Date.parse(item.producedAt) - durationMs,
				).toISOString(),
				endedAt: item.producedAt,
				durationMs,
				frequency:
					item.frequencyHz === null
						? null
						: { hz: item.frequencyHz, tuningTrust: "commanded" },
				modulation: mod === "am" ? "am" : "nfm",
				bandwidthHz: 12_500,
				squelchMode: "auto",
				thresholdDbfs: -62,
				peakChannelPowerDbfs: -38.5,
				meanChannelPowerDbfs: -44.2,
				closeReason: "squelch",
				tone: {
					ctcssHz: typeof ctcss === "number" ? ctcss : null,
					dtmf: typeof dtmf === "string" ? dtmf : null,
					dcs: null,
				},
			},
		}
	}
	const fromFields: Record<string, string | number | boolean | null> = {}
	for (const f of item.fields) fromFields[f.key] = f.value
	const decodedData: JsonValue = decoded ?? fromFields
	const payload = {
		version: 1 as const,
		eventId: item.eventId,
		producedAt: item.producedAt,
		receivedAt: item.receivedAt,
		decoderId: item.decoderId ?? "unknown",
		outputType: "message",
		protocol: item.protocol,
		category: item.category,
		entityKey: item.entityKey,
		title: item.title,
		fields: item.fields,
		provenance: {
			sourceId: item.sourceId,
			frequency:
				item.frequencyHz === null
					? null
					: {
							hz: item.frequencyHz,
							basis: "channel" as const,
							tuningTrust: "commanded" as const,
						},
		},
		decodedData,
		...(item.position ? { position: item.position } : {}),
	}
	return { ...base, kind: "decoder-reception", payload }
}

const emptyMetadata = (): DiscoveryMetadata => ({
	talkgroups: [],
	sources: [],
	slots: [],
	callsigns: [],
	capcodes: [],
	ismModels: [],
})

export async function buildMockServer(
	options: MockServerOptions = {},
): Promise<MockServer> {
	const host = options.host ?? "127.0.0.1"
	const port = options.port ?? 3101
	const audioPort = options.audioPort ?? (port === 0 ? 0 : port + 1)
	const load = Math.max(1, options.load ?? 1)
	const summaryBins = Math.min(
		8192,
		Math.max(512, Math.round(options.spectrumBins ?? SPECTRUM_SUMMARY_BINS)),
	)
	const messageEvery = Math.max(20, (options.messageIntervalMs ?? 3000) / load)
	const activityFloods = options.activityFloods ?? false
	let audioOrigin = options.audioOrigin ?? `http://localhost:${audioPort}`
	const startedAt = Date.now()

	// --- State ---

	const tuner: TunerState = {
		sourceId: MOCK_SOURCE_ID,
		frequency: DEFAULT_CENTER_HZ,
		sampleRate: SAMPLE_RATE_HZ,
		gainMode: "manual",
		gain: 297,
		ppm: 0,
		agcMode: false,
		biasTee: false,
		directSampling: "off",
		offsetTuning: false,
		ifGain: 0,
		tunerIfGain: null,
		testMode: false,
		controlMode: "internal",
		lastCommandAt: new Date(startedAt).toISOString(),
		commandCount: 3,
	}
	const secondTuner: TunerState | null = options.secondSource
		? {
				...tuner,
				sourceId: MOCK_SECOND_SOURCE_ID,
				frequency: DEFAULT_CENTER_HZ + 10_000_000,
				gain: 197,
				commandCount: 0,
			}
		: null
	let epoch = 1
	/** Starts the retune sweep scenario (once; a no-op without it). */
	let startSweep: () => void = () => undefined
	/** The retune sweep scenario: frames follow the tuner's rate and draw its signals. */
	const sweepFrame = () =>
		options.retuneSweep
			? { sampleRateHz: tuner.sampleRate, signals: RETUNE_SWEEP_SIGNALS }
			: {}
	/** When the current epoch began (backfill never crosses an epoch). */
	let epochStartedAt = Date.now()
	const decoderStats = new Map<string, number>()
	const suspendedSince = new Map<string, string>()
	/** Set once the routes are registered (./source-feed.ts); until then the feed is live. */
	let feedMock: SourceFeedMock | null = null
	const feedHeld = () => feedMock?.paused() ?? false
	const live = {
		running: false,
		clients: 0,
		bytes: 0,
		autoClients: 0,
		autoActive: "none" as "analog" | "digital" | "none",
		autoSince: Date.now(),
		carrierSince: null as number | null,
		config: {
			enabled: true,
			sourceId: MOCK_SOURCE_ID,
			httpPort: audioPort,
			modulation: "nfm",
			bandwidth: 12500,
			squelch: -60,
			squelchMode: "auto",
			autoMarginDb: 6,
			noiseQuietingDb: LIVE_AUDIO_NOISE_QUIETING_DB.default,
			noiseReduction: "off",
			lowPass: 0,
			highPass: 0,
			gain: 1,
			deEmphasis: false,
			deEmphasisTau: 50,
			audioFormat: "s16le",
			iqDcBlock: false,
			// Tuned.dc.html opens on the DMR channel: 161.150 = 161.500 − 350 kHz.
			offsetHz: -350_000,
		} as LiveAudioConfig,
	}
	const activity: ActivitySummary[] = []
	// the greatest pruned commitSeq, as the core reports it (snapshot.lowBarrier); "0" until one is pruned
	let activityPruned = "0"
	let seq = 1000
	let jobCounter = 0
	const clients = new Set<Client>()
	const timers = new Set<ReturnType<typeof setTimeout>>()

	const later = (ms: number, fn: () => void) => {
		const t = setTimeout(() => {
			timers.delete(t)
			fn()
		}, ms)
		timers.add(t)
	}

	// --- Helpers ---

	/** Operator start / stop / restart over the band-derived statuses (./settings.ts). */
	const lifecycle = createDecoderLifecycle()
	// set once Settings is registered: the ADS-B budget case lasts until the budget is raised
	let budgetRaised = (): boolean => false
	const decoders = (): DecoderInfo[] => {
		const list = withAdsbBudget(
			lifecycle.adjust(
				buildDecoders(
					tuner.frequency,
					startedAt,
					Date.now(),
					decoderStats,
					suspendedSince,
				),
			),
			tuner.frequency,
			budgetRaised(),
			suspendedSince.get("readsb") ?? new Date(startedAt).toISOString(),
		)
		return feedMock
			? withSourcePaused(list, MOCK_SOURCE_ID, feedMock.feed())
			: list
	}

	const tunedHz = () => tuner.frequency + (live.config.offsetHz ?? 0)

	const wide = () =>
		live.config.modulation === "wfm" || live.config.modulation === "raw"
	const decimation = () => (wide() ? 50 : 150)
	const effectiveRate = () => SAMPLE_RATE_HZ / decimation()

	const level = (): LiveAudioLevel => {
		const signal = signalAt(tunedHz())
		const keyed = signal !== null && signalActive(signal, Date.now() / 1000)
		const floor = NOISE_FLOOR_DBFS + 6
		const power =
			keyed && signal
				? signal.powerDbfs + (Math.random() - 0.5) * 2
				: floor + (Math.random() - 0.5) * 3
		const threshold =
			live.config.squelchMode === "auto"
				? floor + (live.config.autoMarginDb ?? 6)
				: live.config.squelch
		// WG7 noise mode: FM quieting opens on any carrier; thresholdDbfs reports the stored squelch
		const open = live.config.squelchMode === "noise" ? keyed : power > threshold
		return {
			sourceId: MOCK_SOURCE_ID,
			channelPowerDbfs: Math.round(power * 10) / 10,
			noiseFloorDbfs: floor,
			squelchOpen: open,
			thresholdDbfs: threshold,
		}
	}

	/** The CTCSS tone (Hz) the mock's transmissions use on the tuned channel, or null. */
	const toneHere = (): number | null =>
		MOCK_TRANSMISSIONS.find(t => Math.abs(t.hz - tunedHz()) <= 6250)?.ctcssHz ??
		null
	const toneGateState = (open: boolean): "off" | "waiting" | "open" => {
		const gate = live.config.toneSquelch
		if (!gate || gate.kind === "none") return "off"
		const heard = toneHere()
		return open &&
			gate.kind === "ctcss" &&
			heard !== null &&
			Math.round(heard * 10) === gate.frequencyTenthsHz
			? "open"
			: "waiting"
	}

	/**
	 * Evidence squelch (docs/specs/evidence-squelch): NFM auto squelch waits for voice or a tone.
	 * The mock hears the transmission's tone after 750 ms, else calls it voice after a second.
	 */
	const autoSquelchOf = (
		open: boolean,
	): NonNullable<LiveAudioStatus["autoSquelch"]> => {
		if (live.config.modulation !== "nfm" || live.config.squelchMode !== "auto")
			return { state: "off" }
		if (!open) {
			live.carrierSince = null
			return { state: "waiting" }
		}
		live.carrierSince ??= Date.now()
		const held = Date.now() - live.carrierSince
		const tone = toneHere()
		if (tone !== null && held >= 750)
			return { state: "open", evidence: "ctcss" }
		if (held >= 1000) return { state: "open", evidence: "voice" }
		return { state: "waiting" }
	}

	/** What `/auto` plays now: the decoded call while one talks (and voice runs), else the analog channel. */
	const autoRouteLevel = (): NonNullable<LiveAudioLevel["autoRoute"]> => {
		const digital = voice.running && voiceCall().talking
		const active = digital ? "digital" : level().squelchOpen ? "analog" : "none"
		if (active !== live.autoActive) {
			live.autoActive = active
			live.autoSince = Date.now()
		}
		return digital ? { active, protocol: "dmr" } : { active }
	}

	// --- Digital voice (dsd-fme): the decoded voice stream on the audio port's /voice. ---
	const VOICE_RATE = 8000
	const voice = { running: false, clients: 0 }
	/** The dsd-fme decoder's call: on while the tuned channel is one of its targets and keyed. */
	const voiceCall = (): { talking: boolean; hz: number | null } => {
		const seed = DECODER_SEEDS.find(d => d.type === "dsd-fme")
		const hz = tunedHz()
		const target = seed?.targetsHz.find(t => Math.abs(t - hz) <= 6250) ?? null
		const signal = target === null ? null : signalAt(hz)
		return {
			talking: signal !== null && signalActive(signal, Date.now() / 1000),
			hz: target,
		}
	}
	const digitalVoiceStatus = (): DigitalVoiceStatus => {
		const { talking, hz } = voiceCall()
		const call =
			talking && hz !== null
				? {
						decoderId: "dsd-fme",
						callId: `call_${Math.floor(Date.now() / 20_000)}`,
						protocol: "dmr",
						talkgroup: 2081,
						source: 2081045,
						slot: 1,
						encrypted: false,
						active: true,
						startedAt: new Date(
							Math.floor(Date.now() / 20_000) * 20_000,
						).toISOString(),
					}
				: null
		return {
			enabled: true,
			running: voice.running,
			config: {
				enabled: true,
				httpPort: audioPort,
				voiceSlot: 1,
				jitterBufferMs: 200,
				maxBufferMs: 1000,
			},
			sampleRate: VOICE_RATE,
			audioFormat: "s16le",
			channels: 1,
			httpUrl: `${audioOrigin}/voice`,
			wavUrl: `${audioOrigin}/voice.wav`,
			clientCount: voice.clients,
			bytesStreamed: 0,
			decoders: [
				{
					decoderId: "dsd-fme",
					mode: "auto",
					udpPort: 0,
					httpUrl: `${audioOrigin}/voice`,
					wavUrl: `${audioOrigin}/voice.wav`,
					clientCount: voice.clients,
					bytesStreamed: 0,
					datagramsReceived: 0,
					datagramsRejected: 0,
					encryptedDatagramsDropped: 0,
					droppedSamples: 0,
					underruns: 0,
					bufferedMs: 0,
					call,
				},
			],
			call,
		}
	}

	const liveStatus = (): LiveAudioStatus => {
		const status: LiveAudioStatus = {
			enabled: live.config.enabled,
			running: live.running,
			sourceId: MOCK_SOURCE_ID,
			sourceConnected: true,
			sourceIqSampleRate: SAMPLE_RATE_HZ,
			config: { ...live.config, httpPort: audioPort },
			effectiveSampleRate: effectiveRate(),
			decimationFactor: decimation(),
			httpUrl: `${audioOrigin}/stream`,
			wavUrl: `${audioOrigin}/stream.wav`,
			clientCount: live.clients,
			bytesStreamed: live.bytes,
			pipelineHealth: live.running ? "running" : "stopped",
			pipelineRestarts: 0,
		}
		if (live.running) {
			const l = level()
			if (l.channelPowerDbfs !== null)
				status.channelPowerDbfs = l.channelPowerDbfs
			if (l.noiseFloorDbfs !== null) status.noiseFloorDbfs = l.noiseFloorDbfs
			status.squelchOpen = l.squelchOpen
			status.thresholdDbfs = l.thresholdDbfs
			status.agc =
				live.config.agc ??
				(["am", "cw", "dsb", "usb", "lsb"].includes(live.config.modulation)
					? "fast"
					: "off")
			// WG7 req 3.4: the gate opens while a transmission with the set tone is on the air
			status.toneSquelch = { state: toneGateState(l.squelchOpen) }
			status.autoSquelch = autoSquelchOf(l.squelchOpen)
		}
		// auto-listen-route: present whenever the audio server listens
		if (live.running) {
			const route = autoRouteLevel()
			status.autoRoute = {
				...route,
				...(route.active === "digital"
					? { decoderId: "dsd-fme", slot: 1 }
					: {}),
				since: new Date(live.autoSince).toISOString(),
				httpUrl: `${audioOrigin}/auto`,
				wavUrl: `${audioOrigin}/auto.wav`,
				clientCount: live.autoClients,
				digitalAvailable: true,
				underruns: 0,
				droppedMs: 0,
				clockRebases: 0,
				latencyMs: 80,
			}
		}
		return status
	}

	/** What `source:status` pushes: the REST row, without `feed` under `socketOmitsFeed`. */
	const sourceStatusEvent = (): ExtendedSourceStatus => {
		const status = sourceStatus()
		if (options.socketOmitsFeed !== true) return status
		const { feed: _feed, ...rest } = status
		void _feed
		return rest
	}
	/** The opt-in second receiver's row: streaming unless its feed is held, no consumers. */
	const secondStatus = (): ExtendedSourceStatus | null => {
		if (!secondTuner) return null
		const held = feedMock?.paused(MOCK_SECOND_SOURCE_ID) ?? false
		const now = Date.now()
		return {
			id: MOCK_SECOND_SOURCE_ID,
			type: "rtl_tcp",
			url: "tcp://receiver-2.local:1234",
			connected: !held,
			activity: held
				? {
						state: "disconnected",
						lastSampleAt: null,
						sampleAgeMs: null,
						timeoutMs: 5000,
					}
				: {
						state: "streaming",
						lastSampleAt: new Date(now - 12).toISOString(),
						sampleAgeMs: 12,
						timeoutMs: 5000,
					},
			consumers: 0,
			bytesReceived: 0,
			dataRate: held ? 0 : (secondTuner.sampleRate * 2) / 1024,
			reconnectAttempts: 0,
			caps: {
				kind: "iq",
				sampleRate: secondTuner.sampleRate,
				format: "U8_IQ",
				centerFreq: secondTuner.frequency,
				exclusive: false,
			},
			assignments: [],
			available: true,
			...(feedMock ? { feed: feedMock.feed(MOCK_SECOND_SOURCE_ID) } : {}),
		}
	}
	/** Every source row, the main one first. */
	const sourceStatuses = (): ExtendedSourceStatus[] => {
		const second = secondStatus()
		return second ? [sourceStatus(), second] : [sourceStatus()]
	}

	const sourceStatus = (): ExtendedSourceStatus => {
		const now = Date.now()
		const bytes = Math.round(((now - startedAt) / 1000) * SAMPLE_RATE_HZ * 2)
		const list = decoders().filter(d => d.sourceId === MOCK_SOURCE_ID)
		// a paused feed: the link is closed, nothing streams (SourceManager.getActivity "disconnected")
		const held = feedHeld()
		return {
			id: MOCK_SOURCE_ID,
			type: "rtl_tcp",
			url: "tcp://192.168.1.40:1234",
			connected: !held,
			activity: held
				? {
						state: "disconnected",
						lastSampleAt: null,
						sampleAgeMs: null,
						timeoutMs: 5000,
					}
				: {
						state: "streaming",
						lastSampleAt: new Date(now - 12).toISOString(),
						sampleAgeMs: 12,
						timeoutMs: 5000,
					},
			consumers: list.filter(d => d.running).length + (live.running ? 1 : 0),
			bytesReceived: bytes,
			// KiB/s, as the core's SourceManager (bytes / 1024 / s)
			dataRate: held ? 0 : (SAMPLE_RATE_HZ * 2) / 1024,
			reconnectAttempts: 0,
			caps: {
				kind: "iq",
				sampleRate: SAMPLE_RATE_HZ,
				format: "U8_IQ",
				centerFreq: tuner.frequency,
				exclusive: false,
			},
			assignments: list.map(d => ({
				decoderId: d.id,
				sourceId: MOCK_SOURCE_ID,
				assignedAt: new Date(startedAt).toISOString(),
			})),
			available: true,
			...(held ? {} : { signalLevelDbfs: -31.5 }),
			...(feedMock ? { feed: feedMock.feed() } : {}),
		}
	}

	const send = (client: Client, message: unknown) => {
		if (client.socket.readyState !== 1) return
		try {
			client.socket.send(JSON.stringify(message))
		} catch {
			// The socket closed under us.
		}
	}

	const broadcast = (channel: string, type: string, data: unknown) => {
		if (clients.size === 0) return
		const text = JSON.stringify({ type, data, channel })
		for (const client of clients) {
			if (!client.channels.has(channel) || client.socket.readyState !== 1)
				continue
			try {
				client.socket.send(text)
			} catch {
				// ignore
			}
		}
	}

	// --- Activity ---

	/** The decoded JSON behind each message summary, for GET /api/activity/:eventId. */
	const decodedById = new Map<string, JsonValue>()
	const summaryFromMessage = (m: MockMessage, at: number): ActivitySummary => {
		seq += 1
		const iso = new Date(at).toISOString()
		const external = m.decoderId === "readsb"
		const summary: ActivitySummary = {
			eventId: `evt_${seq.toString(36)}`,
			commitSeq: String(seq),
			kind: "decoder-reception",
			producedAt: iso,
			receivedAt: iso,
			decoderId: m.decoderId,
			sourceId: external ? null : MOCK_SOURCE_ID,
			protocol: m.protocol,
			category: m.category,
			frequencyHz: m.hz,
			entityKey: m.entityKey,
			title: m.title,
			fields: m.fields,
		}
		if (m.position) summary.position = m.position
		decodedById.set(summary.eventId, m.data)
		if (decodedById.size > 2500) {
			const first = decodedById.keys().next().value
			if (first !== undefined) decodedById.delete(first)
		}
		return summary
	}

	const summaryFromFlood = (f: FloodEvent, at: number): ActivitySummary => {
		seq += 1
		const iso = new Date(at).toISOString()
		const summary: ActivitySummary = {
			...f.summary,
			eventId: `evt_${seq.toString(36)}`,
			commitSeq: String(seq),
			producedAt: iso,
			receivedAt: iso,
		}
		decodedById.set(summary.eventId, f.data)
		if (decodedById.size > 2500) {
			const first = decodedById.keys().next().value
			if (first !== undefined) decodedById.delete(first)
		}
		return summary
	}

	const seedHistory = () => {
		const now = Date.now()
		const items: { at: number; build: (at: number) => ActivitySummary }[] = []
		let at = now - 45 * 60_000
		for (let round = 0; round < 3; round++) {
			for (const m of MOCK_MESSAGES) {
				at += 23_000 + ((m.hz / 1000) % 17) * 1000
				items.push({ at, build: t => summaryFromMessage(m, t) })
			}
			for (const tx of MOCK_TRANSMISSIONS) {
				at += 19_000
				items.push({
					at,
					build: t => {
						seq += 1
						const iso = new Date(t).toISOString()
						// The core's transmission summary fields (src/core/activity/storage/row.ts).
						const fields: ActivitySummary["fields"][number][] = [
							{
								key: "durationMs",
								label: "Duration",
								value: tx.durationMs,
								unit: "ms",
							},
							{
								key: "modulation",
								label: "Modulation",
								value: tx.hz < 137e6 ? "am" : "nfm",
							},
						]
						if (tx.ctcssHz !== null)
							fields.push({
								key: "ctcssHz",
								label: "CTCSS",
								value: tx.ctcssHz,
								unit: "Hz",
							})
						if (tx.dtmf !== null)
							fields.push({ key: "dtmf", label: "DTMF", value: tx.dtmf })
						return {
							eventId: `evt_${seq.toString(36)}`,
							commitSeq: String(seq),
							kind: "analog-transmission",
							producedAt: iso,
							receivedAt: iso,
							decoderId: null,
							sourceId: MOCK_SOURCE_ID,
							protocol: "analog",
							category: "voice",
							frequencyHz: tx.hz,
							entityKey: null,
							title: tx.title,
							fields,
						}
					},
				})
			}
		}
		// One ingestion gap in the history, as the core writes when it sheds load.
		items.push({
			at: now - 20 * 60_000,
			build: t => {
				seq += 1
				const iso = new Date(t).toISOString()
				return {
					eventId: `evt_${seq.toString(36)}`,
					commitSeq: String(seq),
					kind: "ingestion-gap",
					producedAt: iso,
					receivedAt: iso,
					decoderId: null,
					sourceId: null,
					protocol: null,
					category: "other",
					frequencyHz: null,
					entityKey: null,
					title: "Ingestion gap (rate-limited)",
					fields: [{ key: "dropped", label: "Dropped", value: 37 }],
				}
			},
		})
		if (activityFloods)
			for (const f of floodEvents(
				now - FLOOD_HISTORY_MS,
				now - 1000,
				now - FLOOD_AIRCRAFT_HISTORY_MS,
			))
				items.push({ at: f.at, build: t => summaryFromFlood(f, t) })
		for (const item of items.sort((a, b) => a.at - b.at))
			activity.push(item.build(Math.min(item.at, now - 1000)))
	}
	seedHistory()

	const pushActivity = (summary: ActivitySummary) => {
		activity.push(summary)
		if (activity.length > 2000) {
			const removed = activity.splice(0, activity.length - 2000)
			activityPruned = removed.at(-1)?.commitSeq ?? activityPruned
		}
		for (const client of clients)
			for (const [id, query] of client.activity) {
				if (!matchesQuery(summary, query)) continue
				send(client, {
					type: "activity:records",
					channel: "activity",
					data: {
						id,
						items: [summary],
						scannedThrough: summary.commitSeq,
						cursor: `mock:${summary.commitSeq}`,
					},
				})
			}
	}

	const emitMessage = () => {
		// no IQ while the feed is paused: nothing decodes
		if (feedHeld()) return
		const candidates = MOCK_MESSAGES.filter(m => {
			const seed = DECODER_SEEDS.find(d => d.id === m.decoderId)
			return seed !== undefined && decoderInBand(seed, tuner.frequency)
		})
		const m = candidates[Math.floor(Math.random() * candidates.length)]
		if (!m) return
		const now = Date.now()
		decoderStats.set(m.decoderId, (decoderStats.get(m.decoderId) ?? 0) + 1)
		broadcast("decoders", "decoder:output", {
			decoderId: m.decoderId,
			output: {
				type: m.outputType,
				decoder: m.decoderId,
				timestamp: new Date(now).toISOString(),
				data: m.data,
			},
		})
		pushActivity(summaryFromMessage(m, now))
	}

	// --- Ticker (runs while a WebSocket client is connected) ---

	let ticker: ReturnType<typeof setInterval> | null = null
	let tick = 0
	let lastMessageAt = Date.now()
	let lastFloodAt = Date.now()
	const onTick = () => {
		tick += 1
		if (live.running) {
			const l: LiveAudioLevel = level()
			l.autoSquelch = autoSquelchOf(l.squelchOpen)
			if (live.autoClients > 0) l.autoRoute = autoRouteLevel()
			broadcast("live-audio", "live-audio:level", l)
		}
		// several per tick under load (messageEvery below the 250 ms tick)
		while (Date.now() - lastMessageAt >= messageEvery) {
			lastMessageAt += messageEvery
			emitMessage()
		}
		if (activityFloods) {
			const to = Date.now()
			for (const f of floodEvents(lastFloodAt, to))
				pushActivity(summaryFromFlood(f, f.at))
			lastFloodAt = to
		}
		if (tick % 20 === 0)
			broadcast("sources", "source:status", sourceStatusEvent())
	}
	const startTicker = () => {
		if (ticker) return
		lastMessageAt = Date.now()
		lastFloodAt = Date.now()
		ticker = setInterval(onTick, 250)
	}
	const stopTickerIfIdle = () => {
		if (clients.size > 0 || !ticker) return
		clearInterval(ticker)
		ticker = null
	}

	// --- Spectrum ---

	const stopSpectrum = (client: Client) => {
		if (client.spectrum) clearInterval(client.spectrum.timer)
		client.spectrum = null
	}

	const sendProfile = (client: Client, data: SpectrumProfileEventData) =>
		send(client, { type: "spectrum:profile", data, channel: "spectrum" })

	const subscribeSpectrum = (client: Client, raw: unknown) => {
		const parsed = normaliseSpectrumOptions(raw, summaryBins)
		const previous = client.spectrum
		const reject = (
			code: "SPECTRUM_OPTIONS_INVALID" | "SPECTRUM_SOURCE_NOT_FOUND",
			message: string,
		) =>
			sendProfile(client, {
				selection: previous
					? previous.explicit
						? "source"
						: "default"
					: "none",
				sourceId: previous?.explicit ? previous.sourceId : null,
				profile: previous
					? {
							key: `${previous.hz}:${previous.bins}`,
							hz: previous.hz,
							bins: previous.bins,
						}
					: null,
				effectiveHz: previous?.explicit ? previous.hz : null,
				outcome: "rejected",
				adjusted: [],
				code,
				message,
			})
		if (!parsed.ok) return reject("SPECTRUM_OPTIONS_INVALID", parsed.message)
		if (parsed.sourceId !== null && parsed.sourceId !== MOCK_SOURCE_ID)
			return reject(
				"SPECTRUM_SOURCE_NOT_FOUND",
				`Unknown source ${parsed.sourceId}`,
			)
		stopSpectrum(client)
		const { hz, bins, explicit } = parsed
		// WG1 backfill like the core: recent frames of the current epoch, oldest first, at most
		// SPECTRUM_BACKFILL_MAX_FRAMES (synthesised here, as if buffered).
		const now = Date.now()
		const periodMs = 1000 / hz
		const backfillFrames =
			explicit && parsed.backfillMs > 0
				? Math.min(
						SPECTRUM_BACKFILL_MAX_FRAMES,
						Math.floor(
							Math.min(parsed.backfillMs, now - epochStartedAt) / periodMs,
						),
					)
				: null
		sendProfile(client, {
			selection: explicit ? "source" : "default",
			sourceId: explicit ? MOCK_SOURCE_ID : null,
			profile: { key: `${hz}:${bins}`, hz, bins },
			effectiveHz: explicit ? hz : null,
			outcome: !explicit
				? "default"
				: parsed.adjusted.length > 0
					? "nearest"
					: "exact",
			adjusted: parsed.adjusted,
			...(backfillFrames !== null ? { backfillFrames } : {}),
		})
		for (let k = backfillFrames ?? 0; k >= 1; k--)
			send(client, {
				type: "spectrum:frame",
				channel: "spectrum",
				data: {
					...synthFrame({
						sourceId: MOCK_SOURCE_ID,
						centerHz: tuner.frequency,
						bins,
						summaryBins,
						hz,
						epoch,
						nowMs: now - k * periodMs,
						...sweepFrame(),
					}),
					backfill: true,
				},
			})
		// a paused feed sends no frames: the waterfall stops on its last rows
		const frame = (snapshot: boolean) => {
			if (feedHeld()) return
			send(client, {
				type: "spectrum:frame",
				channel: "spectrum",
				data: synthFrame({
					sourceId: MOCK_SOURCE_ID,
					centerHz: tuner.frequency,
					bins,
					summaryBins,
					hz,
					epoch,
					nowMs: Date.now(),
					snapshot,
					...sweepFrame(),
				}),
			})
		}
		frame(true)
		startSweep()
		client.spectrum = {
			sourceId: MOCK_SOURCE_ID,
			hz,
			bins,
			explicit,
			timer: setInterval(() => frame(false), Math.round(1000 / hz)),
		}
	}

	// --- Identify ---

	const identify = (
		hz: number,
		bandwidthHz: number | undefined,
		timeoutMs: number,
		protocols: readonly ScannerProtocol[] = [],
	): ScanJob => {
		jobCounter += 1
		const id = `j_${Date.now().toString(36).toUpperCase()}${String(jobCounter).padStart(4, "0")}`
		const now = new Date().toISOString()
		const signal = signalAt(hz)
		const plan = onlyProtocols(identifyPlanFor(signal), protocols)
		const bw = bandwidthHz ?? signal?.bwHz ?? 12_500
		const centre = tuner.frequency
		const half = (SAMPLE_RATE_HZ * USABLE_FRACTION) / 2
		const event = (
			state: ScannerIdentifyEventData["state"],
			trials: ScannerIdentifyTrial[],
			result?: ScannerIdentifyResult,
		): ScannerIdentifyEventData => {
			const e: ScannerIdentifyEventData = {
				jobId: id,
				targetHz: hz,
				state,
				trials,
			}
			if (result) e.result = result
			return e
		}
		const trialsAt = (step: number): ScannerIdentifyTrial[] =>
			plan.trials.map((t, i) => ({
				protocol: t.protocol,
				decoder: t.decoder,
				mode: t.mode,
				transport: t.decoder === null ? null : "offset",
				outcome: i < step ? t.outcome : i === step ? "running" : "pending",
			}))
		const job: ScanJob = {
			resumeAt: null,
			resumeHeldBy: null,
			id,
			name: `Identify ${(hz / 1e6).toFixed(5)} MHz`,
			// the core answers the POST before the job starts
			state: "starting",
			passive: false,
			spec: {
				sourceId: MOCK_SOURCE_ID,
				sensitivity: "normal",
				priority: 50,
				mode: "in-window",
				kind: "identify",
				ranges: [
					{ startHz: Math.round(hz - bw / 2), endHz: Math.round(hz + bw / 2) },
				],
				exclusions: [],
				protocols: [],
				fftSize: 8192,
				integrationMs: 100,
				thresholdDb: null,
				dwellMs: 0,
				settleMs: 0,
				hold: { policy: "never", confirmHoldMs: {}, maxHoldMs: 0, hangMs: 0 },
				revisit: { share: 0, maxIntervalMs: null },
				record: { voice: true, analog: true, data: true },
				evidence: { psd: false, iq: false },
				tuner: {
					sampleRateHz: null,
					gainTenthsDb: null,
					agc: null,
					overload: "flag",
				},
				stop: { afterSweeps: null, afterMs: timeoutMs, onFirstDecoded: true },
				takeover: false,
				resume: { autoAfterIdleMs: null, onBoot: false },
				txDurationHintMs: 0,
				capture: {
					enabled: false,
					mode: "channel",
					preMs: 0,
					postMs: 0,
					onlyDecoded: true,
					maxPerHour: 0,
				},
				provenance: {},
			},
			plan: {
				hops: [
					{
						index: 0,
						centreHz: centre,
						covered: { startHz: centre - half, endHz: centre + half },
						channelCount: 1,
						dcAdjacentChannelsHz: [],
						excluded: [],
						dcMinEdgeHz: 2000,
					},
				],
				usableHalfSpanHz: half,
				dcGuardHz: 2000,
				ppmMarginHz: 500,
			},
			issues: [],
			impact: null,
			unrestorable: [],
			progress: {
				sweepIndex: 0,
				hopIndex: 0,
				hopCount: 1,
				sweepPeriodMs: null,
				coverage: 1,
				holdingOn: null,
				settleMode: "none",
				probes: [],
				counts: {
					observations: 0,
					transients: 0,
					discoveries: { activity: 0, candidate: 0, classified: 0, decoded: 0 },
				},
			},
			createdAt: now,
			updatedAt: now,
			identify: {
				target:
					bandwidthHz !== undefined
						? { frequencyHz: hz, bandwidthHz }
						: { frequencyHz: hz },
				timeoutMs,
				protocols: [...protocols],
				exhaustive: false,
				record: true,
				targets: [event("waiting-for-signal", trialsAt(-1))],
			},
		}
		scanner.identifyJobs.set(id, job)

		const update = (e: ScannerIdentifyEventData, done = false) => {
			const current = scanner.identifyJobs.get(id)
			if (
				!current ||
				(current.state !== "running" && current.state !== "starting")
			)
				return
			current.updatedAt = new Date().toISOString()
			if (current.identify) current.identify.targets = [e]
			broadcast("scanner", "scanner:identify", e)
			if (done) {
				current.state = "completed"
				current.endedAt = current.updatedAt
				broadcast("scanner", "scanner:job", current)
			}
		}
		const resultFor = (): ScannerIdentifyResult => {
			const metadata = { ...emptyMetadata(), ...(plan.metadata ?? {}) }
			const confidence =
				plan.state === "identified"
					? "decoded"
					: plan.state === "candidate"
						? "candidate"
						: "activity"
			const r: ScannerIdentifyResult = {
				confidence,
				metadata,
				measurements: signal
					? {
							source: "track",
							centreHz: signal.hz,
							obwHz: signal.bwHz,
							peakDbfs: signal.powerDbfs,
							snrDb: Math.round(signal.powerDbfs - NOISE_FLOOR_DBFS),
							floorDbfs: NOISE_FLOOR_DBFS,
							dutyCycle:
								signal.per && signal.on
									? Math.round((signal.on / signal.per) * 100) / 100
									: 1,
							class: plan.class,
						}
					: {
							source: "spectrum",
							centreHz: hz,
							obwHz: null,
							peakDbfs: null,
							snrDb: null,
							floorDbfs: NOISE_FLOOR_DBFS,
							dutyCycle: null,
							class: "unknown",
						},
			}
			if (plan.protocol) r.protocol = plan.protocol
			if (plan.identity) r.identity = plan.identity
			if (!signal && Math.abs(hz - centre) <= 2000) r.artefact = "dc"
			return r
		}
		const steps = plan.trials.length
		const finish = () => {
			const current = scanner.identifyJobs.get(id)
			if (!current || current.state !== "running") return
			const result = resultFor()
			// the core records the identify observation: the result names its discovery
			scanner.identified(id, result)
			update(event(plan.state, trialsAt(steps), result), true)
		}
		// The core's order: waiting-for-signal first, then the job turns "running" (about 1 s later on a
		// real core; compressed here).
		later(80, () => update(event("waiting-for-signal", trialsAt(-1))))
		later(300, () => {
			const current = scanner.identifyJobs.get(id)
			if (!current || current.state !== "starting") return
			current.state = "running"
			current.startedAt = new Date().toISOString()
			current.updatedAt = current.startedAt
			broadcast("scanner", "scanner:job", current)
		})
		if (signal && steps > 0) {
			later(600, () => update(event("trying", trialsAt(0))))
			later(1300, () =>
				update(event("trying", trialsAt(Math.max(1, Math.floor(steps / 2))))),
			)
		}
		later(2000, finish)
		return job
	}

	// --- HTTP ---

	const app = Fastify({ logger: false })
	await app.register(fastifyWebsocket)
	// Error bodies as the core's (src/api/server.ts setNotFoundHandler / setErrorHandler, legacy mode).
	app.setNotFoundHandler((request, reply) =>
		reply.code(404).send({
			error: "NotFound",
			code: "NOT_FOUND",
			message: `Route ${request.method} ${request.url} not found`,
			correlationId: randomUUID(),
		}),
	)
	app.setErrorHandler((error: FastifyError, _request, reply) => {
		if (error.validation)
			return reply.code(400).send({
				error: "ValidationError",
				code: "VALIDATION_ERROR",
				message: error.message,
				details: error.validation,
				correlationId: randomUUID(),
			})
		const status = error.statusCode ?? 500
		if (status >= 400 && status < 500)
			return reply.code(status).send({
				error: error.name || "ClientError",
				code: error.code || "CLIENT_ERROR",
				message: error.message,
				correlationId: randomUUID(),
			})
		return reply.code(500).send({
			error: "InternalServerError",
			code: "INTERNAL_ERROR",
			message: error.message,
			correlationId: randomUUID(),
		})
	})

	const ok = () => ({
		status: "ok" as const,
		timestamp: new Date().toISOString(),
	})
	app.get("/health", async () => ok())
	// Operator data as a protected core serves it (core mounts it in protected mode only).
	const operatorData = registerOperatorData(app, {
		seeds: [
			...MOCK_SAVED_FREQUENCIES,
			...(options.bandFixtures ? [BAND_FIXTURE_BOOKMARK] : []),
			...(options.retuneSweep ? [RETUNE_SWEEP_BOOKMARK] : []),
		],
		onCommit: dto => broadcast("operator-data", "operator-data:updated", dto),
	})
	app.get("/health/live", async () => ok())
	app.get("/health/ready", async () => ok())
	// GET /api/spectrum: the limits the web app reads (Settings › FFT size); bins.max as WG8 serves it.
	app.get("/api/spectrum", async () => ({
		limits: {
			maxProfiles: 4,
			hz: { min: 0.5, max: 25, step: 0.5 },
			bins: { min: 128, max: summaryBins },
			binsCap: { setting: "auto", cap: 8192, source: "measured" },
			averaging: { min: 1, max: 32 },
			backfill: {
				maxMs: SPECTRUM_BACKFILL_MAX_MS,
				maxFrames: SPECTRUM_BACKFILL_MAX_FRAMES,
				maxBytes: 512 * 1024,
			},
		},
		subscribers: [...clients].filter(c => c.spectrum !== null).length,
	}))
	// GET /api/status: version and uptime (seconds) as core's health routes report them.
	app.get("/api/status", async () => {
		const uptime = Math.round((Date.now() - startedAt) / 1000)
		const list = decoders()
		const timestamp = new Date().toISOString()
		const up = { status: "up" as const, lastCheck: timestamp }
		return {
			status: "healthy",
			uptime,
			version: MOCK_VERSION,
			sources: sourceStatuses(),
			decoders: list,
			audio: { outputPort: 3103, clientsConnected: 0 },
			health: {
				status: "healthy",
				timestamp,
				uptime,
				components: {
					api: up,
					decoders: Object.fromEntries(list.map(d => [d.id, up])),
					source: up,
				},
			},
		}
	})
	// --- Settings (./settings.ts): station, decoder types / settings / lifecycle / log, storage,
	// config export. Writable routes are mounted as on a protected core (see README).
	const settings = registerSettingsMock(app, {
		decoders,
		broadcast: (channel, type, data) => broadcast(channel, type, data),
		lifecycle,
	})
	budgetRaised = () => settings.budgetRaised()
	// --- Map (./map.ts): aircraft, vessels, APRS, mesh and coverage around the Settings station.
	const map = registerMapMock(app, {
		load,
		...(options.adsbRate !== undefined ? { adsbRate: options.adsbRate } : {}),
		broadcast: (channel, type, data) => broadcast(channel, type, data),
		station: () => {
			const st = settings.station()
			return st.lat.value !== null && st.lon.value !== null
				? { lat: st.lat.value, lon: st.lon.value }
				: null
		},
	})
	// --- Recordings (./recordings.ts): the WG8 inventory, WG9 Keep and delete, synthetic WAV files.
	const recordings = registerRecordingsMock(app)
	// GET /api/access/bootstrap is deliberately not mounted: a legacy core answers it with 404.

	app.get("/api/sources", async () => sourceStatuses())
	// The core has no GET /api/sources/:id (it answers the route-not-found 404 below).

	app.get("/api/decoders", async () => decoders())
	// The core's one verdict per decoder (./decoder-summary.ts); ADS-B near 1090 MHz waits for CPU budget.
	app.get("/api/decoders/summary", async () =>
		buildDecoderSummaries(decoders(), Date.now()),
	)
	app.get<{ Params: { id: string } }>(
		"/api/decoders/:id",
		async (request, reply) => {
			const found = decoders().find(d => d.id === request.params.id)
			if (!found)
				return reply.code(404).send({
					error: "NotFound",
					code: "DECODER_NOT_FOUND",
					message: `Decoder with id '${request.params.id}' not found`,
				})
			return found
		},
	)

	/** A frequency write as the core's tuner controller applies it (`rest` or `scanner` origin). */
	const applyFrequency = (hz: number, origin: "rest" | "scanner") => {
		const sourceId = MOCK_SOURCE_ID
		const before = new Map(decoders().map(d => [d.id, d.suspended]))
		if (hz !== tuner.frequency) {
			epoch += 1
			epochStartedAt = Date.now()
		}
		// the core drops a reported band gain before every frequency write
		delete tuner.bandGain
		tuner.frequency = hz
		if (tuner.unknownFields) {
			const rest = tuner.unknownFields.filter(f => f !== "frequency")
			if (rest.length > 0) tuner.unknownFields = rest
			else delete tuner.unknownFields
		}
		tuner.commandCount += 1
		tuner.lastCommandAt = new Date().toISOString()
		broadcast("tuner", "tuner:command-sent", {
			sourceId,
			command: "set_frequency",
			value: hz,
			origin,
		})
		broadcast("tuner", "tuner:state-changed", { sourceId, state: tuner })
		for (const d of decoders()) {
			if (before.get(d.id) === d.suspended) continue
			if (d.suspended) suspendedSince.set(d.id, new Date().toISOString())
			else suspendedSince.delete(d.id)
			broadcast(
				"decoders",
				"decoder:status",
				decoders().find(x => x.id === d.id),
			)
		}
		broadcast("sources", "source:status", sourceStatusEvent())
	}

	// --- Scanner (./scanner.ts): status, settings, bandplans, plans, jobs, discoveries. ---
	const scanner = registerScannerMock(app, {
		sourceId: MOCK_SOURCE_ID,
		tuner,
		broadcast,
		retune: hz => applyFrequency(hz, "scanner"),
		decoders,
		liveStatus,
		...(options.bandFixtures ? { bandFixtures: true } : {}),
		...(options.retuneSweep ? { retuneSweep: true } : {}),
		...(options.overloadHint ? { overloadHint: true } : {}),
		lastActivity: hz => {
			for (let i = activity.length - 1; i >= 0; i--) {
				const a = activity[i]
				if (a?.kind === "decoder-reception" && a.frequencyHz === hz)
					return { eventId: a.eventId, producedAt: a.producedAt }
			}
			return null
		},
		liveListen: offsetHz => {
			live.config = { ...live.config, offsetHz, sourceId: MOCK_SOURCE_ID }
			broadcast("live-audio", "live-audio:config", liveStatus().config)
			if (!live.running) {
				live.running = true
				broadcast("live-audio", "live-audio:started", {
					sourceId: MOCK_SOURCE_ID,
				})
			}
			broadcast("live-audio", "live-audio:status", liveStatus())
		},
	})

	const tunerNotFound = (reply: FastifyReply, sourceId: string) =>
		reply.code(404).send({
			error: "TunerSourceNotFoundError",
			code: "TUNER_SOURCE_NOT_FOUND",
			message: `Tuner source not found: ${sourceId}`,
		})

	app.get("/api/tuner", async () =>
		secondTuner ? [tuner, secondTuner] : [tuner],
	)
	app.get<{ Params: { sourceId: string } }>(
		"/api/tuner/:sourceId",
		async (request, reply) =>
			request.params.sourceId === MOCK_SOURCE_ID
				? tuner
				: secondTuner && request.params.sourceId === MOCK_SECOND_SOURCE_ID
					? secondTuner
					: tunerNotFound(reply, request.params.sourceId),
	)
	app.post<{ Params: { sourceId: string }; Body: { hz: number } }>(
		"/api/tuner/:sourceId/frequency",
		{
			schema: {
				body: {
					type: "object",
					properties: { hz: { type: "integer" } },
					required: ["hz"],
					additionalProperties: false,
				},
			},
		},
		async (request, reply) => {
			const { sourceId } = request.params
			if (sourceId !== MOCK_SOURCE_ID) return tunerNotFound(reply, sourceId)
			const { hz } = request.body
			if (hz < TUNER_MIN_HZ || hz > TUNER_MAX_HZ)
				return reply.code(400).send({
					error: "TunerValidationError",
					code: "TUNER_VALIDATION_ERROR",
					message: `frequency out of range: ${hz} (expected ${TUNER_MIN_HZ}-${TUNER_MAX_HZ})`,
				})
			const delay = options.retuneMs ?? 0
			if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay))
			applyFrequency(hz, "rest")
			receiver.operatorRetuned(hz)
			// an operator write: a running sweep pauses (preempted-operator)
			scanner.operatorWrite()
			return tuner
		},
	)

	// --- Receiver feed (./source-feed.ts): pause / resume; decoders wait with reason source-paused. ---
	const feed = registerSourceFeedMock(app, {
		sourceId: MOCK_SOURCE_ID,
		...(secondTuner ? { extraSourceIds: [MOCK_SECOND_SOURCE_ID] } : {}),
		...(options.resumeMs !== undefined ? { resumeMs: options.resumeMs } : {}),
		...(options.resumeFailures !== undefined
			? { resumeFailures: options.resumeFailures }
			: {}),
		...(options.persistFailures !== undefined
			? { persistFailures: options.persistFailures }
			: {}),
		paused: sourceId => {
			if (sourceId === MOCK_SOURCE_ID) scanner.feedPaused()
		},
		resumed: (sourceId, restoreTuning) => {
			if (sourceId !== MOCK_SOURCE_ID) return
			// a plain resume writes no tuning: like the core, centre, rate and gain read unverified
			// with their last known values until set (a measured rate is adopted, still unverified)
			if (!restoreTuning) {
				tuner.unknownFields = [
					...new Set([
						...(tuner.unknownFields ?? []),
						...PLAIN_RESUME_UNVERIFIED,
					]),
				]
				delete tuner.bandGain
				if (options.measuredRateHz !== undefined) {
					tuner.sampleRate = options.measuredRateHz
					tuner.measuredFields = ["sampleRate"]
				} else delete tuner.measuredFields
				broadcast("tuner", "tuner:state-changed", {
					sourceId,
					state: tuner,
				})
			}
			scanner.feedResumed(restoreTuning)
		},
		onChange: sourceId => {
			if (sourceId !== MOCK_SOURCE_ID) {
				const second = secondStatus()
				if (second) broadcast("sources", "source:status", second)
				return
			}
			broadcast("sources", "source:status", sourceStatusEvent())
			for (const d of decoders())
				if (d.sourceId === MOCK_SOURCE_ID)
					broadcast("decoders", "decoder:status", d)
		},
		tuning: sourceId => {
			const t = sourceId === MOCK_SOURCE_ID ? tuner : secondTuner
			return t
				? {
						centerFreq: t.frequency,
						sampleRate: t.sampleRate,
						gainMode: t.gainMode,
						gain: t.gain,
					}
				: null
		},
		// a restore resume writes the pre-pause tuning back (a plain resume writes none)
		restore: (sourceId, t) => {
			const target = sourceId === MOCK_SOURCE_ID ? tuner : secondTuner
			if (!target) return
			if (t.sampleRate !== undefined) target.sampleRate = t.sampleRate
			if (t.gainMode !== undefined) target.gainMode = t.gainMode
			if (t.gain !== undefined) target.gain = t.gain
			// like the core: written fields are known again, and a restore resume measured nothing
			const written = new Set<string>(["frequency"])
			if (t.sampleRate !== undefined) written.add("sampleRate")
			if (t.gainMode !== undefined) written.add("gainMode")
			if (t.gain !== undefined) written.add("gain")
			const unknown = target.unknownFields?.filter(f => !written.has(f)) ?? []
			if (unknown.length > 0) target.unknownFields = unknown
			else delete target.unknownFields
			delete target.measuredFields
			if (sourceId === MOCK_SOURCE_ID) applyFrequency(t.centerFreq, "rest")
			else {
				target.frequency = t.centerFreq
				broadcast("tuner", "tuner:state-changed", { sourceId, state: target })
			}
		},
	})
	feedMock = feed

	// --- Receiver controls (./receiver.ts): tuner settings, capabilities, relay. Begin. ---
	const receiver = registerReceiverMock(app, {
		sourceId: MOCK_SOURCE_ID,
		tuner,
		broadcast,
		onCommand: () => scanner.operatorWrite(),
		restartStream: () => {
			// the core restarts the IQ stream: spectrum history never crosses the new epoch
			epoch += 1
			epochStartedAt = Date.now()
			broadcast("sources", "source:status", sourceStatusEvent())
		},
		retune: async hz => {
			await app.inject({
				method: "POST",
				url: `/api/tuner/${encodeURIComponent(MOCK_SOURCE_ID)}/frequency`,
				payload: { hz },
			})
		},
	})
	// --- Receiver controls. End. ---

	// --- Retune sweep scenario (./retune-sweep.ts): through the bands, then park. ---
	let sweepTimer: ReturnType<typeof setTimeout> | null = null
	// the sweep starts with the first spectrum subscription, so a page loaded late still sees it
	if (options.retuneSweep) {
		const tunerUrl = `/api/tuner/${encodeURIComponent(MOCK_SOURCE_ID)}`
		const step = (i: number) => {
			const s = RETUNE_SWEEP_STEPS[i]
			if (!s) {
				sweepTimer = null
				return
			}
			void (async () => {
				if (s.sampleRateHz !== tuner.sampleRate)
					await app.inject({
						method: "POST",
						url: `${tunerUrl}/sample-rate`,
						payload: { hz: s.sampleRateHz },
					})
				await app.inject({
					method: "POST",
					url: `${tunerUrl}/frequency`,
					payload: { hz: s.hz },
				})
			})().then(
				() => {
					sweepTimer = setTimeout(() => step(i + 1), RETUNE_SWEEP_STEP_MS)
				},
				() => undefined,
			)
		}
		startSweep = () => {
			startSweep = () => undefined
			sweepTimer = setTimeout(() => step(0), RETUNE_SWEEP_STEP_MS)
		}
	}
	// --- Retune sweep scenario. End. ---

	app.get("/api/digital-voice/status", async () => digitalVoiceStatus())
	app.post("/api/digital-voice/start", async () => {
		if (!voice.running) {
			voice.running = true
			broadcast("digital-voice", "digital-voice:status", digitalVoiceStatus())
		}
		return { success: true }
	})
	app.post("/api/digital-voice/stop", async () => {
		if (voice.running) {
			voice.running = false
			broadcast("digital-voice", "digital-voice:status", digitalVoiceStatus())
		}
		return { success: true }
	})

	app.get("/api/live-audio/status", async () => liveStatus())
	app.post("/api/live-audio/start", async () => {
		if (!live.running) {
			live.running = true
			broadcast("live-audio", "live-audio:started", {
				sourceId: MOCK_SOURCE_ID,
			})
			broadcast("live-audio", "live-audio:status", liveStatus())
		}
		return { success: true }
	})
	app.post("/api/live-audio/stop", async () => {
		if (live.running) {
			live.running = false
			broadcast("live-audio", "live-audio:stopped", {
				sourceId: MOCK_SOURCE_ID,
			})
			broadcast("live-audio", "live-audio:status", liveStatus())
		}
		return { success: true }
	})
	app.patch<{ Body: unknown }>(
		"/api/live-audio/config",
		async (request, reply) => {
			// Type and range errors come from the core's route schema (VALIDATION_ERROR).
			const bad = (message: string) =>
				reply.code(400).send({
					error: "ValidationError",
					code: "VALIDATION_ERROR",
					message,
					correlationId: randomUUID(),
				})
			const body = request.body
			if (!isRecord(body)) return bad("body must be an object")
			const next: LiveAudioConfig = { ...live.config }
			const num = (
				key: string,
				min: number,
				max: number,
			): number | undefined | string => {
				// worded as the core's schema validation (ajv) words it
				const v = body[key]
				if (v === undefined) return undefined
				if (typeof v !== "number" || !Number.isFinite(v))
					return `body/${key} must be number`
				if (v < min) return `body/${key} must be >= ${min}`
				if (v > max) return `body/${key} must be <= ${max}`
				return v
			}
			for (const [key, min, max] of [
				["bandwidth", 0, 250_000],
				["squelch", -150, 0],
				["autoMarginDb", 0, 40],
				[
					"noiseQuietingDb",
					LIVE_AUDIO_NOISE_QUIETING_DB.min,
					LIVE_AUDIO_NOISE_QUIETING_DB.max,
				],
				["lowPass", 0, 24_000],
				["highPass", 0, 24_000],
				["gain", 0, 100],
				["offsetHz", -Infinity, Infinity],
			] as const) {
				const v = num(key, min, max)
				if (typeof v === "string") return bad(v)
				if (v !== undefined) next[key] = v
			}
			const modulation = body["modulation"]
			if (modulation !== undefined) {
				if (typeof modulation !== "string" || !MODULATIONS.has(modulation))
					return bad("modulation: invalid value")
				next.modulation = modulation as LiveAudioConfig["modulation"]
			}
			const squelchMode = body["squelchMode"]
			if (squelchMode !== undefined) {
				if (
					squelchMode !== "manual" &&
					squelchMode !== "auto" &&
					squelchMode !== "noise"
				)
					return bad("squelchMode: invalid value")
				next.squelchMode = squelchMode
			}
			// WG7 req 2.3: noise squelch is FM-only (also when a PATCH moves a noise config off FM)
			if (
				next.squelchMode === "noise" &&
				!LIVE_AUDIO_NOISE_SQUELCH_MODULATIONS.includes(next.modulation)
			)
				return reply.code(400).send({
					error: "Bad Request",
					message:
						"Configuration validation failed:\n  - squelchMode: noise squelch requires nfm or wfm modulation",
				})
			const agc = body["agc"]
			if (agc !== undefined) {
				if (agc === null) delete next.agc
				else if (agc === "off" || agc === "slow" || agc === "fast")
					next.agc = agc
				else return bad("agc: invalid value")
			}
			for (const key of ["enabled", "deEmphasis", "iqDcBlock"] as const) {
				const v = body[key]
				if (v === undefined) continue
				if (typeof v !== "boolean") return bad(`${key}: must be a boolean`)
				next[key] = v
			}
			const nr = body["noiseReduction"]
			if (nr !== undefined) {
				if (
					nr !== "off" &&
					nr !== "voice" &&
					nr !== "noaa-apt" &&
					nr !== "narrow-band"
				)
					return bad("noiseReduction: invalid value")
				next.noiseReduction = nr
			}
			const tau = body["deEmphasisTau"]
			if (tau !== undefined) {
				if (tau !== 50 && tau !== 75)
					return bad("deEmphasisTau: must be 50 or 75")
				next.deEmphasisTau = tau
			}
			const tone = body["toneSquelch"]
			if (tone !== undefined) {
				if (!isRecord(tone)) return bad("body/toneSquelch must be object")
				if (tone["kind"] === "none") next.toneSquelch = { kind: "none" }
				else if (
					tone["kind"] === "ctcss" &&
					typeof tone["frequencyTenthsHz"] === "number"
				)
					next.toneSquelch = {
						kind: "ctcss",
						frequencyTenthsHz: tone["frequencyTenthsHz"],
					}
				else if (
					tone["kind"] === "dcs" &&
					typeof tone["code"] === "string" &&
					(tone["polarity"] === "normal" || tone["polarity"] === "inverted")
				)
					next.toneSquelch = {
						kind: "dcs",
						code: tone["code"],
						polarity: tone["polarity"],
					}
				else return bad("toneSquelch: invalid value")
			}
			// WG7 req 3.1: a tone gate is NFM-only
			if (
				next.toneSquelch !== undefined &&
				next.toneSquelch.kind !== "none" &&
				next.modulation !== "nfm"
			)
				return reply.code(400).send({
					error: "Bad Request",
					message:
						"Configuration validation failed:\n  - toneSquelch: tone squelch requires nfm modulation",
				})
			const format = body["audioFormat"]
			if (format !== undefined) {
				if (format !== "s16le" && format !== "f32le")
					return bad("audioFormat: invalid value")
				next.audioFormat = format
			}
			if (body["sourceId"] !== undefined && body["sourceId"] !== MOCK_SOURCE_ID)
				return bad("sourceId: unknown source")
			// The core's channel check (src/decoders/csdr-stages.ts validateChannelOffset), answered as the
			// core's live-audio route does: 400 "Bad Request" without a code.
			const offset = next.offsetHz ?? 0
			const limit = SAMPLE_RATE_HZ / 2 - next.bandwidth / 2
			if (Math.abs(offset) > limit)
				return reply.code(400).send({
					error: "Bad Request",
					message: `offsetHz ${offset} puts the channel outside the ${SAMPLE_RATE_HZ} Hz capture (limit ±${Math.floor(limit)} Hz)`,
				})
			live.config = next
			broadcast("live-audio", "live-audio:config", liveStatus().config)
			broadcast("live-audio", "live-audio:status", liveStatus())
			return liveStatus()
		},
	)
	app.get("/api/live-audio/presets", async () => ({
		nfm: { bandwidth: 12500, deEmphasis: false },
		wfm: { bandwidth: 150000, deEmphasis: true, deEmphasisTau: 50 },
		am: { bandwidth: 10000, deEmphasis: false },
		usb: { bandwidth: 2400, deEmphasis: false },
		lsb: { bandwidth: 2400, deEmphasis: false },
		dsb: { bandwidth: 6000, deEmphasis: false },
		cw: { bandwidth: 500, deEmphasis: false },
		raw: { bandwidth: 0, deEmphasis: false },
	}))

	const bandplans = registerBandPlansMock(app, {
		onCommit: token => broadcast("bandplans", "bandplans:changed", token),
	})

	app.post<{
		Body: {
			sourceId?: string
			target: { frequencyHz?: number; bandwidthHz?: number; all?: true }
			timeoutMs?: number
			protocols?: string[]
		}
	}>(
		"/api/scanner/identify",
		{
			schema: {
				body: {
					type: "object",
					properties: {
						sourceId: { type: "string", minLength: 1 },
						target: {
							type: "object",
							properties: {
								frequencyHz: { type: "number", exclusiveMinimum: 0 },
								bandwidthHz: {
									type: "number",
									exclusiveMinimum: 0,
									maximum: 1_000_000,
								},
								all: { type: "boolean", enum: [true] },
							},
							oneOf: [{ required: ["frequencyHz"] }, { required: ["all"] }],
							additionalProperties: false,
						},
						timeoutMs: { type: "integer", minimum: 1000, maximum: 120_000 },
						protocols: {
							type: "array",
							items: { type: "string" },
							uniqueItems: true,
						},
						exhaustive: { type: "boolean" },
						record: { type: "boolean" },
					},
					required: ["target"],
					additionalProperties: false,
				},
			},
		},
		async (request, reply) => {
			const { sourceId, target, timeoutMs, protocols } = request.body
			if (sourceId !== undefined && sourceId !== MOCK_SOURCE_ID)
				return reply.code(400).send({
					error: "WaveKitError",
					code: "SCANNER_SOURCE_NOT_FOUND",
					message: `unknown scanner source ${sourceId}`,
					correlationId: randomUUID(),
				})
			const holder = scanner.sweepHolder()
			if (holder !== null)
				return reply.code(409).send({
					error: "ScannerApiError",
					code: "SCANNER_SOURCE_BUSY",
					message: `A sweep (scanner job ${holder}) holds this source's tuner; identify works in a still window`,
					details: { reason: "held", holderJobId: holder },
				})
			// Identify of the whole window: the mock answers for the strongest signal in it.
			const centre = tuner.frequency
			const half = (SAMPLE_RATE_HZ * USABLE_FRACTION) / 2
			let hz = target.frequencyHz
			if (hz === undefined)
				hz = strongestIn(centre - half, centre + half)?.hz ?? centre
			const bw = target.bandwidthHz ?? 0
			if (Math.abs(hz - centre) + bw / 2 > half)
				return reply.code(409).send({
					error: "ScannerApiError",
					code: "OUT_OF_WINDOW",
					message: "The target is outside the tuned window; tune first",
					details: { window: { startHz: centre - half, endHz: centre + half } },
				})
			return reply
				.code(201)
				.send(
					identify(
						hz,
						target.bandwidthHz,
						timeoutMs ?? 15_000,
						(protocols ?? []) as ScannerProtocol[],
					),
				)
		},
	)
	// The Activity store lifecycle (GET /api/activity/status, the core's 503 while not open)
	const activityStore = options.activityStore
	const activityOpenAt =
		activityStore === undefined
			? startedAt
			: startedAt + (activityStore.openAfterMs ?? Number.POSITIVE_INFINITY)
	const activityLifecycle = (): ActivityLifecycleStatus => {
		const now = Date.now()
		if (activityStore === undefined || now >= activityOpenAt)
			return {
				state: "available",
				reason: null,
				attempts: activityStore?.state === "retrying" ? 2 : 1,
				nextAttemptAt: null,
				droppedWhileClosed: 0,
			}
		if (activityStore.state === "opening")
			return {
				state: "opening",
				reason: null,
				attempts: 1,
				nextAttemptAt: null,
				droppedWhileClosed: 0,
			}
		const elapsed = now - startedAt
		return {
			state: "retrying",
			reason: "ACTIVITY_OPEN_TIMEOUT",
			attempts: 1 + Math.floor(elapsed / 5_000),
			nextAttemptAt: new Date(
				startedAt + (Math.floor(elapsed / 5_000) + 1) * 5_000,
			).toISOString(),
			droppedWhileClosed: Math.floor(elapsed / 1_000),
		}
	}
	if (activityStore !== undefined)
		app.addHook("onRequest", async (request, reply) => {
			const path = request.url.split("?")[0] ?? ""
			if (path !== "/api/activity" && !path.startsWith("/api/activity/")) return
			if (path === "/api/activity/status") return
			const lifecycle = activityLifecycle()
			if (lifecycle.state === "available") return
			return reply.code(503).send({
				error: "ActivityQueryError",
				code: "ACTIVITY_UNAVAILABLE",
				message: "Activity store is not open",
				...(lifecycle.reason !== null ? { reason: lifecycle.reason } : {}),
			})
		})
	app.get("/api/activity/status", async () => {
		const lifecycle = activityLifecycle()
		const open = lifecycle.state === "available"
		return {
			enabled: true,
			stats: {
				admitted: open ? activity.length : 0,
				committed: open ? activity.length : 0,
				duplicates: 0,
				dropped: {
					"rate-limited": 0,
					"queue-full": 0,
					"store-paused": 0,
					"write-failed": 0,
					closed: 0,
				},
				excludedTelemetry: 0,
				coalescedPositions: 0,
				queueDepth: 0,
				queueBytes: 0,
				dbBytes: open ? activity.length * 1_024 : 0,
				walBytes: 0,
				rows: open ? activity.length : 0,
				oldestReceivedAt: open ? (activity[0]?.receivedAt ?? null) : null,
				pruneWatermark: activityPruned,
				paused: false,
				writer: open ? "running" : "stopped",
				lifecycle,
			},
		}
	})

	// Band inspection UX req 2.1: rate-limited Activity reads (every other one answers 429)
	let activityReads = 0
	const activity429 = options.activity429
	if (activity429 !== undefined)
		app.addHook("onRequest", async (request, reply) => {
			const path = request.url.split("?")[0] ?? ""
			const read =
				(request.method === "GET" &&
					(path === "/api/activity" || path.startsWith("/api/activity/"))) ||
				(request.method === "POST" && path === "/api/activity/facets")
			if (!read) return
			activityReads += 1
			if (activityReads % 2 === 0) return
			return reply
				.code(429)
				.header("Retry-After", activity429RetryAfter(activity429, Date.now()))
				.send({
					error: "TooManyRequests",
					code: "RATE_LIMITED",
					message: "Rate limit exceeded",
				})
		})

	app.get("/api/activity", async (request, reply) => {
		const params = (request.query ?? {}) as Record<string, unknown>
		let query: ActivityQuery
		try {
			query = queryFromParams(params)
		} catch (error) {
			const message =
				error instanceof Error ? error.message : "Invalid activity query"
			return reply.code(400).send({
				error: "ActivityQueryError",
				code: "ACTIVITY_QUERY_INVALID",
				message,
			})
		}
		const order = params["order"] ?? "desc"
		if (order !== "asc" && order !== "desc")
			return reply.code(400).send({
				error: "ActivityQueryError",
				code: "ACTIVITY_QUERY_INVALID",
				message: "order must be asc or desc",
			})
		const limit = params["limit"] === undefined ? 100 : Number(params["limit"])
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500)
			return reply.code(400).send({
				error: "ActivityQueryError",
				code: "ACTIVITY_QUERY_INVALID",
				message: "limit must be an integer from 1 to 500",
			})
		const highWater = activity[activity.length - 1]?.commitSeq ?? "0"
		let snapshotTop = Number(highWater)
		let offset = 0
		const token = params["pageToken"]
		if (token !== undefined) {
			const match =
				typeof token === "string" ? /^p:(\d+):(\d+)$/.exec(token) : null
			if (!match)
				return reply.code(400).send({
					error: "ActivityQueryError",
					code: "ACTIVITY_QUERY_INVALID",
					message: "Invalid pageToken",
				})
			offset = Number(match[1])
			snapshotTop = Number(match[2])
		}
		const matched = activity.filter(
			item =>
				Number(item.commitSeq) <= snapshotTop && matchesQuery(item, query),
		)
		if (order === "desc") matched.reverse()
		const items = matched.slice(offset, offset + limit)
		const next =
			offset + limit < matched.length
				? `p:${offset + limit}:${snapshotTop}`
				: null
		const page: ActivitySearchPage = {
			items,
			nextPageToken: next,
			replayCursor: `mock:${snapshotTop}`,
			snapshot: {
				lowBarrier: activityPruned,
				highWater: String(snapshotTop),
				expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
			},
			searchCoverage: "bounded-projection",
		}
		return page
	})

	app.post("/api/activity/facets", async (request, reply) => {
		const body = isRecord(request.body) ? request.body : {}
		let query: ActivityQuery
		try {
			query = queryFromWire(body["query"])
		} catch (error) {
			return reply.code(400).send({
				error: "ActivityQueryError",
				code: "ACTIVITY_QUERY_INVALID",
				message: error instanceof Error ? error.message : "Invalid query",
			})
		}
		const dims = Array.isArray(body["dimensions"])
			? body["dimensions"].filter(
					(
						d,
					): d is "category" | "protocol" | "decoderId" | "sourceId" | "kind" =>
						d === "category" ||
						d === "protocol" ||
						d === "decoderId" ||
						d === "sourceId" ||
						d === "kind",
				)
			: []
		const matched = activity.filter(item => matchesQuery(item, query))
		const facets: Record<string, { value: string | null; count: number }[]> = {}
		for (const dim of dims) {
			const counts = new Map<string | null, number>()
			for (const item of matched) {
				const v = item[dim]
				counts.set(v, (counts.get(v) ?? 0) + 1)
			}
			facets[dim] = [...counts]
				.map(([value, count]) => ({ value, count }))
				.sort(
					(a, b) =>
						b.count - a.count || String(a.value).localeCompare(String(b.value)),
				)
				.slice(0, 32)
		}
		const highWater = activity[activity.length - 1]?.commitSeq ?? "0"
		return {
			facets,
			scanned: matched.length,
			truncated: false,
			snapshot: { lowBarrier: activityPruned, highWater },
		}
	})

	app.get<{ Params: { eventId: string } }>(
		"/api/activity/:eventId",
		async (request, reply) => {
			const item = activity.find(i => i.eventId === request.params.eventId)
			if (!item)
				return reply.code(404).send({
					error: "NotFound",
					code: "NOT_FOUND",
					message: "Activity event not found",
				})
			return recordOf(item, decodedById.get(item.eventId))
		},
	)

	function strongestIn(startHz: number, endHz: number): MockSignal | null {
		let best: MockSignal | null = null
		for (let hz = startHz; hz <= endHz; hz += 5000) {
			const s = signalAt(hz)
			if (s && (!best || s.powerDbfs > best.powerDbfs)) best = s
		}
		return best
	}

	// --- WebSocket ---

	const handleActivity = (client: Client, msg: Record<string, unknown>) => {
		const id = msg["id"]
		const error = (code: string, message: string) =>
			send(client, {
				type: "error",
				channel: "activity",
				data:
					typeof id === "string" ? { code, message, id } : { code, message },
			})
		if (typeof id !== "string" || !ACTIVITY_ID.test(id))
			return error("ACTIVITY_QUERY_INVALID", "Invalid activity message")
		if (msg["type"] === "activity:unsubscribe") {
			client.activity.delete(id)
			send(client, {
				type: "activity:unsubscribed",
				channel: "activity",
				data: { id },
			})
			return
		}
		let query: ActivityQuery
		try {
			query = queryFromWire(msg["query"])
		} catch (e) {
			return error(
				"ACTIVITY_QUERY_INVALID",
				e instanceof Error ? e.message : "Invalid activity query",
			)
		}
		const cursor = msg["cursor"]
		client.activity.set(id, query)
		send(client, {
			type: "activity:subscribed",
			channel: "activity",
			data: { id },
		})
		const highWater = activity[activity.length - 1]?.commitSeq ?? "0"
		if (cursor === undefined) {
			send(client, {
				type: "activity:progress",
				channel: "activity",
				data: { id, scannedThrough: highWater, cursor: `mock:${highWater}` },
			})
			return
		}
		const match =
			typeof cursor === "string" ? /^mock:(\d+)$/.exec(cursor) : null
		if (!match) {
			client.activity.delete(id)
			send(client, {
				type: "activity:reset",
				channel: "activity",
				data: { id, reason: "invalid-cursor" },
			})
			return
		}
		const after = Number(match[1])
		const items = activity.filter(
			item => Number(item.commitSeq) > after && matchesQuery(item, query),
		)
		send(client, {
			type: "activity:records",
			channel: "activity",
			data: {
				id,
				items,
				scannedThrough: highWater,
				cursor: `mock:${highWater}`,
			},
		})
	}

	const handleMessage = (client: Client, raw: string) => {
		let parsed: unknown
		try {
			parsed = JSON.parse(raw)
		} catch {
			send(client, { type: "error", data: { message: "Invalid JSON" } })
			return
		}
		if (!isRecord(parsed)) {
			send(client, {
				type: "error",
				data: { message: "Invalid message format" },
			})
			return
		}
		const type = parsed["type"]
		if (type === "activity:subscribe" || type === "activity:unsubscribe") {
			handleActivity(client, parsed)
			return
		}
		const channels = Array.isArray(parsed["channels"])
			? parsed["channels"].filter(
					(c): c is string => typeof c === "string" && CHANNELS.has(c),
				)
			: []
		if (
			(type !== "subscribe" && type !== "unsubscribe") ||
			channels.length === 0
		) {
			send(client, {
				type: "error",
				data: { message: "Invalid message format" },
			})
			return
		}
		if (type === "unsubscribe") {
			for (const c of channels) {
				if (!client.channels.delete(c)) continue
				if (c === "spectrum") stopSpectrum(client)
			}
			send(client, {
				type: "unsubscribed",
				data: { channels: [...client.channels] },
			})
			return
		}
		for (const c of channels) client.channels.add(c)
		send(client, {
			type: "subscribed",
			data: { channels: [...client.channels] },
		})
		const opts = isRecord(parsed["options"]) ? parsed["options"] : {}
		for (const c of new Set(channels)) {
			if (c === "spectrum") subscribeSpectrum(client, opts["spectrum"])
			if (c === "operator-data")
				send(client, {
					type: "operator-data:snapshot",
					channel: "operator-data",
					data: operatorData.readDto(),
				})
			if (c === "bandplans")
				send(client, {
					type: "bandplans:changed",
					channel: "bandplans",
					data: bandplans.token(),
				})
		}
	}

	// @fastify/websocket's route augmentation does not reach this workspace's fastify types (pnpm
	// links it without a sibling fastify), so the websocket route is typed here.
	const wsRoutes = app as unknown as {
		get(
			path: string,
			opts: { websocket: true },
			handler: (socket: WebSocket) => void,
		): unknown
	}
	wsRoutes.get("/ws", { websocket: true }, socket => {
		const client: Client = {
			socket,
			channels: new Set(),
			spectrum: null,
			activity: new Map(),
		}
		clients.add(client)
		startTicker()
		socket.on("message", (data: Buffer | string) =>
			handleMessage(
				client,
				typeof data === "string" ? data : data.toString("utf-8"),
			),
		)
		const drop = () => {
			if (!clients.delete(client)) return
			stopSpectrum(client)
			stopTickerIfIdle()
		}
		socket.on("close", drop)
		socket.on("error", drop)
	})

	// --- Audio ---

	const audio = createAudioServer({
		sampleRate: () => (live.running ? effectiveRate() : null),
		tunedHz,
		onClient: (delta, bytes) => {
			live.clients = Math.max(0, live.clients + delta)
			live.bytes += bytes
		},
		voice: {
			sampleRate: () => (voice.running ? VOICE_RATE : null),
			talking: () => voiceCall().talking,
		},
		auto: {
			onClient: delta => {
				live.autoClients = Math.max(0, live.autoClients + delta)
			},
		},
	})

	app.addHook("onClose", async () => {
		recordings.stop()
		for (const t of timers) clearTimeout(t)
		timers.clear()
		for (const client of clients) {
			stopSpectrum(client)
			client.socket.terminate()
		}
		clients.clear()
		stopTickerIfIdle()
		if (ticker) clearInterval(ticker)
		ticker = null
		audio.closeAllConnections()
		await new Promise<void>(resolve => {
			if (!audio.listening) return resolve()
			audio.close(() => resolve())
		})
	})

	return {
		app,
		audio,
		receiver,
		scanner,
		settings,
		map,
		feed,
		async listen() {
			await new Promise<void>((resolve, reject) => {
				audio.once("error", reject)
				audio.listen(audioPort, host, () => {
					audio.off("error", reject)
					resolve()
				})
			})
			const actualAudio = (audio.address() as AddressInfo).port
			if (options.audioOrigin === undefined)
				audioOrigin = `http://localhost:${actualAudio}`
			live.config.httpPort = actualAudio
			await app.listen({ port, host })
			const actualPort = (app.server.address() as AddressInfo).port
			return {
				apiUrl: `http://${host}:${actualPort}`,
				audioUrl: audioOrigin,
				port: actualPort,
				audioPort: actualAudio,
			}
		},
		async close() {
			if (sweepTimer !== null) clearTimeout(sweepTimer)
			await app.close()
		},
	}
}

async function main(): Promise<void> {
	const env = process.env
	const port = Number(env["WAVEKIT_MOCK_PORT"] ?? 3101)
	const audioPortEnv = env["WAVEKIT_MOCK_AUDIO_PORT"]
	const audioOrigin = env["WAVEKIT_MOCK_AUDIO_ORIGIN"]
	const loadEnv = env["WAVEKIT_MOCK_LOAD"]
	const adsbEnv = env["WAVEKIT_MOCK_ADSB_RATE"]
	const spectrumBinsEnv = env["WAVEKIT_MOCK_SPECTRUM_BINS"]
	const retuneEnv = env["WAVEKIT_MOCK_RETUNE_MS"]
	const activity429Env = env["WAVEKIT_MOCK_ACTIVITY_429"]
	const activityStoreEnv = env["WAVEKIT_MOCK_ACTIVITY_STORE"]
	const activityOpenEnv = env["WAVEKIT_MOCK_ACTIVITY_OPEN_MS"]
	const resumeFailuresEnv = env["WAVEKIT_MOCK_RESUME_FAILURES"]
	const persistFailuresEnv = env["WAVEKIT_MOCK_PERSIST_FAILURES"]
	const measuredRateEnv = env["WAVEKIT_MOCK_MEASURED_RATE"]
	const server = await buildMockServer({
		host: env["WAVEKIT_MOCK_HOST"] ?? "127.0.0.1",
		port,
		...(audioPortEnv !== undefined ? { audioPort: Number(audioPortEnv) } : {}),
		...(audioOrigin !== undefined ? { audioOrigin } : {}),
		...(loadEnv !== undefined ? { load: Number(loadEnv) } : {}),
		...(adsbEnv !== undefined ? { adsbRate: Number(adsbEnv) } : {}),
		...(spectrumBinsEnv !== undefined
			? { spectrumBins: Number(spectrumBinsEnv) }
			: {}),
		...(retuneEnv !== undefined ? { retuneMs: Number(retuneEnv) } : {}),
		...(env["WAVEKIT_MOCK_BAND_FIXTURES"] === "1"
			? { bandFixtures: true }
			: {}),
		...(env["WAVEKIT_MOCK_RETUNE_SWEEP"] === "1" ? { retuneSweep: true } : {}),
		...(env["WAVEKIT_MOCK_OVERLOAD_HINT"] === "1"
			? { overloadHint: true }
			: {}),
		...(isActivity429Mode(activity429Env)
			? { activity429: activity429Env }
			: {}),
		activityFloods: env["WAVEKIT_MOCK_ACTIVITY_FLOODS"] !== "0",
		...(resumeFailuresEnv !== undefined
			? { resumeFailures: Number(resumeFailuresEnv) }
			: {}),
		...(persistFailuresEnv !== undefined
			? { persistFailures: Number(persistFailuresEnv) }
			: {}),
		...(measuredRateEnv !== undefined
			? { measuredRateHz: Number(measuredRateEnv) }
			: {}),
		...(env["WAVEKIT_MOCK_SOCKET_OMITS_FEED"] === "1"
			? { socketOmitsFeed: true }
			: {}),
		...(env["WAVEKIT_MOCK_SECOND_SOURCE"] === "1"
			? { secondSource: true }
			: {}),
		...(activityStoreEnv === "opening" || activityStoreEnv === "retrying"
			? {
					activityStore: {
						state: activityStoreEnv,
						...(activityOpenEnv !== undefined
							? { openAfterMs: Number(activityOpenEnv) }
							: {}),
					},
				}
			: {}),
	})
	const { apiUrl, audioUrl } = await server.listen()
	// WAVEKIT_MOCK_RELAY_CLIENT=1: an SDR++ client on the relay holds the tuner (Receiver lock state)
	if (env["WAVEKIT_MOCK_RELAY_CLIENT"] === "1")
		server.receiver.relayClient(true)
	process.stdout.write(
		`WaveKit mock API on ${apiUrl} (ws ${apiUrl.replace(/^http/, "ws")}/ws), audio on ${audioUrl}/stream.wav\n`,
	)
	const shutdown = () => {
		server.close().then(
			() => process.exit(0),
			() => process.exit(1),
		)
	}
	process.on("SIGINT", shutdown)
	process.on("SIGTERM", shutdown)
}

const entry = process.argv[1]
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
	main().catch((error: unknown) => {
		process.stderr.write(
			`mock server failed: ${error instanceof Error ? error.message : String(error)}\n`,
		)
		process.exit(1)
	})
}
