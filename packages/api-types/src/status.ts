/**
 * Agent-facing verdict helpers: the reasons and load figures on `GET /api/status`, the analog
 * recorder's recent decisions (`GET /api/scanner/recorder/decisions`) and the passive
 * "what is at this frequency" answer (`GET /api/identify`). Every field composes data the core
 * already holds; none of these adds a sampling loop.
 */
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
 * - `recorder-refusal-streak` (warn): the analog recorder has refused every candidate for over
 *   `RECORDER_STREAK_LIMITS.raiseAfterMs` with a code an operator can fix, and kept none. It
 *   raises a `healthy` verdict to `degraded`; `fix` names the call that fixes it.
 */
export const SYSTEM_STATUS_REASON_CODES = [
	"sweep-suspends-decoders",
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
	/** `sweep-suspends-decoders`: the held sources and how many decoders each suspends. */
	sources?: { sourceId: string; decoders: number }[] | undefined
	/** `recorder-refusal-streak`: the streak, as `GET /api/scanner/recorder/decisions` shows it. */
	streak?: RecorderRefusalStreak | undefined
}

/**
 * `SystemStatus.load`: the figures of the shared `GET /api/diagnostics` sample (one sample at most
 * every 2 s whoever asks, so reading them here costs no extra sampling). Null figures mean the
 * sample has none yet: the first sample has no CPU or utilization window.
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
 * the recorder working as meant and never make a streak.
 */
export const RECORDER_STREAK_FIXES = Object.freeze({
	"refused:tuning":
		"GET /api/sources (sources[].tuningUnproven), then POST /api/tuner/:sourceId/take-back",
	"refused:cpu":
		"GET /api/diagnostics, then raise cpuBudgetCores with PATCH /api/scanner/settings",
	"refused:slots":
		"GET /api/scanner (recorder.sessions), then raise cpuBudgetCores with PATCH /api/scanner/settings",
	"refused:no-iq":
		"GET /api/sources: the source must deliver U8_IQ for the analog recorder",
	"refused:record-disabled":
		"PATCH /api/scanner/jobs/:id with record.analog true on the job covering the band",
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
	/** ISO time of the first blocking refusal since the last kept file (a lower bound). */
	since: string
	durationMs: number
	/** The newest blocking refusal: its code names the fix. */
	newestCode: RecorderStreakCode
	newestAt: string
	/** Blocking refusals the recorder's rings still hold for the streak. */
	refusals: number
	/** True once it lasted over `raiseAfterMs` and is fresh: `/api/status` is raised. */
	raisesStatus: boolean
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
	/** Decisions since the core started, per code. */
	counts: Partial<Record<ScannerRecorderDecision, number>>
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
 *   second read of at most `scanMax` decoded ones keeps a decode from being cut.
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
