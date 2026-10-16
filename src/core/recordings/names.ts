/**
 * Recording name patterns of the WG8 inventory (docs/specs/web-gaps-8, requirement 4).
 *
 * The scanner patterns are copies of the scanner evidence store's (the store pulls zod and its
 * persistence into the startup bundle, so it is not imported here); a unit test pins them equal.
 */

import type { RecordingCallType } from "@wavekit/api-types"

/** Scanner recording id `${discoveryId}~${fileName}` (evidence-store RECORDING_ID). */
export const SCANNER_RECORDING_ID = /^(d_[0-9A-Za-z]+)~([A-Za-z0-9_.-]+\.wav)$/
/** Scanner discovery id (evidence-store DISCOVERY_ID); `probe-*` folders never match. */
export const SCANNER_DISCOVERY_ID = /^d_[0-9A-Za-z]+$/
/** Scanner recording kinds, in lookup order (dv first). */
export const SCANNER_RECORDING_KINDS = ["dv", "analog"] as const
/** dsd-fme close_and_rename_wav_file name (evidence-store CALL_WAV). */
export const CALL_WAV =
	/^(\d{8})_(\d{6})_\d{5}_.+_(?:GROUP|PRIVATE|UNIT)_TGT_([^_]+)_SRC_([^_.]+)\.wav$/

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
