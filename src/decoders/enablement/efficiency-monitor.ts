import { performance } from "node:perf_hooks"
import {
	EFFICIENCY_CLEAR_MS,
	EFFICIENCY_SAMPLE_MS,
	EFFICIENCY_STALE_MS,
} from "./contract.js"
import type { EfficiencySample, SourceDropSample } from "./contract.js"
import type { DropReader } from "./efficiency-gate.js"

type Counters = { droppedBytesTotal: number; droppedChunksTotal: number }
type SourceState = {
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
	sources: () => readonly string[]
	branchCounters: (id: string) => ReadonlyMap<string, Counters> | null
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
		start(): void
		stop(): void
		sampleNow(): EfficiencySample
	} {
	const states = new Map<string, SourceState>()
	const monoNow = deps.monoNow ?? (() => performance.now())
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
			return NaN
		}
		if (!Number.isFinite(raw)) return NaN
		if (lastRaw !== null && raw < lastRaw) {
			offset += lastRaw - raw
			discontinuity()
		}
		lastRaw = raw
		return raw + offset
	}
	const fresh = (): SourceState => ({
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
			ids = Array.from(deps.sources())
			if (ids.some(id => typeof id !== "string" || !id)) readable = false
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
		const sources = new Map<string, SourceDropSample>()
		for (const id of readable ? new Set(ids) : states.keys()) {
			const s = states.get(id) ?? fresh()
			states.set(id, s)
			let counters: ReadonlyMap<string, Counters> | null = null
			let signature: string | null = null
			try {
				counters = deps.branchCounters(id)
				signature = deps.topology?.(id) ?? null
				if (counters !== null) counters = new Map(counters)
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
					bytes += value.droppedBytesTotal - base.droppedBytesTotal
					chunks += value.droppedChunksTotal - base.droppedChunksTotal
				}
				s.seen = next
				if (bytes > 0 || chunks > 0) {
					s.lastDropMono = at
					s.drops.push(at)
					if (s.drops.length > MAX_DROP_SAMPLES) s.drops.shift()
				}
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
			if (comparable) {
				const last = s.covered.at(-1)
				if (last && last.to === s.lastCompleteMono) last.to = at
				else s.covered.push({ from: s.lastCompleteMono!, to: at })
				if (s.covered.length > MAX_COVERED_INTERVALS) s.covered.shift()
			}
			if (comparable && bytes === 0 && chunks === 0) s.cleanSinceMono ??= at
			else fault(s, Number.isFinite(at) ? at : null)
			s.rate = comparable && gap > 0 ? (bytes * 1000) / gap : null
			s.lastCompleteMono =
				counters !== null && signature !== null && valid && validClock
					? at
					: null
			s.lastTickMono = Number.isFinite(at) ? at : null
			sources.set(id, {
				droppedBytesDelta: comparable ? bytes : null,
				droppedChunksDelta: comparable ? chunks : null,
			})
		}
		let atMs = NaN
		let cpuPercent: number | null = null
		try {
			atMs = deps.now()
		} catch {
			/* Display only. */
		}
		try {
			const cpu = deps.cpu.normalisedPercent
			if (cpu !== null && Number.isFinite(cpu) && cpu >= 0 && cpu <= 100)
				cpuPercent = cpu
		} catch {
			/* Display only. */
		}
		return { atMs, cpuPercent, sources }
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
		if (!s || !Number.isFinite(since)) return null
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
		/** Inclusive lookback: a drop or fault at admission counts. Missing,
		 * stale and invalid-clock evidence fails closed. An unknown interval lasts
		 * until a full clean window is earned; any overlap with the lookback counts. */
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
			interval?.cancel()
			interval = undefined
			states.clear()
			lastMono = null
		},
	}
}
