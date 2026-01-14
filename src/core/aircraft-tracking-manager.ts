/**
 * Aircraft Tracking Manager - Bridges decoder output to the AircraftTracker
 *
 * This is an ADS-B-specific addon that does NOT affect other decoders.
 * It listens for decoder:output events from readsb/ADS-B decoders, parses
 * the aircraft data, and feeds it to the AircraftTracker for state aggregation.
 *
 * @module src/core/aircraft-tracking-manager
 */

import type { Logger } from "@wavekit/shared"
import { createComponentLogger } from "../utils/logger.js"
import {
	AircraftTracker,
	type AircraftTrackerConfig,
} from "./aircraft-tracker.js"
import type { DecoderManager } from "../decoders/manager.js"
import type { DecoderOutput } from "../decoders/types.js"
import { parseRawAircraft } from "../decoders/builtin/readsb.js"

// ============================================================================
// Configuration
// ============================================================================

export interface AircraftTrackingManagerConfig extends AircraftTrackerConfig {
	/** Decoder IDs to listen to (empty = listen to all) */
	decoderIds?: string[]
}

// ============================================================================
// Aircraft Tracking Manager
// ============================================================================

/**
 * AircraftTrackingManager - Manages the AircraftTracker lifecycle and wiring.
 *
 * Responsibilities:
 * - Instantiates and manages the AircraftTracker
 * - Listens to decoder:output events from the DecoderManager
 * - Filters for aircraft-type messages and feeds them to the tracker
 * - Exposes the tracker for API and WebSocket wiring
 */
export class AircraftTrackingManager {
	private readonly log: Logger
	private readonly tracker: AircraftTracker
	private readonly decoderIds: string[]
	private started = false

	constructor(
		private readonly decoderManager: DecoderManager,
		config: AircraftTrackingManagerConfig,
		logger: Logger,
	) {
		this.log = createComponentLogger(logger, "AircraftTrackingManager")
		this.decoderIds = config.decoderIds ?? []

		// Create the tracker with provided config
		this.tracker = new AircraftTracker(config, logger)

		// Wire up decoder events
		this.wireDecoderEvents()

		this.log.info(
			{
				decoderFilter: this.decoderIds.length > 0 ? this.decoderIds : "all",
			},
			"Aircraft tracking manager initialized",
		)
	}

	/**
	 * Start the tracker (begins cleanup timer).
	 */
	start(): void {
		if (this.started) return
		this.tracker.start()
		this.started = true
		this.log.info("Aircraft tracking manager started")
	}

	/**
	 * Stop the tracker.
	 */
	stop(): void {
		if (!this.started) return
		this.tracker.stop()
		this.started = false
		this.log.info("Aircraft tracking manager stopped")
	}

	/**
	 * Get the underlying AircraftTracker instance.
	 * Used by ApiServer for routes and WebSocket wiring.
	 */
	getTracker(): AircraftTracker {
		return this.tracker
	}

	/**
	 * Wire decoder:output events to the tracker.
	 */
	private wireDecoderEvents(): void {
		this.decoderManager.on(
			"decoder:output",
			(decoderId: string, output: DecoderOutput) => {
				// Filter by decoder ID if configured
				if (
					this.decoderIds.length > 0 &&
					!this.decoderIds.includes(decoderId)
				) {
					return
				}

				// Only process aircraft-type messages
				if (output.type !== "aircraft") {
					return
				}

				// Parse the raw aircraft data
				const rawData = output.data as Record<string, unknown>
				const parsed = parseRawAircraft(rawData)

				if (parsed) {
					this.tracker.processUpdate(parsed)
				}
			},
		)

		this.log.debug("Decoder events wired to aircraft tracker")
	}
}
