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
const entityKeySchema = text(128)
	.refine(value => /^[a-z][a-z0-9-]*:[^:]+$/.test(value))
	.nullable()
const positionSchema = z
	.object({
		lat: z.number().finite().min(-90).max(90),
		lon: z.number().finite().min(-180).max(180),
		altM: z.number().finite().optional(),
	})
	.strict()
const presentationSchema = z
	.object({
		entityKey: entityKeySchema.optional(),
		position: positionSchema.optional(),
		protocol: text(64).nullable().optional(),
		category: z
			.enum([
				"aircraft",
				"marine",
				"aviation-data",
				"voice",
				"paging",
				"aprs",
				"sensors",
				"mesh",
				"other",
			])
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
		category: z.enum([
			"aircraft",
			"marine",
			"aviation-data",
			"voice",
			"paging",
			"aprs",
			"sensors",
			"mesh",
			"other",
		]),
		entityKey: entityKeySchema,
		position: positionSchema.optional(),
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
/**
 * Wire bytes of each envelope this module validated. `withPresentation` adds
 * a presentation to one of them without validating its metadata again.
 * Envelopes are treated as immutable once built.
 */
const validatedBytes = new WeakMap<DecodeEnvelope, number>()

function complete(metadata: unknown, decodedData: JsonValue): DecodeEnvelope {
	const result = metadataSchema.safeParse(metadata)
	if (!result.success) return invalidEnvelope()
	const envelope = { ...result.data, decodedData }
	const bytes = Buffer.byteLength(JSON.stringify(envelope), "utf8")
	if (bytes > MAX_ENVELOPE_BYTES) return invalidEnvelope()
	// Safe projection removed undefined members; Zod's optional types remain wider.
	validatedBytes.set(envelope as DecodeEnvelope, bytes)
	return envelope as DecodeEnvelope
}

function jsonBytes(value: unknown): number {
	return Buffer.byteLength(JSON.stringify(value), "utf8")
}

/** `null`, `"other"`, `null`, `null`, `[]`: the defaults a plain envelope stores. */
const PLAIN_PRESENTATION_BYTES = 4 + 7 + 4 + 4 + 2
/** `,"position":` */
const POSITION_MEMBER_BYTES = 12

/**
 * Bytes a presentation adds to the JSON of a presentation-free envelope (or
 * of any JSON that stores protocol, category, entity key, title, fields and
 * an optional position the same way, such as the Activity row summary).
 */
export function presentationJsonBytes(
	presentation: DecodePresentation,
): number {
	let bytes =
		jsonBytes(presentation.protocol ?? null) +
		jsonBytes(presentation.category ?? "other") +
		jsonBytes(presentation.entityKey ?? null) +
		jsonBytes(presentation.title ?? null) +
		jsonBytes(presentation.fields ?? []) -
		PLAIN_PRESENTATION_BYTES
	if (presentation.position !== undefined)
		bytes += POSITION_MEMBER_BYTES + jsonBytes(presentation.position)
	return bytes
}

function isPlain(envelope: DecodeEnvelope): boolean {
	return (
		envelope.protocol === null &&
		envelope.category === "other" &&
		envelope.entityKey === null &&
		envelope.title === null &&
		envelope.fields.length === 0 &&
		envelope.position === undefined
	)
}

type ParsedPresentation = z.infer<typeof presentationSchema>

interface EnvelopeBase {
	eventId: string
	producedAt: string
	receivedAt: string
	decoderId: string
	decoderType: string | undefined
	outputType: string
	provenance: unknown
	refs: unknown
}

function assemble(
	base: EnvelopeBase,
	display: ParsedPresentation,
	decodedData: JsonValue,
): DecodeEnvelope {
	return complete(
		{
			version: 1,
			eventId: base.eventId,
			producedAt: base.producedAt,
			receivedAt: base.receivedAt,
			decoderId: base.decoderId,
			...(base.decoderType === undefined
				? {}
				: { decoderType: base.decoderType }),
			outputType: base.outputType,
			protocol: display.protocol ?? null,
			category: display.category ?? "other",
			entityKey: display.entityKey ?? null,
			...(display.position === undefined ? {} : { position: display.position }),
			title: display.title ?? null,
			fields: display.fields ?? [],
			provenance: base.provenance,
			...(base.refs === undefined ? {} : { refs: base.refs }),
		},
		decodedData,
	)
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
		delete producer["provenanceBinding"]
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
		if (origin.decoder !== supplied.decoderId) return invalidEnvelope()
		return assemble(
			{
				eventId: supplied.eventId,
				producedAt: origin.timestamp,
				receivedAt: supplied.receivedAt,
				decoderId: supplied.decoderId,
				decoderType: supplied.decoderType,
				outputType: origin.type,
				provenance: supplied.provenance ?? { sourceId: null, frequency: null },
				refs: supplied.refs,
			},
			parsedPresentation.data,
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

/**
 * Adds a presentation to an envelope built by `createDecodeEnvelope` without
 * one. The result equals `createDecodeEnvelope(output, context, presentation)`
 * but skips projecting the producer payload again. Throws like create when the
 * presentation or the grown envelope is rejected.
 */
export function withPresentation(
	envelope: DecodeEnvelope,
	presentation: DecodePresentation,
): DecodeEnvelope {
	try {
		const parsed = presentationSchema.safeParse(
			projectJson(presentation, false, true),
		)
		if (!parsed.success) return invalidEnvelope()
		const display = parsed.data
		const plainBytes = validatedBytes.get(envelope)
		if (plainBytes !== undefined && isPlain(envelope)) {
			// The metadata was validated when the plain envelope was built and the
			// presentation just now; only the size can change. Same member order
			// as `assemble`.
			const bytes =
				plainBytes + presentationJsonBytes(display as DecodePresentation)
			if (bytes > MAX_ENVELOPE_BYTES) return invalidEnvelope()
			const grown = {
				version: envelope.version,
				eventId: envelope.eventId,
				producedAt: envelope.producedAt,
				receivedAt: envelope.receivedAt,
				decoderId: envelope.decoderId,
				...(envelope.decoderType === undefined
					? {}
					: { decoderType: envelope.decoderType }),
				outputType: envelope.outputType,
				protocol: display.protocol ?? null,
				category: display.category ?? "other",
				entityKey: display.entityKey ?? null,
				...(display.position === undefined
					? {}
					: { position: display.position }),
				title: display.title ?? null,
				fields: display.fields ?? [],
				provenance: envelope.provenance,
				...(envelope.refs === undefined ? {} : { refs: envelope.refs }),
				decodedData: envelope.decodedData,
			} as DecodeEnvelope
			validatedBytes.set(grown, bytes)
			return grown
		}
		return assemble(
			{
				eventId: envelope.eventId,
				producedAt: envelope.producedAt,
				receivedAt: envelope.receivedAt,
				decoderId: envelope.decoderId,
				decoderType: envelope.decoderType,
				outputType: envelope.outputType,
				provenance: envelope.provenance,
				refs: envelope.refs,
			},
			display,
			envelope.decodedData,
		)
	} catch {
		return invalidEnvelope()
	}
}
