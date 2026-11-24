/**
 * dsd-fme per-call WAV file names (`-7 <dir> -P`), per protocol, and the name pattern of one
 * call's own recording.
 *
 * Grammar (pinned dsd-fme ed1d1d6): dsd_file.c close_and_rename_wav_file writes
 * `<YYYYMMDD>_<HHMMSS>_<%05d random>_<sysid>_<gi>_TGT_<tgt>_SRC_<src>.wav`, where `<gi>` is
 * `GROUP`, `PRIVATE` or empty (an unset gi), and `<tgt>`/`<src>` are the event's strings for the
 * string protocols (D-STAR, YSF, dPMR, M17, EDACS) or its decimal ids otherwise. dsd_events.c
 * watchdog_event_history builds the sysid and the strings:
 *
 * - DMR: `DMR_CC_<cc>` or `DMR_<syscode %X>_CC_<cc>`; numeric TGT/SRC.
 * - P25 (phase 1 and 2): `P25_<nac %03X>` or `P25_<wacn %05X><sysid %03X><nac %03X>_<rfss>_<site>`;
 *   numeric TGT/SRC.
 * - NXDN: `NXDN_RAN_<ran>` or `NXDN_<sys>_<site>_RAN_<ran>`; numeric TGT/SRC.
 * - D-STAR: `DSTAR`; TGT the 8-character UR field, SRC the 12-character MY field (callsign 8 +
 *   suffix 4), each space or non-printable byte written `_`.
 * - YSF: `YSF`; TGT and SRC the 10-character CSD1 destination and source, written like D-STAR's.
 * - dPMR: `DPMR_CC_<cc>`; TGT/SRC the raw called and calling id strings.
 *
 * Names on disk are untrusted: a call matches only a name built from its own fields, every field
 * escaped, and a call without the fields that tell its file from another call's gets no pattern
 * (no link): dPMR and ProVoice calls carry no identity, a D-STAR call without MY, a YSF call
 * without its source callsign, a numeric call without its talkgroup or source.
 */

/** The call fields a recording name is matched on (a structural view of the adapter's state). */
export interface DsdFmeWavCall {
	protocol: string | null
	talkgroup: number | null
	source: number | null
	dmr?: { cc?: number | undefined } | undefined
	p25?:
		| { nac?: string | undefined; unitTarget?: number | undefined }
		| undefined
	nxdn?: { ran?: number | undefined } | undefined
	dstar?: { my?: string | undefined; ur?: string | undefined } | undefined
	ysf?: { callsign?: string | undefined } | undefined
}

/** `YYYYMMDD_HHMMSS` (group 1), the random field (`%05d`, a minimum width) and `_`. */
const HEAD = "^(\\d{8}_\\d{6})_\\d+_"
const GI = "(?:GROUP|PRIVATE|UNIT)?"
/** One byte of a sanitized string field: printable ASCII but `/` (a name holds no directory). */
const FIELD_CHAR = "[!-.0-~]"

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * A string field as dsd_events.c writes it: padded to its `width`, each space and each byte
 * outside printable ASCII becomes `_`. Null when the value is longer than its field or would put
 * `/` in the name.
 */
function sanitized(value: string, width: number): string | null {
	if (value.length > width) return null
	let out = ""
	for (const ch of value.padEnd(width, " ")) {
		const c = ch.charCodeAt(0)
		out += c > 0x20 && c < 0x7f ? ch : "_"
	}
	return out.includes("/") ? null : out
}

function decimal(n: number | null | undefined): string | null {
	return n !== null && n !== undefined && Number.isSafeInteger(n) && n >= 0
		? String(n)
		: null
}

function numericTail(
	tg: number | null | undefined,
	src: number | null,
): string | null {
	const t = decimal(tg)
	const s = decimal(src)
	return t === null || s === null ? null : `_${GI}_TGT_${t}_SRC_${s}\\.wav$`
}

/** The sysid alternatives of a protocol, or null when the call's own field is malformed. */
function sysPattern(call: DsdFmeWavCall): string | null {
	switch (call.protocol) {
		case "dmr": {
			const cc = call.dmr?.cc
			const ccPat = cc === undefined ? "\\d+" : decimal(cc)
			return ccPat === null ? null : `DMR_(?:[0-9A-F]+_)?CC_${ccPat}`
		}
		case "p25p1":
		case "p25p2": {
			const raw = call.p25?.nac
			let nac = "[0-9A-F]{3}"
			if (raw !== undefined) {
				if (!/^[0-9A-Fa-f]{1,3}$/.test(raw)) return null
				nac = parseInt(raw, 16).toString(16).toUpperCase().padStart(3, "0")
			}
			return `P25_(?:[0-9A-F]{5}[0-9A-F]{3}${nac}_\\d+_\\d+|${nac})`
		}
		case "nxdn48":
		case "nxdn96": {
			const ran = call.nxdn?.ran
			const ranPat = ran === undefined ? "\\d+" : decimal(ran)
			return ranPat === null ? null : `NXDN_(?:\\d+_\\d+_)?RAN_${ranPat}`
		}
		default:
			return null
	}
}

/**
 * The pattern of the recording dsd-fme names for `call` (group 1 the `YYYYMMDD_HHMMSS` stamp),
 * or null when the call's fields cannot tell its file from another call's.
 */
export function dsdFmeCallWavPattern(call: DsdFmeWavCall): RegExp | null {
	switch (call.protocol) {
		case "dstar": {
			const myRaw = call.dstar?.my
			if (myRaw === undefined || myRaw.trim() === "") return null
			const my = sanitized(myRaw, 8)
			if (my === null) return null
			const urRaw = call.dstar?.ur
			let ur = `${FIELD_CHAR}{0,8}`
			if (urRaw !== undefined) {
				const u = sanitized(urRaw, 8)
				if (u === null) return null
				ur = escapeRegExp(u)
			}
			return new RegExp(
				`${HEAD}DSTAR_${GI}_TGT_${ur}_SRC_${escapeRegExp(my)}${FIELD_CHAR}{0,4}\\.wav$`,
			)
		}
		case "ysf": {
			const raw = call.ysf?.callsign
			if (raw === undefined || raw.trim() === "") return null
			const src = sanitized(raw, 10)
			if (src === null) return null
			return new RegExp(
				`${HEAD}YSF_${GI}_TGT_${FIELD_CHAR}{0,10}_SRC_${escapeRegExp(src)}\\.wav$`,
			)
		}
		default: {
			const sys = sysPattern(call)
			if (sys === null) return null
			const tg =
				call.protocol === "p25p1" || call.protocol === "p25p2"
					? (call.p25?.unitTarget ?? call.talkgroup)
					: call.talkgroup
			const tail = numericTail(tg, call.source)
			return tail === null ? null : new RegExp(`${HEAD}${sys}${tail}`)
		}
	}
}
