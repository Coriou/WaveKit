/**
 * The wideband analog recorder's decision log (docs/SCANNER.md, Recorder decisions): every
 * decision gets a closed reason code (SCANNER_RECORDER_DECISIONS) and is kept for the API (a
 * bounded per-observation memory for discovery reads). A session decision is logged at info
 * within a rate limit and kept in the status ring of session decisions; a snapshot refusal (an
 * observation refused before any session started for it) is logged at debug and kept in its own
 * ring, so the refusals of busy tracks never crowd session decisions out of either. Only trusted
 * values are logged: the code, the source id from the config and the core's own observation and
 * discovery ids.
 */
import {
	RECORDER_MAX_OBSERVATIONS,
	RECORDER_RECENT_DECISIONS,
	RECORDER_RECENT_REFUSALS,
	type ScannerRecorderDecision,
	type ScannerRecorderDecisionEntry,
	type ScannerRecorderDiscovery,
} from "@wavekit/api-types"
import type { Logger } from "../../../utils/logger.js"

/**
 * Info lines per RECORDER_LOG_WINDOW_MS, session decisions only (snapshot refusals go to debug). A
 * recorded transmission costs 3 to 4 lines (started or shadow, classed, voiced, finalized), so 20
 * a minute log about five recordings a minute in full and at most 20 × 1440 = 28 800 lines a day;
 * past it the lines are counted (logsSuppressed) and the next logged line carries how many were
 * left out.
 */
export const RECORDER_LOG_LIMIT = 20
export const RECORDER_LOG_WINDOW_MS = 60_000

export interface RecorderDecisionRef {
	readonly sourceId: string
	readonly observationId: string
	readonly discoveryId: string | null
}

interface ObservationMemory {
	sourceId: string
	discoveryId: string | null
	last: ScannerRecorderDecision
	at: number
	counts: Map<ScannerRecorderDecision, number>
}

interface Entry {
	code: ScannerRecorderDecision
	at: number
	sourceId: string
	observationId: string
	discoveryId: string | null
}

export class RecorderDecisions {
	/** Session decisions, newest last (RECORDER_RECENT_DECISIONS). */
	private readonly recent: Entry[] = []
	/** Snapshot refusals, newest last (RECORDER_RECENT_REFUSALS). */
	private readonly refusals: Entry[] = []
	private readonly counts = new Map<ScannerRecorderDecision, number>()
	/** Insertion order is recency: an update moves the observation to the end. */
	private readonly byObservation = new Map<string, ObservationMemory>()
	private windowStart = Number.NEGATIVE_INFINITY
	private logged = 0
	private suppressedInWindow = 0
	private suppressedTotal = 0

	constructor(
		private readonly log: Logger,
		private readonly now: () => number,
	) {}

	/**
	 * One decision. A snapshot refusal (`session` false) repeating the observation's last decision
	 * (a snapshot retried while slots or CPU stay full, a class that stays non-analog) is no new
	 * decision: it is not counted, kept or logged, but the discovery it now carries is still bound
	 * (an observation may be associated only after its first refusal). Any other code always
	 * counts: a session's decisions are each about a file or the session (two files of one session
	 * finalize twice, two files refused by the store are refused twice). A snapshot refusal is
	 * logged at debug and kept in the refusal ring; a session decision at info (rate limited) and in
	 * the session ring.
	 */
	note(
		code: ScannerRecorderDecision,
		ref: RecorderDecisionRef,
		session = false,
	): void {
		const at = this.now()
		const known = this.byObservation.get(ref.observationId)
		if (!session && known?.last === code && code.startsWith("refused:")) {
			known.discoveryId = ref.discoveryId ?? known.discoveryId
			return
		}
		const memory: ObservationMemory = known ?? {
			sourceId: ref.sourceId,
			discoveryId: null,
			last: code,
			at,
			counts: new Map(),
		}
		memory.last = code
		memory.at = at
		memory.discoveryId = ref.discoveryId ?? memory.discoveryId
		memory.counts.set(code, (memory.counts.get(code) ?? 0) + 1)
		this.byObservation.delete(ref.observationId)
		this.byObservation.set(ref.observationId, memory)
		if (this.byObservation.size > RECORDER_MAX_OBSERVATIONS) {
			const oldest = this.byObservation.keys().next()
			if (oldest.done !== true) this.byObservation.delete(oldest.value)
		}
		this.counts.set(code, (this.counts.get(code) ?? 0) + 1)
		const entry: Entry = {
			code,
			at,
			sourceId: ref.sourceId,
			observationId: ref.observationId,
			discoveryId: memory.discoveryId,
		}
		if (!session) {
			this.refusals.push(entry)
			if (this.refusals.length > RECORDER_RECENT_REFUSALS) this.refusals.shift()
			this.log.debug(fields(entry), "Analog recorder snapshot refusal")
			return
		}
		this.recent.push(entry)
		if (this.recent.length > RECORDER_RECENT_DECISIONS) this.recent.shift()
		this.logLine(entry)
	}

	/**
	 * The observation's discovery became known (a shadow classed after its decisions, a refused
	 * observation associated later, or an association first given at its close).
	 */
	bindDiscovery(observationId: string, discoveryId: string): void {
		const memory = this.byObservation.get(observationId)
		if (memory) memory.discoveryId ??= discoveryId
	}

	/** The decisions about `discoveryId`'s remembered observations, or null when there are none. */
	forDiscovery(discoveryId: string): ScannerRecorderDiscovery | null {
		let last: { id: string; m: ObservationMemory } | null = null
		const counts: Partial<Record<ScannerRecorderDecision, number>> = {}
		for (const [id, m] of this.byObservation) {
			if (m.discoveryId !== discoveryId) continue
			for (const [code, n] of m.counts) counts[code] = (counts[code] ?? 0) + n
			if (last === null || m.at >= last.m.at) last = { id, m }
		}
		if (last === null) return null
		return {
			last: dto({
				code: last.m.last,
				at: last.m.at,
				sourceId: last.m.sourceId,
				observationId: last.id,
				discoveryId,
			}),
			counts,
		}
	}

	status(): {
		recent: ScannerRecorderDecisionEntry[]
		recentRefusals: ScannerRecorderDecisionEntry[]
		counts: Partial<Record<ScannerRecorderDecision, number>>
		logsSuppressed: number
	} {
		return {
			recent: this.recent.map(dto),
			recentRefusals: this.refusals.map(dto),
			counts: Object.fromEntries(this.counts),
			logsSuppressed: this.suppressedTotal,
		}
	}

	private logLine(entry: Entry): void {
		if (entry.at - this.windowStart >= RECORDER_LOG_WINDOW_MS) {
			this.windowStart = entry.at
			this.logged = 0
		}
		if (this.logged >= RECORDER_LOG_LIMIT) {
			this.suppressedInWindow++
			this.suppressedTotal++
			return
		}
		this.logged++
		const suppressed = this.suppressedInWindow
		this.suppressedInWindow = 0
		this.log.info(
			{ ...fields(entry), ...(suppressed > 0 ? { suppressed } : {}) },
			"Analog recorder decision",
		)
	}
}

function fields(entry: Entry): Record<string, string | null> {
	return {
		decision: entry.code,
		sourceId: entry.sourceId,
		observationId: entry.observationId,
		discoveryId: entry.discoveryId,
	}
}

function dto(e: Entry): ScannerRecorderDecisionEntry {
	return {
		code: e.code,
		at: new Date(e.at).toISOString(),
		sourceId: e.sourceId,
		observationId: e.observationId,
		discoveryId: e.discoveryId,
	}
}
