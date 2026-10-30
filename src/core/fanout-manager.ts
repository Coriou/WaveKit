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
	/** Bytes. Wins over highWaterMarkMs. Default: see branchHighWaterMark. */
	highWaterMark?: number
	/**
	 * Milliseconds of signal at the fanout's byte rate (setByteRate), never
	 * below DEFAULT_HIGH_WATER_MARK. Ignored while the byte rate is unknown.
	 */
	highWaterMarkMs?: number
	decoderId?: string // Optional decoder ID for telemetry context
	sourceId?: string // Optional source ID for telemetry context
	// Created inactive: it receives no data (and counts no drops) until
	// activateBranch(), so a consumer that is still starting cannot fill it.
	deferred?: boolean
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
	"writable-drain": (branchId: string) => void
	"branch-added": (branchId: string) => void
	"branch-removed": (branchId: string) => void
}

interface BranchState {
	stream: PassThrough
	/** False while a deferred branch waits for its consumer. */
	active: boolean
	/** Larger congestion mark while a just-started consumer gets going. */
	startupHighWaterMark?: number | undefined
	/** Ends the startup period; unref'd, cleared on removal. */
	startupTimer?: ReturnType<typeof setTimeout> | undefined
	/** The startup mark ended with a backlog that must drain first. */
	startupDraining?: boolean | undefined
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
	/** This congestion episode already logged its first dropped chunk. */
	dropLogged: boolean
	/** Polls the low-water exit while a drop-mode episode lasts. */
	lowWaterTimer?: ReturnType<typeof setInterval> | undefined
	/** The episode's one-shot 'drain' listener, removed when the poll ends it. */
	episodeDrain?: (() => void) | undefined
}

/**
 * Floor of every derived mark: 256 KiB, the historic fixed default (128 ms of
 * CU8 at 1.024 Msps, but only 54.6 ms at 2.4 Msps).
 */
export const DEFAULT_HIGH_WATER_MARK = 256 * 1024
/**
 * Default branch buffer in signal time once the byte rate is known. A mark
 * bounds each side of a PassThrough, so a consumer stalls for about twice
 * this before its branch congests: 2 × 250 ms = 500 ms, the absorber's
 * laggard bound (ABSORBER_LAGGARD_MS). At 2.4 Msps CU8 (4.8 MB/s) that is
 * 1 200 000 B per side; at 1.024 Msps (2.048 MB/s) 512 000 B.
 */
export const DEFAULT_BRANCH_BUFFER_MS = 250
/**
 * Ceiling of a derived mark: 16 MiB, the channelizer input limit. 250 ms
 * reaches it only above 33.5 MB/s (8.4 Msps of CS16).
 */
export const MAX_DERIVED_HIGH_WATER_MARK = 16 * 1024 * 1024

/**
 * A drop-mode episode ends once the branch's writable side is back at half its
 * mark, not only at Node's 'drain' (writable side empty). Waiting for empty
 * meant consuming both sides first, about 2 × mark: 2.4 MB, 500 ms of signal
 * at 2.4 Msps with 250 ms marks, as long as the absorber's laggard bound.
 * Half leaves room for 0.5 × 1 200 000 = 600 000 bytes (125 ms) before the
 * branch congests again, so episodes do not chatter.
 */
export const DROP_MODE_LOW_WATER = 0.5
/**
 * Low-water poll while an episode lasts (only then): 10 ms is 48 000 bytes at
 * 4.8 MB/s, 4 % of a 1 200 000-byte mark, and 100 timer callbacks per second
 * per congested branch.
 */
export const DROP_MODE_POLL_MS = 10

/**
 * Bytes holding `ms` of signal at `bytesPerSecond`, clamped to
 * [DEFAULT_HIGH_WATER_MARK, MAX_DERIVED_HIGH_WATER_MARK]. An unknown or
 * invalid rate or duration returns the floor.
 */
export function branchHighWaterMark(
	bytesPerSecond: number | null | undefined,
	ms: number = DEFAULT_BRANCH_BUFFER_MS,
): number {
	if (
		bytesPerSecond === null ||
		bytesPerSecond === undefined ||
		!Number.isFinite(bytesPerSecond) ||
		bytesPerSecond <= 0 ||
		!Number.isFinite(ms) ||
		ms <= 0
	)
		return DEFAULT_HIGH_WATER_MARK
	return Math.min(
		MAX_DERIVED_HIGH_WATER_MARK,
		Math.max(DEFAULT_HIGH_WATER_MARK, Math.ceil((bytesPerSecond * ms) / 1000)),
	)
}

export class FanoutManager extends EventEmitter {
	private readonly log: Logger
	private readonly branches: Map<string, BranchState> = new Map()
	private source: Readable | null = null
	private dataHandler: ((chunk: Buffer) => void) | null = null
	private sourceErrorHandler: ((error: Error) => void) | null = null
	private sourceEndHandler: (() => void) | null = null
	private byteRate: number | null = null

	constructor(logger: Logger) {
		super()
		this.log = createComponentLogger(logger, "FanoutManager")
	}

	// Attach a source stream to distribute data from.
	// Requirement 2.1: Accept source stream as input
	attachSource(source: Readable): void {
		this.attachIngest(source, chunk => this.distributeData(chunk))
	}

	attachIngest(source: Readable, ingest: (chunk: Buffer) => void): void {
		if (this.source) {
			this.detachSource()
		}

		this.source = source
		this.dataHandler = ingest

		source.on("data", this.dataHandler)
		this.sourceErrorHandler = err => {
			this.log.error({ err }, "Source stream error")
		}
		this.sourceEndHandler = () => {
			this.log.info("Source stream ended")
		}
		source.on("error", this.sourceErrorHandler)
		source.on("end", this.sourceEndHandler)

		this.log.info("Source attached")
	}

	/**
	 * Source byte rate (sample rate × frame bytes), or null when unknown. Sizes
	 * the marks of branches added afterwards; existing streams keep theirs.
	 */
	setByteRate(bytesPerSecond: number | null): void {
		this.byteRate =
			bytesPerSecond !== null &&
			Number.isFinite(bytesPerSecond) &&
			bytesPerSecond > 0
				? bytesPerSecond
				: null
	}

	getByteRate(): number | null {
		return this.byteRate
	}

	// Detach the current source stream.
	detachSource(): void {
		if (this.source && this.dataHandler) {
			this.source.removeListener("data", this.dataHandler)
			if (this.sourceErrorHandler)
				this.source.removeListener("error", this.sourceErrorHandler)
			if (this.sourceEndHandler)
				this.source.removeListener("end", this.sourceEndHandler)
			this.sourceErrorHandler = null
			this.sourceEndHandler = null
			this.dataHandler = null
			this.source = null
			this.log.info("Source detached")
		}
	}

	// Add a new branch for a consumer.
	// Requirement 2.2: Create independent buffered stream for consumer
	addBranch(config: BranchConfig): PassThrough {
		if (this.branches.has(config.id)) {
			this.log.warn(
				{ branchId: config.id },
				"Branch already exists, returning existing stream",
			)
			return this.branches.get(config.id)!.stream
		}

		const highWaterMark =
			config.highWaterMark ??
			branchHighWaterMark(this.byteRate, config.highWaterMarkMs)

		const stream = new PassThrough({
			highWaterMark,
		})

		// Handle stream errors gracefully
		stream.on("error", err => {
			this.log.error({ err, branchId: config.id }, "Branch stream error")
		})

		const branchState: BranchState = {
			stream,
			active: config.deferred !== true,
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
			dropLogged: false,
		} as BranchState

		// Startup buffering can suppress drop-mode while writableLength reaches
		// its effective mark. Wake read-only congestion observers on that drain
		// too; ordinary drop-mode already emits through its one-shot listener.
		stream.on("drain", () => {
			if (!branchState.backpressure) this.emit("writable-drain", config.id)
		})
		this.branches.set(config.id, branchState)
		this.emit("branch-added", config.id)
		this.log.info({ branchId: config.id, highWaterMark }, "Branch added")

		return stream
	}

	// Starts delivering data to a deferred branch; every later drop counts.
	// With `startup`, the branch buffers up to `highWaterMark` bytes for
	// `durationMs` (a consumer's first reads after spawn are slow), then returns
	// to its normal mark: a larger backlog is left to drain, and new data is not
	// accepted beyond the normal mark until it has.
	activateBranch(
		id: string,
		startup?: { highWaterMark: number; durationMs: number },
	): void {
		const branch = this.branches.get(id)
		if (!branch || branch.active) return
		branch.active = true
		if (
			startup &&
			Number.isFinite(startup.highWaterMark) &&
			startup.highWaterMark > branch.highWaterMark &&
			Number.isFinite(startup.durationMs) &&
			startup.durationMs > 0
		) {
			branch.startupHighWaterMark = startup.highWaterMark
			// One timer per activation ends the period: no clock read per chunk.
			branch.startupTimer = setTimeout(() => {
				branch.startupTimer = undefined
				branch.startupHighWaterMark = undefined
				// A backlog at or above the normal mark drains before new data.
				branch.startupDraining =
					branch.stream.writableLength >= branch.highWaterMark
			}, startup.durationMs)
			branch.startupTimer.unref?.()
		}
		this.log.debug({ branchId: id }, "Branch activated")
	}

	// Remove a branch and clean up its resources.
	// Requirement 2.5: Clean up resources when branch is removed
	removeBranch(id: string): void {
		const branch = this.branches.get(id)
		if (!branch) {
			this.log.warn({ branchId: id }, "Attempted to remove non-existent branch")
			return
		}

		clearTimeout(branch.startupTimer)
		branch.startupTimer = undefined
		clearInterval(branch.lowWaterTimer)
		branch.lowWaterTimer = undefined
		// End the stream gracefully
		branch.stream.end()
		// Destroy to release resources
		branch.stream.destroy()

		this.branches.delete(id)
		this.emit("branch-removed", id)
		this.log.info({ branchId: id }, "Branch removed")
	}

	// Get all branch IDs.
	getBranchIds(): string[] {
		return Array.from(this.branches.keys())
	}

	distribute(chunk: Buffer): void {
		this.distributeData(chunk)
	}

	congestedBranchIds(out: Set<string>): void {
		out.clear()
		for (const [id, branch] of this.branches) {
			if (
				branch.active &&
				(branch.backpressure ||
					branch.stream.destroyed ||
					branch.stream.writableEnded ||
					branch.stream.writableLength >=
						(branch.startupHighWaterMark ?? branch.highWaterMark))
			)
				out.add(id)
		}
	}

	activeBranchIds(out: Set<string>): void {
		out.clear()
		for (const [id, branch] of this.branches) {
			if (branch.active) out.add(id)
		}
	}

	isBranchActive(id: string): boolean {
		return this.branches.get(id)?.active ?? false
	}

	// Get status for a specific branch.
	getBranchStatus(id: string): BranchStatus | undefined {
		const branch = this.branches.get(id)
		if (!branch) {
			return undefined
		}

		return {
			id,
			bufferedBytes: this.getBufferedBytes(branch),
			backpressure: branch.backpressure,
		}
	}

	// Distribute data to all active branches.
	// Requirement 2.3: Copy data to all active branches
	// Requirement 2.4: Emit backpressure without blocking source
	// Requirement 2.6: Prioritize real-time flow over buffering
	private distributeData(chunk: Buffer): void {
		const chunkLength = chunk.length

		for (const [branchId, branch] of this.branches) {
			// A deferred branch's consumer is not ready yet: nothing is written
			// or counted until it is activated.
			if (!branch.active) continue
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

			// Startup-only refusal: the startup period ended with a writable
			// backlog at or above the normal mark. It ends on any chunk once the
			// stream is writable and its writable backlog is below the mark; a
			// destroyed or ended stream stays refused and every chunk counts.
			if (branch.startupDraining) {
				const stream = branch.stream
				if (
					!stream.destroyed &&
					!stream.writableEnded &&
					stream.writableLength < branch.highWaterMark
				) {
					branch.startupDraining = false
					branch.dropLogged = false
				} else {
					this.countDrop(branchId, branch, chunkLength)
					continue
				}
			}

			if (branch.backpressure) {
				// Already in backpressure state, drop packet and track metrics
				this.countDrop(branchId, branch, chunkLength)
				continue
			}

			let canWrite = false
			try {
				if (!branch.stream.destroyed) {
					canWrite = branch.stream.write(chunk)
					branch.bufferedBytes = this.getBufferedBytes(branch)
					// While the startup mark lasts, only a writable backlog beyond it
					// is congestion. Beyond it the writable side is above the normal
					// mark, so the stream has a pending 'drain' to end the episode.
					if (branch.startupHighWaterMark !== undefined)
						canWrite =
							branch.stream.writableLength <= branch.startupHighWaterMark
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
				// Entering drop-mode loses nothing yet: the chunk was written, and a
				// burst absorber holds the next ones until the branch drains. The
				// warning waits for the first chunk actually dropped (countDrop).
				this.log.debug(
					{ branchId, bufferedBytes: branch.bufferedBytes },
					"Branch congested, entering drop-mode",
				)

				// The episode ends at the stream's 'drain' (writable side empty)
				// or, polled while it lasts, once the writable side is back at the
				// low-water mark, whichever comes first.
				const onDrain = () => this.endEpisode(branchId, branch)
				branch.episodeDrain = onDrain
				branch.stream.once("drain", onDrain)
				branch.lowWaterTimer = setInterval(() => {
					const stream = branch.stream
					if (stream.destroyed || stream.writableEnded) return
					if (
						stream.writableLength <=
						(branch.startupHighWaterMark ?? branch.highWaterMark) *
							DROP_MODE_LOW_WATER
					)
						this.endEpisode(branchId, branch)
				}, DROP_MODE_POLL_MS)
				branch.lowWaterTimer.unref?.()
			}
		}
	}

	/** Ends a drop-mode episode once; the next chunk is written again. */
	private endEpisode(branchId: string, branch: BranchState): void {
		clearInterval(branch.lowWaterTimer)
		branch.lowWaterTimer = undefined
		if (branch.episodeDrain) branch.stream.off("drain", branch.episodeDrain)
		branch.episodeDrain = undefined
		if (!branch.backpressure) return
		const drainTime = Date.now()
		const durationMs = branch.backpressureSince
			? drainTime - branch.backpressureSince
			: 0

		branch.backpressure = false
		branch.dropLogged = false
		branch.bufferedBytes = this.getBufferedBytes(branch)
		branch.backpressureSince = undefined
		branch.lastDrainAt = new Date(drainTime).toISOString()

		// Emit drain event with duration for telemetry; it also wakes the absorber.
		this.emit("drain", branchId, durationMs)
		this.log.debug({ branchId, durationMs }, "Branch drained, resuming flow")
	}

	/** Counts one dropped chunk; the first of a congestion episode warns. */
	private countDrop(
		branchId: string,
		branch: BranchState,
		chunkLength: number,
	): void {
		branch.droppedBytesTotal += chunkLength
		branch.droppedChunksTotal++
		if (branch.dropLogged) return
		branch.dropLogged = true
		this.log.warn(
			{
				branchId,
				bufferedBytes: this.getBufferedBytes(branch),
				highWaterMark: branch.highWaterMark,
			},
			"Branch congested, dropping input",
		)
	}

	// Get extended telemetry for a specific branch.
	// Used for real-time monitoring dashboards.
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
			bufferBytes: this.getBufferedBytes(branch),
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

	// Get complete telemetry snapshot for all branches.
	// Provides global view of fanout system health for dashboards and APIs.
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
				bufferBytes: this.getBufferedBytes(branch),
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

	private getBufferedBytes(branch: BranchState): number {
		return branch.stream.readableLength + branch.stream.writableLength
	}

	// Clean up all branches and detach source.
	destroy(): void {
		this.detachSource()

		for (const branchId of this.branches.keys()) {
			this.removeBranch(branchId)
		}

		this.log.info("FanoutManager destroyed")
	}
}
