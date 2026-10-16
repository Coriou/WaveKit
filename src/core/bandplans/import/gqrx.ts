/**
 * Total parser for Gqrx `bandplan.csv` bytes: `start,end,mode,step,color,name`
 * per line. Never throws. Oversized input is rejected before decoding.
 * Failure reasons are fixed tokens and never include file content.
 */
import { BANDPLANS_LIMITS } from "@wavekit/api-types"
import type { ImportSkipReason } from "@wavekit/api-types"
import type { BandPlanImportParser } from "../contract.js"
import {
	assembleImport,
	decodeStrictUtf8,
	invalid,
	tooLarge,
} from "./group-map.js"
import type { RawImportRow } from "./group-map.js"

const LINE_MAX = 1024
const FIELD_COUNT = 6

export const parseGqrxBandPlan: BandPlanImportParser = (bytes, options) => {
	try {
		if (bytes.length > BANDPLANS_LIMITS.importFileBytes) return tooLarge()
		const text = decodeStrictUtf8(bytes)
		if (text === null) return invalid("encoding")
		const entries: (RawImportRow | ImportSkipReason)[] = []
		let start = 0
		while (start <= text.length) {
			let end = text.indexOf("\n", start)
			if (end < 0) end = text.length
			let lineEnd = end
			if (lineEnd > start && text.charCodeAt(lineEnd - 1) === 13) lineEnd -= 1
			const entry = readLine(text, start, lineEnd)
			start = end + 1
			if (entry === null) continue
			if (entries.length >= BANDPLANS_LIMITS.importRows)
				return invalid("row-limit")
			entries.push(entry)
		}
		return assembleImport(entries, {
			format: "gqrx-csv",
			bytes,
			fileName: options.fileName,
			overrides: options.overrides,
			rowsExamined: entries.length,
		})
	} catch {
		return invalid("shape")
	}
}

/** Null for a blank or comment line (not a row). */
function readLine(
	text: string,
	from: number,
	to: number,
): RawImportRow | ImportSkipReason | null {
	let first = from
	while (first < to && isBlank(text.charCodeAt(first))) first += 1
	if (first === to || text.charCodeAt(first) === 35) return null
	if (to - from > LINE_MAX) return "malformed-row"
	// Slice the line first so the comma search can never scan past its end.
	const line = text.slice(from, to)
	const fields: string[] = []
	let at = 0
	for (let i = 0; i < FIELD_COUNT - 1; i++) {
		const comma = line.indexOf(",", at)
		if (comma < 0) return "malformed-row"
		fields.push(line.slice(at, comma).trim())
		at = comma + 1
	}
	fields.push(line.slice(at).trim())
	const [minHz, maxHz, mode, step, color, name] = fields
	if (
		minHz === undefined ||
		maxHz === undefined ||
		mode === undefined ||
		step === undefined ||
		color === undefined ||
		name === undefined
	)
		return "malformed-row"
	return {
		name,
		minHz,
		maxHz,
		mode,
		step: step.length === 0 ? null : step,
		color: color.length === 0 ? null : color,
	}
}

function isBlank(code: number): boolean {
	return code === 32 || code === 9 || code === 13
}
