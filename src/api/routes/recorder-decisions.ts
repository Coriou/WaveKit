/**
 * GET /api/scanner/recorder/decisions: "why is nothing recorded", from the analog recorder's own
 * bounded rings (RECORDER_RECENT_DECISIONS session decisions + RECORDER_RECENT_REFUSALS snapshot
 * refusals), newest first, each joined to its discovery's frequency. Composition only: the rings
 * and counts are the recorder's, read through the scanner; nothing new is sampled or stored here
 * beyond the refusal streak's few remembered values.
 *
 * The refusal streak (RecorderStreakTracker) is the run of blocking refusals (RECORDER_STREAK_FIXES:
 * codes an operator can fix, never classification outcomes or operator choices) since the last kept
 * file or started session whose terminal decision was not a blocking code (progress codes such as
 * `classed` or `voiced` are no outcome), with no gap over RECORDER_STREAK_LIMITS.freshMs. A
 * `refused:slots` on a source the recorder holds a session on is recording at capacity and does
 * not count. `/api/status` raises its verdict once one lasts over
 * RECORDER_STREAK_LIMITS.raiseAfterMs and is fresh.
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

/** A session the recorder started: a candidate was taken, unless that session then failed. */
const SESSION_STARTS: ReadonlySet<ScannerRecorderDecision> = new Set([
	"started",
	"shadow",
])

/**
 * A session decision that ends a session's file (kept, refused or discarded: outcomeOf), or
 * `evicted`, the only decision a session the recorder evicts ever gets (terminal in the
 * SCANNER_RECORDER_DECISIONS contract). The other progress codes (`started`, `shadow`, `classed`,
 * `voiced`) are steps the recorder notes while the session runs, never its outcome.
 */
function isTerminal(code: ScannerRecorderDecision): boolean {
	return code === "evicted" || outcomeOf(code) !== "progress"
}

/**
 * Session starts (`started`, `shadow`) by how their session went. The recorder notes a session's
 * start, then its progress (`classed`, `voiced`, `evicted`) and one terminal decision per file
 * (`finalized`, `refused:store`, `discarded:write-failed`, ...), all about the session's owner
 * observation in the session ring (`recent`), so a start is paired with the terminal session
 * decisions for the same `observationId` after it, up to that observation's next start:
 * - `failed`: one of them is blocking. No breaker: the candidate was not recorded after all.
 * - `ended`: one of them is any other terminal code (a file kept, a classification end). A
 *   breaker.
 * - `open`: none yet (only progress codes, or a session that is done and waits for its store
 *   receipt). It may still record or fail: neither a breaker nor a failure.
 * Terminal ends whose start rolled out of the ring are paired among themselves the same way (up to
 * the observation's next start): a group with no blocking end is `ended` at its first end.
 */
function sessionStarts(
	entries: readonly Tagged[],
	blocking: (entry: ScannerRecorderDecisionEntry) => boolean,
): { ended: ReadonlySet<Tagged>; open: ReadonlySet<Tagged> } {
	const latest = new Map<string, Tagged>()
	const orphans = new Map<string, Tagged>()
	const failed = new Set<Tagged>()
	const ended = new Set<Tagged>()
	for (const t of entries) {
		if (t.kind !== "session") continue
		const id = t.entry.observationId
		if (SESSION_STARTS.has(t.entry.code)) {
			latest.set(id, t)
			orphans.delete(id)
			continue
		}
		if (!isTerminal(t.entry.code)) continue
		let group = latest.get(id)
		if (group === undefined) {
			group = orphans.get(id) ?? t
			orphans.set(id, group)
		}
		if (blocking(t.entry)) failed.add(group)
		else ended.add(group)
	}
	const open = new Set<Tagged>()
	for (const t of entries)
		if (
			t.kind === "session" &&
			SESSION_STARTS.has(t.entry.code) &&
			!failed.has(t) &&
			!ended.has(t)
		)
			open.add(t)
	for (const t of failed) ended.delete(t)
	return { ended, open }
}

/**
 * How many files the recorder kept since the core started: a change means a file was kept since
 * the last read, even one rolled out of the rings since. Session starts are not counted here (a
 * start whose session failed is no breaker, and the counts cannot tell); they are read from the
 * session ring, which holds the last RECORDER_RECENT_DECISIONS = 64 session decisions: at least 32
 * sessions (a start and an end each) between two reads.
 */
function keptCount(recorder: ScannerRecorderStatus): number {
	return recorder.counts.finalized ?? 0
}

interface RingStreak {
	startMs: number
	newest: Tagged
	refusals: number
}

/**
 * The streak the rings alone show: blocking refusals after the newest breaker (a kept file, or a
 * session start that ended without a blocking code: sessionStarts), restarted wherever two
 * blocking refusals in a row are over `freshMs` apart (a gap: the cause cleared in between).
 * `blocking` decides which entries count. `lastBreakerMs` is the newest breaker's time and
 * `firstOpenMs` the oldest open session start's (one with no terminal outcome yet), each null
 * without one.
 */
function ringStreak(
	entries: readonly Tagged[],
	blocking: (entry: ScannerRecorderDecisionEntry) => boolean,
): {
	streak: RingStreak | null
	lastBreakerMs: number | null
	firstOpenMs: number | null
} {
	const { ended, open } = sessionStarts(entries, blocking)
	let streak: RingStreak | null = null
	let lastBreakerMs: number | null = null
	let firstOpenMs: number | null = null
	for (const t of entries) {
		if (t.entry.code === "finalized" || ended.has(t)) {
			streak = null
			lastBreakerMs = t.ms
			continue
		}
		if (open.has(t)) {
			firstOpenMs ??= t.ms
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
	return { streak, lastBreakerMs, firstOpenMs }
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
 * (32 snapshot refusals) while a streak must be seen for 5. State: the count of kept files last
 * seen (a change means a file was kept since: the streak restarts), the earliest start and the
 * newest blocking refusal seen. A breaker in the rings (ringStreak) at or after the remembered
 * start also restarts it; a session start with no terminal outcome yet (`pending`) keeps the memory
 * and holds back only a first raise: one it started no later than `raiseAfterMs` after the streak's
 * start (it may be the recording that ends the streak), never one the streak had already earned
 * before it (overlapping failing sessions always leave a newer start open). A read whose rings hold no
 * blocking refusal (flooded by other codes) keeps that memory while it is fresh; a remembered
 * streak whose newest refusal is over `freshMs` older than the rings' start, or than now, is over.
 * Each read takes the earlier of the remembered start and the rings' own, so an unpolled core still
 * raises once its rings alone span the bound.
 */
export class RecorderStreakTracker {
	private keptSeen: number | null = null
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

	/**
	 * Whether an entry counts toward a streak. `recording`: the sources the recorder holds a session
	 * on now; a `refused:slots` on one of them is recording at capacity (every slot busy recording),
	 * not a refusal of every candidate, and does not count.
	 */
	private blocking(
		entry: ScannerRecorderDecisionEntry,
		recording: ReadonlySet<string>,
	): boolean {
		if (!isStreakCode(entry.code)) return false
		if (entry.code === "refused:slots") return !recording.has(entry.sourceId)
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
		const kept = keptCount(recorder)
		if (kept !== this.keptSeen) {
			this.keptSeen = kept
			this.remembered = null
		}
		const { freshMs, raiseAfterMs } = RECORDER_STREAK_LIMITS
		const recording = new Set(recorder.sessions.map(s => s.sourceId))
		const {
			streak: ring,
			lastBreakerMs,
			firstOpenMs,
		} = ringStreak(merged(recorder), entry => this.blocking(entry, recording))
		let prior = this.remembered
		if (
			prior !== null &&
			((ring !== null && ring.startMs - prior.newestMs > freshMs) ||
				(lastBreakerMs !== null && lastBreakerMs >= prior.sinceMs))
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
		// A session start with no terminal outcome yet: it may be recording. It holds back a raise
		// the streak would first earn while it runs (started within `raiseAfterMs` of the streak's
		// start, or before it), never one already earned before it started.
		const pending = firstOpenMs !== null
		// An open start older than `raiseAfterMs` holds nothing: every session end the recorder
		// notes comes well within it (unvoiced 8 s, digital shadow 12 s, file roll-over 120 s), so
		// such a start lost its outcome and must not hold a real streak back for good.
		const held =
			firstOpenMs !== null &&
			firstOpenMs - sinceMs <= raiseAfterMs &&
			nowMs - firstOpenMs <= raiseAfterMs
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
			raisesStatus: fresh && !held && durationMs > raiseAfterMs,
			pending,
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
