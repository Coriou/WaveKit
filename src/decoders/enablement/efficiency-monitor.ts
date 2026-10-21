import { performance } from "node:perf_hooks"
import { EFFICIENCY_CLEAR_MS, EFFICIENCY_SAMPLE_MS } from "./contract.js"
import type { EfficiencySample, SourceDropSample } from "./contract.js"
import type { DropReader } from "./efficiency-gate.js"

export const EFFICIENCY_STALE_MS = 3 * EFFICIENCY_SAMPLE_MS
type Counters = { droppedBytesTotal: number; droppedChunksTotal: number }
type Baseline = {
	branches: ReadonlyMap<string, Counters>
	topologySignature: string
}
type SourceState = {
	baseline: Baseline | null
	lastTickMono: number | null
	cleanSinceMono: number | null
	lastDropMono: number | null
	faultMono: number | null
	rate: number | null
}
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
}): DropReader & {
	start(): void
	stop(): void
	sampleNow(): EfficiencySample
} {
	const states = new Map<string, SourceState>()
	const monoNow = deps.monoNow ?? (() => performance.now())
	let lastMono: number | null = null
	let interval: { cancel(): void } | undefined
	const clock = () => {
		try {
			return monoNow()
		} catch {
			return NaN
		}
	}
	const fresh = (): SourceState => ({
		baseline: null,
		lastTickMono: null,
		cleanSinceMono: null,
		lastDropMono: null,
		faultMono: null,
		rate: null,
	})
	const fault = (s: SourceState, at: number | null) => {
		s.cleanSinceMono = null
		s.faultMono = at
		s.rate = null
	}
	const sampleNow = (): EfficiencySample => {
		const at = clock()
		const validClock =
			Number.isFinite(at) && (lastMono === null || at >= lastMono)
		// Reset the clock reference after a fault so backwards clocks can recover.
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
				s.baseline = null
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
			// A clock discontinuity ends the old clock domain. The fault and new
			// clean window replace timestamps that could otherwise remain future.
			if (!validClock) s.lastDropMono = null
			let baseline: Baseline | null = null
			try {
				const counters = deps.branchCounters(id)
				const topologySignature = deps.topology?.(id) ?? null
				if (counters !== null && topologySignature !== null) {
					const branches = new Map<string, Counters>()
					let readableBranches = true
					for (const [key, value] of counters) {
						const bytes = value.droppedBytesTotal
						const chunks = value.droppedChunksTotal
						const previous = s.baseline?.branches.get(key)
						if (
							validClock &&
							previous &&
							((validTotal(bytes) && bytes > previous.droppedBytesTotal) ||
								(validTotal(chunks) && chunks > previous.droppedChunksTotal))
						)
							s.lastDropMono = at
						if (!validTotal(bytes) || !validTotal(chunks))
							readableBranches = false
						branches.set(key, {
							droppedBytesTotal: bytes,
							droppedChunksTotal: chunks,
						})
					}
					if (readableBranches) baseline = { branches, topologySignature }
				}
			} catch {
				/* Unreadable counters invalidate the whole interval. */
			}
			const before = s.baseline
			const gap = s.lastTickMono === null ? NaN : at - s.lastTickMono
			let bytes = 0
			let chunks = 0
			let comparable =
				readable &&
				validClock &&
				baseline !== null &&
				before !== null &&
				baseline.topologySignature === before.topologySignature &&
				baseline.branches.size === before.branches.size
			if (baseline && before) {
				for (const [key, value] of baseline.branches) {
					const previous = before.branches.get(key)
					if (
						!previous ||
						value.droppedBytesTotal < previous.droppedBytesTotal ||
						value.droppedChunksTotal < previous.droppedChunksTotal
					) {
						comparable = false
						continue
					}
					bytes += value.droppedBytesTotal - previous.droppedBytesTotal
					chunks += value.droppedChunksTotal - previous.droppedChunksTotal
				}
			}

			const clean =
				comparable &&
				bytes === 0 &&
				chunks === 0 &&
				gap >= 0 &&
				gap <= 1.5 * EFFICIENCY_SAMPLE_MS
			if (clean) s.cleanSinceMono ??= at
			else fault(s, Number.isFinite(at) ? at : null)
			s.rate = comparable && gap > 0 ? (bytes * 1000) / gap : null
			s.baseline = readable ? baseline : null
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
	const droppedSinceMono = (id: string, since: number): boolean => {
		const at = clock()
		const s = states.get(id)
		if (
			!s ||
			!Number.isFinite(at) ||
			!Number.isFinite(since) ||
			since > at ||
			s.lastTickMono === null ||
			at < s.lastTickMono ||
			at - s.lastTickMono > EFFICIENCY_STALE_MS
		)
			return true
		return (
			[s.lastDropMono, s.faultMono].some(
				t => t !== null && (t >= since || t > at),
			) ||
			s.cleanSinceMono === null ||
			s.cleanSinceMono + EFFICIENCY_CLEAR_MS > since
		)
	}
	return {
		monoNow: clock,
		sources: () => [...states.keys()],
		droppedSinceMono,
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
