import { randomUUID as cryptoRandomUUID } from "node:crypto"
import type { DecoderOutput } from "../../decoders/types.js"
import { createComponentLogger, type Logger } from "../../utils/logger.js"
import { createDecodeEnvelope } from "./envelope.js"
import type { DecodeEnvelope } from "./types.js"

const LOG_INTERVAL_MS = 60_000

export interface ActivityIngressCounters {
	published: number
	buildFailures: number
	sinkFailures: number
}

export interface ActivityIngress {
	publish(
		decoderId: string,
		decoderType: string | undefined,
		output: DecoderOutput,
	): void
	counters(): ActivityIngressCounters
}

export interface ActivityIngressOptions {
	sink: (envelope: DecodeEnvelope) => void
	logger: Logger
	now?: () => Date
	randomUUID?: () => string
}

/**
 * Allocates one event id and receivedAt per decoder output, builds a
 * provenance-free envelope, and hands it to the store. Build and sink
 * failures are counted and never thrown back to the decoder manager.
 */
export function createActivityIngress(
	options: ActivityIngressOptions,
): ActivityIngress {
	const now = options.now ?? (() => new Date())
	const randomUUID = options.randomUUID ?? cryptoRandomUUID
	const sink = options.sink
	const log = createComponentLogger(options.logger, "ActivityIngress")
	const counts = { published: 0, buildFailures: 0, sinkFailures: 0 }
	const lastLoggedAt = new Map<string, number>()

	function note(
		decoderId: string,
		kind: "build" | "sink",
		err: unknown,
		at: number,
	): void {
		if (kind === "build") counts.buildFailures++
		else counts.sinkFailures++
		const previous = lastLoggedAt.get(decoderId)
		if (previous !== undefined && at - previous < LOG_INTERVAL_MS) return
		lastLoggedAt.set(decoderId, at)
		try {
			log.warn(
				{ err, decoderId, failure: kind },
				"Activity ingress failed for a decoder output",
			)
		} catch {
			// Logging must not escape publish.
		}
	}

	return {
		publish(decoderId, decoderType, output) {
			let eventId: string
			let receivedAt: Date
			try {
				eventId = randomUUID()
				receivedAt = now()
			} catch (err) {
				note(decoderId, "build", err, Date.now())
				return
			}
			let envelope: DecodeEnvelope
			try {
				envelope = createDecodeEnvelope(output, {
					eventId,
					receivedAt,
					decoderId,
					...(decoderType === undefined ? {} : { decoderType }),
					provenance: { sourceId: null, frequency: null },
				})
			} catch (err) {
				note(decoderId, "build", err, receivedAt.getTime())
				return
			}
			try {
				sink(envelope)
			} catch (err) {
				note(decoderId, "sink", err, receivedAt.getTime())
				return
			}
			counts.published++
		},
		counters() {
			return { ...counts }
		},
	}
}
