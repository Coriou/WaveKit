import type { TunerState } from "@wavekit/api-types"
import type { TunerCommand } from "../data/types.js"
import type { EditKey } from "./actions.js"
import type { EditField, TunerDraft, TunerEditState } from "./ui-state.js"

/** RTL-SDR rates the CLI offers; core only range-checks 225 001–3 200 000. */
export const VALID_SAMPLE_RATES: readonly number[] = [
	250_000, 1_024_000, 1_536_000, 1_792_000, 1_920_000, 2_048_000, 2_160_000,
	2_400_000, 2_560_000, 2_880_000, 3_200_000,
]
/** Tab order on screen. */
export const FIELD_ORDER: readonly EditField[] = [
	"frequency",
	"sampleRate",
	"gain",
	"ppm",
	"gainMode",
	"agc",
	"biasTee",
	"directSampling",
	"offsetTuning",
]
/** POST order: gain mode goes before gain so a switch to manual plus a gain change is accepted. */
export const SEND_ORDER: readonly EditField[] = [
	"frequency",
	"sampleRate",
	"gainMode",
	"gain",
	"ppm",
	"agc",
	"biasTee",
	"directSampling",
	"offsetTuning",
]
export const FREQ_MIN = 24_000_000
export const FREQ_MAX = 1_900_000_000
export const GAIN_MAX = 500
export const PPM_LIMIT = 500
export const FREQ_DIGITS = 10
/** Largest value the 10-digit frequency field can show. */
export const FREQ_FIELD_MAX = 10 ** FREQ_DIGITS - 1

const clamp = (v: number, lo: number, hi: number): number =>
	Math.min(hi, Math.max(lo, v))

export function draftFromTuner(t: TunerState): TunerDraft {
	return {
		frequency: t.frequency,
		sampleRate: t.sampleRate,
		gainTenthsDb: t.gain,
		ppm: t.ppm,
		gainMode: t.gainMode,
		agc: t.agcMode,
		biasTee: t.biasTee,
		directSampling: t.directSampling,
		offsetTuning: t.offsetTuning,
	}
}

/** Editing starts on frequency with the cursor on the 1 kHz digit. */
export function startEdit(t: TunerState): TunerEditState {
	const d = draftFromTuner(t)
	return {
		sourceId: t.sourceId,
		original: d,
		draft: { ...d },
		field: "frequency",
		digit: 3,
	}
}

export function digitAt(n: number, digit: number): number {
	return Math.floor(n / 10 ** digit) % 10
}

function setDigit(n: number, digit: number, value: number): number {
	return n - digitAt(n, digit) * 10 ** digit + value * 10 ** digit
}

/**
 * Steps through VALID_SAMPLE_RATES. An off-list rate moves to the nearest valid
 * rate in the key's direction (↓ from 2 000 000 is 1 920 000, ↑ is 2 048 000).
 */
function nextRate(rate: number, dir: 1 | -1): number {
	const idx = VALID_SAMPLE_RATES.indexOf(rate)
	if (idx >= 0)
		return (
			VALID_SAMPLE_RATES[clamp(idx + dir, 0, VALID_SAMPLE_RATES.length - 1)] ??
			rate
		)
	const ahead =
		dir > 0
			? VALID_SAMPLE_RATES.find(r => r > rate)
			: [...VALID_SAMPLE_RATES].reverse().find(r => r < rate)
	return (
		ahead ??
		(dir > 0
			? VALID_SAMPLE_RATES[VALID_SAMPLE_RATES.length - 1]
			: VALID_SAMPLE_RATES[0]) ??
		rate
	)
}

function toggle(d: TunerDraft, field: EditField, dir: 1 | -1 = 1): TunerDraft {
	switch (field) {
		case "gainMode":
			return { ...d, gainMode: d.gainMode === "manual" ? "agc" : "manual" }
		case "agc":
			return { ...d, agc: !d.agc }
		case "biasTee":
			return { ...d, biasTee: !d.biasTee }
		case "offsetTuning":
			return { ...d, offsetTuning: !d.offsetTuning }
		case "directSampling": {
			const modes = ["off", "i", "q"] as const
			const i = modes.indexOf(d.directSampling)
			return {
				...d,
				directSampling: modes[(i + dir + modes.length) % modes.length] ?? "off",
			}
		}
		default:
			return d
	}
}

function editFrequency(
	s: TunerEditState,
	key: EditKey,
	dir: 1 | -1 | 0,
): TunerEditState {
	const d = s.draft
	// Not clamped to the server range while typing (that would rewrite the lower
	// digits); outOfRange() reports it and canReview() holds the confirm.
	const set = (frequency: number, digit = s.digit): TunerEditState => ({
		...s,
		draft: { ...d, frequency: clamp(frequency, 0, FREQ_FIELD_MAX) },
		digit,
	})
	if (key === "left")
		return { ...s, digit: Math.min(FREQ_DIGITS - 1, s.digit + 1) }
	if (key === "right") return { ...s, digit: Math.max(0, s.digit - 1) }
	// Backspace clears the digit under the cursor and moves to the next higher one.
	if (key === "backspace")
		return set(
			setDigit(d.frequency, s.digit, 0),
			Math.min(FREQ_DIGITS - 1, s.digit + 1),
		)
	if (dir !== 0) {
		// At the field's edge the step is refused rather than clamped, which would
		// rewrite the lower digits.
		const next = d.frequency + dir * 10 ** s.digit
		return next < 0 || next > FREQ_FIELD_MAX ? s : set(next)
	}
	// Typing replaces the digit and moves to the next lower one.
	if (/^[0-9]$/.test(key))
		return set(
			setDigit(d.frequency, s.digit, Number(key)),
			Math.max(0, s.digit - 1),
		)
	return s
}

export function applyEditKey(s: TunerEditState, key: EditKey): TunerEditState {
	const d = s.draft
	if (key === "tab") {
		const i = FIELD_ORDER.indexOf(s.field)
		let next = FIELD_ORDER[(i + 1) % FIELD_ORDER.length] ?? "frequency"
		// Gain is editable in manual mode only.
		if (next === "gain" && d.gainMode !== "manual") next = "ppm"
		return { ...s, field: next }
	}
	const dir: 1 | -1 | 0 = key === "up" ? 1 : key === "down" ? -1 : 0
	switch (s.field) {
		case "frequency":
			return editFrequency(s, key, dir)
		case "sampleRate":
			return dir === 0
				? s
				: { ...s, draft: { ...d, sampleRate: nextRate(d.sampleRate, dir) } }
		case "gain":
			return dir === 0 || d.gainMode !== "manual"
				? s
				: {
						...s,
						draft: {
							...d,
							gainTenthsDb: clamp(d.gainTenthsDb + dir, 0, GAIN_MAX),
						},
					}
		case "ppm":
			return dir === 0
				? s
				: {
						...s,
						draft: { ...d, ppm: clamp(d.ppm + dir, -PPM_LIMIT, PPM_LIMIT) },
					}
		default:
			if (key === "space") return { ...s, draft: toggle(d, s.field) }
			return dir === 0 ? s : { ...s, draft: toggle(d, s.field, dir) }
	}
}

export interface PendingChange {
	field: EditField
	from: number | string | boolean
	to: number | string | boolean
}

const VALUE: Readonly<
	Record<EditField, (d: TunerDraft) => number | string | boolean>
> = {
	frequency: d => d.frequency,
	sampleRate: d => d.sampleRate,
	gain: d => d.gainTenthsDb,
	ppm: d => d.ppm,
	gainMode: d => d.gainMode,
	agc: d => d.agc,
	biasTee: d => d.biasTee,
	directSampling: d => d.directSampling,
	offsetTuning: d => d.offsetTuning,
}

/** Changed fields in SEND_ORDER. Gain is left out when the draft is in AGC mode. */
export function pendingChanges(s: TunerEditState): PendingChange[] {
	const out: PendingChange[] = []
	for (const field of SEND_ORDER) {
		if (field === "gain" && s.draft.gainMode !== "manual") continue
		const from = VALUE[field](s.original)
		const to = VALUE[field](s.draft)
		if (from !== to) out.push({ field, from, to })
	}
	return out
}

/**
 * The rtl_tcp command core relays for each field: the names the relay history shows,
 * so the confirm bar and the result line use the operator's vocabulary (polish M6).
 */
export const COMMAND_NAME: Readonly<Record<EditField, string>> = {
	frequency: "set-frequency",
	sampleRate: "set-sample-rate",
	gainMode: "set-gain-mode",
	gain: "set-gain",
	ppm: "set-freq-correction",
	agc: "set-agc-mode",
	biasTee: "set-bias-tee",
	directSampling: "set-direct-sampling",
	offsetTuning: "set-offset-tuning",
}

/** Bodies follow src/api/routes/tuner.ts. */
const COMMAND: Readonly<Record<EditField, (d: TunerDraft) => TunerCommand>> = {
	frequency: d => ({
		setting: "frequency",
		body: { hz: d.frequency },
		label: COMMAND_NAME.frequency,
	}),
	sampleRate: d => ({
		setting: "sample-rate",
		body: { hz: d.sampleRate },
		label: COMMAND_NAME.sampleRate,
	}),
	gainMode: d => ({
		setting: "gain-mode",
		body: { mode: d.gainMode },
		label: COMMAND_NAME.gainMode,
	}),
	gain: d => ({
		setting: "gain",
		body: { tenthsDb: d.gainTenthsDb },
		label: COMMAND_NAME.gain,
	}),
	ppm: d => ({ setting: "ppm", body: { ppm: d.ppm }, label: COMMAND_NAME.ppm }),
	agc: d => ({
		setting: "agc",
		body: { enabled: d.agc },
		label: COMMAND_NAME.agc,
	}),
	biasTee: d => ({
		setting: "bias-tee",
		body: { enabled: d.biasTee },
		label: COMMAND_NAME.biasTee,
	}),
	directSampling: d => ({
		setting: "direct-sampling",
		body: { mode: d.directSampling },
		label: COMMAND_NAME.directSampling,
	}),
	offsetTuning: d => ({
		setting: "offset-tuning",
		body: { enabled: d.offsetTuning },
		label: COMMAND_NAME.offsetTuning,
	}),
}

export function pendingCommands(s: TunerEditState): TunerCommand[] {
	return pendingChanges(s).map(c => COMMAND[c.field](s.draft))
}

export function turnsBiasTeeOn(s: TunerEditState): boolean {
	return !s.original.biasTee && s.draft.biasTee
}

export function editWindow(s: TunerEditState): {
	centreHz: number
	sampleRate: number
} {
	return { centreHz: s.draft.frequency, sampleRate: s.draft.sampleRate }
}

/** Draft fields core would refuse; the pending line shows them with the attention role. */
export function outOfRange(s: TunerEditState): EditField[] {
	const f = s.draft.frequency
	return f < FREQ_MIN || f > FREQ_MAX ? ["frequency"] : []
}

/** Enter opens the review confirm only when something changed and every field is in range. */
export function canReview(s: TunerEditState): boolean {
	return pendingChanges(s).length > 0 && outOfRange(s).length === 0
}
