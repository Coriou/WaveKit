import { z } from "zod"
import type { Logger } from "../../utils/logger.js"
import type {
	DecoderEfficiencyDetail,
	DropAttribution,
} from "@wavekit/api-types"
import {
	chargesBranch,
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
	ChargedDrop,
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

/**
 * The smallest double above a valid time: a mark set here admits as evidence
 * only what happened strictly after `value` (the readers count `>= since`).
 */
const justAfter = (value: number): number => {
	if (value === 0) return Number.MIN_VALUE
	const bits = new BigInt64Array(new Float64Array([value]).buffer)
	bits[0] = bits[0]! + 1n
	return new Float64Array(bits.buffer)[0]!
}

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
	/**
	 * The drop samples within [fromMono, toMono] with the branches charged with
	 * each. With it, probation judges a placement only by drops charged to the
	 * branch it reads; without it, every drop on the source judges it.
	 */
	chargedDropsBetweenMono?(
		id: string,
		fromMono: number,
		toMono: number,
	): readonly ChargedDrop[]
}

export function createEfficiencyGate(
	inputs: EfficiencyInputs,
	deps: { drops?: DropReader; log?: Logger } = {},
): EfficiencyGate {
	const budgetCores = () => inputs.budget?.cores() ?? inputs.budgetCores
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
	/** When a tuned-band probationer's loss last shed a scapegoat on each source. */
	const scapegoatAt = new Map<string, number>()
	/** Per tuned-band probationer: host loss before this time was already judged. */
	const hostJudged = new Map<string, number>()
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
	const lateRetries = new Set<string>()
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
	// CPU evidence evicted from bounded history must not erase a failed probation.
	// One flag per admitted placement, reset with its admission mark or removal.
	const originalFailed = new Set<string>()
	const evictHighCpu = () => {
		const t = highCpu.shift()
		if (t === undefined) return
		for (const [key, admitted] of admittedMono)
			if (!graduated.has(key) && admitted <= t) originalFailed.add(key)
	}
	/** Placements this gate admitted (YAML and pre-gate runs never are). */
	const gated = new Set<string>()
	/** Activity moves whose next admission inherits a graduated probation. */
	const earned = new Set<string>()
	const mark = (key: string, mono: number) => {
		admittedMono.set(key, mono)
		originalFailed.delete(key)
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
					hostJudged.delete(key)
					placementEpochs.delete(key)
					admittedMono.delete(key)
					originalFailed.delete(key)
					graduated.delete(key)
					gated.delete(key)
				}
		}
		for (const placement of running)
			if (!admittedMono.has(placement.key)) mark(placement.key, mono)
	}
	/**
	 * The drop samples on a source within [from, to] with their charged
	 * branches; null when the reader does not scope drops by branch.
	 * Unreadable or malformed evidence is no drop.
	 */
	const chargedDrops = (
		sourceId: string,
		from: number,
		to: number,
	): readonly ChargedDrop[] | null => {
		const read = deps.drops?.chargedDropsBetweenMono
		if (read === undefined) return null
		try {
			const value: unknown =
				typeof read === "function"
					? read.call(deps.drops, sourceId, from, to)
					: []
			return Array.isArray(value)
				? value.filter(
						(d: ChargedDrop) =>
							d &&
							valid(d.atMono) &&
							d.atMono >= from &&
							d.atMono <= to &&
							(d.branches === "source" ||
								(Array.isArray(d.branches) &&
									d.branches.every((b: unknown) => typeof b === "string"))),
					)
				: []
		} catch {
			return []
		}
	}
	/**
	 * Drops or CPU over the limit observed in [admitted, until]. Drops judge a
	 * placement only when charged to the branch it reads (or the source as a
	 * whole), as late drops do; for a tuned-band placement, host loss charged
	 * to the source as a whole is loss elsewhere (no holder known), never its
	 * own. A placement naming no input branch, or a reader without branch
	 * evidence, is judged by every drop on the source: probation fails closed
	 * where it cannot tell whose loss it was.
	 */
	const evidence = (
		p: RunningPlacement,
		admitted: number,
		until = Infinity,
	): "drops" | "cpu" | null => {
		let dropped = false
		try {
			const reader = deps.drops
			const charged = chargedDrops(p.sourceId, admitted, until)
			if (charged !== null)
				dropped = charged.some(
					d =>
						p.inputBranch === undefined ||
						(chargesBranch(d.branches, p.inputBranch) &&
							!(
								p.tunedBand === true &&
								d.code === "host" &&
								d.branches === "source"
							)),
				)
			else if (until === Infinity)
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
	// Normal probation is earned: with a coverage reader a placement needs
	// EFFICIENCY_PROBATION_MS of complete evidence since admission (unknown
	// intervals do not count), else that much time. Evidence is judged before
	// graduation over everything observed up to and including the sample that
	// completes it; evidence in that window prevents normal graduation.
	const graduationAt = (
		p: RunningPlacement,
		mono: number,
		admitted = admittedMono.get(p.key) ?? NaN,
		duration = EFFICIENCY_PROBATION_MS,
	): number | null => {
		if (!Number.isFinite(mono) || !Number.isFinite(admitted)) return null
		const reader = deps.drops
		if (reader?.coverageCompleteAtMono !== undefined) {
			if (typeof reader.coverageCompleteAtMono !== "function") return null
			try {
				const at = reader.coverageCompleteAtMono(p.sourceId, admitted, duration)
				return valid(at) && at >= admitted + duration && at <= mono ? at : null
			} catch {
				return null
			}
		}
		if (reader?.latestAttribution !== undefined) return null
		return mono - admitted >= duration ? admitted + duration : null
	}
	const graduates = (p: RunningPlacement, mono: number) => {
		if (graduated.has(p.key)) return true
		const at = graduationAt(p, mono)
		const admitted = admittedMono.get(p.key)!
		if (
			at !== null &&
			!originalFailed.has(p.key) &&
			evidence(p, admitted, at) === null
		)
			return true
		if (p.mode !== "always" && p.startMode !== "operator") return false
		// Protected probationers cannot be suspended after loss. Let a fresh
		// clean run release their slot: cleanAt - 30 × 2000 ms is its first
		// clean point; require all 60000 ms of coverage, including the endpoint.
		// CPU does not restart the monitor's drop-clean run. Start after its
		// latest disqualifying sample too, then require a full clear window.
		try {
			const cleanAt = deps.drops?.cleanAtMono?.(p.sourceId)
			if (!valid(cleanAt) || cleanAt > mono) return false
			const lastHighCpu = highCpu.findLast(t => t >= admitted && t <= mono)
			// Recovery needs only the last 60 s plus one sample: at 2 s per
			// sample that is at most 32 timestamps, well below the 1024 cap.
			// Older original evidence is retained separately in originalFailed.
			// Coverage ends at the latest sample, even when reconciliation polls later.
			const sampled = deps.drops?.lastSampleMono?.() ?? mono
			if (!valid(sampled)) return false
			const since = Math.max(
				Math.min(sampled, mono) - EFFICIENCY_CLEAR_MS,
				cleanAt - EFFICIENCY_CLEAR_MS,
				lastHighCpu === undefined
					? admitted
					: lastHighCpu + EFFICIENCY_SAMPLE_MS,
			)
			return (
				since > admitted &&
				readDrops(p.sourceId).state === "ok" &&
				graduationAt(p, mono, since, EFFICIENCY_CLEAR_MS) !== null &&
				evidence(p, since, mono) === null
			)
		} catch {
			return false
		}
	}
	const onProbation = (p: RunningPlacement, mono: number) => !graduates(p, mono)
	/** An `always` decoder's or an operator-started placement: never stopped for another. */
	const pinned = (p: RunningPlacement | WantedPlacement) =>
		("mode" in p && p.mode === "always") ||
		("startMode" in p && p.startMode === "operator")
	/**
	 * A gate-admitted placement the gate may stop for another: never a YAML
	 * placement (never admitted here), an `always` decoder or an operator start.
	 */
	const sheddable = (p: RunningPlacement | WantedPlacement) =>
		gated.has(p.key) && !pinned(p)
	/**
	 * Whether `p` holds no budget against `newcomer`. 3.21: gated secondaries
	 * yield to an ungated newcomer, except a tuned-band secondary to an
	 * untuned one, and never a pinned one (`always` or operator start, which
	 * holds its budget like a primary). Tuned band: every sheddable untuned
	 * placement yields to a tuned-band newcomer, so the decoders of the tuned
	 * band are refused last.
	 */
	const yieldsTo = (
		newcomer: WantedPlacement,
		p: RunningPlacement | WantedPlacement,
	): boolean => {
		if (p.key === newcomer.key) return false
		const tuned = newcomer.tunedBand === true
		if (
			newcomer.gated !== true &&
			p.gated === true &&
			!pinned(p) &&
			(tuned || p.tunedBand !== true)
		)
			return true
		return tuned && p.tunedBand !== true && sheddable(p)
	}
	/**
	 * 3.21 and tuned band: the running placements a newcomer displaces, newest
	 * first out: those in `forced`, those that no longer fit the budget beside
	 * the firm placements (primaries are kept before secondaries, oldest
	 * first), and (when `probationers`) one on probation on the newcomer's
	 * source, whose evidence the newcomer would blur.
	 */
	const displacement = (
		newcomer: WantedPlacement,
		running: readonly RunningPlacement[],
		firm: readonly (RunningPlacement | WantedPlacement)[],
		mono: number,
		probationers: boolean,
		forced: ReadonlySet<string> = new Set(),
	): string[] => {
		const displace: string[] = []
		const kept = [...firm, newcomer]
		const yielding = running
			.filter(p => yieldsTo(newcomer, p))
			.sort(
				(a, b) =>
					Number(a.gated === true) - Number(b.gated === true) ||
					(admittedMono.get(a.key) ?? 0) - (admittedMono.get(b.key) ?? 0),
			)
		for (const p of yielding) {
			const probationer =
				probationers &&
				p.sourceId === newcomer.sourceId &&
				gated.has(p.key) &&
				onProbation(p, mono)
			if (
				!forced.has(p.key) &&
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
	/**
	 * A clean run is under way on the source: it delivers complete evidence
	 * with no drop since the run began, and its latest sample is fresh
	 * (within EFFICIENCY_STALE_MS). It has not yet earned the 60 s clear
	 * window that "ok" needs.
	 */
	const cleanRunUnderway = (sourceId: string, mono: number): boolean => {
		if (!valid(mono)) return false
		try {
			const cleanAt = deps.drops?.cleanAtMono?.(sourceId)
			if (!valid(cleanAt) || cleanAt - EFFICIENCY_CLEAR_MS > mono) return false
			const sampled = deps.drops?.lastSampleMono?.()
			return (
				sampled === undefined ||
				(valid(sampled) &&
					sampled <= mono &&
					mono - sampled <= EFFICIENCY_STALE_MS)
			)
		} catch {
			return false
		}
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
							(w.condemnedBranches === undefined ||
								w.condemnedBranches === "source" ||
								(Array.isArray(w.condemnedBranches) &&
									w.condemnedBranches.every(
										(b: unknown) => typeof b === "string",
									))) &&
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
		// A window condemns the placements reading a branch that dropped in it;
		// an unscoped window (no branch list) or upstream loss no branch can be
		// charged with (absorber overflow, "source") condemns the whole source.
		const condemns = (w: LateDropWindow, p: RunningPlacement) =>
			w.condemning && chargesBranch(w.condemnedBranches, p.inputBranch)
		// Windows that condemn some placement on the source: drops only on a
		// branch no decoder reads (live audio) condemn nothing.
		const condemningWindows = windows.filter(w =>
			placements.some(p => condemns(w, p)),
		).length
		// Each placement is judged by its own branch's windows.
		const condemned = eligible.filter(
			p => windows.filter(w => condemns(w, p)).length >= LATE_SHED_HITS,
		)
		let held: "nothing-sheddable" | "link-or-unknown" | null = null
		if (!probation) {
			if (condemningWindows >= LATE_SHED_HITS && condemned.length === 0)
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
			condemned,
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
			// Prune on healthy samples too, retaining the recovery interval:
			// 60000 ms + one 2000 ms sample = at most 32 timestamps.
			// Normal graduation may still need anything since admission, so
			// lower the cutoff to the oldest ungraduated admission. Any forced
			// eviction preserves CPU failure for admissions <= that timestamp;
			// drops stay with the monitor, which clears them on a new epoch.
			let mono = NaN
			try {
				mono = deps.drops?.lastSampleMono?.() ?? monoNow()
			} catch {
				mono = monoNow()
			}
			if (valid(mono)) {
				let since = mono - EFFICIENCY_CLEAR_MS - EFFICIENCY_SAMPLE_MS
				for (const [key, admitted] of admittedMono)
					if (!graduated.has(key)) since = Math.min(since, admitted)
				while (highCpu.length && highCpu[0]! < since) evictHighCpu()
			}
			if (
				valid(sample.cpuPercent) &&
				sample.cpuPercent > inputs.cpuGuardPercent
			) {
				// CPU evidence carries the evidence time of the sample it came with,
				// so the sample that completes coverage includes its CPU reading.
				if (Number.isFinite(mono)) {
					highCpu.push(mono)
					if (highCpu.length > 1024) evictHighCpu()
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
			const tuned = newcomer.tunedBand === true
			const retry = retries.get(newcomer.key)
			if (retry?.pending) {
				retry.at = Math.max(retry.at, now + retry.delay)
				delete retry.pending
			}
			// A tuned-band newcomer is not held by a budget backoff: untuned
			// placements yield their budget to it. Loss backoff still applies.
			if (retry && now < retry.at && !(tuned && retry.detail === "budget")) {
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
			const yields = (p: RunningPlacement | WantedPlacement) =>
				yieldsTo(newcomer, p)
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
			// Tuned band, start latency: after a reconnect the source reads
			// "unknown" until a 60 s clear window is earned. A tuned-band
			// newcomer starts once a clean run is under way instead (host or
			// consumer loss still refuses); its probation judges it as usual.
			const warming =
				tuned &&
				state !== "dropping" &&
				attribution !== "host" &&
				attribution !== "consumer" &&
				cleanRunUnderway(newcomer.sourceId, mono)
			const unsettled =
				state === "unknown" || state === "clearing" || attribution === "unknown"
			let detail: DecoderEfficiencyDetail | null = null
			// Over the CPU limit a tuned-band newcomer swaps in for untuned
			// placements (newest first) whose cost together covers its own.
			const swapped = new Set<string>()
			if (
				!valid(now) ||
				(unsettled && !warming) ||
				(attribution !== undefined && !valid(mono))
			)
				detail = "unknown"
			else if (state === "dropping") detail = "drops"
			else if (!valid(inputs.cpuGuardPercent)) detail = "unknown"
			else if ((currentCpu(now) ?? 0) > inputs.cpuGuardPercent) {
				detail = "cpu"
				if (tuned && valid(newcomer.costCores)) {
					let freed = 0
					const victims = running
						.filter(p => yields(p) && p.tunedBand !== true && sheddable(p))
						.sort(
							(a, b) =>
								(admittedMono.get(b.key) ?? 0) - (admittedMono.get(a.key) ?? 0),
						)
					for (const p of victims) {
						if (freed >= newcomer.costCores) break
						if (!valid(p.costCores)) continue
						swapped.add(p.key)
						freed += p.costCores
					}
					if (freed >= newcomer.costCores) detail = null
					else swapped.clear()
				}
			}
			if (
				detail === null &&
				(!valid(budgetCores()) ||
					!Number.isFinite(total([...firm, newcomer])) ||
					total([...firm, newcomer]) > budgetCores())
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
				const displace = displacement(
					newcomer,
					running,
					firm,
					mono,
					true,
					swapped,
				)
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
				// Tuned band: re-checked every sample (2000 ms), since a clean run
				// starting is enough for it (see `warming`), not the clear window.
				if (tuned)
					return {
						admit: false,
						detail,
						retryAtMs: base + EFFICIENCY_SAMPLE_MS,
					}
				return {
					admit: false,
					detail,
					retryAtMs:
						valid(cleanAt) && valid(mono)
							? Math.max(base + cleanAt - mono, base + EFFICIENCY_SAMPLE_MS)
							: base + EFFICIENCY_CLEAR_MS,
				}
			}
			// A tuned-band newcomer refused for budget or CPU had every untuned
			// placement yield already: only tuned, YAML, `always` or operator
			// placements hold the budget. It is re-checked after one clear window
			// (60 s) without a growing backoff; a budget change rechecks at once.
			if ((detail === "budget" || detail === "cpu") && tuned)
				return {
					admit: false,
					detail,
					retryAtMs: (valid(now) ? now : 0) + EFFICIENCY_CLEAR_MS,
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
				p => p.key !== newcomer.key && !yieldsTo(newcomer, p),
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
			for (const placement of running) {
				if (!graduated.has(placement.key) && graduates(placement, mono))
					graduated.add(placement.key)
				// Normal retries reset on graduation. Late-shed retries retain their
				// doubling history until readmission + the 1,800,000 ms cap.
				if (
					gated.has(placement.key) &&
					graduated.has(placement.key) &&
					(!lateRetries.has(placement.key) ||
						mono - admittedMono.get(placement.key)! >= EFFICIENCY_RETRY_MAX_MS)
				) {
					retries.delete(placement.key)
					failures.delete(placement.key)
					lateRetries.delete(placement.key)
				}
			}
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
				if (placement.mode === "always" || placement.startMode === "operator")
					continue
				const detail = evidence(placement, admitted)
				const tuned = placement.tunedBand === true
				// Tuned band: host loss charged to a sibling branch some placement
				// reads, or to the source as a whole (no holder known), while the
				// probationer's own branch stayed clean, is its load on the host.
				// Drops on a branch no placement reads (live audio) never count.
				let hostElsewhere = false
				// Sibling branches the host loss was charged to (holder attribution).
				const hostCharged = new Set<string>()
				if (tuned && detail === null && valid(mono)) {
					const read = new Set(
						running
							.filter(
								p =>
									p.sourceId === placement.sourceId &&
									p.key !== placement.key &&
									p.inputBranch !== undefined &&
									p.inputBranch !== placement.inputBranch,
							)
							.map(p => p.inputBranch),
					)
					for (const d of chargedDrops(
						placement.sourceId,
						Math.max(admitted, hostJudged.get(placement.key) ?? admitted),
						mono,
					) ?? []) {
						if (d.code !== "host") continue
						if (d.branches === "source") hostElsewhere = true
						else
							for (const b of d.branches)
								if (read.has(b)) {
									hostElsewhere = true
									hostCharged.add(b)
								}
					}
					hostJudged.set(placement.key, justAfter(mono))
				}
				if (detail === null && !hostElsewhere) continue
				// Tuned band: a tuned-band probationer's CPU loss, or host loss on a
				// sibling's branch, sheds the newest sheddable untuned placement
				// instead (on its source for drops, anywhere for CPU); the tuned one
				// restarts its probation. Host loss charged to sibling branches sheds
				// a placement reading one of them first (newest among those), so the
				// holder goes rather than a clean bystander and then the holder too;
				// unattributed (source-wide) host loss and CPU loss shed the newest.
				// Loss on its own branch is its own.
				if (tuned && detail !== "drops" && valid(mono)) {
					const candidates = running.filter(
						p =>
							p.key !== placement.key &&
							p.tunedBand !== true &&
							sheddable(p) &&
							(detail === "cpu" || p.sourceId === placement.sourceId) &&
							!verdicts.some(v => v.key === p.key),
					)
					// At most one scapegoat per clear window (EFFICIENCY_CLEAR_MS,
					// 60 000 ms): a shed placement's relief shows only in later
					// samples. Host drops are relieved per source; CPU is host-wide,
					// so a CPU scapegoat waits for the window since the latest
					// scapegoat on any source.
					const eligible = candidates.filter(
						p =>
							mono - (scapegoatAt.get(p.sourceId) ?? -Infinity) >=
								EFFICIENCY_CLEAR_MS &&
							(detail !== "cpu" ||
								mono - Math.max(-Infinity, ...scapegoatAt.values()) >=
									EFFICIENCY_CLEAR_MS),
					)
					const charged =
						detail === null
							? eligible.filter(
									p =>
										p.inputBranch !== undefined &&
										hostCharged.has(p.inputBranch),
								)
							: []
					const scapegoat = (charged.length > 0 ? charged : eligible).reduce<
						RunningPlacement | undefined
					>(
						(best, p) =>
							!best ||
							(admittedMono.get(p.key) ?? 0) > (admittedMono.get(best.key) ?? 0)
								? p
								: best,
						undefined,
					)
					if (scapegoat) {
						failures.add(scapegoat.key)
						verdicts.push({ key: scapegoat.key, detail: detail ?? "drops" })
						scapegoatAt.set(scapegoat.sourceId, mono)
					}
					if (scapegoat || candidates.length > 0) {
						// The loss is spent on the scapegoat, the one shed within this
						// window included: the restarted probation counts only drops
						// and CPU strictly after this evaluation, so the same loss
						// never condemns a second placement.
						if (detail === "cpu") mark(placement.key, justAfter(mono))
						continue
					}
				}
				// Host loss on a sibling's branch with nothing untuned left to shed:
				// the tuned one is judged by its own branch and CPU only.
				if (detail === null) continue
				failures.add(placement.key)
				verdicts.push({ key: placement.key, detail })
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
						state.condemned.length === 0
					)
						continue
					// Only placements whose own branch dropped are shed; among them,
					// tuned band: untuned placements before tuned ones.
					const untuned = state.condemned.filter(p => p.tunedBand !== true)
					const newestEligible = (
						untuned.length ? untuned : state.condemned
					).reduce<RunningPlacement | undefined>(
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
			originalFailed.delete(key)
			reconnectRetained.delete(key)
			placementEpochs.delete(key)
			gated.delete(key)
			if (detail === "late-drops") lateRetries.add(key)
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
			hostJudged.delete(key)
			reconnectRetained.delete(key)
			placementEpochs.delete(key)
			admittedMono.delete(key)
			originalFailed.delete(key)
			graduated.delete(key)
			gated.delete(key)
			retries.delete(key)
			failures.delete(key)
			lateRetries.delete(key)
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
