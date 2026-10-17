// What the palette's field understands (DESIGN.md "Command palette (⌘K), first pass"): typed and pasted
// frequencies, command words with a value (`gain 30`, `sq 90`, `bw 25k`, `vol 60`, `rate 2.048`, `step 6.25k`,
// a mode name) and identifiers (talkgroup, capcode, MMSI). Pure: no DOM, no stores.
import {
	parseFrequency,
	TUNER_RANGE,
	type FrequencyRange,
} from "../tuner/frequency.ts"
import type { Modulation } from "../tuner/modes.ts"

export interface ParsedTune {
	kind: "ok"
	hz: number
	/** `+25k` / `-12.5k`: a step from the tuned frequency. */
	relative: boolean
	hint: string | null
	/** Read out of pasted text ("Freq: 118.700 MHz AM"). */
	pasted: boolean
	mode: Modulation | null
	/** A trailing bandwidth in pasted text ("12.5 kHz"). */
	bandwidthHz: number | null
}

export type FrequencyIntent =
	| { kind: "none" }
	| { kind: "error"; message: string }
	| ParsedTune

/** Command words are never read as frequencies (`gain 30`, `step 6.25k`). */
const COMMAND_WORD =
	/^(gain|g|sq|squelch|sql|bw|bandwidth|filter|step|rate|sr|vol|volume|mode|tg|talkgroup|cap|capcode|pager|ric|mmsi)\b/

const MODE_WORD = /\b(nfm|wfm|am|usb|lsb|cw|fm)\b/

function modeOf(word: string): Modulation {
	return word === "fm" ? "nfm" : (word as Modulation)
}

/** "161.150.000", "161 150 000", "446,00625" → a plain decimal string. */
function normaliseNumber(raw: string): string {
	const t = raw.replace(/[\s']/g, "")
	const seps = (t.match(/[.,]/g) ?? []).length
	return seps > 1 ? t.replace(/[.,]/g, "") : t.replace(",", ".")
}

/**
 * Pasted or copied text: grouped digits (`161.150.000`, `161 150 000`), a unit (`446,00625 MHz`, `161150000 Hz`),
 * a label and a mode (`Freq: 118.700 MHz AM`) and a trailing bandwidth (`12.5 kHz`). A bare number is left to the
 * plain parser; so is anything starting with a command word.
 */
export function parsePasted(
	input: string,
	currentHz: number,
	range: FrequencyRange = TUNER_RANGE,
): FrequencyIntent {
	const s = input.trim().toLowerCase()
	if (!s || COMMAND_WORD.test(s)) return { kind: "none" }
	const modeMatch = MODE_WORD.exec(s)
	const nums: { raw: string; unit: string }[] = []
	const re = /(\d[\d\s.,']*\d|\d)\s*(ghz|mhz|khz|hz|g|m|k)?(?![a-z])/g
	for (let m = re.exec(s); m; m = re.exec(s))
		nums.push({ raw: m[1] ?? "", unit: m[2] ?? "" })
	// the frequency is the number with a frequency unit ("Ch 16: 156.800 MHz"), else a long or grouped one
	const first =
		nums.find(n => /^(ghz|mhz|hz|g|m)$/.test(n.unit)) ??
		nums.find(n => normaliseNumber(n.raw).replace(".", "").length >= 6) ??
		nums[0]
	if (!first) return { kind: "none" }
	const fullUnit = /(ghz|mhz|khz|hz)/.test(s)
	const grouped = /\d[.,' ]\d{3}[.,' ]\d{3}/.test(s) || /\d \d{3}/.test(s)
	if (!modeMatch && !fullUnit && !grouped) return { kind: "none" }
	const num = normaliseNumber(first.raw)
	const unit = first.unit || (/^\d{7,10}$/.test(num) ? "hz" : "")
	const p = parseFrequency(num + unit, currentHz, range)
	if (p.kind === "error") return { kind: "error", message: p.message }
	if (p.kind !== "ok") return { kind: "none" }
	const bw = nums
		.slice(nums.indexOf(first) + 1)
		.find(n => n.unit === "k" || n.unit === "khz")
	return {
		kind: "ok",
		hz: p.hz,
		relative: false,
		hint: null,
		pasted: true,
		mode: modeMatch?.[1] ? modeOf(modeMatch[1]) : null,
		bandwidthHz: bw
			? Math.round(Number.parseFloat(normaliseNumber(bw.raw)) * 1000)
			: null,
	}
}

/** A typed or pasted frequency: the Tuner's parser first, then pasted text. */
export function parseFrequencyIntent(
	input: string,
	currentHz: number,
	range: FrequencyRange = TUNER_RANGE,
): FrequencyIntent {
	const s = input.trim()
	if (!s || COMMAND_WORD.test(s.toLowerCase())) return { kind: "none" }
	const p = parseFrequency(s, currentHz, range)
	if (p.kind === "ok")
		return {
			kind: "ok",
			hz: p.hz,
			relative: p.relative,
			hint: p.hint,
			pasted: false,
			mode: null,
			bandwidthHz: null,
		}
	const pasted = parsePasted(s, currentHz, range)
	if (pasted.kind === "ok") return pasted
	if (p.kind === "error") return { kind: "error", message: p.message }
	return pasted
}

export type CommandIntent =
	| { kind: "gain"; db: number | "auto" }
	| { kind: "squelch"; value: number | "auto" | "off" }
	| { kind: "bandwidth"; hz: number }
	| { kind: "step"; hz: number }
	| { kind: "rate"; msps: number }
	| { kind: "volume"; percent: number }
	| { kind: "mode"; mode: Modulation }

/** kHz unless said otherwise: `25k`, `25`, `25000 hz`, `12.5`. */
function widthHz(raw: string, unit: string | undefined): number {
	const v = Number.parseFloat(raw)
	if (unit === "hz") return Math.round(v)
	return Math.round(unit || v < 1000 ? v * 1000 : v)
}

/** A command word with its value, or null. `sq 90` is −90 dB (squelch levels are below zero). */
export function parseCommand(input: string): CommandIntent | null {
	const s = input.trim().toLowerCase().replace(",", ".")
	let m = /^(?:gain|g)\s*(auto|\d+(?:\.\d+)?)\s*(?:db)?$/.exec(s)
	if (m?.[1])
		return {
			kind: "gain",
			db: m[1] === "auto" ? "auto" : Number.parseFloat(m[1]),
		}
	m = /^(?:sq|squelch|sql)\s*(auto|off|-?\d+(?:\.\d+)?)\s*(?:db)?$/.exec(s)
	if (m?.[1])
		return {
			kind: "squelch",
			value:
				m[1] === "auto" || m[1] === "off"
					? m[1]
					: -Math.abs(Number.parseFloat(m[1])),
		}
	m = /^(?:bw|bandwidth|filter)\s*(\d+(?:\.\d+)?)\s*(k|khz|hz)?$/.exec(s)
	if (m?.[1]) return { kind: "bandwidth", hz: widthHz(m[1], m[2]) }
	m = /^step\s*(\d+(?:\.\d+)?)\s*(k|khz|hz)?$/.exec(s)
	if (m?.[1]) return { kind: "step", hz: widthHz(m[1], m[2]) }
	m = /^(?:rate|sr|sample rate)\s*(\d+(?:\.\d+)?)\s*(?:ms\/?s|m)?$/.exec(s)
	if (m?.[1]) return { kind: "rate", msps: Number.parseFloat(m[1]) }
	m = /^(?:vol|volume)\s*(\d{1,3})\s*%?$/.exec(s)
	if (m?.[1])
		return {
			kind: "volume",
			percent: Math.min(100, Number.parseInt(m[1], 10)),
		}
	m = /^(?:mode\s+)?(nfm|am|wfm|usb|lsb|cw|raw|fm)$/.exec(s)
	if (m?.[1]) return { kind: "mode", mode: modeOf(m[1]) }
	return null
}

export type IdentifierIntent =
	| { kind: "talkgroup"; value: string }
	| { kind: "capcode"; value: string }
	| { kind: "mmsi"; value: string }

/**
 * Identifiers to look up in Activity: `tg 2081` and bare digits (up to 7) a talkgroup, `cap 1234567` and 7 bare
 * digits a capcode, `mmsi …` and 9 bare digits an MMSI. Bare digits may give several.
 */
export function parseIdentifiers(input: string): IdentifierIntent[] {
	const s = input.trim().toLowerCase()
	const out: IdentifierIntent[] = []
	let m = /^(?:tg|talkgroup)\s*:?\s*(\d{1,8})$/.exec(s)
	if (m?.[1]) out.push({ kind: "talkgroup", value: m[1] })
	else if (/^\d{1,7}$/.test(s)) out.push({ kind: "talkgroup", value: s })
	m = /^(?:cap|capcode|pager|ric)\s*:?\s*(\d{1,8})$/.exec(s)
	if (m?.[1]) out.push({ kind: "capcode", value: m[1] })
	else if (/^\d{7}$/.test(s)) out.push({ kind: "capcode", value: s })
	m = /^(?:mmsi\s*:?\s*)?(\d{9})$/.exec(s)
	if (m?.[1]) out.push({ kind: "mmsi", value: m[1] })
	return out
}
