/**
 * Agent-facing verdict helpers: the reasons and load figures on `GET /api/status`, the analog
 * recorder's recent decisions (`GET /api/scanner/recorder/decisions`) and the passive
 * "what is at this frequency" answer (`GET /api/identify`). Every field composes data the core
 * already holds and none adds a sampling loop of its own: `load` reads the shared diagnostics
 * sample, taking one when none is under 2 s old.
 */
import type { DecoderStatus } from "./decoders.js"
import type { SourceStatus } from "./sources.js"
import type { TunerRelayStatus } from "./tuner.js"
import {
	RECORDER_RECENT_DECISIONS,
	RECORDER_RECENT_REFUSALS,
	type Identity,
	type ScannerClass,
	type ScannerConfidence,
	type ScannerEvidenceLevel,
	type ScannerProofKind,
	type ScannerProtocol,
	type ScannerRecorderDecision,
	type ScannerRecorderDecisionEntry,
} from "./scanner.js"

// ============================================================================
// GET /api/status: reasons and load
// ============================================================================

/**
 * Why `/api/status` reads the verdict it does, beyond the component states:
 * - `sweep-suspends-decoders` (info): a scanner sweep holds a source, so the configured decoders
 *   on it are suspended (`tuner-scanning`). They are not counted down; they resume when the sweep
 *   ends. The verdict stays as the other components make it.
 * - `sweep-hold-without-job` (warn): decoders are suspended `tuner-scanning` on a source no live
 *   scanner job (starting, running, holding or paused) names: a hold its job did not release. It
 *   raises a `healthy` verdict to `degraded`. Only read when the core knows its jobs.
 * - `recorder-refusal-streak` (warn): the analog recorder has refused every candidate for over
 *   `RECORDER_STREAK_LIMITS.raiseAfterMs` with a code an operator can fix, and kept none and
 *   started none. It raises a `healthy` verdict to `degraded`; `fix` names the call that fixes it.
 */
export const SYSTEM_STATUS_REASON_CODES = [
	"sweep-suspends-decoders",
	"sweep-hold-without-job",
	"recorder-refusal-streak",
] as const
export type SystemStatusReasonCode = (typeof SYSTEM_STATUS_REASON_CODES)[number]

export interface SystemStatusReason {
	code: SystemStatusReasonCode
	level: "info" | "warn"
	/** Fixed text with counts; never a component's own message. */
	message: string
	/** The API call that fixes or explains it, in fixed text. */
	fix: string
	/** `sweep-*`: the held sources and how many decoders each suspends. */
	sources?: { sourceId: string; decoders: number }[] | undefined
	/** `recorder-refusal-streak`: the streak, as `GET /api/scanner/recorder/decisions` shows it. */
	streak?: RecorderRefusalStreak | undefined
}

/**
 * `SystemStatusResponse.load`: the figures of the shared `GET /api/diagnostics` sample. Status
 * reuses the newest sample when it is under 2 s old and otherwise takes one (the same sample
 * `/api/diagnostics` answers with), so the core samples at most once every 2 s whoever asks; with
 * nobody asking, nothing is sampled. Null figures mean the sample has none yet: the first sample
 * has no CPU or utilization window.
 */
export interface SystemStatusLoad {
	/** ISO time of the sample. */
	at: string
	/** All threads of the core together over the sample window; 1 is one full core. */
	processCpuCores: number | null
	/** The container's CPU use in cores, when the core reads it. */
	containerCpuCores: number | null
	/** Share of the window the event loop was busy, 0 to 1. */
	eventLoopUtilization: number | null
	/** Event-loop delay over the last 2 s interval, ms. */
	eventLoopDelayMaxMs: number | null
	eventLoopDelayP99Ms: number | null
	/** The worst 2 s interval of the last 10 minutes, ms. */
	eventLoopDelayMaxMs10m: number | null
	/** The full sample: threads, channels and the delay histogram. */
	details: "/api/diagnostics"
}

/** The verdict levels of `GET /api/status` (and `health.status`). */
export type SystemHealthLevel = "healthy" | "degraded" | "unhealthy"

/** One component's health in `SystemStatusResponse.health.components`. */
export interface SystemComponentHealth {
	status: "up" | "down" | "degraded"
	message?: string
	lastCheck: string
	metrics?: Record<string, number>
}

/** `SystemStatusResponse.health`: the components' own verdict, before any reason raises it. */
export interface SystemHealth {
	status: SystemHealthLevel
	timestamp: string
	uptime: number
	components: {
		api: SystemComponentHealth
		sdrpp?: SystemComponentHealth
		decoders: Record<string, SystemComponentHealth>
		source: SystemComponentHealth
	}
}

/** `GET /api/status`. */
export interface SystemStatusResponse {
	/**
	 * `health.status` raised to `degraded` by a `warn` reason; `health.status` stays the
	 * components' own verdict.
	 */
	status: SystemHealthLevel
	/** Seconds since the core started. */
	uptime: number
	version: string
	sources: SourceStatus[]
	decoders: DecoderStatus[]
	audio: {
		outputPort: number
		clientsConnected: number
		format?: string
		sampleRate?: number
	}
	tunerRelay?: TunerRelayStatus
	health: SystemHealth
	/** Why `status` reads as it does beyond the components (empty when nothing applies). */
	reasons: SystemStatusReason[]
	/** The shared diagnostics sample's CPU and event-loop figures; null when the sample failed, absent when not wired. */
	load?: SystemStatusLoad | null
}

// ============================================================================
// GET /api/scanner/recorder/decisions
// ============================================================================

/**
 * The route's `limit`: 20 by default, at most the two rings the recorder keeps together
 * (RECORDER_RECENT_DECISIONS session decisions + RECORDER_RECENT_REFUSALS snapshot refusals =
 * 64 + 32 = 96), since nothing older is held.
 */
export const RECORDER_DECISIONS_LIMITS = Object.freeze({
	defaultLimit: 20,
	maxLimit: RECORDER_RECENT_DECISIONS + RECORDER_RECENT_REFUSALS,
})

/**
 * When a refusal streak raises `/api/status`:
 * - `raiseAfterMs` 5 min: a streak lasting longer (strictly) raises the verdict. A busy band can
 *   refuse a few snapshots for `slots` or `cpu` and then record; 5 min of nothing kept is not that.
 * - `freshMs` 5 min: the newest blocking refusal must be at most this old, or the streak is over
 *   (a quiet band after the cause cleared refuses nothing, and must not stay degraded).
 */
export const RECORDER_STREAK_LIMITS = Object.freeze({
	raiseAfterMs: 5 * 60_000,
	freshMs: 5 * 60_000,
})

/**
 * Refusal and discard codes that mean the recorder cannot record what it would keep, each with the
 * call that fixes it. Classification outcomes (`refused:not-analog`, `discarded:unvoiced`, ...) are
 * the recorder working as meant and never make a streak, nor does `refused:record-disabled` (the
 * operator turned recording off on the job: a choice, not a fault; the decisions list still shows
 * it). `refused:tuning` counts only while its source's tuning is unproven (`tuningUnproven` on
 * GET /api/sources), since the recorder also refuses a snapshot of an older stream or epoch with it.
 */
export const RECORDER_STREAK_FIXES = Object.freeze({
	"refused:tuning":
		"GET /api/sources (sources[].tuningUnproven), then POST /api/tuner/:sourceId/take-back",
	"refused:cpu":
		"GET /api/diagnostics: the shared CPU budget is full or the measured core or host CPU is busy; wait, or free CPU or raise cpuBudgetCores with PATCH /api/scanner/settings",
	"refused:slots":
		"GET /api/scanner (recorder.sessions): the source is at its recording limit; wait for a recording to end. When the CPU budget gives only the floor of slots (cpuBudgetCores 0.5, say), raising cpuBudgetCores with PATCH /api/scanner/settings raises it; without a CPU reading the limit is the floor of 2 whatever the budget",
	"refused:no-iq":
		"GET /api/sources: the source must deliver U8_IQ for the analog recorder",
	"refused:store":
		"GET /api/scanner (recordingsQuota) and GET /api/storage: free space or raise maxRecordingsMb",
	"refused:start-failed":
		"GET /api/scanner/recorder/decisions, then the core log for the recorder start failure",
	"discarded:store-backlog":
		"GET /api/storage and GET /api/diagnostics: the disk is not keeping up",
	"discarded:write-failed":
		"GET /api/storage: the recordings directory refused a write",
	"discarded:buffer-full":
		"GET /api/diagnostics: the store fell 60 s behind the recorder",
} as const satisfies Partial<Record<ScannerRecorderDecision, string>>)
export type RecorderStreakCode = keyof typeof RECORDER_STREAK_FIXES

export interface RecorderRefusalStreak {
	/**
	 * ISO time of the first blocking refusal since the last kept file or started session (one whose
	 * session then ended in a blocking code does not count), with no gap over `freshMs` between two
	 * in a row (a lower bound).
	 */
	since: string
	durationMs: number
	/** The newest blocking refusal: its code names the fix. */
	newestCode: RecorderStreakCode
	newestAt: string
	/** Blocking refusals the recorder's rings still hold for the streak (0 once rolled out). */
	refusals: number
	/**
	 * True once it lasted over `raiseAfterMs` and is fresh, unless a `pending` start holds it back
	 * (see `pending`): `/api/status` is raised.
	 */
	raisesStatus: boolean
	/**
	 * A session the recorder started has no terminal decision yet (`finalized`, `refused:*`,
	 * `discarded:*`; progress codes such as `classed` or `voiced` are none): it may be recording.
	 * It neither breaks nor ends the streak, and holds back only a raise the streak would first
	 * earn while it runs (started within `raiseAfterMs` of `since`, or before it, and itself at most
	 * `raiseAfterMs` old), never one already earned. A blocking end continues the streak, any other end breaks it.
	 */
	pending: boolean
	fix: string
}

/** `kept`: a file was written; `progress`: a session step (started, shadow, classed, voiced, evicted). */
export type RecorderDecisionOutcome =
	| "kept"
	| "refused"
	| "discarded"
	| "progress"

export interface RecorderDecisionRow {
	at: string
	code: ScannerRecorderDecision
	outcome: RecorderDecisionOutcome
	/** `session`: about a recording; `snapshot`: a refusal before any recording started. */
	kind: "session" | "snapshot"
	sourceId: string
	observationId: string
	discoveryId: string | null
	/** The discovery's frequency now; null without a discovery or once it is gone. */
	frequencyHz: number | null
	unclean?: ScannerRecorderDecisionEntry["unclean"]
	receipt?: ScannerRecorderDecisionEntry["receipt"]
}

export interface RecorderDecisionsResponse {
	at: string
	limit: number
	/** Newest first, at most `limit`. */
	items: RecorderDecisionRow[]
	/** Entries the recorder holds now (both rings), at most `maxLimit`. */
	held: number
	/**
	 * Decisions since the core started, per code; a snapshot refusal once per observation and code
	 * (`ScannerRecorderStatus.counts`).
	 */
	counts: Partial<Record<ScannerRecorderDecision, number>>
	/** Every refused snapshot since the core started, per code (`ScannerRecorderStatus.refusalAttempts`). */
	refusalAttempts?: Partial<Record<ScannerRecorderDecision, number>> | undefined
	/** Null while no blocking refusal follows the last kept file. */
	streak: RecorderRefusalStreak | null
}

// ============================================================================
// GET /api/identify
// ============================================================================

/**
 * How much the core already knows about a frequency, from the discoveries it holds there:
 * `decoded` (a decode or a decoded proof), `classified` (a class or a non-decode proof such as
 * analog voice or tone), `energy-only` (a level above the floor, a candidate, a carrier, or a
 * possible receiver spur), `nothing` (no discovery within the tolerance: nothing was recorded
 * there, which is not proof that nothing transmits).
 */
export const FREQUENCY_PROOF_LEVELS = [
	"decoded",
	"classified",
	"energy-only",
	"nothing",
] as const
export type FrequencyProofLevel = (typeof FREQUENCY_PROOF_LEVELS)[number]

/**
 * - `toleranceHz` default 6 250 (half a 12.5 kHz channel) and at most 1 MHz, the discovery list's
 *   own `nearHz` bounds (DISCOVERY_NEAR_*).
 * - `scanMax` 50: discoveries read nearest first; a wider window with more is `truncated`, and a
 *   second read of at most `scanMax` whose published confidence is `decoded` keeps such a decode
 *   from being cut (a row decoded only by its proof kind can still be; `truncated` says so).
 * - `othersMax` 8: rows beside `best`, so the answer stays a few KiB.
 */
export const FREQUENCY_IDENTIFY_LIMITS = Object.freeze({
	scanMax: 50,
	othersMax: 8,
})

export interface FrequencyIdentifyRow {
	discoveryId: string
	frequencyHz: number
	/** `frequencyHz` less the asked frequency. */
	offsetHz: number
	level: Exclude<FrequencyProofLevel, "nothing">
	protocol: ScannerProtocol
	class: ScannerClass
	confidence: ScannerConfidence
	evidenceLevel: ScannerEvidenceLevel | null
	proofKind: ScannerProofKind | null
	identity?: Identity | undefined
	lastSeenAt: string
	/** Suspected receiver spur, not verified: the level is capped at `energy-only`. */
	possibleSpur: boolean
}

export interface FrequencyIdentifyResponse {
	at: string
	frequencyHz: number
	toleranceHz: number
	/** The best level among the rows; `nothing` without any. */
	level: FrequencyProofLevel
	best: FrequencyIdentifyRow | null
	others: FrequencyIdentifyRow[]
	/** More discoveries sat in the window than were read. */
	truncated: boolean
	/** A live test that listens now, without retuning: POST /api/scanner/identify. */
	confirm: { method: "POST"; path: "/api/scanner/identify" }
}
