import { z } from "zod"
import { WaveKitError } from "../utils/errors.js"

export const OPERATOR_DATA_LIMITS = Object.freeze({
	savedFrequencies: 256,
	commandUsage: 64,
	snapshotBytes: 512 * 1024,
	requestBytes: 16 * 1024,
	waitingTransactions: 32,
	usageCount: 1_000_000,
	revision: Number.MAX_SAFE_INTEGER,
})

export const uuidSchema = z
	.string()
	.uuid()
	.refine(
		value => value === value.toLowerCase(),
		"UUID must be canonical lowercase",
	)
export const revisionSchema = z
	.number()
	.int()
	.min(0)
	.max(OPERATOR_DATA_LIMITS.revision)
export const expectedTokenSchema = z
	.object({ storeId: uuidSchema, revision: revisionSchema })
	.strict()
export type ExpectedToken = z.infer<typeof expectedTokenSchema>

const errorDefinitions = {
	OPERATOR_DATA_INVALID: [400, "Invalid operator data."],
	OPERATOR_DATA_PRECONDITION_REQUIRED: [
		428,
		"An expected operator-data token is required.",
	],
	OPERATOR_DATA_CONFLICT: [
		409,
		"Operator data changed; fetch the current snapshot.",
	],
	OPERATOR_DATA_NOT_FOUND: [404, "Saved frequency not found."],
	OPERATOR_DATA_QUOTA: [409, "Operator-data limit exceeded."],
	OPERATOR_DATA_BUSY: [503, "Operator data is busy."],
	OPERATOR_DATA_UNAVAILABLE: [503, "Operator data is unavailable."],
} as const
export type OperatorDataErrorCode = keyof typeof errorDefinitions

export class OperatorDataError extends WaveKitError {
	readonly statusCode: number
	readonly current?: ExpectedToken
	constructor(code: OperatorDataErrorCode, current?: ExpectedToken) {
		super(errorDefinitions[code][1], code)
		this.name = "OperatorDataError"
		this.statusCode = errorDefinitions[code][0]
		if (current) this.current = { ...current }
	}
}

// Accept UTC ISO timestamps only, including real calendar dates (not February 30).
export const timestampSchema = z
	.string()
	.datetime()
	.refine(value => {
		const time = Date.parse(value)
		return (
			Number.isFinite(time) &&
			new Date(time).toISOString().slice(0, 19) === value.slice(0, 19)
		)
	}, "Invalid UTC date")

function textSchema(max: number, normalize: boolean) {
	const text = z
		.string()
		.refine(
			value => !/[\p{Cc}\p{Cs}]/u.test(value),
			"Control characters or invalid Unicode",
		)
	const trimmed = normalize
		? text.transform(value => value.trim())
		: text.refine(value => value === value.trim(), "Must be trimmed")
	return trimmed.refine(
		value => [...value].length >= 1 && [...value].length <= max,
		"Invalid code-point length",
	)
}
export const modeSchema = z.enum([
	"nfm",
	"wfm",
	"am",
	"usb",
	"lsb",
	"dsb",
	"cw",
	"raw",
])
export const toneSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("none") }).strict(),
	z
		.object({
			kind: z.literal("ctcss"),
			frequencyTenthsHz: z.number().int().min(600).max(3000),
		})
		.strict(),
	z
		.object({
			kind: z.literal("dcs"),
			code: z.string().regex(/^[0-7]{3}$/),
			polarity: z.enum(["normal", "inverted"]),
		})
		.strict(),
])
const frequencyFields = (normalize: boolean) => ({
	name: textSchema(128, normalize),
	frequencyHz: z.number().int().min(1).max(100_000_000_000),
	mode: modeSchema,
	bandwidthHz: z.number().int().min(0).max(10_000_000),
	tone: toneSchema,
	group: textSchema(64, normalize).optional(),
})
function validateFrequency(
	value: {
		group?: string | undefined
		mode: z.infer<typeof modeSchema>
		bandwidthHz: number
		tone: z.infer<typeof toneSchema>
	},
	ctx: z.RefinementCtx,
) {
	if (Object.hasOwn(value, "group") && value.group === undefined)
		ctx.addIssue({
			code: "custom",
			path: ["group"],
			message: "Explicit undefined is not a group",
		})
	if ((value.mode === "raw") !== (value.bandwidthHz === 0))
		ctx.addIssue({
			code: "custom",
			path: ["bandwidthHz"],
			message:
				"Raw requires zero bandwidth; other modes require positive bandwidth",
		})
	if (value.tone.kind !== "none" && value.mode !== "nfm")
		ctx.addIssue({
			code: "custom",
			path: ["tone"],
			message: "Selected tones require NFM",
		})
}
export const savedFrequencyInputSchema = z
	.object(frequencyFields(true))
	.strict()
	.superRefine(validateFrequency)
export const savedFrequencySchema = z
	.object({
		id: uuidSchema,
		createdAt: timestampSchema,
		updatedAt: timestampSchema,
		...frequencyFields(false),
	})
	.strict()
	.superRefine((value, ctx) => {
		validateFrequency(value, ctx)
		if (Date.parse(value.updatedAt) < Date.parse(value.createdAt))
			ctx.addIssue({
				code: "custom",
				path: ["updatedAt"],
				message: "Update precedes creation",
			})
	})
export type SavedFrequencyInput = z.infer<typeof savedFrequencyInputSchema>
export type SavedFrequency = z.infer<typeof savedFrequencySchema>

export const preferenceKeySchema = z.enum([
	"units",
	"timeFormat",
	"waterfallPalette",
	"showSavedFrequencyLabels",
])
export const preferencesSchema = z
	.object({
		units: z.enum(["metric", "nautical", "imperial"]),
		timeFormat: z.enum(["local-24h", "local-12h", "utc"]),
		waterfallPalette: z.enum(["phosphor", "amber", "mono"]),
		showSavedFrequencyLabels: z.boolean(),
	})
	.strict()
export const preferenceOverridesSchema = preferencesSchema
	.partial()
	.superRefine((value, ctx): value is Partial<Preferences> => {
		for (const key of preferenceKeySchema.options) {
			if (Object.hasOwn(value, key) && value[key] === undefined)
				ctx.addIssue({
					code: "custom",
					path: [key],
					message: "Explicit undefined is not an override",
				})
		}
		return true // Issues above reject explicitly undefined keys before this narrowing.
	})
export type PreferenceKey = z.infer<typeof preferenceKeySchema>
export type Preferences = z.infer<typeof preferencesSchema>
export type PreferenceOverrides = z.infer<typeof preferenceOverridesSchema>
export const commandSchema = z.enum([
	"tune",
	"identify",
	"listen",
	"open-saved-frequency",
])
const commandReferenceFields = {
	command: commandSchema,
	savedFrequencyId: uuidSchema.optional(),
}
function validateCommandReference(
	value: {
		command: z.infer<typeof commandSchema>
		savedFrequencyId?: string | undefined
	},
	ctx: z.RefinementCtx,
) {
	if (value.command === "open-saved-frequency" && !value.savedFrequencyId)
		ctx.addIssue({
			code: "custom",
			path: ["savedFrequencyId"],
			message: "A preset reference is required",
		})
	if (
		Object.hasOwn(value, "savedFrequencyId") &&
		value.savedFrequencyId === undefined
	)
		ctx.addIssue({
			code: "custom",
			path: ["savedFrequencyId"],
			message: "Explicit undefined is not a reference",
		})
}
const commandUsageObjectSchema = z
	.object({
		...commandReferenceFields,
		count: z.number().int().min(1).max(OPERATOR_DATA_LIMITS.usageCount),
		lastUsedAt: timestampSchema,
		lastUsedRevision: revisionSchema.refine(
			value => value > 0,
			"Usage requires a changed revision",
		),
	})
	.strict()

export const commandReferenceSchema = z.discriminatedUnion("command", [
	z
		.object({
			command: z.enum(["tune", "identify", "listen"]),
			savedFrequencyId: uuidSchema.optional(),
		})
		.strict(),
	z
		.object({
			command: z.literal("open-saved-frequency"),
			savedFrequencyId: uuidSchema,
		})
		.strict(),
])
export type CommandReference = z.infer<typeof commandReferenceSchema>
export const commandUsageSchema = commandUsageObjectSchema.superRefine(
	(
		value,
		ctx,
	): value is z.infer<typeof commandUsageObjectSchema> & CommandReference => {
		validateCommandReference(value, ctx)
		return (
			value.command !== "open-saved-frequency" ||
			value.savedFrequencyId !== undefined
		)
	},
)
export type CommandUsage = z.infer<typeof commandUsageSchema>
export function commandUsageKey(
	value: Pick<CommandUsage, "command" | "savedFrequencyId">,
): string {
	return `${value.command}:${value.savedFrequencyId ?? ""}`
}
export function compareCommandUsage(a: CommandUsage, b: CommandUsage): number {
	return (
		b.lastUsedRevision - a.lastUsedRevision ||
		(commandUsageKey(a) < commandUsageKey(b)
			? -1
			: commandUsageKey(a) > commandUsageKey(b)
				? 1
				: 0)
	)
}

export const snapshotSchema = z
	.object({
		version: z.literal(1),
		storeId: uuidSchema,
		revision: revisionSchema,
		savedFrequencies: z
			.array(savedFrequencySchema)
			.max(OPERATOR_DATA_LIMITS.savedFrequencies),
		preferenceOverrides: preferenceOverridesSchema,
		commandUsage: z
			.array(commandUsageSchema)
			.max(OPERATOR_DATA_LIMITS.commandUsage),
	})
	.strict()
	.superRefine((value, ctx) => {
		const ids = new Set<string>()
		value.savedFrequencies.forEach((frequency, index) => {
			if (ids.has(frequency.id))
				ctx.addIssue({
					code: "custom",
					path: ["savedFrequencies", index, "id"],
					message: "Duplicate preset ID",
				})
			ids.add(frequency.id)
		})
		const keys = new Set<string>()
		value.commandUsage.forEach((usage, index) => {
			const key = commandUsageKey(usage)
			if (keys.has(key))
				ctx.addIssue({
					code: "custom",
					path: ["commandUsage", index],
					message: "Duplicate usage key",
				})
			keys.add(key)
			const preset = value.savedFrequencies.find(
				frequency => frequency.id === usage.savedFrequencyId,
			)
			if (usage.savedFrequencyId && !ids.has(usage.savedFrequencyId))
				ctx.addIssue({
					code: "custom",
					path: ["commandUsage", index],
					message: "Dangling preset reference",
				})
			if (preset && Date.parse(usage.lastUsedAt) < Date.parse(preset.createdAt))
				ctx.addIssue({
					code: "custom",
					path: ["commandUsage", index, "lastUsedAt"],
					message: "Usage precedes preset creation",
				})
			if (usage.lastUsedRevision > value.revision)
				ctx.addIssue({
					code: "custom",
					path: ["commandUsage", index, "lastUsedRevision"],
					message: "Usage revision exceeds snapshot",
				})
			const previous = value.commandUsage[index - 1]
			if (previous && compareCommandUsage(previous, usage) > 0)
				ctx.addIssue({
					code: "custom",
					path: ["commandUsage", index],
					message: "Usage is not in revision/key order",
				})
		})
		if (
			Buffer.byteLength(JSON.stringify(value), "utf8") >
			OPERATOR_DATA_LIMITS.snapshotBytes
		)
			ctx.addIssue({
				code: "custom",
				message: "Snapshot byte limit exceeded",
				params: { quota: true },
			})
	})
export type OperatorDataSnapshot = z.infer<typeof snapshotSchema>

const mutationObjects = [
	z
		.object({
			type: z.literal("create-saved-frequency"),
			expected: expectedTokenSchema,
			frequency: savedFrequencyInputSchema,
		})
		.strict(),
	z
		.object({
			type: z.literal("replace-saved-frequency"),
			expected: expectedTokenSchema,
			id: uuidSchema,
			frequency: savedFrequencyInputSchema,
		})
		.strict(),
	z
		.object({
			type: z.literal("delete-saved-frequency"),
			expected: expectedTokenSchema,
			id: uuidSchema,
		})
		.strict(),
	z
		.object({
			type: z.literal("patch-preferences"),
			expected: expectedTokenSchema,
			set: preferenceOverridesSchema.optional(),
			reset: z.array(preferenceKeySchema).max(4).optional(),
		})
		.strict(),
	z
		.object({
			type: z.literal("report-command-usage"),
			expected: expectedTokenSchema,
			...commandReferenceFields,
		})
		.strict(),
	z
		.object({
			type: z.literal("reset-command-usage"),
			expected: expectedTokenSchema,
		})
		.strict(),
] as const
const mutationObjectSchema = z.discriminatedUnion("type", mutationObjects)
type MutationFields = z.infer<typeof mutationObjectSchema>
type ValidatedMutation =
	| Exclude<MutationFields, { type: "report-command-usage" }>
	| (Extract<MutationFields, { type: "report-command-usage" }> &
			CommandReference)
export const mutationSchema = mutationObjectSchema.superRefine(
	(value, ctx): value is ValidatedMutation => {
		if (value.type === "report-command-usage")
			validateCommandReference(value, ctx)
		if (value.type === "patch-preferences") {
			const set = Object.keys(value.set ?? {})
			const reset = value.reset ?? []
			if (
				set.length + reset.length === 0 ||
				new Set(reset).size !== reset.length ||
				reset.some(key => set.includes(key))
			)
				ctx.addIssue({
					code: "custom",
					message:
						"Preference patch must be nonempty, with distinct nonoverlapping reset keys",
				})
		}
		return (
			value.type !== "report-command-usage" ||
			value.command !== "open-saved-frequency" ||
			value.savedFrequencyId !== undefined
		)
	},
)
export type OperatorDataMutation = z.infer<typeof mutationSchema>

function parse<T>(
	schema: z.ZodType<T, z.ZodTypeDef, unknown>,
	value: unknown,
): T {
	const result = schema.safeParse(value)
	if (!result.success) {
		const quota = result.error.issues.some(
			issue =>
				(issue.code === "too_big" && issue.type === "array") ||
				(issue.code === "custom" && issue.params?.["quota"] === true),
		)
		throw new OperatorDataError(
			quota ? "OPERATOR_DATA_QUOTA" : "OPERATOR_DATA_INVALID",
		)
	}
	return result.data
}
/** Validates and returns a detached snapshot; never repairs unknown-version state. */
export function validateSnapshot(value: unknown): OperatorDataSnapshot {
	return parse(snapshotSchema, value)
}
/** Compact JSON, bounded by its actual UTF-8 encoding. Storage writes these exact bytes. */
export function encodeSnapshot(value: unknown): string {
	return JSON.stringify(validateSnapshot(value))
}
export function parseMutation(value: unknown): OperatorDataMutation {
	if (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		(!Object.hasOwn(value, "expected") ||
			Reflect.get(value, "expected") === undefined)
	)
		throw new OperatorDataError("OPERATOR_DATA_PRECONDITION_REQUIRED")
	const mutation = parse(mutationSchema, value)
	let bytes: number
	try {
		bytes = Buffer.byteLength(JSON.stringify(value), "utf8")
	} catch {
		throw new OperatorDataError("OPERATOR_DATA_INVALID")
	}
	if (bytes > OPERATOR_DATA_LIMITS.requestBytes)
		throw new OperatorDataError("OPERATOR_DATA_QUOTA")
	return mutation
}
