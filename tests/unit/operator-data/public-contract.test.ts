import { build } from "esbuild"
import fc from "fast-check"
import { runInNewContext } from "node:vm"
import { describe, expect, expectTypeOf, it } from "vitest"
import * as publicContract from "@wavekit/api-types"
import type {
	CommandReference,
	CommandUsage,
	ExpectedToken,
	OperatorDataMutation,
	OperatorDataSnapshot,
	OperatorDataReadDto,
	OperatorDataWriteDto,
	OperatorDataErrorDto,
	PreferenceOverrides,
	SavedFrequency,
	SavedFrequencyInput,
} from "@wavekit/api-types"
import * as core from "../../../src/operator-data/schema.js"
import { createEmptySnapshot } from "../../../src/operator-data/domain.js"
import type { effectivePreferences } from "../../../src/operator-data/domain.js"
import {
	toOperatorDataErrorResponse,
	toOperatorDataReadDto,
	toOperatorDataWriteDto,
} from "../../../src/operator-data/transport.js"
import type * as transport from "../../../src/operator-data/transport.js"

const storeId = "00000000-0000-4000-8000-000000000001"
const id = "abcdefab-1234-4000-8000-abcdefabcdef"
const time = "2026-01-01T00:00:00.000Z"
const expected = { storeId, revision: 0 }
const frequency = {
	name: "📡 Repeater",
	frequencyHz: 145_500_000,
	mode: "nfm",
	bandwidthHz: 12_500,
	tone: { kind: "dcs", code: "023", polarity: "inverted" },
} as const
function configured(): OperatorDataSnapshot {
	return {
		...createEmptySnapshot(storeId),
		revision: 1,
		savedFrequencies: [{ ...frequency, id, createdAt: time, updatedAt: time }],
		preferenceOverrides: { units: "metric", showSavedFrequencyLabels: false },
		commandUsage: [
			{
				command: "open-saved-frequency",
				savedFrequencyId: id,
				count: 1,
				lastUsedAt: time,
				lastUsedRevision: 1,
			},
		],
	}
}
function atByteLimit(): OperatorDataSnapshot {
	const snapshot = configured()
	const remaining =
		core.OPERATOR_DATA_LIMITS.snapshotBytes -
		Buffer.byteLength(JSON.stringify(snapshot), "utf8")
	snapshot.savedFrequencies[0]!.updatedAt = time.replace(
		".000Z",
		`.000${"0".repeat(remaining)}Z`,
	)
	return snapshot
}
function expectError(action: () => unknown, code: string, statusCode: number) {
	try {
		action()
		expect.fail("Expected a core operator-data error")
	} catch (error) {
		expect(error).toBeInstanceOf(core.OperatorDataError)
		expect(error).toMatchObject({ code, statusCode })
	}
}

describe("canonical public operator-data contract", () => {
	it("reexports the same validator instances, helpers and limits used by the core", () => {
		const names = [
			"OPERATOR_DATA_LIMITS",
			"uuidSchema",
			"revisionSchema",
			"expectedTokenSchema",
			"timestampSchema",
			"modeSchema",
			"toneSchema",
			"savedFrequencyInputSchema",
			"savedFrequencySchema",
			"preferenceKeySchema",
			"preferencesSchema",
			"preferenceOverridesSchema",
			"commandSchema",
			"commandReferenceSchema",
			"commandUsageSchema",
			"commandUsageKey",
			"compareCommandUsage",
			"snapshotSchema",
			"mutationSchema",
		] as const
		for (const name of names) expect(core[name]).toBe(publicContract[name])
	})

	it("keeps public inferred types compatible with existing core and mapper consumers", () => {
		expectTypeOf<ExpectedToken>().toEqualTypeOf<core.ExpectedToken>()
		expectTypeOf<SavedFrequencyInput>().toEqualTypeOf<core.SavedFrequencyInput>()
		expectTypeOf<SavedFrequency>().toEqualTypeOf<core.SavedFrequency>()
		expectTypeOf<PreferenceOverrides>().toEqualTypeOf<core.PreferenceOverrides>()
		expectTypeOf<CommandReference>().toEqualTypeOf<core.CommandReference>()
		expectTypeOf<CommandUsage>().toEqualTypeOf<core.CommandUsage>()
		expectTypeOf<OperatorDataSnapshot>().toEqualTypeOf<core.OperatorDataSnapshot>()
		expectTypeOf<OperatorDataMutation>().toEqualTypeOf<core.OperatorDataMutation>()
		expectTypeOf<OperatorDataReadDto>().toEqualTypeOf<transport.OperatorDataReadDto>()
		expectTypeOf<OperatorDataWriteDto>().toEqualTypeOf<transport.OperatorDataWriteDto>()
		expectTypeOf<OperatorDataErrorDto>().toEqualTypeOf<transport.OperatorDataErrorDto>()
		expectTypeOf<OperatorDataReadDto["preferences"]>().toEqualTypeOf<
			ReturnType<typeof effectivePreferences>
		>()
		// The special open command still requires its reference at compile time.
		// @ts-expect-error An open-saved-frequency reference is mandatory.
		const invalidReference: CommandReference = {
			command: "open-saved-frequency",
		}
		expect(
			publicContract.commandReferenceSchema.safeParse(invalidReference).success,
		).toBe(false)
	})

	it("accepts exact existing read/write outputs without exposing changed or delivery state", () => {
		for (const snapshot of [createEmptySnapshot(storeId), configured()]) {
			const read = toOperatorDataReadDto(snapshot)
			expect(publicContract.operatorDataReadDtoSchema.parse(read)).toEqual(read)
			const write = toOperatorDataWriteDto({
				snapshot,
				changed: true,
				delivery: "failed",
			})
			expect(publicContract.operatorDataWriteDtoSchema.parse(write)).toEqual({
				snapshot,
			})
		}
		const snapshot = configured()
		const write = toOperatorDataWriteDto({
			snapshot,
			savedFrequencyId: id,
			changed: true,
			delivery: "sent",
		})
		expect(publicContract.operatorDataWriteDtoSchema.parse(write)).toEqual(
			write,
		)
		expect(Object.keys(write)).toEqual(["snapshot", "savedFrequencyId"])
	})

	it("rejects unknown DTO keys, incomplete preferences, unsupported capabilities and changed limits", () => {
		const read = toOperatorDataReadDto(configured())
		for (const invalid of [
			{ ...read, secret: true },
			{ ...read, preferences: { ...read.preferences, extra: true } },
			{
				...read,
				preferences: {
					...read.preferences,
					values: { ...read.preferences.values, scanner: true },
				},
			},
			{
				...read,
				preferences: { ...read.preferences, values: { units: "metric" } },
			},
			{
				...read,
				preferences: { ...read.preferences, provenance: { units: "operator" } },
			},
			{
				...read,
				preferences: {
					...read.preferences,
					provenance: { ...read.preferences.provenance, units: "yaml" },
				},
			},
			{ ...read, capabilities: { ...read.capabilities, toneDetection: true } },
			{ ...read, capabilities: { ...read.capabilities, toneSelection: false } },
			{ ...read, capabilities: { ...read.capabilities, toneSquelch: true } },
			{ ...read, capabilities: { ...read.capabilities, extra: false } },
			{ ...read, limits: { ...read.limits, snapshotBytes: 1024 * 1024 } },
			{ ...read, limits: { ...read.limits, extra: 1 } },
			{ ...read, snapshot: { ...read.snapshot, stationLocation: null } },
		])
			expect(
				publicContract.operatorDataReadDtoSchema.safeParse(invalid).success,
			).toBe(false)
	})

	it("requires canonical live write references and rejects internal result fields", () => {
		const snapshot = configured()
		for (const savedFrequencyId of [
			undefined,
			storeId,
			id.toUpperCase(),
			"invalid",
		]) {
			expect(
				publicContract.operatorDataWriteDtoSchema.safeParse({
					snapshot,
					savedFrequencyId,
				}).success,
			).toBe(false)
		}
		for (const internal of [{ changed: false }, { delivery: "failed" }])
			expect(
				publicContract.operatorDataWriteDtoSchema.safeParse({
					snapshot,
					...internal,
				}).success,
			).toBe(false)
	})

	it.each(publicContract.operatorDataErrorCodeSchema.options)(
		"closes %s over canonical messages and token-only conflict details",
		code => {
			const error = new core.OperatorDataError(code, expected)
			Object.assign(error, {
				message: "secret path",
				name: "PrivateError",
				statusCode: 200,
				details: { secret: true },
			})
			const response = toOperatorDataErrorResponse(error)
			expect(response.statusCode).toBe(
				publicContract.OPERATOR_DATA_ERROR_DEFINITIONS[code][0],
			)
			expect(
				publicContract.operatorDataErrorDtoSchema.parse(response.body),
			).toEqual(response.body)
			expect(JSON.stringify(response)).not.toMatch(/secret|PrivateError|stack/)
			for (const invalid of [
				{ ...response.body, error: "PrivateError" },
				{ ...response.body, code: "toString" },
				{ ...response.body, message: "secret path" },
				{ ...response.body, stack: "secret" },
				{
					...response.body,
					details: { current: { ...expected, secret: true } },
				},
				{ ...response.body, details: { current: expected, secret: true } },
				{ ...response.body, details: undefined },
			])
				expect(
					publicContract.operatorDataErrorDtoSchema.safeParse(invalid).success,
				).toBe(false)
			if (code !== "OPERATOR_DATA_CONFLICT")
				expect(
					publicContract.operatorDataErrorDtoSchema.safeParse({
						...response.body,
						details: { current: expected },
					}).success,
				).toBe(false)
			// A different code's otherwise-canonical message must still fail.
			const other =
				code === "OPERATOR_DATA_INVALID"
					? "OPERATOR_DATA_BUSY"
					: "OPERATOR_DATA_INVALID"
			expect(
				publicContract.operatorDataErrorDtoSchema.safeParse({
					...response.body,
					message: publicContract.OPERATOR_DATA_ERROR_DEFINITIONS[other][1],
				}).success,
			).toBe(false)
		},
	)

	it("accepts conflict responses without details when internal tokens are absent or malformed", () => {
		for (const current of [
			undefined,
			null,
			{ ...expected, secret: true },
			{ ...expected, revision: -1 },
		]) {
			const error = new core.OperatorDataError("OPERATOR_DATA_CONFLICT")
			Object.assign(error, { current })
			const response = toOperatorDataErrorResponse(error)
			expect(response.statusCode).toBe(409)
			expect(Object.hasOwn(response.body, "details")).toBe(false)
			expect(
				publicContract.operatorDataErrorDtoSchema.parse(response.body),
			).toEqual(response.body)
		}
		const response = toOperatorDataErrorResponse(new Error("private path"))
		expect(
			publicContract.operatorDataErrorDtoSchema.parse(response.body),
		).toEqual(response.body)
	})

	it("retains strict aggregate and special command refinements through public validation", () => {
		const snapshot = configured()
		const preset = snapshot.savedFrequencies[0]!
		const usage = snapshot.commandUsage[0]!
		for (const invalid of [
			{ ...snapshot, savedFrequencies: [preset, preset] },
			{ ...snapshot, commandUsage: [usage, usage] },
			{ ...snapshot, savedFrequencies: [] },
			{ ...snapshot, savedFrequencies: [{ ...preset, name: " untrimmed " }] },
			{ ...snapshot, savedFrequencies: [{ ...preset, mode: "raw" }] },
			{ ...snapshot, savedFrequencies: [{ ...preset, mode: "am" }] },
			{
				...snapshot,
				savedFrequencies: [{ ...preset, createdAt: "2026-02-30T00:00:00Z" }],
			},
			{
				...snapshot,
				savedFrequencies: [{ ...preset, updatedAt: "2025-01-01T00:00:00Z" }],
			},
			{
				...snapshot,
				commandUsage: [{ ...usage, lastUsedAt: "2025-01-01T00:00:00Z" }],
			},
			{ ...snapshot, commandUsage: [{ ...usage, lastUsedRevision: 2 }] },
			{
				...snapshot,
				commandUsage: [
					usage,
					{ ...usage, command: "identify", lastUsedRevision: 2 },
				],
				revision: 2,
			},
			{
				...snapshot,
				commandUsage: [{ ...usage, savedFrequencyId: undefined }],
			},
		]) {
			expect(publicContract.snapshotSchema.safeParse(invalid).success).toBe(
				false,
			)
			expectError(
				() => core.validateSnapshot(invalid),
				"OPERATOR_DATA_INVALID",
				400,
			)
		}
		for (const mutation of [
			{
				type: "report-command-usage",
				expected,
				command: "open-saved-frequency",
			},
			{ type: "patch-preferences", expected, reset: ["units", "units"] },
			{ type: "patch-preferences", expected, set: { units: undefined } },
			{
				type: "patch-preferences",
				expected,
				set: { units: "metric" },
				reset: ["units"],
			},
		])
			expect(publicContract.mutationSchema.safeParse(mutation).success).toBe(
				false,
			)
	})

	it("preserves core missing-token 428 and count/request-byte quota classification", () => {
		for (const missing of [
			{ type: "reset-command-usage" },
			{ type: "reset-command-usage", expected: undefined },
		])
			expectError(
				() => core.parseMutation(missing),
				"OPERATOR_DATA_PRECONDITION_REQUIRED",
				428,
			)
		expectError(
			() => core.parseMutation({ type: "reset-command-usage", expected: null }),
			"OPERATOR_DATA_INVALID",
			400,
		)
		const snapshot = configured()
		expectError(
			() =>
				core.validateSnapshot({
					...snapshot,
					savedFrequencies: Array.from(
						{ length: 257 },
						() => snapshot.savedFrequencies[0],
					),
				}),
			"OPERATOR_DATA_QUOTA",
			409,
		)
		expectError(
			() =>
				core.validateSnapshot({
					...snapshot,
					commandUsage: Array.from(
						{ length: 65 },
						() => snapshot.commandUsage[0],
					),
				}),
			"OPERATOR_DATA_QUOTA",
			409,
		)
		const mutation = { type: "create-saved-frequency", expected, frequency }
		const padding =
			core.OPERATOR_DATA_LIMITS.requestBytes -
			Buffer.byteLength(JSON.stringify(mutation), "utf8")
		const atLimit = {
			...mutation,
			frequency: {
				...frequency,
				name: `${" ".repeat(padding)}${frequency.name}`,
			},
		}
		expect(Buffer.byteLength(JSON.stringify(atLimit), "utf8")).toBe(16_384)
		expect(core.parseMutation(atLimit)).toMatchObject({
			frequency: { name: frequency.name },
		})
		expectError(
			() =>
				core.parseMutation({
					...atLimit,
					frequency: {
						...atLimit.frequency,
						name: ` ${atLimit.frequency.name}`,
					},
				}),
			"OPERATOR_DATA_QUOTA",
			409,
		)
	})

	// Feature: operator-data, Property 1: Validation closure
	// Validates: Requirements 1.1, 4.6
	it("matches Buffer UTF-8 bytes for multibyte/control/surrogate JSON across 100 property cases", () => {
		const encoder = new TextEncoder()
		fc.assert(
			fc.property(
				fc.array(fc.integer({ min: 0, max: 0xffff }), { maxLength: 256 }),
				units => {
					const value = `${String.fromCharCode(...units)}📡é\n\u0000\ud800\udfff`
					for (const text of [value, JSON.stringify({ value })])
						expect(encoder.encode(text).byteLength).toBe(
							Buffer.byteLength(text, "utf8"),
						)
				},
			),
			{ numRuns: 100 },
		)
	})

	it("accepts exactly 524288 UTF-8 snapshot bytes and rejects the next byte without repair", () => {
		const snapshot = atByteLimit()
		const json = core.encodeSnapshot(snapshot)
		expect(new TextEncoder().encode(json).byteLength).toBe(524_288)
		expect(Buffer.byteLength(json, "utf8")).toBe(524_288)
		const dto = toOperatorDataReadDto(snapshot)
		expect(publicContract.operatorDataReadDtoSchema.parse(dto)).toEqual(dto)
		snapshot.savedFrequencies[0]!.updatedAt =
			snapshot.savedFrequencies[0]!.updatedAt.replace("Z", "0Z")
		const result = publicContract.snapshotSchema.safeParse(snapshot)
		expect(result.success).toBe(false)
		if (!result.success)
			expect(result.error.issues).toContainEqual(
				expect.objectContaining({ code: "custom", params: { quota: true } }),
			)
		expectError(
			() => core.validateSnapshot(snapshot),
			"OPERATOR_DATA_QUOTA",
			409,
		)
	})

	it("bundles the actual built package for browsers and validates at runtime with no Node globals", async () => {
		const bundle = await build({
			stdin: {
				contents: 'export * from "@wavekit/api-types"',
				resolveDir: process.cwd(),
			},
			bundle: true,
			platform: "browser",
			format: "iife",
			globalName: "OperatorPublic",
			write: false,
			metafile: true,
		})
		expect(Object.keys(bundle.metafile!.inputs)).toContain(
			"packages/api-types/dist/operator-data.js",
		)
		expect(
			Object.keys(bundle.metafile!.inputs).some(
				path => path.startsWith("src/") || path.startsWith("node:"),
			),
		).toBe(false)
		const source = bundle.outputFiles[0]!.text
		const result: unknown = runInNewContext(
			`${source}\nJSON.stringify({
			buffer: typeof Buffer, process: typeof process, require: typeof require,
			valid: OperatorPublic.operatorDataReadDtoSchema.safeParse(input).success,
			invalid: OperatorPublic.snapshotSchema.safeParse({ ...input.snapshot, version: 2 }).success,
			mutation: OperatorPublic.mutationSchema.safeParse({ type: "reset-command-usage", expected: token }).success,
			error: OperatorPublic.operatorDataErrorDtoSchema.safeParse(error).success,
		})`,
			{
				TextEncoder,
				input: toOperatorDataReadDto(atByteLimit()),
				token: expected,
				error: toOperatorDataErrorResponse(undefined).body,
			},
		)
		expect(result).toBe(
			JSON.stringify({
				buffer: "undefined",
				process: "undefined",
				require: "undefined",
				valid: true,
				invalid: false,
				mutation: true,
				error: true,
			}),
		)
	})
})
