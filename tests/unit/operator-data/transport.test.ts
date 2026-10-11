import { describe, expect, it } from "vitest"
import {
	createEmptySnapshot,
	PREFERENCE_DEFAULTS,
} from "../../../src/operator-data/domain.js"
import {
	OPERATOR_DATA_LIMITS,
	OperatorDataError,
} from "../../../src/operator-data/schema.js"
import type {
	OperatorDataErrorCode,
	OperatorDataSnapshot,
} from "../../../src/operator-data/schema.js"
import {
	toOperatorDataErrorResponse,
	toOperatorDataReadDto,
	toOperatorDataWriteDto,
} from "../../../src/operator-data/transport.js"

const storeId = "00000000-0000-4000-8000-000000000001"
const id = "abcdefab-1234-4000-8000-abcdefabcdef"
const time = "2026-01-01T00:00:00.000Z"
function configured(): OperatorDataSnapshot {
	return {
		...createEmptySnapshot(storeId),
		revision: 1,
		savedFrequencies: [
			{
				id,
				name: "Repeater",
				frequencyHz: 145_500_000,
				bandwidthHz: 12_500,
				mode: "nfm",
				tone: { kind: "ctcss", frequencyTenthsHz: 885 },
				createdAt: time,
				updatedAt: time,
			},
		],
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
const definitions: [OperatorDataErrorCode, number, string][] = [
	["OPERATOR_DATA_INVALID", 400, "Invalid operator data."],
	[
		"OPERATOR_DATA_PRECONDITION_REQUIRED",
		428,
		"An expected operator-data token is required.",
	],
	[
		"OPERATOR_DATA_CONFLICT",
		409,
		"Operator data changed; fetch the current snapshot.",
	],
	["OPERATOR_DATA_NOT_FOUND", 404, "Saved frequency not found."],
	["OPERATOR_DATA_QUOTA", 409, "Operator-data limit exceeded."],
	["OPERATOR_DATA_BUSY", 503, "Operator data is busy."],
	["OPERATOR_DATA_UNAVAILABLE", 503, "Operator data is unavailable."],
]
const unavailable = {
	statusCode: 503,
	body: {
		error: "OperatorDataError",
		code: "OPERATOR_DATA_UNAVAILABLE",
		message: "Operator data is unavailable.",
	},
}

describe("operator-data pure transport mappings", () => {
	it("preserves configured tone units and resolves preferences with honest metadata capabilities", () => {
		const snapshot = configured()
		const dto = toOperatorDataReadDto(snapshot)
		expect(dto).toEqual({
			snapshot,
			preferences: {
				values: {
					...PREFERENCE_DEFAULTS,
					units: "metric",
					showSavedFrequencyLabels: false,
				},
				provenance: {
					units: "operator",
					timeFormat: "default",
					waterfallPalette: "default",
					showSavedFrequencyLabels: "operator",
				},
			},
			capabilities: {
				toneSelection: true,
				toneDetection: false,
				toneSquelch: false,
			},
			limits: OPERATOR_DATA_LIMITS,
		})
		snapshot.savedFrequencies[0]!.tone = {
			kind: "dcs",
			code: "023",
			polarity: "inverted",
		}
		expect(
			toOperatorDataReadDto(snapshot).snapshot.savedFrequencies[0]!.tone,
		).toEqual({ kind: "dcs", code: "023", polarity: "inverted" })
		expect(
			toOperatorDataReadDto(createEmptySnapshot(storeId)).preferences,
		).toEqual({
			values: PREFERENCE_DEFAULTS,
			provenance: {
				units: "default",
				timeFormat: "default",
				waterfallPalette: "default",
				showSavedFrequencyLabels: "default",
			},
		})
	})

	it("detaches nested input/output state, preferences, capabilities and immutable limits", () => {
		const input = configured()
		const before = structuredClone(input)
		const read = toOperatorDataReadDto(input)
		const write = toOperatorDataWriteDto({
			snapshot: input,
			changed: true,
			delivery: "failed",
		})
		read.snapshot.savedFrequencies[0]!.tone.kind = "none"
		read.snapshot.commandUsage[0]!.count = 999
		read.snapshot.preferenceOverrides.units = "imperial"
		read.preferences.values.timeFormat = "utc"
		read.preferences.provenance.units = "default"
		write.snapshot.savedFrequencies[0]!.name = "Changed"
		expect(input).toEqual(before)
		input.savedFrequencies[0]!.frequencyHz = 1
		input.commandUsage.length = 0
		expect(write.snapshot).toMatchObject({
			savedFrequencies: [{ frequencyHz: 145_500_000 }],
			commandUsage: [{ count: 1 }],
		})
		expect(read.limits).not.toBe(OPERATOR_DATA_LIMITS)
		Reflect.set(read.limits, "savedFrequencies", 0)
		expect(OPERATOR_DATA_LIMITS.savedFrequencies).toBe(256)
		expect(PREFERENCE_DEFAULTS.timeFormat).toBe("local-24h")
		expect(toOperatorDataReadDto(before).limits.savedFrequencies).toBe(256)
		expect(toOperatorDataReadDto(before).capabilities).not.toBe(
			read.capabilities,
		)
	})

	it("uses strict snapshot authority for both mappings without repairing invalid state", () => {
		const snapshot = configured()
		for (const invalid of [
			{ ...snapshot, version: 2 },
			{ ...snapshot, observedTone: true },
			{ ...snapshot, savedFrequencies: [] },
			{ ...snapshot, preferenceOverrides: { units: undefined } },
			{
				...snapshot,
				savedFrequencies: [{ ...snapshot.savedFrequencies[0], mode: "am" }],
			},
		]) {
			const value = invalid as OperatorDataSnapshot
			for (const map of [
				() => toOperatorDataReadDto(value),
				() =>
					toOperatorDataWriteDto({
						snapshot: value,
						changed: false,
						delivery: "not-needed",
					}),
			])
				expect(map).toThrow(new OperatorDataError("OPERATOR_DATA_INVALID"))
		}
	})

	it("projects only write snapshot and optional canonical live saved-frequency ID", () => {
		const snapshot = configured()
		for (const delivery of [
			"sent",
			"failed",
			"unmounted",
			"not-needed",
		] as const) {
			const result = {
				snapshot,
				savedFrequencyId: id,
				changed: true,
				delivery,
				secret: "hidden",
			}
			expect(toOperatorDataWriteDto(result)).toEqual({
				snapshot,
				savedFrequencyId: id,
			})
		}
		expect(
			toOperatorDataWriteDto({
				snapshot,
				changed: false,
				delivery: "not-needed",
			}),
		).toEqual({ snapshot })
		for (const savedFrequencyId of [
			undefined,
			"",
			"invalid",
			id.toUpperCase(),
			storeId,
		]) {
			const result = { snapshot, changed: true, delivery: "sent" as const }
			// Simulate malformed internal output, including an explicit undefined ID.
			Object.assign(result, { savedFrequencyId })
			expect(() => toOperatorDataWriteDto(result)).toThrow(
				new OperatorDataError("OPERATOR_DATA_INVALID"),
			)
		}
	})

	it.each(definitions)(
		"reconstructs %s status %i and canonical message despite tampering",
		(code, statusCode, message) => {
			const error = new OperatorDataError(code)
			Object.assign(error, {
				name: "SecretError",
				message: "secret filesystem path",
				statusCode: 200,
				current: { storeId, revision: 1 },
				details: { secret: "hidden" },
			})
			Object.defineProperty(error, "toJSON", {
				value: () => {
					throw new Error("must not serialize")
				},
			})
			expect(toOperatorDataErrorResponse(error)).toEqual({
				statusCode,
				body: {
					error: "OperatorDataError",
					code,
					message,
					...(code === "OPERATOR_DATA_CONFLICT"
						? { details: { current: { storeId, revision: 1 } } }
						: {}),
				},
			})
		},
	)

	it("includes only validated detached current tokens for conflicts", () => {
		const error = new OperatorDataError("OPERATOR_DATA_CONFLICT", {
			storeId,
			revision: 0,
		})
		const response = toOperatorDataErrorResponse(error)
		expect(response.body.details?.current).toEqual({ storeId, revision: 0 })
		response.body.details!.current.revision = 2
		expect(error.current?.revision).toBe(0)
		const independent = toOperatorDataErrorResponse(error)
		error.current!.revision = 3
		expect(independent.body.details?.current.revision).toBe(0)
		for (const current of [
			undefined,
			null,
			{ storeId, revision: -1 },
			{ storeId: id.toUpperCase(), revision: 0 },
			{ storeId, revision: 0, secret: "hidden" },
			{ storeId, revision: Number.MAX_SAFE_INTEGER + 1 },
		]) {
			Object.assign(error, { current })
			expect(toOperatorDataErrorResponse(error)).toEqual({
				statusCode: 409,
				body: {
					error: "OperatorDataError",
					code: "OPERATOR_DATA_CONFLICT",
					message: definitions[2]![2],
				},
			})
		}
	})

	it("maps unknown exceptions, impostors and malformed internal errors safely to unavailable", () => {
		const tampered = new OperatorDataError("OPERATOR_DATA_INVALID")
		Object.assign(tampered, { code: "toString" })
		const accessor = new OperatorDataError("OPERATOR_DATA_CONFLICT")
		Object.defineProperty(accessor, "current", {
			get: () => {
				throw new Error("secret")
			},
		})
		const hostile = new Proxy(
			{},
			{
				getPrototypeOf: () => {
					throw new Error("secret")
				},
			},
		)
		for (const error of [
			new Error("secret"),
			null,
			undefined,
			"secret",
			{
				name: "OperatorDataError",
				code: "OPERATOR_DATA_INVALID",
				statusCode: 200,
				message: "secret",
			},
			tampered,
			accessor,
			hostile,
		])
			expect(toOperatorDataErrorResponse(error)).toEqual(unavailable)
	})

	it("measures complete compact UTF-8 ReadDto at maximal counts and the snapshot byte quota", () => {
		const snapshot = configured()
		snapshot.revision = OPERATOR_DATA_LIMITS.revision
		snapshot.preferenceOverrides = {
			units: "nautical",
			timeFormat: "local-12h",
			waterfallPalette: "phosphor",
			showSavedFrequencyLabels: false,
		}
		snapshot.savedFrequencies = Array.from(
			{ length: OPERATOR_DATA_LIMITS.savedFrequencies },
			(_, index) => ({
				...snapshot.savedFrequencies[0]!,
				id: `00000000-0000-4000-8000-${String(index + 10).padStart(12, "0")}`,
				name: "📡".repeat(128),
				group: "📡".repeat(64),
				frequencyHz: 100_000_000_000,
				bandwidthHz: 10_000_000,
				tone: { kind: "dcs", code: "777", polarity: "inverted" },
			}),
		)
		snapshot.commandUsage = snapshot.savedFrequencies
			.slice(0, OPERATOR_DATA_LIMITS.commandUsage)
			.map((frequency, index) => ({
				command: "open-saved-frequency",
				savedFrequencyId: frequency.id,
				count: OPERATOR_DATA_LIMITS.usageCount,
				lastUsedAt: time,
				lastUsedRevision: OPERATOR_DATA_LIMITS.revision - index,
			}))
		// UTC fractional precision has no field-length cap; fill the existing aggregate quota.
		const remaining =
			OPERATOR_DATA_LIMITS.snapshotBytes -
			Buffer.byteLength(JSON.stringify(snapshot), "utf8")
		snapshot.savedFrequencies[0]!.updatedAt = time.replace(
			".000Z",
			`.000${"0".repeat(remaining)}Z`,
		)
		const dto = toOperatorDataReadDto(snapshot)
		const json = JSON.stringify(dto)
		const bytes = Buffer.byteLength(json, "utf8")
		expect(Buffer.byteLength(JSON.stringify(dto.snapshot), "utf8")).toBe(
			OPERATOR_DATA_LIMITS.snapshotBytes,
		)
		expect(bytes).toBeGreaterThan(json.length)
		expect(bytes).toBeLessThanOrEqual(1024 * 1024)
		expect(bytes).toBe(524_811)
		snapshot.savedFrequencies[0]!.updatedAt =
			snapshot.savedFrequencies[0]!.updatedAt.replace("Z", "0Z")
		expect(() => toOperatorDataReadDto(snapshot)).toThrow(
			new OperatorDataError("OPERATOR_DATA_QUOTA"),
		)
	})
})
