/**
 * Total parser for SDR++ band-plan JSON bytes. Never throws. Oversized
 * input is rejected before decoding. Failure reasons are fixed tokens and
 * never include file content.
 */
import { createHash } from "node:crypto"
import { BANDPLANS_LIMITS } from "@wavekit/api-types"
import type { ImportSkipReason, StoredBand } from "@wavekit/api-types"
import type {
	ParsedImportPreview,
	ParseSdrppBandPlan,
	SdrppParseOptions,
} from "../contract.js"
import { aggregateImportReport, mapImportGroup } from "./group-map.js"
import type { MappedImportRow } from "./group-map.js"
import {
	allocateId,
	countSkip,
	decodeStrictUtf8,
	exceedsCodePoints,
	invalid,
	NAME_CODE_POINTS,
	slugFromName,
	sourceTypeOf,
	TEXT_INVALID,
	toStoredBand,
	tooLarge,
} from "./group-map.js"
import type { NormalizedRow } from "./group-map.js"

const META_CODE_POINTS = 80
const COLOUR_PATTERN = /^#[0-9a-fA-F]{6}$/

interface DocumentRead {
	ok: true
	meta: ParsedImportPreview["meta"]
	bands: readonly unknown[]
}

export const parseSdrppBandPlan: ParseSdrppBandPlan = (bytes, options) => {
	try {
		return parseBody(bytes, options)
	} catch {
		return invalid("shape")
	}
}

function parseBody(
	bytes: Uint8Array,
	options: SdrppParseOptions,
): ReturnType<ParseSdrppBandPlan> {
	if (bytes.length > BANDPLANS_LIMITS.importFileBytes) return tooLarge()
	const text = decodeStrictUtf8(bytes)
	if (text === null) return invalid("encoding")
	const parsed = parseJson(text)
	if (!parsed.ok) return invalid("json")
	const document = readDocument(parsed.value)
	if (!document.ok) return invalid(document.reason)

	const seen = new Set<string>()
	const usedIds = new Set<string>()
	const skipCounts = new Map<ImportSkipReason, number>()
	const rows: MappedImportRow[] = []
	const bands: StoredBand[] = []

	for (const raw of document.bands) {
		const inspected = inspectRow(raw)
		if (typeof inspected === "string") {
			countSkip(skipCounts, inspected)
			continue
		}
		const duplicateKey = JSON.stringify([
			inspected.name,
			inspected.startHz,
			inspected.endHz,
		])
		if (seen.has(duplicateKey)) {
			countSkip(skipCounts, "duplicate")
			continue
		}
		if (bands.length >= BANDPLANS_LIMITS.bandsPerPack) {
			countSkip(skipCounts, "pack-band-limit")
			continue
		}
		seen.add(duplicateKey)
		const mapping = mapImportGroup(
			inspected.sourceType,
			inspected.name,
			options.overrides,
		)
		const band = toStoredBand(
			allocateId(slugFromName(inspected.name), usedIds),
			inspected,
			mapping.group,
		)
		bands.push(band)
		rows.push({
			sourceType: inspected.sourceType,
			mapping,
			colourHint: inspected.colourHint,
		})
	}

	if (bands.length === 0) return invalid("empty")
	const preview: ParsedImportPreview = {
		format: "sdrpp-json",
		fileName: options.fileName,
		bytes: bytes.length,
		sha256: createHash("sha256").update(bytes).digest("hex"),
		meta: document.meta,
		trust: "community-unverified",
		bands,
		report: aggregateImportReport(document.bands.length, skipCounts, rows),
	}
	return { ok: true, value: { preview, bands } }
}

function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
	try {
		return { ok: true, value: JSON.parse(text) as unknown }
	} catch {
		return { ok: false }
	}
}

function readDocument(
	value: unknown,
): DocumentRead | { ok: false; reason: "shape" | "row-limit" } {
	if (!isRecord(value)) return { ok: false, reason: "shape" }
	const bands = value["bands"]
	if (!Array.isArray(bands)) return { ok: false, reason: "shape" }
	if (bands.length > BANDPLANS_LIMITS.importRows)
		return { ok: false, reason: "row-limit" }
	return { ok: true, meta: readMeta(value), bands }
}

function readMeta(value: Record<string, unknown>): ParsedImportPreview["meta"] {
	return {
		name: boundedText(value["name"], META_CODE_POINTS),
		countryName: boundedText(value["country_name"], META_CODE_POINTS),
		countryCode: boundedText(value["country_code"], META_CODE_POINTS),
		author: boundedText(value["author_name"], META_CODE_POINTS),
		version: versionText(value["version"]),
	}
}

function versionText(value: unknown): string | null {
	if (typeof value === "number") {
		if (!Number.isFinite(value)) return null
		return boundedText(String(value), META_CODE_POINTS)
	}
	return boundedText(value, META_CODE_POINTS)
}

function boundedText(value: unknown, maxCodePoints: number): string | null {
	if (typeof value !== "string") return null
	const trimmed = value.trim()
	if (trimmed.length === 0 || TEXT_INVALID.test(trimmed)) return null
	if (exceedsCodePoints(trimmed, maxCodePoints)) return null
	return trimmed
}

function inspectRow(row: unknown): ImportSkipReason | NormalizedRow {
	if (!isRecord(row)) return "malformed-row"
	const rawName = row["name"]
	const rawStart = row["start"]
	const rawEnd = row["end"]
	const rawType = row["type"]
	if (typeof rawName !== "string") return "malformed-row"
	if (typeof rawStart !== "number" || typeof rawEnd !== "number")
		return "malformed-row"
	if (!Number.isFinite(rawStart) || !Number.isFinite(rawEnd))
		return "malformed-row"
	if (rawType !== undefined && typeof rawType !== "string")
		return "malformed-row"
	const name = rawName.trim()
	if (name.length === 0) return "unnamed"
	if (TEXT_INVALID.test(name) || exceedsCodePoints(name, NAME_CODE_POINTS))
		return "text-invalid"
	const startHz = Math.round(rawStart)
	const endHz = Math.round(rawEnd)
	if (startHz >= endHz) return "invalid-edges"
	if (
		startHz < 1 ||
		endHz < 1 ||
		startHz > BANDPLANS_LIMITS.frequencyHzMax ||
		endHz > BANDPLANS_LIMITS.frequencyHzMax
	)
		return "out-of-range"
	const typeText = typeof rawType === "string" ? rawType : ""
	return {
		name,
		sourceType: sourceTypeOf(typeText),
		startHz,
		endHz,
		colourHint: colourOf(typeText.trim()),
	}
}

function colourOf(trimmedType: string): string | null {
	if (!COLOUR_PATTERN.test(trimmedType)) return null
	return trimmedType.toLowerCase()
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}
