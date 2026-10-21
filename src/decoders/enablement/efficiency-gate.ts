import type { DecoderEfficiencyDetail } from "@wavekit/api-types"
import {
	channelizerBaseCores,
	EFFICIENCY_CLEAR_MS,
	EFFICIENCY_PROBATION_MS,
	EFFICIENCY_RETRY_MS,
	EFFICIENCY_RETRY_MAX_MS,
	EFFICIENCY_SAMPLE_MS,
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
	/** True only for positive drop deltas observed at or after `sinceMono`. */
	droppedSinceMono(id: string, sinceMono: number): boolean
	droppedWithinMs(id: string, ms: number): boolean
	/** When the source's current clean run earns its clear window; null while it has none. */
	cleanAtMono?(id: string): number | null
	/** Milliseconds since `sinceMono` covered by complete evidence (earned probation time). */
	coveredSinceMono?(id: string, sinceMono: number): number
	/** The sample at which `amount` ms of coverage since `sinceMono` completes; null before. */
	coverageCompleteAtMono?(
		id: string,
		sinceMono: number,
		amount: number,
	): number | null
	/** Evidence time of the latest sample; a recorded sample is stamped with it. */
	lastSampleMono?(): number | null
	/** True for a positive drop delta observed by a sample within [fromMono, toMono]. */
	droppedBetweenMono?(id: string, fromMono: number, toMono: number): boolean
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
	/** Monotonic times of samples with CPU over the limit, oldest first. */
	const highCpu: number[] = []
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
	// Placements that completed probation with no evidence against them.
	const graduated = new Set<string>()
	/** Placements this gate admitted (YAML and pre-gate runs never are). */
	const gated = new Set<string>()
	const mark = (key: string, mono: number) => {
		admittedMono.set(key, mono)
		graduated.delete(key)
	}
	const observeRunning = (
		running: readonly RunningPlacement[],
		mono: number,
		prune = false,
	) => {
		if (prune) {
			const present = new Set(running.map(p => p.key))
			for (const key of admittedMono.keys())
				if (!present.has(key)) {
					admittedMono.delete(key)
					graduated.delete(key)
					gated.delete(key)
				}
		}
		for (const placement of running)
			if (!admittedMono.has(placement.key)) mark(placement.key, mono)
	}
	/** Drops or CPU over the limit observed in [admitted, until]. */
	const evidence = (
		p: RunningPlacement,
		admitted: number,
		until = Infinity,
	): "drops" | "cpu" | null => {
		let dropped = false
		try {
			const reader = deps.drops
			if (until === Infinity)
				dropped = reader?.droppedSinceMono(p.sourceId, admitted) ?? false
			else if (reader?.droppedBetweenMono)
				dropped = reader.droppedBetweenMono(p.sourceId, admitted, until)
			else
				// A reader reporting only its latest drop: a latest drop inside the
				// window is evidence.
				dropped =
					(reader?.droppedSinceMono(p.sourceId, admitted) ?? false) &&
					!(reader?.droppedSinceMono(p.sourceId, until + 1) ?? false)
		} catch {
			/* Unreadable evidence is unknown, not a drop. */
		}
		if (dropped) return "drops"
		return highCpu.some(t => t >= admitted && t <= until) ? "cpu" : null
	}
	// Probation is earned: with a coverage reader a placement needs
	// EFFICIENCY_PROBATION_MS of complete evidence since admission (unknown
	// intervals do not count), else that much time. Evidence is judged before
	// graduation over everything observed up to and including the sample that
	// completes it: a placement with evidence in that window never graduates.
	const graduationAt = (p: RunningPlacement, mono: number): number | null => {
		const admitted = admittedMono.get(p.key) ?? NaN
		if (!Number.isFinite(mono) || !Number.isFinite(admitted)) return null
		const reader = deps.drops
		if (reader?.coverageCompleteAtMono) {
			try {
				const at = reader.coverageCompleteAtMono(
					p.sourceId,
					admitted,
					EFFICIENCY_PROBATION_MS,
				)
				return at !== null && Number.isFinite(at) ? at : null
			} catch {
				return null
			}
		}
		return mono - admitted >= EFFICIENCY_PROBATION_MS
			? admitted + EFFICIENCY_PROBATION_MS
			: null
	}
	const graduates = (p: RunningPlacement, mono: number) => {
		if (graduated.has(p.key)) return true
		const at = graduationAt(p, mono)
		return at !== null && evidence(p, admittedMono.get(p.key)!, at) === null
	}
	const onProbation = (p: RunningPlacement, mono: number) => !graduates(p, mono)

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
			) {
				// CPU evidence carries the evidence time of the sample it came with,
				// so the sample that completes coverage includes its CPU reading.
				let mono = NaN
				try {
					mono = deps.drops?.lastSampleMono?.() ?? monoNow()
				} catch {
					mono = monoNow()
				}
				if (Number.isFinite(mono)) {
					highCpu.push(mono)
					if (highCpu.length > 1024) highCpu.shift()
				}
			}
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
			// Otherwise admissible: one gated probationer per source, so probation
			// evidence is always attributable to a single newcomer; the next waits
			// (re-checked every sample, no backoff) until it graduates or is
			// suspended.
			if (
				detail === null &&
				running.some(
					p =>
						p.key !== newcomer.key &&
						p.sourceId === newcomer.sourceId &&
						gated.has(p.key) &&
						onProbation(p, mono),
				)
			)
				return {
					admit: false,
					detail: "unknown",
					retryAtMs: now + EFFICIENCY_SAMPLE_MS,
				}
			if (detail === null) {
				// A key already running keeps its mark; any other admission starts a
				// fresh probation window.
				if (!running.some(p => p.key === newcomer.key)) mark(newcomer.key, mono)
				gated.add(newcomer.key)
				return { admit: true }
			}
			// Missing evidence is not a rejection: no backoff is recorded and the
			// placement is re-evaluated when the source's clean run earns its clear
			// window (one clear window from now while it has no clean run; the next
			// sample when the window is earned but the reading is stale).
			if (detail === "unknown") {
				let cleanAt: number | null = null
				try {
					cleanAt = deps.drops?.cleanAtMono?.(newcomer.sourceId) ?? null
				} catch {
					/* Unreadable: the fallback below applies. */
				}
				const base = valid(now) ? now : 0
				return {
					admit: false,
					detail,
					retryAtMs:
						cleanAt !== null && Number.isFinite(cleanAt)
							? Math.max(cleanAt, base + EFFICIENCY_SAMPLE_MS)
							: base + EFFICIENCY_CLEAR_MS,
				}
			}
			const at = (valid(now) ? now : 0) + (retry?.delay ?? EFFICIENCY_RETRY_MS)
			retries.set(newcomer.key, {
				detail,
				at,
				delay: retry?.delay ?? EFFICIENCY_RETRY_MS,
			})
			return { admit: false, detail, retryAtMs: at }
		},
		// Probation suspends only on positive drops observed after admission or on
		// CPU over the limit; missing evidence closes the gate to newcomers only.
		probation(running) {
			const mono = monoNow()
			observeRunning(running, mono, true)
			// Graduation is sticky: a later discontinuity that discards coverage
			// restarts only the placements still on probation.
			for (const placement of running)
				if (graduates(placement, mono)) graduated.add(placement.key)
			const newest = new Map<
				string,
				{ placement: RunningPlacement; admitted: number }
			>()
			for (const placement of running) {
				if (graduated.has(placement.key)) continue
				const admitted = admittedMono.get(placement.key)!
				const previous = newest.get(placement.sourceId)
				if (!previous || admitted > previous.admitted) {
					newest.set(placement.sourceId, { placement, admitted })
				}
			}
			const verdicts: { key: string; detail: "drops" | "cpu" }[] = []
			for (const { placement, admitted } of newest.values()) {
				const detail = evidence(placement, admitted)
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
			graduated.delete(key)
			gated.delete(key)
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
