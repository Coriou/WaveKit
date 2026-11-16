import { isIP } from "node:net"
import type { LinkAdvisory, LinkBurstSummary } from "@wavekit/api-types"
import {
	HOST_LOOP_DELAY_MS,
	LINK_DROPPING_HOLD_MS,
	LINK_GAP_MS,
} from "./link-burst/contract.js"
import type { LinkAdvisor } from "./rate-policy-contract.js"
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

/**
 * Event-loop utilisation at or above this over the advisory window means the core itself is
 * saturated: at 90 % busy the loop is idle about 1 s in 10, so socket reads queue behind
 * other work and a shortfall is the core's, whatever the link does.
 */
export const CORE_BUSY_ELU = 0.9
/**
 * Below this utilisation (with loop delay under `HOST_LOOP_DELAY_MS`) the core had headroom
 * to read every byte offered: 30 % idle is roughly 3 s free per 10 s window, so a shortfall
 * is the receiver link's. Between this and `CORE_BUSY_ELU` the evidence is ambiguous.
 *
 * The loop-delay thresholds come from the link-burst contract: a `LINK_GAP_MS` (200 ms)
 * stall at 2.4 MS/s U8 IQ is 2.4e6 * 2 B * 0.2 s = 960 kB, more than typical kernel socket
 * receive buffers hold, so a stall that long can lose bytes before the core reads them; a
 * stall under `HOST_LOOP_DELAY_MS` (50 ms, 240 kB at that rate) fits the buffers and cannot.
 */
export const SOURCE_ELU_MAX = 0.7

/** Core-load evidence over a window, as the advisor reads it (null: unavailable). */
export interface CoreLoadEvidence {
	/** Event-loop utilisation (0..1) over the window. */
	elu: number | null
	/** Worst event-loop delay (ms) over the window, including the in-progress interval. */
	loopDelayMaxMs: number | null
}

/**
 * The cause ladder for a `dropping` advisory, evaluated in order; any missing, negative or
 * non-finite input answers `unknown`, never `source`.
 * 1. utilisation >= `CORE_BUSY_ELU`: `core-busy` (needs only utilisation);
 * 2. arrival gap beyond the loop delay by >= `LINK_GAP_MS` (the gap the loop cannot
 *    explain, as the drop attribution reads it): `source`;
 * 3. loop delay >= `LINK_GAP_MS`: `core-busy`;
 * 4. loop delay < `HOST_LOOP_DELAY_MS` and utilisation < `SOURCE_ELU_MAX`: `source`;
 * 5. otherwise `unknown`.
 */
export function droppingCause(evidence: {
	elu: number | null
	loopDelayMaxMs: number | null
	arrivalGapMaxMs: number | null
}): DroppingCause {
	const { elu, loopDelayMaxMs: loop, arrivalGapMaxMs: gap } = evidence
	// A saturated loop is core-busy on its own; every later step needs all three inputs.
	if (valid(elu) && elu <= 1 && elu >= CORE_BUSY_ELU) return "core-busy"
	if (!valid(elu) || elu > 1 || !valid(loop) || !valid(gap)) return "unknown"
	if (gap - loop >= LINK_GAP_MS) return "source"
	if (loop >= LINK_GAP_MS) return "core-busy"
	if (loop < HOST_LOOP_DELAY_MS && elu < SOURCE_ELU_MAX) return "source"
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

export function createLinkAdvisor(deps: {
	now: () => number
	monoNow?: () => number
	linkDropsSince?: (sourceId: string, sinceMono: number) => boolean
	burst?: (sourceId: string) => LinkBurstSummary | null
	/** Core load over the window starting at `sinceMono`; absent: causes read `unknown`. */
	coreLoad?: (sinceMono: number) => CoreLoadEvidence
	/** Longest arrival gap (ms) of the source since `sinceMono`; absent: causes read `unknown`. */
	arrivalGapMaxMs?: (sourceId: string, sinceMono: number) => number | null
}): LinkAdvisor & Required<Pick<LinkAdvisor, "shortfall">> {
	const histories = new Map<string, History>()
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
	const decideCause = (
		sourceId: string,
		rate: number,
		mono: number,
	): DroppingCause => {
		const latch = latches.get(sourceId)
		if (latch && latch.rate === rate && mono < latch.until) return latch.cause
		const since = mono - LINK_SUSTAINED_WINDOW_MS
		let cause: DroppingCause = "unknown"
		try {
			const load = deps.coreLoad?.(since)
			const gap = deps.arrivalGapMaxMs?.(sourceId, since)
			cause = droppingCause({
				elu: load?.elu ?? null,
				loopDelayMaxMs: load?.loopDelayMaxMs ?? null,
				arrivalGapMaxMs: gap ?? null,
			})
		} catch {
			/* Missing evidence reads unknown. */
		}
		if (cause === "unknown") {
			if (latch?.rate === rate) latches.delete(sourceId)
		} else
			latches.set(sourceId, {
				rate,
				cause,
				until: mono + LINK_SUSTAINED_WINDOW_MS,
			})
		return cause
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
			if (!valid(bytes) || !valid(rate) || rate === 0 || !Number.isFinite(at)) {
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
			const received =
				history?.rate === input.sampleRateHz
					? average(history, deps.now())
					: null
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
			if (!dropping) {
				const latch = latches.get(input.sourceId)
				if (latch?.rate === input.sampleRateHz) latches.delete(input.sourceId)
			}
			const lossReason: LinkLossReason | null = loopback
				? null
				: dropping
					? Number.isFinite(mono)
						? decideCause(input.sourceId, input.sampleRateHz, mono)
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
		},
	}
}
