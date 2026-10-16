import { randomUUID as cryptoRandomUUID } from "node:crypto"
import type { DecoderOutput } from "../../decoders/types.js"
import { createComponentLogger, type Logger } from "../../utils/logger.js"
import { createDecodeEnvelope, withPresentation } from "./envelope.js"
import { presentDecoderOutputResult } from "./presentation/registry.js"
import { resolveProvenance } from "./provenance/resolve.js"
import type {
	ActivityProvenanceLookup,
	DecodeEnvelope,
	DecodeEnvelopeContext,
	DecodeProvenance,
} from "./types.js"

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
	/**
	 * Receptions whose provenance lookup or resolution threw, or whose envelope
	 * was rejected because of provenance; each was kept with null provenance.
	 */
	provenanceFailures: number
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
	/**
	 * WG3 (web-gaps-3 req 5): decoder binding lookup for RF provenance. Null or omitted keeps
	 * today's `{ sourceId: null, frequency: null }` unless the payload reports a frequency.
	 */
	resolveProvenance?: ActivityProvenanceLookup | null
}

/**
 * Allocates one event id and receivedAt per decoder output, resolves its RF
 * provenance (before store admission, req 5.6), builds the envelope, and
 * hands it to the store with a lazy presenter.
 * Build, sink and presentation failures are counted and never thrown back to
 * the decoder manager. A failed presentation keeps the plain envelope (1.7).
 */
export function createActivityIngress(
	options: ActivityIngressOptions,
): ActivityIngress {
	const now = options.now ?? (() => new Date())
	const randomUUID = options.randomUUID ?? cryptoRandomUUID
	const sink = options.sink
	const lookup = options.resolveProvenance ?? null
	const log = createComponentLogger(options.logger, "ActivityIngress")
	const counts: ActivityIngressCounters = {
		published: 0,
		buildFailures: 0,
		sinkFailures: 0,
		presentationFailures: 0,
		provenanceFailures: 0,
	}
	const lastLoggedAt = new Map<string, number>()

	function logFailure(
		decoderId: string,
		kind: "build" | "sink" | "presentation" | "provenance",
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

	function noteProvenance(decoderId: string, err: unknown, at: number): void {
		counts.provenanceFailures++
		logFailure(decoderId, "provenance", err, at)
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
			let provenance: DecodeProvenance | null = null
			try {
				provenance = resolveProvenance(
					output,
					lookup === null ? null : lookup(decoderId),
				)
				if (provenance.sourceId === null && provenance.frequency === null)
					provenance = null
			} catch (err) {
				noteProvenance(decoderId, err, receivedAt.getTime())
			}
			let context: DecodeEnvelopeContext = {
				eventId,
				receivedAt,
				decoderId,
				...(decoderType === undefined ? {} : { decoderType }),
				provenance: provenance ?? { sourceId: null, frequency: null },
			}
			let envelope: DecodeEnvelope
			try {
				envelope = createDecodeEnvelope(output, context)
			} catch (err) {
				if (provenance === null) {
					note(decoderId, "build", err, receivedAt.getTime())
					return
				}
				// Rejected possibly because of provenance (req 5.7): keep the
				// reception with null provenance; only a failed rebuild counts as
				// a build failure.
				context = {
					...context,
					provenance: { sourceId: null, frequency: null },
				}
				try {
					envelope = createDecodeEnvelope(output, context)
				} catch (rebuildErr) {
					note(decoderId, "build", rebuildErr, receivedAt.getTime())
					return
				}
				noteProvenance(decoderId, err, receivedAt.getTime())
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
