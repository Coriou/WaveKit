/**
 * Running-job range edits (SF1 design "PATCH validation"). Pure and total:
 * a length mismatch or a locked-field change is a `range-locked` error, and
 * nothing here throws or writes back into the inputs.
 */
import type { PlanIssue, ScanRange } from "../types.js"
import {
	RANGE_LIVE_FIELDS,
	RANGE_LOCKED_FIELDS,
	type ApplyRangePatch,
	type RangeLockedField,
	type ScanRangeLive,
} from "./range-contract.js"

function rastersEqual(
	a: ScanRange["rasters"],
	b: ScanRange["rasters"],
): boolean {
	if (a === undefined || b === undefined) return a === b
	if (a.length !== b.length) return false
	for (let i = 0; i < a.length; i++) {
		const left = a[i]
		const right = b[i]
		if (
			left === undefined ||
			right === undefined ||
			left.spacingHz !== right.spacingHz ||
			left.firstChannelHz !== right.firstChannelHz
		)
			return false
	}
	return true
}

function obwEqual(a: ScanRange["obwHz"], b: ScanRange["obwHz"]): boolean {
	if (a === undefined || b === undefined) return a === b
	if (a.length !== b.length) return false
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
	return true
}

function lockedEqual(
	field: RangeLockedField,
	current: ScanRange,
	patch: ScanRange,
): boolean {
	switch (field) {
		case "startHz":
			return current.startHz === patch.startHz
		case "endHz":
			return current.endHz === patch.endHz
		case "rasters":
			return rastersEqual(current.rasters, patch.rasters)
		case "obwHz":
			return obwEqual(current.obwHz, patch.obwHz)
		case "bandplanId":
			return current.bandplanId === patch.bandplanId
	}
}

function differingLocked(
	current: ScanRange,
	patch: ScanRange,
): RangeLockedField[] {
	const fields: RangeLockedField[] = []
	for (const field of RANGE_LOCKED_FIELDS)
		if (!lockedEqual(field, current, patch)) fields.push(field)
	return fields
}

/** Defined live keys only; `protocols` is a copy so the patch stays unchanged. */
function liveSnapshot(range: ScanRange): ScanRangeLive {
	const out: ScanRangeLive = {}
	for (const field of RANGE_LIVE_FIELDS) {
		switch (field) {
			case "enabled":
				if (range.enabled !== undefined) out.enabled = range.enabled
				break
			case "protocols":
				if (range.protocols !== undefined) out.protocols = [...range.protocols]
				break
			case "name":
				if (range.name !== undefined) out.name = range.name
				break
			case "dwellMs":
				if (range.dwellMs !== undefined) out.dwellMs = range.dwellMs
				break
			case "sensitivity":
				if (range.sensitivity !== undefined) out.sensitivity = range.sensitivity
				break
		}
	}
	return out
}

function countIssue(expected: number, received: number): PlanIssue {
	return {
		code: "range-locked",
		severity: "error",
		message: "a running job's ranges cannot be added or removed",
		details: { reason: "range-count", expected, received },
	}
}

function fieldIssue(
	index: number,
	fields: readonly RangeLockedField[],
): PlanIssue {
	const names = [...fields]
	return {
		code: "range-locked",
		severity: "error",
		message: `range ${index}: ${names.join(", ")} cannot change while the job exists; stop it to change edges or channel spacing`,
		details: { index, fields: names },
	}
}

export const applyRangePatch: ApplyRangePatch = (current, patch) => {
	if (patch.length !== current.length) {
		return {
			rangeLive: [],
			issues: [countIssue(current.length, patch.length)],
		}
	}
	const issues: PlanIssue[] = []
	for (let i = 0; i < current.length; i++) {
		const left = current[i]
		const right = patch[i]
		const fields =
			left === undefined || right === undefined
				? [...RANGE_LOCKED_FIELDS]
				: differingLocked(left, right)
		if (fields.length > 0) issues.push(fieldIssue(i, fields))
	}
	if (issues.length > 0) return { rangeLive: [], issues }
	return {
		rangeLive: patch.map(range => liveSnapshot(range)),
		issues: [],
	}
}
