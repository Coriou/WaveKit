/**
 * Tuner wiring - connects SourceManager lifecycle and TunerRelay activity to
 * the shared TunerController (used by src/index.ts; exported for tests).
 *
 * Source caps follow tuner state only through TunerController: accepted
 * commands (API or relay) and reconnect synchronization. Raw relay events never
 * write caps directly, so a rate the controller rejected cannot reach decoders.
 */

import type { Logger } from "../utils/logger.js"
import type { SourceManager } from "./source-manager.js"
import type { TunerController } from "./tuner-controller.js"
import type { TunerRelay } from "./tuner-relay.js"

export interface TunerWiringDeps {
	log: Logger
	sourceManager: SourceManager
	tunerController: TunerController
	tunerRelay: TunerRelay
	relayEnabled: boolean
}

export function wireTunerControl(deps: TunerWiringDeps): void {
	const { log, sourceManager, tunerController, tunerRelay, relayEnabled } = deps

	sourceManager.on("connected", sourceId => {
		if (!sourceManager.isRtlTcpSource(sourceId)) return
		tunerController.initializeSource(sourceId, sourceManager.getCaps(sourceId))
		// The receiver may have come back at its own defaults: restore or reset
		// accepted tuner state per tuner.reconnectPolicy and reconcile caps.
		const result = tunerController.synchronizeOnConnect(sourceId)
		if (result.error) {
			log.warn(
				{
					sourceId,
					policy: result.policy,
					commands: result.commands,
					err: result.error,
				},
				"Tuner state restore after reconnect failed; will retry on next connection",
			)
		}
		tunerRelay.handleSourceConnected(sourceId)
	})

	sourceManager.on("removed", sourceId => {
		tunerController.removeSource(sourceId)
	})

	if (!relayEnabled) return

	const syncRelayControl = () => {
		const status = tunerRelay.getStatus()
		if (!status.sourceId) {
			return
		}

		if (!tunerController.getState(status.sourceId)) {
			if (sourceManager.isRtlTcpSource(status.sourceId)) {
				tunerController.initializeSource(
					status.sourceId,
					sourceManager.getCaps(status.sourceId),
				)
			} else {
				log.warn(
					{ sourceId: status.sourceId },
					"Tuner relay source is not RTL-TCP compatible",
				)
				return
			}
		}

		const hasExternalControl =
			status.controlPolicy === "shared"
				? status.clientsConnected > 0
				: Boolean(status.controlClientId)

		tunerController.syncExternalControl(status.sourceId, hasExternalControl)
	}

	tunerRelay.on("client-connected", syncRelayControl)
	tunerRelay.on("client-disconnected", syncRelayControl)
	tunerRelay.on("control-changed", syncRelayControl)
	tunerRelay.on("command-received", event => {
		if (!event.sourceId) {
			return
		}
		tunerController.applyExternalCommand(
			event.sourceId,
			event.command,
			event.value,
		)
	})

	// Accepted relay rates already reach caps via applyExternalCommand; a
	// rejected (out-of-range) rate must not, so this handler only logs.
	tunerRelay.on("sample-rate-changed", (sourceId, sampleRate) => {
		const accepted = tunerController.getState(sourceId)?.sampleRate
		log.info(
			{ sourceId, sampleRate, accepted: accepted === sampleRate },
			"Sample rate command from tuner relay",
		)
	})
}
