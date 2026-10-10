import fc from "fast-check"
import { createEmptySnapshot } from "../../../src/operator-data/domain.js"
import {
	OPERATOR_DATA_LIMITS,
	OperatorDataError,
	encodeSnapshot,
	mutationSchema,
	parseMutation,
	savedFrequencyInputSchema,
	snapshotSchema,
	validateSnapshot,
} from "../../../src/operator-data/schema.js"
import type { OperatorDataSnapshot } from "../../../src/operator-data/schema.js"

const storeId = "00000000-0000-4000-8000-000000000001"
const id = "00000000-0000-4000-8000-000000000002"
const time = "2026-01-01T00:00:00.000Z"
const expected = { storeId, revision: 0 }
const frequency = {
	name: "Air",
	frequencyHz: 118_000_000,
	mode: "am",
	bandwidthHz: 12_000,
	tone: { kind: "none" },
} as const
const preset = { ...frequency, id, createdAt: time, updatedAt: time }
function errorCode(fn: () => unknown, code: string, statusCode: number) {
	try {
		fn()
		expect.fail("Expected a feature error")
	} catch (error) {
		expect(error).toBeInstanceOf(OperatorDataError)
		expect(error).toMatchObject({ code, statusCode })
	}
}

describe("operator-data schema", () => {
	it("validates only v1 strict snapshots and rejects reserved/operational fields at every boundary", () => {
		const empty = createEmptySnapshot(storeId)
		expect(
			snapshotSchema.safeParse({
				...empty,
				storeId: "ABCDEFAB-1234-4000-8000-ABCDEFABCDEF",
			}).success,
		).toBe(false)
		for (const field of [
			"stationLocation",
			"scanner",
			"sources",
			"retention",
			"language",
		]) {
			expect(
				snapshotSchema.safeParse({ ...empty, [field]: null }).success,
			).toBe(false)
			expect(
				mutationSchema.safeParse({
					type: "patch-preferences",
					expected,
					set: { [field]: true },
				}).success,
			).toBe(false)
		}
		expect(snapshotSchema.safeParse({ ...empty, version: 2 }).success).toBe(
			false,
		)
		expect(
			savedFrequencyInputSchema.safeParse({ ...frequency, id }).success,
		).toBe(false)
		expect(
			savedFrequencyInputSchema.safeParse({
				...frequency,
				tone: { kind: "none", detected: true },
			}).success,
		).toBe(false)
		errorCode(
			() => parseMutation({ type: "reset-command-usage" }),
			"OPERATOR_DATA_PRECONDITION_REQUIRED",
			428,
		)
		errorCode(
			() => parseMutation({ type: "reset-command-usage", expected: null }),
			"OPERATOR_DATA_INVALID",
			400,
		)
		errorCode(
			() =>
				parseMutation({
					type: "reset-command-usage",
					expected: { ...expected, extra: 1 },
				}),
			"OPERATOR_DATA_INVALID",
			400,
		)
		errorCode(
			() =>
				parseMutation({
					type: "report-command-usage",
					expected,
					command: "shell",
					args: "secret",
				}),
			"OPERATOR_DATA_INVALID",
			400,
		)
	})

	// Feature: operator-data, Property 1: Validation closure
	// Validates: Requirements 1.1, 1.3, 2.1, 2.3, 4.6
	it("bounds Unicode by code points, normalizes request whitespace, and closes validation over generated records", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 1, max: 128 }),
				fc.integer({ min: 1, max: 100_000_000_000 }),
				(length, frequencyHz) => {
					const name = "📡".repeat(length)
					const result = savedFrequencyInputSchema.safeParse({
						...frequency,
						frequencyHz,
						name: ` ${name} `,
					})
					expect(result.success).toBe(true)
					if (!result.success) return
					expect(result.data.name).toBe(name)
					expect(
						snapshotSchema.safeParse({
							...createEmptySnapshot(storeId),
							revision: 1,
							savedFrequencies: [
								{ ...result.data, id, createdAt: time, updatedAt: time },
							],
						}).success,
					).toBe(true)
					expect(
						savedFrequencyInputSchema.safeParse({
							...frequency,
							name: "📡".repeat(129),
						}).success,
					).toBe(false)
				},
			),
			{ numRuns: 100 },
		)
		for (const name of [
			"",
			"   ",
			"a\n",
			"a\t",
			"a\u0000b",
			"a\u007fb",
			"a\u0085b",
			"\ud800",
		])
			expect(
				savedFrequencyInputSchema.safeParse({ ...frequency, name }).success,
			).toBe(false)
		expect(
			savedFrequencyInputSchema.safeParse({ ...frequency, name: "👩‍🔬" }).success,
		).toBe(true)
		expect(
			savedFrequencyInputSchema.safeParse({
				...frequency,
				group: "📡".repeat(64),
			}).success,
		).toBe(true)
		expect(
			savedFrequencyInputSchema.safeParse({
				...frequency,
				group: "📡".repeat(65),
			}).success,
		).toBe(false)
		expect(
			snapshotSchema.safeParse({
				...createEmptySnapshot(storeId),
				revision: 1,
				savedFrequencies: [{ ...preset, name: " Air " }],
			}).success,
		).toBe(false)
	})

	it("enforces stored RF/tone rules without hardware capability claims", () => {
		const accepted = [
			{ ...frequency, mode: "raw", bandwidthHz: 0 },
			{
				...frequency,
				mode: "nfm",
				tone: { kind: "ctcss", frequencyTenthsHz: 600 },
			},
			{
				...frequency,
				mode: "nfm",
				tone: { kind: "ctcss", frequencyTenthsHz: 3000 },
			},
			{
				...frequency,
				mode: "nfm",
				tone: { kind: "dcs", code: "023", polarity: "inverted" },
			},
		]
		for (const value of accepted)
			expect(savedFrequencyInputSchema.safeParse(value).success).toBe(true)
		for (const value of [
			{ ...frequency, bandwidthHz: 0 },
			{ ...frequency, mode: "raw" },
			{ ...frequency, tone: { kind: "ctcss", frequencyTenthsHz: 1000 } },
			{
				...frequency,
				mode: "nfm",
				tone: { kind: "ctcss", frequencyTenthsHz: 599 },
			},
			{
				...frequency,
				mode: "nfm",
				tone: { kind: "ctcss", frequencyTenthsHz: 3001 },
			},
			{
				...frequency,
				mode: "nfm",
				tone: { kind: "ctcss", frequencyTenthsHz: 1000.1 },
			},
			...["23", "0230", "028", 23].map(code => ({
				...frequency,
				mode: "nfm",
				tone: { kind: "dcs", code, polarity: "normal" },
			})),
			{ ...frequency, frequencyHz: 0 },
			{ ...frequency, frequencyHz: 100_000_000_001 },
			{ ...frequency, frequencyHz: 1.1 },
			{ ...frequency, bandwidthHz: 10_000_001 },
		])
			expect(savedFrequencyInputSchema.safeParse(value).success).toBe(false)
	})

	it("rejects empty/overlapping/duplicate preference patches", () => {
		for (const patch of [
			{},
			{ set: {} },
			{ reset: [] },
			{ reset: ["units", "units"] },
			{ set: { units: "metric" }, reset: ["units"] },
			{ set: { units: undefined } },
		]) {
			expect(
				mutationSchema.safeParse({
					type: "patch-preferences",
					expected,
					...patch,
				}).success,
			).toBe(false)
		}
		expect(
			parseMutation({
				type: "patch-preferences",
				expected,
				reset: ["units"],
				set: { timeFormat: "utc" },
			}),
		).toMatchObject({ reset: ["units"] })
	})

	it("validates aggregate uniqueness, references, revisions, dates and ranking order", () => {
		const usage = {
			command: "tune",
			savedFrequencyId: id,
			count: 1,
			lastUsedAt: time,
			lastUsedRevision: 1,
		} as const
		const base = {
			...createEmptySnapshot(storeId),
			revision: 2,
			savedFrequencies: [preset],
			commandUsage: [usage],
		}
		expect(validateSnapshot(base)).toEqual(base)
		const invalid = [
			{ ...base, savedFrequencies: [preset, preset] },
			{ ...base, commandUsage: [usage, usage] },
			{ ...base, savedFrequencies: [] },
			{ ...base, commandUsage: [{ ...usage, savedFrequencyId: undefined }] },
			{
				...base,
				commandUsage: [
					{
						...usage,
						command: "open-saved-frequency",
						savedFrequencyId: undefined,
					},
				],
			},
			{ ...base, commandUsage: [{ ...usage, lastUsedRevision: 0 }] },
			{ ...base, commandUsage: [{ ...usage, lastUsedRevision: 3 }] },
			{
				...base,
				commandUsage: [{ ...usage, lastUsedAt: "2025-01-01T00:00:00Z" }],
			},
			{
				...base,
				commandUsage: [
					usage,
					{ ...usage, command: "listen", lastUsedRevision: 2 },
				],
			},
			{
				...base,
				savedFrequencies: [{ ...preset, updatedAt: "2025-01-01T00:00:00Z" }],
			},
			{
				...base,
				savedFrequencies: [{ ...preset, createdAt: "2026-02-30T00:00:00Z" }],
			},
			{
				...base,
				savedFrequencies: [
					{ ...preset, createdAt: "2026-01-01T00:00:00+00:00" },
				],
			},
			{ ...base, revision: Number.MAX_SAFE_INTEGER + 1 },
		]
		for (const value of invalid)
			expect(snapshotSchema.safeParse(value).success).toBe(false)
	})

	it("accepts quota edges and bounds UTF-8 JSON including encoding overhead", () => {
		const base = createEmptySnapshot(storeId)
		const savedFrequencies = Array.from({ length: 256 }, (_, index) => ({
			...preset,
			id: `00000000-0000-4000-8000-${String(index + 10).padStart(12, "0")}`,
			name: "📡".repeat(128),
			group: "📡".repeat(64),
		}))
		const commandUsage = savedFrequencies.slice(0, 64).map((value, index) => ({
			command: "tune" as const,
			savedFrequencyId: value.id,
			count: 1_000_000,
			lastUsedAt: time,
			lastUsedRevision: 64 - index,
		}))
		const snapshot: OperatorDataSnapshot = {
			...base,
			revision: 64,
			savedFrequencies,
			commandUsage,
		}
		const encoded = encodeSnapshot(snapshot)
		expect(Buffer.byteLength(encoded, "utf8")).toBeGreaterThan(encoded.length)
		expect(Buffer.byteLength(encoded, "utf8")).toBeLessThanOrEqual(
			OPERATOR_DATA_LIMITS.snapshotBytes,
		)
		errorCode(
			() =>
				validateSnapshot({
					...snapshot,
					savedFrequencies: [...savedFrequencies, { ...preset, id }],
				}),
			"OPERATOR_DATA_QUOTA",
			409,
		)
		errorCode(
			() =>
				validateSnapshot({
					...snapshot,
					commandUsage: [
						...commandUsage,
						{ ...commandUsage[0], command: "identify" },
					],
				}),
			"OPERATOR_DATA_QUOTA",
			409,
		)
		// Trimming cannot evade the bound on the original request's JSON encoding.
		errorCode(
			() =>
				parseMutation({
					type: "create-saved-frequency",
					expected,
					frequency: { ...frequency, name: `${" ".repeat(16 * 1024)}Air` },
				}),
			"OPERATOR_DATA_QUOTA",
			409,
		)
		const mutation = { type: "create-saved-frequency", expected, frequency }
		const padding =
			OPERATOR_DATA_LIMITS.requestBytes -
			Buffer.byteLength(JSON.stringify(mutation))
		expect(
			parseMutation({
				...mutation,
				frequency: { ...frequency, name: `${" ".repeat(padding)}Air` },
			}).type,
		).toBe("create-saved-frequency")
		errorCode(
			() =>
				parseMutation({
					...mutation,
					frequency: { ...frequency, name: `${" ".repeat(padding + 1)}Air` },
				}),
			"OPERATOR_DATA_QUOTA",
			409,
		)
	})
})
