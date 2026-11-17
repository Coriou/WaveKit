/**
 * Recording name patterns of the WG8 inventory (docs/specs/web-gaps-8, requirement 4).
 *
 * The scanner patterns are copies of the scanner evidence store's (the store pulls zod and its
 * persistence into the startup bundle, so it is not imported here); a unit test pins them equal.
 */

import { createHash } from "node:crypto"
import type { RecordingCallType } from "@wavekit/api-types"

/** Scanner recording id `${discoveryId}~${fileName}` (evidence-store RECORDING_ID). */
export const SCANNER_RECORDING_ID = /^(d_[0-9A-Za-z]+)~([A-Za-z0-9_.-]+\.wav)$/
/** Scanner discovery id (evidence-store DISCOVERY_ID); `probe-*` folders never match. */
export const SCANNER_DISCOVERY_ID = /^d_[0-9A-Za-z]+$/
/** Scanner recording kinds, in lookup order (dv first). */
export const SCANNER_RECORDING_KINDS = ["dv", "analog"] as const
/**
 * The discovery folder ids of scanner paths relative to the evidence root (or deeper): each
 * `d_<id>` segment that follows a `dv` or `analog` segment, deduplicated, at most `max`.
 */
export function recordingFolderIdsOf(
	paths: readonly string[],
	max = 4_096,
): string[] {
	const out = new Set<string>()
	for (const p of paths) {
		if (typeof p !== "string") continue
		const parts = p.split(/[\\/]/)
		for (let i = 1; i < parts.length; i++) {
			const prev = parts[i - 1]
			const seg = parts[i]
			if (
				(prev === "dv" || prev === "analog") &&
				seg !== undefined &&
				SCANNER_DISCOVERY_ID.test(seg)
			)
				out.add(seg)
		}
		if (out.size >= max) break
	}
	return [...out]
}

/** dsd-fme close_and_rename_wav_file name (evidence-store CALL_WAV). */
export const CALL_WAV =
	/^(\d{8})_(\d{6})_\d{5}_.+_(?:GROUP|PRIVATE|UNIT)_TGT_([^_]+)_SRC_([^_.]+)\.wav$/

/** A decoder id the dv-call name field carries verbatim: `[A-Za-z0-9-]{1,18}`. */
export const DV_CALL_DECODER_LITERAL = /^[A-Za-z0-9-]{1,18}$/
/** 36^8 = 2 821 109 907 456 (about 2^41.4) hash values. */
const DV_CALL_HASH_SPACE = 36n ** 8n
const DV_CALL_HASH_MEMO_MAX = 256
const hashedFields = new Map<string, string>()

/**
 * The decoder field of a dv-call recorder name for `decoderId`: the id itself when it already
 * matches DV_CALL_DECODER_LITERAL, else `h` plus 8 base36 digits of the SHA-256 of the exact id
 * (its first 64 bits mod 36^8; 9 characters). The field never loses an id silently: a reader maps
 * it back only by an exact match against known ids (dvCallDecoderOf).
 *
 * Collisions: k distinct hashed ids collide with probability at most k(k-1)/2 / 36^8; for
 * k = 1 000 that is 499 500 / 2 821 109 907 456 ≈ 1.8e-7. A hashed field may also equal a literal
 * 9-character id `h…`. Either case is ambiguous and reads as no decoder (null), never a guess.
 */
export function dvCallNameField(decoderId: string): string {
	if (DV_CALL_DECODER_LITERAL.test(decoderId)) return decoderId
	const memo = hashedFields.get(decoderId)
	if (memo !== undefined) return memo
	const digest = createHash("sha256").update(decoderId, "utf8").digest()
	const n = digest.readBigUInt64BE(0) % DV_CALL_HASH_SPACE
	const field = "h" + n.toString(36).padStart(8, "0")
	// The inventory maps every listed file against the known ids: a bounded memo (256 ids,
	// cleared when full) keeps that to one hash per id.
	if (hashedFields.size >= DV_CALL_HASH_MEMO_MAX) hashedFields.clear()
	hashedFields.set(decoderId, field)
	return field
}

/**
 * The decoder field of a dv-call recorder name (`<stamp>_<rand5>_<field>_<TYPE>_TGT_…`), or null
 * when the name is not in that shape. The field is not a decoder id: see dvCallDecoderOf.
 */
const DV_CALL_DECODER =
	/^\d{8}_\d{6}_\d{5}_([A-Za-z0-9-]{1,18})_(?:GROUP|PRIVATE|UNIT)_TGT_/
export function dvCallDecoderField(name: string): string | null {
	return DV_CALL_DECODER.exec(name)?.[1] ?? null
}

/**
 * The known decoder id whose name field is `field`: exactly one of `knownIds` must map to it
 * (dvCallNameField). Unknown, ambiguous (two ids, one field) or a null field gives null.
 */
export function dvCallDecoderOf(
	field: string | null,
	knownIds: Iterable<string>,
): string | null {
	if (field === null) return null
	let found: string | null = null
	for (const id of new Set(knownIds)) {
		if (dvCallNameField(id) !== field) continue
		if (found !== null) return null
		found = id
	}
	return found
}

const CALL_TYPE = /_(GROUP|PRIVATE|UNIT)_TGT_[^_]+_SRC_[^_.]+\.wav$/
const LEADING_STAMP = /^(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})_/
const DIGITS = /^\d{1,10}$/

export interface CallNameFields {
	startedAtLocal: string | null
	callType: RecordingCallType | null
	talkgroup: string | null
	source: string | null
}

const NO_FIELDS: CallNameFields = {
	startedAtLocal: null,
	callType: null,
	talkgroup: null,
	source: null,
}

function daysInMonth(year: number, month: number): number {
	return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

/**
 * `YYYY-MM-DDTHH:MM:SS` from a leading `YYYYMMDD_HHMMSS_` only when it is a real calendar
 * date-time (month 1-12, day within the month, hour 0-23, minute and second 0-59); else null.
 */
export function startedAtLocalFromName(name: string): string | null {
	const m = LEADING_STAMP.exec(name)
	if (!m) return null
	const [, ys, mos, ds, hs, mis, ss] = m
	if (!ys || !mos || !ds || !hs || !mis || !ss) return null
	const y = Number(ys)
	const mo = Number(mos)
	const d = Number(ds)
	const h = Number(hs)
	const mi = Number(mis)
	const s = Number(ss)
	if (y < 1 || mo < 1 || mo > 12) return null
	if (d < 1 || d > daysInMonth(y, mo)) return null
	if (h > 23 || mi > 59 || s > 59) return null
	return `${ys}-${mos}-${ds}T${hs}:${mis}:${ss}`
}

/** Fields of a dsd-fme call name (CALL_WAV); every field null when the name does not match. */
export function callNameFields(name: string): CallNameFields {
	const m = CALL_WAV.exec(name)
	if (!m) return NO_FIELDS
	const t = CALL_TYPE.exec(name)?.[1]
	const tg = m[3]
	const src = m[4]
	return {
		startedAtLocal: startedAtLocalFromName(name),
		callType:
			t === "GROUP"
				? "group"
				: t === "PRIVATE"
					? "private"
					: t === "UNIT"
						? "unit"
						: null,
		talkgroup: tg !== undefined && DIGITS.test(tg) ? tg : null,
		source: src !== undefined && DIGITS.test(src) ? src : null,
	}
}
