/**
 * A transmission's tone, derived on read (never stored: a closed entry is frozen). The live
 * demodulator reports CTCSS and DCS at its close; the recorder's facts carry the CTCSS tone or
 * DCS code (with its polarity) of each kept file. A heard value wins over none or not measured; a
 * recorder `none` wins over not measured; two different heard values read the recorder's and are
 * marked ambiguous. DCS was looked for when the live demodulator reported, or a recorder fact is
 * a DCS code or `none` (both need its DCS decoder's analysis; a CTCSS fact may predate it).
 */
import type { RecordingTone } from "@wavekit/api-types"
import type { TxLiveTone, TxToneReading } from "./types.js"

/** Standard CTCSS tones lie at least 2.5 Hz apart: within 0.5 Hz is the same tone. */
const SAME_TONE_HZ = 0.5

type DcsPolarity = "normal" | "inverted"

type Heard =
	| { ctcssHz: number; dcs: null; polarity: null }
	| { ctcssHz: null; dcs: string; polarity: DcsPolarity | null }

function heardOfRecorder(tone: RecordingTone | null | undefined): Heard | null {
	if (tone === null || tone === undefined) return null
	return tone.kind === "ctcss"
		? { ctcssHz: tone.hz, dcs: null, polarity: null }
		: { ctcssHz: null, dcs: tone.code, polarity: tone.polarity ?? null }
}

function heardOfLive(tone: TxLiveTone | null): Heard | null {
	if (tone === null) return null
	if (tone.ctcssHz !== null)
		return { ctcssHz: tone.ctcssHz, dcs: null, polarity: null }
	if (tone.dcs !== null)
		return { ctcssHz: null, dcs: tone.dcs.code, polarity: tone.dcs.polarity }
	return null
}

function same(a: Heard, b: Heard): boolean {
	if (a.ctcssHz !== null && b.ctcssHz !== null)
		return Math.abs(a.ctcssHz - b.ctcssHz) <= SAME_TONE_HZ
	return a.dcs !== null && a.dcs === b.dcs
}

export function deriveTone(
	liveTone: TxLiveTone | null,
	recorderTones: readonly (RecordingTone | null | undefined)[],
): TxToneReading {
	let dcsChecked = liveTone !== null
	let recorder: Heard | null = null
	let ambiguous = false
	let recorderNone = false
	for (const t of recorderTones) {
		if (t === null) recorderNone = true
		if (t === null || t?.kind === "dcs") dcsChecked = true
		const heard = heardOfRecorder(t)
		if (heard === null) continue
		if (recorder === null) recorder = heard
		else if (!same(recorder, heard)) ambiguous = true
	}
	const live = heardOfLive(liveTone)
	if (recorder !== null && live !== null && !same(recorder, live))
		ambiguous = true
	const value = recorder ?? live
	if (value !== null)
		return {
			state: "heard",
			ctcssHz: value.ctcssHz,
			dcs: value.dcs,
			dcsPolarity: value.polarity,
			source: recorder !== null ? "recorder" : "live-demod",
			ambiguous,
			dcsChecked,
		}
	const none = recorderNone || liveTone !== null
	return {
		state: none ? "none" : "not-measured",
		ctcssHz: null,
		dcs: null,
		dcsPolarity: null,
		source: recorderNone ? "recorder" : liveTone !== null ? "live-demod" : null,
		ambiguous: false,
		dcsChecked,
	}
}
