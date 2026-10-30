import type { Readable } from "node:stream"
import { EventEmitter } from "node:events"
import { FanoutManager, type FanoutStatus } from "./fanout-manager.js"
import type { SourceManager } from "./source-manager.js"
import { sourceScannerConfig, type SourceConfig } from "../config.js"
import type { Logger } from "../utils/logger.js"

import { isLoopbackHost } from "./link-advisory.js"
import { hasOverflowGates } from "./link-burst/absorber.js"
import {
	ABSORBER_COUNTER_PREFIX,
	frameBytesFor,
	resolveAbsorberSeconds,
	type LinkBurstFactories,
	type LinkBurstHandles,
} from "./link-burst/contract.js"

/**
 * Reads of `branchDropCounters` that still report a removed branch's absorber
 * gate total. The efficiency monitor reads once per EFFICIENCY_SAMPLE_MS
 * (2000 ms): the first read after the removal sees the total grow and charges
 * the overflow to that branch; the second covers a read whose sample was
 * discarded (no clock). 2 reads ≈ 4000 ms, then the total is dropped.
 */
export const RETIRED_GATE_READS = 2

/**
 * Removed holders kept per absorber at once; the oldest goes first. Only a
 * branch that held the absorber while it overflowed has a total to keep, a
 * handful of live-audio listeners between two samples, so 64 bounds UUID
 * branch churn without dropping real ones; a total dropped past it leaves
 * its overflow on the source, as before it was kept.
 */
export const RETIRED_GATES_MAX = 64

/** Telemetry shared by a single fanout and the collection of source fanouts. */
export type FanoutTelemetryProvider = Pick<
	FanoutManager,
	"getTelemetrySnapshot" | "getBranchTelemetry"
> &
	Pick<EventEmitter, "on">

/** First source that is not `scanner.role: "dedicated"` (spec § 10.7). */
export function defaultSourceIdFor(
	sources: readonly Pick<SourceConfig, "id" | "scanner">[],
): string | undefined {
	return sources.find(s => sourceScannerConfig(s).role !== "dedicated")?.id
}

/** Keeps each source's bytes in its own fanout while preserving the primary consumers. */
export class SourceFanoutRouter extends EventEmitter {
	private readonly fanouts = new Map<string, FanoutManager>()
	private readonly topology = new Map<
		FanoutManager,
		{
			changed: boolean
			generation: number
			removals: number
			/** Per-id instance number: a re-added id is a different branch. */
			instances: Map<string, number>
			listener: (id: string) => void
			removed: (id: string) => void
		}
	>()
	private readonly bursts = new Map<
		string,
		{
			handles: LinkBurstHandles
			frame: number
			rate: number
			instance: number
			/**
			 * Gate totals of removed branches, keyed `<branch id>#<instance>`,
			 * reported for RETIRED_GATE_READS reads (at most RETIRED_GATES_MAX).
			 */
			retired: Map<string, { total: number; reads: number }>
			stream: Readable | null
			listener: (chunk: Buffer) => void
		}
	>()
	private readonly factories: LinkBurstFactories | undefined
	private branchInstance = 0
	private topologyGeneration = 0
	private primarySourceId: string | undefined
	private readonly connected = (sourceId: string) => {
		if (this.bursts.get(sourceId)?.stream) this.unwire(sourceId, "disconnect")
		this.primarySourceId ??=
			this.firstShared() ??
			(this.dedicated.has(sourceId) ? undefined : sourceId)
		const fanout =
			this.fanouts.get(sourceId) ??
			(sourceId === this.primarySourceId ? this.primary : undefined)
		if (fanout) this.syncByteRate(sourceId, fanout)
		const stream = this.sources.getStream(sourceId)
		if (fanout && stream) this.wire(sourceId, fanout, stream)
	}
	private readonly disconnected = (sourceId: string) => {
		this.unwire(sourceId, "disconnect")
		this.fanouts.get(sourceId)?.detachSource()
		if (sourceId === this.primarySourceId) this.primary.detachSource()
	}
	private readonly removed = (sourceId: string) => {
		this.unwire(sourceId, "removed")
		this.fanouts.get(sourceId)?.detachSource()
		if (sourceId === this.primarySourceId) this.primary.detachSource()
		this.disposeBurst(sourceId)
		this.releaseUnused(sourceId)
	}

	private readonly dedicated: ReadonlySet<string>

	constructor(
		private readonly sources: SourceManager,
		private readonly primary: FanoutManager,
		private readonly logger: Logger,
		primarySourceId?: string,
		opts: {
			dedicated?: ReadonlySet<string>
			linkBurst?: LinkBurstFactories
		} = {},
	) {
		super()
		this.factories = opts.linkBurst
		this.dedicated = opts.dedicated ?? new Set()
		this.primarySourceId = primarySourceId ?? this.firstShared()
		this.forwardEvents(primary)
		sources.on("connected", this.connected)
		sources.on("disconnected", this.disconnected)
		sources.on("removed", this.removed)
		sources.on("caps-changed", this.rateChanged)
		if (this.factories) sources.on("caps-changed", this.capsChanged)
		if (this.primarySourceId !== undefined)
			this.syncByteRate(this.primarySourceId, primary)
		for (const status of sources.getAllStatus()) {
			if (status.connected) this.connected(status.id)
		}
	}

	/**
	 * Sizes the fanout's derived branch marks in signal time: its byte rate is
	 * the source's sample rate × IQ frame bytes (2 400 000 × 2 = 4.8 MB/s for
	 * 2.4 Msps CU8, a 1 200 000-byte 250 ms mark). Unknown caps keep the last
	 * rate; known caps without an IQ frame (audio) fall back to the floor.
	 */
	private syncByteRate(sourceId: string, fanout: FanoutManager): void {
		const caps = this.sources.getCaps(sourceId)
		if (!caps) return
		const frame = frameBytesFor(caps.format)
		fanout.setByteRate(frame === null ? null : caps.sampleRate * frame)
	}

	private readonly rateChanged = (sourceId: string) => {
		const fanout =
			sourceId === this.primarySourceId
				? this.primary
				: this.fanouts.get(sourceId)
		if (fanout) this.syncByteRate(sourceId, fanout)
	}

	linkBurst(sourceId: string): LinkBurstHandles | null {
		return this.bursts.get(sourceId)?.handles ?? null
	}

	private unwire(sourceId: string, reason: "disconnect" | "removed"): void {
		const state = this.bursts.get(sourceId)
		if (!state) return
		state.handles.absorber?.flush(reason)
		state.handles.recorder?.resetArrival()
		if (state.stream) state.stream.off("data", state.listener)
		state.stream = null
	}

	private disposeBurst(sourceId: string): void {
		const state = this.bursts.get(sourceId)
		if (!state) return
		if (state.stream) state.stream.off("data", state.listener)
		state.handles.absorber?.dispose()
		this.bursts.delete(sourceId)
	}

	private readonly capsChanged = (sourceId: string) => {
		const state = this.bursts.get(sourceId)
		const caps = this.sources.getCaps(sourceId)
		if (
			!caps ||
			(state &&
				state.rate === caps.sampleRate &&
				state.frame === frameBytesFor(caps.format))
		)
			return
		state?.handles.absorber?.flush("rate")
		const stream = state
			? state.stream
			: this.sources.getStatus(sourceId)?.connected
				? this.sources.getStream(sourceId)
				: null
		const fanout =
			sourceId === this.primarySourceId
				? this.primary
				: this.fanouts.get(sourceId)
		if (stream && fanout) this.wire(sourceId, fanout, stream, true)
	}

	private wire(
		sourceId: string,
		fanout: FanoutManager,
		stream: Readable,
		preserveTransport = false,
	): void {
		const factories = this.factories
		if (!factories) {
			fanout.attachSource(stream)
			return
		}
		const caps = this.sources.getCaps(sourceId)
		const config = this.sources.getConfig(sourceId)
		const frame = caps ? frameBytesFor(caps.format) : null
		let state = this.bursts.get(sourceId)
		if (state?.stream) {
			state.stream.off("data", state.listener)
			fanout.detachSource()
		}
		if (!caps || frame === null || !config) {
			this.disposeBurst(sourceId)
			fanout.attachSource(stream)
			return
		}
		const configuredTransport =
			config.type !== "recording" &&
			config.host !== undefined &&
			!isLoopbackHost(config.host)
				? "network"
				: "loopback"
		const transport =
			preserveTransport && state ? state.handles.transport : configuredTransport
		const seconds =
			transport === "network"
				? resolveAbsorberSeconds(config.burstAbsorber?.seconds, transport)
				: 0
		if (!state) {
			const recorder = factories.createRecorder(sourceId)
			state = {
				handles: {
					transport,
					capacitySeconds: seconds,
					recorder,
					absorber: null,
				},
				frame,
				rate: caps.sampleRate,
				instance: 0,
				retired: new Map(),
				stream: null,
				listener: chunk =>
					recorder.observeChunk(chunk.length, factories.monoNow()),
			}
			this.bursts.set(sourceId, state)
		}
		if (state.frame !== frame || seconds === 0) {
			state.handles.absorber?.dispose()
			state.handles.absorber = null
			state.retired.clear()
		}
		state.frame = frame
		state.rate = caps.sampleRate
		state.handles.transport = transport
		state.handles.capacitySeconds = seconds
		state.handles.recorder?.configure(caps.sampleRate, frame)
		state.stream = stream
		stream.on("data", state.listener)
		if (seconds > 0) {
			if (!state.handles.absorber) {
				state.handles.absorber = factories.createAbsorber(sourceId, {
					fanout,
					recorder: state.handles.recorder,
					monoNow: factories.monoNow,
					frameBytes: frame,
					log: this.logger,
				})
				state.instance = ++this.branchInstance
				state.retired.clear()
			}
			state.handles.absorber.configure(seconds * caps.sampleRate * frame)
			fanout.attachIngest(stream, state.handles.absorber.ingest)
		} else fanout.attachSource(stream)
	}

	/** The default source; never a dedicated scanner source (spec § 10.7). */
	getDefaultSourceId(): string | undefined {
		this.primarySourceId ??= this.firstShared()
		return this.primarySourceId
	}

	private firstShared(): string | undefined {
		return this.sources.getAllStatus().find(s => !this.dedicated.has(s.id))?.id
	}

	getFanout(sourceId?: string): FanoutManager {
		// Registration precedes connection. Select the default before creating a
		// secondary fanout so its identity cannot change when that source connects.
		this.primarySourceId =
			this.getDefaultSourceId() ??
			(sourceId !== undefined && !this.dedicated.has(sourceId)
				? sourceId
				: undefined)
		if (!sourceId || sourceId === this.primarySourceId) return this.primary
		let fanout = this.fanouts.get(sourceId)
		if (!fanout) {
			fanout = new FanoutManager(this.logger)
			this.fanouts.set(sourceId, fanout)
			this.forwardEvents(fanout)
			this.syncByteRate(sourceId, fanout)
			if (this.sources.getStatus(sourceId)?.connected) {
				const stream = this.sources.getStream(sourceId)
				if (stream) this.wire(sourceId, fanout, stream)
			}
		}
		return fanout
	}

	/**
	 * Removal epoch of the source's fanout: stable across reads and additions;
	 * a branch removal (including same-id replacement) or a recreated fanout
	 * changes it. Added branches are visible in the counters themselves.
	 */
	branchTopology(sourceId: string): string | null {
		const fanout =
			sourceId === this.primarySourceId
				? this.primary
				: this.fanouts.get(sourceId)
		if (!fanout) return null
		return JSON.stringify([this.topology.get(fanout)?.removals])
	}

	/**
	 * Snapshot each branch independently so resets cannot cancel other drops.
	 * Keys are `<branch id>#<instance>`: a removed and re-added id is a new
	 * branch whose counters started at zero.
	 */
	branchDropCounters(sourceId: string): ReadonlyMap<
		string,
		{
			droppedBytesTotal: number
			droppedChunksTotal: number
			active: boolean
			/**
			 * The absorber's: overflow lost while each branch held it, keyed
			 * `<branch id>#<instance>` like the branch counters.
			 */
			overflowGatedBy?: Readonly<Record<string, number>>
		}
	> | null {
		const fanout =
			sourceId === this.primarySourceId
				? this.primary
				: this.fanouts.get(sourceId)
		if (!fanout) return null
		const counters = new Map<
			string,
			{
				droppedBytesTotal: number
				droppedChunksTotal: number
				active: boolean
				overflowGatedBy?: Readonly<Record<string, number>>
			}
		>()
		const instances = this.topology.get(fanout)?.instances
		for (const id of fanout.getBranchIds()) {
			const branch = fanout.getBranchTelemetry(id)
			counters.set(`${id}#${instances?.get(id) ?? 0}`, {
				droppedBytesTotal: branch?.droppedBytesTotal ?? NaN,
				droppedChunksTotal: branch?.droppedChunksTotal ?? NaN,
				active: fanout.isBranchActive(id),
			})
		}
		const burst = this.bursts.get(sourceId)
		if (burst?.handles.absorber) {
			const absorber = burst.handles.absorber
			const overflow = absorber.counters()
			const retired: [string, number][] = []
			for (const [key, gate] of burst.retired) {
				retired.push([key, gate.total])
				if (++gate.reads >= RETIRED_GATE_READS) burst.retired.delete(key)
			}
			counters.set(`${ABSORBER_COUNTER_PREFIX}#${burst.instance}`, {
				droppedBytesTotal: overflow.overflowBytesTotal,
				droppedChunksTotal: overflow.overflowChunksTotal,
				active: true,
				...(hasOverflowGates(absorber)
					? {
							// Keyed like the branch counters: a removed and re-added
							// id is a new branch, its gate total a new key from zero.
							// A branch removed since keeps its last total under its old
							// key, so overflow it held is still charged to it.
							overflowGatedBy: Object.fromEntries([
								...retired,
								...Object.entries(absorber.overflowGatedBy()).map(
									([id, total]) => [`${id}#${instances?.get(id) ?? 0}`, total],
								),
							]),
						}
					: {}),
			})
		}
		return counters
	}

	/** Read existing counters only; never creates a fanout or touches the IQ path. */
	branchDropTotals(sourceId: string): {
		droppedBytesTotal: number
		droppedChunksTotal: number
	} | null {
		const fanout =
			sourceId === this.primarySourceId
				? this.primary
				: this.fanouts.get(sourceId)
		if (!fanout) return null
		const topology = this.topology.get(fanout)
		if (topology?.changed) {
			// Drops a removed branch suffered after the last read are not observable;
			// report the tick unknown instead.
			topology.changed = false
			return null
		}
		let droppedBytesTotal = 0
		let droppedChunksTotal = 0
		for (const id of fanout.getBranchIds()) {
			const branch = fanout.getBranchTelemetry(id)
			if (
				!branch ||
				!Number.isSafeInteger(branch.droppedBytesTotal) ||
				branch.droppedBytesTotal < 0 ||
				!Number.isSafeInteger(branch.droppedChunksTotal) ||
				branch.droppedChunksTotal < 0
			)
				return null
			droppedBytesTotal += branch.droppedBytesTotal
			droppedChunksTotal += branch.droppedChunksTotal
			if (
				!Number.isSafeInteger(droppedBytesTotal) ||
				!Number.isSafeInteger(droppedChunksTotal)
			)
				return null
		}
		return { droppedBytesTotal, droppedChunksTotal }
	}

	releaseUnused(sourceId: string): void {
		const fanout = this.fanouts.get(sourceId)
		if (fanout && fanout.getBranchIds().length === 0) {
			this.disposeBurst(sourceId)
			this.forgetTopology(fanout)
			fanout.destroy()
			fanout.removeAllListeners()
			this.fanouts.delete(sourceId)
		}
	}

	getTelemetrySnapshot(): FanoutStatus {
		const snapshots = [this.primary, ...this.fanouts.values()].map(fanout =>
			fanout.getTelemetrySnapshot(),
		)
		return {
			timestamp: new Date().toISOString(),
			branches: snapshots.flatMap((snapshot, index) =>
				snapshot.branches.map(branch =>
					index === 0 && this.primarySourceId && !branch.sourceId
						? { ...branch, sourceId: this.primarySourceId }
						: branch,
				),
			),
			backpressureActiveCount: snapshots.reduce(
				(sum, s) => sum + s.backpressureActiveCount,
				0,
			),
			droppedBytesTotal: snapshots.reduce(
				(sum, s) => sum + s.droppedBytesTotal,
				0,
			),
			droppedChunksTotal: snapshots.reduce(
				(sum, s) => sum + s.droppedChunksTotal,
				0,
			),
			totalBytesWritten: snapshots.reduce(
				(sum, s) => sum + s.totalBytesWritten,
				0,
			),
		}
	}

	getBranchTelemetry(branchId: string) {
		const primaryBranch = this.primary.getBranchTelemetry(branchId)
		if (primaryBranch) {
			return this.primarySourceId && !primaryBranch.sourceId
				? { ...primaryBranch, sourceId: this.primarySourceId }
				: primaryBranch
		}
		for (const fanout of this.fanouts.values()) {
			const branch = fanout.getBranchTelemetry(branchId)
			if (branch) return branch
		}
		return undefined
	}

	private readonly backpressure = (id: string, bytes: number) =>
		this.emit("backpressure", id, bytes)
	private readonly drain = (id: string, duration: number) =>
		this.emit("drain", id, duration)
	private forgetTopology(fanout: FanoutManager): void {
		const state = this.topology.get(fanout)
		if (!state) return
		fanout.off("branch-added", state.listener)
		fanout.off("branch-removed", state.removed)
		this.topology.delete(fanout)
	}

	/**
	 * Keeps a removed branch's absorber gate total until the monitor read it.
	 * This listener was added when the fanout was created, before any absorber
	 * on it, so it runs before the absorber forgets the branch's total.
	 */
	private retireGate(
		fanout: FanoutManager,
		id: string,
		instance: number,
	): void {
		for (const [sourceId, burst] of this.bursts) {
			const absorber = burst.handles.absorber
			if (
				!absorber ||
				!hasOverflowGates(absorber) ||
				(sourceId === this.primarySourceId
					? this.primary
					: this.fanouts.get(sourceId)) !== fanout
			)
				continue
			const total = absorber.overflowGatedBy()[id]
			if (!total) return
			burst.retired.set(`${id}#${instance}`, { total, reads: 0 })
			for (const key of burst.retired.keys()) {
				if (burst.retired.size <= RETIRED_GATES_MAX) break
				burst.retired.delete(key)
			}
			return
		}
	}

	private forwardEvents(fanout: FanoutManager): void {
		const generation = ++this.topologyGeneration
		const state = {
			changed: false,
			generation,
			removals: generation,
			instances: new Map<string, number>(),
			listener: (id: string) => {
				if (id.startsWith("@")) {
					this.logger.warn("Reserved fanout branch prefix")
					fanout.removeBranch(id)
					return
				}
				state.changed = true
				state.generation = ++this.topologyGeneration
				state.instances.set(id, ++this.branchInstance)
			},
			removed: (id: string) => {
				state.changed = true
				state.generation = ++this.topologyGeneration
				state.removals = state.generation
				this.retireGate(fanout, id, state.instances.get(id) ?? 0)
				state.instances.delete(id)
			},
		}
		this.topology.set(fanout, state)
		for (const id of fanout.getBranchIds()) {
			if (id.startsWith("@")) state.listener(id)
		}
		fanout.on("branch-added", state.listener)
		fanout.on("branch-removed", state.removed)
		fanout.on("backpressure", this.backpressure)
		fanout.on("drain", this.drain)
	}

	destroy(): void {
		this.sources.off("connected", this.connected)
		this.sources.off("disconnected", this.disconnected)
		this.sources.off("removed", this.removed)
		this.sources.off("caps-changed", this.rateChanged)
		this.sources.off("caps-changed", this.capsChanged)
		for (const id of this.bursts.keys()) this.disposeBurst(id)
		this.primary.off("backpressure", this.backpressure)
		this.primary.off("drain", this.drain)
		this.forgetTopology(this.primary)
		this.primary.detachSource()
		for (const fanout of this.fanouts.values()) {
			this.forgetTopology(fanout)
			fanout.destroy()
			fanout.removeAllListeners()
		}
		this.fanouts.clear()
		this.removeAllListeners()
	}
}
