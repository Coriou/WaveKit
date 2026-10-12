import type {
	RegionalChannelsResult,
	RegionalDatasetHeader,
	RegionalFamiliesResult,
	RegionalResolveResult,
	RegionalSelection,
	RegionalUnavailableResult,
} from "@wavekit/api-types"
import { z } from "zod"
import { WaveKitError } from "../../utils/errors.js"
import {
	IdSchema,
	RegionSchema,
	REGIONAL_LIMITS,
	canonicalBytes,
	detachedFrozen,
	normalizeAlias,
	regionalInvalidRequest,
	regionalUnavailable,
	validateRegistration,
} from "./types.js"
import type { RegionCode } from "./types.js"

export interface RegionalRegistry {
	listFamilies(region: RegionCode): RegionalFamiliesResult
	listChannels(input: {
		region: RegionCode
		family: string
		offset?: number
		limit?: number
	}): RegionalChannelsResult
	resolveAlias(input: {
		region: RegionCode
		family: string
		alias: string
	}): RegionalResolveResult
}
const ChannelsInputSchema = z
	.object({
		region: RegionSchema,
		family: IdSchema,
		offset: z
			.number()
			.int()
			.min(0)
			.max(1024)
			.refine(value => !Object.is(value, -0))
			.optional(),
		limit: z.number().int().min(1).max(128).optional(),
	})
	.strict()
const ResolveInputSchema = z
	.object({ region: RegionSchema, family: IdSchema, alias: z.string() })
	.strict()
function input<T>(schema: z.ZodType<T>, value: unknown): T {
	try {
		const safe: unknown = JSON.parse(canonicalBytes(value).toString("utf8"))
		const result = schema.safeParse(safe)
		if (!result.success) regionalInvalidRequest()
		return result.data
	} catch {
		return regionalInvalidRequest()
	}
}
function result<T>(value: T): T {
	canonicalBytes(value, REGIONAL_LIMITS.responseBytes)
	return detachedFrozen(value)
}
function knownFamily(family: string): void {
	if (family !== "frs")
		throw new WaveKitError(
			"Regional family not found",
			"REGIONAL_FAMILY_NOT_FOUND",
		)
}

/** No I/O, operational dependencies, callbacks, timers or mutable exposed state. */
export function createRegionalRegistry(
	registration: unknown,
): RegionalRegistry {
	const stored = validateRegistration(registration)
	const entry = stored.registrations[0] ?? regionalUnavailable()
	function selection(region: RegionCode): RegionalSelection {
		return {
			requestedRegion: region,
			source: "query",
			coarseContext: stored.coarseContext,
		}
	}
	function unavailable(region: RegionCode): RegionalUnavailableResult | null {
		if (region !== "US")
			return {
				schemaVersion: 1,
				selection: selection(region),
				familyId: "frs",
				state: "unsupported",
				reason: "region-not-covered",
			}
		if (entry.dataset === null)
			return {
				schemaVersion: 1,
				selection: selection(region),
				familyId: "frs",
				state: "unavailable",
				reason: "evidence-pending",
			}
		return null
	}
	function header(): RegionalDatasetHeader {
		if (!entry.dataset) regionalUnavailable()
		const publication = entry.dataset.publication
		return {
			datasetId: publication.datasetId,
			datasetVersion: publication.datasetVersion,
			dataContentSha256: publication.dataContentSha256,
			applicability: publication.applicability,
			verifiedAsOf: publication.verifiedAsOf,
			sourceReferences: publication.sourceReferences,
		}
	}
	return Object.freeze({
		listFamilies(region: RegionCode): RegionalFamiliesResult {
			const valid = input(RegionSchema, region)
			if (valid !== "US")
				return result({
					schemaVersion: 1,
					selection: selection(valid),
					state: "unsupported",
					reason: "region-not-covered",
					families: [],
				} satisfies RegionalFamiliesResult)
			return result({
				schemaVersion: 1,
				selection: selection(valid),
				state: "available",
				families: [entry.manifest],
			} satisfies RegionalFamiliesResult)
		},
		listChannels(query: {
			region: RegionCode
			family: string
			offset?: number
			limit?: number
		}): RegionalChannelsResult {
			const valid = input(ChannelsInputSchema, query)
			knownFamily(valid.family)
			const missing = unavailable(valid.region)
			if (missing) return result(missing)
			if (!entry.dataset) regionalUnavailable()
			const offset = valid.offset ?? 0
			const limit = valid.limit ?? 64
			const all = entry.dataset.publication.rows
			const rows = all.slice(offset, offset + limit)
			const next = offset + rows.length
			return result({
				schemaVersion: 1,
				selection: selection(valid.region),
				state: "verified",
				dataset: header(),
				total: all.length,
				offset,
				limit,
				rows,
				nextOffset: next < all.length ? next : null,
			} satisfies RegionalChannelsResult)
		},
		resolveAlias(query: {
			region: RegionCode
			family: string
			alias: string
		}): RegionalResolveResult {
			const valid = input(ResolveInputSchema, query)
			const normalizedAlias = normalizeAlias(valid.alias)
			knownFamily(valid.family)
			const missing = unavailable(valid.region)
			if (missing) return result(missing)
			if (!entry.dataset) regionalUnavailable()
			const candidates = entry.dataset.publication.rows.filter(row =>
				row.aliases.includes(normalizedAlias),
			)
			const common = {
				schemaVersion: 1 as const,
				selection: selection(valid.region),
				state: "verified" as const,
				dataset: header(),
				normalizedAlias,
			}
			const first = candidates[0]
			const second = candidates[1]
			if (!first)
				return result({
					...common,
					result: "not-found",
					candidates: [],
				} satisfies RegionalResolveResult)
			if (!second)
				return result({
					...common,
					result: "matched",
					candidates: [first],
				} satisfies RegionalResolveResult)
			return result({
				...common,
				result: "ambiguous",
				candidates: [first, second, ...candidates.slice(2)],
			} satisfies RegionalResolveResult)
		},
	})
}
