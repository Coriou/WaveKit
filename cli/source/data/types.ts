import type {
	AircraftState,
	AircraftTrackerStats,
	DecoderCaps,
	DecoderHealth,
	DecoderOutput,
	DecoderStatus,
	ExtendedSourceStatus,
	FanoutSnapshot,
	LiveAudioConfig,
	LiveAudioStatus,
	ResourceAlert,
	ResourceSnapshot,
	SdrHostSampling,
	SdrHostStatus,
	SourceCaps,
	TunerControlMode,
	TunerRelayStatus,
	TunerState,
} from "@wavekit/api-types"

// ---------- DTO views (what guards produce) ----------

export type DecoderRow = DecoderStatus & { caps?: DecoderCaps }

export interface CoreComponent {
	name: string
	status: string
	message?: string
}

export interface CoreStatus {
	status: string
	uptime: number
	version: string
	components: CoreComponent[]
}

export interface AudioPreset {
	bandwidth: number
	deEmphasis?: boolean
	deEmphasisTau?: 50 | 75
}
export type PresetMap = Record<string, AudioPreset>

export interface AircraftSnapshot {
	aircraft: AircraftState[]
	stats: AircraftTrackerStats
	timestamp: number
}

/** SdrHostStatus plus the optional Pi sampling slot (request 6), validated by readHostSampling. */
export type SdrHostView = SdrHostStatus & { sampling?: SdrHostSampling }
export interface ResourceView extends Omit<ResourceSnapshot, "sdrHosts"> {
	sdrHosts: SdrHostView[]
}

// ---------- endpoints ----------

export type Endpoint =
	| "decoders"
	| "sources"
	| "tuner"
	| "relay"
	| "fanout"
	| "resources"
	| "audio"
	| "status"
	| "presets"
	| "aircraft"

export const ENDPOINT_PATHS: Readonly<Record<Endpoint, string>> = {
	decoders: "/api/decoders",
	sources: "/api/sources",
	tuner: "/api/tuner",
	relay: "/api/tuner-relay",
	fanout: "/api/telemetry/fanout",
	resources: "/api/resources",
	audio: "/api/live-audio/status",
	status: "/api/status",
	presets: "/api/live-audio/presets",
	aircraft: "/api/aircraft",
}

/** Polled every 5 s (spec §10.2). */
export const POLL_ENDPOINTS: readonly Endpoint[] = [
	"decoders",
	"sources",
	"tuner",
	"relay",
	"fanout",
	"resources",
	"audio",
	"status",
]
/** Fetched at start and after every reconnect. */
export const RESYNC_ENDPOINTS: readonly Endpoint[] = ["presets", "aircraft"]

export interface RestValues {
	decoders: DecoderRow[]
	sources: ExtendedSourceStatus[]
	tuner: TunerState[]
	relay: TunerRelayStatus
	fanout: FanoutSnapshot
	resources: ResourceView
	audio: LiveAudioStatus
	status: CoreStatus
	presets: PresetMap
	aircraft: AircraftSnapshot
}

// ---------- lanes ----------

export type LaneErrorKind = "timeout" | "network" | "http" | "invalid"
export interface LaneError {
	kind: LaneErrorKind
	status?: number
	message: string
	at: number
}
export type LaneOrigin = "rest" | "ws"
export interface Lane<T> {
	value: T | undefined
	receivedAt: number | null
	origin: LaneOrigin
	error?: LaneError
}

export type FetchOutcome<T> =
	| { ok: true; value: T; rejected: number }
	| { ok: false; error: LaneError }

// ---------- WS events (output of parseServerMessage) ----------

// Union members too long for one line are named, because prettier's
// tab-plus-space alignment of multi-line union members fails
// no-mixed-spaces-and-tabs.
export interface WsMetricsEvent {
	type: "metrics"
	sourceId: string
	bytesReceived: number
	dataRate: number
}
export interface WsBackpressureEvent {
	type: "fanout:backpressure"
	branchId: string
	bufferedBytes: number
	timestamp: string
}
export interface WsDrainEvent {
	type: "fanout:drain"
	branchId: string
	durationMs: number
	timestamp: string
}
export interface WsCommandSentEvent {
	type: "tuner:command-sent"
	sourceId: string
	command: string
	value: unknown
}
export interface WsControlModeEvent {
	type: "tuner:control-mode-changed"
	sourceId: string
	mode: TunerControlMode
}

export type WsEvent =
	| { type: "subscribed"; channels: string[] }
	| { type: "unsubscribed"; channels: string[] }
	| { type: "server-error"; message: string }
	| { type: "decoder:output"; decoderId: string; output: DecoderOutput }
	| { type: "decoder:started"; decoderId: string }
	| { type: "decoder:stopped"; decoderId: string }
	| { type: "decoder:error"; decoderId: string; error: string }
	| { type: "decoder:health"; decoderId: string; health: DecoderHealth }
	| { type: "source:connected"; sourceId: string }
	| { type: "source:disconnected"; sourceId: string; error?: string }
	| { type: "source:error"; sourceId: string; error: string }
	| { type: "source:caps-changed"; sourceId: string; caps: SourceCaps }
	| WsMetricsEvent
	| { type: "fanout:snapshot"; snapshot: FanoutSnapshot }
	| WsBackpressureEvent
	| WsDrainEvent
	| { type: "live-audio:status"; status: LiveAudioStatus }
	| { type: "live-audio:config"; config: LiveAudioConfig }
	| { type: "live-audio:started" }
	| { type: "live-audio:stopped" }
	| { type: "live-audio:error"; message: string }
	| { type: "resources:snapshot"; snapshot: ResourceView }
	| { type: "resources:alert"; alert: ResourceAlert }
	| { type: "tuner:state-changed"; sourceId: string; state: TunerState }
	| WsCommandSentEvent
	| WsControlModeEvent
	| { type: "tuner:error"; sourceId: string; error: string }
	| { type: "aircraft:new"; aircraft: AircraftState }
	| { type: "aircraft:update"; aircraft: AircraftState }
	| { type: "aircraft:lost"; icao: string }
	| { type: "aircraft:stats"; stats: AircraftTrackerStats }

// ---------- writes ----------

export type DecoderOp = "start" | "stop" | "restart"
export type TunerSetting =
	| "frequency"
	| "gain"
	| "gain-mode"
	| "sample-rate"
	| "ppm"
	| "agc"
	| "bias-tee"
	| "offset-tuning"
	| "direct-sampling"
	| "tuner-gain-index"
	| "control-mode"
export interface TunerCommand {
	setting: TunerSetting
	body: Record<string, number | boolean | string>
	/** Field name shown in result lines, e.g. "frequency". */
	label: string
}
export type WriteIntent =
	| { kind: "decoder"; op: DecoderOp; decoderId: string }
	| { kind: "tuner"; sourceId: string; commands: TunerCommand[] }
	| { kind: "audio"; op: "start" | "stop" }
	| { kind: "preset"; name: string; patch: Partial<LiveAudioConfig> }

export function actionKey(intent: WriteIntent): string {
	switch (intent.kind) {
		case "decoder":
			return `decoder:${intent.decoderId}`
		case "tuner":
			return `tuner:${intent.sourceId}`
		case "audio":
			return "audio"
		case "preset":
			return "preset"
	}
}

export interface ActionResult {
	ok: boolean
	status: number | null
	code?: string
	message: string
}
export interface CommandOutcome {
	label: string
	/** null = not sent (an earlier command failed). */
	result: ActionResult | null
	at: number | null
}
export interface ActionRecord {
	key: string
	intent: WriteIntent
	sentAt: number
	state: "sent" | "ok" | "failed"
	outcomes: CommandOutcome[]
	doneAt: number | null
	/** decoder:started / decoder:stopped observed after the send. */
	confirmedAt: number | null
}

// ---------- messages ----------

export interface MessageSegment {
	text: string
	/** 0 = most important; dropped last by fitGroups. */
	priority: number
	role?: "value" | "attention" | "label"
}
export type MessageCategory = "aircraft" | "voice" | "pager" | "data" | "other"
export interface FormattedMessage {
	/** Type column, e.g. "DMR", "POCSAG", "ADS-B". */
	protocol: string
	category: MessageCategory
	segments: MessageSegment[]
	/** Free text body (pager text, ACARS text); cut at the row end, never dropped. */
	text?: string
	fields: Array<{ label: string; value: string; attention?: boolean }>
	emergency: boolean
	/** Lower-case, sanitised, bounded text used by the filter. */
	searchText: string
}
export interface MessageEntry {
	seq: number
	decoderId: string
	type: string
	receivedAt: number
	output: DecoderOutput
	formatted: FormattedMessage
}
export interface Gap {
	afterSeq: number
	from: number
	to: number | null
}
export interface MessageRing {
	capacity: number
	floor: number
	/** Oldest → newest. Mutated in place by ring-buffer.ts. */
	entries: MessageEntry[]
	gaps: Gap[]
	nextSeq: number
	perDecoder: Record<string, number>
	/** Messages ever ingested this session. */
	total: number
}
export type AircraftLookup = (icao: string) => AircraftState | undefined

// ---------- histories ----------

export interface CounterSample {
	t: number
	v: number
}
export interface FanoutBranchSample {
	decoderId?: string
	offered?: number
	dropped: number
	backpressure: boolean
}
export interface FanoutSample {
	/** Server timestamp (ms) of the snapshot. */
	t: number
	branches: Record<string, FanoutBranchSample>
}
export interface DecoderSession {
	lastWsOutputAt: number | null
	lastError: { message: string; at: number } | null
	previousHealth: DecoderHealth | null
	/** eventsOut samples, trailing 60 s (decode rate). */
	events: CounterSample[]
	/** restartCount samples, trailing 5 min (crash-loop). */
	restarts: CounterSample[]
	/** minute index (floor(t/60000)) → decodes observed in that minute. */
	spark: Record<string, number>
	firstObservedAt: number
}
export interface MetricBeat {
	bytesReceived: number
	/** KiB/s as reported by core. */
	dataRateKiB: number
	at: number
}
export interface BranchTransition {
	active: boolean
	at: number
	bufferedBytes?: number
}
export interface AlertEntry {
	key: string
	alert: ResourceAlert
	count: number
	firstAt: number
	lastAt: number
}
export interface AircraftEntry {
	state: AircraftState
	/** Local receipt time, used for the 300 s prune. */
	at: number
}

// ---------- connection ----------

export interface DiscoveryState {
	mode: "explicit" | "probing" | "found" | "failed"
	tried: string[]
}
export interface ConnState {
	target: { base: string | null; ws: string | null }
	discovery: DiscoveryState
	ws: {
		state: "idle" | "connecting" | "open" | "closed"
		since: number | null
		code: number | null
		reason: string | null
		nextRetryAt: number | null
		attempt: number
	}
	rest: {
		/** Last time any polled endpoint answered OK. */
		lastOkAt: number | null
		lastCycleAt: number | null
		nextAt: number | null
		failing: Endpoint[]
		firstFailAt: number | null
		lastError: LaneError | null
	}
	invalidFrames: number
	rejectedItems: number
	lastEventAt: number | null
}

export interface Effects {
	polls: Endpoint[]
}

export interface AppState {
	conn: ConnState
	sources: Lane<ExtendedSourceStatus[]>
	metrics: Record<string, MetricBeat>
	decoders: Lane<DecoderRow[]>
	session: Record<string, DecoderSession>
	tuner: Lane<TunerState[]>
	tunerLastCommand: Record<
		string,
		{ command: string; value: unknown; at: number }
	>
	relay: Lane<TunerRelayStatus>
	fanout: Lane<FanoutSnapshot>
	fanoutHistory: FanoutSample[]
	branchEvents: Record<string, BranchTransition>
	resources: Lane<ResourceView>
	alerts: AlertEntry[]
	audio: Lane<LiveAudioStatus>
	presets: Lane<PresetMap>
	status: Lane<CoreStatus>
	messages: { version: number; ring: MessageRing }
	aircraft: {
		version: number
		map: Map<string, AircraftEntry>
		stats: Lane<AircraftTrackerStats>
	}
	actions: { byKey: Record<string, ActionRecord>; stoppedByCli: string[] }
	effects: Effects
	now: number
}

// ---------- inbound ----------

export type RestInbound = {
	[E in Endpoint]: {
		kind: "rest"
		endpoint: E
		outcome: FetchOutcome<RestValues[E]>
		at: number
	}
}[Endpoint]

export interface WsCloseInbound {
	kind: "ws:close"
	at: number
	code: number
	reason: string
	nextRetryAt: number | null
}
export interface TargetInbound {
	kind: "target"
	at: number
	base: string | null
	ws: string | null
	discovery: DiscoveryState
}
export interface ActionResultInbound {
	kind: "action:result"
	at: number
	key: string
	outcomes: CommandOutcome[]
}

export type Inbound =
	| RestInbound
	| { kind: "rest:cycle"; at: number; nextAt: number }
	| { kind: "ws"; event: WsEvent; at: number }
	| { kind: "ws:connecting"; at: number; attempt: number }
	| { kind: "ws:open"; at: number }
	| WsCloseInbound
	| { kind: "ws:invalid"; at: number }
	| TargetInbound
	| { kind: "action:sent"; at: number; key: string; intent: WriteIntent }
	| ActionResultInbound

// ---------- derived evidence shared by data/ and ui/ ----------

export type GlyphRole = "live" | "neutral" | "fault" | "unknown"

export type ApiView =
	| { kind: "connecting" }
	| { kind: "ok"; restAgeMs: number }
	| { kind: "split"; ws: boolean; rest: boolean; restAgeMs: number | null }
	| { kind: "down"; sinceMs: number | null }

export interface IqView {
	glyph: GlyphRole
	/** "streaming", "connected · no samples", "no samples", "paused", "ended", "disconnected", "connected", "receiving", "unknown", or "<n>/<m> streaming". */
	word: string
	/** For "no samples": server-relative sample age. */
	ageMs: number | null
	rateBytesPerSec: number | null
}
