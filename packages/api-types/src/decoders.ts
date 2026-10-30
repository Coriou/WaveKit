import { z } from "zod"
import type {
	EfficiencyBudgetResolution,
	EfficiencyBudgetSettings,
	EfficiencyBudgetValue,
} from "./efficiency-budget.js"
import type { DropAttribution } from "./resources.js"

export interface DecoderStats {
	bytesIn: number
	eventsOut: number
	errors: number
}

/**
 * - running: running (or stopped by the operator; see `running`)
 * - idle: running without output for `idleTimeoutMs`
 * - restarting: exited unexpectedly; an automatic restart is scheduled at `nextRestartAt`
 * - faulted: crash loop (consecutive unstable runs) or restart budget exhausted.
 *   `running: true` = a crash-loop retry on probation (returns to "running"
 *   once it produces output or stays up 30 s); `nextRestartAt` set = waiting
 *   for the next retry; `!running && !nextRestartAt` = terminal until an
 *   explicit start/restart.
 */
export type DecoderHealth = "running" | "idle" | "restarting" | "faulted"

export type DecoderInputType = "audio_pcm" | "iq" | "external"

export type DecoderOutputFormat = "jsonl" | "nmea" | "beast" | "text"

export type DecoderIntegrationPattern =
	| "pure_consumer"
	| "network_producer"
	| "external_sdr"

/** Rates in Hz in one explicitly named domain, never inferred from legacy preferences. */
export type DecoderRateSet =
	| { kind: "discrete"; valuesHz: number[] }
	| { kind: "range"; minHz: number; maxHz?: number; stepHz?: number }

/** Instance requirements; capture rates and program stdin rates are distinct. */
export interface DecoderRateRequirements {
	version: 1
	sourceKind: DecoderInputType
	capture?: {
		accepted: DecoderRateSet[]
		preferredHz: number[]
		minimum?: {
			hz: number
			basis: "implementation" | "verified-rf"
			evidence: string
		}
	}
	frontendIq?: { preferredHz: number; accepted: DecoderRateSet[] }
	decoderInput: {
		kind: DecoderInputType
		format?: string
		preferredHz?: number
		accepted?: DecoderRateSet[]
	}
}

/** Reporting only: this verdict does not start, stop, or suspend a decoder. */
export interface DecoderRateAssessment {
	verdict: "best" | "acceptable" | "unusable" | "unknown"
	sourceKind?: DecoderInputType
	sourceRateHz?: number
	frontendRateHz?: number
	decoderInputKind?: DecoderInputType
	decoderInputRateHz?: number
	adaptation?: "none" | "integer-decimation" | "resample"
	reasonCode?:
		| "insufficient-sample-rate"
		| "unsupported-sample-rate"
		| "unsupported-input-kind"
		| "unsupported-input-format"
		| "unsupported-frontend-rate"
		| "unsupported-decoder-input-rate"
		| "unknown-requirements"
		| "source-rate-unknown"
		| "adaptation-unknown"
		| "external-input"
	requiredMinimumHz?: number
	requirementBasis?: "implementation" | "verified-rf"
}

/**
 * Where an instance wants to receive:
 * "configured" from config, "protocol" fixed by the protocol (ADS-B 1090 MHz,
 * AIS 161.975/162.025 MHz), "decoder-default" a built-in list the process is
 * actually told to decode (or its own option default, e.g. the Meshtastic
 * region of a followCenter LoRa decoder), "region-default" the built-in band
 * table for the decoder type (and region), "override" an operator band
 * override (`decoders[].band` or `PUT /api/decoders/:id/band`).
 * New members may be added; treat unknown values as opaque.
 */
export type DecoderBandBasis =
	| "configured"
	| "protocol"
	| "decoder-default"
	| "region-default"
	| "override"

/** Absolute RF interval in Hz, `minHz <= maxHz`. */
export interface DecoderBandRange {
	minHz: number
	maxHz: number
}

/**
 * Band plan region codes. They name band plans, not polities: `EU` is
 * CEPT / IARU Region 1 (includes the UK, Switzerland, Norway).
 */
export type BandRegion = "EU" | "US" | "CA" | "AU" | "NZ" | "JP" | "CN"

/** Where the effective band region came from. */
export type BandRegionSource =
	| "configured"
	| "decoder"
	| "guessed:tz"
	| "guessed:intl-timezone"
	| "guessed:locale-env"
	| "guessed:intl-locale"
	| "default"

export interface DecoderBandRegion {
	code: BandRegion
	source: BandRegionSource
}

/** Operator band override (config `decoders[].band` or the API layer). */
export interface DecoderBandOverride {
	rangesHz?: DecoderBandRange[]
	targetsHz?: number[]
	region?: BandRegion
	/** false: never band-suspend this decoder (the durable form of a pin). */
	bandSuspension?: boolean
}

/** GET/PUT/DELETE /api/decoders/:id/band response. */
export interface DecoderBandSettings {
	decoderId: string
	/** API layer (persisted by core); null when none is set. */
	override: DecoderBandOverride | null
	/** Config layer (`decoders[].band`); null when none is set. */
	configOverride: DecoderBandOverride | null
	/** Effective region for this decoder. */
	region: DecoderBandRegion
	/** false while the API layer lives only in memory (state file not writable). */
	persisted: boolean
	bandAssessment: DecoderBandAssessment
}

/**
 * Who started a wanted decoder: "auto" at boot (or `{ pin: false }`),
 * "operator" via `POST /api/decoders/:id/start`. An operator decoder is
 * never band-suspended; a rate suspension still applies.
 */
export type DecoderStartMode = "auto" | "operator"

/**
 * Whether the source centre lets this instance receive any of its targets:
 * in band when some target lies within `windowHalfWidthHz` of
 * `captureCenterHz`, or the centre lies within `windowHalfWidthHz` of some
 * range in `rangesHz`. The window is the RF span the pipeline actually sees
 * (capture, or the narrower demodulator frontend), times a usable fraction
 * of 0.8 for filter margin. `unknown` is never out of band.
 */
export interface DecoderBandAssessment {
	verdict: "in-band" | "out-of-band" | "unknown"
	reasonCode?:
		| "frequency-out-of-band"
		| "no-target-frequency"
		| "source-center-unknown"
		| "external-input"
	targetsHz?: number[]
	rangesHz?: DecoderBandRange[]
	basis?: DecoderBandBasis
	/** Present when a region-dependent default produced the band. */
	region?: DecoderBandRegion
	/** Present when basis is "override": which layer supplied the band. */
	overrideSource?: "config" | "api"
	captureCenterHz?: number
	windowHalfWidthHz?: number
}

/**
 * Rate reasons, the tuned band no longer covering any target, or the
 * source held by a scanner sweep (signal discovery spec § 10.4).
 */
export type DecoderSuspensionReasonCode =
	| NonNullable<DecoderRateAssessment["reasonCode"]>
	| "frequency-out-of-band"
	| "capture-too-narrow"
	| "no-channel-selected"
	| "tuner-scanning"
	| "efficiency-budget"
	| "decoder-unavailable"
	| "channelizer-unavailable"

export interface DecoderCaps {
	input: DecoderInputType
	wantsExclusiveSource?: boolean
	preferredSampleRates?: number[]
	/** Optional declarations; absence means unknown, never incompatible. */
	rateRequirements?: DecoderRateRequirements
	output: DecoderOutputFormat
	integrationPattern: DecoderIntegrationPattern
}

/** Upper bound on `DecoderLastError.message`, in UTF-16 code units. */
export const DECODER_LAST_ERROR_MAX_LENGTH = 512

/**
 * Most recent decoder failure. Retained across automatic restarts so a crash
 * loop keeps its cause visible; cleared only by an explicit start/restart
 * (the same moment `restartCount` resets to 0). An "error" recorded during a
 * run is not replaced by the generic "exit" that ends that run.
 */
export interface DecoderLastError {
	/** "error": the decoder emitted an error (spawn failure, socket error, failed start). "exit": the process exited without being asked to stop. */
	kind: "error" | "exit"
	/** Human-readable message, truncated to DECODER_LAST_ERROR_MAX_LENGTH with a trailing "…". */
	message: string
	/** ISO-8601 time the failure was recorded. */
	at: string
}

/** Raw stdout/stderr output, capped to 4096 UTF-16 code units per line. */
export interface DecoderLogLine {
	stream: "stdout" | "stderr"
	line: string
}

export interface DecoderLog {
	decoderId: string
	lines: DecoderLogLine[]
}

export interface DecoderStatus {
	mode?: DecoderMode
	modeSource?: DecoderModeSource
	origin?: "config" | "catalogue"
	placements?: DecoderPlacementView[]
	efficiency?: { detail: DecoderEfficiencyDetail; retryAt?: string }
	/** Messages per wall-clock minute, oldest first, last 15 including the current partial minute. */
	rateHistory?: number[]
	id: string
	type: string
	running: boolean
	health: DecoderHealth
	pid?: number
	uptime: number
	stats: DecoderStats
	lastOutputAt?: string | null
	restartCount: number
	version?: string
	rateAssessment?: DecoderRateAssessment
	/** Band check against the source centre; always sent by current cores. */
	bandAssessment?: DecoderBandAssessment
	/**
	 * WaveKit source this decoder reads: the live assignment while wired,
	 * otherwise the configured `sourceId`. Absent for external-input decoders
	 * (they own their device) and for unwired decoders that use the default source.
	 */
	sourceId?: string
	/** Configured device serial of an external-input decoder; never inferred. */
	deviceSerial?: string
	/** Configured target frequencies in Hz; absent when the config declares none. */
	targetFrequenciesHz?: number[]
	/** Most recent failure; see DecoderLastError for retention semantics. */
	lastError?: DecoderLastError
	/** Effective ms without output before `health` becomes "idle". */
	idleTimeoutMs?: number
	/** ISO-8601 time of the scheduled automatic restart; present only while one is pending. */
	nextRestartAt?: string
	/** Operator intent: true after start/restart, false after stop. Always sent by current cores. */
	desiredRunning?: boolean
	/**
	 * Wanted but held back because the source rate makes this instance
	 * unusable, or the tuned band covers none of its targets. The source reservation and `sourceId` are kept; no lastError,
	 * no health change, no restart counted. Always sent by current cores.
	 */
	suspended?: boolean
	/** Present only while suspended. */
	suspension?: DecoderSuspension
	/**
	 * Present only during a transition. A lasting "suspending" means the stop
	 * failed and the process may still run (`running` stays truthful).
	 */
	transition?: "suspending" | "resuming"
	/** Who started the decoder; sent while `desiredRunning` is true. */
	startMode?: DecoderStartMode
	/** Who created the instance: configuration, or the scanner (a probe). Sent by current cores. */
	owner?: "config" | "scanner"
	/** Scanner job that owns this probe; present only for owner "scanner". */
	scannerJobId?: string
	/** Runtime-only instance (not in config, never persisted); present only for probes. */
	ephemeral?: true
	/**
	 * WG6 (web-gaps-6 req 3.3): problems of the configured `options` against the type's option
	 * schema (report only while DECODER_OPTIONS_ENFORCE is false). Absent when the type has no
	 * schema; [] when the options are valid. Sent by WG6 cores.
	 */
	optionIssues?: DecoderOptionIssue[]
}

/** WG6 req 3.6: false = option problems are reported, the decoder is created as before. */
export const DECODER_OPTIONS_ENFORCE = false
/** WG6 req 3.3: issues kept per decoder; more are counted in one final `truncated` issue. */
export const DECODER_OPTION_ISSUES_MAX = 32
/** WG6 req 3.3: UTF-16 code units of an issue message (and of its path). */
export const DECODER_OPTION_ISSUE_TEXT_MAX = 256

/** WG6 req 3.3: one problem of a decoder's configured options. */
export interface DecoderOptionIssue {
	/** Dotted path below `options`, e.g. `frequencies.2`; "" for the whole object. */
	path: string
	code: "unknown-key" | "invalid-value" | "truncated"
	message: string
}

/** WG6 req 3.4: value type of one documented option key. */
export type DecoderOptionType =
	| "string"
	| "integer"
	| "number"
	| "boolean"
	| "enum"
	| "string-list"
	| "number-list"
	| "object"

/** WG6 req 3.4: one documented option key of a decoder type. */
export interface DecoderOptionDescriptor {
	key: string
	type: DecoderOptionType
	/** For `enum` (and string lists with a closed set). */
	enumValues?: string[]
	min?: number
	max?: number
	/** e.g. "Hz", "dB", "ms", "ppm". */
	unit?: string
	/** The adapter's own default when the key is absent; null = none or computed. */
	default: string | number | boolean | null
	/** The value is a credential or key; exports redact it and UIs mask it. */
	secret: boolean
	/** How a change takes effect: WG8 decoder PATCH applies it when the decoder next starts. */
	effect: "restart"
	/**
	 * WG8 req 2.3: PATCH /api/decoders/:id may set this key (protected mode). Absent means
	 * false; set only by the reviewed allowlist by meaning.
	 */
	patchable?: boolean
	description: string
}

/** WG6 req 3.4: GET /api/decoders/types item. */
export interface DecoderTypeInfo {
	type: string
	caps: DecoderCaps
	/** Documented option keys; absent when the type has no option schema. */
	options?: DecoderOptionDescriptor[]
}

/** Why and since when a decoder is suspended for its source rate or band. */
export interface DecoderSuspension {
	reasonCode: DecoderSuspensionReasonCode
	/** ISO-8601 */
	since: string
}

/** GET /api/decoders/rate-preview item: the plan if the source ran at the given rate. */
export interface DecoderRatePreviewItem {
	decoderId: string
	assessment: DecoderRateAssessment
}

/** GET /api/decoders item and `decoder:status` WebSocket payload. */
export interface DecoderInfo extends DecoderStatus {
	caps?: DecoderCaps
}

export interface DecoderOutput {
	type: string
	decoder: string
	timestamp: string
	data: unknown
}

export type DecoderMode = "auto" | "always" | "off"
export type DecoderModeSource =
	| "settings"
	| "config"
	| "legacy-enabled"
	| "legacy-band"
	| "default"
export type DecoderReachKind = "channel" | "raw" | "centre"
export type DecoderEfficiencyDetail =
	| "budget"
	| "cpu"
	| "drops"
	| "unknown"
	| "late-drops"
/** Why an activity-ranked channel (multimon-ng, dsd-fme) runs. */
export interface DecoderPlacementActivity {
	/** "activity": chosen from a ready activity ranking; "nearest": the nearest-first fallback. */
	ranking: "activity" | "nearest"
	state?: "hot" | "warm" | "cold"
	/** At least 0, three decimals. */
	score?: number
	/** Energy on the channel in the latest spectrum block. */
	live?: boolean
	reasons?: (
		| "live-energy"
		| "track"
		| "occupancy"
		| "decoded"
		| "trial-success"
		| "trial-backoff"
	)[]
}
export interface DecoderPlacementView {
	sourceId: string
	channelHz?: number
	/** A channel placement's two-sided channel width; absent when unknown. */
	channelWidthHz?: number
	reach: DecoderReachKind
	origin: "configured" | "band" | "vfo" | "bandplan" | "fallback" | "activity"
	primary: boolean
	running: boolean
	/** Activity-ranked decoders only: why this channel runs. */
	activity?: DecoderPlacementActivity
	suspension?: DecoderSuspension
	efficiencyDetail?: DecoderEfficiencyDetail
	costCores: number
	probation?: boolean
}
export interface DecoderEfficiencyPlacement {
	decoderId: string
	sourceId: string
	channelHz: number | null
	reach: DecoderReachKind
	costCores: number
	probation: boolean
	/** "configured": a YAML decoder, admitted without the gate; its cost still counts. */
	detail?: DecoderEfficiencyDetail | "configured"
	retryAt?: string | null
}
export interface DecoderEfficiencySourceView {
	attribution?: DropAttribution
	lateDrops?: DecoderLateDropsView
	sourceId: string
	coresInUse: number
	cpu: { percent: number | null; limit: number }
	drops: "ok" | "dropping" | "clearing" | "unknown"
	dropBytesPerSecond: number | null
	admitted: DecoderEfficiencyPlacement[]
	blocked: DecoderEfficiencyPlacement[]
}
export interface DecoderEfficiencyView {
	budget?: EfficiencyBudgetResolution
	budgetCores: number
	cpuGuardPercent: number
	sources: DecoderEfficiencySourceView[]
}

/** PUT /api/decoders/efficiency/budget body. */
export interface EfficiencyBudgetUpdateRequest {
	cpuBudgetCores: EfficiencyBudgetValue
	/** Save only while the stored `cpuBudgetCores` still equals this; otherwise 409 and no change. */
	expected?: EfficiencyBudgetValue
}
/** The 409 body of a PUT whose `expected` no longer matched. */
export interface EfficiencyBudgetConflict {
	code: "EFFICIENCY_BUDGET_CONFLICT"
	current: EfficiencyBudgetSettings
}

export interface DecoderLateDropsView {
	condemningWindows: number
	windows: number
	cooldownUntil: string | null
	sheddable: number
	/** Why sustained late drops are not shedding (requirement 5.5); null when not held. */
	held: "nothing-sheddable" | "link-or-unknown" | null
}

/** GET /api/decoders/summary: compact output and placement diagnostics. */
export interface DecoderSummary {
	id: string
	/** Decoder protocol family / adapter type. */
	protocol: string
	state: "running" | "stopped"
	placements: Array<{ sourceId: string | null; frequencyHz: number | null }>
	eventsOut: number
	lastOutputAt: string | null
	suspensionReason: DecoderSuspensionReasonCode | null
	health: "decoding" | "idle" | "suspended" | "failed"
	/** One verdict per decoder: why it does or does not decode now, and what helps. */
	verdict: DecoderVerdict
}

/**
 * Closed set of decoder verdict codes (GET /api/decoders/summary). A client
 * meeting a code it does not know treats it as "unknown".
 */
export const DECODER_VERDICT_CODES = [
	"decoding",
	"listening",
	"starting",
	"off",
	"stopped",
	"failed",
	"out-of-band",
	"no-channel",
	"capture-too-narrow",
	"source-unavailable",
	"unsupported-rate",
	"scanner-busy",
	"efficiency-budget",
	"efficiency-cpu",
	"efficiency-drops",
	"efficiency-late-drops",
	"efficiency-waiting",
	"decoder-unavailable",
	"channelizer-unavailable",
	"unknown",
] as const
export type DecoderVerdictCode = (typeof DECODER_VERDICT_CODES)[number]

/** Closed set of actions a verdict may suggest; clients ignore ones they do not know. */
export const DECODER_VERDICT_ACTIONS = [
	"turn-on",
	"start",
	"restart",
	"tune-to-band",
	"raise-sample-rate",
	"lower-sample-rate",
	"change-sample-rate",
	"check-source",
	"pause-scanner",
	"raise-budget",
	"turn-off-others",
	"install-decoder",
	"enable-channelizer",
] as const
export type DecoderVerdictAction = (typeof DECODER_VERDICT_ACTIONS)[number]

/** Upper bound on `DecoderVerdict.text`, in UTF-16 code units. */
export const DECODER_VERDICT_TEXT_MAX_LENGTH = 160

export interface DecoderVerdict {
	code: DecoderVerdictCode
	/** One short human sentence, e.g. "ADS-B paused: CPU budget full". */
	text: string
	/** Suggested actions, most helpful first; empty when none applies. */
	actions: DecoderVerdictAction[]
}

export const decoderVerdictSchema = z
	.object({
		code: z.enum(DECODER_VERDICT_CODES),
		text: z.string().min(1).max(DECODER_VERDICT_TEXT_MAX_LENGTH),
		actions: z
			.array(z.enum(DECODER_VERDICT_ACTIONS))
			.max(DECODER_VERDICT_ACTIONS.length),
	})
	.strict()
