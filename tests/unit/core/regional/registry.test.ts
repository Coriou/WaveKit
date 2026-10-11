import { describe, expect, it } from "vitest"
import fc from "fast-check"
import { createRegionalRegistry } from "../../../../src/core/regional/registry.js"
import { createRegionalRegistration } from "../../../../src/core/regional/data.js"
import {
	canonicalBytes,
	canonicalJson,
	FrequencySchema,
	normalizeAlias,
	normalizeStoredDataset,
	publicationDigest,
	validateRegistration,
} from "../../../../src/core/regional/types.js"
import type {
	CoarseContext,
	Registration,
	StoredDataset,
} from "../../../../src/core/regional/types.js"

// Invented TEST evidence and values; these fixtures qualify no RF publication.
function fixture(count = 2, collision = false): Registration {
	const stored: StoredDataset = {
		publication: {
			schemaVersion: 1,
			datasetId: "us-frs",
			datasetVersion: "test-1",
			dataContentSha256: "0".repeat(64),
			familyId: "frs",
			applicability: { kind: "national", countryCode: "US" },
			verifiedAsOf: "2026-01-01",
			sourceReferences: [
				{
					id: "test-source",
					organization: "TEST",
					documentId: "TEST",
					title: "Invented TEST evidence",
					edition: "test-1",
					publishedDate: null,
					retrievedDate: "2026-01-01",
					url: "https://example.invalid/test",
					documentSha256: "0".repeat(64),
					applicability: "US",
					redistribution: "facts-transcribed",
					locator: "TEST fixture",
				},
			],
			rows: Array.from({ length: count }, (_, index) => ({
				id: `us-frs-test-${index}`,
				displayLabel: `TEST ${index}`,
				aliases: collision ? ["shared", `test ${index}`] : [`test ${index}`],
				frequency: { kind: "simplex", frequencyHz: index + 1 },
				display: {
					advisory: true,
					mode: null,
					bandwidthHz: null,
					stepHz: null,
				},
				sourceReferenceIds: ["test-source"],
			})),
		},
		collisions:
			collision && count >= 2
				? [
						{
							alias: "shared",
							candidateIds: Array.from(
								{ length: count },
								(_, index) => `us-frs-test-${index}`,
							),
						},
					]
				: [],
	}
	stored.publication.dataContentSha256 = publicationDigest(stored)
	return {
		schemaVersion: 1,
		registrations: [
			{
				manifest: {
					familyId: "frs",
					displayLabel: "TEST FRS",
					applicability: { kind: "national", countryCode: "US" },
					state: "verified",
					datasetVersion: "test-1",
					reason: null,
				},
				dataset: stored,
			},
		],
		coarseContext: null,
	}
}
function dataset(registration: Registration): StoredDataset {
	const stored = registration.registrations[0]?.dataset
	if (!stored) throw new Error("TEST fixture requires dataset")
	return stored
}
function rehash(registration: Registration): void {
	const stored = dataset(registration)
	stored.publication.dataContentSha256 = publicationDigest(stored)
}
// Dataset-local cases call the normalizer directly, outside any hash check.
// The outer-cardinality case instead keeps the dataset/digest valid throughout.
function assertContradiction(count: number, contradiction: number): void {
	const withCollision = contradiction >= 5 && contradiction <= 9
	const registration = fixture(count, withCollision)
	const stored = dataset(registration)
	expect(() => normalizeStoredDataset(stored)).not.toThrow()
	expect(() => validateRegistration(registration)).not.toThrow()
	const first = stored.publication.rows[0]!
	switch (contradiction) {
		case 0:
			// Alias sets remain distinct, so duplicate ID alone is invalid.
			stored.publication.rows[1]!.id = first.id
			break
		case 1:
			stored.publication.sourceReferences.push({
				...stored.publication.sourceReferences[0]!,
			})
			break
		case 2:
			// Other rows still cite the source; no orphan is introduced.
			first.sourceReferenceIds = []
			break
		case 3:
			first.sourceReferenceIds = ["missing"]
			break
		case 4:
			first.aliases.push(first.aliases[0]!)
			break
		case 5:
			stored.collisions = []
			break
		case 6:
			// count >= 3 keeps the subset within the legal 2..128 count.
			stored.collisions[0]!.candidateIds.pop()
			break
		case 7:
			stored.collisions[0]!.candidateIds[0] = "us-frs-missing"
			break
		case 8:
			stored.collisions[0]!.candidateIds[1] =
				stored.collisions[0]!.candidateIds[0]!
			break
		case 9:
			stored.collisions.push({
				...stored.collisions[0]!,
				candidateIds: [...stored.collisions[0]!.candidateIds],
			})
			break
		case 10:
			registration.registrations.push(registration.registrations[0]!)
			break
		case 11:
			stored.publication.sourceReferences.push({
				...stored.publication.sourceReferences[0]!,
				id: "orphan",
			})
			break
	}
	if (contradiction === 10) {
		expect(() => normalizeStoredDataset(stored)).not.toThrow()
	} else {
		expect(() => normalizeStoredDataset(stored)).toThrow()
	}
	// Supplementary provider assertion; semantic proof is the direct call above,
	// not the still-original digest on a mutated dataset.
	expect(() => validateRegistration(registration)).toThrow()
}
const regions = ["EU", "US", "CA", "AU", "NZ", "JP", "CN"] as const
const contexts = [
	"configured",
	"decoder",
	"guessed:tz",
	"guessed:intl-timezone",
	"guessed:locale-env",
	"guessed:intl-locale",
	"default",
] as const

describe("regional pure registry", () => {
	// Feature: regional-display-registry, Property 1: Authority separation
	// Validates: Requirements 1.2, 1.3, 1.4, 2.5, 3.2
	it("coarse context cannot change explicit national data", () => {
		fc.assert(
			fc.property(
				fc.constantFrom(...regions),
				fc.constantFrom(...contexts),
				fc.constantFrom(...regions),
				(code, source, region) => {
					const registration = fixture(1)
					registration.coarseContext = { code, source }
					const withContext = createRegionalRegistry(registration).listChannels(
						{ region, family: "frs" },
					)
					const without = createRegionalRegistry(fixture(1)).listChannels({
						region,
						family: "frs",
					})
					expect({ ...withContext, selection: null }).toEqual({
						...without,
						selection: null,
					})
					expect(withContext.selection).toEqual({
						requestedRegion: region,
						source: "query",
						coarseContext: { code, source },
					})
					if (region !== "US") expect(withContext).not.toHaveProperty("rows")
					else if (withContext.state === "verified")
						expect(withContext.rows[0]?.display).toEqual({
							advisory: true,
							mode: null,
							bandwidthHz: null,
							stepHz: null,
						})
				},
			),
			{ numRuns: 100 },
		)
	})

	// Feature: regional-display-registry, Property 2: Alias determinism
	// Validates: Requirements 2.1, 2.2, 2.3, 3.5
	it("declared collisions remain ambiguous under row and alias permutations", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 2, max: 32 }),
				fc.boolean(),
				fc.boolean(),
				(count, reverseRows, reverseAliases) => {
					const registration = fixture(count, true)
					const stored = dataset(registration)
					if (reverseRows) stored.publication.rows.reverse()
					if (reverseAliases)
						for (const row of stored.publication.rows) row.aliases.reverse()
					stored.collisions[0]?.candidateIds.reverse()
					const registry = createRegionalRegistry(registration)
					const resolved = registry.resolveAlias({
						region: "US",
						family: "frs",
						alias: "  SHARED  ",
					})
					expect(resolved.state).toBe("verified")
					if (resolved.state !== "verified")
						throw new Error("TEST verified expected")
					expect(resolved.result).toBe("ambiguous")
					expect(resolved.candidates.map(row => row.id)).toEqual(
						stored.publication.rows.map(row => row.id).sort(),
					)
					expect(
						registry.resolveAlias({
							region: "US",
							family: "frs",
							alias: "test 0",
						}),
					).toMatchObject({ result: "matched" })
					expect(
						registry.resolveAlias({ region: "US", family: "frs", alias: "01" }),
					).toMatchObject({ result: "not-found" })
				},
			),
			{ numRuns: 100 },
		)
	})

	// Feature: regional-display-registry, Property 3: Detached projection
	// Validates: Requirements 1.1, 3.3
	it("input mutation and frozen output mutation cannot change subsequent reads", () => {
		fc.assert(
			fc.property(fc.integer({ min: 1, max: 20 }), count => {
				const registration = fixture(count)
				const registry = createRegionalRegistry(registration)
				const before = registry.listChannels({ region: "US", family: "frs" })
				dataset(registration).publication.rows[0]!.displayLabel = "mutated TEST"
				registration.coarseContext = { code: "JP", source: "configured" }
				if (before.state !== "verified")
					throw new Error("TEST verified expected")
				expect(() =>
					Reflect.set(before.rows[0]!, "displayLabel", "mutated"),
				).not.toThrow()
				expect(Reflect.set(before.rows[0]!, "displayLabel", "mutated")).toBe(
					false,
				)
				expect(Object.isFrozen(before.dataset.sourceReferences[0])).toBe(true)
				const after = registry.listChannels({ region: "US", family: "frs" })
				expect(after).toEqual(before)
				expect(after).not.toBe(before)
				if (after.state === "verified")
					expect(after.rows[0]).not.toBe(before.rows[0])
			}),
			{ numRuns: 100 },
		)
	})

	// Feature: regional-display-registry, Property 4: Bounds
	// Validates: Requirements 3.3, 3.5
	it("multibyte labels and bounded pages reject the next scalar without truncation", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 1, max: 80 }),
				fc.integer({ min: 1, max: 128 }),
				(length, limit) => {
					const registration = fixture(3)
					dataset(registration).publication.rows[0]!.displayLabel = "😀".repeat(
						length,
					)
					rehash(registration)
					const registry = createRegionalRegistry(registration)
					const output = registry.listChannels({
						region: "US",
						family: "frs",
						limit,
					})
					expect(
						Buffer.byteLength(canonicalJson(output), "utf8"),
					).toBeLessThanOrEqual(128 * 1024)
					if (output.state === "verified")
						expect(output.rows.length).toBeLessThanOrEqual(limit)
					dataset(registration).publication.rows[0]!.displayLabel = "😀".repeat(
						81,
					)
					expect(() => normalizeStoredDataset(dataset(registration))).toThrow()
					expect(() => createRegionalRegistry(registration)).toThrow()
					expect(() =>
						registry.listChannels({ region: "US", family: "frs", limit: 129 }),
					).toThrow()
				},
			),
			{ numRuns: 100 },
		)
	})

	// Feature: regional-display-registry, Property 5: Duplex preservation
	// Validates: Requirements 2.4
	it("generic duplex retains endpoint-relative roles but cannot enter FRS", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 1, max: 1_000_000_000_000 }),
				fc.integer({ min: 1, max: 1_000_000_000_000 }),
				fc.constantFrom("subscriber" as const, "base" as const),
				(stationReceiveHz, stationTransmitHz, endpoint) => {
					const frequency = {
						kind: "duplex" as const,
						stationReceiveHz,
						stationTransmitHz,
						endpoint,
					}
					expect(FrequencySchema.parse(frequency)).toEqual(frequency)
					expect(JSON.parse(canonicalJson(frequency))).toEqual(frequency)
					const registration = fixture(1)
					const stored = dataset(registration)
					expect(() => normalizeStoredDataset(stored)).not.toThrow()
					stored.publication.rows[0]!.frequency = frequency
					// The normalizer does not compare publication digests: this assertion
					// must reject duplex on its own, even if the old digest is unchanged.
					expect(() => normalizeStoredDataset(stored)).toThrow()
					expect(() => createRegionalRegistry(registration)).toThrow()
				},
			),
			{ numRuns: 100 },
		)
	})

	// Feature: regional-display-registry, Property 8: Canonical publication
	// Validates: Requirements 2.1, 3.5
	it("object-key and all dataset-array permutations preserve exact bytes and digest", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 2, max: 20 }),
				fc.boolean(),
				(count, reversed) => {
					const registration = fixture(count, true)
					const source = dataset(registration).publication.sourceReferences[0]!
					const second = { ...source, id: "test-second", title: "TEST second" }
					const stored = dataset(registration)
					stored.publication.sourceReferences.push(second)
					for (const row of stored.publication.rows)
						row.sourceReferenceIds.push(second.id)
					stored.publication.rows[0]!.aliases.push("another shared")
					stored.publication.rows[1]!.aliases.push("another shared")
					stored.collisions.push({
						alias: "another shared",
						candidateIds: [
							stored.publication.rows[0]!.id,
							stored.publication.rows[1]!.id,
						],
					})
					rehash(registration)
					const before = canonicalJson(normalizeStoredDataset(stored))
					function permute(value: unknown): unknown {
						if (Array.isArray(value))
							return (reversed ? [...value].reverse() : [...value]).map(permute)
						if (value !== null && typeof value === "object")
							return Object.fromEntries(
								Object.entries(value)
									.reverse()
									.map(([key, item]) => [key, permute(item)]),
							)
						return value
					}
					expect(canonicalJson(normalizeStoredDataset(permute(stored)))).toBe(
						before,
					)
					expect(publicationDigest(permute(stored))).toBe(
						stored.publication.dataContentSha256,
					)
				},
			),
			{ numRuns: 100 },
		)
	})

	// Feature: regional-display-registry, Property 9: Correlated registration
	// Validates: Requirements 2.3, 2.5, 3.1, 3.4, 3.5
	it("each generated contradiction rejects independently of the digest comparison", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 3, max: 12 }),
				fc.integer({ min: 0, max: 11 }),
				(count, contradiction) => {
					assertContradiction(count, contradiction)
				},
			),
			{ numRuns: 100 },
		)
	})
	it.each(Array.from({ length: 12 }, (_, index) => index))(
		"isolates every Property 9 case %i alongside its valid control",
		contradiction => {
			assertContradiction(3, contradiction)
		},
	)
	it.each([
		"duplicate-source",
		"orphan-source",
		"duplicate-row",
		"duplex",
	] as const)(
		"isolates %s with otherwise valid citations and no collisions",
		contradiction => {
			const registration = fixture(2)
			const stored = dataset(registration)
			expect(() => normalizeStoredDataset(stored)).not.toThrow()
			expect(() => validateRegistration(registration)).not.toThrow()
			const first = stored.publication.rows[0]!
			switch (contradiction) {
				case "duplicate-source":
					stored.publication.sourceReferences.push({
						...stored.publication.sourceReferences[0]!,
					})
					break
				case "orphan-source":
					stored.publication.sourceReferences.push({
						...stored.publication.sourceReferences[0]!,
						id: "test-orphan",
					})
					break
				case "duplicate-row":
					// Existing aliases stay distinct; there is no collision declaration
					// that could independently fail when the row uniqueness guard is off.
					stored.publication.rows[1]!.id = first.id
					break
				case "duplex":
					first.frequency = {
						kind: "duplex",
						stationReceiveHz: 1,
						stationTransmitHz: 2,
						endpoint: "subscriber",
					}
					break
			}
			expect(() => normalizeStoredDataset(stored)).toThrow()
		},
	)

	it("all seven region states distinguish unavailable, verified and verified-empty", () => {
		for (const registration of [
			createRegionalRegistration(),
			fixture(0),
			fixture(1),
		]) {
			const registry = createRegionalRegistry(registration)
			for (const region of regions) {
				const families = registry.listFamilies(region)
				const channels = registry.listChannels({ region, family: "frs" })
				const resolution = registry.resolveAlias({
					region,
					family: "frs",
					alias: "missing",
				})
				if (region !== "US") {
					expect(families).toMatchObject({ state: "unsupported", families: [] })
					expect(channels).toMatchObject({ state: "unsupported" })
					expect(resolution).not.toHaveProperty("dataset")
				} else {
					expect(families).toMatchObject({ state: "available" })
					if (families.state === "available")
						expect(families.families).toHaveLength(1)
					if (registration.registrations[0]?.dataset === null)
						expect(channels).toMatchObject({ state: "unavailable" })
					else
						expect(channels).toMatchObject({
							state: "verified",
							total:
								registration.registrations[0]?.dataset?.publication.rows.length,
						})
				}
			}
		}
	})
	it("pagination uses ASCII IDs before slice, defaults and end/max offsets", () => {
		const registry = createRegionalRegistry(fixture(12))
		const first = registry.listChannels({
			region: "US",
			family: "frs",
			limit: 2,
		})
		expect(first).toMatchObject({
			offset: 0,
			limit: 2,
			total: 12,
			nextOffset: 2,
		})
		if (first.state === "verified")
			expect(first.rows.map(row => row.id)).toEqual([
				"us-frs-test-0",
				"us-frs-test-1",
			])
		const second = registry.listChannels({
			region: "US",
			family: "frs",
			offset: 2,
			limit: 1,
		})
		if (second.state === "verified")
			expect(second.rows[0]?.id).toBe("us-frs-test-10")
		expect(
			registry.listChannels({ region: "US", family: "frs" }),
		).toMatchObject({ offset: 0, limit: 64, nextOffset: null })
		for (const offset of [12, 1024])
			expect(
				registry.listChannels({ region: "US", family: "frs", offset }),
			).toMatchObject({ rows: [], nextOffset: null, total: 12 })
		for (const query of [
			{ offset: -0 },
			{ offset: 1025 },
			{ offset: -1 },
			{ limit: 0 },
			{ limit: 129 },
			{ limit: 1.5 },
			{ unexpected: true },
		])
			expect(() =>
				registry.listChannels({ region: "US", family: "frs", ...query }),
			).toThrow()
	})
	it("strict alias grammar preserves punctuation/zeros and never infers label aliases", () => {
		expect(normalizeAlias("  FRS   01+%2B&=  ")).toBe("frs 01+%2b&=")
		for (const alias of ["", " ", "é", "a\n", "a".repeat(33)])
			expect(() => normalizeAlias(alias)).toThrow()
		const registry = createRegionalRegistry(fixture(1))
		expect(
			registry.resolveAlias({ region: "US", family: "frs", alias: "TEST 0" }),
		).toMatchObject({ result: "matched" })
		expect(
			registry.resolveAlias({ region: "US", family: "frs", alias: "TEST-0" }),
		).toMatchObject({ result: "not-found" })
		expect(() =>
			registry.listChannels({ region: "US", family: "unknown" }),
		).toThrow(
			expect.objectContaining({
				code: "REGIONAL_FAMILY_NOT_FOUND",
				message: "Regional family not found",
			}),
		)
		expect(() =>
			registry.listChannels({ region: "US", family: "UNKNOWN" }),
		).toThrow(expect.objectContaining({ code: "REGIONAL_INVALID_REQUEST" }))
		expect(() => registry.listFamilies("bad" as "US")).toThrow()
	})
	it("labels are not hidden aliases and complete ambiguity is not capped by a page", () => {
		const registration = fixture(1)
		const row = dataset(registration).publication.rows[0]!
		row.displayLabel = "TEST distinct label"
		row.aliases = []
		rehash(registration)
		expect(
			createRegionalRegistry(registration).resolveAlias({
				region: "US",
				family: "frs",
				alias: row.displayLabel,
			}),
		).toMatchObject({ result: "not-found", candidates: [] })
		const all = createRegionalRegistry(fixture(128, true)).resolveAlias({
			region: "US",
			family: "frs",
			alias: "shared",
		})
		expect(all).toMatchObject({ state: "verified", result: "ambiguous" })
		if (all.state === "verified") expect(all.candidates).toHaveLength(128)
	})
	it("context injection is detached and invalid context is not inferred or accepted", () => {
		const context: CoarseContext = { code: "EU", source: "default" }
		const registration = createRegionalRegistration(context)
		context.code = "US"
		expect(registration.coarseContext?.code).toBe("EU")
		expect(() =>
			createRegionalRegistration({
				code: "US",
				source: "invalid",
			} as unknown as CoarseContext),
		).toThrow()
	})
	it("rejects getters without invoking them, cycles, extra nested keys and wrong digests", () => {
		let calls = 0
		const getter = Object.defineProperty({}, "registrations", {
			enumerable: true,
			get() {
				calls++
				return []
			},
		})
		expect(() => createRegionalRegistry(getter)).toThrow()
		expect(calls).toBe(0)
		const proxy = new Proxy(
			{},
			{
				ownKeys() {
					calls++
					return []
				},
			},
		)
		expect(() => createRegionalRegistry(proxy)).toThrow()
		expect(calls).toBe(0)
		const cyclic: { self?: unknown } = {}
		cyclic.self = cyclic
		expect(() => canonicalBytes(cyclic)).toThrow()
		const registration = fixture(1)
		dataset(registration).publication.dataContentSha256 = "f".repeat(64)
		expect(() => createRegionalRegistry(registration)).toThrow()
		expect(() =>
			createRegionalRegistry({ ...createRegionalRegistration(), extra: true }),
		).toThrow()
	})
})
