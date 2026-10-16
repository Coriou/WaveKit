/**
 * WG8 decoder PATCH policy (docs/specs/web-gaps-8 requirement 2.2 to 2.4, design "Patch
 * policy"). Fail closed by meaning: a key is patchable only when its reviewed descriptor says
 * so AND the descriptor is consistent with requirement 2.3, re-checked here at runtime. Error
 * messages and issue texts are fixed rule text built from descriptor bounds; no submitted
 * value and no undocumented key name ever reaches an error, issue or log.
 */
import { z } from "zod"
import {
	DECODER_OPTION_ISSUES_MAX,
	DECODER_SETTINGS_MAX_KEYS,
	DECODER_SETTINGS_PATCHABLE_TYPES,
	type DecoderOptionDescriptor,
	type DecoderOptionIssue,
	type DecoderSettingValue,
} from "@wavekit/api-types"
import {
	DECODER_OPTION_SCHEMAS,
	decoderOptionDescriptors,
	trimIssueText,
} from "../options/index.js"
import { DecoderSettingsError } from "./contract.js"

/** Meanings that are never patchable (requirement 2.3), matched on the key. */
const NEVER_PATCHABLE_KEY =
	/(path|file|dir|host|addr|port|device|serial|url|callsign|^lat$|^lon$|^output|^udp|record|prune|debug|inputIqFormat|extraArgs|voiceSlot)/i

const INVALID_MESSAGE = "Decoder options are invalid"
const NOT_PATCHABLE_MESSAGE = "Option not patchable"
const BODY_KEYS: ReadonlySet<string> = new Set(["enabled", "options"])

export interface DecoderPatch {
	enabled?: boolean | null
	options: Record<string, DecoderSettingValue | null>
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		return false
	const proto: unknown = Object.getPrototypeOf(value)
	return proto === Object.prototype || proto === null
}

/** Reaches the object schema through effects, pipelines and other wrappers. */
function objectSchema(schema: z.ZodTypeAny): z.AnyZodObject | undefined {
	let current: z.ZodTypeAny = schema
	for (let depth = 0; depth < 16; depth++) {
		if (current instanceof z.ZodObject) return current as z.AnyZodObject
		if (current instanceof z.ZodEffects) current = current.innerType()
		else if (current instanceof z.ZodPipeline)
			current = current._def.in as z.ZodTypeAny
		else if (current instanceof z.ZodBranded) current = current.unwrap()
		else if (current instanceof z.ZodLazy) current = current.schema
		else if (current instanceof z.ZodReadonly)
			current = current._def.innerType as z.ZodTypeAny
		else return undefined
	}
	return undefined
}

function typeSchema(type: string): z.ZodTypeAny | undefined {
	if (!Object.hasOwn(DECODER_OPTION_SCHEMAS, type)) return undefined
	return DECODER_OPTION_SCHEMAS[type]
}

function keySchema(type: string, key: string): z.ZodTypeAny | undefined {
	const schema = typeSchema(type)
	const object = schema ? objectSchema(schema) : undefined
	if (!object) return undefined
	const shape = object.shape as Record<string, z.ZodTypeAny>
	return Object.hasOwn(shape, key) ? shape[key] : undefined
}

function descriptorOf(
	type: string,
	key: string,
): DecoderOptionDescriptor | undefined {
	return decoderOptionDescriptors(type)?.find(d => d.key === key)
}

function consistentPatchable(d: DecoderOptionDescriptor): boolean {
	if (d.patchable !== true || d.secret !== false) return false
	if (NEVER_PATCHABLE_KEY.test(d.key)) return false
	if (!(DECODER_SETTINGS_PATCHABLE_TYPES as readonly string[]).includes(d.type))
		return false
	if (d.type === "enum" || d.type === "string-list")
		return (d.enumValues?.length ?? 0) > 0
	return true
}

/** WG8 req 2.3: the key may be set by PATCH (reviewed allowlist plus the runtime re-check). */
export function isPatchableOption(type: string, key: string): boolean {
	try {
		if (typeof type !== "string" || typeof key !== "string") return false
		if (keySchema(type, key) === undefined) return false
		const d = descriptorOf(type, key)
		return d !== undefined && consistentPatchable(d)
	} catch {
		return false
	}
}

function range(d: DecoderOptionDescriptor): string {
	if (d.min !== undefined && d.max !== undefined)
		return ` from ${String(d.min)} to ${String(d.max)}`
	if (d.min !== undefined) return ` of at least ${String(d.min)}`
	if (d.max !== undefined) return ` of at most ${String(d.max)}`
	return ""
}

/** Fixed rule text of a key, from its descriptor only. */
function ruleText(d: DecoderOptionDescriptor): string {
	switch (d.type) {
		case "boolean":
			return "must be true or false"
		case "integer":
			return `must be an integer${range(d)}`
		case "number":
			return `must be a number${range(d)}`
		case "enum":
			return "must be one of the documented values"
		case "string-list":
			return "must be a list of documented values within the allowed length"
		case "number-list":
			return `must be a list of numbers${range(d)} within the allowed length`
		default:
			return "invalid value"
	}
}

/** Type and membership check before the schema (text only for closed sets). */
function preCheck(
	d: DecoderOptionDescriptor,
	value: unknown,
): { ok: true } | { ok: false; index?: number } {
	const members = d.enumValues ?? []
	switch (d.type) {
		case "boolean":
			return typeof value === "boolean" ? { ok: true } : { ok: false }
		case "integer":
			return typeof value === "number" && Number.isSafeInteger(value)
				? { ok: true }
				: { ok: false }
		case "number":
			return typeof value === "number" && Number.isFinite(value)
				? { ok: true }
				: { ok: false }
		case "enum":
			return typeof value === "string" && members.includes(value)
				? { ok: true }
				: { ok: false }
		case "string-list":
		case "number-list": {
			if (!Array.isArray(value)) return { ok: false }
			for (let i = 0; i < value.length; i++) {
				if (!Object.hasOwn(value, i)) return { ok: false, index: i }
				const item: unknown = value[i]
				const good =
					d.type === "string-list"
						? typeof item === "string" && members.includes(item)
						: typeof item === "number" && Number.isFinite(item)
				if (!good) return { ok: false, index: i }
			}
			return { ok: true }
		}
		default:
			return { ok: false }
	}
}

function copyValue(value: unknown): DecoderSettingValue {
	return Array.isArray(value)
		? ([...value] as string[] | number[])
		: (value as boolean | number | string)
}

/** Per-key check: undefined when valid, else the issue (fixed text). */
function checkValue(
	type: string,
	d: DecoderOptionDescriptor,
	value: unknown,
): DecoderOptionIssue | undefined {
	const issue = (index?: number): DecoderOptionIssue => ({
		path: index === undefined ? d.key : `${d.key}.${String(index)}`,
		code: "invalid-value",
		message: trimIssueText(ruleText(d)),
	})
	try {
		const pre = preCheck(d, value)
		if (!pre.ok) return issue(pre.index)
		const schema = keySchema(type, d.key)
		if (!schema) return issue()
		const parsed = schema.safeParse(value)
		if (parsed.success) return undefined
		const first = parsed.error.issues[0]?.path[0]
		return issue(typeof first === "number" ? first : undefined)
	} catch {
		return issue()
	}
}

function issueId(issue: z.ZodIssue): string {
	return JSON.stringify([issue.code, issue.message])
}

function fullIssues(
	type: string,
	options: Record<string, unknown>,
): z.ZodIssue[] {
	const schema = typeSchema(type)
	if (!schema) return []
	try {
		const parsed = schema.safeParse(options)
		return parsed.success ? [] : parsed.error.issues
	} catch {
		return [
			{ code: z.ZodIssueCode.custom, path: [], message: "schema failure" },
		]
	}
}

function bounded(issues: DecoderOptionIssue[]): DecoderOptionIssue[] {
	if (issues.length <= DECODER_OPTION_ISSUES_MAX) return issues
	const kept = issues.slice(0, DECODER_OPTION_ISSUES_MAX - 1)
	kept.push({
		path: "",
		code: "truncated",
		message: `${String(issues.length - kept.length)} more issues`,
	})
	return kept
}

function invalid(issues?: DecoderOptionIssue[]): DecoderSettingsError {
	return new DecoderSettingsError(
		"DECODER_OPTIONS_INVALID",
		INVALID_MESSAGE,
		issues ? { issues: bounded(issues) } : {},
	)
}

function shapeIssue(path: string, message: string): DecoderOptionIssue[] {
	return [{ path, code: "invalid-value", message }]
}

/**
 * Validates a raw PATCH body for a decoder of `type` whose configured options are
 * `configured`. Throws DecoderSettingsError (DECODER_OPTIONS_INVALID with issues /
 * DECODER_OPTION_NOT_PATCHABLE with keys+unknownKeys). Returns the normalised patch (only
 * keys present in the body; null = revert).
 */
export function validateDecoderPatch(
	type: string,
	configured: Readonly<Record<string, unknown>>,
	body: unknown,
): DecoderPatch {
	if (!isPlainObject(body))
		throw invalid(shapeIssue("", "body must be a JSON object"))
	const bodyKeys = Object.keys(body)
	if (bodyKeys.length === 0)
		throw invalid(shapeIssue("", "body must set enabled or options"))
	if (bodyKeys.some(k => !BODY_KEYS.has(k)))
		throw invalid(shapeIssue("", "body may only contain enabled and options"))

	const result: DecoderPatch = { options: {} }
	if (Object.hasOwn(body, "enabled")) {
		const enabled = body["enabled"]
		if (enabled !== null && typeof enabled !== "boolean")
			throw invalid(shapeIssue("", "enabled must be true, false or null"))
		result.enabled = enabled
	}
	if (!Object.hasOwn(body, "options")) return result

	const options = body["options"]
	if (!isPlainObject(options))
		throw invalid(shapeIssue("", "options must be a JSON object"))
	const keys = Object.keys(options)
	if (keys.length > DECODER_SETTINGS_MAX_KEYS)
		throw invalid(
			shapeIssue(
				"",
				`options may name at most ${String(DECODER_SETTINGS_MAX_KEYS)} keys`,
			),
		)

	// Fail closed by meaning: refuse every key that is not patchable now.
	const documented = new Map(
		(decoderOptionDescriptors(type) ?? []).map(d => [d.key, d]),
	)
	const refused: string[] = []
	let unknownKeys = 0
	for (const key of keys) {
		if (isPatchableOption(type, key)) continue
		if (keySchema(type, key) !== undefined && documented.has(key))
			refused.push(key)
		else unknownKeys += 1
	}
	if (refused.length > 0 || unknownKeys > 0)
		throw new DecoderSettingsError(
			"DECODER_OPTION_NOT_PATCHABLE",
			NOT_PATCHABLE_MESSAGE,
			{ keys: refused, unknownKeys },
		)

	// Values: null reverts (no validation); others pass the per-key rules.
	const issues: DecoderOptionIssue[] = []
	const set = new Set<string>()
	for (const key of keys) {
		const value: unknown = options[key]
		if (value === null) {
			result.options[key] = null
			continue
		}
		const d = documented.get(key)
		const issue = d ? checkValue(type, d, value) : undefined
		if (!d || issue) {
			issues.push(
				issue ?? { path: key, code: "invalid-value", message: "invalid value" },
			)
			continue
		}
		result.options[key] = copyValue(value)
		set.add(key)
	}
	if (issues.length > 0) throw invalid(issues)

	// Cross-key rules on the merged options; unrelated configured problems never count.
	// Object.fromEntries defines own properties, so a configured "__proto__" key stays data.
	const configuredCopy: Record<string, unknown> = Object.fromEntries(
		Object.keys(configured).map(key => [key, configured[key]]),
	)
	const merged: Record<string, unknown> = Object.fromEntries([
		...Object.entries(configuredCopy).filter(
			([key]) => !Object.hasOwn(result.options, key),
		),
		...Object.entries(result.options).filter(([, value]) => value !== null),
	])
	const before = new Set(fullIssues(type, configuredCopy).map(issueId))
	for (const issue of fullIssues(type, merged)) {
		const head = issue.path[0]
		if (typeof head === "string" && set.has(head)) {
			const d = documented.get(head)
			issues.push({
				path: head,
				code: "invalid-value",
				message: d ? trimIssueText(ruleText(d)) : "invalid value",
			})
		} else if (issue.path.length === 0 && !before.has(issueId(issue))) {
			issues.push({
				path: "",
				code: "invalid-value",
				message: "the options are inconsistent with each other",
			})
		}
	}
	if (issues.length > 0) {
		const seen = new Set<string>()
		throw invalid(
			issues.filter(i => {
				const id = `${i.path}\u0000${i.message}`
				if (seen.has(id)) return false
				seen.add(id)
				return true
			}),
		)
	}
	return result
}

/**
 * Load-time re-check of a stored entry's options: keeps only keys that are patchable now
 * and whose value passes the per-key schema; returns kept options and the dropped count.
 */
export function sanitizeStoredOptions(
	type: string,
	options: Readonly<Record<string, unknown>>,
): { options: Record<string, DecoderSettingValue>; dropped: number } {
	const kept: Record<string, DecoderSettingValue> = {}
	let dropped = 0
	if (!isPlainObject(options)) return { options: kept, dropped }
	for (const key of Object.keys(options)) {
		const value: unknown = options[key]
		const d = isPatchableOption(type, key) ? descriptorOf(type, key) : undefined
		if (
			d === undefined ||
			value === null ||
			value === undefined ||
			checkValue(type, d, value) !== undefined
		) {
			dropped += 1
			continue
		}
		kept[key] = copyValue(value)
	}
	return { options: kept, dropped }
}
