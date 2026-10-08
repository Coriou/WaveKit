import { EventEmitter } from "node:events"
import { FanoutManager, type FanoutStatus } from "./fanout-manager.js"
import type { SourceManager } from "./source-manager.js"
import type { Logger } from "../utils/logger.js"

/** Telemetry shared by a single fanout and the collection of source fanouts. */
export type FanoutTelemetryProvider = Pick<
	FanoutManager,
	"getTelemetrySnapshot" | "getBranchTelemetry"
> &
	Pick<EventEmitter, "on">

/** Keeps each source's bytes in its own fanout while preserving the primary consumers. */
export class SourceFanoutRouter extends EventEmitter {
	private readonly fanouts = new Map<string, FanoutManager>()
	private primarySourceId: string | undefined
	private readonly connected = (sourceId: string) => {
		this.primarySourceId ??= this.sources.getAllStatus()[0]?.id ?? sourceId
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

	constructor(
		private readonly sources: SourceManager,
		private readonly primary: FanoutManager,
		private readonly logger: Logger,
		primarySourceId?: string,
	) {
		super()
		this.primarySourceId = primarySourceId ?? sources.getAllStatus()[0]?.id
		this.forwardEvents(primary)
		sources.on("connected", this.connected)
		sources.on("disconnected", this.disconnected)
		sources.on("removed", this.removed)
		for (const status of sources.getAllStatus()) {
			if (status.connected) this.connected(status.id)
		}
	}

	getDefaultSourceId(): string | undefined {
		this.primarySourceId ??= this.sources.getAllStatus()[0]?.id
		return this.primarySourceId
	}

	getFanout(sourceId?: string): FanoutManager {
		// Registration precedes connection. Select the default before creating a
		// secondary fanout so its identity cannot change when that source connects.
		this.primarySourceId = this.getDefaultSourceId() ?? sourceId
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

	releaseUnused(sourceId: string): void {
		const fanout = this.fanouts.get(sourceId)
		if (fanout && fanout.getBranchIds().length === 0) {
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
	private forwardEvents(fanout: FanoutManager): void {
		fanout.on("backpressure", this.backpressure)
		fanout.on("drain", this.drain)
	}

	destroy(): void {
		this.sources.off("connected", this.connected)
		this.sources.off("disconnected", this.disconnected)
		this.sources.off("removed", this.removed)
		this.primary.off("backpressure", this.backpressure)
		this.primary.off("drain", this.drain)
		this.primary.detachSource()
		for (const fanout of this.fanouts.values()) {
			fanout.destroy()
			fanout.removeAllListeners()
		}
		this.fanouts.clear()
		this.removeAllListeners()
	}
}
