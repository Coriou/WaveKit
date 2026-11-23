/**
 * File names of the digital-voice call recorder.
 *
 * A final recording takes dsd-fme's close_and_rename_wav_file shape, so the `dsd~<name>` keep key,
 * the `dsd:<n>~<name>` inventory id and the per-call pruner accept it unchanged:
 * `YYYYMMDD_HHMMSS_<rand5>_<decoder>_<GROUP|PRIVATE|UNIT>_TGT_<tg>_SRC_<src>.wav`.
 * The in-progress file is `TEMP_dv_YYYYMMDD_HHMMSS_<%04X>.wav`: neither the inventory nor the pruner
 * matches it, and only the recorder's own start sweep removes it.
 *
 * Every field is reduced to `[A-Za-z0-9-]` (a `_` would split the name's fields). The decoder
 * field is never a lossy cut of the id: it is the id itself or a stable hash of it
 * (`dvCallNameField` in recordings/names.ts), mapped back only by an exact match.
 */

import { dvCallNameField } from "../recordings/names.js"

/** The recorder's in-progress name (swept at start only). */
export const DV_TEMP_WAV = /^TEMP_dv_\d{8}_\d{6}_[0-9A-F]{4}\.wav$/

/**
 * Field caps (the decoder field is dvCallNameField's: at most 18). A name is `22 + decoder + 1 + type (≤ 7) + 5 + tg + 5 + src + 4` characters
 * = 44 + decoder + tg + src. The inventory lists ids of at most 100 characters
 * (RECORDINGS_ID_MAX_LENGTH) and an id is `dsd:<n>~<name>` with n ≤ 9 999 (9 characters), so a
 * name stays listable while 44 + decoder + tg + src ≤ 91: 18 + 14 + 15 = 47 gives exactly 91.
 */
export const DV_NAME_DECODER_MAX = 18
export const DV_NAME_TALKGROUP_MAX = 14
export const DV_NAME_SOURCE_MAX = 15
/** Longest final name: 44 + 18 + 14 + 15 = 91 characters. */
export const DV_NAME_MAX = 91

export type DvCallNameType = "group" | "private" | "unit"

/** What a final name says about the call; every field may be unknown. */
export interface DvCallNameInfo {
	callType: DvCallNameType | null
	talkgroup: string | null
	source: string | null
}

/**
 * One name field: every character outside `[A-Za-z0-9-]` becomes `-` (so `/`, `.`, `_` and
 * spaces do), runs of `-` collapse to one, leading and trailing `-` go, then the field is cut to
 * `max` characters (keeping the head, or the tail with `keepTail`). An empty result is `fallback`.
 */
export function sanitizeNameField(
	value: string | null | undefined,
	max: number,
	fallback: string,
	keepTail = false,
): string {
	if (typeof value !== "string") return fallback
	let s = value
		.replace(/[^A-Za-z0-9-]/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "")
	if (s.length > max) s = keepTail ? s.slice(s.length - max) : s.slice(0, max)
	s = s.replace(/^-|-$/g, "")
	return s.length > 0 ? s : fallback
}

function pad(n: number, width: number): string {
	return String(n).padStart(width, "0")
}

/** `YYYYMMDD_HHMMSS` in local time, as dsd-fme names its files. */
export function localStamp(ms: number): string {
	const d = new Date(ms)
	return (
		pad(d.getFullYear() % 10_000, 4) +
		pad(d.getMonth() + 1, 2) +
		pad(d.getDate(), 2) +
		"_" +
		pad(d.getHours(), 2) +
		pad(d.getMinutes(), 2) +
		pad(d.getSeconds(), 2)
	)
}

/** The in-progress name; `tag` is reduced to 0..0xFFFF. */
export function dvTempFileName(startedAtMs: number, tag: number): string {
	const hex = (Math.trunc(Math.abs(tag)) & 0xffff)
		.toString(16)
		.toUpperCase()
		.padStart(4, "0")
	return `TEMP_dv_${localStamp(startedAtMs)}_${hex}.wav`
}

const TYPE_WORD: Record<DvCallNameType, string> = {
	group: "GROUP",
	private: "PRIVATE",
	unit: "UNIT",
}

/**
 * The final name of a call recording. `rand` is reduced to five digits (0..99 999). An unknown
 * call type is GROUP and an unknown talkgroup or source is `0`, as dsd-fme writes them.
 */
export function dvCallFileName(
	startedAtMs: number,
	rand: number,
	decoderId: string,
	info: DvCallNameInfo | null,
): string {
	const r = pad(Math.trunc(Math.abs(rand)) % 100_000, 5)
	// At most DV_NAME_DECODER_MAX (18) characters: the id, or `h` + 8 base36 digits.
	const dec = dvCallNameField(decoderId)
	const type = TYPE_WORD[info?.callType ?? "group"]
	const tg = sanitizeNameField(info?.talkgroup, DV_NAME_TALKGROUP_MAX, "0")
	const src = sanitizeNameField(info?.source, DV_NAME_SOURCE_MAX, "0")
	return `${localStamp(startedAtMs)}_${r}_${dec}_${type}_TGT_${tg}_SRC_${src}.wav`
}
