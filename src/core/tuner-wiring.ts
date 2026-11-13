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
		// WG11 req 4.1: the configured gain follows the source's live config, so a
		// source re-added at runtime (with or without tuner) is honoured. Fakes
		// without getConfig keep whatever was set directly.
		if (typeof sourceManager.getConfig === "function")
			tunerController.syncConfiguredTuning(
				sourceId,
				sourceManager.getConfig(sourceId)?.tuner,
			)
		tunerController.initializeSource(sourceId, sourceManager.getCaps(sourceId))
		// WG11 req 4.2: a new connection; its first payload writes the configured gain.
		tunerController.noteSourceConnected(sourceId)
		tunerRelay.handleSourceConnected(sourceId)
	})

	// Sync on the session's first payload, not on connect: through rtlmux the
	// TCP accept precedes the dongle (writing commands into an rtlmux upstream
	// gap can crash it), and rtlmux replays its own command cache first, so the
	// core's restore lands last. Direct rtl_tcp streams within milliseconds.
	// With a tuning ledger the sync runs as its session starts (just before that first payload
	// byte is forwarded): assert reads the new session, unproven from its first byte. A source
	// manager without one (test doubles) syncs on "payload-started".
	const hasLedger =
		(sourceManager as Partial<Pick<SourceManager, "tuningLedger">>)
			.tuningLedger !== undefined
	const synchronize = (sourceId: string) => {
		if (!sourceManager.isRtlTcpSource(sourceId)) return
		tunerController.initializeSource(sourceId, sourceManager.getCaps(sourceId))
		// The receiver may have come back at its own defaults: restore or reset
		// accepted tuner state per tuner.reconnectPolicy and reconcile caps.
		// The first session after a paused feed's resume follows the resume instead: a plain
		// resume writes no tuning (SDR++ may have retuned the dongle through rtlmux, unseen),
		// a restore resume (`restoreTuning: true`) restores whatever the policy says.
		// Optional call: test doubles of the source manager predate pause / resume.
		const resume = sourceManager.resumeKind?.(sourceId) ?? null
		const result = tunerController.synchronizeOnConnect(
			sourceId,
			resume ? { resume } : {},
		)
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
	}
	if (hasLedger) sourceManager.on("session-started", synchronize)
	else sourceManager.on("payload-started", synchronize)

	sourceManager.on("removed", sourceId => {
		tunerController.removeSource(sourceId)
	})

	// A pause marks where the relay commands a plain resume still writes begin; a held feed
	// shows what a restore resume would write (SourceFeed.restoreTuning).
	// Optional calls: test doubles of the source manager predate pause / resume.
	sourceManager.on("feed-changed", (sourceId, feed) => {
		if (feed.state === "paused") tunerController.noteFeedPaused(sourceId)
	})
	sourceManager.setPausedTuningSource?.(sourceId =>
		tunerController.restorableTuning(sourceId),
	)

	// After a plain resume the rate is unverified: a sustained rate-truth mismatch is what the
	// receiver delivers, so a measured common rate is adopted (adoptObservedSampleRate).
	// A flagged mismatch keeps updating its measurement without another transition (a first
	// estimate between two common rates settles later), so adoption is retried on each metrics
	// interval (METRICS_INTERVAL_MS, 5 s per source, after the rate-truth check) while the rate is in doubt;
	// otherwise the listener stops at one Set lookup.
	const adoptMeasuredRate = (sourceId: string) => {
		if (!tunerController.isSampleRateUnverified(sourceId)) return
		const measured =
			sourceManager.getStatus?.(sourceId)?.rateMismatch?.measuredSampleRateHz
		if (measured !== undefined)
			tunerController.adoptObservedSampleRate(sourceId, measured)
	}
	sourceManager.on("rate-truth-changed", adoptMeasuredRate)
	sourceManager.on("metrics", adoptMeasuredRate)

	if (!relayEnabled) return

	// Assert rule 1: an attached relay client tunes the receiver; the core writes no centre or rate
	// (the client's frames prove them as `relay`). Its detach is a trigger.
	tunerController.setRelayAttachedView(sourceId => {
		// Optional call: relay doubles in tests may not report a status.
		const status = (
			tunerRelay as Partial<Pick<TunerRelay, "getStatus">>
		).getStatus?.()
		return status?.sourceId === sourceId && status.clientsConnected > 0
	})

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
	tunerRelay.on("client-disconnected", () => {
		const sourceId = (
			tunerRelay as Partial<Pick<TunerRelay, "getStatus">>
		).getStatus?.().sourceId
		if (sourceId) tunerController.requestAssert(sourceId)
	})
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
