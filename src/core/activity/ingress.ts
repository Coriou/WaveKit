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
import { recordingBaseName } from "./recording-path.js"
import type { CoalesceMerge } from "./storage/coalesce.js"
import type {
	ActivityLinkOp,
	ActivityRecordingLink,
} from "./storage/contract.js"
import { activityChannelOf, recordingLinkOf } from "./storage/row.js"
import { dsdFmeKeepKey } from "../recordings/contract.js"
import {
	callTrustAdmits,
	dsdFmeCallRecordable,
} from "../../decoders/builtin/dmr-recording-gate.js"
import { DV_TAP_END_MAX_MS } from "../dv-tap/types.js"
import type {
	ActivityChannel,
	ActivityChannelLookup,
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
	/**
	 * Receptions whose channel lookup threw or answered something that is not a channel, or
	 * whose envelope could not carry it; each was kept without a channel.
	 */
	channelFailures: number
}

export interface ActivityIngress {
	publish(
		decoderId: string,
		decoderType: string | undefined,
		output: DecoderOutput,
	): void
	/**
	 * A call recording finalized after the call (the digital-voice call recorder): links it to
	 * that decoder's call's `call_end` row once the row's end was seen (see
	 * createCallRecordingLinker). Never throws.
	 */
	linkRecording(
		decoderId: string,
		callId: string,
		key: string,
		durationMs: number,
	): void
	counters(): ActivityIngressCounters
}

/**
 * How long a seen call end waits for its recording: twice DV_TAP_END_MAX_MS = 20 000 ms. The
 * recorder hears a call's end at most DV_TAP_END_MAX_MS (10 000 ms) after the decoder's, then
 * closes and renames the file (milliseconds); the second 10 s is the margin for a busy disk.
 */
export const CALL_LINK_END_KEEP_MS = 2 * DV_TAP_END_MAX_MS
/**
 * How long a recording waits for its call's end row: DV_TAP_END_MAX_MS = 10 000 ms. The tap
 * delivers a call DV_TAP_SETTLE_MS late, so the row normally exists already; a row that never
 * appears (Activity dropped it, or a probe's call) is given up then.
 */
export const CALL_LINK_PENDING_MS = DV_TAP_END_MAX_MS
/**
 * Entries in each of the linker's two maps: 1 024, the oldest evicted past it (counted). That is
 * 51 call ends per second over CALL_LINK_END_KEEP_MS (1 024 / 20), far above any receiver's
 * call rate; each entry is two short strings.
 */
export const CALL_LINK_MAX = 1024

export interface CallRecordingLinkerCounters {
	linked: number
	/** Not a call file key, or a decoder the catalogue does not list. */
	refused: number
	/** A recording whose call end row never appeared within CALL_LINK_PENDING_MS. */
	expired: number
	/** Entries evicted past CALL_LINK_MAX. */
	evicted: number
	/** The link sink threw. */
	failures: number
}

export interface CallRecordingLinker {
	/** Every decoder output, as published: only a `call_end` (not a late file) is kept. */
	noteOutput(decoderId: string, output: DecoderOutput): void
	/** A call's `call_end` row was published. */
	noteCallEnd(decoderId: string, callId: string): void
	linkRecording(
		decoderId: string,
		callId: string,
		key: string,
		durationMs: number,
	): void
	counters(): CallRecordingLinkerCounters
}

export interface CallRecordingLinkerOptions {
	/** The catalogue gate (ActivityIngressOptions.callRecordings). Omitted: none links. */
	callRecordings?: ((decoderId: string) => boolean) | null
	link: ((op: ActivityLinkOp) => void) | null
	/** Monotonic enough for the bounds; Date.now by default. */
	now?: () => number
	onFailure?: (decoderId: string, err: unknown) => void
}

/**
 * Links a call recording made after its call to the call's `call_end` row, in either order: the
 * row's end seen first (the normal case: the recorder hears a call DV_TAP_SETTLE_MS late), or the
 * recording first (held until the end arrives, at most CALL_LINK_PENDING_MS). No timer: expired
 * entries go on the next call. Never throws.
 */
export function createCallRecordingLinker(
	options: CallRecordingLinkerOptions,
): CallRecordingLinker {
	const now = options.now ?? Date.now
	const gate = options.callRecordings ?? null
	const ended = new Map<string, number>()
	const pending = new Map<
		string,
		{
			at: number
			decoderId: string
			callId: string
			recording: ActivityRecordingLink
		}
	>()
	const counts: CallRecordingLinkerCounters = {
		linked: 0,
		refused: 0,
		expired: 0,
		evicted: 0,
		failures: 0,
	}
	const keyOf = (decoderId: string, callId: string) =>
		`${decoderId}\u0000${callId}`

	/** Insertion order is age order: drop from the oldest while expired. */
	function expire(at: number): void {
		for (const [k, t] of ended) {
			if (at - t <= CALL_LINK_END_KEEP_MS) break
			ended.delete(k)
		}
		for (const [k, p] of pending) {
			if (at - p.at <= CALL_LINK_PENDING_MS) break
			pending.delete(k)
			counts.expired++
		}
	}

	function bound<V>(map: Map<string, V>): void {
		while (map.size > CALL_LINK_MAX) {
			const oldest = map.keys().next()
			if (oldest.done === true) break
			map.delete(oldest.value)
			counts.evicted++
		}
	}

	function send(
		decoderId: string,
		callId: string,
		recording: ActivityRecordingLink,
	): void {
		if (options.link === null) return
		try {
			options.link({ type: "link-call", decoderId, callId, recording })
			counts.linked++
		} catch (err) {
			counts.failures++
			try {
				options.onFailure?.(decoderId, err)
			} catch {
				// Never into the caller.
			}
		}
	}

	function noteCallEnd(decoderId: string, callId: string): void {
		try {
			const at = now()
			expire(at)
			const k = keyOf(decoderId, callId)
			const waiting = pending.get(k)
			if (waiting !== undefined) {
				pending.delete(k)
				// After the row: the end is noted before the row reaches the store (the decoder
				// manager emits an output before it publishes it), and a link only finds a row
				// queued before it. A microtask, never a timer.
				queueMicrotask(() =>
					send(waiting.decoderId, waiting.callId, waiting.recording),
				)
				return
			}
			ended.delete(k)
			ended.set(k, at)
			bound(ended)
		} catch {
			// Never into the decoder path.
		}
	}

	return {
		noteOutput(decoderId, output) {
			if (output.type !== "call_end") return
			let file: CallEndFile | null
			try {
				file = callEndFile(output)
			} catch {
				return
			}
			if (file === null || file.late || file.callId === undefined) return
			noteCallEnd(decoderId, file.callId)
		},
		noteCallEnd,
		linkRecording(decoderId, callId, key, durationMs) {
			try {
				const at = now()
				expire(at)
				let listed = false
				try {
					listed = gate !== null && gate(decoderId)
				} catch {
					listed = false
				}
				// Only a call file's `dsd~<name>` key (the catalogue's key grammar) is linked.
				const name = key.startsWith("dsd~") ? key.slice("dsd~".length) : null
				const recording =
					listed && name !== null && callIdOf(callId) !== undefined
						? recordingLinkOf(dsdFmeKeepKey(name), durationMs)
						: null
				if (recording === null) {
					counts.refused++
					return
				}
				const k = keyOf(decoderId, callId)
				if (ended.delete(k)) {
					send(decoderId, callId, recording)
					return
				}
				pending.delete(k)
				pending.set(k, { at, decoderId, callId, recording })
				bound(pending)
			} catch {
				// Never into the recorder.
			}
		},
		counters: () => ({ ...counts }),
	}
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
	 * `recording`: the row's playable recording (a dsd-fme call's file).
	 */
	sink: (
		envelope: DecodeEnvelope,
		present: ActivityPresenter,
		recording?: ActivityRecordingLink,
	) => void
	/**
	 * True when this decoder instance's call files are listed by the recordings catalogue (a
	 * configured dsd-fme decoder, not a scanner probe, whose files move into discovery folders).
	 * Only such calls link to `dsd~<name>`. Omitted: none.
	 */
	callRecordings?: ((decoderId: string) => boolean) | null
	/** A call's file found after its `call_end` row (`wavFileUpdate`): the link change. */
	link?: ((op: ActivityLinkOp) => void) | null
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
	/**
	 * The channel of a reception (ActivityChannelLookup: a scanner probe's discovery, or the
	 * discovery on the reception's frequency): stored rows carry it as `channel` and a
	 * `discoveryId` ref. Null or omitted: no row gets one. A throwing lookup or a malformed answer
	 * is counted (channelFailures) and the row kept without it.
	 */
	channel?: ActivityChannelLookup | null
}

const ICAO_ENTITY = /^icao:([0-9A-F]{6})$/

/** A call id as envelope refs accept it (envelope.ts): 1 to 128 characters. */
function callIdOf(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 && value.length <= 128
		? value
		: undefined
}

/** What a `call_end` output says about its recording (dsd-fme's `wavFile` and flags). */
interface CallEndFile {
	callId: string | undefined
	/** A file found after the call's row (`flags.wavFileUpdate`): never a row of its own. */
	late: boolean
	/** The output's data with `wavFile` reduced to a call file name (or removed): never a path. */
	data: unknown
	/** The `dsd~<name>` key of a call file name, or null. */
	key: string | null
	durationMs: unknown
	/** The call_end's own trust fields admit a recording (callTrustAdmits). */
	clear: boolean
}

function callEndFile(output: DecoderOutput): CallEndFile | null {
	if (output.type !== "call_end") return null
	const data = output.data
	if (typeof data !== "object" || data === null || Array.isArray(data))
		return null
	const body = data as Record<string, unknown>
	const flags = body["flags"]
	const late =
		typeof flags === "object" &&
		flags !== null &&
		(flags as Record<string, unknown>)["wavFileUpdate"] === true
	const wav = body["wavFile"]
	let key: string | null = null
	let clean: unknown = data
	if (typeof wav === "string") {
		const name = recordingBaseName(wav)
		key = dsdFmeKeepKey(name)
		const rest: Record<string, unknown> = {}
		for (const [field, value] of Object.entries(body))
			if (field !== "wavFile") rest[field] = value
		// A name that is not a call file name (or a path elsewhere) is not kept at all.
		clean = key === null ? rest : { ...rest, wavFile: name }
	}
	return {
		callId: callIdOf(body["callId"]),
		late,
		data: clean,
		key,
		durationMs: body["duration"],
		clear: callTrustAdmits(body["protocol"], body),
	}
}

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
 * then the lookup's registration, type and operator. When the lookup knows
 * nothing (the tracker forgot a fading aircraft before its final flush),
 * the identity the entity's earlier rows carried (`remembered`, from the
 * merged state) fills in. Undefined when none.
 */
function aircraftIdentityOf(
	envelope: DecodeEnvelope,
	lookup: ActivityAircraftIdentityLookup | null,
	remembered?: DecodeAircraftIdentity,
): DecodeAircraftIdentity | undefined {
	const icao = ICAO_ENTITY.exec(envelope.entityKey ?? "")?.[1]
	if (icao === undefined) return undefined
	const identity: DecodeAircraftIdentity = {}
	const callsign =
		callsignOf(envelope.decodedData) ?? identityText(remembered?.callsign)
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
	const looked =
		identity.registration !== undefined ||
		identity.typeCode !== undefined ||
		identity.typeDescription !== undefined ||
		identity.operator !== undefined
	if (!looked && remembered !== undefined) {
		const registration = identityText(remembered.registration)
		const typeCode = identityText(remembered.typeCode)
		const typeDescription = identityText(remembered.typeDescription)
		const operator = identityText(remembered.operator)
		if (registration !== undefined) identity.registration = registration
		if (typeCode !== undefined) identity.typeCode = typeCode
		if (typeDescription !== undefined)
			identity.typeDescription = typeDescription
		if (operator !== undefined) identity.operator = operator
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
	const callRecordings = options.callRecordings ?? null
	const linkSink = options.link ?? null
	const channelLookup = options.channel ?? null
	const log = createComponentLogger(options.logger, "ActivityIngress")
	const counts: ActivityIngressCounters = {
		published: 0,
		buildFailures: 0,
		sinkFailures: 0,
		presentationFailures: 0,
		provenanceFailures: 0,
		channelFailures: 0,
	}
	const lastLoggedAt = new Map<string, number>()
	// Recordings made after their call (the digital-voice call recorder): same gate and sink.
	const recordingLinker = createCallRecordingLinker({
		callRecordings,
		link: linkSink,
		onFailure: (decoderId, err) => note(decoderId, "sink", err, Date.now()),
	})

	function logFailure(
		decoderId: string,
		kind: "build" | "sink" | "presentation" | "provenance" | "channel",
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

	/**
	 * The envelope with the reception's channel, or as it was (no lookup, no channel, or a
	 * failure: counted). Never throws.
	 */
	const withChannel = (
		decoderId: string,
		envelope: DecodeEnvelope,
		at: number,
	): DecodeEnvelope => {
		if (channelLookup === null) return envelope
		let channel: ActivityChannel | null
		try {
			const answer: unknown = channelLookup(
				decoderId,
				envelope.provenance.frequency?.hz ?? null,
			)
			if (answer === null || answer === undefined) return envelope
			channel = activityChannelOf(answer)
			if (channel === null) throw new TypeError("not a channel")
		} catch (err) {
			counts.channelFailures++
			logFailure(decoderId, "channel", err, at)
			return envelope
		}
		try {
			return withEnvelopeMetadata(envelope, { channel })
		} catch (err) {
			counts.channelFailures++
			logFailure(decoderId, "channel", err, at)
			return envelope
		}
	}

	/** The call's recording when the catalogue lists this decoder's files; never throws. */
	const callRecording = (
		decoderId: string,
		file: CallEndFile,
	): ActivityRecordingLink | null => {
		if (file.key === null || callRecordings === null) return null
		// dsd-fme's own call file: its name must say a recordable protocol (a DMR name, or one
		// without a known protocol, is never linked while DMR recordings are off), whatever the
		// decoder reported.
		if (!dsdFmeCallRecordable(file.key.slice("dsd~".length))) return null
		// And the call_end must prove its call clear (callTrustAdmits): a P25 phase 1 or NXDN call
		// only with encryptionKnown true and clearEvidence true (its own clear print), a DMR call
		// only with encryptionKnown true, a P25 phase 2, dPMR, ProVoice, EDACS or M17 call never,
		// any call never when encrypted.
		if (!file.clear) return null
		try {
			if (!callRecordings(decoderId)) return null
		} catch {
			return null
		}
		return recordingLinkOf(file.key, file.durationMs)
	}

	return {
		publish(decoderId, decoderType, sourceOutput) {
			// dsd-fme calls: the file is a link, never a row or a path. A file found after the call's
			// row updates that row instead of adding one.
			const file = callEndFile(sourceOutput)
			if (file !== null && !file.late && file.callId !== undefined)
				recordingLinker.noteCallEnd(decoderId, file.callId)
			if (file?.late === true) {
				const recording = callRecording(decoderId, file)
				if (
					recording !== null &&
					file.callId !== undefined &&
					linkSink !== null
				)
					try {
						linkSink({
							type: "link-call",
							decoderId,
							callId: file.callId,
							recording,
						})
					} catch (err) {
						note(decoderId, "sink", err, Date.now())
					}
				return
			}
			const output: DecoderOutput =
				file === null || file.data === sourceOutput.data
					? sourceOutput
					: { ...sourceOutput, data: file.data }
			const recording = file === null ? null : callRecording(decoderId, file)
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
				// A call's end row is found again by its call id (a late file, links.ts).
				...(file?.callId === undefined
					? {}
					: { refs: { callId: file.callId } }),
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
			envelope = withChannel(decoderId, envelope, receivedAt.getTime())
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
				remembered?: DecodeAircraftIdentity,
			): DecodeEnvelope => {
				if (env.outputType !== "aircraft") return env
				const known = aircraftIdentityOf(env, identityLookup, remembered)
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
				const remembered = merged.aircraft
				try {
					const attempt = presentDecoderOutputResult(
						{ ...output, data: merged.decodedData },
						decoderType,
						context,
						base,
					)
					if (attempt.error !== undefined) {
						failed(attempt.error)
						return identified(base, base, remembered)
					}
					if (attempt.presentation === undefined)
						return identified(base, base, remembered)
					return identified(
						withPresentation(base, attempt.presentation),
						base,
						remembered,
					)
				} catch (err) {
					failed(err)
					return identified(base, base, remembered)
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
				if (recording === null) sink(envelope, present)
				else sink(envelope, present, recording)
			} catch (err) {
				note(decoderId, "sink", err, receivedAt.getTime())
				return
			}
			counts.published++
		},
		linkRecording(decoderId, callId, key, durationMs) {
			recordingLinker.linkRecording(decoderId, callId, key, durationMs)
		},
		counters() {
			return { ...counts }
		},
	}
}
