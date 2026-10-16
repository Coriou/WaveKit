/**
 * Bridges decoder:output APRS events to the AprsTracker.
 *
 * Listens to every decoder unless decoderIds is set. Non-APRS output is ignored.
 */

import type { Logger } from "@wavekit/shared"
import { createComponentLogger } from "../utils/logger.js"
import type { DecoderManager } from "../decoders/manager.js"
import type { DecoderOutput } from "../decoders/types.js"
import { AprsTracker, type AprsTrackerConfig } from "./aprs-tracker.js"

export interface AprsTrackingManagerConfig extends AprsTrackerConfig {
	/** Decoder ids to accept. Empty or omitted means every decoder. */
	decoderIds?: string[]
}

export class AprsTrackingManager {
	private readonly log: Logger
	private readonly tracker: AprsTracker
	private readonly decoderIds: string[]
	private started = false

	constructor(
		decoderManager: DecoderManager,
		config: AprsTrackingManagerConfig,
		logger: Logger,
	) {
		this.log = createComponentLogger(logger, "AprsTrackingManager")
		this.decoderIds = config.decoderIds ?? []
		this.tracker = new AprsTracker(config, logger)
		this.wireDecoderEvents(decoderManager)
		this.log.info(
			{
				decoderFilter: this.decoderIds.length > 0 ? this.decoderIds : "all",
			},
			"APRS tracking manager initialized",
		)
	}

	/** Start the tracker timers. Idempotent. */
	start(): void {
		if (this.started) return
		this.tracker.start()
		this.started = true
		this.log.info("APRS tracking manager started")
	}

	/** Stop the tracker timers. Idempotent. */
	stop(): void {
		if (!this.started) return
		this.tracker.stop()
		this.started = false
		this.log.info("APRS tracking manager stopped")
	}

	/** Used by the API server for routes and WebSocket wiring. */
	getTracker(): AprsTracker {
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
				if (output.type !== "aprs") return
				this.tracker.processAprs(decoderId, output.data, output.timestamp)
			},
		)
		this.log.debug("Decoder events wired to APRS tracker")
	}
}
