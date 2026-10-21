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
	let cpu: number | null = null
	let maxHighCpuAt: number | null = null
	let cpuAt: number | null = null

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
		if (source.maxDropAt !== null) {
			if (source.maxDropAt > now) return "dropping"
			const age = now - source.maxDropAt
			if (age <= EFFICIENCY_DROP_WINDOW_MS) return "dropping"
			if (age < EFFICIENCY_CLEAR_MS) return "clearing"
		}
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
			// Malformed observations invalidate every baseline until valid samples arrive.
			if (!sample || !valid(sample.atMs) || !(sample.sources instanceof Map)) {
				for (const source of sources.values()) source.unknown = true
				cpu = null
				return
			}
			// Failure evidence never decreases, regardless of arrival order.
			if (
				valid(sample.cpuPercent) &&
				sample.cpuPercent > inputs.cpuGuardPercent
			)
				maxHighCpuAt = Math.max(maxHighCpuAt ?? sample.atMs, sample.atMs)
			for (const [id, counters] of sample.sources) {
				if (
					counters != null &&
					((valid(counters.droppedBytesDelta) &&
						counters.droppedBytesDelta > 0) ||
						(valid(counters.droppedChunksDelta) &&
							counters.droppedChunksDelta > 0))
				) {
					let source = sources.get(id)
					if (!source) {
						source = {
							unknown: true,
							at: sample.atMs,
							maxDropAt: null,
							rate: null,
						}
						sources.set(id, source)
					}
					source.maxDropAt = Math.max(
						source.maxDropAt ?? sample.atMs,
						sample.atMs,
					)
				}
			}
			cpuAt = sample.atMs
			cpu = valid(sample.cpuPercent) ? sample.cpuPercent : null
			for (const [id, source] of sources) {
				if (!sample.sources.has(id)) source.unknown = true
			}
			for (const [id, counters] of sample.sources) {
				const previous = sources.get(id)
				const known =
					counters != null &&
					valid(counters.droppedBytesDelta) &&
					valid(counters.droppedChunksDelta)
				sources.set(id, {
					unknown: !known,
					at: sample.atMs,
					maxDropAt: previous?.maxDropAt ?? null,
					rate:
						known && previous && !previous.unknown && sample.atMs > previous.at
							? (counters.droppedBytesDelta! * 1000) /
								(sample.atMs - previous.at)
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
