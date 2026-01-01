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
 */

import { EventEmitter } from "node:events"
import { PassThrough, type Readable } from "node:stream"
import { createComponentLogger, type Logger } from "../utils/logger.js"

export interface BranchConfig {
	id: string
	highWaterMark?: number // Default: 256KB (262144 bytes)
}

export interface BranchStatus {
	id: string
	bufferedBytes: number
	backpressure: boolean
}

export interface FanoutManagerEvents {
	backpressure: (branchId: string, bufferedBytes: number) => void
	"branch-added": (branchId: string) => void
	"branch-removed": (branchId: string) => void
}

interface BranchState {
	stream: PassThrough
	highWaterMark: number
	backpressure: boolean
	bufferedBytes: number
}

const DEFAULT_HIGH_WATER_MARK = 262144 // 256KB

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
		}

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
		for (const [branchId, branch] of this.branches) {
			// Create a copy of the chunk for each branch (no shared buffers)
			const chunkCopy = Buffer.from(chunk)

			// Track buffered bytes
			branch.bufferedBytes += chunkCopy.length

			// Write returns false when buffer is full (backpressure)
			const canWrite = branch.stream.write(chunkCopy)

			if (!canWrite) {
				// Requirement 2.4: Emit backpressure event without blocking
				if (!branch.backpressure) {
					branch.backpressure = true
					this.emit("backpressure", branchId, branch.bufferedBytes)
					this.log.warn(
						{ branchId, bufferedBytes: branch.bufferedBytes },
						"Branch backpressure detected",
					)
				}

				// Requirement 2.6: Continue anyway - real-time priority
				// We don't wait for drain, we continue distributing
				// Set up drain handler to clear backpressure flag
				branch.stream.once("drain", () => {
					branch.backpressure = false
					branch.bufferedBytes = 0
					this.log.debug({ branchId }, "Branch backpressure cleared")
				})
			} else {
				// Reset backpressure state if write succeeded
				if (branch.backpressure) {
					branch.backpressure = false
					branch.bufferedBytes = 0
				}
			}
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
