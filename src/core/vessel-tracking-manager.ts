/**
 * Bridges decoder:output ship events to the VesselTracker.
 *
 * Listens to every decoder unless decoderIds is set. Non-ship output is ignored.
 */

import type { Logger } from "@wavekit/shared"
import { createComponentLogger } from "../utils/logger.js"
import type { DecoderManager } from "../decoders/manager.js"
import type { DecoderOutput } from "../decoders/types.js"
import { VesselTracker, type VesselTrackerConfig } from "./vessel-tracker.js"

export interface VesselTrackingManagerConfig extends VesselTrackerConfig {
	/** Decoder ids to accept. Empty or omitted means every decoder. */
	decoderIds?: string[]
}

export class VesselTrackingManager {
	private readonly log: Logger
	private readonly tracker: VesselTracker
	private readonly decoderIds: string[]
	private started = false

	constructor(
		decoderManager: DecoderManager,
		config: VesselTrackingManagerConfig,
		logger: Logger,
	) {
		this.log = createComponentLogger(logger, "VesselTrackingManager")
		this.decoderIds = config.decoderIds ?? []
		this.tracker = new VesselTracker(config, logger)
		this.wireDecoderEvents(decoderManager)
		this.log.info(
			{
				decoderFilter: this.decoderIds.length > 0 ? this.decoderIds : "all",
			},
			"Vessel tracking manager initialized",
		)
	}

	/** Start the tracker timers. Idempotent. */
	start(): void {
		if (this.started) return
		this.tracker.start()
		this.started = true
		this.log.info("Vessel tracking manager started")
	}

	/** Stop the tracker timers. Idempotent. */
	stop(): void {
		if (!this.started) return
		this.tracker.stop()
		this.started = false
		this.log.info("Vessel tracking manager stopped")
	}

	/** Used by the API server for routes and WebSocket wiring. */
	getTracker(): VesselTracker {
		return this.tracker
	}

	private wireDecoderEvents(decoderManager: DecoderManager): void {
		decoderManager.on(
			"decoder:output",
			(decoderId: string, output: DecoderOutput) => {
				if (
					this.decoderIds.length > 0 &&
					!this.decoderIds.includes(decoderId)
				) {
					return
				}
				if (output.type !== "ship") return
				this.tracker.processShip(decoderId, output.data, output.timestamp)
			},
		)
		this.log.debug("Decoder events wired to vessel tracker")
	}
}
