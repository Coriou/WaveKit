import { EventEmitter } from "node:events"
import { FanoutManager, type FanoutStatus } from "./fanout-manager.js"
import type { SourceManager } from "./source-manager.js"
import { sourceScannerConfig, type SourceConfig } from "../config.js"
import type { Logger } from "../utils/logger.js"

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
		{ changed: boolean; listener: () => void }
	>()
	private primarySourceId: string | undefined
	private readonly connected = (sourceId: string) => {
		this.primarySourceId ??=
			this.firstShared() ??
			(this.dedicated.has(sourceId) ? undefined : sourceId)
		const fanout =
			this.fanouts.get(sourceId) ??
			(sourceId === this.primarySourceId ? this.primary : undefined)
		const stream = this.sources.getStream(sourceId)
		if (fanout && stream) fanout.attachSource(stream)
	}
	private readonly disconnected = (sourceId: string) => {
		this.fanouts.get(sourceId)?.detachSource()
		if (sourceId === this.primarySourceId) this.primary.detachSource()
	}
	private readonly removed = (sourceId: string) => {
		this.disconnected(sourceId)
		this.releaseUnused(sourceId)
	}

	private readonly dedicated: ReadonlySet<string>

	constructor(
		private readonly sources: SourceManager,
		private readonly primary: FanoutManager,
		private readonly logger: Logger,
		primarySourceId?: string,
		opts: { dedicated?: ReadonlySet<string> } = {},
	) {
		super()
		this.dedicated = opts.dedicated ?? new Set()
		this.primarySourceId = primarySourceId ?? this.firstShared()
		this.forwardEvents(primary)
		sources.on("connected", this.connected)
		sources.on("disconnected", this.disconnected)
		sources.on("removed", this.removed)
		for (const status of sources.getAllStatus()) {
			if (status.connected) this.connected(status.id)
		}
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
			if (this.sources.getStatus(sourceId)?.connected) {
				const stream = this.sources.getStream(sourceId)
				if (stream) fanout.attachSource(stream)
			}
		}
		return fanout
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
		fanout.off("branch-removed", state.listener)
		this.topology.delete(fanout)
	}

	private forwardEvents(fanout: FanoutManager): void {
		const state = {
			changed: false,
			listener: () => {
				state.changed = true
			},
		}
		this.topology.set(fanout, state)
		fanout.on("branch-added", state.listener)
		fanout.on("branch-removed", state.listener)
		fanout.on("backpressure", this.backpressure)
		fanout.on("drain", this.drain)
	}

	destroy(): void {
		this.sources.off("connected", this.connected)
		this.sources.off("disconnected", this.disconnected)
		this.sources.off("removed", this.removed)
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
