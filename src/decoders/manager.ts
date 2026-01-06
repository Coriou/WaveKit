/**
 * Decoder Manager - Orchestrates decoder lifecycle
 *
 * Requirements:
 * - 4.1: WHEN a decoder is started, THE Decoder_Manager SHALL spawn the decoder process with appropriate arguments
 * - 4.2: WHEN a decoder process exits unexpectedly, THE Decoder_Manager SHALL restart it with exponential backoff
 * - 4.3: WHEN a decoder is stopped, THE Decoder_Manager SHALL send SIGTERM and wait, then SIGKILL if needed
 * - 4.4: WHEN a decoder produces output, THE Decoder_Manager SHALL parse it into structured DecoderOutput objects
 * - 4.5: WHEN requested, THE Decoder_Manager SHALL return status for all managed decoders including PID, uptime, and statistics
 * - 4.6: THE Decoder_Manager SHALL emit events for decoder output, errors, and exit conditions
 * - 20.1: WHEN a decoder is running and producing output, THE Decoder_Manager SHALL report health as "running"
 * - 20.2: WHEN a decoder is running but has not produced output for the configured timeout, THE Decoder_Manager SHALL report health as "idle"
 * - 20.3: WHEN a decoder has crashed and exceeded restart limits, THE Decoder_Manager SHALL report health as "faulted"
 * - 20.4: WHEN decoder health changes, THE Decoder_Manager SHALL emit a health event with the new status
 * - 27.1: WHEN a decoder is configured, THE Decoder_Manager SHALL validate the installed version against the pinned version
 * - 27.2: WHEN a version mismatch is detected, THE Decoder_Manager SHALL log a warning with upgrade instructions
 * - 27.3: THE Configuration SHALL support specifying minimum and maximum versions per decoder type
 */

import { EventEmitter } from "node:events"
import type {
	Decoder,
	DecoderConfig,
	DecoderHealth,
	DecoderOutput,
	DecoderStatus,
} from "./types.js"
import type { DecoderRegistry } from "./registry.js"
import type { FanoutManager } from "../core/fanout-manager.js"
import { createComponentLogger, type Logger } from "../utils/logger.js"
import {
	validateDecoderVersion,
	getUpgradeInstructions,
	type VersionValidationResult,
} from "../utils/version.js"

/**
 * Configuration for the Decoder Manager.
 */
export interface DecoderManagerConfig {
	/** Initial restart delay in milliseconds (default: 2000) */
	restartDelay: number
	/** Maximum restart delay in milliseconds (default: 30000) */
	maxRestartDelay: number
	/** Maximum number of restarts before giving up (0 = unlimited, default: 0) */
	maxRestarts: number
	/** Interval in milliseconds between health checks (default: 5000) */
	healthCheckInterval: number
	/** Timeout in milliseconds without output before marking decoder as idle (default: 30000) */
	idleTimeout: number
	/** Whether to validate decoder versions at startup (default: true) */
	validateVersions: boolean
}

/**
 * Internal state for tracking decoder restart behavior.
 */
interface DecoderState {
	decoder: Decoder
	config: DecoderConfig
	restartCount: number
	currentDelay: number
	restartTimer: ReturnType<typeof setTimeout> | null
	intentionallyStopped: boolean
	branchId: string | null
	/** Last known health state for change detection */
	lastHealth: DecoderHealth
	/** Timestamp of last output received */
	lastOutputAt: Date | null
	/** Version validation result (Requirements 27.1, 27.2, 27.3) */
	versionValidation?: VersionValidationResult | undefined
}

/**
 * Events emitted by the Decoder Manager.
 */
export interface DecoderManagerEvents {
	/** Emitted when a decoder produces output */
	"decoder:output": (decoderId: string, output: DecoderOutput) => void
	/** Emitted when a decoder encounters an error */
	"decoder:error": (decoderId: string, error: Error) => void
	/** Emitted when a decoder starts */
	"decoder:started": (decoderId: string) => void
	/** Emitted when a decoder stops */
	"decoder:stopped": (decoderId: string) => void
	/** Emitted when a decoder is restarting */
	"decoder:restarting": (
		decoderId: string,
		attempt: number,
		delay: number,
	) => void
	/** Emitted when max restarts exceeded */
	"decoder:max-restarts": (decoderId: string, restartCount: number) => void
	/** Emitted when decoder health changes (Requirement 20.4) */
	"decoder:health": (decoderId: string, health: DecoderHealth) => void
	/** Emitted when decoder version validation fails (Requirement 27.2) */
	"decoder:version-mismatch": (
		decoderId: string,
		validation: VersionValidationResult,
	) => void
}

const DEFAULT_CONFIG: DecoderManagerConfig = {
	restartDelay: 2000,
	maxRestartDelay: 30000,
	maxRestarts: 0,
	healthCheckInterval: 5000,
	idleTimeout: 30000,
	validateVersions: true,
}

/**
 * DecoderManager - Orchestrates decoder lifecycle and coordinates with other components.
 *
 * Handles:
 * - Creating decoders via the registry
 * - Starting/stopping/restarting decoders
 * - Auto-restart with exponential backoff on unexpected exits
 * - Wiring decoders to fanout branches for audio input
 * - Forwarding decoder events
 * - Periodic health checks (Requirements 20.1, 20.2, 20.3, 20.4)
 */
export class DecoderManager extends EventEmitter {
	private readonly log: Logger
	private readonly registry: DecoderRegistry
	private readonly fanout: FanoutManager
	private readonly config: DecoderManagerConfig
	private readonly decoders: Map<string, DecoderState> = new Map()
	private healthCheckTimer: ReturnType<typeof setInterval> | null = null

	constructor(
		registry: DecoderRegistry,
		fanout: FanoutManager,
		logger: Logger,
		config?: Partial<DecoderManagerConfig>,
	) {
		super()
		this.registry = registry
		this.fanout = fanout
		this.log = createComponentLogger(logger, "DecoderManager")
		this.config = { ...DEFAULT_CONFIG, ...config }

		// Start periodic health checks (Requirements 20.1, 20.2, 20.3, 20.4)
		this.startHealthChecks()
	}

	/**
	 * Creates a decoder instance using the registry.
	 * Does not start the decoder - call startDecoder() separately.
	 * Validates decoder version against configured constraints (Requirements 27.1, 27.2, 27.3).
	 *
	 * @param config - Configuration for the decoder
	 * @returns The created decoder instance
	 * @throws RegistryError if the decoder type is not registered
	 */
	createDecoder(config: DecoderConfig): Decoder {
		if (this.decoders.has(config.id)) {
			this.log.warn(
				{ decoderId: config.id },
				"Decoder already exists, returning existing instance",
			)
			return this.decoders.get(config.id)!.decoder
		}

		this.log.info(
			{ decoderId: config.id, type: config.type },
			"Creating decoder",
		)

		const decoder = this.registry.create(config, this.log)

		// Validate decoder version if constraints are specified (Requirements 27.1, 27.2, 27.3)
		let versionValidation: VersionValidationResult | undefined
		if (this.config.validateVersions) {
			versionValidation = this.validateDecoderVersion(config)
		}

		const state: DecoderState = {
			decoder,
			config,
			restartCount: 0,
			currentDelay: this.config.restartDelay,
			restartTimer: null,
			intentionallyStopped: false,
			branchId: null,
			lastHealth: "running",
			lastOutputAt: null,
			versionValidation,
		}

		this.decoders.set(config.id, state)
		this.setupDecoderEventHandlers(state)

		return decoder
	}

	/**
	 * Starts a decoder by ID.
	 * Wires the decoder to a fanout branch for audio input.
	 *
	 * @param id - The decoder ID to start
	 * @throws Error if decoder not found
	 */
	async startDecoder(id: string): Promise<void> {
		const state = this.decoders.get(id)
		if (!state) {
			throw new Error(`Decoder not found: ${id}`)
		}

		if (state.decoder.getStatus().running) {
			this.log.warn({ decoderId: id }, "Decoder already running")
			return
		}

		this.log.info({ decoderId: id }, "Starting decoder")

		// Reset restart tracking
		state.intentionallyStopped = false
		state.restartCount = 0
		state.currentDelay = this.config.restartDelay

		// Wire to fanout branch
		await this.wireDecoderToFanout(state)

		// Start the decoder process
		await state.decoder.start()
	}

	/**
	 * Stops a decoder by ID.
	 * Cleans up the fanout branch and cancels any pending restart.
	 *
	 * @param id - The decoder ID to stop
	 * @throws Error if decoder not found
	 */
	async stopDecoder(id: string): Promise<void> {
		const state = this.decoders.get(id)
		if (!state) {
			throw new Error(`Decoder not found: ${id}`)
		}

		this.log.info({ decoderId: id }, "Stopping decoder")

		// Mark as intentionally stopped to prevent auto-restart
		state.intentionallyStopped = true

		// Cancel any pending restart
		if (state.restartTimer) {
			clearTimeout(state.restartTimer)
			state.restartTimer = null
		}

		// Stop the decoder process
		await state.decoder.stop()

		// Clean up fanout branch
		this.unwireDecoderFromFanout(state)
	}

	/**
	 * Restarts a decoder by ID.
	 *
	 * @param id - The decoder ID to restart
	 * @throws Error if decoder not found
	 */
	async restartDecoder(id: string): Promise<void> {
		const state = this.decoders.get(id)
		if (!state) {
			throw new Error(`Decoder not found: ${id}`)
		}

		this.log.info({ decoderId: id }, "Restarting decoder")

		// Stop first (this marks intentionallyStopped = true)
		await this.stopDecoder(id)

		// Reset the flag and start
		state.intentionallyStopped = false
		await this.startDecoder(id)
	}

	/**
	 * Starts all enabled decoders.
	 */
	async startAll(): Promise<void> {
		this.log.info("Starting all enabled decoders")

		const startPromises: Promise<void>[] = []

		for (const [id, state] of this.decoders) {
			if (state.config.enabled) {
				startPromises.push(
					this.startDecoder(id).catch(err => {
						this.log.error({ err, decoderId: id }, "Failed to start decoder")
					}),
				)
			}
		}

		await Promise.all(startPromises)
	}

	/**
	 * Stops all running decoders.
	 */
	async stopAll(): Promise<void> {
		this.log.info("Stopping all decoders")

		const stopPromises: Promise<void>[] = []

		for (const [id, state] of this.decoders) {
			if (state.decoder.getStatus().running) {
				stopPromises.push(
					this.stopDecoder(id).catch(err => {
						this.log.error({ err, decoderId: id }, "Failed to stop decoder")
					}),
				)
			}
		}

		await Promise.all(stopPromises)
	}

	/**
	 * Gets a decoder by ID.
	 *
	 * @param id - The decoder ID
	 * @returns The decoder instance or undefined if not found
	 */
	getDecoder(id: string): Decoder | undefined {
		return this.decoders.get(id)?.decoder
	}

	/**
	 * Gets all managed decoders.
	 *
	 * @returns Array of all decoder instances
	 */
	getAllDecoders(): Decoder[] {
		return Array.from(this.decoders.values()).map(state => state.decoder)
	}

	/**
	 * Gets the status of a decoder by ID (Requirement 4.5).
	 *
	 * @param id - The decoder ID
	 * @returns DecoderStatus or undefined if not found
	 */
	getStatus(id: string): DecoderStatus | undefined {
		return this.decoders.get(id)?.decoder.getStatus()
	}

	/**
	 * Gets the status of all managed decoders (Requirement 4.5).
	 *
	 * @returns Array of DecoderStatus for all decoders
	 */
	getAllStatus(): DecoderStatus[] {
		return Array.from(this.decoders.values()).map(state =>
			state.decoder.getStatus(),
		)
	}

	/**
	 * Removes a decoder from management.
	 * Stops the decoder if running and cleans up resources.
	 *
	 * @param id - The decoder ID to remove
	 */
	async removeDecoder(id: string): Promise<void> {
		const state = this.decoders.get(id)
		if (!state) {
			return
		}

		this.log.info({ decoderId: id }, "Removing decoder")

		// Stop if running
		if (state.decoder.getStatus().running) {
			await this.stopDecoder(id)
		}

		// Remove event listeners
		state.decoder.removeAllListeners()

		// Remove from map
		this.decoders.delete(id)
	}

	/**
	 * Destroys the manager and all managed decoders.
	 */
	async destroy(): Promise<void> {
		this.log.info("Destroying DecoderManager")

		// Stop health checks
		this.stopHealthChecks()

		await this.stopAll()

		for (const id of this.decoders.keys()) {
			await this.removeDecoder(id)
		}
	}

	/**
	 * Sets up event handlers for a decoder to forward events and handle auto-restart.
	 * All handlers are wrapped in try-catch to ensure failure isolation (Requirement 10.1).
	 */
	private setupDecoderEventHandlers(state: DecoderState): void {
		const { decoder } = state

		// Forward output events (Requirement 4.4, 4.6)
		// Also track last output time for health checks (Requirement 20.1, 20.2)
		// Wrapped in try-catch for failure isolation (Requirement 10.1)
		decoder.on("output", (output: DecoderOutput) => {
			try {
				state.lastOutputAt = new Date()
				this.emit("decoder:output", decoder.id, output)
			} catch (err) {
				this.log.error(
					{ err, decoderId: decoder.id },
					"Error handling decoder output event, continuing operation",
				)
			}
		})

		// Forward error events (Requirement 4.6)
		// Wrapped in try-catch for failure isolation (Requirement 10.1)
		decoder.on("error", (error: Error) => {
			try {
				this.log.error({ err: error, decoderId: decoder.id }, "Decoder error")
				this.emit("decoder:error", decoder.id, error)
			} catch (err) {
				this.log.error(
					{ err, decoderId: decoder.id },
					"Error handling decoder error event, continuing operation",
				)
			}
		})

		// Handle started event
		// Wrapped in try-catch for failure isolation (Requirement 10.1)
		decoder.on("started", () => {
			try {
				// Reset health to running when decoder starts (Requirement 20.1)
				this.updateDecoderHealth(state, "running")
				this.emit("decoder:started", decoder.id)
			} catch (err) {
				this.log.error(
					{ err, decoderId: decoder.id },
					"Error handling decoder started event, continuing operation",
				)
			}
		})

		// Handle stopped event
		// Wrapped in try-catch for failure isolation (Requirement 10.1)
		decoder.on("stopped", () => {
			try {
				this.emit("decoder:stopped", decoder.id)
			} catch (err) {
				this.log.error(
					{ err, decoderId: decoder.id },
					"Error handling decoder stopped event, continuing operation",
				)
			}
		})

		// Forward health events from decoder (Requirement 20.4)
		// Wrapped in try-catch for failure isolation (Requirement 10.1)
		decoder.on("health", (health: DecoderHealth) => {
			try {
				this.updateDecoderHealth(state, health)
			} catch (err) {
				this.log.error(
					{ err, decoderId: decoder.id },
					"Error handling decoder health event, continuing operation",
				)
			}
		})

		// Handle exit for auto-restart (Requirement 4.2)
		// Wrapped in try-catch for failure isolation (Requirement 10.1)
		decoder.on("exit", (code: number | null, signal: string | null) => {
			try {
				this.handleDecoderExit(state, code, signal)
			} catch (err) {
				this.log.error(
					{ err, decoderId: decoder.id, code, signal },
					"Error handling decoder exit event, continuing operation",
				)
			}
		})
	}

	/**
	 * Handles decoder process exit for auto-restart logic (Requirement 4.2).
	 * Also handles health state transitions (Requirements 20.3).
	 * Ensures failure isolation - errors here don't affect other decoders (Requirement 10.1).
	 */
	private handleDecoderExit(
		state: DecoderState,
		code: number | null,
		signal: string | null,
	): void {
		const { decoder } = state

		// Clean up fanout branch on exit - wrapped in try-catch for isolation (Requirement 10.1)
		try {
			this.unwireDecoderFromFanout(state)
		} catch (err) {
			this.log.error(
				{ err, decoderId: decoder.id },
				"Error unwiring decoder from fanout, continuing with exit handling",
			)
		}

		// Don't restart if intentionally stopped
		if (state.intentionallyStopped) {
			this.log.debug(
				{ decoderId: decoder.id },
				"Decoder stopped intentionally, not restarting",
			)
			return
		}

		// Check if max restarts exceeded (Requirement 20.3)
		if (
			this.config.maxRestarts > 0 &&
			state.restartCount >= this.config.maxRestarts
		) {
			this.log.error(
				{ decoderId: decoder.id, restartCount: state.restartCount },
				"Max restarts exceeded, not restarting - other decoders continue operating",
			)
			// Set health to faulted when crash loop detected (Requirement 20.3)
			this.updateDecoderHealth(state, "faulted")
			this.emit("decoder:max-restarts", decoder.id, state.restartCount)
			return
		}

		// Schedule restart with exponential backoff
		state.restartCount++
		const delay = state.currentDelay

		this.log.info(
			{
				decoderId: decoder.id,
				code,
				signal,
				attempt: state.restartCount,
				delay,
			},
			"Decoder exited unexpectedly, scheduling restart - other decoders continue operating",
		)

		this.emit("decoder:restarting", decoder.id, state.restartCount, delay)

		state.restartTimer = setTimeout(() => {
			state.restartTimer = null

			// Use void to handle the promise without blocking
			void (async () => {
				try {
					// Wire to fanout and start
					await this.wireDecoderToFanout(state)
					await decoder.start()

					// Reset delay on successful start
					state.currentDelay = this.config.restartDelay
				} catch (err) {
					// Log failure but don't crash - failure isolation (Requirement 10.1)
					this.log.error(
						{ err, decoderId: decoder.id },
						"Failed to restart decoder - other decoders continue operating",
					)
					// The exit handler will be called again, triggering another restart attempt
				}
			})()
		}, delay)

		// Calculate next delay with exponential backoff (Requirement 4.2)
		// Formula: min(2^N * baseDelay, maxDelay)
		state.currentDelay = Math.min(
			state.currentDelay * 2,
			this.config.maxRestartDelay,
		)
	}

	/**
	 * Wires a decoder to a fanout branch for audio input.
	 */
	private async wireDecoderToFanout(state: DecoderState): Promise<void> {
		const { decoder, config } = state

		// Create a branch ID based on decoder ID
		const branchId = `decoder-${config.id}`

		// Add branch to fanout
		const branch = this.fanout.addBranch({ id: branchId })

		// Attach branch to decoder input
		decoder.attachInput(branch)

		state.branchId = branchId

		this.log.debug(
			{ decoderId: decoder.id, branchId },
			"Decoder wired to fanout branch",
		)
	}

	/**
	 * Unwires a decoder from its fanout branch.
	 */
	private unwireDecoderFromFanout(state: DecoderState): void {
		const { decoder, branchId } = state

		if (branchId) {
			// Detach input from decoder
			decoder.detachInput()

			// Remove branch from fanout
			this.fanout.removeBranch(branchId)

			state.branchId = null

			this.log.debug(
				{ decoderId: decoder.id, branchId },
				"Decoder unwired from fanout branch",
			)
		}
	}

	// ============================================================================
	// Version Validation (Requirements 27.1, 27.2, 27.3)
	// ============================================================================

	/**
	 * Validates a decoder's installed version against configured constraints.
	 * Requirements: 27.1, 27.2, 27.3
	 *
	 * @param config - Decoder configuration with version constraints
	 * @returns Version validation result
	 */
	private validateDecoderVersion(
		config: DecoderConfig,
	): VersionValidationResult {
		const { type, minVersion, maxVersion } = config

		// Skip validation if no constraints specified
		if (!minVersion && !maxVersion) {
			this.log.debug(
				{ decoderId: config.id, type },
				"No version constraints specified, skipping validation",
			)
			return { valid: true }
		}

		this.log.info(
			{ decoderId: config.id, type, minVersion, maxVersion },
			"Validating decoder version",
		)

		const result = validateDecoderVersion(type, minVersion, maxVersion)

		if (result.valid) {
			this.log.info(
				{
					decoderId: config.id,
					type,
					detectedVersion: result.detectedVersion,
					minVersion,
					maxVersion,
				},
				"Decoder version validation passed",
			)
		} else {
			// Log warning with upgrade instructions (Requirement 27.2)
			if (result.detectedVersion) {
				if (minVersion && result.detectedVersion) {
					const instructions = getUpgradeInstructions(
						type,
						result.detectedVersion,
						minVersion,
						true,
					)
					this.log.warn(
						{
							decoderId: config.id,
							type,
							detectedVersion: result.detectedVersion,
							minVersion,
							maxVersion,
							error: result.error,
						},
						instructions,
					)
				} else if (maxVersion && result.detectedVersion) {
					const instructions = getUpgradeInstructions(
						type,
						result.detectedVersion,
						maxVersion,
						false,
					)
					this.log.warn(
						{
							decoderId: config.id,
							type,
							detectedVersion: result.detectedVersion,
							minVersion,
							maxVersion,
							error: result.error,
						},
						instructions,
					)
				}
			} else {
				this.log.warn(
					{
						decoderId: config.id,
						type,
						error: result.error,
					},
					`Failed to detect version for decoder ${type}. Version validation skipped.`,
				)
			}

			// Emit version mismatch event
			this.emit("decoder:version-mismatch", config.id, result)
		}

		return result
	}

	/**
	 * Gets the version validation result for a decoder.
	 *
	 * @param id - Decoder ID
	 * @returns Version validation result or undefined if not found
	 */
	getVersionValidation(id: string): VersionValidationResult | undefined {
		return this.decoders.get(id)?.versionValidation
	}

	/**
	 * Gets all version validation results.
	 *
	 * @returns Map of decoder ID to version validation result
	 */
	getAllVersionValidations(): Map<string, VersionValidationResult | undefined> {
		const validations = new Map<string, VersionValidationResult | undefined>()
		for (const [id, state] of this.decoders) {
			validations.set(id, state.versionValidation)
		}
		return validations
	}

	// ============================================================================
	// Health Monitoring (Requirements 20.1, 20.2, 20.3, 20.4)
	// ============================================================================

	/**
	 * Gets the health state of a decoder by ID (Requirements 20.1, 20.2, 20.3).
	 *
	 * @param id - The decoder ID
	 * @returns DecoderHealth or undefined if not found
	 */
	getHealth(id: string): DecoderHealth | undefined {
		const state = this.decoders.get(id)
		if (!state) {
			return undefined
		}
		return state.lastHealth
	}

	/**
	 * Gets the health state of all managed decoders (Requirements 20.1, 20.2, 20.3).
	 *
	 * @returns Map of decoder ID to health state
	 */
	getAllHealth(): Map<string, DecoderHealth> {
		const healthMap = new Map<string, DecoderHealth>()
		for (const [id, state] of this.decoders) {
			healthMap.set(id, state.lastHealth)
		}
		return healthMap
	}

	/**
	 * Starts periodic health checks for all decoders.
	 * Checks for idle state based on output timeout (Requirement 20.2).
	 */
	private startHealthChecks(): void {
		if (this.healthCheckTimer) {
			return
		}

		this.log.debug(
			{ interval: this.config.healthCheckInterval },
			"Starting health checks",
		)

		this.healthCheckTimer = setInterval(() => {
			this.performHealthChecks()
		}, this.config.healthCheckInterval)
	}

	/**
	 * Stops periodic health checks.
	 */
	private stopHealthChecks(): void {
		if (this.healthCheckTimer) {
			clearInterval(this.healthCheckTimer)
			this.healthCheckTimer = null
			this.log.debug("Stopped health checks")
		}
	}

	/**
	 * Performs health checks on all running decoders.
	 * Transitions to idle state if no output received within timeout (Requirement 20.2).
	 * Transitions back to running state if output is received (Requirement 20.1).
	 * Wrapped in try-catch for failure isolation (Requirement 10.1).
	 */
	private performHealthChecks(): void {
		const now = Date.now()

		for (const [id, state] of this.decoders) {
			try {
				const { decoder, lastOutputAt, lastHealth } = state
				const status = decoder.getStatus()

				// Skip if not running or already faulted
				if (!status.running || lastHealth === "faulted") {
					continue
				}

				// Check if decoder has produced output recently
				if (lastOutputAt) {
					const timeSinceOutput = now - lastOutputAt.getTime()

					if (timeSinceOutput > this.config.idleTimeout) {
						// No output for too long - transition to idle (Requirement 20.2)
						if (lastHealth !== "idle") {
							this.log.info(
								{
									decoderId: id,
									timeSinceOutput,
									timeout: this.config.idleTimeout,
								},
								"Decoder has not produced output, marking as idle (no signals detected)",
							)
							this.updateDecoderHealth(state, "idle")
						}
					} else if (lastHealth === "idle") {
						// Output received recently - transition back to running (Requirement 20.1)
						this.log.info(
							{ decoderId: id },
							"Decoder producing output again, marking as running",
						)
						this.updateDecoderHealth(state, "running")
					}
				} else {
					// No output ever received - check if decoder has been running long enough
					const uptime = status.uptime * 1000 // Convert to ms
					if (uptime > this.config.idleTimeout && lastHealth !== "idle") {
						this.log.info(
							{
								decoderId: id,
								uptime: status.uptime,
								timeout: this.config.idleTimeout,
							},
							"Decoder has never produced output, marking as idle (no signals detected)",
						)
						this.updateDecoderHealth(state, "idle")
					}
				}
			} catch (err) {
				// Log error but continue checking other decoders (Requirement 10.1)
				this.log.error(
					{ err, decoderId: id },
					"Error during health check for decoder, continuing with other decoders",
				)
			}
		}
	}

	/**
	 * Updates the health state of a decoder and emits an event if changed (Requirement 20.4).
	 *
	 * @param state - The decoder state to update
	 * @param health - The new health state
	 */
	private updateDecoderHealth(
		state: DecoderState,
		health: DecoderHealth,
	): void {
		if (state.lastHealth !== health) {
			const previousHealth = state.lastHealth
			state.lastHealth = health

			this.log.info(
				{
					decoderId: state.decoder.id,
					previousHealth,
					newHealth: health,
				},
				"Decoder health changed",
			)

			// Emit health event (Requirement 20.4)
			this.emit("decoder:health", state.decoder.id, health)
		}
	}
}
