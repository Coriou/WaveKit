import { DECIMAL_TEXT, INTEGER_TEXT } from "./options/common.js"
import { shellArg } from "./process-tools.js"

/** Bounds of one numeric decoder option, by meaning. */
export interface NumericOptionRule {
	/** Option key, reported to `warn` (never the value). */
	key: string
	/** Only integers pass (integer text form only: `INTEGER_TEXT`, or `-` prefixed when min < 0). */
	integer: boolean
	min: number
	max: number
	/** Value used when the option is absent or invalid (undefined = the adapter's own default). */
	default?: number | undefined
}

/** Why a value did not pass as given. Never carries the value itself. */
export type NumericOptionIssue = "invalid" | "clamped"

/** Reports an issue for a key; `createOptionWarner` dedupes per decoder and key. */
export type NumericOptionWarn = (key: string, issue: NumericOptionIssue) => void

const SIGNED_INTEGER_TEXT = /^-?\d+$/

function parse(value: unknown, rule: NumericOptionRule): number | undefined {
	if (typeof value === "number")
		return Number.isFinite(value) ? value : undefined
	if (typeof value !== "string") return undefined
	const pattern = rule.integer
		? rule.min < 0
			? SIGNED_INTEGER_TEXT
			: INTEGER_TEXT
		: DECIMAL_TEXT
	if (!pattern.test(value)) return undefined
	const parsed = Number(value)
	return Number.isFinite(parsed) ? parsed : undefined
}

/**
 * Read one numeric option by meaning: a finite number or the schema's numeric text
 * form passes; anything else is absent (`rule.default`) with `warn("invalid")`; an
 * out-of-range value (or a fraction for an integer rule) is clamped (rounded toward
 * the range) with `warn("clamped")`. Absent (`undefined`/`null`) is silent.
 */
export function readNumericOption(
	value: unknown,
	rule: NumericOptionRule,
	warn: NumericOptionWarn,
): number | undefined {
	if (value === undefined || value === null) return rule.default
	const parsed = parse(value, rule)
	if (parsed === undefined) {
		warn(rule.key, "invalid")
		return rule.default
	}
	let result = rule.integer ? Math.trunc(parsed) : parsed
	if (result < rule.min) result = rule.min
	if (result > rule.max) result = rule.max
	if (result !== parsed) warn(rule.key, "clamped")
	// -0 formats as "0" either way; normalise so argv never shows "-0".
	return result === 0 ? 0 : result
}

/**
 * Read an array option of numbers: a non-array is absent with `warn("invalid")`;
 * entries past `maxLength` are dropped with `warn("clamped")`; each entry is read with
 * `rule` (invalid entries are dropped, out-of-range entries clamped).
 */
export function readNumericArrayOption(
	value: unknown,
	rule: NumericOptionRule,
	maxLength: number,
	warn: NumericOptionWarn,
): number[] | undefined {
	if (value === undefined || value === null) return undefined
	if (!Array.isArray(value)) {
		warn(rule.key, "invalid")
		return undefined
	}
	const out: number[] = []
	let issue: NumericOptionIssue | undefined
	const limit = Math.min(value.length, maxLength)
	if (value.length > maxLength) issue = "clamped"
	for (let i = 0; i < limit; i++) {
		const entry = readNumericOption(
			value[i],
			{ ...rule, default: undefined },
			(_key, entryIssue) => {
				if (issue !== "invalid") issue = entryIssue
			},
		)
		if (entry === undefined) {
			issue = "invalid"
			continue
		}
		out.push(entry)
	}
	if (issue !== undefined) warn(rule.key, issue)
	return out
}

/**
 * Build a per-decoder warner: each key warns at most once, logging key and issue,
 * never the value.
 */
export function createOptionWarner(
	log: (
		fields: { key: string; issue: NumericOptionIssue },
		message: string,
	) => void,
): NumericOptionWarn {
	const warned = new Set<string>()
	return (key, issue) => {
		if (warned.has(key)) return
		warned.add(key)
		log(
			{ key, issue },
			"Decoder option invalid or out of bounds; using a safe value",
		)
	}
}

/**
 * extraArgs bounds (WG7 HW fix, R2): entry count, per-entry and aggregate bytes of
 * the SERIALIZED form. An entry costs the UTF-8 bytes of `shellArg(entry)` (what
 * it becomes inside an `sh -c` pipeline; never less than its raw bytes, so the
 * same bound covers argv-spawned adapters) plus one separator byte (the space in
 * the shell string, the NUL in argv). Per entry the serialized form is at most
 * `maxEntryBytes`; all kept entries together, separators included, at most
 * `maxTotalBytes`, so the extraArgs share of the final command never passes it.
 */
export const EXTRA_ARGS_BOUNDS = {
	maxEntries: 64,
	maxEntryBytes: 4096,
	maxTotalBytes: 65536,
} as const

/** Serialized bytes of one extraArgs entry (see EXTRA_ARGS_BOUNDS), separator excluded. */
export function extraArgSerializedBytes(entry: string): number {
	return Buffer.byteLength(shellArg(entry), "utf8")
}

/**
 * Read an `extraArgs` option: the operator's config-only argv tail (never
 * API-settable), so there is no flag allowlist and operands pass raw. A non-array
 * is absent with `warn("invalid")`. Only the first `maxEntries` entries are read
 * (`warn("clamped")` past that). Each entry must be a primitive string: anything
 * else is dropped, never coerced (`warn("invalid")`). An entry whose serialized
 * form (shell-quoted UTF-8) is over `maxEntryBytes` is dropped, and once the
 * running serialized total (plus one separator per entry) would pass
 * `maxTotalBytes` no further entries are added (both `warn("clamped")`).
 * Warnings carry the key only, never an entry.
 */
export function readExtraArgsOption(
	value: unknown,
	warn: NumericOptionWarn,
	key = "extraArgs",
): string[] | undefined {
	if (value === undefined || value === null) return undefined
	if (!Array.isArray(value)) {
		warn(key, "invalid")
		return undefined
	}
	const { maxEntries, maxEntryBytes, maxTotalBytes } = EXTRA_ARGS_BOUNDS
	let invalid = false
	let clamped = value.length > maxEntries
	const limit = Math.min(value.length, maxEntries)
	const out: string[] = []
	let total = 0
	for (let i = 0; i < limit; i++) {
		const entry: unknown = value[i]
		if (typeof entry !== "string") {
			invalid = true
			continue
		}
		// The serialized form is at least one byte per UTF-16 unit: skip quoting
		// when the length alone is already over the limit.
		const bytes =
			entry.length > maxEntryBytes
				? maxEntryBytes + 1
				: extraArgSerializedBytes(entry)
		if (bytes > maxEntryBytes) {
			clamped = true
			continue
		}
		if (total + bytes + 1 > maxTotalBytes) {
			clamped = true
			break
		}
		total += bytes + 1
		out.push(entry)
	}
	if (invalid) warn(key, "invalid")
	else if (clamped) warn(key, "clamped")
	return out
}
