import { describe, expect, it } from "vitest"
import { createHash } from "node:crypto"
import {
	createRegionalRegistration,
	REGIONAL_REGISTRATION,
} from "../../../../src/core/regional/data.js"
import { createRegionalRegistry } from "../../../../src/core/regional/registry.js"
import {
	assertVersionCoverage,
	canonicalBytes,
	canonicalJson,
	FrequencySchema,
	normalizeStoredDataset,
	publicationDigest,
	publicationPayload,
	REGIONAL_LIMITS,
	validateRegistration,
} from "../../../../src/core/regional/types.js"
import type {
	Registration,
	StoredDataset,
} from "../../../../src/core/regional/types.js"

// TEST-only inputs, not regulatory facts, source captures or accepted numeric data.
function synthetic(count: number, collision = false): StoredDataset {
	return {
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
					title: "TEST source",
					edition: "test-1",
					publishedDate: null,
					retrievedDate: "2026-01-01",
					url: "https://example.invalid/test",
					documentSha256: "0".repeat(64),
					applicability: "US",
					redistribution: "facts-transcribed",
					locator: "TEST only",
				},
			],
			rows: Array.from({ length: count }, (_, index) => ({
				id: `us-frs-test-${index}`,
				displayLabel: index === 0 ? 'TEST "é\\ /' : `TEST ${index}`,
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
		collisions: collision
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
}
function registration(stored: StoredDataset): Registration {
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
					datasetVersion: stored.publication.datasetVersion,
					reason: null,
				},
				dataset: stored,
			},
		],
		coarseContext: null,
	}
}
function hash(bytes: string): string {
	return createHash("sha256").update(Buffer.from(bytes, "utf8")).digest("hex")
}

// VECTORS are literal spec-algorithm bytes/hash pins derived independently using
// Python standard-library JSON (sorted ASCII keys, scalar UTF8) and hashlib.
// The application serializer was not invoked to produce these constants.
const V1_BYTES =
	'{"collisions":[],"publication":{"applicability":{"countryCode":"US","kind":"national"},"datasetId":"us-frs","datasetVersion":"test-1","familyId":"frs","rows":[],"schemaVersion":1,"sourceReferences":[{"applicability":"US","documentId":"TEST","documentSha256":"0000000000000000000000000000000000000000000000000000000000000000","edition":"test-1","id":"test-source","locator":"TEST only","organization":"TEST","publishedDate":null,"redistribution":"facts-transcribed","retrievedDate":"2026-01-01","title":"TEST source","url":"https://example.invalid/test"}],"verifiedAsOf":"2026-01-01"},"schemaVersion":1}'
const V1_SHA256 =
	"fa8dac9065839715d544d6cb6b59bae6e9dfebc9833007893a7f0547a9316e93"
const V2_BYTES =
	'{"collisions":[],"publication":{"applicability":{"countryCode":"US","kind":"national"},"datasetId":"us-frs","datasetVersion":"test-1","familyId":"frs","rows":[{"aliases":["test 0"],"display":{"advisory":true,"bandwidthHz":null,"mode":null,"stepHz":null},"displayLabel":"TEST \\"é\\\\ /","frequency":{"frequencyHz":1,"kind":"simplex"},"id":"us-frs-test-0","sourceReferenceIds":["test-source"]}],"schemaVersion":1,"sourceReferences":[{"applicability":"US","documentId":"TEST","documentSha256":"0000000000000000000000000000000000000000000000000000000000000000","edition":"test-1","id":"test-source","locator":"TEST only","organization":"TEST","publishedDate":null,"redistribution":"facts-transcribed","retrievedDate":"2026-01-01","title":"TEST source","url":"https://example.invalid/test"}],"verifiedAsOf":"2026-01-01"},"schemaVersion":1}'
const V2_SHA256 =
	"dc4df6af38bf60b6deb84bac6a326dec314b0e8f5c64fcbae53a073091db5e21"
const V3_BYTES =
	'{"collisions":[{"alias":"shared","candidateIds":["us-frs-test-0","us-frs-test-1"]}],"publication":{"applicability":{"countryCode":"US","kind":"national"},"datasetId":"us-frs","datasetVersion":"test-1","familyId":"frs","rows":[{"aliases":["shared","test 0"],"display":{"advisory":true,"bandwidthHz":null,"mode":null,"stepHz":null},"displayLabel":"TEST \\"é\\\\ /","frequency":{"frequencyHz":1,"kind":"simplex"},"id":"us-frs-test-0","sourceReferenceIds":["test-source"]},{"aliases":["shared","test 1"],"display":{"advisory":true,"bandwidthHz":null,"mode":null,"stepHz":null},"displayLabel":"TEST 1","frequency":{"frequencyHz":2,"kind":"simplex"},"id":"us-frs-test-1","sourceReferenceIds":["test-source"]}],"schemaVersion":1,"sourceReferences":[{"applicability":"US","documentId":"TEST","documentSha256":"0000000000000000000000000000000000000000000000000000000000000000","edition":"test-1","id":"test-source","locator":"TEST only","organization":"TEST","publishedDate":null,"redistribution":"facts-transcribed","retrievedDate":"2026-01-01","title":"TEST source","url":"https://example.invalid/test"}],"verifiedAsOf":"2026-01-01"},"schemaVersion":1}'
const V3_SHA256 =
	"c0b2185f94143145602e57765515fc6b438e8c0276e030f2004cdf6d569afaf9"
const V4_BYTES =
	'{"coarseContext":null,"registrations":[{"dataset":null,"manifest":{"applicability":{"countryCode":"US","kind":"national"},"datasetVersion":null,"displayLabel":"FRS","familyId":"frs","reason":"evidence-pending","state":"unavailable"}}],"schemaVersion":1}'
const V4_SHA256 =
	"8eef77b1451c0d96ff8a9111d405fb8c5a2a005ec6cc1a3490f8f577c4f25b3b"
const PRIMITIVE_BYTES =
	'{"a":true,"n":9007199254740991,"text":"TEST \\"é\\\\ /  ","z":null}'
const PRIMITIVE_SHA256 =
	"aaa711365fa8ba224c8679de52406dbf06344f20c7e545bdf99bfe9c58ab393b"

describe("regional data and canonical publication", () => {
	it("production has exactly the mandatory unavailable/null registration and no invented authority", () => {
		expect(canonicalJson(REGIONAL_REGISTRATION)).toBe(V4_BYTES)
		expect(hash(canonicalJson(REGIONAL_REGISTRATION))).toBe(V4_SHA256)
		expect(
			Object.isFrozen(REGIONAL_REGISTRATION.registrations[0]?.manifest),
		).toBe(true)
		const bytes = canonicalJson(REGIONAL_REGISTRATION)
		for (const field of [
			"frequencyHz",
			"sourceReferences",
			"verifiedAsOf",
			"dataContentSha256",
			"documentSha256",
			"total",
			"rows",
		])
			expect(bytes).not.toContain(`"${field}"`)
		expect(
			createRegionalRegistry(REGIONAL_REGISTRATION).listChannels({
				region: "US",
				family: "frs",
			}),
		).toMatchObject({ state: "unavailable", reason: "evidence-pending" })
	})
	it.each([
		["V1", 0, false, V1_BYTES, V1_SHA256],
		["V2", 1, false, V2_BYTES, V2_SHA256],
		["V3", 2, true, V3_BYTES, V3_SHA256],
	] as const)(
		"%s exact independently pinned payload bytes and digest",
		(_name, count, collision, bytes, digest) => {
			const stored = synthetic(count, collision)
			stored.publication.rows.reverse()
			stored.collisions[0]?.candidateIds.reverse()
			const normalized = normalizeStoredDataset(stored)
			expect(canonicalJson(publicationPayload(normalized))).toBe(bytes)
			expect(publicationDigest(stored)).toBe(digest)
			expect(hash(bytes)).toBe(digest)
			expect(
				createRegionalRegistry(registration(stored)).listChannels({
					region: "US",
					family: "frs",
				}),
			).toMatchObject({ state: "verified", total: count })
		},
	)
	it("primitive byte pins preserve escapes, slashes, Unicode separators, integers and null", () => {
		const input = {
			z: null,
			a: true,
			n: Number.MAX_SAFE_INTEGER,
			text: 'TEST "é\\ /\u2028\u2029',
		}
		expect(canonicalJson(input)).toBe(PRIMITIVE_BYTES)
		expect(hash(canonicalJson(input))).toBe(PRIMITIVE_SHA256)
		expect(canonicalJson({ n: 0, b: false })).toBe('{"b":false,"n":0}')
		for (const invalid of [
			-0,
			-1,
			1.5,
			Infinity,
			NaN,
			Number.MAX_SAFE_INTEGER + 1,
			undefined,
			1n,
			"\ud800",
			"a\n",
			() => 1,
		])
			expect(() => canonicalJson(invalid)).toThrow()
		expect(canonicalJson("é")).not.toBe(canonicalJson("e\u0301"))
		expect(hash(canonicalJson("é"))).not.toBe(hash(canonicalJson("e\u0301")))
	})
	it("every mutable hashed field requires a new version; digest alone is excluded", () => {
		const before = synthetic(2, true)
		const changes: Array<(stored: StoredDataset) => void> = [
			stored => {
				stored.publication.datasetVersion = "test-2"
			},
			stored => {
				stored.publication.verifiedAsOf = "2026-01-02"
			},
			stored => {
				stored.publication.sourceReferences[0]!.organization = "TEST corrected"
			},
			stored => {
				stored.publication.sourceReferences[0]!.documentId = "TEST2"
			},
			stored => {
				stored.publication.sourceReferences[0]!.title = "TEST corrected"
			},
			stored => {
				stored.publication.sourceReferences[0]!.edition = "test-2"
			},
			stored => {
				stored.publication.sourceReferences[0]!.publishedDate = "2025-01-01"
			},
			stored => {
				stored.publication.sourceReferences[0]!.retrievedDate = "2026-01-02"
			},
			stored => {
				stored.publication.sourceReferences[0]!.url =
					"https://example.invalid/second"
			},
			stored => {
				stored.publication.sourceReferences[0]!.documentSha256 = "1".repeat(64)
			},
			stored => {
				stored.publication.sourceReferences[0]!.locator = "TEST corrected"
			},
			stored => {
				stored.publication.rows[0]!.displayLabel = "TEST corrected"
			},
			stored => {
				stored.publication.rows[0]!.aliases.push("extra")
			},
			stored => {
				stored.publication.rows[0]!.frequency = {
					kind: "simplex",
					frequencyHz: 999,
				}
			},
			stored => {
				stored.publication.rows[0]!.display.mode = "nfm"
			},
			stored => {
				stored.publication.rows[0]!.display.bandwidthHz = 1
			},
			stored => {
				stored.publication.rows[0]!.display.stepHz = 1
			},
			stored => {
				stored.publication.rows[0]!.id = "us-frs-test-renamed"
				stored.collisions[0]!.candidateIds[0] = "us-frs-test-renamed"
			},
			stored => {
				stored.publication.sourceReferences[0]!.id = "test-renamed"
				for (const row of stored.publication.rows)
					row.sourceReferenceIds = ["test-renamed"]
			},
			stored => {
				for (const row of stored.publication.rows)
					row.aliases[0] = "changed shared"
				stored.collisions[0]!.alias = "changed shared"
			},
		]
		for (const change of changes) {
			const after = synthetic(2, true)
			change(after)
			expect(publicationDigest(after)).not.toBe(publicationDigest(before))
			if (
				after.publication.datasetVersion === before.publication.datasetVersion
			)
				expect(() => assertVersionCoverage(before, after)).toThrow()
			after.publication.datasetVersion = "test-2"
			expect(() => assertVersionCoverage(before, after)).not.toThrow()
		}
		const digestOnly = synthetic(2, true)
		digestOnly.publication.dataContentSha256 = "f".repeat(64)
		expect(publicationDigest(digestOnly)).toBe(publicationDigest(before))
		expect(() => assertVersionCoverage(before, digestOnly)).not.toThrow()
		const original = registration(synthetic(1))
		const changed = structuredClone(original)
		changed.registrations[0]!.manifest.displayLabel = "Another TEST label"
		changed.coarseContext = { code: "JP", source: "default" }
		expect(
			changed.registrations[0]?.dataset?.publication.dataContentSha256,
		).toBe(original.registrations[0]?.dataset?.publication.dataContentSha256)
		expect(canonicalJson(changed)).not.toBe(canonicalJson(original))
		expect(() => validateRegistration(changed)).not.toThrow()
	})
	it("literal-only fields cannot be changed to evade version/authority coverage", () => {
		const base = synthetic(1)
		for (const publication of [
			{ ...base.publication, schemaVersion: 2 },
			{ ...base.publication, datasetId: "other" },
			{ ...base.publication, familyId: "other" },
			{
				...base.publication,
				applicability: { kind: "national", countryCode: "CA" },
			},
		])
			expect(() => publicationDigest({ ...base, publication })).toThrow()
		for (const source of [
			{ ...base.publication.sourceReferences[0], applicability: "CA" },
			{ ...base.publication.sourceReferences[0], redistribution: "licensed" },
		])
			expect(() =>
				publicationDigest({
					...base,
					publication: { ...base.publication, sourceReferences: [source] },
				}),
			).toThrow()
		expect(() =>
			publicationDigest({
				...base,
				publication: {
					...base.publication,
					rows: [
						{
							...base.publication.rows[0],
							display: {
								...base.publication.rows[0]?.display,
								advisory: false,
							},
						},
					],
				},
			}),
		).toThrow()
	})
	it("storage includes digest/collisions while publication payload excludes only digest", () => {
		const stored = synthetic(2, true)
		const payload = canonicalJson(
			publicationPayload(normalizeStoredDataset(stored)),
		)
		const storage = canonicalJson(normalizeStoredDataset(stored))
		expect(payload).not.toContain('"dataContentSha256"')
		expect(storage).toContain('"dataContentSha256"')
		expect(payload).toContain('"collisions"')
		expect(Buffer.byteLength(storage)).toBe(Buffer.byteLength(payload) + 69)
		// Stored envelope removes schemaVersion:1 (18 bytes including comma),
		// then adds dataContentSha256 (87 bytes including comma): delta 69.
		// This delta follows from the literal field lengths, not the serializer.
	})
	it("strict state correlations never accept an orphan or mismatched publication", () => {
		const unavailable = createRegionalRegistration()
		const verified = registration(synthetic(0))
		const entry = verified.registrations[0]!
		for (const bad of [
			{ ...unavailable, registrations: [] },
			{
				...unavailable,
				registrations: [
					{ ...unavailable.registrations[0], dataset: synthetic(0) },
				],
			},
			{ ...verified, registrations: [{ ...entry, dataset: null }] },
			{ ...verified, registrations: [entry, entry] },
			{
				...verified,
				registrations: [
					{
						...entry,
						manifest: { ...entry.manifest, reason: "evidence-pending" },
					},
				],
			},
			{
				...verified,
				registrations: [
					{
						...entry,
						manifest: { ...entry.manifest, datasetVersion: "test-2" },
					},
				],
			},
			{
				...unavailable,
				registrations: [
					{
						...unavailable.registrations[0],
						manifest: {
							...unavailable.registrations[0]?.manifest,
							reason: null,
						},
					},
				],
			},
			{
				...verified,
				registrations: [
					{ ...entry, dataset: { ...synthetic(0), extra: true } },
				],
			},
		])
			expect(() => createRegionalRegistry(bad)).toThrow()
	})
	it("rejects all missing, extra and incomplete collision declarations", () => {
		const base = synthetic(2, true)
		for (const collisions of [
			[],
			[{ alias: "shared", candidateIds: ["us-frs-test-0"] }],
			[{ alias: "shared", candidateIds: ["us-frs-test-0", "us-frs-test-0"] }],
			[{ alias: "shared", candidateIds: ["us-frs-test-0", "us-frs-missing"] }],
			[{ alias: "test 0", candidateIds: ["us-frs-test-0", "us-frs-test-1"] }],
			[{ alias: "absent", candidateIds: ["us-frs-test-0", "us-frs-test-1"] }],
		])
			expect(() => normalizeStoredDataset({ ...base, collisions })).toThrow()
	})
	it("string/date/URL/numeric/count boundaries are strict, not coercing", () => {
		for (const frequencyHz of [
			0,
			-0,
			-1,
			1.1,
			"1",
			1_000_000_000_001,
			Number.MAX_SAFE_INTEGER + 1,
		])
			expect(
				FrequencySchema.safeParse({ kind: "simplex", frequencyHz }).success,
			).toBe(false)
		for (const frequencyHz of [1, 1_000_000_000_000])
			expect(
				FrequencySchema.safeParse({ kind: "simplex", frequencyHz }).success,
			).toBe(true)
		const invalidSources = [
			{ title: "😀".repeat(121) },
			{ organization: "" },
			{ locator: "\ud800" },
			{ documentId: "é" },
			{ edition: "x".repeat(81) },
			{ retrievedDate: "2026-02-30" },
			{ publishedDate: "2025-02-29" },
			{ url: "http://example.invalid/test" },
			{ url: "https://user@example.invalid/test" },
			{ url: "https://example.invalid/#" },
			{ documentSha256: "F".repeat(64) },
			{ extra: true },
		]
		for (const patch of invalidSources) {
			const stored = synthetic(1)
			expect(() =>
				publicationDigest({
					...stored,
					publication: {
						...stored.publication,
						sourceReferences: [
							{ ...stored.publication.sourceReferences[0], ...patch },
						],
					},
				}),
			).toThrow()
		}
		for (const patch of [
			{ aliases: [" TEST "] },
			{ aliases: ["test", "test"] },
			{ aliases: Array.from({ length: 9 }, (_, index) => `test ${index}`) },
			{ id: "us-frs-" },
			{ displayLabel: "\u0000" },
			{ displayLabel: "😀".repeat(81) },
			{ sourceReferenceIds: [] },
			{ sourceReferenceIds: ["test-source", "test-source"] },
		]) {
			const stored = synthetic(2)
			// The unchanged second row keeps the source cited even for empty
			// citations on the first row; no unrelated orphan rejection.
			expect(() => normalizeStoredDataset(stored)).not.toThrow()
			expect(() =>
				normalizeStoredDataset({
					...stored,
					publication: {
						...stored.publication,
						rows: [
							{ ...stored.publication.rows[0], ...patch },
							stored.publication.rows[1]!,
						],
					},
				}),
			).toThrow()
		}
		for (const display of [
			{ advisory: true, mode: "bad", bandwidthHz: null, stepHz: null },
			{ advisory: true, mode: null, bandwidthHz: 0, stepHz: null },
			{ advisory: true, mode: null, bandwidthHz: null, stepHz: 10_000_001 },
			{ advisory: true, mode: null, bandwidthHz: null, stepHz: -0 },
		]) {
			const stored = synthetic(1)
			expect(() =>
				publicationDigest({
					...stored,
					publication: {
						...stored.publication,
						rows: [{ ...stored.publication.rows[0], display }],
					},
				}),
			).toThrow()
		}
		expect(() => normalizeStoredDataset(synthetic(129))).toThrow()
		const max = synthetic(128)
		expect(() => createRegionalRegistry(registration(max))).not.toThrow()
	})
	it("all exact structural maxima and their next boundaries reject atomically", () => {
		const empty = synthetic(0)
		const reference = empty.publication.sourceReferences[0]!
		for (const count of [1, 8]) {
			const stored = synthetic(0)
			stored.publication.sourceReferences = Array.from(
				{ length: count },
				(_, index) => ({ ...reference, id: `test-source-${index}` }),
			)
			expect(() => createRegionalRegistry(registration(stored))).not.toThrow()
		}
		for (const count of [0, 9])
			expect(() =>
				normalizeStoredDataset({
					...empty,
					publication: {
						...empty.publication,
						sourceReferences: Array.from({ length: count }, (_, index) => ({
							...reference,
							id: `test-source-${index}`,
						})),
					},
				}),
			).toThrow()
		const stored = synthetic(1)
		stored.publication.sourceReferences = Array.from(
			{ length: 4 },
			(_, index) => ({ ...reference, id: `test-source-${index}` }),
		)
		const row = stored.publication.rows[0]!
		row.sourceReferenceIds = stored.publication.sourceReferences.map(
			source => source.id,
		)
		row.id = "us-frs-" + "x".repeat(57)
		row.aliases = Array.from({ length: 8 }, (_, index) =>
			`test-${index}`.padEnd(32, "x"),
		)
		row.displayLabel = "😀".repeat(80)
		row.display = {
			advisory: true,
			mode: "unknown",
			bandwidthHz: 10_000_000,
			stepHz: 10_000_000,
		}
		stored.publication.datasetVersion = "x".repeat(32)
		for (const source of stored.publication.sourceReferences) {
			source.organization = "😀".repeat(120)
			source.title = "😀".repeat(120)
			source.locator = "😀".repeat(120)
			source.documentId = "x".repeat(80)
			source.edition = "x".repeat(80)
			source.publishedDate = "2024-02-29"
			source.url = "https://example.invalid/".padEnd(512, "x")
		}
		expect(() => createRegionalRegistry(registration(stored))).not.toThrow()
		for (const patch of [
			{ id: row.id + "x" },
			{ aliases: [...row.aliases, "ninth"] },
			{ aliases: ["x".repeat(33)] },
		])
			expect(() =>
				normalizeStoredDataset({
					...stored,
					publication: { ...stored.publication, rows: [{ ...row, ...patch }] },
				}),
			).toThrow()
		expect(() =>
			normalizeStoredDataset({
				...stored,
				publication: { ...stored.publication, datasetVersion: "x".repeat(33) },
			}),
		).toThrow()
		const tooLongUrl = structuredClone(stored)
		tooLongUrl.publication.sourceReferences[0]!.url =
			"https://example.invalid/".padEnd(513, "x")
		// All four existing citations/references remain intact; URL length is
		// the only new defect, rather than replacement with an unrelated source.
		expect(() => normalizeStoredDataset(tooLongUrl)).toThrow()
		const citationBefore = synthetic(2)
		citationBefore.publication.sourceReferences.push({
			...reference,
			id: "test-second",
		})
		for (const item of citationBefore.publication.rows)
			item.sourceReferenceIds.push("test-second")
		const citationAfter = structuredClone(citationBefore)
		citationAfter.publication.rows[0]!.sourceReferenceIds.pop()
		expect(publicationDigest(citationAfter)).not.toBe(
			publicationDigest(citationBefore),
		)
		expect(() => assertVersionCoverage(citationBefore, citationAfter)).toThrow()
	})
	it("33 complete collision declarations fail only the 32-declaration ceiling", () => {
		function completeGroups(count: number): StoredDataset {
			const stored = synthetic(count * 2)
			for (let index = 0; index < stored.publication.rows.length; index++) {
				stored.publication.rows[index]!.aliases = [
					`test-shared-${Math.floor(index / 2)}`,
				]
			}
			stored.collisions = Array.from({ length: count }, (_, index) => ({
				alias: `test-shared-${index}`,
				candidateIds: [
					stored.publication.rows[index * 2]!.id,
					stored.publication.rows[index * 2 + 1]!.id,
				],
			}))
			return stored
		}
		const allowed = completeGroups(32)
		expect(() => normalizeStoredDataset(allowed)).not.toThrow()
		expect(() => createRegionalRegistry(registration(allowed))).not.toThrow()
		const over = completeGroups(33)
		// All 66 rows and 33 declarations have distinct IDs/aliases, each exact
		// two-row candidate set, valid source/citations and legal row/alias caps.
		expect(over.publication.rows).toHaveLength(66)
		expect(over.collisions).toHaveLength(33)
		for (const collision of over.collisions) {
			expect(
				over.publication.rows
					.filter(row => row.aliases.includes(collision.alias))
					.map(row => row.id)
					.sort(),
			).toEqual([...collision.candidateIds].sort())
		}
		// No publicationDigest helper in the rejection/setup path.
		expect(() => normalizeStoredDataset(over)).toThrow()
	})
	it("five unique existing fully cited sources fail only the four-citation ceiling", () => {
		function fullyCited(count: number): StoredDataset {
			const stored = synthetic(1)
			const source = stored.publication.sourceReferences[0]!
			stored.publication.sourceReferences = Array.from(
				{ length: count },
				(_, index) => ({ ...source, id: `test-source-${index}` }),
			)
			stored.publication.rows[0]!.sourceReferenceIds =
				stored.publication.sourceReferences.map(reference => reference.id)
			return stored
		}
		const allowed = fullyCited(4)
		expect(() => normalizeStoredDataset(allowed)).not.toThrow()
		expect(() => createRegionalRegistry(registration(allowed))).not.toThrow()
		const over = fullyCited(5)
		expect(over.publication.sourceReferences).toHaveLength(5)
		expect(
			new Set(over.publication.sourceReferences.map(reference => reference.id))
				.size,
		).toBe(5)
		expect(over.publication.rows[0]!.sourceReferenceIds).toEqual(
			over.publication.sourceReferences.map(reference => reference.id),
		)
		// Source count is below 8, every citation resolves and every source is
		// used; only the per-row citation ceiling is exceeded. Digest unchecked.
		expect(() => normalizeStoredDataset(over)).toThrow()
	})
	it("independently measures overflow and refuses actual oversized public envelopes", () => {
		expect(canonicalBytes({ text: "x".repeat(512 * 1024 - 11) }).length).toBe(
			512 * 1024,
		)
		expect(() =>
			canonicalBytes({ text: "x".repeat(512 * 1024 - 10) }),
		).toThrow()
		expect(
			canonicalBytes(
				{ text: "x".repeat(128 * 1024 - 11) },
				REGIONAL_LIMITS.responseBytes,
			).length,
		).toBe(128 * 1024)
		expect(() =>
			canonicalBytes(
				{ text: "x".repeat(128 * 1024) },
				REGIONAL_LIMITS.responseBytes,
			),
		).toThrow()
		const stored = synthetic(128)
		const sourceIds = Array.from(
			{ length: 4 },
			(_, index) => `test-source-${index}-${"x".repeat(50)}`,
		)
		const firstSource = stored.publication.sourceReferences[0]!
		stored.publication.sourceReferences = sourceIds.map(id => ({
			...firstSource,
			id,
		}))
		for (let index = 0; index < stored.publication.rows.length; index++) {
			const row = stored.publication.rows[index]!
			row.id = `us-frs-test-${index}-${"x".repeat(45)}`
			row.displayLabel = "😀".repeat(80)
			row.aliases = Array.from({ length: 8 }, (_, alias) =>
				`test-${index}-${alias}-`.padEnd(32, "x"),
			)
			row.sourceReferenceIds = [...sourceIds]
		}
		expect(Buffer.byteLength(canonicalJson(stored))).toBeGreaterThan(
			REGIONAL_LIMITS.datasetBytes,
		)
		expect(() => normalizeStoredDataset(stored)).toThrow()
		// Bring an otherwise valid dataset just below its storage bound. The
		// response adds selection/pagination and has its OWN checked bound.
		let index = 0
		while (
			Buffer.byteLength(canonicalJson(stored)) > REGIONAL_LIMITS.datasetBytes
		) {
			const row =
				stored.publication.rows[index % stored.publication.rows.length]!
			const over =
				Buffer.byteLength(canonicalJson(stored)) - REGIONAL_LIMITS.datasetBytes
			const remove = Math.min(
				[...row.displayLabel].length - 1,
				Math.ceil(over / 4),
			)
			row.displayLabel = [...row.displayLabel].slice(0, -remove).join("")
			index++
		}
		const registry = createRegionalRegistry(registration(stored))
		expect(
			Buffer.byteLength(canonicalJson(normalizeStoredDataset(stored))),
		).toBeLessThanOrEqual(REGIONAL_LIMITS.datasetBytes)
		expect(() =>
			registry.listChannels({ region: "US", family: "frs", limit: 128 }),
		).toThrow(expect.objectContaining({ code: "REGIONAL_UNAVAILABLE" }))
	})
})
