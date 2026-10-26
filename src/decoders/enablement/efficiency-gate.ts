import { z } from "zod"
import type { Logger } from "../../utils/logger.js"
import type {
	DecoderEfficiencyDetail,
	DropAttribution,
} from "@wavekit/api-types"
import {
	channelizerBaseCores,
	LATE_SHED_WINDOWS,
	LATE_SHED_HITS,
	LATE_SHED_COOLDOWN_MS,
	EFFICIENCY_DROP_WINDOW_MS,
	EFFICIENCY_CLEAR_MS,
	EFFICIENCY_PROBATION_MS,
	EFFICIENCY_RETRY_MS,
	EFFICIENCY_RETRY_MAX_MS,
	EFFICIENCY_SAMPLE_MS,
	EFFICIENCY_STALE_MS,
} from "./contract.js"
import type {
	AdmissionDecision,
	LateDropWindow,
	EfficiencyGate,
	EfficiencyInputs,
	RunningPlacement,
	WantedPlacement,
} from "./contract.js"

const DropStateSchema = z.object({
	state: z.enum(["ok", "dropping", "clearing", "unknown"]),
	dropBytesPerSecond: z.number().finite().nonnegative().nullable(),
})

const valid = (value: unknown): value is number =>
	typeof value === "number" && Number.isFinite(value) && value >= 0

/** Stateful decision core; all time and observations are supplied by the caller. */
export interface DropReader {
	sourceEpoch?(id: string): number
	latestAttribution?(id: string): DropAttribution | null
	lateWindows?(id: string): readonly LateDropWindow[]
	linkDropsSince?(id: string, sinceMono: number): boolean
	dropState(id: string): {
		state: "ok" | "dropping" | "clearing" | "unknown"
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
	deps: { drops?: DropReader; log?: Logger } = {},
): EfficiencyGate {
	const budgetCores = () =>
		inputs.budget?.view().resolved.cores ?? inputs.budgetCores
	const placementEpochs = new Map<
		string,
		{ sourceId: string; epoch: number; placement: WantedPlacement }
	>()
	const reconnectRetained = new Set<string>()
	const refreshReconnects = () => {
		for (const [key, previous] of placementEpochs) {
			try {
				const epoch = deps.drops?.sourceEpoch?.(previous.sourceId)
				if (valid(epoch) && epoch > previous.epoch) {
					reconnectRetained.add(key)
					previous.epoch = epoch
				}
			} catch {
				/* Missing source evidence cannot establish a reconnect. */
			}
		}
	}
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
			const parsed = DropStateSchema.safeParse(deps.drops?.dropState(id))
			if (parsed.success) return parsed.data
		} catch {
			// Unreadable and malformed snapshots close admission as unknown.
		}
		return { state: "unknown" as const, dropBytesPerSecond: null }
	}
	const latestAttribution = (id: string): DropAttribution | undefined => {
		try {
			const read = deps.drops?.latestAttribution
			if (read === undefined) return undefined
			if (typeof read !== "function") return "unknown"
			const value = read.call(deps.drops, id)
			return value === "none" ||
				value === "link" ||
				value === "host" ||
				value === "consumer"
				? value
				: "unknown"
		} catch {
			return "unknown"
		}
	}
	const lateSince = new Map<string, number>()
	const cooldownUntil = new Map<string, number>()
	const warned = new Map<string, Map<string, number>>()
	let lastLateMono: number | null = null

	const retries = new Map<
		string,
		{
			detail: DecoderEfficiencyDetail
			at: number
			delay: number
			pending?: boolean
		}
	>()
	let lastBudget = budgetCores()
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
	/** Activity moves whose next admission inherits a graduated probation. */
	const earned = new Set<string>()
	const mark = (key: string, mono: number) => {
		admittedMono.set(key, mono)
		graduated.delete(key)
	}
	const observeRunning = (
		running: readonly RunningPlacement[],
		mono: number,
		prune = false,
	) => {
		refreshReconnects()
		if (prune) {
			const present = new Set(running.map(p => p.key))
			for (const key of admittedMono.keys())
				if (!present.has(key) && !reconnectRetained.has(key)) {
					earned.delete(key)
					placementEpochs.delete(key)
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
		if (reader?.coverageCompleteAtMono !== undefined) {
			if (typeof reader.coverageCompleteAtMono !== "function") return null
			try {
				const at = reader.coverageCompleteAtMono(
					p.sourceId,
					admitted,
					EFFICIENCY_PROBATION_MS,
				)
				return valid(at) &&
					at >= admitted + EFFICIENCY_PROBATION_MS &&
					at <= mono
					? at
					: null
			} catch {
				return null
			}
		}
		if (reader?.latestAttribution !== undefined) return null
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
	/**
	 * 3.21: the running gated secondaries an ungated newcomer displaces, newest
	 * first out: those that no longer fit the budget beside the firm placements,
	 * and (when `probationers`) one on probation on the newcomer's source, whose
	 * evidence the newcomer would blur.
	 */
	const displacement = (
		newcomer: WantedPlacement,
		running: readonly RunningPlacement[],
		firm: readonly (RunningPlacement | WantedPlacement)[],
		mono: number,
		probationers: boolean,
	): string[] => {
		if (newcomer.gated === true) return []
		const displace: string[] = []
		const kept = [...firm, newcomer]
		const secondaries = running
			.filter(p => p.gated === true && p.key !== newcomer.key)
			.sort(
				(a, b) =>
					(admittedMono.get(a.key) ?? 0) - (admittedMono.get(b.key) ?? 0),
			)
		for (const p of secondaries) {
			const probationer =
				probationers &&
				p.sourceId === newcomer.sourceId &&
				gated.has(p.key) &&
				onProbation(p, mono)
			if (
				!probationer &&
				valid(budgetCores()) &&
				total([...kept, p]) <= budgetCores()
			)
				kept.push(p)
			else displace.push(p.key)
		}
		// Newest first: the stop order 3.21 names.
		return displace.reverse()
	}

	const lateState = (
		sourceId: string,
		running: readonly RunningPlacement[],
		mono: number,
	) => {
		const placements = running.filter(p => p.sourceId === sourceId)
		const probation = placements.some(p => onProbation(p, mono))
		const eligible = placements.filter(
			p =>
				gated.has(p.key) &&
				graduated.has(p.key) &&
				(p.mode === "auto" || p.mode === "off") &&
				p.startMode === "auto",
		)
		let windows: readonly LateDropWindow[] = []
		try {
			const read = deps.drops?.lateWindows
			if (typeof read === "function" && valid(mono)) {
				const value = read.call(deps.drops, sourceId)
				if (
					Array.isArray(value) &&
					value.every(
						(w: LateDropWindow, i: number) =>
							w &&
							valid(w.startMono) &&
							valid(w.endMono) &&
							w.endMono - w.startMono === EFFICIENCY_DROP_WINDOW_MS &&
							w.endMono <= mono &&
							typeof w.condemning === "boolean" &&
							typeof w.linkOrUnknownDrops === "boolean" &&
							(i === 0 || value[i - 1].endMono <= w.startMono),
					)
				)
					windows = value
						.filter(
							w =>
								w.startMono >= (lateSince.get(sourceId) ?? mono) &&
								w.endMono >
									mono - LATE_SHED_WINDOWS * EFFICIENCY_DROP_WINDOW_MS,
						)
						.slice(-LATE_SHED_WINDOWS)
			}
		} catch {
			/* Unreadable windows never condemn or credit. */
		}
		const condemningWindows = windows.filter(w => w.condemning).length
		let held: "nothing-sheddable" | "link-or-unknown" | null = null
		if (!probation) {
			if (condemningWindows >= LATE_SHED_HITS && eligible.length === 0)
				held = "nothing-sheddable"
			else if (
				condemningWindows < LATE_SHED_HITS &&
				windows.filter(w => w.condemning || w.linkOrUnknownDrops).length >=
					LATE_SHED_HITS
			)
				held = "link-or-unknown"
		}

		return {
			eligible,
			condemningWindows,
			windows: windows.length,
			held,
			cooldownUntil: cooldownUntil.has(sourceId)
				? new Date(cooldownUntil.get(sourceId)!).toISOString()
				: null,
		}
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
			// A live budget change rechecks capacity immediately, keeping loss backoff.
			const currentBudget = budgetCores()
			if (currentBudget !== lastBudget) {
				for (const [key, retry] of retries)
					if (retry.detail === "budget") retries.delete(key)
				lastBudget = currentBudget
			}
			const retry = retries.get(newcomer.key)
			if (retry?.pending) {
				retry.at = Math.max(retry.at, now + retry.delay)
				delete retry.pending
			}
			if (retry && now < retry.at) {
				return { admit: false, detail: retry.detail, retryAtMs: retry.at }
			}
			// A disconnected placement still owns its admitted capacity. Otherwise
			// another source could spend it before the placement resumes.
			const present = new Set(running.map(p => p.key))
			const reserved: WantedPlacement[] = []
			for (const key of reconnectRetained) {
				const previous = placementEpochs.get(key)
				if (previous && !present.has(key)) reserved.push(previous.placement)
			}
			// 3.21: gated secondaries yield to an ungated newcomer. They hold no
			// budget or probation slot against it; running ones that no longer fit
			// are displaced (newest first) instead of starving it.
			const primary = newcomer.gated !== true
			const yields = (p: RunningPlacement | WantedPlacement) =>
				primary && p.gated === true && p.key !== newcomer.key
			// The newcomer's own running entry or reservation is replaced by it.
			const firm = [...running, ...reserved].filter(
				p => p.key !== newcomer.key && !yields(p),
			)
			if (reconnectRetained.has(newcomer.key) && gated.has(newcomer.key)) {
				const resumedCost = total([...firm, newcomer])
				if (valid(budgetCores()) && resumedCost <= budgetCores()) {
					const previous = placementEpochs.get(newcomer.key)
					if (previous) previous.placement = { ...newcomer }
					const displace = displacement(newcomer, running, firm, mono, false)
					return displace.length ? { admit: true, displace } : { admit: true }
				}
			}
			const attribution = latestAttribution(newcomer.sourceId)
			if (attribution === "link")
				return {
					admit: false,
					detail: "unknown",
					retryAtMs: now + EFFICIENCY_SAMPLE_MS,
				}

			const state = readDrops(newcomer.sourceId).state
			let detail: DecoderEfficiencyDetail | null = null
			if (
				!valid(now) ||
				state === "unknown" ||
				state === "clearing" ||
				attribution === "unknown" ||
				(attribution !== undefined && !valid(mono))
			)
				detail = "unknown"
			else if (state !== "ok") detail = "drops"
			else if (!valid(inputs.cpuGuardPercent)) detail = "unknown"
			else if ((currentCpu(now) ?? 0) > inputs.cpuGuardPercent) detail = "cpu"
			else if (
				!valid(budgetCores()) ||
				!Number.isFinite(total([...firm, newcomer])) ||
				total([...firm, newcomer]) > budgetCores()
			)
				detail = "budget"
			// Otherwise admissible: one gated probationer per source, so probation
			// evidence is always attributable to a single newcomer; the next waits
			// (re-checked every sample, no backoff) until it graduates or is
			// suspended.
			if (
				detail === null &&
				!earned.has(newcomer.key) &&
				running.some(
					p =>
						p.key !== newcomer.key &&
						!yields(p) &&
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
				// An activity move keeps the probation its predecessor earned (on
				// the preflight and the final admission alike).
				if (earned.has(newcomer.key)) graduated.add(newcomer.key)
				gated.add(newcomer.key)
				try {
					const epoch = deps.drops?.sourceEpoch?.(newcomer.sourceId)
					if (valid(epoch))
						placementEpochs.set(newcomer.key, {
							sourceId: newcomer.sourceId,
							epoch,
							placement: { ...newcomer },
						})
				} catch {
					/* Optional lifecycle evidence. */
				}
				const displace = displacement(newcomer, running, firm, mono, true)
				return displace.length ? { admit: true, displace } : { admit: true }
			}
			// Missing evidence is not a rejection: no backoff is recorded and the
			// placement is re-evaluated when the source's clean run earns its clear
			// window (one clear window from now while it has no clean run; the next
			// sample when the window is earned but the reading is stale).
			// Admission waits for source recovery without caching a drop rejection
			// for the five-minute backoff reserved for suspended probationers.
			if (detail === "unknown" || detail === "drops") {
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
			// An activity slot over the budget is a planning race (the allocator
			// sized it to fit): it is re-checked next sample, with no backoff.
			if (detail === "budget" && newcomer.origin === "activity")
				return {
					admit: false,
					detail,
					retryAtMs: (valid(now) ? now : 0) + EFFICIENCY_SAMPLE_MS,
				}
			const at = (valid(now) ? now : 0) + (retry?.delay ?? EFFICIENCY_RETRY_MS)
			retries.set(newcomer.key, {
				detail,
				at,
				delay: retry?.delay ?? EFFICIENCY_RETRY_MS,
			})
			return { admit: false, detail, retryAtMs: at }
		},
		yieldTo(newcomer, running) {
			const mono = monoNow()
			observeRunning(running, mono)
			const firm = running.filter(
				p => p.gated !== true && p.key !== newcomer.key,
			)
			return displacement(newcomer, running, firm, mono, false)
		},
		// Probation suspends only on positive drops observed after admission or on
		// CPU over the limit; missing evidence closes the gate to newcomers only.
		probation(running) {
			const mono = monoNow()
			observeRunning(running, mono, true)
			const sourceIds = new Set(running.map(p => p.sourceId))
			if (!valid(mono) || (lastLateMono !== null && mono < lastLateMono)) {
				for (const id of sourceIds)
					lateSince.set(id, valid(mono) ? mono : Infinity)
			}
			lastLateMono = valid(mono) ? mono : null

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
			const verdicts: {
				key: string
				detail: "drops" | "cpu" | "late-drops"
			}[] = []
			for (const { placement, admitted } of newest.values()) {
				if (valid(mono)) lateSince.set(placement.sourceId, mono)
				const detail = evidence(placement, admitted)
				if (
					detail &&
					placement.mode !== "always" &&
					placement.startMode !== "operator"
				) {
					failures.add(placement.key)
					verdicts.push({ key: placement.key, detail })
				}
			}
			if (valid(mono))
				for (const sourceId of new Set(running.map(p => p.sourceId))) {
					if (newest.has(sourceId)) continue
					if (!valid(lateSince.get(sourceId))) lateSince.set(sourceId, mono)
					const state = lateState(sourceId, running, mono)
					if (state.held !== null) {
						const times = warned.get(sourceId) ?? new Map<string, number>()
						const previous = times.get(state.held)
						if (previous === undefined || mono - previous >= 60_000) {
							times.set(state.held, mono)
							warned.set(sourceId, times)
							try {
								deps.log?.warn(
									{
										sourceId,
										reason: state.held,
										condemningWindows: state.condemningWindows,
										windows: state.windows,
									},
									"Late drops not shed",
								)
							} catch {
								/* Logging cannot change a verdict. */
							}
						}
					}
					if (
						mono < (cooldownUntil.get(sourceId) ?? 0) ||
						state.condemningWindows < LATE_SHED_HITS
					)
						continue
					const newestEligible = state.eligible.reduce<
						RunningPlacement | undefined
					>(
						(best, p) =>
							!best || admittedMono.get(p.key)! > admittedMono.get(best.key)!
								? p
								: best,
						undefined,
					)
					if (newestEligible) {
						failures.add(newestEligible.key)
						verdicts.push({ key: newestEligible.key, detail: "late-drops" })
						cooldownUntil.set(sourceId, mono + LATE_SHED_COOLDOWN_MS)
						lateSince.set(sourceId, mono)
					}
				}
			return verdicts
		},
		noteSuspended(key, detail, now) {
			reconnectRetained.delete(key)
			placementEpochs.delete(key)
			gated.delete(key)
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
		inherit(fromKey, toKey) {
			if (fromKey === toKey || !graduated.has(fromKey) || !gated.has(fromKey))
				return
			earned.add(toKey)
			if (retries.get(toKey)?.detail === "budget" && !failures.has(toKey))
				retries.delete(toKey)
		},
		forget(key) {
			earned.delete(key)
			reconnectRetained.delete(key)
			placementEpochs.delete(key)
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
				budgetCores: budgetCores(),
				...(inputs.budget ? { budget: inputs.budget.view().resolved } : {}),
				cpuGuardPercent: inputs.cpuGuardPercent,
				sources: [...ids].map(sourceId => {
					const attribution = latestAttribution(sourceId)
					return {
						sourceId,
						...(attribution !== undefined ? { attribution } : {}),
						...(deps.drops?.lateWindows !== undefined
							? {
									lateDrops: (() => {
										const state = lateState(sourceId, running, mono)
										return {
											condemningWindows: state.condemningWindows,
											windows: state.windows,
											cooldownUntil: state.cooldownUntil,
											sheddable: state.eligible.length,
											held: state.held,
										}
									})(),
								}
							: {}),
						coresInUse: total(running.filter(p => p.sourceId === sourceId)),
						cpu: { percent: currentCpu(now), limit: inputs.cpuGuardPercent },
						drops: readDrops(sourceId).state,
						dropBytesPerSecond: readDrops(sourceId).dropBytesPerSecond,
						admitted: running
							.filter(p => p.sourceId === sourceId)
							.map(p => {
								const separator = p.key.lastIndexOf("#")
								const channel = p.key.slice(
									separator + 1,
									p.key.lastIndexOf("@"),
								)
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
							.filter(
								b => b.placement.sourceId === sourceId && !b.decision.admit,
							)
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
					}
				}),
			}
		},
	}
}
