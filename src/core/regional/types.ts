import { createHash } from "node:crypto"
import { types as utilTypes } from "node:util"
import { z } from "zod"
import { WaveKitError } from "../../utils/errors.js"

export const REGIONAL_LIMITS = Object.freeze({
	rows: 128,
	aliases: 8,
	sources: 8,
	citations: 4,
	collisions: 32,
	datasetBytes: 128 * 1024,
	registrationBytes: 512 * 1024,
	responseBytes: 128 * 1024,
})
export const RegionSchema = z.enum(["EU", "US", "CA", "AU", "NZ", "JP", "CN"])
export type RegionCode = z.infer<typeof RegionSchema>
export const IdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/)
export const VersionSchema = z.string().regex(/^[a-z0-9][a-z0-9.-]{0,31}$/)
const DigestSchema = z.string().regex(/^[0-9a-f]{64}$/)

export function regionalUnavailable(): never {
	throw new WaveKitError(
		"Regional registry is unavailable",
		"REGIONAL_UNAVAILABLE",
	)
}
export function regionalInvalidRequest(): never {
	throw new WaveKitError(
		"Invalid regional registry request",
		"REGIONAL_INVALID_REQUEST",
	)
}
function scalarText(value: string): boolean {
	return !/[\p{Cc}\p{Cs}]/u.test(value)
}
const text = (scalars: number, bytes: number) =>
	z
		.string()
		.refine(
			value =>
				scalarText(value) &&
				[...value].length >= 1 &&
				[...value].length <= scalars &&
				Buffer.byteLength(value, "utf8") <= bytes,
		)
const ascii = (max: number) =>
	z
		.string()
		.min(1)
		.max(max)
		.regex(/^[\x20-\x7e]+$/)
const integer = (min: number, max: number) =>
	z
		.number()
		.int()
		.min(min)
		.max(max)
		.refine(value => Number.isSafeInteger(value) && !Object.is(value, -0))
const DateSchema = z
	.string()
	.regex(/^\d{4}-\d{2}-\d{2}$/)
	.refine(value => {
		const date = new Date(`${value}T00:00:00.000Z`)
		return (
			Number.isFinite(date.getTime()) &&
			date.toISOString().slice(0, 10) === value
		)
	})
const UrlSchema = ascii(512).refine(value => {
	try {
		const url = new URL(value)
		return (
			/^https:\/\//i.test(value) &&
			!value.includes(" ") &&
			url.protocol === "https:" &&
			url.hostname !== "" &&
			url.username === "" &&
			url.password === "" &&
			!value.includes("#")
		)
	} catch {
		return false
	}
})
export function normalizeAlias(value: string): string {
	if (typeof value !== "string" || !/^[\x20-\x7e]{1,32}$/.test(value))
		regionalInvalidRequest()
	const alias = value
		.replace(/^ +| +$/g, "")
		.replace(/ +/g, " ")
		.replace(/[A-Z]/g, character => character.toLowerCase())
	if (alias.length === 0) regionalInvalidRequest()
	return alias
}
const AliasSchema = ascii(32).refine(
	value =>
		value.trim() !== "" &&
		value ===
			value
				.replace(/^ +| +$/g, "")
				.replace(/ +/g, " ")
				.toLowerCase(),
)
export const ApplicabilitySchema = z
	.object({ kind: z.literal("national"), countryCode: z.literal("US") })
	.strict()
export const CoarseContextSchema = z
	.object({
		code: RegionSchema,
		source: z.enum([
			"configured",
			"decoder",
			"guessed:tz",
			"guessed:intl-timezone",
			"guessed:locale-env",
			"guessed:intl-locale",
			"default",
		]),
	})
	.strict()
export type CoarseContext = z.infer<typeof CoarseContextSchema>
export const FrequencySchema = z.discriminatedUnion("kind", [
	z
		.object({
			kind: z.literal("simplex"),
			frequencyHz: integer(1, 1_000_000_000_000),
		})
		.strict(),
	z
		.object({
			kind: z.literal("duplex"),
			stationReceiveHz: integer(1, 1_000_000_000_000),
			stationTransmitHz: integer(1, 1_000_000_000_000),
			endpoint: z.enum(["subscriber", "base"]),
		})
		.strict(),
])
export const SourceReferenceSchema = z
	.object({
		id: IdSchema,
		organization: text(120, 480),
		documentId: ascii(80),
		title: text(120, 480),
		edition: ascii(80),
		publishedDate: DateSchema.nullable(),
		retrievedDate: DateSchema,
		url: UrlSchema,
		documentSha256: DigestSchema,
		applicability: z.literal("US"),
		redistribution: z.literal("facts-transcribed"),
		locator: text(120, 480),
	})
	.strict()
export const RowSchema = z
	.object({
		id: IdSchema.refine(value => /^us-frs-[a-z0-9-]+$/.test(value)),
		displayLabel: text(80, 320),
		aliases: z.array(AliasSchema).max(8),
		frequency: FrequencySchema,
		display: z
			.object({
				advisory: z.literal(true),
				mode: z.enum(["nfm", "fm", "am", "digital", "unknown"]).nullable(),
				bandwidthHz: integer(1, 10_000_000).nullable(),
				stepHz: integer(1, 10_000_000).nullable(),
			})
			.strict(),
		sourceReferenceIds: z.array(IdSchema).min(1).max(4),
	})
	.strict()
export const DatasetSchema = z
	.object({
		schemaVersion: z.literal(1),
		datasetId: z.literal("us-frs"),
		datasetVersion: VersionSchema,
		dataContentSha256: DigestSchema,
		familyId: z.literal("frs"),
		applicability: ApplicabilitySchema,
		verifiedAsOf: DateSchema,
		sourceReferences: z.array(SourceReferenceSchema).min(1).max(8),
		rows: z.array(RowSchema).max(128),
	})
	.strict()
export const CollisionSchema = z
	.object({
		alias: AliasSchema,
		candidateIds: z.array(IdSchema).min(2).max(128),
	})
	.strict()
export const StoredDatasetSchema = z
	.object({
		publication: DatasetSchema,
		collisions: z.array(CollisionSchema).max(32),
	})
	.strict()
const manifestCommon = {
	familyId: z.literal("frs"),
	displayLabel: text(80, 320),
	applicability: ApplicabilitySchema,
}
export const UnavailableManifestSchema = z
	.object({
		...manifestCommon,
		state: z.literal("unavailable"),
		datasetVersion: z.null(),
		reason: z.literal("evidence-pending"),
	})
	.strict()
export const VerifiedManifestSchema = z
	.object({
		...manifestCommon,
		state: z.literal("verified"),
		datasetVersion: VersionSchema,
		reason: z.null(),
	})
	.strict()
export const RegistrationSchema = z
	.object({
		schemaVersion: z.literal(1),
		registrations: z
			.array(
				z.union([
					z
						.object({ manifest: UnavailableManifestSchema, dataset: z.null() })
						.strict(),
					z
						.object({
							manifest: VerifiedManifestSchema,
							dataset: StoredDatasetSchema,
						})
						.strict(),
				]),
			)
			.length(1),
		coarseContext: CoarseContextSchema.nullable(),
	})
	.strict()
export type Dataset = z.infer<typeof DatasetSchema>
export type StoredDataset = z.infer<typeof StoredDatasetSchema>
export type Registration = z.infer<typeof RegistrationSchema>
export type ChannelRow = z.infer<typeof RowSchema>
export type CollisionDeclaration = z.infer<typeof CollisionSchema>

/** Finite JSON only: descriptors are inspected without invoking accessors. */
export function canonicalJson(value: unknown): string {
	const active = new Set<object>()
	const parts: string[] = []
	let bytes = 0
	function emit(fragment: string): void {
		bytes += Buffer.byteLength(fragment, "utf8")
		if (bytes > REGIONAL_LIMITS.registrationBytes) regionalUnavailable()
		parts.push(fragment)
	}
	function encode(item: unknown): void {
		if (item === null) {
			emit("null")
			return
		}
		if (typeof item === "boolean") {
			emit(item ? "true" : "false")
			return
		}
		if (typeof item === "number") {
			if (!Number.isSafeInteger(item) || item < 0 || Object.is(item, -0))
				regionalUnavailable()
			emit(String(item))
			return
		}
		if (typeof item === "string") {
			if (
				!scalarText(item) ||
				Buffer.byteLength(item, "utf8") > REGIONAL_LIMITS.registrationBytes
			)
				regionalUnavailable()
			emit(`"${item.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`)
			return
		}
		if (typeof item !== "object" || utilTypes.isProxy(item) || active.has(item))
			regionalUnavailable()
		if (
			!Array.isArray(item) &&
			Object.getPrototypeOf(item) !== Object.prototype &&
			Object.getPrototypeOf(item) !== null
		)
			regionalUnavailable()
		active.add(item)
		if (Array.isArray(item)) {
			if (item.length > REGIONAL_LIMITS.registrationBytes) regionalUnavailable()
			const descriptors = Object.getOwnPropertyDescriptors(item)
			if (Reflect.ownKeys(descriptors).length !== item.length + 1)
				regionalUnavailable()
			emit("[")
			for (let index = 0; index < item.length; index++) {
				const descriptor = descriptors[String(index)]
				if (!descriptor || !("value" in descriptor)) regionalUnavailable()
				if (index > 0) emit(",")
				encode(descriptor.value)
			}
			emit("]")
		} else {
			const keys = Reflect.ownKeys(item)
			if (
				keys.length > REGIONAL_LIMITS.registrationBytes ||
				keys.some(key => typeof key !== "string" || !/^[\x20-\x7e]+$/.test(key))
			)
				regionalUnavailable()
			emit("{")
			let index = 0
			for (const key of (keys as string[]).sort()) {
				const descriptor = Object.getOwnPropertyDescriptor(item, key)
				if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
					regionalUnavailable()
				if (index++ > 0) emit(",")
				encode(key)
				emit(":")
				encode(descriptor.value)
			}
			emit("}")
		}
		active.delete(item)
	}
	try {
		encode(value)
		return parts.join("")
	} catch {
		return regionalUnavailable()
	}
}
export function canonicalBytes(
	value: unknown,
	limit = REGIONAL_LIMITS.registrationBytes,
): Buffer {
	if (
		!Number.isSafeInteger(limit) ||
		limit < 0 ||
		limit > REGIONAL_LIMITS.registrationBytes
	)
		regionalUnavailable()
	const bytes = Buffer.from(canonicalJson(value), "utf8")
	if (bytes.length > limit) regionalUnavailable()
	return bytes
}
export function deepFreeze<T>(value: T): T {
	if (value !== null && typeof value === "object") {
		for (const nested of Object.values(value)) deepFreeze(nested)
		Object.freeze(value)
	}
	return value
}
export function detachedFrozen<T>(value: T): T {
	return deepFreeze(JSON.parse(canonicalJson(value)) as T)
}
function unique(values: readonly string[]): void {
	if (new Set(values).size !== values.length) regionalUnavailable()
}
function compareId(a: { id: string }, b: { id: string }): number {
	return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}
export function normalizeStoredDataset(input: unknown): StoredDataset {
	// Reject accessors, non-JSON values and excessive raw storage before Zod reads.
	const safe: unknown = JSON.parse(canonicalBytes(input).toString("utf8"))
	const parsed = StoredDatasetSchema.safeParse(safe)
	if (!parsed.success) regionalUnavailable()
	const stored = parsed.data
	const { publication, collisions } = stored
	unique(publication.rows.map(row => row.id))
	unique(publication.sourceReferences.map(source => source.id))
	unique(collisions.map(collision => collision.alias))
	const sources = new Set(publication.sourceReferences.map(source => source.id))
	const used = new Set<string>()
	const matches = new Map<string, string[]>()
	for (const row of publication.rows) {
		if (row.frequency.kind !== "simplex") regionalUnavailable()
		unique(row.aliases)
		unique(row.sourceReferenceIds)
		for (const citation of row.sourceReferenceIds) {
			if (!sources.has(citation)) regionalUnavailable()
			used.add(citation)
		}
		row.aliases.sort()
		row.sourceReferenceIds.sort()
		for (const alias of row.aliases) {
			const ids = matches.get(alias) ?? []
			ids.push(row.id)
			matches.set(alias, ids)
		}
	}
	if (publication.rows.length > 0 && used.size !== sources.size)
		regionalUnavailable()
	for (const collision of collisions) {
		unique(collision.candidateIds)
		const ids = matches.get(collision.alias)
		collision.candidateIds.sort()
		if (
			!ids ||
			ids.length < 2 ||
			ids.sort().join(",") !== collision.candidateIds.join(",")
		)
			regionalUnavailable()
	}
	for (const [alias, ids] of matches) {
		if (
			ids.length > 1 &&
			!collisions.some(collision => collision.alias === alias)
		)
			regionalUnavailable()
	}
	publication.rows.sort(compareId)
	publication.sourceReferences.sort(compareId)
	collisions.sort((a, b) =>
		a.alias < b.alias ? -1 : a.alias > b.alias ? 1 : 0,
	)
	canonicalBytes(stored, REGIONAL_LIMITS.datasetBytes)
	return stored
}
export function publicationPayload(stored: StoredDataset): unknown {
	const { dataContentSha256: _digest, ...publication } = stored.publication
	return { schemaVersion: 1, publication, collisions: stored.collisions }
}
/** Also used by dataset authoring; this does not attest external evidence. */
export function publicationDigest(input: unknown): string {
	const stored = normalizeStoredDataset(input)
	return createHash("sha256")
		.update(canonicalBytes(publicationPayload(stored)))
		.digest("hex")
}
export function validateRegistration(input: unknown): Registration {
	try {
		const safe: unknown = JSON.parse(canonicalBytes(input).toString("utf8"))
		const parsed = RegistrationSchema.safeParse(safe)
		if (!parsed.success) regionalUnavailable()
		const registration = parsed.data
		for (const entry of registration.registrations) {
			if (entry.dataset !== null) {
				entry.dataset = normalizeStoredDataset(entry.dataset)
				if (
					entry.manifest.state !== "verified" ||
					entry.manifest.datasetVersion !==
						entry.dataset.publication.datasetVersion ||
					entry.dataset.publication.dataContentSha256 !==
						publicationDigest(entry.dataset)
				)
					regionalUnavailable()
			}
		}
		canonicalBytes(registration)
		return deepFreeze(registration)
	} catch {
		return regionalUnavailable()
	}
}
/** Explicit cross-publication authoring gate; no persistent history is retained. */
export function assertVersionCoverage(
	previous: unknown,
	candidate: unknown,
): void {
	const before = normalizeStoredDataset(previous)
	const after = normalizeStoredDataset(candidate)
	if (
		before.publication.datasetId === after.publication.datasetId &&
		before.publication.datasetVersion === after.publication.datasetVersion &&
		canonicalJson(publicationPayload(before)) !==
			canonicalJson(publicationPayload(after))
	)
		regionalUnavailable()
}
