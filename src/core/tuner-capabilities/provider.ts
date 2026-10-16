import type {
	ReceiverCapabilities,
	ReceiverCapabilitiesPage,
} from "@wavekit/api-types"
import { RECEIVER_SAMPLE_RATE_PRESETS_HZ } from "@wavekit/api-types"
import {
	prepareReceiverPolicy,
	projectReceiverControls,
	projectReceiverHeader,
} from "./rtl-tcp.js"
import {
	freezeReceiverData,
	isDetachedPlainData,
	isReceiverSourceId,
	isReceiverTime,
	isReceiverToken,
	receiverCapabilitiesPageSchema,
	receiverCapabilitiesSchema,
	receiverEvidenceSchema,
	RECEIVER_CAPABILITIES_LIMITS,
} from "./types.js"
import type {
	ReceiverCapabilitiesProvider,
	ReceiverEvidenceReader,
	ReceiverProviderFailureCode,
	ReceiverProviderResult,
	ReceiverRestCommandPolicy,
	SourceReceiverEvidence,
} from "./types.js"

type PageFailure = Exclude<ReceiverProviderFailureCode, "NOT_FOUND">
const failure = <C extends ReceiverProviderFailureCode>(
	code: C,
): { readonly ok: false; readonly code: C } => ({ ok: false, code })

function coherentEvidence(e: SourceReceiverEvidence): boolean {
	const { source, connection, delivery, header } = e
	if (
		e.sourceIncarnation === e.snapshotId ||
		e.sessionId === e.snapshotId ||
		e.sessionId === e.sourceIncarnation
	)
		return false
	if (source.type === "recording" && connection === "connecting") return false
	if (source.kind === "recording" && source.type !== "recording") return false
	if (
		source.kind === "iq" &&
		source.format !== "U8_IQ" &&
		source.format !== "S16_IQ"
	)
		return false
	if (
		source.kind === "audio_pcm" &&
		!["S16LE", "FLOAT32LE", "auto"].includes(source.format)
	)
		return false
	if (
		source.type === "recording"
			? e.sessionId !== null
			: connection === "connected" || connection === "connecting"
				? e.sessionId === null
				: e.sessionId !== null
	)
		return false
	if (connection === "ended" && source.type !== "recording") return false
	if (
		delivery.lastSampleAt === null
			? delivery.sampleAgeMs !== null
			: delivery.sampleAgeMs === null
	)
		return false
	if (
		delivery.lastSampleAt !== null &&
		(delivery.lastSampleAt > e.capturedAt ||
			delivery.sampleAgeMs !==
				Math.min(
					Number.MAX_SAFE_INTEGER,
					Math.max(0, e.capturedAt - delivery.lastSampleAt),
				))
	)
		return false
	if (
		connection === "disconnected" &&
		(delivery.state !== "disconnected" || delivery.lastSampleAt !== null)
	)
		return false
	if (
		connection === "ended" &&
		(delivery.state !== "ended" || delivery.lastSampleAt !== null)
	)
		return false
	if (
		connection === "connecting" &&
		(delivery.state !== "waiting" || delivery.lastSampleAt !== null)
	)
		return false
	if (connection === "connected") {
		if (delivery.state === "disconnected" || delivery.state === "ended")
			return false
		if (
			delivery.state === "streaming" &&
			(delivery.sampleAgeMs === null || delivery.sampleAgeMs >= 10000)
		)
			return false
		if (
			delivery.state === "waiting" &&
			delivery.lastSampleAt !== null &&
			delivery.sampleAgeMs !== null &&
			delivery.sampleAgeMs < 10000
		)
			return false
		if (
			delivery.state === "stale" &&
			delivery.sampleAgeMs !== null &&
			delivery.sampleAgeMs < 10000
		)
			return false
	}
	const headerApplicable =
		source.type === "rtl_tcp" &&
		source.kind === "iq" &&
		source.format === "U8_IQ"
	if (!headerApplicable && header.capture !== "not-applicable") return false
	if (headerApplicable && header.capture === "not-applicable") return false
	if (
		connection !== "connected" &&
		header.capture !== "missing" &&
		header.capture !== "not-applicable"
	)
		return false
	if (header.capture === "complete") {
		if (
			header.bytes === null ||
			header.bytes.length !== 12 ||
			header.capturedAt === null ||
			header.capturedAt > e.capturedAt
		)
			return false
	} else if (header.bytes !== null || header.capturedAt !== null) return false
	return true
}

function project(
	input: SourceReceiverEvidence,
	policy: ReceiverRestCommandPolicy,
): ReceiverProviderResult<ReceiverCapabilities> {
	if (!isDetachedPlainData(input, true)) return failure("CONFLICT")
	if (
		input === null ||
		typeof input !== "object" ||
		typeof input.sourceId !== "string"
	)
		return failure("CONFLICT")
	// Existing invalid source IDs are LIMIT; get deliberately still calls the reader.
	if (!isReceiverSourceId(input.sourceId)) return failure("LIMIT")
	const parsed = receiverEvidenceSchema.safeParse(input)
	if (!parsed.success || !coherentEvidence(parsed.data))
		return failure("CONFLICT")
	const e = parsed.data
	const dto = {
		schemaVersion: 1 as const,
		sourceId: e.sourceId,
		sourceIncarnation: e.sourceIncarnation,
		sessionId: e.sessionId,
		snapshotId: e.snapshotId,
		capturedAt: new Date(e.capturedAt).toISOString(),
		source: { ...e.source },
		connection: e.connection,
		delivery: {
			...e.delivery,
			lastSampleAt:
				e.delivery.lastSampleAt === null
					? null
					: new Date(e.delivery.lastSampleAt).toISOString(),
		},
		peerHeader: projectReceiverHeader(e),
		controls: projectReceiverControls(policy, e.source.type === "rtl_tcp"),
		declaredStream: {
			provenance: "source-config-or-core-metadata" as const,
			sampleRateHz: e.caps.sampleRate,
			centerFrequencyHz: e.caps.centerFreq,
		},
		sampleRatePresets:
			e.source.type === "rtl_tcp"
				? {
						state: "suggested" as const,
						provenance: "wavekit-rtl-rate-presets" as const,
						valuesHz: RECEIVER_SAMPLE_RATE_PRESETS_HZ,
					}
				: {
						state: "not-applicable" as const,
						reason: "non-rtl-transport" as const,
					},
	}
	const validated = receiverCapabilitiesSchema.safeParse(dto)
	if (!validated.success) return failure("CONFLICT")
	if (
		Buffer.byteLength(JSON.stringify(validated.data), "utf8") >
		RECEIVER_CAPABILITIES_LIMITS.itemBytes
	)
		return failure("LIMIT")
	return { ok: true, value: freezeReceiverData(validated.data) }
}

/** Pure foundation. The caller owns real source capture and policy provenance. */
export function createReceiverCapabilitiesProvider(
	reader: ReceiverEvidenceReader | null | undefined,
	descriptor: ReceiverRestCommandPolicy,
): ReceiverCapabilitiesProvider {
	let disposed = false
	let policy: ReceiverRestCommandPolicy | null = null
	try {
		policy = prepareReceiverPolicy(descriptor)
	} catch {
		policy = null
	}
	return {
		get(sourceId) {
			if (disposed || !reader) return failure("UNAVAILABLE")
			if (typeof sourceId !== "string") return failure("CONFLICT")
			if (!policy) return failure("CONFLICT")
			try {
				const result = reader.read(sourceId)
				if (
					!isDetachedPlainData(result, true) ||
					result === null ||
					typeof result !== "object"
				)
					return failure("CONFLICT")
				if (result.kind !== "present") {
					if (Object.keys(result).length !== 1) return failure("CONFLICT")
					switch (result.kind) {
						case "missing":
							return failure("NOT_FOUND")
						case "unavailable":
							return failure("UNAVAILABLE")
						case "conflict":
							return failure("CONFLICT")
						case "limit":
							return failure("LIMIT")
						default:
							return failure("CONFLICT")
					}
				}
				if (
					Object.keys(result).length !== 2 ||
					result.evidence === null ||
					typeof result.evidence !== "object" ||
					result.evidence.sourceId !== sourceId
				)
					return failure("CONFLICT")
				return project(result.evidence, policy)
			} catch {
				return failure("FAILED")
			}
		},
		list(input): ReceiverProviderResult<ReceiverCapabilitiesPage, PageFailure> {
			if (disposed || !reader) return failure("UNAVAILABLE")
			try {
				if (
					input === null ||
					typeof input !== "object" ||
					Array.isArray(input) ||
					!isDetachedPlainData(input)
				)
					return failure("CONFLICT")
				const keys = Reflect.ownKeys(input)
				if (
					keys.length !== 2 ||
					!keys.includes("after") ||
					!keys.includes("limit")
				)
					return failure("CONFLICT")
				if (
					!Number.isInteger(input.limit) ||
					input.limit < 1 ||
					input.limit > 16 ||
					(input.after !== null && !isReceiverSourceId(input.after))
				)
					return failure("CONFLICT")
				if (!policy) return failure("CONFLICT")
				const result = reader.readPage(input.after, input.limit)
				if (
					!isDetachedPlainData(result, true) ||
					result === null ||
					typeof result !== "object"
				)
					return failure("CONFLICT")
				if (result.kind !== "candidates") {
					if (Object.keys(result).length !== 1) return failure("CONFLICT")
					switch (result.kind) {
						case "unavailable":
							return failure("UNAVAILABLE")
						case "conflict":
							return failure("CONFLICT")
						case "limit":
							return failure("LIMIT")
						default:
							return failure("CONFLICT")
					}
				}
				if (
					Object.keys(result).length !== 4 ||
					!Array.isArray(result.candidates)
				)
					return failure("CONFLICT")
				if (
					result.candidates.length > input.limit + 1 ||
					result.candidates.length > 17
				)
					return failure("LIMIT")
				if (
					!isReceiverTime(result.capturedAt) ||
					(result.candidates.length === 0
						? result.snapshotId !== null
						: !isReceiverToken(result.snapshotId))
				)
					return failure("CONFLICT")
				const projected: ReceiverCapabilities[] = []
				let previous = input.after
				for (const candidate of result.candidates) {
					if (candidate === null || typeof candidate !== "object")
						return failure("CONFLICT")
					if (
						candidate.capturedAt !== result.capturedAt ||
						candidate.snapshotId !== result.snapshotId
					)
						return failure("CONFLICT")
					const item = project(candidate, policy)
					if (!item.ok)
						return failure(
							item.code === "NOT_FOUND" || item.code === "UNAVAILABLE"
								? "CONFLICT"
								: item.code,
						)
					if (
						previous !== null &&
						Buffer.compare(
							Buffer.from(previous, "utf8"),
							Buffer.from(item.value.sourceId, "utf8"),
						) >= 0
					)
						return failure("CONFLICT")
					previous = item.value.sourceId
					projected.push(item.value)
				}
				// Omit lookahead only after its full projection, schema and byte checks.
				const items = projected.slice(0, input.limit)
				const value = {
					schemaVersion: 1 as const,
					items,
					nextAfter:
						projected.length > input.limit
							? (items.at(-1)?.sourceId ?? null)
							: null,
				}
				const validated = receiverCapabilitiesPageSchema.safeParse(value)
				if (!validated.success) return failure("CONFLICT")
				if (
					Buffer.byteLength(JSON.stringify(validated.data), "utf8") >
					RECEIVER_CAPABILITIES_LIMITS.pageBytes
				)
					return failure("LIMIT")
				return { ok: true, value: freezeReceiverData(validated.data) }
			} catch {
				return failure("FAILED")
			}
		},
		dispose() {
			disposed = true
		},
	}
}
