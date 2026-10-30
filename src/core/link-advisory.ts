import { isIP } from "node:net"
import type { LinkAdvisory, LinkBurstSummary } from "@wavekit/api-types"
import { LINK_DROPPING_HOLD_MS } from "./link-burst/contract.js"
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

interface History {
	rate: number
	samples: Array<{ at: number; bytes: number }>
	sustained: number | null
}

const valid = (value: number | null): value is number =>
	value !== null && Number.isFinite(value) && value >= 0

// Ignore rounding noise in the time-weighted average at the shortfall boundary.
const exceedsShortfall = (received: number, payload: number): boolean =>
	received < payload * (1 - LINK_SHORTFALL_PERCENT / 100) - payload * 1e-9

export function createLinkAdvisor(deps: {
	now: () => number
	monoNow?: () => number
	linkDropsSince?: (sourceId: string, sinceMono: number) => boolean
	burst?: (sourceId: string) => LinkBurstSummary | null
}): LinkAdvisor & Required<Pick<LinkAdvisor, "shortfall">> {
	const histories = new Map<string, History>()
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
			if (!loopback) {
				try {
					linkDropping =
						deps.linkDropsSince?.(
							input.sourceId,
							(deps.monoNow?.() ?? performance.now()) - LINK_DROPPING_HOLD_MS,
						) ?? false
				} catch {
					/* Optional evidence is unavailable. */
				}
				try {
					burst = deps.burst?.(input.sourceId) ?? null
				} catch {
					/* Optional summary is unavailable. */
				}
			}
			// Only loss before the core is a link problem. Internal branch drops
			// after an arrival gap are reported apart and never raise `dropping`.
			const dropping =
				(received !== null && exceedsShortfall(received, payload)) ||
				(upstream !== null && upstream > LINK_UPSTREAM_DROPS_BYTES_PER_SECOND)
			const lossReason: LinkLossReason | null = loopback
				? null
				: dropping
					? "source"
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
