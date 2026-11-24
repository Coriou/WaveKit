/**
 * One registry for the whole core and the ports each producer gets from it. Every port is the
 * same instance, narrowed: a producer without a port mints no txId and behaves as before.
 */
import type { Logger } from "../../utils/logger.js"
import { createComponentLogger } from "../../utils/logger.js"
import { TransmissionRegistry } from "./registry.js"
import type { TxDvPort, TxLiveDemodPort, TxScannerPort } from "./types.js"

export interface TransmissionWiringOptions {
	now?: () => number
	logger: Logger
}

export interface TransmissionWiring {
	readonly registry: TransmissionRegistry
	/** The scanner analog chain (ScannerService `transmissions`). */
	readonly scanner: TxScannerPort
	/** The live demodulator's transmissions (wireAnalogTransmissions `transmissions`). */
	readonly liveDemod: TxLiveDemodPort
	/** Digital-voice calls (dsd-fme options `transmissions`). */
	readonly dv: TxDvPort
	closeSource(
		sourceId: string | null,
		reason: "retune" | "source-lost",
		filter?: { epochNot?: number },
	): void
	stop(): void
}

export function wireTransmissions(
	opts: TransmissionWiringOptions,
): TransmissionWiring {
	const log = createComponentLogger(opts.logger, "Transmissions")
	const registry = new TransmissionRegistry(
		opts.now !== undefined ? { now: opts.now } : {},
	)
	registry.start()
	return {
		registry,
		scanner: registry,
		liveDemod: registry,
		dv: registry,
		closeSource(sourceId, reason, filter) {
			const n = registry.closeSource(sourceId, reason, undefined, filter)
			if (n > 0) log.debug({ closed: n, reason }, "Transmissions closed")
		},
		stop() {
			registry.stop()
		},
	}
}
