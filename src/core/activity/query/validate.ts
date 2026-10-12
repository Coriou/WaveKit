import { z } from "zod"
import { sha256Hex, canonicalJson } from "./canonical.js"
import { ActivityQueryInvalidError } from "./errors.js"
import { compileFtsMatch, type FtsLimits } from "./fts.js"
import type {
	ActivityCategory,
	ActivityKind,
	ActivityQuery,
	ActivityRefType,
} from "../storage/contract.js"

const KINDS = [
	"decoder-reception",
	"call-lifecycle",
	"analog-transmission",
	"scanner-result",
	"recording-change",
	"ingestion-gap",
] as const satisfies readonly ActivityKind[]

const CATEGORIES = [
	"aircraft",
	"marine",
	"aviation-data",
	"voice",
	"paging",
	"aprs",
	"sensors",
	"mesh",
	"other",
] as const satisfies readonly ActivityCategory[]

const REF_TYPES = [
	"callId",
	"discoveryId",
	"observationId",
	"jobId",
	"probeId",
	"channelId",
] as const satisfies readonly ActivityRefType[]

const FACET_DIMENSIONS = [
	"category",
	"protocol",
	"decoderId",
	"sourceId",
	"kind",
] as const

export type FacetDimension = (typeof FACET_DIMENSIONS)[number]

export type FtsConstraint =
	| { readonly kind: "none" }
	| { readonly kind: "impossible" }
	| { readonly kind: "match"; readonly match: string }

/** Filter form passed to the reader. JSON-safe: null instead of undefined. */
export interface NormalisedQuery {
	kinds: ActivityKind[]
	sourceIds: string[]
	decoderIds: string[]
	protocols: string[]
	categories: ActivityCategory[]
	frequencyMin: number | null
	frequencyMax: number | null
	producedFromMs: number | null
	producedToMs: number | null
	refs: { type: ActivityRefType; value: string }[]
	entityKey: string | null
	fts: FtsConstraint
}

export interface QueryLimits extends FtsLimits {
	filterTerms: number
	pageDefault: number
	pageMax: number
	facetDimensions: number
}

const idSchema = z.string().min(1).max(256)
const querySchema = z
	.object({
		kinds: z.array(z.enum(KINDS)).max(64).optional(),
		sourceIds: z.array(idSchema).max(64).optional(),
		decoderIds: z.array(idSchema).max(64).optional(),
		protocols: z.array(idSchema).max(64).optional(),
		categories: z.array(z.enum(CATEGORIES)).max(64).optional(),
		frequencyHz: z
			.object({
				min: z.number().finite().nonnegative().optional(),
				max: z.number().finite().nonnegative().optional(),
			})
			.strict()
			.optional(),
		producedAt: z
			.object({
				from: z.string().min(1).max(40).optional(),
				to: z.string().min(1).max(40).optional(),
			})
			.strict()
			.optional(),
		refs: z
			.array(
				z
					.object({
						type: z.enum(REF_TYPES),
						value: idSchema,
					})
					.strict(),
			)
			.max(64)
			.optional(),
		entityKey: idSchema.optional(),
		text: z.string().optional(),
	})
	.strict()

function uniqueSorted(values: readonly string[]): string[] {
	return [...new Set(values)].sort((left, right) =>
		left < right ? -1 : left > right ? 1 : 0,
	)
}

function parseTime(value: string, label: string): number {
	const parsed = Date.parse(value)
	if (!Number.isFinite(parsed)) {
		throw new ActivityQueryInvalidError(`${label} is not a timestamp`)
	}
	return parsed
}

function integerHz(value: number, label: string): number {
	if (!Number.isSafeInteger(value)) {
		throw new ActivityQueryInvalidError(`${label} must be an integer hertz`)
	}
	return value
}

function invalid(error: z.ZodError): ActivityQueryInvalidError {
	const issue = error.issues[0]
	const path = issue && issue.path.length > 0 ? issue.path.join(".") : "query"
	const message = issue ? issue.message : "Invalid activity query"
	return new ActivityQueryInvalidError(`${path}: ${message}`)
}

export function normaliseQuery(
	input: ActivityQuery | unknown,
	limits: QueryLimits,
): NormalisedQuery {
	const parsed = querySchema.safeParse(input ?? {})
	if (!parsed.success) throw invalid(parsed.error)
	const raw = parsed.data
	const frequencyMin =
		raw.frequencyHz?.min === undefined ? null : integerHz(raw.frequencyHz.min, "frequencyHz.min")
	const frequencyMax =
		raw.frequencyHz?.max === undefined ? null : integerHz(raw.frequencyHz.max, "frequencyHz.max")
	if (
		frequencyMin !== null &&
		frequencyMax !== null &&
		frequencyMin > frequencyMax
	) {
		throw new ActivityQueryInvalidError(
			"frequencyHz.min must not exceed frequencyHz.max",
		)
	}
	const producedFromMs =
		raw.producedAt?.from === undefined
			? null
			: parseTime(raw.producedAt.from, "producedAt.from")
	const producedToMs =
		raw.producedAt?.to === undefined
			? null
			: parseTime(raw.producedAt.to, "producedAt.to")
	if (
		producedFromMs !== null &&
		producedToMs !== null &&
		producedFromMs > producedToMs
	) {
		throw new ActivityQueryInvalidError(
			"producedAt.from must not exceed producedAt.to",
		)
	}
	let fts: FtsConstraint = { kind: "none" }
	if (raw.text !== undefined) {
		const match = compileFtsMatch(raw.text, limits)
		// No letters or numbers (whitespace, punctuation) is not a filter.
		if (match !== null) fts = { kind: "match", match }
	}
	const query: NormalisedQuery = {
		kinds: uniqueSorted(raw.kinds ?? []) as ActivityKind[],
		sourceIds: uniqueSorted(raw.sourceIds ?? []),
		decoderIds: uniqueSorted(raw.decoderIds ?? []),
		protocols: uniqueSorted(raw.protocols ?? []),
		categories: uniqueSorted(raw.categories ?? []) as ActivityCategory[],
		frequencyMin,
		frequencyMax,
		producedFromMs,
		producedToMs,
		refs: [...(raw.refs ?? [])]
			.map(ref => ({ type: ref.type, value: ref.value }))
			.sort((left, right) => {
				if (left.type !== right.type) return left.type < right.type ? -1 : 1
				return left.value < right.value ? -1 : left.value > right.value ? 1 : 0
			}),
		entityKey: raw.entityKey ?? null,
		fts,
	}
	const terms = countTerms(query)
	if (terms > limits.filterTerms) {
		throw new ActivityQueryInvalidError(
			`Activity query has more than ${limits.filterTerms} filter terms`,
		)
	}
	return query
}

export function countTerms(query: NormalisedQuery): number {
	let terms =
		query.kinds.length +
		query.sourceIds.length +
		query.decoderIds.length +
		query.protocols.length +
		query.categories.length +
		query.refs.length
	if (query.frequencyMin !== null) terms += 1
	if (query.frequencyMax !== null) terms += 1
	if (query.producedFromMs !== null) terms += 1
	if (query.producedToMs !== null) terms += 1
	if (query.entityKey !== null) terms += 1
	if (query.fts.kind !== "none") terms += 1
	return terms
}

/** SHA-256 of the canonical sorted query. Order and paging are not part of the hash. */
export function hashQuery(query: NormalisedQuery): string {
	const producedAt: Record<string, string> = {}
	if (query.producedFromMs !== null) {
		producedAt["from"] = new Date(query.producedFromMs).toISOString()
	}
	if (query.producedToMs !== null) {
		producedAt["to"] = new Date(query.producedToMs).toISOString()
	}
	const body: Record<string, unknown> = {}
	if (query.kinds.length > 0) body["kinds"] = query.kinds
	if (query.sourceIds.length > 0) body["sourceIds"] = query.sourceIds
	if (query.decoderIds.length > 0) body["decoderIds"] = query.decoderIds
	if (query.protocols.length > 0) body["protocols"] = query.protocols
	if (query.categories.length > 0) body["categories"] = query.categories
	if (query.frequencyMin !== null || query.frequencyMax !== null) {
		const frequency: Record<string, number> = {}
		if (query.frequencyMin !== null) frequency["min"] = query.frequencyMin
		if (query.frequencyMax !== null) frequency["max"] = query.frequencyMax
		body["frequencyHz"] = frequency
	}
	if (Object.keys(producedAt).length > 0) body["producedAt"] = producedAt
	if (query.refs.length > 0) body["refs"] = query.refs
	if (query.entityKey !== null) body["entityKey"] = query.entityKey
	if (query.fts.kind === "match") body["text"] = query.fts.match
	else if (query.fts.kind === "impossible") body["text"] = ""
	return sha256Hex(canonicalJson(body))
}

const dimensionSchema = z.enum(FACET_DIMENSIONS)

export function parseDimensions(
	input: unknown,
	maxDimensions: number,
): FacetDimension[] {
	const parsed = z.array(dimensionSchema).safeParse(input)
	if (!parsed.success) {
		throw new ActivityQueryInvalidError(
			"dimensions must list category, protocol, decoderId, sourceId, or kind",
		)
	}
	if (parsed.data.length === 0) {
		throw new ActivityQueryInvalidError("dimensions must not be empty")
	}
	if (parsed.data.length > maxDimensions) {
		throw new ActivityQueryInvalidError(
			`At most ${maxDimensions} facet dimensions are allowed`,
		)
	}
	if (new Set(parsed.data).size !== parsed.data.length) {
		throw new ActivityQueryInvalidError("dimensions must be unique")
	}
	return parsed.data
}

export function parseLimit(
	input: number | undefined,
	defaults: { pageDefault: number; pageMax: number },
): number {
	if (input === undefined) return Math.min(defaults.pageDefault, defaults.pageMax)
	if (!Number.isSafeInteger(input) || input < 1 || input > defaults.pageMax) {
		throw new ActivityQueryInvalidError(
			`limit must be an integer from 1 to ${defaults.pageMax}`,
		)
	}
	return input
}

export function parseOrder(input: unknown): "asc" | "desc" {
	if (input === undefined) return "desc"
	if (input === "asc" || input === "desc") return input
	throw new ActivityQueryInvalidError("order must be asc or desc")
}
