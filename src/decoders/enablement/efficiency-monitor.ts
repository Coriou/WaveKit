import { performance } from "node:perf_hooks"
import type { DropAttribution } from "@wavekit/api-types"
import { z } from "zod"
import {
	LINK_GAP_MS,
	LINK_RECOVERY_WAIT_MS,
	type IngestInterval,
	type RecoveryEvidence,
	type LoopDelayInterval,
} from "../../core/link-burst/contract.js"
import type { Logger } from "../../utils/logger.js"
import { attributeInterval } from "./attribution.js"
import {
	EFFICIENCY_CLEAR_MS,
	EFFICIENCY_CPU_GUARD_PERCENT,
	EFFICIENCY_DROP_WINDOW_MS,
	LATE_SHED_WINDOWS,
	EFFICIENCY_SAMPLE_MS,
	EFFICIENCY_STALE_MS,
} from "./contract.js"
import type {
	EfficiencySample,
	SourceDropSample,
	LateDropWindow,
} from "./contract.js"
import type { DropReader } from "./efficiency-gate.js"

type Counters = {
	droppedBytesTotal: number
	droppedChunksTotal: number
	active?: boolean
}
const nonNegative = z.number().finite().nonnegative()
const counterSchema = z.object({
	droppedBytesTotal: z.number().int().nonnegative().safe(),
	droppedChunksTotal: z.number().int().nonnegative().safe(),
	active: z.boolean().optional(),
})
const ingestSchema = z.object({
	maxGapMs: nonNegative,
	catchupBytes: nonNegative,
	chunks: nonNegative,
})
const recoverySchema = z.object({
	retired: z.boolean().optional(),
	sequence: z.number().int().nonnegative().safe(),
	completedSequence: z.number().int().nonnegative().safe(),
	failedSequence: z.number().int().nonnegative().safe(),
	maxGapMs: nonNegative,
	shortfall: z.boolean().nullable(),
})
const loopSchema = z.object({ maxMs: nonNegative, p99Ms: nonNegative })
type SourceState = {
	pending: {
		sequence: number
		bytes: number
		chunks: number
		at: number
		gap: number
		loop: number
		cpu: number
		upstream: number
		valid: boolean
	} | null
	branchDrops: Map<string, number>
	rawSamples: number[]
	upstream: number | null
	coverageBlocked: boolean
	latest: DropAttribution | null
	lastNonNone: DropAttribution | null
	counts: { mono: number; code: DropAttribution }[]
	linkDrops: number[]
	windows: LateDropWindow[]
	openWindow: (LateDropWindow & { complete: boolean }) | null
	logged: Map<DropAttribution, number>
	/** Last valid counters per branch identity, kept across unreadable reads. */
	seen: Map<string, Counters> | null
	/** Branches first seen with invalid counters: baselined when they turn valid. */
	unbaselined: Set<string>
	signature: string | null
	lastTickMono: number | null
	/** Last tick that was a complete read (every branch valid); null breaks the chain. */
	lastCompleteMono: number | null
	cleanSinceMono: number | null
	lastDropMono: number | null
	faultMono: number | null
	rate: number | null
	/** Merged intervals with complete per-branch evidence, oldest first. */
	covered: { from: number; to: number }[]
	/** Times of samples that observed a positive drop delta, oldest first. */
	drops: number[]
}
/** Coverage history bound; dropping the oldest only lengthens probation. */
const MAX_COVERED_INTERVALS = 256
/** Drop history bound: about 34 minutes of continuous drops at 2 s samples. */
const MAX_DROP_SAMPLES = 1024
const validTotal = (n: unknown): n is number =>
	typeof n === "number" && Number.isSafeInteger(n) && n >= 0

/** Polling owns evidence; display callbacks cannot acknowledge or alter it. */
export function createEfficiencyMonitor(deps: {
	sourceEvents?: {
		on(
			event: "disconnected" | "removed" | "source-removed",
			listener: (id: string) => void,
		): unknown
		on(event: "data", listener: (id: string, chunk: Buffer) => void): unknown
		off(
			event: "disconnected" | "removed" | "source-removed",
			listener: (id: string) => void,
		): unknown
		off(event: "data", listener: (id: string, chunk: Buffer) => void): unknown
	}
	sources: () => readonly string[]
	branchCounters: (id: string) => ReadonlyMap<string, Counters> | null
	ingest?: (
		id: string,
		fromMono: number,
		toMono: number,
	) => IngestInterval | null
	loopDelay?: () => LoopDelayInterval | null
	shortfall?: (id: string) => boolean | null
	upstreamDroppedTotal?: (id: string) => number | null | undefined
	attributionApplies?: (id: string) => boolean
	recovery?: (id: string, mono: number) => RecoveryEvidence | null
	cpuGuardPercent?: number
	log?: Logger
	topology?: (id: string) => string | null
	cpu: { readonly normalisedPercent: number | null }
	now: () => number
	monoNow?: () => number
	setInterval: (fn: () => void, ms: number) => { cancel(): void }
	onSample?: (sample: EfficiencySample) => void
}): DropReader &
	Required<
		Pick<
			DropReader,
			| "cleanAtMono"
			| "lastSampleMono"
			| "coveredSinceMono"
			| "coverageCompleteAtMono"
			| "droppedBetweenMono"
		>
	> & {
		latestAttribution(id: string): DropAttribution | null
		lateWindows(id: string): readonly LateDropWindow[]
		linkDropsSince(id: string, sinceMono: number): boolean
		attributionCounts(id: string): {
			last: DropAttribution | null
			counts10m: Record<DropAttribution, number>
		} | null
		start(): void
		stop(): void
		sampleNow(): EfficiencySample
	} {
	const states = new Map<string, SourceState>()
	const monoNow = deps.monoNow ?? (() => performance.now())
	// Default only an omitted guard: a supplied malformed value (null included)
	// must fail validation rather than become the default.
	const cpuGuardPercent: unknown =
		deps.cpuGuardPercent === undefined
			? EFFICIENCY_CPU_GUARD_PERCENT
			: deps.cpuGuardPercent
	let lastMono: number | null = null
	let interval: { cancel(): void } | undefined
	// Evidence time is strictly monotonic: a raw clock that goes back is offset
	// so it continues from the last reading. A discontinuity discards every
	// source's coverage (probation restarts from zero); drops already seen keep
	// their place in this one time domain, so they still condemn the
	// probationers admitted before them and never poison later admissions.
	let lastRaw: number | null = null
	let offset = 0
	const discontinuity = () => {
		for (const s of states.values()) {
			s.pending = null
			s.rawSamples = []
			s.windows = []
			s.openWindow = null
			s.coverageBlocked = false
			s.upstream = null
			s.covered = []
			s.lastCompleteMono = null
			// Admission needs a fresh full clean window after a discontinuity.
			s.cleanSinceMono = null
		}
	}
	const clock = () => {
		let raw: number
		try {
			raw = monoNow()
		} catch {
			discontinuity()
			return NaN
		}
		if (!Number.isFinite(raw) || raw < 0) {
			discontinuity()
			return NaN
		}
		if (lastRaw !== null && raw < lastRaw) {
			offset += lastRaw - raw
			discontinuity()
		}
		lastRaw = raw
		return raw + offset
	}
	const recoveries = new Map<
		string,
		{ epoch: number; readyAt: number | null }
	>()
	let nextSourceEpoch = 0
	const sourceRemoved = (id: string) => {
		recoveries.delete(id)
		states.delete(id)
	}
	const resetSource = (s: SourceState) => {
		s.seen = null
		s.signature = null
		s.pending = null
		s.rawSamples = []
		s.upstream = null
		s.covered = []
		s.windows = []
		s.openWindow = null
		s.lastCompleteMono = null
		s.latest = "unknown"
		s.cleanSinceMono = null
		s.rate = null
	}
	const sourceDown = (id: string) => {
		const s = states.get(id)
		if (s) resetSource(s)
		recoveries.set(id, {
			epoch: ++nextSourceEpoch,
			readyAt: null,
		})
	}
	const sourceData = (id: string, chunk: Buffer) => {
		const recovery = recoveries.get(id)
		if (recovery && recovery.readyAt === null && chunk.length > 0) {
			const at = clock()
			if (Number.isFinite(at)) recovery.readyAt = at + EFFICIENCY_SAMPLE_MS
		}
	}
	const fresh = (): SourceState => ({
		pending: null,
		branchDrops: new Map(),
		rawSamples: [],
		upstream: null,
		coverageBlocked: false,
		latest: null,
		lastNonNone: null,
		counts: [],
		linkDrops: [],
		windows: [],
		openWindow: null,
		logged: new Map(),
		seen: null,
		unbaselined: new Set(),
		signature: null,
		lastTickMono: null,
		lastCompleteMono: null,
		cleanSinceMono: null,
		lastDropMono: null,
		faultMono: null,
		rate: null,
		covered: [],
		drops: [],
	})
	const fault = (s: SourceState, at: number | null) => {
		s.cleanSinceMono = null
		s.faultMono = at
		s.rate = null
	}
	const sampleNow = (): EfficiencySample => {
		const at = clock()
		const validClock =
			Number.isFinite(at) && (lastMono === null || at > lastMono)
		if (Number.isFinite(at) && !validClock) discontinuity()
		lastMono = Number.isFinite(at) ? at : null
		let ids: readonly string[] = []
		let readable = true
		try {
			const parsed = z.array(z.string().min(1)).safeParse(deps.sources())
			if (parsed.success) ids = parsed.data
			else readable = false
		} catch {
			readable = false
		}
		if (!readable) {
			for (const s of states.values()) {
				fault(s, Number.isFinite(at) ? at : null)
				s.lastTickMono = Number.isFinite(at) ? at : null
			}
		} else {
			const present = new Set(ids)
			for (const id of states.keys()) if (!present.has(id)) states.delete(id)
		}
		let sampledCpuPercent: number | null = null
		const attributionEnabled = [
			deps.ingest,
			deps.loopDelay,
			deps.shortfall,
			deps.upstreamDroppedTotal,
		].some(value => value !== undefined)
		let commonValid =
			(!attributionEnabled ||
				[deps.ingest, deps.loopDelay, deps.shortfall].every(
					value => typeof value === "function",
				)) &&
			(deps.upstreamDroppedTotal === undefined ||
				typeof deps.upstreamDroppedTotal === "function") &&
			(deps.monoNow === undefined || typeof deps.monoNow === "function") &&
			typeof deps.cpu === "object" &&
			deps.cpu !== null
		let sampledLoopDelayMaxMs: number | null = null
		try {
			const cpu = deps.cpu.normalisedPercent
			if (cpu !== null && Number.isFinite(cpu) && cpu >= 0 && cpu <= 100)
				sampledCpuPercent = cpu
			else if (attributionEnabled) commonValid = false
		} catch {
			if (attributionEnabled) commonValid = false
		}
		try {
			if (deps.loopDelay !== undefined) {
				const parsed = loopSchema.safeParse(deps.loopDelay())
				if (parsed.success) sampledLoopDelayMaxMs = parsed.data.maxMs
				else commonValid = false
			}
		} catch {
			commonValid = false
		}
		const sources = new Map<string, SourceDropSample>()
		for (const id of readable ? new Set(ids) : states.keys()) {
			let cpuPercent = sampledCpuPercent
			let loopDelayMaxMs = sampledLoopDelayMaxMs
			const s = states.get(id) ?? fresh()
			states.set(id, s)
			const sourceRecovery = recoveries.get(id)
			if (
				sourceRecovery &&
				(sourceRecovery.readyAt === null ||
					!Number.isFinite(at) ||
					at <= sourceRecovery.readyAt)
			) {
				// Baseline again after delivery settles: reconnect counters and gaps
				// describe the source transition, never consumer performance.
				resetSource(s)
				s.lastTickMono = Number.isFinite(at) ? at : null
				fault(s, Number.isFinite(at) ? at : null)
				sources.set(id, {
					attribution: "unknown",
					droppedBytesDelta: null,
					droppedChunksDelta: null,
				})
				continue
			}
			s.branchDrops.clear()
			let counters: ReadonlyMap<string, Counters> | null = null
			let signature: string | null = null
			try {
				counters = deps.branchCounters(id)
				signature = deps.topology?.(id) ?? null
				if (typeof signature !== "string" || !signature) signature = null
				if (counters !== null) {
					const snapshot = new Map<string, Counters>()
					for (const [key, value] of counters) {
						if (typeof key !== "string") {
							snapshot.clear()
							counters = null
							break
						}
						const parsed = counterSchema.safeParse(value)
						// Retain invalid totals for the existing per-key recovery path.
						snapshot.set(
							key,
							parsed.success
								? {
										droppedBytesTotal: parsed.data.droppedBytesTotal,
										droppedChunksTotal: parsed.data.droppedChunksTotal,
										...(parsed.data.active === undefined
											? {}
											: { active: parsed.data.active }),
									}
								: { droppedBytesTotal: NaN, droppedChunksTotal: NaN },
						)
					}
					if (counters !== null) counters = snapshot
				}
			} catch {
				counters = null
			}
			// Without a time for the read, its deltas carry to the next timed read.
			if (!Number.isFinite(at)) counters = null
			// Evidence is per branch identity: a branch present in two valid reads
			// whose counters did not decrease contributes its positive delta, even
			// across unreadable reads and other branches' additions or removals. A
			// branch added since the last valid read started at zero, so its first
			// total is its delta. A decrease or removal loses that branch only.
			let absorberOverflow: number | null = null
			let bytes = 0
			let chunks = 0
			let complete = counters !== null && signature !== null
			let valid = true
			const first = s.seen === null
			if (counters !== null) {
				const next = new Map(s.seen ?? [])
				for (const key of s.seen?.keys() ?? [])
					if (!counters.has(key)) {
						next.delete(key)
						complete = false
					}
				for (const key of s.unbaselined)
					if (!counters.has(key)) s.unbaselined.delete(key)
				for (const [key, value] of counters) {
					if (
						!validTotal(value.droppedBytesTotal) ||
						!validTotal(value.droppedChunksTotal)
					) {
						complete = false
						valid = false
						// A branch present at the first read has an unknown history.
						if (first) s.unbaselined.add(key)
						continue
					}
					const previous = s.seen?.get(key)
					const counted = { droppedBytesTotal: 0, droppedChunksTotal: 0 }
					next.set(key, {
						droppedBytesTotal: value.droppedBytesTotal,
						droppedChunksTotal: value.droppedChunksTotal,
						...(value.active === undefined ? {} : { active: value.active }),
					})
					if (first || s.unbaselined.delete(key)) {
						complete = false
						continue
					}
					const base = previous ?? counted
					if (
						value.droppedBytesTotal < base.droppedBytesTotal ||
						value.droppedChunksTotal < base.droppedChunksTotal
					) {
						complete = false
						continue
					}
					if (
						previous &&
						(previous.active !== false) !== (value.active !== false)
					)
						complete = false
					const delta = value.droppedBytesTotal - base.droppedBytesTotal
					const chunkDelta = value.droppedChunksTotal - base.droppedChunksTotal
					// Chunk-only loss is still positive drop evidence.
					const loss = Math.max(delta, chunkDelta)
					if (value.active === false && loss > 0) complete = false
					if (key.startsWith("@"))
						absorberOverflow = (absorberOverflow ?? 0) + loss
					else if (value.active !== false) s.branchDrops.set(key, loss)
					bytes += value.droppedBytesTotal - base.droppedBytesTotal
					chunks += value.droppedChunksTotal - base.droppedChunksTotal
				}
				s.seen = next
			}
			if (signature !== s.signature) complete = false
			if (counters !== null && signature !== null) s.signature = signature
			// Coverage and the clean run need both ends to be complete reads
			// (every branch valid) on consecutive ticks at most 1.5 sample
			// periods apart, with every branch comparable in between.
			const gap = s.lastCompleteMono === null ? NaN : at - s.lastCompleteMono
			const comparable =
				readable &&
				validClock &&
				complete &&
				s.lastCompleteMono !== null &&
				s.lastTickMono === s.lastCompleteMono &&
				gap > 0 &&
				gap <= 1.5 * EFFICIENCY_SAMPLE_MS
			let evidenceValid =
				commonValid && nonNegative.safeParse(cpuGuardPercent).success
			let maxGapMs: number | null = null
			let shortfall: boolean | null = null
			let upstreamDropDelta: number | null = null
			try {
				if (deps.ingest !== undefined) {
					const from = s.rawSamples.at(-2)
					if (from !== undefined && validClock && lastRaw !== null) {
						const parsed = ingestSchema.safeParse(
							deps.ingest(id, from, lastRaw),
						)
						if (parsed.success) maxGapMs = parsed.data.maxGapMs
						else evidenceValid = false
					} else evidenceValid = false
				}
			} catch {
				evidenceValid = false
			}
			const applies = deps.attributionApplies?.(id) ?? true
			let recovery = null
			try {
				recovery = applies
					? (deps.recovery?.(id, lastRaw ?? NaN) ?? null)
					: null
				if (recovery !== null && !recoverySchema.safeParse(recovery).success) {
					recovery = null
					evidenceValid = false
				}
			} catch {
				evidenceValid = false
			}
			try {
				if (recovery !== null && recovery.retired !== true) {
					shortfall = recovery.shortfall
				} else if (deps.shortfall !== undefined) {
					const parsed = z.boolean().safeParse(deps.shortfall(id))
					if (parsed.success) shortfall = parsed.data
					else evidenceValid = false
				}
			} catch {
				evidenceValid = false
			}
			try {
				const total = deps.upstreamDroppedTotal?.(id)
				if (total === undefined) upstreamDropDelta = 0
				if (total !== null && validTotal(total)) {
					if (s.upstream !== null && total >= s.upstream)
						upstreamDropDelta = total - s.upstream
					else evidenceValid = false
					s.upstream = total
				} else {
					if (total !== undefined) evidenceValid = false
					s.upstream = null
				}
			} catch {
				s.upstream = null
				evidenceValid = false
			}
			if (!applies) evidenceValid = true
			const intervalBytes = bytes
			const positiveNow = bytes > 0 || chunks > 0
			// A completed episode can be followed by another gap between monitor polls.
			const completedPending =
				s.pending !== null &&
				recovery !== null &&
				recovery.completedSequence >= s.pending.sequence &&
				recovery.failedSequence < s.pending.sequence &&
				comparable &&
				evidenceValid &&
				s.pending.valid &&
				s.pending.upstream === 0 &&
				upstreamDropDelta === 0 &&
				s.pending.gap - s.pending.loop >= LINK_GAP_MS
			const completed = completedPending ? s.pending : null
			if (completed) {
				if (s.openWindow) s.openWindow.linkOrUnknownDrops = true
				// A new loss may belong to a successor episode. Resolve the old
				// interval independently so its bytes cannot inherit that verdict.
				if (positiveNow) {
					s.counts.push({ mono: completed.at, code: "link" })
					try {
						deps.log?.info(
							{
								sourceId: id,
								attribution: "link",
								dropBytes: completed.bytes,
								intervalMono: completed.at,
								gapMs: completed.gap,
								loopDelayMs: completed.loop,
								cpuPercent: completed.cpu,
							},
							"Drop interval attributed",
						)
					} catch {
						/* Observability cannot alter evidence. */
					}
				} else {
					maxGapMs = completed.gap
					loopDelayMaxMs = completed.loop
					cpuPercent = completed.cpu
				}
				s.linkDrops.push(s.pending!.at)
				if (s.linkDrops.length > 32) s.linkDrops.shift()
				s.pending = null
			}
			const consumerNow =
				applies &&
				comparable &&
				evidenceValid &&
				(absorberOverflow ?? 0) === 0 &&
				[...s.branchDrops.values()].some(drop => drop > 0) &&
				[...s.branchDrops.values()].some(drop => drop === 0)
			if (consumerNow && s.pending) {
				s.lastDropMono = at
				s.drops.push(at)
				if (s.drops.length > MAX_DROP_SAMPLES) s.drops.shift()
				fault(s, at)
			}
			if (
				recovery &&
				recovery.retired !== true &&
				comparable &&
				evidenceValid &&
				positiveNow &&
				maxGapMs !== null &&
				loopDelayMaxMs !== null &&
				maxGapMs - loopDelayMaxMs >= LINK_GAP_MS &&
				((absorberOverflow ?? 0) > 0 ||
					(s.branchDrops.size > 0 &&
						[...s.branchDrops.values()].every(drop => drop > 0))) &&
				!s.pending
			)
				s.pending = {
					sequence: recovery.sequence,
					bytes: 0,
					chunks: 0,
					at,
					gap: maxGapMs,
					loop: loopDelayMaxMs,
					cpu: cpuPercent ?? NaN,
					upstream: 0,
					valid: comparable && evidenceValid,
				}
			const pending = s.pending
			if (pending) {
				if (!consumerNow) {
					pending.bytes += bytes
					pending.chunks += chunks
				}
				pending.valid &&=
					comparable &&
					evidenceValid &&
					(recovery === null || recovery.failedSequence < pending.sequence)
				pending.upstream += upstreamDropDelta ?? 0
				pending.loop = Math.max(pending.loop, loopDelayMaxMs ?? NaN)
				pending.cpu = Math.max(pending.cpu, cpuPercent ?? NaN)
				maxGapMs = pending.gap
				loopDelayMaxMs = pending.loop
				cpuPercent = pending.cpu
				upstreamDropDelta = pending.upstream
				shortfall = recovery?.shortfall ?? null
				absorberOverflow = Math.max(absorberOverflow ?? 0, 1)
				evidenceValid &&= pending.valid
			}
			const waiting =
				pending !== null &&
				recovery?.shortfall !== false &&
				recovery?.shortfall !== true &&
				// Maximum supported capacity plus a gap and one polling period.
				at - pending.at <
					LINK_RECOVERY_WAIT_MS + LINK_GAP_MS + EFFICIENCY_SAMPLE_MS
			const unresolved = waiting && !consumerNow
			const attribution =
				completedPending && !positiveNow
					? "link"
					: consumerNow
						? "consumer"
						: !applies
							? positiveNow
								? "unknown"
								: "none"
							: attributeInterval({
									complete: comparable && evidenceValid,
									branchDrops: s.branchDrops,
									absorberOverflow,
									maxGapMs,
									loopDelayMaxMs,
									cpuPercent,
									cpuGuardPercent:
										typeof cpuGuardPercent === "number"
											? cpuGuardPercent
											: Number.NaN,
									shortfall,
									upstreamDropDelta,
								})
			if (pending && !waiting) {
				bytes = pending.bytes
				chunks = pending.chunks
			}
			if (!waiting && !positiveNow && completed) {
				bytes += completed.bytes
				chunks += completed.chunks
			}
			const resolvedAt =
				pending?.at ?? (!positiveNow ? completed?.at : undefined) ?? at
			const positive = positiveNow || pending !== null || completedPending
			const link =
				(attribution === "link" || (completedPending && !positiveNow)) &&
				positive
			if (positive && !waiting) {
				if (link) {
					s.linkDrops.push(resolvedAt)
					if (s.linkDrops.length > 32) s.linkDrops.shift()
				} else {
					s.lastDropMono = Math.max(
						s.lastDropMono ?? -Infinity,
						pending?.at ?? at,
					)
					s.drops.push(pending?.at ?? at)
					if (s.drops.length > MAX_DROP_SAMPLES) s.drops.shift()
				}
			}
			if (
				comparable &&
				evidenceValid &&
				!link &&
				!waiting &&
				!s.coverageBlocked
			) {
				const last = s.covered.at(-1)
				if (last && last.to === s.lastCompleteMono) last.to = at
				else s.covered.push({ from: s.lastCompleteMono!, to: at })
				if (s.covered.length > MAX_COVERED_INTERVALS) s.covered.shift()
			}
			if (!link && !waiting) {
				if (comparable && evidenceValid && attribution === "none" && !positive)
					s.cleanSinceMono ??= at
				else fault(s, Number.isFinite(at) ? at : null)
			}
			s.coverageBlocked = link || waiting || !evidenceValid
			if (!waiting) s.pending = null
			s.latest = unresolved ? null : attribution
			if (Number.isFinite(at)) {
				if (!unresolved) s.counts.push({ mono: resolvedAt, code: attribution })
				if (s.counts.length > 300) s.counts.shift()
				// Windows are (start, end]: the closing sample belongs to the window it closes.
				if (s.openWindow === null)
					s.openWindow = {
						startMono: at,
						endMono: at + EFFICIENCY_DROP_WINDOW_MS,
						condemning: false,
						linkOrUnknownDrops: false,
						complete: true,
					}
				const w = s.openWindow
				if (at > w.startMono) {
					w.complete &&= comparable && evidenceValid
					if (positive && !unresolved) {
						if (attribution === "host" || attribution === "consumer")
							w.condemning = true
						else w.linkOrUnknownDrops = true
					}
				}
				if (at >= w.endMono && !waiting) {
					if (w.complete) {
						s.windows.push({
							startMono: w.startMono,
							endMono: w.endMono,
							condemning: w.condemning,
							linkOrUnknownDrops: !w.condemning && w.linkOrUnknownDrops,
						})
						if (s.windows.length > LATE_SHED_WINDOWS) s.windows.shift()
					}
					const start =
						w.endMono +
						Math.floor((at - w.endMono) / EFFICIENCY_DROP_WINDOW_MS) *
							EFFICIENCY_DROP_WINDOW_MS
					s.openWindow = {
						startMono: start,
						endMono: start + EFFICIENCY_DROP_WINDOW_MS,
						condemning: false,
						linkOrUnknownDrops: false,
						complete: comparable && evidenceValid,
					}
				}
				if (validClock && lastRaw !== null) {
					s.rawSamples.push(lastRaw)
					if (s.rawSamples.length > 2) s.rawSamples.shift()
				}
				try {
					if (
						!unresolved &&
						attribution !== "none" &&
						attribution !== s.lastNonNone
					) {
						deps.log?.info(
							{ sourceId: id, from: s.lastNonNone, to: attribution },
							"Drop attribution changed",
						)
						s.lastNonNone = attribution
					}
					const logged = s.logged.get(attribution)
					if (
						!unresolved &&
						positive &&
						(logged === undefined || at - logged >= 60_000)
					) {
						deps.log?.info(
							{
								sourceId: id,
								attribution,
								dropBytes: bytes,
								intervalMono: resolvedAt,
								gapMs: maxGapMs,
								loopDelayMs: loopDelayMaxMs,
								cpuPercent,
							},
							"Drop interval attributed",
						)
						s.logged.set(attribution, at)
					}
				} catch {
					/* Observability cannot alter evidence. */
				}
			}

			s.rate = comparable && gap > 0 ? (intervalBytes * 1000) / gap : null
			s.lastCompleteMono =
				counters !== null && signature !== null && valid && validClock
					? at
					: null
			s.lastTickMono = Number.isFinite(at) ? at : null
			sources.set(id, {
				...(unresolved ? {} : { attribution }),
				droppedBytesDelta:
					!unresolved && (comparable || pending !== null || completedPending)
						? bytes
						: null,
				droppedChunksDelta:
					!unresolved && (comparable || pending !== null || completedPending)
						? chunks
						: null,
			})
		}
		let atMs = NaN
		try {
			atMs = deps.now()
		} catch {
			/* Display only. */
		}
		return { atMs, cpuPercent: sampledCpuPercent, sources }
	}
	const dropState: DropReader["dropState"] = id => {
		const at = clock()
		const s = states.get(id)
		if (
			!s ||
			!Number.isFinite(at) ||
			s.lastTickMono === null ||
			at < s.lastTickMono
		)
			return { state: "unknown", dropBytesPerSecond: null }
		let state: "ok" | "dropping" | "unknown" = "unknown"
		if (
			s.pending === null &&
			s.cleanSinceMono !== null &&
			at - s.cleanSinceMono >= EFFICIENCY_CLEAR_MS &&
			at - s.lastTickMono <= EFFICIENCY_STALE_MS
		)
			state = "ok"
		else if (
			s.lastDropMono !== null &&
			at >= s.lastDropMono &&
			at - s.lastDropMono < EFFICIENCY_CLEAR_MS
		)
			state = "dropping"
		return {
			state,
			dropBytesPerSecond:
				at - s.lastTickMono <= EFFICIENCY_STALE_MS ? s.rate : null,
		}
	}
	// Probation evidence: only a positive drop delta observed at or after the
	// admission mark counts. Missing, stale or faulted evidence is unknown, which
	// closes admission (dropState) but never condemns a running probationer.
	const droppedSinceMono = (id: string, since: number): boolean => {
		const s = states.get(id)
		if (!s || !Number.isFinite(since)) return false
		return s.lastDropMono !== null && s.lastDropMono >= since
	}
	// Probation is earned: only intervals with complete, timely per-branch
	// evidence count toward it.
	const coveredSinceMono = (id: string, since: number): number => {
		const s = states.get(id)
		if (!s || !Number.isFinite(since)) return 0
		// Intervals are disjoint and increasing (cleared on any discontinuity);
		// the running end guards against counting any overlap twice.
		let total = 0
		let end = since
		for (const { from, to } of s.covered) {
			const start = Math.max(from, end)
			if (to > start) {
				total += to - start
				end = to
			}
		}
		return total
	}
	const droppedBetweenMono = (id: string, from: number, to: number) => {
		const s = states.get(id)
		if (!s || !Number.isFinite(from)) return false
		return s.drops.some(t => t >= from && t <= to)
	}
	// The sample that completes `amount` of coverage since `since`; drops seen
	// up to and including it are judged before graduation.
	const coverageCompleteAtMono = (
		id: string,
		since: number,
		amount: number,
	): number | null => {
		const s = states.get(id)
		if (!s || s.pending !== null || !Number.isFinite(since)) return null
		let total = 0
		let end = since
		for (const { from, to } of s.covered) {
			const start = Math.max(from, end)
			if (to <= start) continue
			total += to - start
			end = to
			if (total >= amount) return to
		}
		return null
	}
	return {
		latestAttribution(id) {
			const at = clock()
			const s = states.get(id)
			return s &&
				Number.isFinite(at) &&
				s.lastTickMono !== null &&
				at >= s.lastTickMono &&
				at - s.lastTickMono <= EFFICIENCY_STALE_MS
				? s.latest
				: null
		},
		lateWindows(id) {
			const at = clock()
			const s = states.get(id)
			if (
				!s ||
				!Number.isFinite(at) ||
				s.lastTickMono === null ||
				at < s.lastTickMono ||
				at - s.lastTickMono > EFFICIENCY_STALE_MS
			)
				return []
			return s.windows.map(w => ({ ...w }))
		},
		linkDropsSince(id, since) {
			const at = clock()
			return (
				Number.isFinite(at) &&
				Number.isFinite(since) &&
				since <= at &&
				(states.get(id)?.linkDrops.some(t => t >= since && t <= at) ?? false)
			)
		},
		attributionCounts(id) {
			const at = clock()
			const s = states.get(id)
			if (!s || !Number.isFinite(at)) return null
			const counts10m: Record<DropAttribution, number> = {
				none: 0,
				link: 0,
				host: 0,
				consumer: 0,
				unknown: 0,
			}
			for (const entry of s.counts)
				if (entry.mono <= at && at - entry.mono <= 600_000)
					counts10m[entry.code]++
			return { last: s.latest, counts10m }
		},
		sourceEpoch: id => recoveries.get(id)?.epoch ?? 0,
		monoNow: clock,
		lastSampleMono: () => lastMono,
		droppedBetweenMono,
		coverageCompleteAtMono,
		sources: () => [...states.keys()],
		droppedSinceMono,
		coveredSinceMono,
		cleanAtMono(id) {
			const s = states.get(id)
			return s && s.cleanSinceMono !== null
				? s.cleanSinceMono + EFFICIENCY_CLEAR_MS
				: null
		},
		sampleNow,
		dropState,
		// Inclusive lookback: a drop or fault at admission counts. Missing,
		// stale and invalid-clock evidence fails closed. An unknown interval lasts
		// until a full clean window is earned; any overlap with the lookback counts.
		droppedWithinMs(id, ms) {
			const at = clock()
			const s = states.get(id)
			if (
				!s ||
				!Number.isFinite(at) ||
				!Number.isFinite(ms) ||
				ms < 0 ||
				s.lastTickMono === null ||
				at < s.lastTickMono ||
				at - s.lastTickMono > EFFICIENCY_STALE_MS
			)
				return true
			return (
				[s.lastDropMono, s.faultMono].some(
					t => t !== null && (at < t || at - t <= ms),
				) ||
				s.cleanSinceMono === null ||
				at - s.cleanSinceMono < EFFICIENCY_CLEAR_MS + ms
			)
		},
		start() {
			if (!interval) {
				deps.sourceEvents?.on("disconnected", sourceDown)
				deps.sourceEvents?.on("removed", sourceDown)
				deps.sourceEvents?.on("source-removed", sourceRemoved)
				deps.sourceEvents?.on("data", sourceData)
			}
			interval ??= deps.setInterval(() => {
				const sample = sampleNow()
				try {
					deps.onSample?.(sample)
				} catch {
					/* Display delivery is irrelevant to evidence. */
				}
			}, EFFICIENCY_SAMPLE_MS)
		},
		stop() {
			deps.sourceEvents?.off("disconnected", sourceDown)
			deps.sourceEvents?.off("removed", sourceDown)
			deps.sourceEvents?.off("source-removed", sourceRemoved)
			deps.sourceEvents?.off("data", sourceData)
			recoveries.clear()
			interval?.cancel()
			interval = undefined
			states.clear()
			lastMono = null
		},
	}
}
