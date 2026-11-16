/**
 * GET /api/scanner/recorder/decisions: "why is nothing recorded", from the analog recorder's own
 * bounded rings (RECORDER_RECENT_DECISIONS session decisions + RECORDER_RECENT_REFUSALS snapshot
 * refusals), newest first, each joined to its discovery's frequency. Composition only: the rings
 * and counts are the recorder's, read through the scanner; nothing new is sampled or stored here
 * beyond the refusal streak's few remembered values.
 *
 * The refusal streak (RecorderStreakTracker) is the run of blocking refusals (RECORDER_STREAK_FIXES:
 * codes an operator can fix, never classification outcomes or operator choices) since the last kept
 * file or started session, with no gap over RECORDER_STREAK_LIMITS.freshMs. `/api/status` raises
 * its verdict once one lasts over RECORDER_STREAK_LIMITS.raiseAfterMs and is fresh.
 */
import { z } from "zod"
import {
	RECORDER_DECISIONS_LIMITS,
	RECORDER_STREAK_FIXES,
	RECORDER_STREAK_LIMITS,
	type RecorderDecisionOutcome,
	type RecorderDecisionRow,
	type RecorderDecisionsResponse,
	type RecorderRefusalStreak,
	type RecorderStreakCode,
	type ScannerRecorderDecision,
	type ScannerRecorderDecisionEntry,
	type ScannerRecorderStatus,
} from "@wavekit/api-types"
import type { FastifyPluginAsync } from "fastify"
import { zodValidationBody } from "../validation-errors.js"

/** What the route reads: the recorder block and a discovery's frequency (null when unknown). */
export interface RecorderDecisionsSource {
	recorder: () => ScannerRecorderStatus | undefined
	frequencyOf: (discoveryId: string) => number | null
}

export const RecorderDecisionsQuerySchema = z
	.object({
		limit: z.coerce
			.number()
			.int()
			.min(1)
			.max(RECORDER_DECISIONS_LIMITS.maxLimit)
			.optional(),
	})
	.strict()

const STREAK_CODES: ReadonlySet<string> = new Set(
	Object.keys(RECORDER_STREAK_FIXES),
)

export function isStreakCode(
	code: ScannerRecorderDecision,
): code is RecorderStreakCode {
	return STREAK_CODES.has(code)
}

export function outcomeOf(
	code: ScannerRecorderDecision,
): RecorderDecisionOutcome {
	if (code === "finalized") return "kept"
	if (code.startsWith("refused:")) return "refused"
	if (code.startsWith("discarded:")) return "discarded"
	return "progress"
}

interface Tagged {
	entry: ScannerRecorderDecisionEntry
	kind: "session" | "snapshot"
	ms: number
}

/** Both rings, oldest first; an entry with an unreadable time is left out (never guessed). */
function merged(recorder: ScannerRecorderStatus): Tagged[] {
	const out: Tagged[] = []
	const add = (
		entries: readonly ScannerRecorderDecisionEntry[] | undefined,
		kind: Tagged["kind"],
	): void => {
		for (const entry of entries ?? []) {
			const ms = Date.parse(entry.at)
			if (Number.isFinite(ms)) out.push({ entry, kind, ms })
		}
	}
	add(recorder.recent, "session")
	add(recorder.recentRefusals, "snapshot")
	// Stable: equal times keep session decisions before snapshot refusals.
	return out.sort((a, b) => a.ms - b.ms)
}

/**
 * Codes that end a streak: a kept file, or a session the recorder started (`started`, `shadow`):
 * a candidate was taken, so "refusing every candidate" no longer holds.
 */
const STREAK_BREAKERS: ReadonlySet<ScannerRecorderDecision> = new Set([
	"finalized",
	"started",
	"shadow",
])

/** How many streak-ending decisions the recorder made since the core started. */
function breakerCount(recorder: ScannerRecorderStatus): number {
	let n = 0
	for (const code of STREAK_BREAKERS) n += recorder.counts[code] ?? 0
	return n
}

interface RingStreak {
	startMs: number
	newest: Tagged
	refusals: number
}

/**
 * The streak the rings alone show: blocking refusals after the newest kept file or started
 * session, restarted wherever two blocking refusals in a row are over `freshMs` apart (a gap: the
 * cause cleared in between). `blocking` decides which entries count.
 */
function ringStreak(
	entries: readonly Tagged[],
	blocking: (entry: ScannerRecorderDecisionEntry) => boolean,
): RingStreak | null {
	let streak: RingStreak | null = null
	for (const t of entries) {
		if (STREAK_BREAKERS.has(t.entry.code)) {
			streak = null
			continue
		}
		if (!blocking(t.entry)) continue
		if (
			streak === null ||
			t.ms - streak.newest.ms > RECORDER_STREAK_LIMITS.freshMs
		)
			streak = { startMs: t.ms, newest: t, refusals: 1 }
		else {
			streak.newest = t
			streak.refusals++
		}
	}
	return streak
}

export interface RecorderStreakTrackerOptions {
	/**
	 * True while a source's tuning is unproven now (GET /api/sources `tuningUnproven`). Given, a
	 * `refused:tuning` counts only while its source is unproven: the recorder also refuses a
	 * snapshot of an older stream or epoch (`refused:tuning` too, a normal step after a sweep hop),
	 * which the entry cannot tell apart. Absent, every `refused:tuning` counts.
	 */
	tuningUnproven?: ((sourceId: string) => boolean) | undefined
}

/**
 * Remembers a streak across reads, since the rings roll over in minutes on a busy band
 * (32 snapshot refusals) while a streak must be seen for 5. State: the count of streak-ending
 * decisions last seen (a change means a file was kept or a session started since: the streak
 * restarts), the earliest start and the newest blocking refusal seen. A read whose rings hold no
 * blocking refusal (flooded by other codes) keeps that memory while it is fresh; a remembered
 * streak whose newest refusal is over `freshMs` older than the rings' start, or than now, is over.
 * Each read takes the earlier of the remembered start and the rings' own, so an unpolled core still
 * raises once its rings alone span the bound.
 */
export class RecorderStreakTracker {
	private breakersSeen: number | null = null
	private remembered: {
		sinceMs: number
		newestMs: number
		newestCode: RecorderStreakCode
		newestAt: string
	} | null = null
	private readonly tuningUnproven: ((sourceId: string) => boolean) | undefined

	constructor(options: RecorderStreakTrackerOptions = {}) {
		this.tuningUnproven = options.tuningUnproven
	}

	private blocking = (entry: ScannerRecorderDecisionEntry): boolean => {
		if (!isStreakCode(entry.code)) return false
		if (entry.code !== "refused:tuning" || this.tuningUnproven === undefined)
			return true
		return this.tuningUnproven(entry.sourceId)
	}

	read(
		recorder: ScannerRecorderStatus | undefined,
		nowMs: number,
	): RecorderRefusalStreak | null {
		if (recorder === undefined) {
			this.remembered = null
			return null
		}
		const breakers = breakerCount(recorder)
		if (breakers !== this.breakersSeen) {
			this.breakersSeen = breakers
			this.remembered = null
		}
		const { freshMs, raiseAfterMs } = RECORDER_STREAK_LIMITS
		const ring = ringStreak(merged(recorder), this.blocking)
		let prior = this.remembered
		if (
			prior !== null &&
			ring !== null &&
			ring.startMs - prior.newestMs > freshMs
		)
			prior = null
		const fromRing =
			ring === null
				? null
				: {
						sinceMs: ring.startMs,
						newestMs: ring.newest.ms,
						newestCode: ring.newest.entry.code as RecorderStreakCode,
						newestAt: ring.newest.entry.at,
					}
		const newest =
			fromRing !== null &&
			(prior === null || fromRing.newestMs >= prior.newestMs)
				? fromRing
				: prior
		if (newest === null) {
			this.remembered = null
			return null
		}
		const sinceMs = Math.min(
			prior?.sinceMs ?? Number.POSITIVE_INFINITY,
			fromRing?.sinceMs ?? Number.POSITIVE_INFINITY,
		)
		const fresh = nowMs - newest.newestMs <= freshMs
		// A stale streak is over: the next blocking refusal starts a new one.
		this.remembered = fresh ? { ...newest, sinceMs } : null
		const durationMs = Math.max(0, nowMs - sinceMs)
		return {
			since: new Date(sinceMs).toISOString(),
			durationMs,
			newestCode: newest.newestCode,
			newestAt: newest.newestAt,
			refusals: ring?.refusals ?? 0,
			// Strictly over the bound: exactly 5 min does not raise.
			raisesStatus: fresh && durationMs > raiseAfterMs,
			fix: RECORDER_STREAK_FIXES[newest.newestCode],
		}
	}
}

/** Pure composition of one answer; exported for the tests. */
export function buildRecorderDecisions(
	source: RecorderDecisionsSource,
	tracker: RecorderStreakTracker,
	limit: number,
	nowMs: number,
): RecorderDecisionsResponse {
	const recorder = source.recorder()
	const all = recorder ? merged(recorder) : []
	const rows: RecorderDecisionRow[] = all
		.slice(-limit)
		.reverse()
		.map(({ entry, kind }) => ({
			at: entry.at,
			code: entry.code,
			outcome: outcomeOf(entry.code),
			kind,
			sourceId: entry.sourceId,
			observationId: entry.observationId,
			discoveryId: entry.discoveryId,
			frequencyHz:
				entry.discoveryId === null
					? null
					: source.frequencyOf(entry.discoveryId),
			...(entry.unclean !== undefined ? { unclean: entry.unclean } : {}),
			...(entry.receipt !== undefined ? { receipt: entry.receipt } : {}),
		}))
	return {
		at: new Date(nowMs).toISOString(),
		limit,
		items: rows,
		held: all.length,
		counts: recorder?.counts ?? {},
		streak: tracker.read(recorder, nowMs),
	}
}

export interface RecorderDecisionsRoutesOptions {
	source: RecorderDecisionsSource
	/** Shared with `/api/status`, so both read one streak. */
	tracker: RecorderStreakTracker
	/** Test seam. */
	now?: (() => number) | undefined
}

export const recorderDecisionsRoutes: FastifyPluginAsync<
	RecorderDecisionsRoutesOptions
> = async (app, options) => {
	const now = options.now ?? Date.now
	app.get(
		"/api/scanner/recorder/decisions",
		{
			schema: {
				summary:
					"The analog recorder's recent keep, refuse and discard decisions, newest first",
				tags: ["scanner"],
			},
		},
		async (request, reply) => {
			const parsed = RecorderDecisionsQuerySchema.safeParse(request.query ?? {})
			if (!parsed.success)
				return reply.code(400).send(
					zodValidationBody(parsed.error, RecorderDecisionsQuerySchema, {
						part: "query",
					}),
				)
			const limit = parsed.data.limit ?? RECORDER_DECISIONS_LIMITS.defaultLimit
			return buildRecorderDecisions(
				options.source,
				options.tracker,
				limit,
				now(),
			)
		},
	)
}
