import type { DecoderEfficiencyDetail } from "@wavekit/api-types"
import {
	channelizerBaseCores,
	EFFICIENCY_CLEAR_MS,
	EFFICIENCY_DROP_WINDOW_MS,
	EFFICIENCY_PROBATION_MS,
	EFFICIENCY_RETRY_MS,
	EFFICIENCY_RETRY_MAX_MS,
	EFFICIENCY_SAMPLE_MS,
} from "./contract.js"
import type {
	AdmissionDecision,
	EfficiencyGate,
	EfficiencyInputs,
	RunningPlacement,
	WantedPlacement,
} from "./contract.js"

// 3 × 2000 ms = 6000 ms: tolerates one missed tick plus jitter.
const EFFICIENCY_STALE_MS = 3 * EFFICIENCY_SAMPLE_MS

const valid = (value: unknown): value is number =>
	typeof value === "number" && Number.isFinite(value) && value >= 0

/** Stateful decision core; all time and observations are supplied by the caller. */
export function createEfficiencyGate(inputs: EfficiencyInputs): EfficiencyGate {
	const sources = new Map<
		string,
		{
			unknown: boolean
			at: number
			barrierAt: number
			maxDropAt: number | null
			rate: number | null
		}
	>()
	const retries = new Map<
		string,
		{
			detail: DecoderEfficiencyDetail
			at: number
			delay: number
			pending?: boolean
		}
	>()
	const failures = new Set<string>()
	let latestAt: number | null = null
	let cpu: number | null = null
	let maxHighCpuAt: number | null = null
	let cpuAt: number | null = null

	// A far-future sample keeps every later sample classified as reordered, so
	// the gate stays closed (fail closed) until it is recreated. The caller's
	// query clock is never trusted to lower ordering or evidence marks.

	const dropState = (id: string, now: number) => {
		const source = sources.get(id)
		if (
			!valid(now) ||
			!source ||
			source.unknown ||
			source.at > now ||
			now - source.at > EFFICIENCY_STALE_MS
		)
			return "unknown"
		if (
			now - source.barrierAt < EFFICIENCY_CLEAR_MS &&
			source.barrierAt > (source.maxDropAt ?? -1)
		)
			return "unknown"
		if (source.maxDropAt !== null) {
			if (source.maxDropAt > now) return "dropping"
			const age = now - source.maxDropAt
			if (age <= EFFICIENCY_DROP_WINDOW_MS) return "dropping"
			if (age < EFFICIENCY_CLEAR_MS) return "clearing"
		}
		if (now - source.barrierAt < EFFICIENCY_CLEAR_MS) return "unknown"
		return "ok"
	}
	const currentCpu = (now: number) =>
		valid(now) &&
		cpuAt !== null &&
		now >= cpuAt &&
		now - cpuAt <= EFFICIENCY_STALE_MS
			? cpu
			: null
	const total = (
		placements: readonly (RunningPlacement | WantedPlacement)[],
	) => {
		let sum = 0
		const bases = new Map<string, number>()
		for (const placement of placements) {
			if (!valid(placement.costCores)) return Infinity
			sum += placement.costCores
			if (placement.reach === "channel") {
				if (!valid(placement.sampleRateHz) || placement.sampleRateHz === 0)
					return Infinity
				bases.set(
					placement.sourceId,
					Math.max(
						bases.get(placement.sourceId) ?? 0,
						channelizerBaseCores(placement.sampleRateHz),
					),
				)
			}
		}
		for (const base of bases.values()) sum += base
		return sum
	}
	const onProbation = (p: RunningPlacement, now: number) =>
		valid(p.admittedAtMs) &&
		now >= p.admittedAtMs &&
		now - p.admittedAtMs < EFFICIENCY_PROBATION_MS

	return {
		record(sample) {
			// Retained barriers never decrease. Unknown history must earn a
			// complete clean window, just like a newly observed source.
			if (!sample || !valid(sample.atMs) || !(sample.sources instanceof Map)) {
				const barrierAt = Math.max(
					latestAt ?? 0,
					valid(sample?.atMs) ? sample.atMs : 0,
				)
				if (barrierAt !== null)
					latestAt = Math.max(latestAt ?? barrierAt, barrierAt)
				for (const source of sources.values()) {
					source.unknown = true
					source.rate = null
					source.barrierAt = Math.max(source.barrierAt, barrierAt ?? source.at)
				}
				cpu = null
				return
			}
			const at = sample.atMs
			const reorderedTick = latestAt !== null && at <= latestAt
			const highWater = Math.max(latestAt ?? at, at)
			latestAt = Math.max(latestAt ?? at, at)
			if (
				valid(sample.cpuPercent) &&
				sample.cpuPercent > inputs.cpuGuardPercent
			)
				maxHighCpuAt = Math.max(maxHighCpuAt ?? at, at)
			cpuAt = at
			cpu = valid(sample.cpuPercent) ? sample.cpuPercent : null
			for (const [id, source] of sources) {
				if (!sample.sources.has(id)) {
					source.unknown = true
					source.rate = null
					source.barrierAt = Math.max(source.barrierAt, highWater)
					if (highWater - source.at > EFFICIENCY_CLEAR_MS) sources.delete(id)
				}
			}
			for (const [id, counters] of sample.sources) {
				const previous = sources.get(id)
				const complete =
					counters != null &&
					valid(counters.droppedBytesDelta) &&
					valid(counters.droppedChunksDelta)
				const drop =
					counters != null &&
					((valid(counters.droppedBytesDelta) &&
						counters.droppedBytesDelta > 0) ||
						(valid(counters.droppedChunksDelta) &&
							counters.droppedChunksDelta > 0))
				const reordered =
					reorderedTick || (previous !== undefined && at <= previous.at)
				const gap =
					previous !== undefined && at - previous.at > EFFICIENCY_STALE_MS
				const irregular = !complete || reordered || gap
				sources.set(id, {
					unknown: irregular,
					at: Math.max(previous?.at ?? at, at),
					barrierAt:
						!previous || irregular || drop
							? Math.max(previous?.barrierAt ?? highWater, highWater)
							: previous.barrierAt,
					maxDropAt: drop
						? Math.max(previous?.maxDropAt ?? highWater, highWater)
						: (previous?.maxDropAt ?? null),
					rate:
						complete &&
						!irregular &&
						previous &&
						!previous.unknown &&
						at > previous.at
							? (counters.droppedBytesDelta! * 1000) / (at - previous.at)
							: null,
				})
			}
		},
		admit(newcomer, running, now): AdmissionDecision {
			if (!valid(now)) return { admit: false, detail: "unknown", retryAtMs: 0 }
			const retry = retries.get(newcomer.key)
			if (retry?.pending) {
				retry.at = Math.max(retry.at, now + retry.delay)
				delete retry.pending
			}
			if (retry && now < retry.at) {
				return { admit: false, detail: retry.detail, retryAtMs: retry.at }
			}
			const state = dropState(newcomer.sourceId, now)
			let detail: DecoderEfficiencyDetail | null = null
			if (!valid(now) || state === "unknown") detail = "unknown"
			else if (state !== "ok") detail = "drops"
			else if (!valid(inputs.cpuGuardPercent)) detail = "unknown"
			else if ((currentCpu(now) ?? 0) > inputs.cpuGuardPercent) detail = "cpu"
			else if (
				!valid(inputs.budgetCores) ||
				!Number.isFinite(total([...running, newcomer])) ||
				total([...running, newcomer]) > inputs.budgetCores
			)
				detail = "budget"
			if (detail === null) return { admit: true }
			const at = (valid(now) ? now : 0) + (retry?.delay ?? EFFICIENCY_RETRY_MS)
			retries.set(newcomer.key, {
				detail,
				at,
				delay: retry?.delay ?? EFFICIENCY_RETRY_MS,
			})
			return { admit: false, detail, retryAtMs: at }
		},
		// Unknown observations close admission, but are not probation verdicts.
		probation(running, now) {
			const newest = new Map<string, RunningPlacement>()
			if (!valid(now)) return []
			for (const placement of running) {
				if (!onProbation(placement, now)) continue
				const previous = newest.get(placement.sourceId)
				if (!previous || placement.admittedAtMs > previous.admittedAtMs) {
					newest.set(placement.sourceId, placement)
				}
			}
			const verdicts: { key: string; detail: "drops" | "cpu" }[] = []
			for (const placement of newest.values()) {
				const maxDropAt = sources.get(placement.sourceId)?.maxDropAt
				let detail: "drops" | "cpu" | null = null
				if (maxDropAt != null && maxDropAt >= placement.admittedAtMs) {
					detail = "drops"
				} else if (
					maxHighCpuAt !== null &&
					maxHighCpuAt >= placement.admittedAtMs
				) {
					detail = "cpu"
				}
				if (detail) {
					failures.add(placement.key)
					verdicts.push({ key: placement.key, detail })
				}
			}
			return verdicts
		},
		noteSuspended(key, detail, now) {
			const previous = retries.get(key)
			const delay =
				failures.delete(key) && previous
					? Math.min(previous.delay * 2, EFFICIENCY_RETRY_MAX_MS)
					: (previous?.delay ?? EFFICIENCY_RETRY_MS)
			retries.set(key, {
				detail,
				delay,
				at: valid(now) ? now + delay : (previous?.at ?? 0),
				...(!valid(now) ? { pending: true } : {}),
			})
		},
		forget(key) {
			retries.delete(key)
			failures.delete(key)
		},
		view(running, blocked, now) {
			const ids = new Set([
				...sources.keys(),
				...running.map(p => p.sourceId),
				...blocked.map(b => b.placement.sourceId),
			])
			return {
				budgetCores: inputs.budgetCores,
				cpuGuardPercent: inputs.cpuGuardPercent,
				sources: [...ids].map(sourceId => ({
					sourceId,
					coresInUse: total(running.filter(p => p.sourceId === sourceId)),
					cpu: { percent: currentCpu(now), limit: inputs.cpuGuardPercent },
					drops: dropState(sourceId, now),
					dropBytesPerSecond:
						dropState(sourceId, now) === "unknown"
							? null
							: (sources.get(sourceId)?.rate ?? null),
					admitted: running
						.filter(p => p.sourceId === sourceId)
						.map(p => {
							const separator = p.key.lastIndexOf("#")
							const channel = p.key.slice(separator + 1, p.key.lastIndexOf("@"))
							return {
								decoderId: p.key.slice(0, separator),
								sourceId,
								channelHz:
									p.reach === "channel" && valid(Number(channel))
										? Number(channel)
										: null,
								reach: p.reach,
								costCores: p.costCores,
								probation: onProbation(p, now),
							}
						}),
					blocked: blocked
						.filter(b => b.placement.sourceId === sourceId && !b.decision.admit)
						.map(({ placement: p, decision }) => ({
							decoderId: p.decoderId,
							sourceId,
							channelHz: p.channelHz,
							reach: p.reach,
							costCores: p.costCores,
							probation: false,
							...(!decision.admit
								? {
										detail: decision.detail,
										retryAt: new Date(decision.retryAtMs).toISOString(),
									}
								: {}),
						})),
				})),
			}
		},
	}
}
