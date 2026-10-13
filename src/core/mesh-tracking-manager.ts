/**
 * Bridges decoder:output meshtastic events to the MeshTracker.
 *
 * Listens to every decoder unless decoderIds is set. Other output types are
 * ignored. The tracker does not touch Activity: it behaves the same whether
 * Activity is enabled, disabled or unavailable.
 */

import type { Logger } from "@wavekit/shared"
import { createComponentLogger } from "../utils/logger.js"
import type { DecoderManager } from "../decoders/manager.js"
import type { DecoderOutput } from "../decoders/types.js"
import { MeshTracker, type MeshTrackerConfig } from "./mesh-tracker.js"

export interface MeshTrackingManagerConfig extends MeshTrackerConfig {
	/** Decoder ids to accept. Empty or omitted means every decoder. */
	decoderIds?: string[]
}

export class MeshTrackingManager {
	private readonly log: Logger
	private readonly tracker: MeshTracker
	private readonly decoderIds: string[]
	private started = false

	constructor(
		decoderManager: DecoderManager,
		config: MeshTrackingManagerConfig,
		logger: Logger,
	) {
		this.log = createComponentLogger(logger, "MeshTrackingManager")
		this.decoderIds = config.decoderIds ?? []
		this.tracker = new MeshTracker(config, logger)
		this.wireDecoderEvents(decoderManager)
		this.log.info(
			{
				decoderFilter: this.decoderIds.length > 0 ? this.decoderIds : "all",
			},
			"Mesh tracking manager initialized",
		)
	}

	/** Start the tracker timers. Idempotent. */
	start(): void {
		if (this.started) return
		this.tracker.start()
		this.started = true
		this.log.info("Mesh tracking manager started")
	}

	/** Stop the tracker timers. Idempotent. */
	stop(): void {
		if (!this.started) return
		this.tracker.stop()
		this.started = false
		this.log.info("Mesh tracking manager stopped")
	}

	/** Used by the API server for routes and WebSocket wiring. */
	getTracker(): MeshTracker {
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
				if (output.type !== "meshtastic") return
				this.tracker.processPacket(decoderId, output.data, output.timestamp)
			},
		)
		this.log.debug("Decoder events wired to mesh tracker")
	}
}
