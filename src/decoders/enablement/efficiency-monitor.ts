import { WaveKitError } from "../../utils/errors.js"
import { EFFICIENCY_SAMPLE_MS } from "./contract.js"
import type { EfficiencySample, SourceDropSample } from "./contract.js"

type DropTotals = { droppedBytesTotal: number; droppedChunksTotal: number }

const validTotal = (value: unknown): value is number =>
	typeof value === "number" && Number.isSafeInteger(value) && value >= 0

/** Samples cumulative counters without adding work to the source stream. */
export function createEfficiencyMonitor(deps: {
	sources: () => readonly string[]
	dropTotals: (sourceId: string) => DropTotals | null
	cpu: { readonly normalisedPercent: number | null }
	now: () => number
	setInterval: (fn: () => void, ms: number) => { cancel(): void }
	onSample: (s: EfficiencySample) => void
}): { start(): void; stop(): void; sampleNow(): EfficiencySample } {
	let baselines = new Map<string, DropTotals>()
	const pendingUnknown = new Set<string>()
	// Positive deltas a read observed but no successful delivery has carried yet.
	const pendingDrops = new Map<string, { bytes: number; chunks: number }>()
	let lastAtMs = -1
	let knownSources = new Set<string>()
	let interval: { cancel(): void } | undefined
	const unknown = (): SourceDropSample => ({
		droppedBytesDelta: null,
		droppedChunksDelta: null,
	})

	const candidate = () => {
		let atMs = NaN
		try {
			atMs = deps.now()
			if (!Number.isFinite(atMs) || atMs < 0 || atMs < lastAtMs) atMs = NaN
		} catch {
			// Invalid clocks leave cumulative evidence untouched.
		}
		if (Number.isNaN(atMs)) {
			return {
				sample: {
					atMs: NaN,
					cpuPercent: null,
					sources: new Map([...knownSources].map(id => [id, unknown()])),
				},
				commit: () => {},
			}
		}
		const nextBaselines = new Map(baselines)
		let nextSources = knownSources
		const deliveredUnknown = new Set<string>()
		let enumerated = false
		const commit = () => {
			baselines = nextBaselines
			knownSources = nextSources
			lastAtMs = atMs
			for (const id of deliveredUnknown) pendingUnknown.delete(id)
			for (const id of sources.keys()) pendingDrops.delete(id)
			if (enumerated) {
				for (const id of pendingUnknown)
					if (!nextSources.has(id)) pendingUnknown.delete(id)
				for (const id of pendingDrops.keys())
					if (!nextSources.has(id)) pendingDrops.delete(id)
			}
		}
		const sources = new Map<string, SourceDropSample>()
		let cpuPercent: number | null = null
		let ids: readonly string[]
		try {
			const result = deps.sources()
			if (
				typeof result === "string" ||
				result == null ||
				typeof result[Symbol.iterator] !== "function"
			)
				throw new WaveKitError("Invalid sources", "EFFICIENCY_SOURCES_INVALID")
			ids = Array.from(result)
			if (ids.some(id => typeof id !== "string" || id.length === 0))
				throw new WaveKitError(
					"Invalid source id",
					"EFFICIENCY_SOURCES_INVALID",
				)
			const cpu = deps.cpu.normalisedPercent
			cpuPercent =
				typeof cpu === "number" &&
				Number.isFinite(cpu) &&
				cpu >= 0 &&
				cpu <= 100
					? cpu
					: null
		} catch {
			nextBaselines.clear()
			for (const id of knownSources) {
				pendingUnknown.add(id)
				sources.set(id, withHeldDrops(id, unknown(), deliveredUnknown))
			}
			return { sample: { atMs, cpuPercent, sources }, commit }
		}

		nextSources = new Set(ids)
		enumerated = true
		for (const id of nextBaselines.keys()) {
			if (!nextSources.has(id)) nextBaselines.delete(id)
		}
		for (const id of nextSources) {
			let deltas = unknown()
			try {
				const totals = deps.dropTotals(id)
				// Copy once: a provider may reuse its object between reads.
				const bytes = totals?.droppedBytesTotal
				const chunks = totals?.droppedChunksTotal
				const previous = pendingUnknown.has(id)
					? undefined
					: nextBaselines.get(id)
				if (
					!validTotal(bytes) ||
					!validTotal(chunks) ||
					(previous &&
						(bytes < previous.droppedBytesTotal ||
							chunks < previous.droppedChunksTotal))
				) {
					pendingUnknown.add(id)
					nextBaselines.delete(id)
				} else {
					if (previous) {
						deltas = {
							droppedBytesDelta: bytes - previous.droppedBytesTotal,
							droppedChunksDelta: chunks - previous.droppedChunksTotal,
						}
					}
					// After any unknown read, the next valid read only re-baselines.
					nextBaselines.set(id, {
						droppedBytesTotal: bytes,
						droppedChunksTotal: chunks,
					})
				}
			} catch {
				pendingUnknown.add(id)
				nextBaselines.delete(id)
			}
			if (
				deltas.droppedBytesDelta !== null &&
				deltas.droppedChunksDelta !== null &&
				(deltas.droppedBytesDelta > 0 || deltas.droppedChunksDelta > 0)
			) {
				const held = pendingDrops.get(id)
				pendingDrops.set(id, {
					bytes: Math.max(held?.bytes ?? 0, deltas.droppedBytesDelta),
					chunks: Math.max(held?.chunks ?? 0, deltas.droppedChunksDelta),
				})
			}
			sources.set(id, withHeldDrops(id, deltas, deliveredUnknown))
		}
		return { sample: { atMs, cpuPercent, sources }, commit }
	}

	// A drop seen by any read reaches the gate even if a reset or topology change
	// later hides it; one counter stays null so held evidence never reads as clean.
	const withHeldDrops = (
		id: string,
		deltas: SourceDropSample,
		deliveredUnknown: Set<string>,
	): SourceDropSample => {
		const held = pendingDrops.get(id)
		if (
			deltas.droppedBytesDelta === null ||
			deltas.droppedChunksDelta === null
		) {
			deliveredUnknown.add(id)
			if (!held) return deltas
			return held.bytes > 0
				? { droppedBytesDelta: held.bytes, droppedChunksDelta: null }
				: { droppedBytesDelta: null, droppedChunksDelta: held.chunks }
		}
		if (!held) return deltas
		return {
			droppedBytesDelta: Math.max(held.bytes, deltas.droppedBytesDelta),
			droppedChunksDelta: Math.max(held.chunks, deltas.droppedChunksDelta),
		}
	}

	// Peeks retain timer-delivery baselines and pending uncertainty.
	const sampleNow = (): EfficiencySample => candidate().sample
	return {
		sampleNow,
		start() {
			interval ??= deps.setInterval(() => {
				const result = candidate()
				if (!Number.isFinite(result.sample.atMs)) return
				try {
					deps.onSample(result.sample)
					result.commit()
				} catch {
					// Keep baselines and pending uncertainty until delivery succeeds.
				}
			}, EFFICIENCY_SAMPLE_MS)
		},
		stop() {
			interval?.cancel()
			interval = undefined
		},
	}
}
