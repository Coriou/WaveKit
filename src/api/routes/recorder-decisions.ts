/**
 * GET /api/scanner/recorder/decisions: "why is nothing recorded", from the analog recorder's own
 * bounded rings (RECORDER_RECENT_DECISIONS session decisions + RECORDER_RECENT_REFUSALS snapshot
 * refusals), newest first, each joined to its discovery's frequency. Composition only: the rings
 * and counts are the recorder's, read through the scanner; nothing new is sampled or stored here
 * beyond the refusal streak's two remembered numbers.
 *
 * The refusal streak (RecorderStreakTracker) is the run of blocking refusals (RECORDER_STREAK_FIXES:
 * codes an operator can fix, never classification outcomes) since the last kept file. `/api/status`
 * raises its verdict once one lasts over RECORDER_STREAK_LIMITS.raiseAfterMs and is fresh.
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

/** The streak the rings alone show: blocking refusals after the newest kept file. */
function ringStreak(
	entries: readonly Tagged[],
): { startMs: number; newest: Tagged; refusals: number } | null {
	let startMs: number | null = null
	let newest: Tagged | null = null
	let refusals = 0
	for (const t of entries) {
		if (t.entry.code === "finalized") {
			startMs = null
			newest = null
			refusals = 0
			continue
		}
		if (!isStreakCode(t.entry.code)) continue
		startMs ??= t.ms
		newest = t
		refusals++
	}
	return startMs === null || newest === null
		? null
		: { startMs, newest, refusals }
}

/**
 * Remembers a streak's start across reads, since the rings roll over in minutes on a busy band
 * (32 snapshot refusals) while a streak must be seen for 5. State: the `finalized` count last
 * seen (a change means a file was kept since: the streak restarts) and the earliest start seen.
 * Each read takes the earlier of that start and the rings' own, so an unpolled core still raises
 * once its rings alone span the bound.
 */
export class RecorderStreakTracker {
	private finalizedSeen: number | null = null
	private sinceMs: number | null = null

	read(
		recorder: ScannerRecorderStatus | undefined,
		nowMs: number,
	): RecorderRefusalStreak | null {
		if (recorder === undefined) {
			this.sinceMs = null
			return null
		}
		const finalized = recorder.counts["finalized"] ?? 0
		if (finalized !== this.finalizedSeen) {
			this.finalizedSeen = finalized
			this.sinceMs = null
		}
		const ring = ringStreak(merged(recorder))
		if (ring === null) {
			this.sinceMs = null
			return null
		}
		const sinceMs =
			this.sinceMs === null
				? ring.startMs
				: Math.min(this.sinceMs, ring.startMs)
		this.sinceMs = sinceMs
		const durationMs = Math.max(0, nowMs - sinceMs)
		const code = ring.newest.entry.code as RecorderStreakCode
		const fresh = nowMs - ring.newest.ms <= RECORDER_STREAK_LIMITS.freshMs
		return {
			since: new Date(sinceMs).toISOString(),
			durationMs,
			newestCode: code,
			newestAt: ring.newest.entry.at,
			refusals: ring.refusals,
			// Strictly over the bound: exactly 5 min does not raise.
			raisesStatus: fresh && durationMs > RECORDER_STREAK_LIMITS.raiseAfterMs,
			fix: RECORDER_STREAK_FIXES[code],
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
