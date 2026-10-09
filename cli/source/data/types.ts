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

/**
 * Health as the CLI reads it (R70): core's values, or "unknown" for any other
 * string, so a row is never dropped for a new value.
 */
export type RowHealth = DecoderHealth | "unknown"

/**
 * Core's DecoderSuspension with the code widened to string: a code newer than
 * this CLI keeps the row suspended and is shown quoted.
 */
export interface DecoderSuspension {
	/** A DecoderSuspensionReasonCode, or a newer code shown quoted. */
	reasonCode: string
	/** ISO-8601. */
	since: string
}

/**
 * Core's DecoderBandAssessment, guarded (R84): a newer verdict reads "unknown";
 * a newer reasonCode or basis is kept as text and shown quoted.
 */
export interface BandAssessment {
	verdict: "in-band" | "out-of-band" | "unknown"
	reasonCode?: string
	/** All or nothing: positive Hz. */
	targetsHz?: number[]
	/** R100: all or nothing like targets; every range finite with minHz <= maxHz. */
	rangesHz?: BandRange[]
	/** "configured" | "protocol" | "decoder-default" | "region-default" | "override", or a newer basis. */
	basis?: string
	/** R100: the band plan region and where it came from, kept as text. */
	region?: { code: string; source: string }
	/** R100: "config" | "api" when basis is "override", or a newer layer shown quoted. */
	overrideSource?: string
	captureCenterHz?: number
	windowHalfWidthHz?: number
}

/** An absolute RF interval in Hz (R100). */
export interface BandRange {
	minHz: number
	maxHz: number
}

/** Core's health and suspension fields (R70, R84), guarded; optional for older cores. */
export interface DecoderContractFields {
	/** ISO-8601, present while an automatic restart is scheduled. */
	nextRestartAt?: string
	desiredRunning?: boolean
	suspended?: boolean
	suspension?: DecoderSuspension
	transition?: "suspending" | "resuming" | "unknown"
	/** When present, the truth for window membership (R84); older cores send none. */
	bandAssessment?: BandAssessment
	/**
	 * R100: "auto" | "operator" (pinned against band suspension), or a newer
	 * mode kept as text and shown quoted. Its presence anywhere says this core pins.
	 */
	startMode?: string
}

/**
 * rateAssessment is omitted: the CLI prints no verdicts (spec §2, R13). The
 * contract fields are replaced by their guarded, widened forms.
 */
export type DecoderRow = Omit<
	DecoderStatus,
	"rateAssessment" | "health" | keyof DecoderContractFields
> &
	DecoderContractFields & {
		health: RowHealth
		caps?: DecoderCaps
	}

/**
 * A guarded source. `activityUnrecognised` is set when a (newer) core sent
 * `activity` that is malformed or has an unknown state: the IQ lane is then
 * unknown. Absent `activity` (older core) leaves it unset.
 */
export type SourceRow = ExtendedSourceStatus & { activityUnrecognised?: true }

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
	sources: SourceRow[]
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
	| { type: "decoder:health"; decoderId: string; health: RowHealth }
	/** One GET /api/decoders/:id body; several per transition, apply the latest. */
	| { type: "decoder:status"; decoder: DecoderRow }
	/** One GET /api/sources item incl. activity; apply the latest per id. */
	| { type: "source:status"; source: SourceRow }
	| { type: "source:connected"; sourceId: string }
	| { type: "source:disconnected"; sourceId: string; error?: string }
	| { type: "source:error"; sourceId: string; error: string }
	| { type: "source:caps-changed"; sourceId: string; caps: SourceCaps }
	/** A11 (R95): the source is gone; drop its row, tuner and metrics. */
	| { type: "source:removed"; sourceId: string }
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

/** `unpin`: POST …/start with `{ "pin": false }`, back to auto mode (R100). */
export type DecoderOp = "start" | "stop" | "restart" | "unpin"
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

/** What an action is keyed by; every WriteIntent is one. */
export type ActionTarget =
	| { kind: "decoder"; decoderId: string }
	| { kind: "tuner"; sourceId: string }
	| { kind: "audio" }
	| { kind: "preset" }

/** The one place action keys are built (R47 M13). */
export function actionKey(target: ActionTarget): string {
	switch (target.kind) {
		case "decoder":
			return `decoder:${target.decoderId}`
		case "tuner":
			return `tuner:${target.sourceId}`
		case "audio":
			return "audio"
		case "preset":
			return "preset"
	}
}

/**
 * "unknown": the write was sent but no reply arrived in time (R23); it is not a
 * failure and is reconciled by an event: decoder:started / stopped / status for
 * decoders, live-audio:started / stopped for audio, live-audio:config for presets
 * and tuner:command-sent for tuner commands.
 */
export type ActionOutcome = "ok" | "failed" | "unknown"
export interface ActionResult {
	/** Read `outcome`; `ok` is true only when outcome is "ok". */
	ok: boolean
	outcome: ActionOutcome
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
/**
 * - sent: the request is in flight.
 * - unknown: no reply in time or the connection reset (R23); waiting for a reconciling event.
 * - no-reply: terminal; nothing reconciled the unknown write within NO_REPLY_MS (R47 M5).
 * - ok / failed: terminal.
 */
export type ActionState = "sent" | "unknown" | "no-reply" | "ok" | "failed"
export interface ActionRecord {
	/** Per-send id: a result applies only to the send it answers (R47 M6). */
	id: number
	key: string
	intent: WriteIntent
	sentAt: number
	state: ActionState
	outcomes: CommandOutcome[]
	/** When the action:result arrived. */
	resultAt: number | null
	doneAt: number | null
	/** A reconciling event (decoder:started / stopped / status, live-audio:*) observed after the send. */
	confirmedAt: number | null
	/** A restart saw the decoder not running after the send (R47 M4). */
	sawNotRunning: boolean
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
	/**
	 * Server time (ms) of the newest decoder:output, from its `timestamp`; compare with
	 * other server times, never with the local clock (a server ahead must read "<1s").
	 */
	lastWsOutputAt: number | null
	lastError: { message: string; at: number } | null
	previousHealth: RowHealth | null
	/** eventsOut samples, trailing 60 s (decode rate). */
	events: CounterSample[]
	/** restartCount samples, trailing 5 min (crash-loop). */
	restarts: CounterSample[]
	/** minute index (floor(t/60000)) → decodes observed in that minute. */
	spark: Record<string, number>
	/** The last eventsOut sample the sparkline counted from; unlike `events`, kept across ws:open (R47 M12). */
	sparkPrev?: CounterSample
	firstObservedAt: number
	/** Local time the row was first seen with transition "suspending" (R70 M-b); absent otherwise. */
	suspendingSince?: number
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
	/** Endpoints to fetch after this commit (writes, events). */
	polls: Endpoint[]
	/**
	 * The full POLL+RESYNC set a ws:open asks for. The runtime skips endpoints its own
	 * resync already has in flight or answered OK (R55), so one reconnect is one set.
	 */
	resync?: Endpoint[]
}

export interface AppState {
	conn: ConnState
	sources: Lane<SourceRow[]>
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
		/** Set by the runtime for an answer a user waits on (final M2): the lane's first, or a poll after a write. */
		urgent?: true
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
export interface ActionSentInbound {
	kind: "action:sent"
	at: number
	id: number
	key: string
	intent: WriteIntent
}
export interface ActionResultInbound {
	kind: "action:result"
	at: number
	id: number
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
	| ActionSentInbound
	| ActionResultInbound

// ---------- derived evidence shared by data/ and ui/ ----------

/** "attention" (`!`, yellow): needs a look now but is not a fault, e.g. a decoder restarting (R31). */
export type GlyphRole = "live" | "neutral" | "attention" | "fault" | "unknown"

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
	/** A11: streaming, but core flags the signal flat at this level (dBFS); absent otherwise. */
	flatDbfs?: number
}
