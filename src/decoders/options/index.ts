import type { z } from "zod"
import {
	DECODER_OPTION_ISSUES_MAX,
	DECODER_OPTION_ISSUE_TEXT_MAX,
	type DecoderOptionDescriptor,
	type DecoderOptionIssue,
} from "@wavekit/api-types"
import { acarsdecOptionDescriptors, acarsdecOptionsSchema } from "./acarsdec.js"
import {
	aisCatcherOptionDescriptors,
	aisCatcherOptionsSchema,
} from "./ais-catcher.js"
import { direwolfOptionDescriptors, direwolfOptionsSchema } from "./direwolf.js"
import { dsdFmeOptionDescriptors, dsdFmeOptionsSchema } from "./dsd-fme.js"
import { dumpvdl2OptionDescriptors, dumpvdl2OptionsSchema } from "./dumpvdl2.js"
import {
	loraMeshtasticOptionDescriptors,
	loraMeshtasticOptionsSchema,
} from "./lora-meshtastic.js"
import {
	multimonNgOptionDescriptors,
	multimonNgOptionsSchema,
} from "./multimon-ng.js"
import { readsbOptionDescriptors, readsbOptionsSchema } from "./readsb.js"
import { rtl433OptionDescriptors, rtl433OptionsSchema } from "./rtl433.js"

/** Option schema per decoder type (WG6 req 3.1). Look up with `Object.hasOwn`. */
export const DECODER_OPTION_SCHEMAS: Readonly<Record<string, z.ZodTypeAny>> = {
	acarsdec: acarsdecOptionsSchema,
	"ais-catcher": aisCatcherOptionsSchema,
	direwolf: direwolfOptionsSchema,
	"dsd-fme": dsdFmeOptionsSchema,
	dumpvdl2: dumpvdl2OptionsSchema,
	"lora-meshtastic": loraMeshtasticOptionsSchema,
	"multimon-ng": multimonNgOptionsSchema,
	readsb: readsbOptionsSchema,
	rtl433: rtl433OptionsSchema,
}

const DESCRIPTORS: Readonly<Record<string, DecoderOptionDescriptor[]>> = {
	acarsdec: acarsdecOptionDescriptors,
	"ais-catcher": aisCatcherOptionDescriptors,
	direwolf: direwolfOptionDescriptors,
	"dsd-fme": dsdFmeOptionDescriptors,
	dumpvdl2: dumpvdl2OptionDescriptors,
	"lora-meshtastic": loraMeshtasticOptionDescriptors,
	"multimon-ng": multimonNgOptionDescriptors,
	readsb: readsbOptionDescriptors,
	rtl433: rtl433OptionDescriptors,
}

/** Documented option keys of a type (a copy), or undefined when it has no schema. */
export function decoderOptionDescriptors(
	type: string,
): DecoderOptionDescriptor[] | undefined {
	if (!Object.hasOwn(DESCRIPTORS, type)) return undefined
	// Sorted by key (UTF-16 order) so lists extended in place stay in a stable, documented order.
	return (DESCRIPTORS[type] ?? [])
		.map(d => ({
			...d,
			...(d.enumValues ? { enumValues: [...d.enumValues] } : {}),
		}))
		.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
}

/** Cuts text to the issue text bound (UTF-16 code units). */
export function trimIssueText(text: string): string {
	return text.length > DECODER_OPTION_ISSUE_TEXT_MAX
		? text.slice(0, DECODER_OPTION_ISSUE_TEXT_MAX)
		: text
}

function dotted(path: ReadonlyArray<string | number>): string {
	return path.map(String).join(".")
}

function bound(
	kind: "number" | "string" | "array" | "set" | "date" | "bigint",
): string {
	return kind === "array" || kind === "set"
		? "items"
		: kind === "string"
			? "characters"
			: "value"
}

/**
 * One message from the issue kind and schema info only. It never reads the
 * received value (`issue.message` and `received` can echo it).
 */
function describeIssue(issue: z.ZodIssue): string {
	switch (issue.code) {
		case "invalid_type":
			return issue.received === "undefined"
				? `required, expected ${issue.expected}`
				: `expected ${issue.expected}`
		case "invalid_enum_value":
			return `expected one of ${issue.options.map(String).join(", ")}`
		case "invalid_literal":
			return `expected ${JSON.stringify(issue.expected)}`
		case "too_small":
		case "too_big": {
			const small = issue.code === "too_small"
			const limit = small ? issue.minimum : issue.maximum
			const kind = issue.type
			if (kind === "number" || kind === "bigint") {
				const word = small ? "at least" : "at most"
				return issue.inclusive
					? `expected ${word} ${String(limit)}`
					: `expected ${small ? "greater than" : "less than"} ${String(limit)}`
			}
			const word = small ? "at least" : "at most"
			return `expected ${word} ${String(limit)} ${bound(kind)}`
		}
		case "not_finite":
			return "expected a finite number"
		case "not_multiple_of":
			return `expected a multiple of ${String(issue.multipleOf)}`
		case "invalid_union":
			return "does not match any allowed type"
		default:
			return "invalid value"
	}
}

function compareIssues(a: DecoderOptionIssue, b: DecoderOptionIssue): number {
	if (a.path !== b.path) return a.path < b.path ? -1 : 1
	if (a.code !== b.code) return a.code < b.code ? -1 : 1
	if (a.message !== b.message) return a.message < b.message ? -1 : 1
	return 0
}

/**
 * Problems of `options` against the type's schema (WG6 req 3.3): undefined for a
 * type without schema, [] when valid. Bounded (32 issues, 256 units of text) and
 * free of option values. Does not throw.
 */
export function validateDecoderOptions(
	type: string,
	options: unknown,
): DecoderOptionIssue[] | undefined {
	if (!Object.hasOwn(DECODER_OPTION_SCHEMAS, type)) return undefined
	const schema = DECODER_OPTION_SCHEMAS[type]
	if (!schema) return undefined
	const parsed = schema.safeParse(options)
	if (parsed.success) return []

	const issues: DecoderOptionIssue[] = []
	for (const issue of parsed.error.issues) {
		if (issue.code === "unrecognized_keys") {
			for (const key of issue.keys) {
				issues.push({
					path: dotted([...issue.path, key]),
					code: "unknown-key",
					message: "unknown option",
				})
			}
			continue
		}
		issues.push({
			path: dotted(issue.path),
			code: "invalid-value",
			message: trimIssueText(describeIssue(issue)),
		})
	}
	issues.sort(compareIssues)
	// Unions and nested schemas can raise the same issue twice; keep one. Compared
	// on the full path, then the path is cut to the text bound.
	const unique = issues
		.filter((issue, i) => i === 0 || compareIssues(issues[i - 1]!, issue) !== 0)
		.map(issue => ({ ...issue, path: trimIssueText(issue.path) }))
	if (unique.length <= DECODER_OPTION_ISSUES_MAX) return unique
	const kept = unique.slice(0, DECODER_OPTION_ISSUES_MAX - 1)
	kept.push({
		path: "",
		code: "truncated",
		message: `${unique.length - kept.length} more`,
	})
	return kept
}
