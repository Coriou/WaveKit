/**
 * The core's transmission composition (src/index.ts uses exactly this): one registry from
 * wireTransmissions, its narrowed ports for every producer and the route, the source-lost and
 * retune closes, and the stop. A test builds it the same way and checks every port is the one
 * registry.
 */
import type { PipelineEvent } from "../spectrum/types.js"
import type { DecoderConfig } from "../../decoders/types.js"
import type { Logger } from "../../utils/logger.js"
import { createDsdFmeDecoder } from "../../decoders/builtin/dsd-fme.js"
import type { DsdFmeDecoder } from "../../decoders/builtin/dsd-fme.js"
import { wireTransmissions } from "./wiring.js"
import type { TransmissionWiring } from "./wiring.js"
import type { TxLiveDemodPort, TxReadPort, TxScannerPort } from "./types.js"

/** What the source manager emits that closes a source's transmissions. */
export interface TxSourceEvents {
	on(event: "disconnected", listener: (sourceId: string) => void): unknown
	off(event: "disconnected", listener: (sourceId: string) => void): unknown
}

/** The spectrum service's pipeline events (a new engine epoch is a retune). */
export interface TxSpectrumEvents {
	on(
		event: "pipeline",
		listener: (sourceId: string, ev: PipelineEvent) => void,
	): unknown
	off(
		event: "pipeline",
		listener: (sourceId: string, ev: PipelineEvent) => void,
	): unknown
}

export interface TransmissionComposition {
	readonly wiring: TransmissionWiring
	/** ScannerService options. */
	readonly scanner: { transmissions: TxScannerPort }
	/** wireAnalogTransmissions options (the live demodulator). */
	readonly liveDemod: { transmissions: TxLiveDemodPort }
	/** The dsd-fme decoder factory, with the registry's DV port as its runtime option. */
	readonly dsdFmeFactory: (
		config: DecoderConfig,
		logger: Logger,
	) => DsdFmeDecoder
	/** ApiServer dependencies. */
	readonly api: { transmissions: TxReadPort }
	/** A lost source closes its transmissions (`source-lost`); returns the unbind. */
	bindSources(sources: TxSourceEvents): () => void
	/** A new spectrum epoch closes the older epochs' transmissions (`retune`); returns the unbind. */
	bindSpectrum(spectrum: TxSpectrumEvents): () => void
	stop(): void
}

export function composeTransmissions(opts: {
	logger: Logger
	now?: () => number
}): TransmissionComposition {
	const wiring = wireTransmissions(
		opts.now !== undefined
			? { logger: opts.logger, now: opts.now }
			: { logger: opts.logger },
	)
	const dv = wiring.dv
	return {
		wiring,
		scanner: { transmissions: wiring.scanner },
		liveDemod: { transmissions: wiring.liveDemod },
		dsdFmeFactory: (config, logger) =>
			createDsdFmeDecoder(config, logger, { transmissions: dv }),
		api: { transmissions: wiring.route },
		bindSources(sources) {
			const lost = (sourceId: string) => {
				wiring.closeSource(sourceId, "source-lost")
			}
			sources.on("disconnected", lost)
			return () => {
				sources.off("disconnected", lost)
			}
		},
		bindSpectrum(spectrum) {
			const pipeline = (sourceId: string, ev: PipelineEvent) => {
				if (ev.kind === "epoch-started")
					wiring.closeSource(sourceId, "retune", { epochNot: ev.epoch })
			}
			spectrum.on("pipeline", pipeline)
			return () => {
				spectrum.off("pipeline", pipeline)
			}
		},
		stop() {
			wiring.stop()
		},
	}
}
