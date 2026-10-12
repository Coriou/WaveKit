import fc from "fast-check"
import { describe, expect, it } from "vitest"
import {
	createEmptySnapshot,
	effectivePreferences,
	PREFERENCE_DEFAULTS,
	snapshotToken,
	transition,
} from "../../../src/operator-data/domain.js"
import {
	OPERATOR_DATA_LIMITS,
	OperatorDataError,
	commandUsageKey,
	encodeSnapshot,
	parseMutation,
	validateSnapshot,
} from "../../../src/operator-data/schema.js"
import type { DomainContext } from "../../../src/operator-data/domain.js"
import type {
	OperatorDataSnapshot,
	SavedFrequencyInput,
} from "../../../src/operator-data/schema.js"

const storeId = "00000000-0000-4000-8000-000000000001"
const time = "2026-01-01T00:00:00.000Z"
const frequency: SavedFrequencyInput = {
	name: "Air",
	frequencyHz: 118_000_000,
	mode: "am",
	bandwidthHz: 12_000,
	tone: { kind: "none" },
}
function context(): DomainContext {
	let index = 1
	return {
		now: () => time,
		uuid: () => `00000000-0000-4000-8000-${String(++index).padStart(12, "0")}`,
	}
}
function create(
	snapshot: OperatorDataSnapshot,
	ctx: DomainContext,
	value = frequency,
) {
	return transition(
		snapshot,
		{
			type: "create-saved-frequency",
			expected: snapshotToken(snapshot),
			frequency: value,
		},
		ctx,
	)
}
function report(
	snapshot: OperatorDataSnapshot,
	ctx: DomainContext,
	savedFrequencyId?: string,
) {
	return transition(
		snapshot,
		{
			type: "report-command-usage",
			expected: snapshotToken(snapshot),
			command: "tune",
			...(savedFrequencyId ? { savedFrequencyId } : {}),
		},
		ctx,
	).snapshot
}
function fail(fn: () => unknown, code: string) {
	try {
		fn()
		expect.fail("Expected a feature error")
	} catch (error) {
		expect(error).toBeInstanceOf(OperatorDataError)
		expect(error).toMatchObject({ code })
	}
}

describe("operator-data transitions", () => {
	// Feature: operator-data, Property 2: Stable identity
	// Validates: Requirements 1.2, 1.5
	it("preserves identity/creation order through replacement and deletes only exact references", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 1, max: 100_000_000_000 }),
				newFrequency => {
					const ctx = context()
					const first = create(createEmptySnapshot(storeId), ctx)
					const second = create(first.snapshot, ctx)
					const id = first.savedFrequencyId!
					const otherId = second.savedFrequencyId!
					let current = report(
						report(report(second.snapshot, ctx, id), ctx, otherId),
						ctx,
					)
					const replacement = transition(
						current,
						{
							type: "replace-saved-frequency",
							expected: snapshotToken(current),
							id,
							frequency: { ...frequency, frequencyHz: newFrequency },
						},
						ctx,
					)
					expect(replacement.snapshot.savedFrequencies[0]).toMatchObject({
						id,
						createdAt: time,
						frequencyHz: newFrequency,
					})
					expect(
						replacement.snapshot.savedFrequencies.map(value => value.id),
					).toEqual([id, otherId])
					current = transition(
						replacement.snapshot,
						{
							type: "delete-saved-frequency",
							expected: snapshotToken(replacement.snapshot),
							id,
						},
						ctx,
					).snapshot
					expect(current.savedFrequencies).toEqual([
						second.snapshot.savedFrequencies[1],
					])
					expect(
						current.commandUsage.map(value => value.savedFrequencyId),
					).toEqual([undefined, otherId])
					fail(
						() =>
							transition(
								current,
								{
									type: "replace-saved-frequency",
									expected: snapshotToken(current),
									id,
									frequency,
								},
								ctx,
							),
						"OPERATOR_DATA_NOT_FOUND",
					)
					fail(
						() =>
							transition(
								current,
								{
									type: "delete-saved-frequency",
									expected: snapshotToken(current),
									id,
								},
								ctx,
							),
						"OPERATOR_DATA_NOT_FOUND",
					)
					fail(() => report(current, ctx, id), "OPERATOR_DATA_NOT_FOUND")
				},
			),
			{ numRuns: 100 },
		)
	})

	// Feature: operator-data, Property 3: CAS isolation
	// Validates: Requirements 3.1, 3.2, 3.3
	it("simulates serialized competing CAS writes and rejects stale no-ops before lookup", () => {
		fc.assert(
			fc.property(fc.boolean(), choice => {
				const ctx = context()
				const original = createEmptySnapshot(storeId)
				const expected = snapshotToken(original)
				const winner = transition(
					original,
					{
						type: "patch-preferences",
						expected,
						set: { showSavedFrequencyLabels: choice },
					},
					ctx,
				)
				const before = encodeSnapshot(winner.snapshot)
				for (const mutation of [
					{
						type: "patch-preferences",
						expected,
						set: { showSavedFrequencyLabels: choice },
					},
					{ type: "reset-command-usage", expected },
					{ type: "create-saved-frequency", expected, frequency },
					{ type: "delete-saved-frequency", expected, id: storeId },
				]) {
					try {
						transition(winner.snapshot, parseMutation(mutation), ctx)
						expect.fail("Expected conflict")
					} catch (error) {
						expect(error).toMatchObject({
							code: "OPERATOR_DATA_CONFLICT",
							statusCode: 409,
							current: snapshotToken(winner.snapshot),
						})
					}
				}
				expect(encodeSnapshot(winner.snapshot)).toBe(before)
				expect(original.revision).toBe(0)
				const otherStore = {
					...expected,
					storeId: "00000000-0000-4000-8000-000000000099",
				}
				fail(
					() =>
						transition(
							original,
							{ type: "reset-command-usage", expected: otherStore },
							ctx,
						),
					"OPERATOR_DATA_CONFLICT",
				)
			}),
			{ numRuns: 100 },
		)
	})

	// Feature: operator-data, Property 4: Revision monotonicity
	// Validates: Requirements 3.3, 3.4
	it("increments once per change and retains stored overrides distinct from defaults", () => {
		fc.assert(
			fc.property(
				fc.array(fc.boolean(), { minLength: 1, maxLength: 40 }),
				values => {
					const ctx = context()
					let current = createEmptySnapshot(storeId)
					for (const value of values) {
						const before = current.revision
						const shouldChange =
							current.preferenceOverrides.showSavedFrequencyLabels !== value
						const result = transition(
							current,
							{
								type: "patch-preferences",
								expected: snapshotToken(current),
								set: { showSavedFrequencyLabels: value },
							},
							ctx,
						)
						expect(result.changed).toBe(shouldChange)
						expect(result.snapshot.revision).toBe(
							before + (shouldChange ? 1 : 0),
						)
						current = result.snapshot
						expect(
							effectivePreferences(current).provenance.showSavedFrequencyLabels,
						).toBe("operator")
					}
					const reset = transition(
						current,
						{
							type: "patch-preferences",
							expected: snapshotToken(current),
							reset: ["showSavedFrequencyLabels"],
						},
						ctx,
					)
					expect(reset.changed).toBe(true)
					expect(effectivePreferences(reset.snapshot)).toEqual({
						values: PREFERENCE_DEFAULTS,
						provenance: {
							units: "default",
							timeFormat: "default",
							waterfallPalette: "default",
							showSavedFrequencyLabels: "default",
						},
					})
					expect(
						transition(
							reset.snapshot,
							{
								type: "patch-preferences",
								expected: snapshotToken(reset.snapshot),
								reset: ["showSavedFrequencyLabels"],
							},
							ctx,
						).changed,
					).toBe(false)
				},
			),
			{ numRuns: 100 },
		)
	})

	it("clamps per-record wall clocks while ranking remains ordered by revision", () => {
		const ctx = context()
		let current = create(createEmptySnapshot(storeId), ctx).snapshot
		const id = current.savedFrequencies[0]!.id
		const future = { ...ctx, now: () => "2030-01-01T00:00:00Z" }
		current = transition(
			current,
			{
				type: "replace-saved-frequency",
				expected: snapshotToken(current),
				id,
				frequency: { ...frequency, name: "Future" },
			},
			future,
		).snapshot
		current = transition(
			current,
			{
				type: "replace-saved-frequency",
				expected: snapshotToken(current),
				id,
				frequency,
			},
			ctx,
		).snapshot
		expect(current.savedFrequencies[0]!.updatedAt).toBe(
			"2030-01-01T00:00:00.000Z",
		)
		current = report(current, future, id)
		current = report(current, { ...ctx, now: () => "2020-01-01T00:00:00Z" }, id)
		expect(current.commandUsage[0]!.lastUsedAt).toBe("2030-01-01T00:00:00.000Z")
		current = transition(
			current,
			{
				type: "report-command-usage",
				expected: snapshotToken(current),
				command: "identify",
			},
			ctx,
		).snapshot
		expect(current.commandUsage.map(value => value.command)).toEqual([
			"identify",
			"tune",
		])
		expect(Date.parse(current.commandUsage[0]!.lastUsedAt)).toBeLessThan(
			Date.parse(current.commandUsage[1]!.lastUsedAt),
		)
		expect(validateSnapshot(current)).toEqual(current)
	})

	it("handles invalid generated IDs, collisions, malformed server clocks, quotas and max revision", () => {
		const ctx = context()
		const empty = createEmptySnapshot(storeId)
		const first = create(empty, ctx)
		for (const uuid of ["invalid", storeId, first.savedFrequencyId!])
			fail(
				() => create(first.snapshot, { ...ctx, uuid: () => uuid }),
				"OPERATOR_DATA_INVALID",
			)
		fail(
			() => create(empty, { ...ctx, now: () => "bad" }),
			"OPERATOR_DATA_INVALID",
		)
		fail(
			() =>
				transition(
					empty,
					{
						type: "create-saved-frequency",
						expected: snapshotToken(empty),
						frequency: { ...frequency, frequencyHz: -1 },
					},
					ctx,
				),
			"OPERATOR_DATA_INVALID",
		)
		const maximum = { ...first.snapshot, revision: Number.MAX_SAFE_INTEGER }
		const noOp = transition(
			maximum,
			{
				type: "replace-saved-frequency",
				expected: snapshotToken(maximum),
				id: first.savedFrequencyId!,
				frequency,
			},
			ctx,
		)
		expect(noOp.changed).toBe(false)
		expect(noOp.snapshot.revision).toBe(Number.MAX_SAFE_INTEGER)
		expect(
			transition(
				maximum,
				{ type: "reset-command-usage", expected: snapshotToken(maximum) },
				ctx,
			).changed,
		).toBe(false)
		fail(() => create(maximum, ctx), "OPERATOR_DATA_QUOTA")
		fail(() => report(maximum, ctx), "OPERATOR_DATA_QUOTA")
		const full = {
			...empty,
			revision: 256,
			savedFrequencies: Array.from({ length: 256 }, (_, index) => ({
				...frequency,
				id: `00000000-0000-4000-8000-${String(index + 10).padStart(12, "0")}`,
				createdAt: time,
				updatedAt: time,
			})),
		}
		fail(() => create(full, ctx), "OPERATOR_DATA_QUOTA")
	})

	// Feature: operator-data, Property 7: Authority isolation
	// Validates: Requirements 1.4, 2.2, 3.3
	it("detaches every returned nested value from snapshots, requests, defaults and tokens", () => {
		fc.assert(
			fc.property(fc.constantFrom("metric", "nautical", "imperial"), units => {
				const ctx = context()
				const input = {
					type: "create-saved-frequency",
					expected: snapshotToken(createEmptySnapshot(storeId)),
					frequency: {
						...frequency,
						tone: { kind: "dcs", code: "023", polarity: "normal" },
						mode: "nfm",
					},
				}
				const mutation = parseMutation(input)
				const empty = createEmptySnapshot(storeId)
				const result = transition(empty, mutation, ctx)
				result.snapshot.savedFrequencies[0]!.tone.kind = "none"
				result.snapshot.savedFrequencies[0]!.name = "Changed"
				expect(input.frequency.name).toBe("Air")
				expect(mutation).toMatchObject({
					frequency: { tone: { kind: "dcs", code: "023" } },
				})
				expect(empty.savedFrequencies).toEqual([])
				const patched = transition(
					empty,
					{
						type: "patch-preferences",
						expected: snapshotToken(empty),
						set: { units },
					},
					ctx,
				).snapshot
				const noOp = transition(
					patched,
					{ type: "reset-command-usage", expected: snapshotToken(patched) },
					ctx,
				)
				noOp.snapshot.preferenceOverrides.units = "imperial"
				expect(patched.preferenceOverrides.units).toBe(units)
				const preferences = effectivePreferences(patched)
				preferences.values.timeFormat = "utc"
				expect(PREFERENCE_DEFAULTS.timeFormat).toBe("local-24h")
				const token = snapshotToken(patched)
				token.revision = 999
				expect(patched.revision).toBe(1)
			}),
			{ numRuns: 100 },
		)
	})

	// Feature: operator-data, Property 8: Bounded ranking
	// Validates: Requirements 2.3, 4.6
	it("bounds arbitrary ranking sequences and validates every resulting reference", () => {
		const ctx = context()
		let seed = createEmptySnapshot(storeId)
		for (let index = 0; index < 70; index++) seed = create(seed, ctx).snapshot
		for (const preset of seed.savedFrequencies.slice(0, 64))
			seed = report(seed, ctx, preset.id)
		fc.assert(
			fc.property(
				fc.array(fc.integer({ min: 0, max: 69 }), {
					minLength: 1,
					maxLength: 10,
				}),
				uses => {
					let current = seed
					for (const index of uses) {
						const id = current.savedFrequencies[index]!.id
						current = report(current, ctx, id)
						expect(current.commandUsage.length).toBeLessThanOrEqual(64)
						expect(
							current.commandUsage.every(
								value => value.count <= OPERATOR_DATA_LIMITS.usageCount,
							),
						).toBe(true)
					}
					expect(validateSnapshot(current)).toEqual(current)
					expect(new Set(current.commandUsage.map(commandUsageKey)).size).toBe(
						current.commandUsage.length,
					)
				},
			),
			{ numRuns: 100 },
		)
	}, 30_000) // fast-check property run; 5 s default flaked on a loaded host

	it("evicts the deterministic oldest key, saturates count, and resets with current-token no-op", () => {
		const ctx = context()
		let current = createEmptySnapshot(storeId)
		for (let index = 0; index < 65; index++)
			current = create(current, ctx).snapshot
		const ids = current.savedFrequencies.map(value => value.id)
		for (const id of ids.slice(0, 64)) current = report(current, ctx, id)
		current = report(current, ctx, ids[0]!) // Refresh the first key: second is oldest.
		current = report(current, ctx, ids[64]!)
		expect(
			current.commandUsage.some(value => value.savedFrequencyId === ids[1]),
		).toBe(false)
		expect(current.commandUsage[0]!.savedFrequencyId).toBe(ids[64])
		current.commandUsage[0]!.count = OPERATOR_DATA_LIMITS.usageCount
		const before = current.revision
		const saturated = report(current, ctx, ids[64]!)
		expect(saturated.commandUsage[0]!.count).toBe(
			OPERATOR_DATA_LIMITS.usageCount,
		)
		expect(saturated.revision).toBe(before + 1)
		// Tied imported revisions use ascending key order; eviction drops the last key.
		const tied = {
			...current,
			commandUsage: current.commandUsage
				.map(value => ({ ...value, lastUsedRevision: 1 }))
				.sort((a, b) => commandUsageKey(a).localeCompare(commandUsageKey(b))),
		}
		const evicted = report(tied, ctx, ids[1]!)
		expect(
			evicted.commandUsage.some(
				value =>
					commandUsageKey(value) === commandUsageKey(tied.commandUsage[63]!),
			),
		).toBe(false)
		const reset = transition(
			saturated,
			{ type: "reset-command-usage", expected: snapshotToken(saturated) },
			ctx,
		)
		expect(reset.changed).toBe(true)
		expect(reset.snapshot.commandUsage).toEqual([])
		expect(
			transition(
				reset.snapshot,
				{
					type: "reset-command-usage",
					expected: snapshotToken(reset.snapshot),
				},
				ctx,
			).changed,
		).toBe(false)
	})

	it("requires exact live preset IDs for open-saved-frequency and accepts all four closed commands", () => {
		const ctx = context()
		let current = create(createEmptySnapshot(storeId), ctx).snapshot
		const id = current.savedFrequencies[0]!.id
		for (const command of [
			"tune",
			"identify",
			"listen",
			"open-saved-frequency",
		] as const) {
			current = transition(
				current,
				{
					type: "report-command-usage",
					expected: snapshotToken(current),
					command,
					savedFrequencyId: id,
				},
				ctx,
			).snapshot
		}
		expect(current.commandUsage).toHaveLength(4)
		fail(
			() =>
				transition(
					current,
					parseMutation({
						type: "report-command-usage",
						expected: snapshotToken(current),
						command: "open-saved-frequency",
						savedFrequencyId: storeId,
					}),
					ctx,
				),
			"OPERATOR_DATA_NOT_FOUND",
		)
		fail(
			() =>
				parseMutation({
					type: "report-command-usage",
					expected: snapshotToken(current),
					command: "open-saved-frequency",
				}),
			"OPERATOR_DATA_INVALID",
		)
	})
})
