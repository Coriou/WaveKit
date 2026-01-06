/**
 * Degraded Mode Monitor - Periodic warnings when system is in degraded state
 *
 * Requirements:
 * - 10.5: Log warning every 60 seconds while degraded, stop when resolved
 */

import type { DecoderManager } from "../decoders/manager.js"
import type { SourceManager } from "../core/source-manager.js"
import { createComponentLogger, type Logger } from "./logger.js"

/**
 * Configuration for the DegradedModeMonitor
 */
export interface DegradedModeMonitorConfig {
	/** Interval in milliseconds between degraded mode warnings (default: 60000 = 60 seconds) */
	warningInterval: number
	/** Whether to monitor decoder health (default: true) */
	monitorDecoders: boolean
	/** Whether to monitor source health (default: true) */
	monitorSources: boolean
}

const DEFAULT_CONFIG: DegradedModeMonitorConfig = {
	warningInterval: 60000, // 60 seconds
	monitorDecoders: true,
	monitorSources: true,
}

/**
 * Degraded state information for logging
 */
interface DegradedState {
	isDecodersDegraded: boolean
	isSourcesDegraded: boolean
	idleDecoders: string[]
	faultedDecoders: string[]
	disconnectedSources: string[]
}

/**
 * DegradedModeMonitor - Monitors system health and logs periodic warnings when degraded.
 *
 * Implements Requirement 10.5:
 * - Logs warning every 60 seconds while system is in degraded mode
 * - Stops warnings when degraded condition is resolved
 *
 * Monitors:
 * - DecoderManager: faulted decoders (idle is normal, not degraded)
 * - SourceManager: disconnected sources
 */
export class DegradedModeMonitor {
	private readonly log: Logger
	private readonly config: DegradedModeMonitorConfig
	private readonly decoderManager: DecoderManager | null
	private readonly sourceManager: SourceManager | null
	private warningTimer: ReturnType<typeof setInterval> | null = null
	private lastDegradedState: DegradedState | null = null

	constructor(
		logger: Logger,
		decoderManager: DecoderManager | null,
		sourceManager: SourceManager | null,
		config?: Partial<DegradedModeMonitorConfig>,
	) {
		this.log = createComponentLogger(logger, "DegradedModeMonitor")
		this.config = { ...DEFAULT_CONFIG, ...config }
		this.decoderManager = decoderManager
		this.sourceManager = sourceManager
	}

	/**
	 * Starts the degraded mode monitoring.
	 * Will check system state at the configured interval and log warnings if degraded.
	 */
	start(): void {
		if (this.warningTimer) {
			this.log.debug("Degraded mode monitor already running")
			return
		}

		this.log.info(
			{ interval: this.config.warningInterval },
			"Starting degraded mode monitor",
		)

		// Perform initial check
		this.checkAndWarn()

		// Schedule periodic checks
		this.warningTimer = setInterval(() => {
			this.checkAndWarn()
		}, this.config.warningInterval)
	}

	/**
	 * Stops the degraded mode monitoring.
	 */
	stop(): void {
		if (this.warningTimer) {
			clearInterval(this.warningTimer)
			this.warningTimer = null
			this.log.info("Stopped degraded mode monitor")
		}
	}

	/**
	 * Checks the current degraded state and logs a warning if degraded.
	 * Implements Requirement 10.5.
	 */
	private checkAndWarn(): void {
		const state = this.getDegradedState()

		// Check if we're in degraded mode
		const isDegraded = state.isDecodersDegraded || state.isSourcesDegraded

		if (isDegraded) {
			this.logDegradedWarning(state)
		} else if (this.lastDegradedState !== null) {
			// Was degraded, now resolved
			this.log.info(
				"System has recovered from degraded state - all components operational",
			)
		}

		this.lastDegradedState = isDegraded ? state : null
	}

	/**
	 * Gets the current degraded state from all monitored components.
	 */
	private getDegradedState(): DegradedState {
		const state: DegradedState = {
			isDecodersDegraded: false,
			isSourcesDegraded: false,
			idleDecoders: [],
			faultedDecoders: [],
			disconnectedSources: [],
		}

		// Check decoder health
		if (this.config.monitorDecoders && this.decoderManager) {
			const allHealth = this.decoderManager.getAllHealth()
			for (const [id, health] of allHealth) {
				if (health === "idle") {
					state.idleDecoders.push(id)
					// Note: idle decoders do NOT set isDecodersDegraded - they are normal
				} else if (health === "faulted") {
					state.faultedDecoders.push(id)
					state.isDecodersDegraded = true
				}
			}
		}

		// Check source health
		if (this.config.monitorSources && this.sourceManager) {
			const degradedInfo = this.sourceManager.getDegradedInfo()
			state.disconnectedSources = degradedInfo.disconnectedSources
			state.isSourcesDegraded =
				degradedInfo.isDegraded || degradedInfo.isAllUnavailable
		}

		return state
	}

	/**
	 * Logs a warning about the current degraded state.
	 * Implements Requirement 10.5.
	 */
	private logDegradedWarning(state: DegradedState): void {
		const issues: string[] = []

		if (state.idleDecoders.length > 0) {
			// Idle decoders are informational only, not warnings
			// issues.push(`idle decoders: ${state.idleDecoders.join(", ")}`)
		}

		if (state.faultedDecoders.length > 0) {
			issues.push(`faulted decoders: ${state.faultedDecoders.join(", ")}`)
		}

		if (state.disconnectedSources.length > 0) {
			issues.push(
				`disconnected sources: ${state.disconnectedSources.join(", ")}`,
			)
		}

		this.log.warn(
			{
				idleDecoders: state.idleDecoders,
				faultedDecoders: state.faultedDecoders,
				disconnectedSources: state.disconnectedSources,
			},
			`System operating in degraded mode: ${issues.join("; ")}`,
		)
	}

	/**
	 * Checks if the system is currently in degraded mode.
	 *
	 * @returns true if any component is degraded, false otherwise
	 */
	isDegraded(): boolean {
		const state = this.getDegradedState()
		return state.isDecodersDegraded || state.isSourcesDegraded
	}

	/**
	 * Gets detailed information about the current degraded state.
	 *
	 * @returns DegradedState object with all degraded components
	 */
	getState(): DegradedState {
		return this.getDegradedState()
	}
}
