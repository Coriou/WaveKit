import type { DecoderEfficiencyDetail } from "@wavekit/api-types"
import {
	channelizerBaseCores,
	EFFICIENCY_PROBATION_MS,
	EFFICIENCY_RETRY_MS,
	EFFICIENCY_RETRY_MAX_MS,
	EFFICIENCY_STALE_MS,
} from "./contract.js"
import type {
	AdmissionDecision,
	EfficiencyGate,
	EfficiencyInputs,
	RunningPlacement,
	WantedPlacement,
} from "./contract.js"

const valid = (value: unknown): value is number =>
	typeof value === "number" && Number.isFinite(value) && value >= 0

/** Stateful decision core; all time and observations are supplied by the caller. */
export interface DropReader {
	dropState(id: string): {
		state: "ok" | "dropping" | "unknown"
		dropBytesPerSecond: number | null
	}
	monoNow(): number
	sources(): readonly string[]
	droppedSinceMono(id: string, sinceMono: number): boolean
	droppedWithinMs(id: string, ms: number): boolean
}

export function createEfficiencyGate(
	inputs: EfficiencyInputs,
	deps: { drops?: DropReader } = {},
): EfficiencyGate {
	const admittedMono = new Map<string, number>()
	const monoNow = () => {
		try {
			return deps.drops?.monoNow() ?? NaN
		} catch {
			return NaN
		}
	}
	const readDrops = (id: string) => {
		try {
			return (
				deps.drops?.dropState(id) ?? {
					state: "unknown" as const,
					dropBytesPerSecond: null,
				}
			)
		} catch {
			return { state: "unknown" as const, dropBytesPerSecond: null }
		}
	}
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
	// Every running key is first observed in the monotonic clock domain. Only
	// probation() prunes: an admitted key may not be running yet when admit()
	// or view() is called with a partial or earlier list.
	const observeRunning = (
		running: readonly RunningPlacement[],
		mono: number,
		prune = false,
	) => {
		if (prune) {
			const present = new Set(running.map(p => p.key))
			for (const key of admittedMono.keys())
				if (!present.has(key)) admittedMono.delete(key)
		}
		for (const placement of running)
			if (!admittedMono.has(placement.key))
				admittedMono.set(placement.key, mono)
	}
	const onProbation = (p: RunningPlacement, mono: number) => {
		const admitted = admittedMono.get(p.key) ?? NaN
		return (
			!Number.isFinite(mono) ||
			!Number.isFinite(admitted) ||
			mono - admitted < EFFICIENCY_PROBATION_MS
		)
	}

	return {
		record(sample) {
			if (!sample || !valid(sample.atMs)) {
				cpu = null
				return
			}
			const at = sample.atMs
			if (
				valid(sample.cpuPercent) &&
				sample.cpuPercent > inputs.cpuGuardPercent
			)
				maxHighCpuAt = Math.max(maxHighCpuAt ?? monoNow(), monoNow())
			cpuAt = at
			cpu = valid(sample.cpuPercent) ? sample.cpuPercent : null
		},
		admit(newcomer, running, now): AdmissionDecision {
			const mono = monoNow()
			observeRunning(running, mono)
			if (!valid(now)) return { admit: false, detail: "unknown", retryAtMs: 0 }
			const retry = retries.get(newcomer.key)
			if (retry?.pending) {
				retry.at = Math.max(retry.at, now + retry.delay)
				delete retry.pending
			}
			if (retry && now < retry.at) {
				return { admit: false, detail: retry.detail, retryAtMs: retry.at }
			}
			const state = readDrops(newcomer.sourceId).state
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
			if (detail === null) {
				// A key already running keeps its mark; any other admission starts a
				// fresh probation window.
				if (!running.some(p => p.key === newcomer.key))
					admittedMono.set(newcomer.key, mono)
				return { admit: true }
			}
			const at = (valid(now) ? now : 0) + (retry?.delay ?? EFFICIENCY_RETRY_MS)
			retries.set(newcomer.key, {
				detail,
				at,
				delay: retry?.delay ?? EFFICIENCY_RETRY_MS,
			})
			return { admit: false, detail, retryAtMs: at }
		},
		// Unknown observations fail closed during probation.
		probation(running) {
			const mono = monoNow()
			observeRunning(running, mono, true)
			const newest = new Map<
				string,
				{ placement: RunningPlacement; admitted: number }
			>()
			for (const placement of running) {
				if (!onProbation(placement, mono)) continue
				const admitted = admittedMono.get(placement.key)!
				const previous = newest.get(placement.sourceId)
				if (!previous || admitted > previous.admitted) {
					newest.set(placement.sourceId, { placement, admitted })
				}
			}
			const verdicts: { key: string; detail: "drops" | "cpu" }[] = []
			for (const { placement, admitted } of newest.values()) {
				let dropped = true
				try {
					dropped =
						deps.drops?.droppedSinceMono(placement.sourceId, admitted) ?? true
				} catch {
					/* Missing evidence fails closed during probation. */
				}
				let detail: "drops" | "cpu" | null = null
				if (dropped) {
					detail = "drops"
				} else if (maxHighCpuAt !== null && maxHighCpuAt >= admitted) {
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
			admittedMono.delete(key)
			retries.delete(key)
			failures.delete(key)
		},
		view(running, blocked, now) {
			const mono = monoNow()
			observeRunning(running, mono)
			let membership: readonly string[] = []
			try {
				membership = deps.drops?.sources() ?? []
			} catch {
				/* Unreadable membership. */
			}
			const ids = new Set([
				...membership,
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
					drops: readDrops(sourceId).state,
					dropBytesPerSecond: readDrops(sourceId).dropBytesPerSecond,
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
								probation: onProbation(p, mono),
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
