/**
 * WaveKit mock core: the routes and `/ws` messages the web app's slice uses, answered with the
 * canvas data (./data.ts). Legacy mode (no access bootstrap route). Run:
 *   pnpm --filter @wavekit/web mock   (node --experimental-strip-types ./mock/server.ts)
 * Listens on 127.0.0.1:3101 (WAVEKIT_MOCK_PORT) and serves synthetic audio on 3102
 * (WAVEKIT_MOCK_AUDIO_PORT). Type stripping only: no enums, parameter properties or namespaces.
 */
import type { Server } from "node:http"
import type { AddressInfo } from "node:net"
import { pathToFileURL } from "node:url"
import fastifyWebsocket from "@fastify/websocket"
import Fastify from "fastify"
import type { FastifyInstance, FastifyReply } from "fastify"
import type { WebSocket } from "ws"
import type {
	ActivityQuery,
	ActivitySearchPage,
	ActivitySummary,
	DecoderInfo,
	DiscoveryMetadata,
	ExtendedSourceStatus,
	LiveAudioConfig,
	LiveAudioLevel,
	LiveAudioStatus,
	ScanJob,
	ScannerIdentifyEventData,
	ScannerIdentifyResult,
	ScannerIdentifyTrial,
	SpectrumProfileEventData,
	TunerState,
} from "@wavekit/api-types"
import { createAudioServer } from "./audio.ts"
import {
	DECODER_SEEDS,
	DEFAULT_CENTER_HZ,
	MOCK_MESSAGES,
	MOCK_SOURCE_ID,
	MOCK_TRANSMISSIONS,
	NOISE_FLOOR_DBFS,
	SAMPLE_RATE_HZ,
	USABLE_FRACTION,
	buildDecoders,
	buildResolvedBandPlan,
	decoderInBand,
	identifyPlanFor,
	signalActive,
	signalAt,
} from "./data.ts"
import type { MockMessage, MockSignal } from "./data.ts"
import { normaliseSpectrumOptions, synthFrame } from "./spectrum.ts"

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
}

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
		const needle = q.text.toLowerCase()
		const hay = [item.title ?? "", ...item.fields.map(f => String(f.value))]
			.join(" ")
			.toLowerCase()
		if (!hay.includes(needle)) return false
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
	const messageEvery = Math.max(250, options.messageIntervalMs ?? 3000)
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
	let epoch = 1
	const decoderStats = new Map<string, number>()
	const suspendedSince = new Map<string, string>()
	const live = {
		running: false,
		clients: 0,
		bytes: 0,
		config: {
			enabled: true,
			sourceId: MOCK_SOURCE_ID,
			httpPort: audioPort,
			modulation: "nfm",
			bandwidth: 12500,
			squelch: -60,
			squelchMode: "auto",
			autoMarginDb: 6,
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
	let seq = 1000
	const jobs = new Map<string, ScanJob>()
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

	const decoders = (): DecoderInfo[] =>
		buildDecoders(
			tuner.frequency,
			startedAt,
			Date.now(),
			decoderStats,
			suspendedSince,
		)

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
		return {
			sourceId: MOCK_SOURCE_ID,
			channelPowerDbfs: Math.round(power * 10) / 10,
			noiseFloorDbfs: floor,
			squelchOpen: power > threshold,
			thresholdDbfs: threshold,
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
		}
		return status
	}

	const sourceStatus = (): ExtendedSourceStatus => {
		const now = Date.now()
		const bytes = Math.round(((now - startedAt) / 1000) * SAMPLE_RATE_HZ * 2)
		const list = decoders().filter(d => d.sourceId === MOCK_SOURCE_ID)
		return {
			id: MOCK_SOURCE_ID,
			type: "rtl_tcp",
			url: "tcp://192.168.1.40:1234",
			connected: true,
			activity: {
				state: "streaming",
				lastSampleAt: new Date(now - 12).toISOString(),
				sampleAgeMs: 12,
				timeoutMs: 5000,
			},
			consumers: list.filter(d => d.running).length + (live.running ? 1 : 0),
			bytesReceived: bytes,
			dataRate: SAMPLE_RATE_HZ * 2,
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
			signalLevelDbfs: -31.5,
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
						const fields: ActivitySummary["fields"][number][] = [
							{
								key: "duration",
								label: "Duration",
								value: tx.durationMs / 1000,
								unit: "s",
							},
						]
						if (tx.ctcssHz !== null)
							fields.push({
								key: "ctcss",
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
							protocol: null,
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
		for (const item of items.sort((a, b) => a.at - b.at))
			activity.push(item.build(Math.min(item.at, now - 1000)))
	}
	seedHistory()

	const pushActivity = (summary: ActivitySummary) => {
		activity.push(summary)
		if (activity.length > 2000) activity.splice(0, activity.length - 2000)
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
	const onTick = () => {
		tick += 1
		if (live.running) broadcast("live-audio", "live-audio:level", level())
		if (Date.now() - lastMessageAt >= messageEvery) {
			lastMessageAt = Date.now()
			emitMessage()
		}
		if (tick % 20 === 0) broadcast("sources", "source:status", sourceStatus())
	}
	const startTicker = () => {
		if (ticker) return
		lastMessageAt = Date.now()
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
		const parsed = normaliseSpectrumOptions(raw)
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
		})
		const frame = (snapshot: boolean) =>
			send(client, {
				type: "spectrum:frame",
				channel: "spectrum",
				data: synthFrame({
					sourceId: MOCK_SOURCE_ID,
					centerHz: tuner.frequency,
					bins,
					hz,
					epoch,
					nowMs: Date.now(),
					snapshot,
				}),
			})
		frame(true)
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
	): ScanJob => {
		jobCounter += 1
		const id = `j_${Date.now().toString(36).toUpperCase()}${String(jobCounter).padStart(4, "0")}`
		const now = new Date().toISOString()
		const signal = signalAt(hz)
		const plan = identifyPlanFor(signal)
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
			state: "running",
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
			startedAt: now,
			identify: {
				target:
					bandwidthHz !== undefined
						? { frequencyHz: hz, bandwidthHz }
						: { frequencyHz: hz },
				timeoutMs,
				protocols: [],
				exhaustive: false,
				record: true,
				targets: [event("waiting-for-signal", trialsAt(-1))],
			},
		}
		jobs.set(id, job)

		const update = (e: ScannerIdentifyEventData, done = false) => {
			const current = jobs.get(id)
			if (!current || current.state !== "running") return
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
		const finish = () =>
			update(event(plan.state, trialsAt(steps), resultFor()), true)
		later(80, () => {
			broadcast("scanner", "scanner:job", jobs.get(id))
			update(event("waiting-for-signal", trialsAt(-1)))
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

	const ok = () => ({
		status: "ok" as const,
		timestamp: new Date().toISOString(),
	})
	app.get("/health", async () => ok())
	app.get("/health/live", async () => ok())
	app.get("/health/ready", async () => ok())
	// GET /api/access/bootstrap is deliberately not mounted: a legacy core answers it with 404.

	app.get("/api/sources", async () => [sourceStatus()])
	app.get<{ Params: { id: string } }>(
		"/api/sources/:id",
		async (request, reply) => {
			if (request.params.id !== MOCK_SOURCE_ID)
				return reply
					.code(404)
					.send({
						error: "NotFound",
						message: `Source not found: ${request.params.id}`,
					})
			return sourceStatus()
		},
	)

	app.get("/api/decoders", async () => decoders())
	app.get<{ Params: { id: string } }>(
		"/api/decoders/:id",
		async (request, reply) => {
			const found = decoders().find(d => d.id === request.params.id)
			if (!found)
				return reply
					.code(404)
					.send({
						error: "NotFound",
						message: `Decoder not found: ${request.params.id}`,
					})
			return found
		},
	)

	const tunerNotFound = (reply: FastifyReply, sourceId: string) =>
		reply
			.code(404)
			.send({
				error: "NotFound",
				code: "TUNER_SOURCE_NOT_FOUND",
				message: `Tuner source not found: ${sourceId}`,
			})

	app.get("/api/tuner", async () => [tuner])
	app.get<{ Params: { sourceId: string } }>(
		"/api/tuner/:sourceId",
		async (request, reply) =>
			request.params.sourceId === MOCK_SOURCE_ID
				? tuner
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
			if (hz < 24_000_000 || hz > 1_766_000_000)
				return reply.code(400).send({
					error: "WaveKitError",
					code: "TUNER_FREQUENCY_OUT_OF_RANGE",
					message: `Frequency ${hz} Hz is outside the tuner range (24–1766 MHz)`,
				})
			const before = new Map(decoders().map(d => [d.id, d.suspended]))
			if (hz !== tuner.frequency) epoch += 1
			tuner.frequency = hz
			tuner.commandCount += 1
			tuner.lastCommandAt = new Date().toISOString()
			broadcast("tuner", "tuner:command-sent", {
				sourceId,
				command: "set_frequency",
				value: hz,
				origin: "rest",
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
			broadcast("sources", "source:status", sourceStatus())
			return tuner
		},
	)

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
			const bad = (message: string) =>
				reply.code(400).send({ error: "Bad Request", message })
			const body = request.body
			if (!isRecord(body)) return bad("body must be an object")
			const next: LiveAudioConfig = { ...live.config }
			const num = (
				key: string,
				min: number,
				max: number,
			): number | undefined | string => {
				const v = body[key]
				if (v === undefined) return undefined
				if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max)
					return `${key}: must be a number between ${min} and ${max}`
				return v
			}
			for (const [key, min, max] of [
				["bandwidth", 0, 250_000],
				["squelch", -150, 0],
				["autoMarginDb", 0, 40],
				["lowPass", 0, 24_000],
				["highPass", 0, 24_000],
				["gain", 0, 100],
				["offsetHz", -SAMPLE_RATE_HZ / 2, SAMPLE_RATE_HZ / 2],
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
				if (squelchMode !== "manual" && squelchMode !== "auto")
					return bad("squelchMode: invalid value")
				next.squelchMode = squelchMode
			}
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
			const format = body["audioFormat"]
			if (format !== undefined) {
				if (format !== "s16le" && format !== "f32le")
					return bad("audioFormat: invalid value")
				next.audioFormat = format
			}
			if (body["sourceId"] !== undefined && body["sourceId"] !== MOCK_SOURCE_ID)
				return bad("sourceId: unknown source")
			const offset = next.offsetHz ?? 0
			if (Math.abs(offset) + next.bandwidth / 2 > SAMPLE_RATE_HZ / 2)
				return bad(
					`Channel offset ${offset} Hz is outside the capture window of ±${SAMPLE_RATE_HZ / 2} Hz`,
				)
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

	const resolved = buildResolvedBandPlan()
	app.get("/api/bandplans/resolved", async () => resolved)

	app.post<{
		Body: {
			sourceId?: string
			target: { frequencyHz?: number; bandwidthHz?: number; all?: true }
			timeoutMs?: number
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
			const { sourceId, target, timeoutMs } = request.body
			if (sourceId !== undefined && sourceId !== MOCK_SOURCE_ID)
				return reply
					.code(404)
					.send({
						error: "ScannerApiError",
						code: "SOURCE_NOT_FOUND",
						message: `Unknown source ${sourceId}`,
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
				.send(identify(hz, target.bandwidthHz, timeoutMs ?? 15_000))
		},
	)
	app.get<{ Params: { id: string } }>(
		"/api/scanner/jobs/:id",
		async (request, reply) => {
			const job = jobs.get(request.params.id)
			if (!job)
				return reply
					.code(404)
					.send({
						error: "ScannerApiError",
						code: "JOB_NOT_FOUND",
						message: "Job not found",
					})
			return job
		},
	)

	app.get("/api/activity", async (request, reply) => {
		const params = (request.query ?? {}) as Record<string, unknown>
		let query: ActivityQuery
		try {
			query = queryFromParams(params)
		} catch (error) {
			const message =
				error instanceof Error ? error.message : "Invalid activity query"
			return reply
				.code(400)
				.send({
					error: "ActivityQueryError",
					code: "ACTIVITY_QUERY_INVALID",
					message,
				})
		}
		const order = params["order"] ?? "desc"
		if (order !== "asc" && order !== "desc")
			return reply
				.code(400)
				.send({
					error: "ActivityQueryError",
					code: "ACTIVITY_QUERY_INVALID",
					message: "order must be asc or desc",
				})
		const limit = params["limit"] === undefined ? 100 : Number(params["limit"])
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500)
			return reply
				.code(400)
				.send({
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
				return reply
					.code(400)
					.send({
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
				lowBarrier: activity[0]?.commitSeq ?? "0",
				highWater: String(snapshotTop),
				expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
			},
			searchCoverage: "bounded-projection",
		}
		return page
	})

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
		for (const c of channels) if (c !== "operator-data") client.channels.add(c)
		send(client, {
			type: "subscribed",
			data: { channels: [...client.channels] },
		})
		const opts = isRecord(parsed["options"]) ? parsed["options"] : {}
		for (const c of new Set(channels)) {
			if (c === "spectrum") subscribeSpectrum(client, opts["spectrum"])
			if (c === "bandplans")
				send(client, {
					type: "bandplans:changed",
					channel: "bandplans",
					data: { storeId: null, revision: 0 },
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
	})

	app.addHook("onClose", async () => {
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
			await app.close()
		},
	}
}

async function main(): Promise<void> {
	const env = process.env
	const port = Number(env["WAVEKIT_MOCK_PORT"] ?? 3101)
	const audioPortEnv = env["WAVEKIT_MOCK_AUDIO_PORT"]
	const audioOrigin = env["WAVEKIT_MOCK_AUDIO_ORIGIN"]
	const server = await buildMockServer({
		host: env["WAVEKIT_MOCK_HOST"] ?? "127.0.0.1",
		port,
		...(audioPortEnv !== undefined ? { audioPort: Number(audioPortEnv) } : {}),
		...(audioOrigin !== undefined ? { audioOrigin } : {}),
	})
	const { apiUrl, audioUrl } = await server.listen()
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
