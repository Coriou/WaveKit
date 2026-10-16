import { DECIMAL_TEXT, INTEGER_TEXT } from "./options/common.js"

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
