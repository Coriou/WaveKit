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
	DecodeAircraftIdentity,
	DecodeCoalesced,
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
const coalescedSchema = z
	.object({
		// 1: a row flushed for one held reception (stamped when stored).
		receptions: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
		firstSeenAt: timestamp,
		lastSeenAt: timestamp,
	})
	.strict()
export const AIRCRAFT_IDENTITY_MAX_BYTES = 64
const identityText = text(AIRCRAFT_IDENTITY_MAX_BYTES)
const aircraftSchema = z
	.object({
		callsign: identityText.optional(),
		registration: identityText.optional(),
		typeCode: identityText.optional(),
		typeDescription: identityText.optional(),
		operator: identityText.optional(),
	})
	.strict()
	.refine(identity => Object.keys(identity).length > 0)
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
		coalesced: coalescedSchema.optional(),
		aircraft: aircraftSchema.optional(),
	})
	.strict()

/**
 * A plain valid Date in years 0 to 9999 prints the 24 characters `timestamp` asks for and parses
 * back to itself. Any other year prints a sign and six digits, and a subclass, an own property or
 * an invalid time gets null, so the Zod path decides those.
 */
function plainDateIso(value: object): string | null {
	if (
		Object.getPrototypeOf(value) !== Date.prototype ||
		Reflect.ownKeys(value).length !== 0
	)
		return null
	if (!Number.isFinite(Date.prototype.getTime.call(value))) return null
	const iso = Date.prototype.toISOString.call(value)
	return iso.length === 24 ? iso : null
}

function dateIso(value: unknown): string {
	if (
		value === null ||
		typeof value !== "object" ||
		types.isProxy(value) ||
		!types.isDate(value)
	)
		return invalidEnvelope()
	const iso = plainDateIso(value)
	if (iso !== null) return iso
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
	return finish(result.data, decodedData)
}

/** The size check and bookkeeping for metadata that has passed the schema or its guards. */
function finish(metadata: object, decodedData: JsonValue): DecodeEnvelope {
	const envelope = { ...metadata, decodedData }
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
	coalesced?: unknown
	aircraft?: unknown
}

/** Member order is the metadata schema's, so the stored JSON does not depend on the path taken. */
function metadataFrom(
	base: EnvelopeBase,
	display: ParsedPresentation,
): Record<string, unknown> {
	return {
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
		...(base.coalesced === undefined ? {} : { coalesced: base.coalesced }),
		...(base.aircraft === undefined ? {} : { aircraft: base.aircraft }),
	}
}

function assemble(
	base: EnvelopeBase,
	display: ParsedPresentation,
	decodedData: JsonValue,
): DecodeEnvelope {
	return complete(metadataFrom(base, display), decodedData)
}

/*
 * Structural guards for the metadata the core builds per decoder output. Each one either returns
 * what the Zod schema of the same name would return, members in the schema's order, or undefined,
 * and undefined sends the input to Zod. So a guard can only save the parse: it never accepts what
 * the schemas refuse (tests/unit/core/activity/envelope-guard.test.ts). Inputs a guard leaves to Zod:
 * anything but data properties on plain objects and arrays, undefined members below the top level,
 * unknown members and -0, which `projectJson` rewrites to 0.
 */
const CONTROL_CHARACTERS = /[\x00-\x1f\x7f-\x9f]/
const ENTITY_KEY = /^[a-z][a-z0-9-]*:[^:]+$/
const CATEGORIES: ReadonlySet<unknown> = new Set([
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
const FREQUENCY_BASES: ReadonlySet<unknown> = new Set(["channel", "probe"])
const TUNING_TRUSTS: ReadonlySet<unknown> = new Set([
	"commanded",
	"relay",
	"unverified",
])

/** UTF-16 needs at most 3 UTF-8 bytes per code unit, so a short string skips the byte count. */
function isText(value: unknown, max: number): value is string {
	return (
		typeof value === "string" &&
		value.length >= 1 &&
		(value.length * 3 <= max || Buffer.byteLength(value, "utf8") <= max) &&
		!CONTROL_CHARACTERS.test(value)
	)
}

function isFiniteNumber(value: unknown): value is number {
	return (
		typeof value === "number" && Number.isFinite(value) && !Object.is(value, -0)
	)
}

/** The members of a plain object of data properties, or null; `allowed` is its strict shape. */
function plainMembers(
	value: unknown,
	allowed: ReadonlySet<string>,
): Record<string, unknown> | null {
	if (value === null || typeof value !== "object" || types.isProxy(value))
		return null
	const prototype: unknown = Object.getPrototypeOf(value)
	if (prototype !== Object.prototype && prototype !== null) return null
	const members = value as Record<string, unknown>
	for (const key of Reflect.ownKeys(value)) {
		if (typeof key !== "string" || !allowed.has(key)) return null
		const descriptor = Object.getOwnPropertyDescriptor(value, key)
		if (
			descriptor === undefined ||
			!descriptor.enumerable ||
			!("value" in descriptor) ||
			descriptor.value === undefined
		)
			return null
	}
	return members
}

const PROVENANCE_KEYS: ReadonlySet<string> = new Set([
	"sourceId",
	"frequency",
	"jobId",
	"probeId",
	"channelId",
])
const FREQUENCY_KEYS: ReadonlySet<string> = new Set([
	"hz",
	"basis",
	"tuningTrust",
])

function guardProvenance(value: unknown): object | undefined {
	const p = plainMembers(value, PROVENANCE_KEYS)
	if (p === null) return undefined
	const sourceId = p["sourceId"]
	if (sourceId !== null && !isText(sourceId, 128)) return undefined
	let frequency: object | null = null
	if (p["frequency"] !== null) {
		const f = plainMembers(p["frequency"], FREQUENCY_KEYS)
		if (
			f === null ||
			!isFiniteNumber(f["hz"]) ||
			f["hz"] <= 0 ||
			f["hz"] > Number.MAX_SAFE_INTEGER ||
			!FREQUENCY_BASES.has(f["basis"]) ||
			!TUNING_TRUSTS.has(f["tuningTrust"])
		)
			return undefined
		frequency = {
			hz: f["hz"],
			basis: f["basis"],
			tuningTrust: f["tuningTrust"],
		}
	}
	const jobId = p["jobId"]
	const probeId = p["probeId"]
	const channelId = p["channelId"]
	if (
		(jobId !== undefined && !isText(jobId, 128)) ||
		(probeId !== undefined && !isText(probeId, 128)) ||
		(channelId !== undefined && !isText(channelId, 128))
	)
		return undefined
	return {
		sourceId,
		frequency,
		...(jobId === undefined ? {} : { jobId }),
		...(probeId === undefined ? {} : { probeId }),
		...(channelId === undefined ? {} : { channelId }),
	}
}

const REFS_KEYS: ReadonlySet<string> = new Set([
	"callId",
	"discoveryId",
	"observationId",
])

function guardRefs(value: unknown): object | undefined {
	const r = plainMembers(value, REFS_KEYS)
	if (r === null) return undefined
	const callId = r["callId"]
	const discoveryId = r["discoveryId"]
	const observationId = r["observationId"]
	if (
		(callId !== undefined && !isText(callId, 128)) ||
		(discoveryId !== undefined && !isText(discoveryId, 128)) ||
		(observationId !== undefined && !isText(observationId, 128))
	)
		return undefined
	return {
		...(callId === undefined ? {} : { callId }),
		...(discoveryId === undefined ? {} : { discoveryId }),
		...(observationId === undefined ? {} : { observationId }),
	}
}

const FIELD_KEYS: ReadonlySet<string> = new Set([
	"key",
	"label",
	"value",
	"unit",
])
/** `fieldsSchema`'s member limit. */
const FIELDS_MAX = 64
const FIELD_STRING_BYTES = 32768

function guardFields(value: unknown): object[] | undefined {
	if (!Array.isArray(value) || types.isProxy(value)) return undefined
	if (
		Object.getPrototypeOf(value) !== Array.prototype ||
		value.length > FIELDS_MAX ||
		Reflect.ownKeys(value).length !== value.length + 1
	)
		return undefined
	const out: object[] = []
	const seen = new Set<string>()
	// By descriptor and index: an element may be an accessor, and with a hole the key count above still
	// matches one extra member, which may be an own Symbol.iterator. At most `FIELDS_MAX` lookups.
	for (let i = 0; i < value.length; i++) {
		const element = Object.getOwnPropertyDescriptor(value, i)
		if (element === undefined || !element.enumerable || !("value" in element))
			return undefined
		const f = plainMembers(element.value, FIELD_KEYS)
		if (f === null) return undefined
		const key = f["key"]
		const label = f["label"]
		const v = f["value"]
		const unit = f["unit"]
		if (!isText(key, 128) || !isText(label, 128) || seen.has(key))
			return undefined
		seen.add(key)
		if (typeof v === "string") {
			if (
				(v.length * 3 > FIELD_STRING_BYTES &&
					Buffer.byteLength(v, "utf8") > FIELD_STRING_BYTES) ||
				CONTROL_CHARACTERS.test(v)
			)
				return undefined
		} else if (v !== null && typeof v !== "boolean" && !isFiniteNumber(v))
			return undefined
		if (unit !== undefined && !isText(unit, 32)) return undefined
		out.push({
			key,
			label,
			value: v,
			...(unit === undefined ? {} : { unit }),
		})
	}
	return out
}

const POSITION_KEYS: ReadonlySet<string> = new Set(["lat", "lon", "altM"])

function guardPosition(value: unknown): object | undefined {
	const p = plainMembers(value, POSITION_KEYS)
	if (p === null) return undefined
	const lat = p["lat"]
	const lon = p["lon"]
	const altM = p["altM"]
	if (
		!isFiniteNumber(lat) ||
		lat < -90 ||
		lat > 90 ||
		!isFiniteNumber(lon) ||
		lon < -180 ||
		lon > 180 ||
		(altM !== undefined && !isFiniteNumber(altM))
	)
		return undefined
	return { lat, lon, ...(altM === undefined ? {} : { altM }) }
}

const PRESENTATION_KEYS: ReadonlySet<string> = new Set([
	"entityKey",
	"position",
	"protocol",
	"category",
	"title",
	"fields",
])

/** `presentationSchema`, or undefined to ask it. */
export function guardPresentation(
	value: unknown,
): ParsedPresentation | undefined {
	const p = plainMembers(value, PRESENTATION_KEYS)
	if (p === null) return undefined
	const entityKey = p["entityKey"]
	if (
		entityKey !== undefined &&
		entityKey !== null &&
		!(isText(entityKey, 128) && ENTITY_KEY.test(entityKey))
	)
		return undefined
	const protocol = p["protocol"]
	if (protocol !== undefined && protocol !== null && !isText(protocol, 64))
		return undefined
	const category = p["category"]
	if (category !== undefined && !CATEGORIES.has(category)) return undefined
	const title = p["title"]
	if (title !== undefined && title !== null && !isText(title, 256))
		return undefined
	const position =
		p["position"] === undefined ? undefined : guardPosition(p["position"])
	if (p["position"] !== undefined && position === undefined) return undefined
	const fields =
		p["fields"] === undefined ? undefined : guardFields(p["fields"])
	if (p["fields"] !== undefined && fields === undefined) return undefined
	return {
		...(entityKey === undefined ? {} : { entityKey }),
		...(position === undefined ? {} : { position }),
		...(protocol === undefined ? {} : { protocol }),
		...(category === undefined ? {} : { category }),
		...(title === undefined ? {} : { title }),
		...(fields === undefined ? {} : { fields }),
	} as ParsedPresentation
}

/**
 * `createDecodeEnvelope` without a parse: every member the metadata schema reads has passed a guard
 * above or `dateIso` (the size check still runs). Undefined leaves the call to the schemas. Top-level
 * undefined members count as absent, as they do after `projectJson`.
 */
function guardedEnvelope(
	producer: Record<string, unknown>,
	context: Record<string, unknown>,
	presentation: unknown,
	decodedData: JsonValue,
): DecodeEnvelope | undefined {
	for (const key of Object.keys(producer))
		if (
			producer[key] !== undefined &&
			key !== "timestamp" &&
			key !== "decoder" &&
			key !== "type"
		)
			return undefined
	const decoder = producer["decoder"]
	const outputType = producer["type"]
	if (!isText(decoder, 128) || !isText(outputType, 64)) return undefined
	for (const key of Object.keys(context))
		if (
			context[key] !== undefined &&
			key !== "eventId" &&
			key !== "receivedAt" &&
			key !== "decoderId" &&
			key !== "decoderType" &&
			key !== "provenance" &&
			key !== "refs"
		)
			return undefined
	const eventId = context["eventId"]
	const decoderType = context["decoderType"]
	if (
		!isText(eventId, 128) ||
		context["decoderId"] !== decoder ||
		(decoderType !== undefined && !isText(decoderType, 128))
	)
		return undefined
	const provenance =
		context["provenance"] === undefined
			? { sourceId: null, frequency: null }
			: guardProvenance(context["provenance"])
	const refs =
		context["refs"] === undefined ? undefined : guardRefs(context["refs"])
	if (provenance === undefined) return undefined
	if (context["refs"] !== undefined && refs === undefined) return undefined
	const display =
		presentation === undefined ? {} : guardPresentation(presentation)
	if (display === undefined) return undefined
	return finish(
		metadataFrom(
			{
				eventId,
				producedAt: producer["timestamp"] as string,
				receivedAt: context["receivedAt"] as string,
				decoderId: decoder,
				decoderType,
				outputType,
				provenance,
				refs,
			},
			display,
		),
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
		const guarded = guardedEnvelope(
			producer,
			metadata,
			presentation,
			decodedData,
		)
		if (guarded !== undefined) return guarded
		return parsedEnvelope(producer, metadata, presentation, decodedData)
	} catch {
		return invalidEnvelope()
	}
}

/** Every input the guards leave undecided, and the reference they are tested against. */
function parsedEnvelope(
	producer: Record<string, unknown>,
	metadata: Record<string, unknown>,
	presentation: DecodePresentation | undefined,
	decodedData: JsonValue,
): DecodeEnvelope {
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
		let display = guardPresentation(presentation)
		if (display === undefined) {
			const parsed = presentationSchema.safeParse(
				projectJson(presentation, false, true),
			)
			if (!parsed.success) return invalidEnvelope()
			display = parsed.data
		}
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
				...(envelope.coalesced === undefined
					? {}
					: { coalesced: envelope.coalesced }),
				...(envelope.aircraft === undefined
					? {}
					: { aircraft: envelope.aircraft }),
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
				coalesced: envelope.coalesced,
				aircraft: envelope.aircraft,
			},
			display,
			envelope.decodedData,
		)
	} catch {
		return invalidEnvelope()
	}
}

/**
 * The envelope with its decodedData replaced by an entity's merged latest state
 * (storage/coalesce.ts) and, when several receptions were merged, their
 * `coalesced` count and span. Keeps the presentation it had; validates the
 * metadata and the size like create. Throws like create when rejected.
 */
export function withMergedData(
	envelope: DecodeEnvelope,
	decodedData: JsonValue,
	coalesced: DecodeCoalesced | undefined,
): DecodeEnvelope {
	try {
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
				coalesced,
				aircraft: envelope.aircraft,
			},
			{
				protocol: envelope.protocol,
				category: envelope.category,
				entityKey: envelope.entityKey,
				...(envelope.position === undefined
					? {}
					: { position: envelope.position }),
				title: envelope.title,
				fields: [...envelope.fields],
			},
			projectJson(decodedData, false, false),
		)
	} catch {
		return invalidEnvelope()
	}
}

/**
 * The envelope with new clocks (a flushed entity row, stamped when stored)
 * or aircraft identity; everything else, decodedData included, as it
 * was. Validates the metadata and the size like create; throws when rejected.
 */
export function withEnvelopeMetadata(
	envelope: DecodeEnvelope,
	patch: {
		producedAt?: string
		receivedAt?: string
		aircraft?: DecodeAircraftIdentity
	},
): DecodeEnvelope {
	try {
		return complete(
			{
				...metadataOf(envelope),
				...(patch.producedAt === undefined
					? {}
					: { producedAt: patch.producedAt }),
				...(patch.receivedAt === undefined
					? {}
					: { receivedAt: patch.receivedAt }),
				...(patch.aircraft === undefined ? {} : { aircraft: patch.aircraft }),
			},
			envelope.decodedData,
		)
	} catch {
		return invalidEnvelope()
	}
}

function metadataOf(envelope: DecodeEnvelope): Record<string, unknown> {
	const { decodedData: _data, ...metadata } = envelope
	return metadata
}

/** Test seam: `createDecodeEnvelope` by the schemas alone, the reference for the guards. */
export function createDecodeEnvelopeBySchema(
	output: DecoderOutput,
	context: DecodeEnvelopeContext,
	presentation?: DecodePresentation,
): DecodeEnvelope {
	try {
		const producer = ownRecord(output)
		const metadata = ownRecord(context)
		producer["timestamp"] = dateIso(producer["timestamp"])
		metadata["receivedAt"] = dateIso(metadata["receivedAt"])
		const decodedData = projectDecodedData(producer["data"])
		delete producer["data"]
		delete producer["provenanceBinding"]
		return parsedEnvelope(producer, metadata, presentation, decodedData)
	} catch {
		return invalidEnvelope()
	}
}

/** Test seam: the schema `guardPresentation` must agree with. */
export const presentationSchemaForTests = presentationSchema
