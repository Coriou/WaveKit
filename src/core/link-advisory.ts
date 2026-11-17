import { isIP } from "node:net"
import type { LinkAdvisory, LinkBurstSummary } from "@wavekit/api-types"
import {
	HOST_LOOP_DELAY_MS,
	INGEST_CELL_MS,
	LINK_DROPPING_HOLD_MS,
	LINK_GAP_MS,
	SOURCE_METRICS_INTERVAL_MS,
} from "./link-burst/contract.js"
import type { IngestRecorder } from "./link-burst/contract.js"
import type { LinkAdvisor } from "./rate-policy-contract.js"
import {
	CORE_BUSY_ELU,
	CORE_BUSY_LOOP_DELAY_MS,
	SOURCE_ELU_MAX,
} from "./core-load.js"
import type { CoreLoadReading, CoreLoadSignal } from "./core-load.js"
import {
	LINK_SHORTFALL_PERCENT,
	LINK_SUSTAINED_WINDOW_MS,
	LINK_UPSTREAM_DROPS_BYTES_PER_SECOND,
} from "./rate-policy-contract.js"

export function isLoopbackHost(host: string): boolean {
	return (
		host.toLowerCase() === "localhost" ||
		host === "::1" ||
		(isIP(host) === 4 && host.startsWith("127."))
	)
}

/** Why samples were lost: see `LinkAdvisory.lossReason`. */
export type LinkLossReason = NonNullable<LinkAdvisory["lossReason"]>
/** Who failed to move the bytes of a `dropping` advisory. */
export type DroppingCause = Extract<
	LinkLossReason,
	"source" | "core-busy" | "unknown"
>

export { CORE_BUSY_ELU, SOURCE_ELU_MAX }
/** Core-load evidence over a window, as the advisor reads it: THE core load signal's reading. */
export type CoreLoadEvidence = CoreLoadReading

/**
 * The cause ladder for a `dropping` advisory, evaluated in order; a step whose inputs are
 * missing, negative or non-finite (utilisation also above 1) is skipped, so missing evidence
 * answers `unknown`, never `source`.
 * 1. utilisation >= `CORE_BUSY_ELU`: `core-busy` (needs only utilisation);
 * 2. arrival gap beyond the loop delay by >= `LINK_GAP_MS` (the gap the loop cannot
 *    explain, as the drop attribution reads it): `source` (needs loop delay and gap);
 * 3. loop delay >= `CORE_BUSY_LOOP_DELAY_MS` (`LINK_GAP_MS`): `core-busy` (needs loop delay
 *    and gap, since step 2 takes precedence);
 * 4. loop delay < `HOST_LOOP_DELAY_MS` and utilisation < `SOURCE_ELU_MAX`: `source` (needs
 *    all three);
 * 5. otherwise `unknown`.
 * Utilisation goes missing after a long stall (the meter has no interval over the window), so
 * steps 2 and 3 must not depend on it.
 */
export function droppingCause(evidence: {
	elu: number | null
	loopDelayMaxMs: number | null
	arrivalGapMaxMs: number | null
}): DroppingCause {
	const { elu, loopDelayMaxMs: loop, arrivalGapMaxMs: gap } = evidence
	const utilisation = valid(elu) && elu <= 1 ? elu : null
	// A saturated loop is core-busy on its own.
	if (utilisation !== null && utilisation >= CORE_BUSY_ELU) return "core-busy"
	if (!valid(loop) || !valid(gap)) return "unknown"
	if (gap - loop >= LINK_GAP_MS) return "source"
	if (loop >= CORE_BUSY_LOOP_DELAY_MS) return "core-busy"
	if (
		utilisation !== null &&
		loop < HOST_LOOP_DELAY_MS &&
		utilisation < SOURCE_ELU_MAX
	)
		return "source"
	return "unknown"
}

interface History {
	rate: number
	samples: Array<{ at: number; bytes: number }>
	sustained: number | null
}

function valid(value: number | null | undefined): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0
}

// Ignore rounding noise in the time-weighted average at the shortfall boundary.
const exceedsShortfall = (received: number, payload: number): boolean =>
	received < payload * (1 - LINK_SHORTFALL_PERCENT / 100) - payload * 1e-9

/**
 * The advisor's cause evidence as production wires it: core load from THE core load signal, and
 * the source's longest arrival gap from its ingest recorder, both on the link-burst clock
 * `monoNow` that stamps the recorder's chunks and the loop meter's intervals.
 */
export function linkAdvisorEvidence(deps: {
	coreLoad: CoreLoadSignal
	recorderOf: (
		sourceId: string,
	) => Pick<IngestRecorder, "interval"> | null | undefined
	monoNow: () => number
}): {
	coreLoad: (sinceMono: number) => CoreLoadReading
	arrivalGapMaxMs: (sourceId: string, sinceMono: number) => number | null
} {
	return {
		coreLoad: since => deps.coreLoad.read(since),
		arrivalGapMaxMs: (id, since) =>
			deps.recorderOf(id)?.interval(since, deps.monoNow())?.maxGapMs ?? null,
	}
}

/**
 * How far back a `dropping` cause looks for evidence. `dropping` is the received average over
 * `LINK_SUSTAINED_WINDOW_MS` ending at the LAST metrics observation, and each observation
 * describes the `SOURCE_METRICS_INTERVAL_MS` before it; so the loss behind it can lie in the
 * interval starting at the observation that bounds the window, up to
 * `LINK_SUSTAINED_WINDOW_MS + SOURCE_METRICS_INTERVAL_MS` (15 s) before now. The evidence
 * window spans back to that observation, at least the sustained window and at most this bound
 * (the ingest recorder answers 15.75 s of arrival cells; the loop meter's ring and ELU base
 * cover it with room).
 */
export const LINK_CAUSE_LOOKBACK_MAX_MS =
	LINK_SUSTAINED_WINDOW_MS + SOURCE_METRICS_INTERVAL_MS

/**
 * How long the stretch rule holds a `core-busy` decision against a fresh `source`. Loss a
 * core-busy decision at `T` explains lies at or before `T`. The dropping average at `now` ends
 * at the last metrics observation, at most `SOURCE_METRICS_INTERVAL_MS` (5 s) before `now`, and
 * reaches back at most `LINK_CAUSE_LOOKBACK_MAX_MS` (15 s) before that observation; so once
 * `now - T > LINK_CAUSE_LOOKBACK_MAX_MS + SOURCE_METRICS_INTERVAL_MS` (20 s), none of that loss
 * is in the average and the decision no longer bears on the cause.
 */
export const CORE_BUSY_STRETCH_MS =
	LINK_CAUSE_LOOKBACK_MAX_MS + SOURCE_METRICS_INTERVAL_MS

/** The source manager facts the advisor's `live` gate reads. */
export interface LiveSourceFacts {
	getStatus(id: string): { connected: boolean } | undefined
	isPaused(id: string): boolean
}

/**
 * Production's `live` gate: the source is connected and its feed is live (not paused, resuming or
 * failed to resume by the operator). A missing source is not live.
 */
export function sourceIsLive(sources: LiveSourceFacts, id: string): boolean {
	return sources.getStatus(id)?.connected === true && !sources.isPaused(id)
}

/**
 * Production's `sourceCauseExcluded` facts: while the tuner is under external control, a
 * shortfall is no proof that the link fails to carry the rate the core set, so `source` reads
 * `unknown`. A rate-truth mismatch is not a reason: rate truth measures the same received bytes,
 * so a sustained link failure would also read as a slower dongle.
 */
export function sourceCauseExcluded(
	deps: { controlModeOf: (id: string) => string | null | undefined },
	id: string,
): boolean {
	return deps.controlModeOf(id) === "external"
}

export function createLinkAdvisor(deps: {
	now: () => number
	monoNow?: () => number
	linkDropsSince?: (sourceId: string, sinceMono: number) => boolean
	burst?: (sourceId: string) => LinkBurstSummary | null
	/**
	 * THE core load signal's read over the window starting at `sinceMono` (`CoreLoadSignal.read`);
	 * absent: causes read `unknown`.
	 */
	coreLoad?: (sinceMono: number) => CoreLoadReading
	/** Longest arrival gap (ms) of the source since `sinceMono`; absent: causes read `unknown`. */
	arrivalGapMaxMs?: (sourceId: string, sinceMono: number) => number | null
	/**
	 * Whether the source is connected with a live feed (not disconnected, and not paused or
	 * resuming by the operator); absent or throwing: live. A source that is not live is never
	 * classified: its observations are dropped (its window starts afresh once live again), and
	 * it reads level `none` with no `lossReason`, so a disconnect or a pause never reads as loss.
	 */
	live?: (sourceId: string) => boolean
	/**
	 * Whether a `source` cause is ruled out for now (see `sourceCauseExcluded`); true: a decided
	 * `source` reads `unknown`. Absent or throwing: not excluded.
	 */
	sourceCauseExcluded?: (sourceId: string) => boolean
}): LinkAdvisor & Required<Pick<LinkAdvisor, "shortfall">> {
	const histories = new Map<string, History>()
	const isLive = (sourceId: string): boolean => {
		try {
			return deps.live?.(sourceId) !== false
		} catch {
			return true
		}
	}
	/**
	 * Latch rule: a known cause (`source` or `core-busy`) decided for a source at a rate is
	 * kept for `LINK_SUSTAINED_WINDOW_MS` after the decision, so the reason does not flap
	 * tick to tick on evidence at a threshold; it is then decided afresh. `unknown` is never
	 * latched, so the first known cause replaces it. The latch is dropped when the source
	 * stops dropping at that rate, or on `reset`; a classification at another rate (a
	 * hypothetical raise) neither reads nor changes it.
	 */
	const latches = new Map<
		string,
		{ rate: number; cause: DroppingCause; until: number }
	>()
	/**
	 * Stretch rule: within one dropping stretch at a rate (ended like the latch), once the core
	 * was found busy, a fresh `source` decision stands only on arrival-gap evidence (ladder step
	 * 2) newer than that core-busy decision; otherwise `core-busy` is kept, because the loss
	 * still in the average may be the core's (and missing evidence for that gap reads
	 * `unknown`). The rule expires `CORE_BUSY_STRETCH_MS` after the core-busy decision, when no
	 * loss it explained can still be in the average, and a kept `core-busy` is latched no longer.
	 */
	const coreBusyAt = new Map<string, { rate: number; at: number }>()
	const dropStretch = (sourceId: string, rate: number) => {
		if (latches.get(sourceId)?.rate === rate) latches.delete(sourceId)
		if (coreBusyAt.get(sourceId)?.rate === rate) coreBusyAt.delete(sourceId)
	}
	// Loop delay is read from one recorder cell earlier than the gap, so a stall whose arrival
	// gap is stamped in the window's first cell has its loop delay in the window too.
	const evidence = (sourceId: string, since: number) => {
		const load = deps.coreLoad?.(since - INGEST_CELL_MS)
		return {
			elu: load?.elu ?? null,
			loopDelayMaxMs: load?.loopDelayMaxMs ?? null,
			arrivalGapMaxMs: deps.arrivalGapMaxMs?.(sourceId, since) ?? null,
		}
	}
	const excluded = (sourceId: string): boolean => {
		try {
			return deps.sourceCauseExcluded?.(sourceId) === true
		} catch {
			return false
		}
	}
	const decideAfresh = (
		sourceId: string,
		rate: number,
		mono: number,
		lookbackMs: number,
	): DroppingCause => {
		const latch = latches.get(sourceId)
		const since = mono - lookbackMs
		let cause: DroppingCause = "unknown"
		let until = mono + LINK_SUSTAINED_WINDOW_MS
		try {
			cause = droppingCause(evidence(sourceId, since))
			let busy = coreBusyAt.get(sourceId)
			if (busy?.rate === rate && mono - busy.at > CORE_BUSY_STRETCH_MS) {
				coreBusyAt.delete(sourceId)
				busy = undefined
			}
			if (cause === "source" && busy?.rate === rate) {
				// Only a gap the loop cannot explain since the core-busy decision may replace it.
				const fresh = evidence(sourceId, Math.max(since, busy.at))
				const { loopDelayMaxMs: loop, arrivalGapMaxMs: gap } = fresh
				if (!valid(loop) || !valid(gap)) cause = "unknown"
				else if (gap - loop < LINK_GAP_MS) {
					cause = "core-busy"
					until = Math.min(until, busy.at + CORE_BUSY_STRETCH_MS)
				} else coreBusyAt.delete(sourceId)
			} else if (cause === "core-busy")
				coreBusyAt.set(sourceId, { rate, at: mono })
		} catch {
			/* Missing evidence reads unknown. */
		}
		if (cause === "unknown") {
			if (latch?.rate === rate) latches.delete(sourceId)
		} else latches.set(sourceId, { rate, cause, until })
		return cause
	}
	const decideCause = (
		sourceId: string,
		rate: number,
		mono: number,
		lookbackMs: number,
	): DroppingCause => {
		const latch = latches.get(sourceId)
		const known =
			latch && latch.rate === rate && mono < latch.until
				? latch.cause
				: decideAfresh(sourceId, rate, mono, lookbackMs)
		return known === "source" && excluded(sourceId) ? "unknown" : known
	}
	/** The evidence lookback for a dropping decision now (see `LINK_CAUSE_LOOKBACK_MAX_MS`). */
	const lookbackOf = (history: History | undefined, at: number): number => {
		const first = history?.samples[0]?.at
		const span = first === undefined ? Number.NaN : at - first
		return Number.isFinite(span)
			? Math.min(
					LINK_CAUSE_LOOKBACK_MAX_MS,
					Math.max(LINK_SUSTAINED_WINDOW_MS, span),
				)
			: LINK_SUSTAINED_WINDOW_MS
	}
	const average = (history: History, at: number): number | null => {
		const samples = history.samples
		const first = samples[0]
		const last = samples.at(-1)
		if (
			!first ||
			!last ||
			last.at > at ||
			at - last.at > LINK_SUSTAINED_WINDOW_MS ||
			last.at - first.at < LINK_SUSTAINED_WINDOW_MS
		)
			return null
		// Metrics describe the byte rate over the interval ending at each observation.
		const start = last.at - LINK_SUSTAINED_WINDOW_MS
		let total = 0
		for (let i = 1; i < samples.length; i++) {
			const sample = samples[i]
			const previous = samples[i - 1]
			if (sample && previous)
				total +=
					sample.bytes *
					((sample.at - Math.max(start, previous.at)) /
						LINK_SUSTAINED_WINDOW_MS)
		}
		return total
	}
	return {
		observe(sourceId, bytes, rate, at) {
			const previous = histories.get(sourceId)
			const live = isLive(sourceId)
			if (!live) {
				latches.delete(sourceId)
				coreBusyAt.delete(sourceId)
			}
			if (
				!live ||
				!valid(bytes) ||
				!valid(rate) ||
				rate === 0 ||
				!Number.isFinite(at)
			) {
				if (previous) previous.samples = []
				return
			}
			const history = previous ?? { rate, samples: [], sustained: null }
			if (
				history.rate !== rate ||
				at <= (history.samples.at(-1)?.at ?? -Infinity)
			)
				history.samples = []
			history.rate = rate
			history.samples.push({ at, bytes })
			// Retain the observation bounding the start of the rolling window.
			while (
				history.samples.length > 2 &&
				(history.samples[1]?.at ?? at) <= at - LINK_SUSTAINED_WINDOW_MS
			)
				history.samples.shift()
			const received = average(history, at)
			if (received !== null && !exceedsShortfall(received, rate * 2))
				history.sustained = Math.max(history.sustained ?? 0, received)
			histories.set(sourceId, history)
		},
		shortfall(sourceId, sampleRateHz, frameBytes) {
			const history = histories.get(sourceId)
			if (
				!history ||
				!isLive(sourceId) ||
				history.rate !== sampleRateHz ||
				!valid(sampleRateHz) ||
				sampleRateHz === 0 ||
				!valid(frameBytes) ||
				frameBytes === 0
			)
				return null
			const received = average(history, deps.now())
			return received === null
				? null
				: exceedsShortfall(received, sampleRateHz * frameBytes)
		},
		classify(input, drops): LinkAdvisory {
			const payload = valid(input.sampleRateHz) ? input.sampleRateHz * 2 : 0
			const history = histories.get(input.sourceId)
			if (!isLive(input.sourceId)) {
				latches.delete(input.sourceId)
				coreBusyAt.delete(input.sourceId)
				return {
					level: "none",
					transport: isLoopbackHost(input.host) ? "loopback" : "network",
					payloadBytesPerSecond: payload,
					sustainedBytesPerSecond: history?.sustained ?? null,
					shortfallPercent: null,
					upstreamDropBytesPerSecond: null,
				}
			}
			const wallNow = deps.now()
			const received =
				history?.rate === input.sampleRateHz ? average(history, wallNow) : null
			const shortfall =
				received !== null && payload > 0
					? Math.max(0, ((payload - received) / payload) * 100)
					: null
			const upstream = valid(drops) ? drops : null
			const loopback = isLoopbackHost(input.host)
			const sustained = history?.sustained ?? null
			let linkDropping = false
			let burst: LinkBurstSummary | null = null
			let mono = Number.NaN
			try {
				mono = deps.monoNow?.() ?? performance.now()
			} catch {
				/* An unreadable clock leaves the cause unknown. */
			}
			if (!loopback) {
				try {
					linkDropping =
						Number.isFinite(mono) &&
						deps.linkDropsSince?.(
							input.sourceId,
							mono - LINK_DROPPING_HOLD_MS,
						) === true
				} catch {
					/* Optional evidence is unavailable. */
				}
				try {
					burst = deps.burst?.(input.sourceId) ?? null
				} catch {
					/* Optional summary is unavailable. */
				}
			}
			// Only loss before the core's fanout raises `dropping`; the cause ladder
			// then says whether the link or the core's own loop failed to move the
			// bytes. Internal branch drops after an arrival gap are reported apart
			// and never raise `dropping`.
			const dropping =
				(received !== null && exceedsShortfall(received, payload)) ||
				(upstream !== null && upstream > LINK_UPSTREAM_DROPS_BYTES_PER_SECOND)
			if (!dropping) dropStretch(input.sourceId, input.sampleRateHz)
			const lossReason: LinkLossReason | null = loopback
				? null
				: dropping
					? Number.isFinite(mono)
						? decideCause(
								input.sourceId,
								input.sampleRateHz,
								mono,
								lookbackOf(
									history?.rate === input.sampleRateHz ? history : undefined,
									wallNow,
								),
							)
						: "unknown"
					: linkDropping
						? "branch-congestion"
						: null
			return {
				level: loopback
					? "none"
					: dropping
						? "dropping"
						: sustained === null || sustained < payload
							? "unproven"
							: "none",
				transport: loopback ? "loopback" : "network",
				payloadBytesPerSecond: payload,
				sustainedBytesPerSecond: sustained,
				shortfallPercent: shortfall,
				upstreamDropBytesPerSecond: upstream,
				...(burst === null ? {} : { burst }),
				...(lossReason === null ? {} : { lossReason }),
			}
		},
		reset(sourceId) {
			histories.delete(sourceId)
			latches.delete(sourceId)
			coreBusyAt.delete(sourceId)
		},
	}
}
