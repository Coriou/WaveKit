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
import type { CoreLoadEvidence, CoreLoadSignal } from "./core-load.js"
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
export type { CoreLoadEvidence }

/**
 * The cause ladder for a `dropping` advisory (rule v3, stateless) over the cause window W (see
 * `LINK_CAUSE_LOOKBACK_MAX_MS`): `eluMax` the worst 2 s take's event-loop utilisation over W and
 * its guard take, `eluComplete` whether every such take was read, `eluLive` the in-progress
 * take's utilisation (at least 500 ms long), `loopDelayMaxMs` the worst loop delay over W from
 * one recorder cell earlier (with the in-progress interval; missing once the monitor stopped
 * taking), and `arrivalGapMaxMs` the source's longest arrival gap over W. Evaluated in order;
 * an input that is missing, negative or non-finite (utilisation also above 1) fails its step,
 * so missing evidence answers `unknown`, never `source`.
 * 1. `eluMax` >= `CORE_BUSY_ELU` (any take read) or loop delay >= `CORE_BUSY_LOOP_DELAY_MS`:
 *    `core-busy`, meaning the link was not assessed: a stressed core in W explains loss in the
 *    average. Precedence over an arrival gap is deliberate: under stress the gap excess is not
 *    trustworthy (the stall's own gap, reads queued behind work).
 * 2. loop delay and gap read, gap beyond the loop delay by >= `LINK_GAP_MS` (the gap the loop
 *    cannot explain, as the drop attribution reads it): `source`.
 * 3. every take read (`eluComplete`), `eluMax` < `SOURCE_ELU_MAX`, the in-progress take absent
 *    or under `SOURCE_ELU_MAX` (a veto only: it never asserts `core-busy`), loop delay <
 *    `HOST_LOOP_DELAY_MS` and a gap read: the core had headroom throughout W, `source`.
 * 4. otherwise `unknown`: a take between `SOURCE_ELU_MAX` and `CORE_BUSY_ELU`, a loop delay
 *    between `HOST_LOOP_DELAY_MS` and `CORE_BUSY_LOOP_DELAY_MS`, or missing evidence.
 * Why it holds without state: W spans the whole averaged window, so loss the core caused leaves
 * the average no later than the stressed takes that caused it leave W, and the guard take keeps
 * the wholly stressed take before one that straddles the end of a starvation; the tail of a
 * starvation cannot read `source`. At onset one stressed take in W reads `core-busy`; a worst
 * take, unlike the window mean, is not diluted by the healthy time before it. A steady link
 * shortfall after the core recovered reads `source` once W holds only healthy takes. Evidence at
 * a threshold (a take at 0.69 then 0.71) may flip the reason between `source` and `unknown`
 * from one recheck to the next; that is accepted.
 */
export function droppingCause(evidence: {
	eluMax: number | null
	eluComplete: boolean
	eluLive: number | null
	loopDelayMaxMs: number | null
	arrivalGapMaxMs: number | null
}): DroppingCause {
	const fraction = (value: number | null) =>
		valid(value) && value <= 1 ? value : null
	const eluMax = fraction(evidence.eluMax)
	const live = fraction(evidence.eluLive)
	const loop = valid(evidence.loopDelayMaxMs) ? evidence.loopDelayMaxMs : null
	const gap = valid(evidence.arrivalGapMaxMs) ? evidence.arrivalGapMaxMs : null
	if (
		(eluMax !== null && eluMax >= CORE_BUSY_ELU) ||
		(loop !== null && loop >= CORE_BUSY_LOOP_DELAY_MS)
	)
		return "core-busy"
	if (loop === null || gap === null) return "unknown"
	if (gap - loop >= LINK_GAP_MS) return "source"
	if (
		evidence.eluComplete &&
		eluMax !== null &&
		eluMax < SOURCE_ELU_MAX &&
		(live === null || live < SOURCE_ELU_MAX) &&
		loop < HOST_LOOP_DELAY_MS
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
	coreLoad: (sinceMono: number) => CoreLoadEvidence
	arrivalGapMaxMs: (sourceId: string, sinceMono: number) => number | null
} {
	return {
		coreLoad: since => deps.coreLoad.read(since),
		arrivalGapMaxMs: (id, since) =>
			deps.recorderOf(id)?.interval(since, deps.monoNow())?.maxGapMs ?? null,
	}
}

/**
 * How far back the cause window W reaches. `dropping` is the received average over
 * `LINK_SUSTAINED_WINDOW_MS` ending at the LAST metrics observation, and each observation
 * describes the `SOURCE_METRICS_INTERVAL_MS` before it; so the loss behind it lies after the
 * retained observation that bounds the window. W = [max(that observation, now - this), now],
 * the observation mapped from the wall clock to the monotonic clock by its age; with no average
 * (a `dropping` from upstream drops alone) W is the last `LINK_SUSTAINED_WINDOW_MS`. The cap
 * holds when timer jitter leaves the bounding observation ~20 s back: the ingest recorder
 * answers only 15.75 s of arrival cells. The arrival gap and the takes are read over W, the
 * loop delay from one recorder cell (`INGEST_CELL_MS`) earlier, so a stall whose arrival gap is
 * stamped in W's first cell has its loop delay in W too.
 */
export const LINK_CAUSE_LOOKBACK_MAX_MS =
	LINK_SUSTAINED_WINDOW_MS + SOURCE_METRICS_INTERVAL_MS

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
 * so a sustained link failure would also read as a slower dongle. When the core takes control
 * back, `wireDecoderLinkFeed` resets the advisor, so a shortfall accrued under external control
 * never reads `source` afterwards.
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
	coreLoad?: (sinceMono: number) => CoreLoadEvidence
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
	const excluded = (sourceId: string): boolean => {
		try {
			return deps.sourceCauseExcluded?.(sourceId) === true
		} catch {
			return false
		}
	}
	const decideCause = (
		sourceId: string,
		mono: number,
		lookbackMs: number,
	): DroppingCause => {
		const since = mono - lookbackMs
		let cause: DroppingCause = "unknown"
		try {
			// Two reads of the one signal: the takes over W, the loop delay from a cell earlier.
			const takes = deps.coreLoad?.(since)
			const loop = deps.coreLoad?.(since - INGEST_CELL_MS)
			cause = droppingCause({
				eluMax: takes?.eluMax ?? null,
				eluComplete: takes?.eluComplete === true,
				eluLive: takes?.eluLive ?? null,
				loopDelayMaxMs: loop?.loopDelayMaxMs ?? null,
				arrivalGapMaxMs: deps.arrivalGapMaxMs?.(sourceId, since) ?? null,
			})
		} catch {
			/* Missing evidence reads unknown. */
		}
		return cause === "source" && excluded(sourceId) ? "unknown" : cause
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
			const lossReason: LinkLossReason | null = loopback
				? null
				: dropping
					? Number.isFinite(mono)
						? decideCause(
								input.sourceId,
								mono,
								// With no average (upstream drops alone) W is the sustained window.
								lookbackOf(received === null ? undefined : history, wallNow),
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
		},
	}
}
