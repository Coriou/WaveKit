/**
 * Static wire form of scanner plan issues in error answers (400 `SCANNER_PLAN_INVALID`, the
 * 409s that carry `details.issues`).
 *
 * The plan preview words its issues for the operator and quotes the job spec: submitted
 * range edges, bandplan ids, source ids, dwell values. An error answer repeats none of it:
 * each issue keeps its `code` and `severity` and gets the fixed message of its code. Its
 * `details` are dropped, except the documented `range-locked` details, which hold only
 * server-derived positions, counts, a fixed reason and locked field names (each checked
 * here). The web app reads `details.issues[].code/severity/message`, so the array shape is
 * unchanged. Error issues also name the job field to change in `fields`.
 */

import { RANGE_LOCKED_FIELDS } from "../../core/scanner/plan/range-contract.js"
import type { PlanIssueCode } from "../../core/scanner/types.js"
import type { ValidationField } from "../validation-errors.js"

interface IssueText {
	message: string
	/** The job spec field an error issue asks the client to change; null for warnings. */
	field: ValidationField | null
}

const RANGES_INSIDE_TUNER: ValidationField = {
	field: "ranges",
	expected:
		"ranges with startHz < endHz inside the source tuner's frequency range, Hz",
}

/** Every code has an entry: the compiler fails when a new PlanIssueCode lacks one. */
const ISSUE_TEXT: Readonly<Record<PlanIssueCode, IssueText>> = Object.freeze({
	"range-empty": {
		message: "a range is empty or inverted, or the sweep has no range",
		field: {
			field: "ranges",
			expected:
				"at least one range or bandplan; each range with startHz > 0 and endHz > startHz, Hz",
		},
	},
	"range-outside-tuner": {
		message: "a range lies outside the tuner's frequency range",
		field: RANGES_INSIDE_TUNER,
	},
	"all-excluded": {
		message: "the exclusions cover every range",
		field: {
			field: "exclusions",
			expected: "exclusions that leave part of a range to scan",
		},
	},
	"plan-empty": {
		message:
			"the sweep plan has no hops: no channel or free span is left to scan",
		field: {
			field: "ranges",
			expected:
				"ranges that hold at least one channel or free span after exclusions",
		},
	},
	"not-in-window": {
		message:
			"in-window mode needs every range inside the source's current window",
		field: {
			field: "mode",
			expected:
				'"sweep" or "auto", or "in-window" with every range inside the source\'s current window',
		},
	},
	"no-tuner-control": {
		message: "the source has no tuner control",
		field: {
			field: "sourceId",
			expected: 'a source with tuner control, or mode "in-window"',
		},
	},
	"source-busy": {
		message: "the source is under external (relay) control",
		field: {
			field: "sourceId",
			expected: "a source not under external (relay) control",
		},
	},
	"dwell-too-short": {
		message: "a dwell is shorter than the settle time plus the integration",
		field: {
			field: "dwellMs",
			expected:
				"number, milliseconds, at least settleMs plus integrationMs (job and per-range dwellMs)",
		},
	},
	"hold-inconsistent": {
		message: "the maximum hold is below the confirm hold",
		field: {
			field: "hold",
			expected: "object with maxHoldMs at least confirmHoldMs, milliseconds",
		},
	},
	"channel-too-wide": {
		message: "a channel is wider than the usable span of one hop",
		field: {
			field: "ranges",
			expected: "channels narrower than the usable span of one hop",
		},
	},
	"source-not-iq": {
		message: "the source does not deliver IQ samples",
		field: { field: "sourceId", expected: "a source that delivers IQ samples" },
	},
	"no-probe-transport": {
		message: "no requested protocol can be confirmed on this source",
		field: {
			field: "protocols",
			expected: "protocols with a probe transport on this source",
		},
	},
	"range-locked": {
		message:
			"a running job's ranges cannot change; stop it to change edges or channel spacing",
		field: {
			field: "ranges",
			expected: "the running job's ranges, edges and channel spacing unchanged",
		},
	},
	"signals-only-unsupported": {
		message: "monitor jobs need decoders",
		field: { field: "kind", expected: '"discover"' },
	},
	"poi-low": {
		message: "the detection probability for a typical transmission is low",
		field: null,
	},
	"rbw-coarse": {
		message: "the resolution bandwidth is coarse for typical channels",
		field: null,
	},
	"rbw-fine": { message: "the resolution bandwidth is very fine", field: null },
	"settle-timer": {
		message: "the source settles on a fixed timer",
		field: null,
	},
	"settle-unmeasured": {
		message: "the source's settle time is not measured",
		field: null,
	},
	"budget-cpu": {
		message: "the estimated CPU use exceeds the budget",
		field: null,
	},
	"budget-disk": {
		message: "the estimated recording rate fills the storage cap quickly",
		field: null,
	},
	"dc-adjacent-channels": {
		message: "some hops have channels next to the DC spike",
		field: null,
	},
	"dedicated-available": {
		message: "a dedicated receiver is available",
		field: null,
	},
	unrestorable: {
		message: "some pre-job settings cannot be restored after the job",
		field: null,
	},
	"probe-unavailable": {
		message: "some requested protocols have no probe transport",
		field: null,
	},
	"decoded-elsewhere-truncated": {
		message:
			"too many decoders, targets or ranges to skip everything decoded elsewhere",
		field: null,
	},
	"decoded-elsewhere-not-applied": {
		message:
			"skipping the ranges decoded elsewhere would leave nothing to scan",
		field: null,
	},
	"bandplan-skips-truncated": {
		message: "band-plan skips were truncated",
		field: null,
	},
	"bandplan-skips-not-applied": {
		message: "skipping the band-plan skip ranges would leave nothing to scan",
		field: null,
	},
})

/** A `range-empty` issue the preview raised for a requested bandplan (its details name it). */
const BANDPLAN_UNAVAILABLE: IssueText = {
	message: "a requested bandplan is not available in this region",
	field: {
		field: "bandplans",
		expected:
			"ids of bandplans available in the configured region (GET /api/bandplans)",
	},
}

/** Unknown codes (never from this server) still answer without echoing anything. */
const UNKNOWN_ISSUE: IssueText = {
	message: "the job spec has an error",
	field: null,
}

/** Names the body when no error issue names a field (or the list is malformed). */
const PLAN_FIELD: ValidationField = {
	field: "body",
	expected:
		"a job spec the plan preview accepts (POST /api/scanner/plan lists its issues)",
}

export interface StaticPlanIssue {
	code: string
	severity: "error" | "warning"
	message: string
	details?: Record<string, unknown>
}

const RANGE_LOCKED_REASONS: ReadonlySet<unknown> = new Set([
	"range-count",
	"range-live-stale",
	"range-plan-changed",
])
const LOCKED_FIELDS: ReadonlySet<unknown> = new Set(RANGE_LOCKED_FIELDS)

function count(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}

/** The documented `range-locked` details, each key type-checked; null when none is left. */
function rangeLockedDetails(
	details: Readonly<Record<string, unknown>> | null,
): Record<string, unknown> | null {
	if (details === null) return null
	const out: Record<string, unknown> = {}
	if (RANGE_LOCKED_REASONS.has(details["reason"]))
		out["reason"] = details["reason"]
	for (const key of ["index", "expected", "received"] as const)
		if (count(details[key])) out[key] = details[key]
	const fields = details["fields"]
	if (Array.isArray(fields) && fields.every(f => LOCKED_FIELDS.has(f)))
		out["fields"] = [...(fields as unknown[])]
	const dropped = details["dropped"]
	if (Array.isArray(dropped) && dropped.every(count))
		out["dropped"] = [...dropped]
	return Object.keys(out).length > 0 ? out : null
}

function record(value: unknown): Readonly<Record<string, unknown>> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null
}

function textOf(issue: Readonly<Record<string, unknown>>): {
	code: string
	text: IssueText
} {
	const code = issue["code"]
	if (typeof code !== "string" || !Object.hasOwn(ISSUE_TEXT, code))
		return { code: "unknown", text: UNKNOWN_ISSUE }
	const details = record(issue["details"])
	if (
		code === "range-empty" &&
		details !== null &&
		Object.hasOwn(details, "bandplan")
	)
		return { code, text: BANDPLAN_UNAVAILABLE }
	return { code, text: ISSUE_TEXT[code as PlanIssueCode] }
}

/**
 * The plan issues of an error answer in static form, with the fields the error issues
 * name (each field once, in issue order), else the body. A malformed list answers no issues.
 */
export function staticPlanIssues(issues: unknown): {
	issues: StaticPlanIssue[]
	fields: ValidationField[]
} {
	if (!Array.isArray(issues)) return { issues: [], fields: [PLAN_FIELD] }
	const out: StaticPlanIssue[] = []
	const fields = new Map<string, string>()
	for (const raw of issues) {
		const issue = record(raw)
		if (issue === null) continue
		const { code, text } = textOf(issue)
		// Trust default: anything but an explicit warning counts as an error.
		const severity = issue["severity"] === "warning" ? "warning" : "error"
		const kept =
			code === "range-locked"
				? rangeLockedDetails(record(issue["details"]))
				: null
		out.push({
			code,
			severity,
			message: text.message,
			...(kept !== null ? { details: kept } : {}),
		})
		if (
			severity === "error" &&
			text.field !== null &&
			!fields.has(text.field.field)
		)
			fields.set(text.field.field, text.field.expected)
	}
	return {
		issues: out,
		fields:
			fields.size > 0
				? [...fields].map(([field, expected]) => ({ field, expected }))
				: [PLAN_FIELD],
	}
}
