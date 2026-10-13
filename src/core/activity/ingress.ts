import { randomUUID as cryptoRandomUUID } from "node:crypto"
import type { DecoderOutput } from "../../decoders/types.js"
import { createComponentLogger, type Logger } from "../../utils/logger.js"
import { createDecodeEnvelope, withPresentation } from "./envelope.js"
import { presentDecoderOutputResult } from "./presentation/registry.js"
import type { DecodeEnvelope, DecodeEnvelopeContext } from "./types.js"

const LOG_INTERVAL_MS = 60_000

export interface ActivityIngressCounters {
	published: number
	buildFailures: number
	sinkFailures: number
	/**
	 * Presentations dropped because they threw or made the envelope invalid.
	 * Only receptions the store goes on to keep are presented.
	 */
	presentationFailures: number
}

export interface ActivityIngress {
	publish(
		decoderId: string,
		decoderType: string | undefined,
		output: DecoderOutput,
	): void
	counters(): ActivityIngressCounters
}

/**
 * Returns the envelope with its presentation, or the given presentation-free
 * envelope when presenting fails (counted). Never throws.
 */
export type ActivityPresenter = () => DecodeEnvelope

export interface ActivityIngressOptions {
	/**
	 * Receives the presentation-free envelope and a presenter. The store calls
	 * the presenter only once it has decided to keep the reception (after
	 * coalescing and admission), so dropped receptions are never presented.
	 */
	sink: (envelope: DecodeEnvelope, present: ActivityPresenter) => void
	logger: Logger
	now?: () => Date
	randomUUID?: () => string
}

/**
 * Allocates one event id and receivedAt per decoder output, builds a
 * provenance-free envelope, and hands it to the store with a lazy presenter.
 * Build, sink and presentation failures are counted and never thrown back to
 * the decoder manager. A failed presentation keeps the plain envelope (1.7).
 */
export function createActivityIngress(
	options: ActivityIngressOptions,
): ActivityIngress {
	const now = options.now ?? (() => new Date())
	const randomUUID = options.randomUUID ?? cryptoRandomUUID
	const sink = options.sink
	const log = createComponentLogger(options.logger, "ActivityIngress")
	const counts = {
		published: 0,
		buildFailures: 0,
		sinkFailures: 0,
		presentationFailures: 0,
	}
	const lastLoggedAt = new Map<string, number>()

	function logFailure(
		decoderId: string,
		kind: "build" | "sink" | "presentation",
		err: unknown,
		at: number,
	): void {
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

	function note(
		decoderId: string,
		kind: "build" | "sink",
		err: unknown,
		at: number,
	): void {
		if (kind === "build") counts.buildFailures++
		else counts.sinkFailures++
		logFailure(decoderId, kind, err, at)
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
			const context: DecodeEnvelopeContext = {
				eventId,
				receivedAt,
				decoderId,
				...(decoderType === undefined ? {} : { decoderType }),
				provenance: { sourceId: null, frequency: null },
			}
			let envelope: DecodeEnvelope
			try {
				envelope = createDecodeEnvelope(output, context)
			} catch (err) {
				note(decoderId, "build", err, receivedAt.getTime())
				return
			}
			const plain = envelope
			const failed = (err: unknown): DecodeEnvelope => {
				counts.presentationFailures++
				logFailure(decoderId, "presentation", err, receivedAt.getTime())
				return plain
			}
			let presented: DecodeEnvelope | undefined
			const present: ActivityPresenter = () => {
				if (presented !== undefined) return presented
				presented = plain
				try {
					const attempt = presentDecoderOutputResult(
						output,
						decoderType,
						context,
						plain,
					)
					if (attempt.error !== undefined) return failed(attempt.error)
					if (attempt.presentation === undefined) return plain
					presented = withPresentation(plain, attempt.presentation)
					return presented
				} catch (err) {
					return failed(err)
				}
			}
			try {
				sink(envelope, present)
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
