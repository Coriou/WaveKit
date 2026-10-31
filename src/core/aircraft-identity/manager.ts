/**
 * Feeds the aircraft identity registry from every decoder's output and prunes expired links.
 */
import type { Logger } from "@wavekit/shared"
import type {
	AircraftIdentifier,
	AircraftIdentityResponse,
} from "@wavekit/api-types"
import type { DecoderOutput } from "../../decoders/types.js"
import { createComponentLogger } from "../../utils/logger.js"
import { icaoId, observationsFrom, regId } from "./observe.js"
import { AircraftIdentityRegistry } from "./registry.js"

/** How often expired links are dropped. */
export const PRUNE_INTERVAL_MS = 60_000

/** The part of DecoderManager this needs, so tests can pass an EventEmitter. */
export interface DecoderOutputSource {
	on(
		event: "decoder:output",
		listener: (decoderId: string, output: DecoderOutput) => void,
	): unknown
	off(
		event: "decoder:output",
		listener: (decoderId: string, output: DecoderOutput) => void,
	): unknown
}

export class AircraftIdentityManager {
	private readonly log: Logger
	private readonly registry: AircraftIdentityRegistry
	private timer: NodeJS.Timeout | null = null
	private readonly onOutput = (_decoderId: string, output: DecoderOutput) => {
		for (const observation of observationsFrom(output))
			this.registry.observe(observation)
	}

	constructor(
		private readonly source: DecoderOutputSource,
		logger: Logger,
		registry: AircraftIdentityRegistry = new AircraftIdentityRegistry(),
	) {
		this.log = createComponentLogger(logger, "AircraftIdentity")
		this.registry = registry
		this.source.on("decoder:output", this.onOutput)
	}

	/** Starts pruning. Idempotent. */
	start(): void {
		if (this.timer !== null) return
		this.timer = setInterval(() => {
			const removed = this.registry.prune()
			if (removed > 0)
				this.log.debug(
					{ removed, links: this.registry.size },
					"Expired links dropped",
				)
		}, PRUNE_INTERVAL_MS)
		this.timer.unref()
	}

	/** Stops pruning and listening. Idempotent. */
	stop(): void {
		if (this.timer !== null) clearInterval(this.timer)
		this.timer = null
		this.source.off("decoder:output", this.onOutput)
	}

	/**
	 * Records that an aircraft database (the local tar1090-db or an online airframe lookup)
	 * gives this ICAO address this registration. A database link resolves a registration only
	 * when no link seen on the air does; values that are not a valid ICAO address or
	 * registration are ignored.
	 */
	observeDatabase(icao: string, registration: string, at = new Date()): void {
		const a = icaoId(icao)
		const b = regId(registration)
		if (a === null || b === null) return
		this.registry.observe({
			a,
			b,
			evidence: "database",
			source: "database",
			at,
		})
	}

	resolve(query: AircraftIdentifier): AircraftIdentityResponse {
		return { ...this.registry.resolve(query), timestamp: Date.now() }
	}
}
