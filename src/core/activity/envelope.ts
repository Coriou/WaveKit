import { types } from "node:util"
import { z } from "zod"
import type { DecoderOutput } from "../../decoders/types.js"
import {
	invalidEnvelope,
	MAX_ENVELOPE_BYTES,
	ownRecord,
	projectDecodedData,
	projectJson,
} from "./projection.js"
import type {
	DecodeEnvelope,
	DecodeEnvelopeContext,
	DecodePresentation,
	JsonValue,
} from "./types.js"

const text = (max: number) =>
	z
		.string()
		.min(1)
		.refine(
			value =>
				Buffer.byteLength(value, "utf8") <= max &&
				!/[\x00-\x1f\x7f-\x9f]/.test(value),
		)
const id = text(128)
const timestamp = text(24).refine(
	value =>
		/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
		Number.isFinite(Date.parse(value)) &&
		new Date(value).toISOString() === value,
)
const provenanceSchema = z
	.object({
		sourceId: id.nullable(),
		frequency: z
			.object({
				hz: z.number().finite().positive().max(Number.MAX_SAFE_INTEGER),
				basis: z.enum(["channel", "probe"]),
				tuningTrust: z.enum(["commanded", "relay", "unverified"]),
			})
			.strict()
			.nullable(),
		jobId: id.optional(),
		probeId: id.optional(),
		channelId: id.optional(),
	})
	.strict()
const refsSchema = z
	.object({
		callId: id.optional(),
		discoveryId: id.optional(),
		observationId: id.optional(),
	})
	.strict()
const fieldSchema = z
	.object({
		key: id,
		label: text(128),
		value: z.union([
			z
				.string()
				.refine(
					value =>
						Buffer.byteLength(value, "utf8") <= 32768 &&
						!/[\x00-\x1f\x7f-\x9f]/.test(value),
				),
			z.number().finite(),
			z.boolean(),
			z.null(),
		]),
		unit: text(32).optional(),
	})
	.strict()
const fieldsSchema = z
	.array(fieldSchema)
	.max(64)
	.refine(
		fields => new Set(fields.map(field => field.key)).size === fields.length,
	)
const presentationSchema = z
	.object({
		protocol: text(64).nullable().optional(),
		category: z
			.enum(["aircraft", "voice", "pager", "data", "other"])
			.optional(),
		title: text(256).nullable().optional(),
		fields: fieldsSchema.optional(),
	})
	.strict()
const contextSchema = z
	.object({
		eventId: id,
		receivedAt: timestamp,
		decoderId: id,
		decoderType: id.optional(),
		provenance: provenanceSchema.optional(),
		refs: refsSchema.optional(),
	})
	.strict()
const outputSchema = z
	.object({
		timestamp: timestamp,
		decoder: id,
		type: text(64),
	})
	.strict()
const metadataSchema = z
	.object({
		version: z.literal(1),
		eventId: id,
		producedAt: timestamp,
		receivedAt: timestamp,
		decoderId: id,
		decoderType: id.optional(),
		outputType: text(64),
		protocol: text(64).nullable(),
		category: z.enum(["aircraft", "voice", "pager", "data", "other"]),
		title: text(256).nullable(),
		fields: fieldsSchema,
		provenance: provenanceSchema,
		refs: refsSchema.optional(),
	})
	.strict()

function dateIso(value: unknown): string {
	if (
		value === null ||
		typeof value !== "object" ||
		types.isProxy(value) ||
		!types.isDate(value)
	)
		return invalidEnvelope()
	const projected = projectDecodedData(value)
	if (typeof projected !== "string" || !timestamp.safeParse(projected).success)
		return invalidEnvelope()
	return projected
}
function complete(metadata: unknown, decodedData: JsonValue): DecodeEnvelope {
	const result = metadataSchema.safeParse(metadata)
	if (!result.success) return invalidEnvelope()
	const envelope = { ...result.data, decodedData }
	if (Buffer.byteLength(JSON.stringify(envelope), "utf8") > MAX_ENVELOPE_BYTES)
		return invalidEnvelope()
	// Safe projection removed undefined members; Zod's optional types remain wider.
	return envelope as DecodeEnvelope
}

/** No IDs, clocks, RF inference or protocol confirmation are performed here. */
export function createDecodeEnvelope(
	output: DecoderOutput,
	context: DecodeEnvelopeContext,
	presentation?: DecodePresentation,
): DecodeEnvelope {
	try {
		const producer = ownRecord(output)
		const metadata = ownRecord(context)
		producer["timestamp"] = dateIso(producer["timestamp"])
		metadata["receivedAt"] = dateIso(metadata["receivedAt"])
		// Payload budgets start at its own root; wrappers must not spend depth/nodes.
		const decodedData = projectDecodedData(producer["data"])
		delete producer["data"]
		const parsedProducer = outputSchema.safeParse(
			projectJson(producer, false, true),
		)
		const parsedContext = contextSchema.safeParse(
			projectJson(metadata, false, true),
		)
		const parsedPresentation = presentationSchema.safeParse(
			projectJson(presentation === undefined ? {} : presentation, false, true),
		)
		if (
			!parsedProducer.success ||
			!parsedContext.success ||
			!parsedPresentation.success
		)
			return invalidEnvelope()
		const origin = parsedProducer.data
		const supplied = parsedContext.data
		const display = parsedPresentation.data
		if (origin.decoder !== supplied.decoderId) return invalidEnvelope()
		return complete(
			{
				version: 1,
				eventId: supplied.eventId,
				producedAt: origin.timestamp,
				receivedAt: supplied.receivedAt,
				decoderId: supplied.decoderId,
				...(supplied.decoderType === undefined
					? {}
					: { decoderType: supplied.decoderType }),
				outputType: origin.type,
				protocol: display.protocol ?? null,
				category: display.category ?? "other",
				title: display.title ?? null,
				fields: display.fields ?? [],
				provenance: supplied.provenance ?? { sourceId: null, frequency: null },
				...(supplied.refs === undefined ? {} : { refs: supplied.refs }),
			},
			decodedData,
		)
	} catch {
		return invalidEnvelope()
	}
}

/** Strict wire JSON only. Nested Dates are rejected; payload budgets match create. */
export function validateDecodeEnvelope(input: unknown): DecodeEnvelope {
	try {
		const metadata = ownRecord(input)
		const decodedData = projectJson(metadata["decodedData"], false, false)
		delete metadata["decodedData"]
		return complete(projectJson(metadata, false, false), decodedData)
	} catch {
		return invalidEnvelope()
	}
}
