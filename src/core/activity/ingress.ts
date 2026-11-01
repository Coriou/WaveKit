import { randomUUID as cryptoRandomUUID } from "node:crypto"
import type { DecoderOutput } from "../../decoders/types.js"
import { createComponentLogger, type Logger } from "../../utils/logger.js"
import {
	AIRCRAFT_IDENTITY_MAX_BYTES,
	createDecodeEnvelope,
	withEnvelopeMetadata,
	withMergedData,
	withPresentation,
} from "./envelope.js"
import { fitAircraftIdentity } from "./presentation/budget.js"
import { presentDecoderOutputResult } from "./presentation/registry.js"
import { resolveProvenance } from "./provenance/resolve.js"
import type { CoalesceMerge } from "./storage/coalesce.js"
import type {
	ActivityProvenanceLookup,
	DecodeAircraftIdentity,
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
 * envelope when presenting fails (counted). Given an entity's merged latest
 * state (storage/coalesce.ts), presents that data instead and carries its
 * `coalesced` span; throws only when no envelope can carry that state (over
 * the envelope size), so the store keeps the held receptions and stores the
 * reception as its own data. Never throws without a merged state.
 */
export type ActivityPresenter = (merged?: CoalesceMerge) => DecodeEnvelope

/**
 * What the aircraft enrichment cache knows about an aircraft (ICAO address,
 * upper case), read from memory: never a lookup, an await or I/O. Called
 * only for aircraft rows the store keeps (about one per aircraft per
 * minute). Undefined or null: nothing known.
 */
export interface ActivityKnownAircraft {
	readonly registration?: string | undefined
	readonly typeCode?: string | undefined
	readonly typeDescription?: string | undefined
	/** The callsign's airline, else the registered operator. */
	readonly operator?: string | undefined
}

export type ActivityAircraftIdentityLookup = (
	icao: string,
) => ActivityKnownAircraft | null | undefined

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
	/**
	 * Stored aircraft rows carry the identity known when stored (`aircraft`):
	 * the callsign from the entity's merged state and what this returns. A
	 * throwing lookup or a malformed value is left out, never a failure.
	 */
	aircraftIdentity?: ActivityAircraftIdentityLookup | null
}

const ICAO_ENTITY = /^icao:([0-9A-F]{6})$/

/** A clean identity string, or undefined (wrong type, blank, control characters, over 64 bytes). */
function identityText(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined
	const text = value.trim()
	if (
		text.length === 0 ||
		Buffer.byteLength(text, "utf8") > AIRCRAFT_IDENTITY_MAX_BYTES ||
		/[\x00-\x1f\x7f-\x9f]/.test(text)
	)
		return undefined
	return text
}

function callsignOf(data: unknown): string | undefined {
	if (typeof data !== "object" || data === null || Array.isArray(data))
		return undefined
	const body = data as { readonly [key: string]: unknown }
	return identityText(body["callsign"]) ?? identityText(body["flight"])
}

/**
 * The aircraft identity of a presented aircraft envelope: merged callsign,
 * then the lookup's registration, type and operator. Undefined when none.
 */
function aircraftIdentityOf(
	envelope: DecodeEnvelope,
	lookup: ActivityAircraftIdentityLookup | null,
): DecodeAircraftIdentity | undefined {
	const icao = ICAO_ENTITY.exec(envelope.entityKey ?? "")?.[1]
	if (icao === undefined) return undefined
	const identity: DecodeAircraftIdentity = {}
	const callsign = callsignOf(envelope.decodedData)
	if (callsign !== undefined) identity.callsign = callsign
	if (lookup !== null) {
		let known: ReturnType<ActivityAircraftIdentityLookup>
		try {
			known = lookup(icao)
		} catch {
			known = undefined
		}
		if (typeof known === "object" && known !== null) {
			const registration = identityText(known.registration)
			const typeCode = identityText(known.typeCode)
			const typeDescription = identityText(known.typeDescription)
			const operator = identityText(known.operator)
			if (registration !== undefined) identity.registration = registration
			if (typeCode !== undefined) identity.typeCode = typeCode
			if (typeDescription !== undefined)
				identity.typeDescription = typeDescription
			if (operator !== undefined) identity.operator = operator
		}
	}
	return Object.keys(identity).length > 0 ? identity : undefined
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
	const identityLookup = options.aircraftIdentity ?? null
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
			// Counted only once the envelope is built: a reception dropped for
			// another reason is a build failure, not a provenance failure.
			let provenanceError: { err: unknown } | null = null
			try {
				provenance = resolveProvenance(
					output,
					lookup === null ? null : lookup(decoderId, output.provenanceBinding),
				)
				if (provenance.sourceId === null && provenance.frequency === null)
					provenance = null
			} catch (err) {
				provenanceError = { err }
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
				provenanceError = { err }
			}
			if (provenanceError !== null)
				noteProvenance(decoderId, provenanceError.err, receivedAt.getTime())
			const plain = envelope
			const failed = (err: unknown): DecodeEnvelope => {
				counts.presentationFailures++
				logFailure(decoderId, "presentation", err, receivedAt.getTime())
				return plain
			}
			let presented: DecodeEnvelope | undefined
			// Aircraft rows carry who the aircraft is (stored rows only: presented
			// lazily), within the row growth bound over `from`, the envelope the
			// presentation was fitted to.
			const identified = (
				env: DecodeEnvelope,
				from: DecodeEnvelope,
			): DecodeEnvelope => {
				if (env.outputType !== "aircraft") return env
				const known = aircraftIdentityOf(env, identityLookup)
				if (known === undefined) return env
				const aircraft = fitAircraftIdentity(env, from, known)
				if (aircraft === undefined) return env
				try {
					return withEnvelopeMetadata(env, { aircraft })
				} catch {
					// Over the envelope size: stored without it.
					return env
				}
			}
			const presentMerged = (merged: CoalesceMerge): DecodeEnvelope => {
				// Throws when the merged state does not fit: not a presentation
				// failure, the store counts it (coalesceMergeFailures).
				const base = withMergedData(plain, merged.decodedData, merged.coalesced)
				try {
					const attempt = presentDecoderOutputResult(
						{ ...output, data: merged.decodedData },
						decoderType,
						context,
						base,
					)
					if (attempt.error !== undefined) {
						failed(attempt.error)
						return identified(base, base)
					}
					if (attempt.presentation === undefined) return identified(base, base)
					return identified(withPresentation(base, attempt.presentation), base)
				} catch (err) {
					failed(err)
					return identified(base, base)
				}
			}
			const present: ActivityPresenter = merged => {
				if (merged !== undefined) return presentMerged(merged)
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
					presented = identified(
						withPresentation(plain, attempt.presentation),
						plain,
					)
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
