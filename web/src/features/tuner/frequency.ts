// Frequency entry (DESIGN.md "Frequency entry"): the place-value digit display and the typed-entry parser.
// Pure: no DOM, no stores.
import { formatWidth } from "../format.ts"

export interface FrequencyRange {
	minHz: number
	maxHz: number
}

/** The core's tuner limits (src/core/tuner-controller.ts). */
export const TUNER_RANGE: FrequencyRange = {
	minHz: 24_000_000,
	maxHz: 1_900_000_000,
}

export function clampHz(
	hz: number,
	range: FrequencyRange = TUNER_RANGE,
): number {
	return Math.min(range.maxHz, Math.max(range.minHz, Math.round(hz)))
}

// ---- digits

export const DIGIT_COUNT = 10

export interface FrequencyDigit {
	/** Index from the left, 0 = GHz. */
	index: number
	char: string
	/** Hz one step of this digit is worth. */
	place: number
	/** A leading zero (drawn dim). */
	leading: boolean
	/** Below 1 kHz (drawn quieter). */
	fine: boolean
	/** A group separator follows this digit (after GHz, MHz and kHz). */
	sepAfter: boolean
}

/** The ten digits of `hz` (0.161.150.000), most significant first. */
export function frequencyDigits(hz: number): FrequencyDigit[] {
	const text = String(Math.max(0, Math.round(hz)))
		.padStart(DIGIT_COUNT, "0")
		.slice(-DIGIT_COUNT)
	const first = text.search(/[1-9]/)
	return text.split("").map((char, index) => ({
		index,
		char,
		place: 10 ** (DIGIT_COUNT - 1 - index),
		leading: first < 0 || index < first,
		fine: index >= 7,
		sepAfter: index === 0 || index === 3 || index === 6,
	}))
}

/** Steps `hz` by one unit of `place` (up for dir > 0), clamped to the range. */
export function stepPlace(
	hz: number,
	place: number,
	dir: number,
	range: FrequencyRange = TUNER_RANGE,
): number {
	return clampHz(hz + Math.sign(dir) * place, range)
}

/** Which half of a digit a click landed on: the top half steps up. */
export function clickDirection(
	clientY: number,
	top: number,
	height: number,
): 1 | -1 {
	return clientY < top + height / 2 ? 1 : -1
}

/** Wheel direction: scrolling up (negative deltaY) steps up. 0 for a horizontal-only wheel. */
export function wheelDirection(deltaY: number): 1 | -1 | 0 {
	return deltaY < 0 ? 1 : deltaY > 0 ? -1 : 0
}

// ---- typed entry

export type ParsedFrequency =
	| { kind: "empty" }
	/** Not a number we understand (letters, a channel name): show the help line. */
	| { kind: "unknown" }
	| { kind: "error"; message: string }
	| { kind: "ok"; hz: number; relative: boolean; hint: string | null }

const UNIT: Readonly<Record<string, number>> = {
	hz: 1,
	k: 1e3,
	khz: 1e3,
	m: 1e6,
	mhz: 1e6,
	g: 1e9,
	ghz: 1e9,
}

function rangeText(range: FrequencyRange): string {
	const t = (hz: number) =>
		hz >= 1e9 ? `${hz / 1e9} GHz` : `${Math.round(hz / 1e6)} MHz`
	return `${t(range.minHz)} to ${t(range.maxHz)}`
}

/**
 * Parses what the operator typed. Accepts MHz ("161.15"), kHz ("161150k"), GHz ("1.09g"), Hz
 * ("161150000", "161.150.000" as grouped digits), a comma decimal, and steps from `currentHz`
 * ("+25k", "-12.5 khz"; a bare step is in kHz). A bare number picks its unit by size: ≥ 24e6 Hz,
 * ≥ 24000 kHz, ≥ 24 MHz, < 2 GHz.
 */
export function parseFrequency(
	input: string,
	currentHz: number,
	range: FrequencyRange = TUNER_RANGE,
): ParsedFrequency {
	let s = input.trim().toLowerCase().replace(/\s+/g, " ")
	if (!s) return { kind: "empty" }
	// grouped digits as the display shows them: 161.150.000
	if (/^\d{1,4}(?:\.\d{3}){2,}$/.test(s)) s = s.replace(/\./g, "")
	s = s.replace(",", ".")
	const m = /^([+-])?\s*(\d+(?:\.\d*)?|\.\d+)\s*(hz|khz|k|mhz|m|ghz|g)?$/.exec(
		s,
	)
	if (!m || m[2] === undefined) return { kind: "unknown" }
	const value = Number.parseFloat(m[2])
	if (!Number.isFinite(value)) return { kind: "unknown" }
	const sign = m[1]
	const unit = m[3] ? (UNIT[m[3]] ?? 0) : 0
	const outOfRange = (): ParsedFrequency => ({
		kind: "error",
		message: `Out of range. This receiver tunes ${rangeText(range)}.`,
	})
	if (sign) {
		const delta = value * (unit || 1e3)
		const hz = Math.round(currentHz + (sign === "+" ? delta : -delta))
		if (hz < range.minHz || hz > range.maxHz) return outOfRange()
		return {
			kind: "ok",
			hz,
			relative: true,
			hint: `${sign === "+" ? "Up" : "Down"} ${formatWidth(delta)} from here`,
		}
	}
	const mult =
		unit ||
		(value >= 24e6
			? 1
			: value >= 24_000
				? 1e3
				: value >= 24
					? 1e6
					: value < 2
						? 1e9
						: 0)
	if (!mult)
		return {
			kind: "error",
			message:
				"Below 24 MHz. The RTL-SDR needs direct sampling for HF. Turn it on in Receiver › Advanced.",
		}
	const hz = Math.round(value * mult)
	if (hz < range.minHz || hz > range.maxHz) return outOfRange()
	return { kind: "ok", hz, relative: false, hint: null }
}

/** Keys that open typed entry from the digit display (the first character of the entry). */
export function startsEntry(key: string): boolean {
	return /^[0-9.,+-]$/.test(key)
}
