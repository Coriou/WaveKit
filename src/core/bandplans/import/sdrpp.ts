/**
 * Total parser for SDR++ band-plan JSON bytes. Never throws. Oversized
 * input is rejected before decoding. Failure reasons are fixed tokens and
 * never include file content.
 */
import { createHash } from "node:crypto"
import { BANDPLANS_LIMITS } from "@wavekit/api-types"
import type {
	ImportPreview,
	ImportSkipReason,
	StoredBand,
} from "@wavekit/api-types"
import type {
	ParseSdrppBandPlan,
	SdrppFailureReason,
	SdrppParseFailure,
	SdrppParseOptions,
} from "../contract.js"
import { aggregateImportReport, mapImportGroup } from "./group-map.js"
import type { MappedImportRow } from "./group-map.js"

const META_CODE_POINTS = 80
const NAME_CODE_POINTS = 80
const SOURCE_TYPE_MAX = 64
const SLUG_MAX = 56
const ID_MAX = 64
const ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/
const COLOUR_PATTERN = /^#[0-9a-fA-F]{6}$/
const TEXT_INVALID = /[\p{Cc}\p{Cs}]/u

const IMPORTED_PROVENANCE: StoredBand["provenance"] = Object.freeze({
	kind: "imported",
})

interface DocumentRead {
	ok: true
	meta: ImportPreview["meta"]
	bands: readonly unknown[]
}

interface NormalizedRow {
	readonly name: string
	readonly sourceType: string
	readonly startHz: number
	readonly endHz: number
	readonly colourHint: string | null
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
	const text = decodeStrict(bytes)
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
	const preview: ImportPreview = {
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

/**
 * Size failures use reason "too-large". That token is not on the frozen
 * `SdrppFailureReason` union; `code` is the discriminator callers switch on.
 */
function tooLarge(): SdrppParseFailure {
	const reason = "too-large" as SdrppFailureReason
	return { ok: false, code: "BANDPLANS_IMPORT_TOO_LARGE", reason }
}

function invalid(reason: SdrppFailureReason): SdrppParseFailure {
	return { ok: false, code: "BANDPLANS_IMPORT_INVALID", reason }
}

function decodeStrict(bytes: Uint8Array): string | null {
	let view = bytes
	const b0 = bytes[0]
	const b1 = bytes[1]
	const b2 = bytes[2]
	if (bytes.length >= 3 && b0 === 0xef && b1 === 0xbb && b2 === 0xbf)
		view = bytes.subarray(3)
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(view)
	} catch {
		return null
	}
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

function readMeta(value: Record<string, unknown>): ImportPreview["meta"] {
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

/** Trimmed, capped at 64 so it fits an operator override key. */
function sourceTypeOf(type: string): string {
	const trimmed = type.trim()
	return trimmed.length <= SOURCE_TYPE_MAX
		? trimmed
		: trimmed.slice(0, SOURCE_TYPE_MAX)
}

function colourOf(trimmedType: string): string | null {
	if (!COLOUR_PATTERN.test(trimmedType)) return null
	return trimmedType.toLowerCase()
}

function toStoredBand(
	id: string,
	row: NormalizedRow,
	group: StoredBand["group"],
): StoredBand {
	return {
		id,
		name: row.name,
		startHz: row.startHz,
		endHz: row.endHz,
		group,
		mode: null,
		bandwidthHz: null,
		stepHz: null,
		skip: null,
		channels: [],
		parentId: null,
		colourHint: row.colourHint,
		registryRef: null,
		scan: null,
		provenance: IMPORTED_PROVENANCE,
	}
}

/**
 * Lowercase, collapse non-alphanumerics to "-", trim dashes, keep at most
 * 56 characters, then prefix "b-" unless it starts with a letter. An empty
 * slug becomes "band". Later repeats get "-2", "-3", skipping ids already
 * used in this file.
 */
function slugFromName(name: string): string {
	let slug = name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
	if (slug.length > SLUG_MAX) slug = slug.slice(0, SLUG_MAX).replace(/-+$/g, "")
	if (slug.length === 0) return "band"
	if (!/^[a-z]/.test(slug)) return `b-${slug}`
	return slug
}

function allocateId(base: string, used: Set<string>): string {
	const first = reserve(base, used)
	if (first !== null) return first
	for (let n = 2; n <= 10_000; n++) {
		const next = reserve(fitSuffix(base, n), used)
		if (next !== null) return next
	}
	for (let n = 0; n <= 10_000; n++) {
		const next = reserve(`b-${n.toString(16)}`, used)
		if (next !== null) return next
	}
	// Unreachable within the 512-band pack cap. The outer catch stays total.
	throw new Error("band-id")
}

function fitSuffix(base: string, n: number): string {
	const suffix = `-${n}`
	let stem = base
	if (stem.length + suffix.length > ID_MAX)
		stem = stem.slice(0, ID_MAX - suffix.length).replace(/-+$/g, "")
	if (stem.length === 0 || !/^[a-z]/.test(stem)) stem = "band"
	return stem + suffix
}

function reserve(id: string, used: Set<string>): string | null {
	if (!ID_PATTERN.test(id) || used.has(id)) return null
	used.add(id)
	return id
}

function countSkip(
	counts: Map<ImportSkipReason, number>,
	reason: ImportSkipReason,
): void {
	counts.set(reason, (counts.get(reason) ?? 0) + 1)
}

function exceedsCodePoints(value: string, max: number): boolean {
	let count = 0
	for (let i = 0; i < value.length; ) {
		const code = value.codePointAt(i)
		if (code === undefined) break
		count += 1
		if (count > max) return true
		i += code > 0xffff ? 2 : 1
	}
	return false
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}
