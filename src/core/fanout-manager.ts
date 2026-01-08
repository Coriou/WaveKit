/**
 * Fanout Manager - Multiplexes audio streams to multiple consumers
 *
 * Requirements:
 * - 2.1: Accept source stream as input
 * - 2.2: Create independent buffered streams for each branch
 * - 2.3: Copy data to all active branches
 * - 2.4: Emit backpressure event without blocking source when buffer fills
 * - 2.5: Clean up resources when branch is removed
 * - 2.6: Prioritize real-time audio flow over buffering
 * - Telemetry: Expose drop counters and backpressure state for monitoring
 */

import { EventEmitter } from "node:events"
import { PassThrough, type Readable } from "node:stream"
import { createComponentLogger, type Logger } from "../utils/logger.js"

export interface BranchConfig {
	id: string
	highWaterMark?: number // Default: 256KB (262144 bytes)
	decoderId?: string // Optional decoder ID for telemetry context
	sourceId?: string // Optional source ID for telemetry context
}

/**
 * Basic branch status (legacy interface maintained for compatibility)
 */
export interface BranchStatus {
	id: string
	bufferedBytes: number
	backpressure: boolean
}

/**
 * Extended branch telemetry for monitoring dashboard
 */
export interface BranchTelemetry {
	id: string
	decoderId?: string
	sourceId?: string
	// Congestion state
	backpressureActive: boolean
	backpressureSince?: string // ISO timestamp (if active)
	backpressureEnterCount: number
	lastBackpressureAt?: string // ISO timestamp
	lastDrainAt?: string // ISO timestamp
	// Counters
	droppedBytesTotal: number
	droppedChunksTotal: number
	// Buffer
	bufferBytes: number
	highWaterMark: number
	// Throughput
	totalBytesWritten: number
}

/**
 * Global fanout telemetry snapshot
 */
export interface FanoutStatus {
	timestamp: string
	branches: BranchTelemetry[]
	backpressureActiveCount: number
	droppedBytesTotal: number
	droppedChunksTotal: number
	totalBytesWritten: number
}

export interface FanoutManagerEvents {
	backpressure: (branchId: string, bufferedBytes: number) => void
	drain: (branchId: string, durationMs: number) => void
	"branch-added": (branchId: string) => void
	"branch-removed": (branchId: string) => void
}

interface BranchState {
	stream: PassThrough
	highWaterMark: number
	backpressure: boolean
	bufferedBytes: number
	// Extended telemetry state
	decoderId?: string | undefined
	sourceId?: string | undefined
	droppedBytesTotal: number
	droppedChunksTotal: number
	totalBytesWritten: number
	backpressureEnterCount: number
	backpressureSince?: number | undefined // hrtime in ms for precise duration
	lastBackpressureAt?: string | undefined // ISO timestamp for display
	lastDrainAt?: string | undefined // ISO timestamp for display
}

const DEFAULT_HIGH_WATER_MARK = 256 * 1024 // 256KB (Increased to prevent congestion)

export class FanoutManager extends EventEmitter {
	private readonly log: Logger
	private readonly branches: Map<string, BranchState> = new Map()
	private source: Readable | null = null
	private dataHandler: ((chunk: Buffer) => void) | null = null

	constructor(logger: Logger) {
		super()
		this.log = createComponentLogger(logger, "FanoutManager")
	}

	/**
	 * Attach a source stream to distribute data from.
	 * Requirement 2.1: Accept source stream as input
	 */
	attachSource(source: Readable): void {
		if (this.source) {
			this.detachSource()
		}

		this.source = source
		this.dataHandler = (chunk: Buffer) => this.distributeData(chunk)

		source.on("data", this.dataHandler)
		source.on("error", err => {
			this.log.error({ err }, "Source stream error")
		})
		source.on("end", () => {
			this.log.info("Source stream ended")
		})

		this.log.info("Source attached")
	}

	/**
	 * Detach the current source stream.
	 */
	detachSource(): void {
		if (this.source && this.dataHandler) {
			this.source.removeListener("data", this.dataHandler)
			this.dataHandler = null
			this.source = null
			this.log.info("Source detached")
		}
	}

	/**
	 * Add a new branch for a consumer.
	 * Requirement 2.2: Create independent buffered stream for consumer
	 */
	addBranch(config: BranchConfig): PassThrough {
		if (this.branches.has(config.id)) {
			this.log.warn(
				{ branchId: config.id },
				"Branch already exists, returning existing stream",
			)
			return this.branches.get(config.id)!.stream
		}

		const highWaterMark = config.highWaterMark ?? DEFAULT_HIGH_WATER_MARK

		const stream = new PassThrough({
			highWaterMark,
		})

		// Handle stream errors gracefully
		stream.on("error", err => {
			this.log.error({ err, branchId: config.id }, "Branch stream error")
		})

		const branchState: BranchState = {
			stream,
			highWaterMark,
			backpressure: false,
			bufferedBytes: 0,
			// Extended telemetry state
			decoderId: config.decoderId,
			sourceId: config.sourceId,
			droppedBytesTotal: 0,
			droppedChunksTotal: 0,
			totalBytesWritten: 0,
			backpressureEnterCount: 0,
			backpressureSince: undefined,
			lastBackpressureAt: undefined,
			lastDrainAt: undefined,
		} as BranchState

		this.branches.set(config.id, branchState)
		this.emit("branch-added", config.id)
		this.log.info({ branchId: config.id, highWaterMark }, "Branch added")

		return stream
	}

	/**
	 * Remove a branch and clean up its resources.
	 * Requirement 2.5: Clean up resources when branch is removed
	 */
	removeBranch(id: string): void {
		const branch = this.branches.get(id)
		if (!branch) {
			this.log.warn({ branchId: id }, "Attempted to remove non-existent branch")
			return
		}

		// End the stream gracefully
		branch.stream.end()
		// Destroy to release resources
		branch.stream.destroy()

		this.branches.delete(id)
		this.emit("branch-removed", id)
		this.log.info({ branchId: id }, "Branch removed")
	}

	/**
	 * Get all branch IDs.
	 */
	getBranchIds(): string[] {
		return Array.from(this.branches.keys())
	}

	/**
	 * Get status for a specific branch.
	 */
	getBranchStatus(id: string): BranchStatus | undefined {
		const branch = this.branches.get(id)
		if (!branch) {
			return undefined
		}

		return {
			id,
			bufferedBytes: branch.bufferedBytes,
			backpressure: branch.backpressure,
		}
	}

	/**
	 * Distribute data to all active branches.
	 * Requirement 2.3: Copy data to all active branches
	 * Requirement 2.4: Emit backpressure without blocking source
	 * Requirement 2.6: Prioritize real-time flow over buffering
	 */
	private distributeData(chunk: Buffer): void {
		const chunkLength = chunk.length

		for (const [branchId, branch] of this.branches) {
			// ZERO-COPY OPTIMIZATION:
			// Do NOT use Buffer.from(chunk) which runs a copy.
			// Node.js buffers are references. PassThrough.write will effectively
			// copy it into its internal buffer if needed, but we avoid the
			// explicit pre-copy.
			//
			// DROP-ON-CONGESTION:
			// If a branch is experiencing backpressure, we DROP new data
			// for that branch until it drains. This prevents one slow consumer
			// from blocking the entire pipeline or consuming excessive memory.

			// Track total bytes attempted to be written (before dropping)
			branch.totalBytesWritten += chunkLength

			if (branch.backpressure) {
				// Already in backpressure state, drop packet and track metrics
				branch.droppedBytesTotal += chunkLength
				branch.droppedChunksTotal++
				continue
			}

			let canWrite = false
			try {
				if (!branch.stream.destroyed) {
					canWrite = branch.stream.write(chunk)
					branch.bufferedBytes += chunkLength
				}
			} catch (err) {
				this.log.error(
					{ err, branchId },
					"Error writing to branch stream (likely closed)",
				)
				continue
			}

			if (!canWrite) {
				// Stream buffer is full. Enter backpressure mode.
				const now = Date.now()
				branch.backpressure = true
				branch.backpressureEnterCount++
				branch.backpressureSince = now
				branch.lastBackpressureAt = new Date(now).toISOString()

				this.emit("backpressure", branchId, branch.bufferedBytes)
				this.log.warn(
					{ branchId, bufferedBytes: branch.bufferedBytes },
					"Branch congested, entering drop-mode",
				)

				// Wait for drain before accepting new data for this branch
				branch.stream.once("drain", () => {
					const drainTime = Date.now()
					const durationMs = branch.backpressureSince
						? drainTime - branch.backpressureSince
						: 0

					branch.backpressure = false
					branch.bufferedBytes = 0
					branch.backpressureSince = undefined
					branch.lastDrainAt = new Date(drainTime).toISOString()

					// Emit drain event with duration for telemetry
					this.emit("drain", branchId, durationMs)
					this.log.debug(
						{ branchId, durationMs },
						"Branch drained, resuming flow",
					)
				})
			}
		}
	}

	/**
	 * Get extended telemetry for a specific branch.
	 * Used for real-time monitoring dashboards.
	 */
	getBranchTelemetry(id: string): BranchTelemetry | undefined {
		const branch = this.branches.get(id)
		if (!branch) {
			return undefined
		}

		const telemetry: BranchTelemetry = {
			id,
			backpressureActive: branch.backpressure,
			backpressureEnterCount: branch.backpressureEnterCount,
			droppedBytesTotal: branch.droppedBytesTotal,
			droppedChunksTotal: branch.droppedChunksTotal,
			bufferBytes: branch.bufferedBytes,
			highWaterMark: branch.highWaterMark,
			totalBytesWritten: branch.totalBytesWritten,
		}

		// Only set optional properties if they exist (exactOptionalPropertyTypes)
		if (branch.decoderId) telemetry.decoderId = branch.decoderId
		if (branch.sourceId) telemetry.sourceId = branch.sourceId
		if (branch.backpressureSince)
			telemetry.backpressureSince = new Date(
				branch.backpressureSince,
			).toISOString()
		if (branch.lastBackpressureAt)
			telemetry.lastBackpressureAt = branch.lastBackpressureAt
		if (branch.lastDrainAt) telemetry.lastDrainAt = branch.lastDrainAt

		return telemetry
	}

	/**
	 * Get complete telemetry snapshot for all branches.
	 * Provides global view of fanout system health for dashboards and APIs.
	 */
	getTelemetrySnapshot(): FanoutStatus {
		const branches: BranchTelemetry[] = []
		let backpressureActiveCount = 0
		let droppedBytesTotal = 0
		let droppedChunksTotal = 0
		let totalBytesWritten = 0

		for (const [id, branch] of this.branches) {
			if (branch.backpressure) {
				backpressureActiveCount++
			}
			droppedBytesTotal += branch.droppedBytesTotal
			droppedChunksTotal += branch.droppedChunksTotal
			totalBytesWritten += branch.totalBytesWritten

			const branchTelemetry: BranchTelemetry = {
				id,
				backpressureActive: branch.backpressure,
				backpressureEnterCount: branch.backpressureEnterCount,
				droppedBytesTotal: branch.droppedBytesTotal,
				droppedChunksTotal: branch.droppedChunksTotal,
				bufferBytes: branch.bufferedBytes,
				highWaterMark: branch.highWaterMark,
				totalBytesWritten: branch.totalBytesWritten,
			}

			if (branch.decoderId) branchTelemetry.decoderId = branch.decoderId
			if (branch.sourceId) branchTelemetry.sourceId = branch.sourceId
			if (branch.backpressureSince)
				branchTelemetry.backpressureSince = new Date(
					branch.backpressureSince,
				).toISOString()
			if (branch.lastBackpressureAt)
				branchTelemetry.lastBackpressureAt = branch.lastBackpressureAt
			if (branch.lastDrainAt) branchTelemetry.lastDrainAt = branch.lastDrainAt

			branches.push(branchTelemetry)
		}

		return {
			timestamp: new Date().toISOString(),
			branches,
			backpressureActiveCount,
			droppedBytesTotal,
			droppedChunksTotal,
			totalBytesWritten,
		}
	}

	/**
	 * Clean up all branches and detach source.
	 */
	destroy(): void {
		this.detachSource()

		for (const branchId of this.branches.keys()) {
			this.removeBranch(branchId)
		}

		this.log.info("FanoutManager destroyed")
	}
}
