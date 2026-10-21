import { WaveKitError } from "../../utils/errors.js"
import { EFFICIENCY_SAMPLE_MS } from "./contract.js"
import type { EfficiencySample, SourceDropSample } from "./contract.js"

type DropTotals = { droppedBytesTotal: number; droppedChunksTotal: number }
type Baseline = {
	droppedBytesTotal: number | null
	droppedChunksTotal: number | null
}

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
	let baselines = new Map<string, Baseline>()
	let generation = 0
	let delivering = false
	const pendingUnknown = new Map<string, number>()
	// Positive deltas a read observed but no successful delivery has carried yet.
	// Delivery acknowledges only its captured generation, never later reentrant reads.
	const pendingDrops = new Map<
		string,
		{ bytes: number; chunks: number; generation: number }
	>()
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
			for (const id of knownSources) pendingUnknown.set(id, ++generation)
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
		const deliveredDrops = new Map<string, number>()
		const unknownGenerations = new Map<string, number>()
		const commit = () => {
			baselines = nextBaselines
			knownSources = nextSources
			lastAtMs = atMs
			for (const id of deliveredUnknown) {
				if (
					(pendingUnknown.get(id) ?? Infinity) <=
					(unknownGenerations.get(id) ?? -1)
				)
					pendingUnknown.delete(id)
			}
			for (const [id, ack] of deliveredDrops) {
				if ((pendingDrops.get(id)?.generation ?? Infinity) <= ack)
					pendingDrops.delete(id)
			}
			for (const id of pendingUnknown.keys())
				if (!nextSources.has(id) && !pendingDrops.has(id))
					pendingUnknown.delete(id)
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
			for (const id of new Set([
				...knownSources,
				...pendingDrops.keys(),
				...pendingUnknown.keys(),
			])) {
				pendingUnknown.set(id, ++generation)
				sources.set(id, withHeldDrops(id, unknown(), deliveredUnknown))
			}
			for (const id of sources.keys()) {
				const held = pendingDrops.get(id)
				if (held) deliveredDrops.set(id, held.generation)
				const uncertain = pendingUnknown.get(id)
				if (uncertain !== undefined) unknownGenerations.set(id, uncertain)
			}
			return { sample: { atMs, cpuPercent, sources }, commit }
		}

		nextSources = new Set(ids)
		for (const id of nextBaselines.keys()) {
			if (!nextSources.has(id)) {
				pendingUnknown.set(id, ++generation)
				nextBaselines.delete(id)
			}
		}
		for (const id of nextSources) {
			let deltas = unknown()
			try {
				const totals = deps.dropTotals(id)
				// Copy once: a provider may reuse its object between reads.
				const bytes = totals?.droppedBytesTotal
				const chunks = totals?.droppedChunksTotal
				const previous = nextBaselines.get(id)
				const delta = (value: unknown, before: number | null | undefined) =>
					validTotal(value) && before != null && value >= before
						? value - before
						: null
				deltas = {
					droppedBytesDelta: delta(bytes, previous?.droppedBytesTotal),
					droppedChunksDelta: delta(chunks, previous?.droppedChunksTotal),
				}
				if (
					!validTotal(bytes) ||
					!validTotal(chunks) ||
					deltas.droppedBytesDelta === null ||
					deltas.droppedChunksDelta === null
				)
					pendingUnknown.set(id, ++generation)
				if (!validTotal(bytes) || !validTotal(chunks)) {
					baselines.set(id, {
						droppedBytesTotal: validTotal(bytes)
							? (previous?.droppedBytesTotal ?? null)
							: null,
						droppedChunksTotal: validTotal(chunks)
							? (previous?.droppedChunksTotal ?? null)
							: null,
					})
				}
				nextBaselines.set(id, {
					droppedBytesTotal: validTotal(bytes) ? bytes : null,
					droppedChunksTotal: validTotal(chunks) ? chunks : null,
				})
			} catch {
				pendingUnknown.set(id, ++generation)
				nextBaselines.delete(id)
			}
			if (
				(deltas.droppedBytesDelta ?? 0) > 0 ||
				(deltas.droppedChunksDelta ?? 0) > 0
			) {
				const held = pendingDrops.get(id)
				pendingDrops.set(id, {
					bytes: Math.max(held?.bytes ?? 0, deltas.droppedBytesDelta ?? 0),
					chunks: Math.max(held?.chunks ?? 0, deltas.droppedChunksDelta ?? 0),
					generation: ++generation,
				})
			}
			sources.set(id, withHeldDrops(id, deltas, deliveredUnknown))
		}
		for (const id of pendingDrops.keys()) {
			if (!sources.has(id))
				sources.set(id, withHeldDrops(id, unknown(), deliveredUnknown))
		}
		for (const id of sources.keys()) {
			const held = pendingDrops.get(id)
			if (held) deliveredDrops.set(id, held.generation)
			const uncertain = pendingUnknown.get(id)
			if (uncertain !== undefined) unknownGenerations.set(id, uncertain)
		}
		return { sample: { atMs, cpuPercent, sources }, commit }
	}

	// Every positive held counter is carried together; only zero/zero is clean.
	const withHeldDrops = (
		id: string,
		deltas: SourceDropSample,
		deliveredUnknown: Set<string>,
	): SourceDropSample => {
		const held = pendingDrops.get(id)
		if (
			deltas.droppedBytesDelta === null ||
			deltas.droppedChunksDelta === null ||
			pendingUnknown.has(id)
		) {
			deliveredUnknown.add(id)
			if (!held)
				return deltas.droppedBytesDelta === null ||
					deltas.droppedChunksDelta === null
					? deltas
					: unknown()
			return {
				droppedBytesDelta: held.bytes > 0 ? held.bytes : null,
				droppedChunksDelta: held.chunks > 0 ? held.chunks : null,
			}
		}
		if (!held) return deltas
		return {
			droppedBytesDelta: Math.max(held.bytes, deltas.droppedBytesDelta),
			droppedChunksDelta: Math.max(held.chunks, deltas.droppedChunksDelta),
		}
	}

	// Peeks retain timer-delivery baselines and pending uncertainty.
	const sampleNow = (): EfficiencySample => {
		const result = candidate().sample
		if (delivering) {
			for (const id of result.sources.keys())
				pendingUnknown.set(id, ++generation)
			return {
				...result,
				sources: new Map(
					[...result.sources.keys()].map(id => [
						id,
						withHeldDrops(id, unknown(), new Set<string>()),
					]),
				),
			}
		}
		return result
	}
	return {
		sampleNow,
		start() {
			interval ??= deps.setInterval(() => {
				if (delivering) {
					sampleNow()
					return
				}
				const result = candidate()
				delivering = true
				const before = generation
				try {
					deps.onSample(result.sample)
					result.commit()
				} catch {
					// A failed delivery is an unknown interval even if its counters were clean.
					for (const id of result.sample.sources.keys())
						pendingUnknown.set(id, ++generation)
				}
				if (generation > before) {
					const ids = new Set([
						...knownSources,
						...result.sample.sources.keys(),
						...pendingDrops.keys(),
						...pendingUnknown.keys(),
					])
					const ack = generation
					const followup: EfficiencySample = {
						atMs: result.sample.atMs,
						cpuPercent: null,
						sources: new Map(
							[...ids].map(id => [
								id,
								withHeldDrops(id, unknown(), new Set<string>()),
							]),
						),
					}
					try {
						deps.onSample(followup)
						for (const id of ids) {
							if ((pendingUnknown.get(id) ?? Infinity) <= ack)
								pendingUnknown.delete(id)
							if ((pendingDrops.get(id)?.generation ?? Infinity) <= ack)
								pendingDrops.delete(id)
						}
					} catch {
						// If both deliveries fail, the gate's 6000 ms freshness limit
						// closes admission; no synchronous consumer notification remains.
					}
				}
				delivering = false
			}, EFFICIENCY_SAMPLE_MS)
		},
		stop() {
			interval?.cancel()
			interval = undefined
		},
	}
}
