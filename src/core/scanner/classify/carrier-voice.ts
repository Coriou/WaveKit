import type { ProofAnalogInput } from "../scanner-redesign-contract.js"
import type { ScannerClass } from "../types.js"
import { carrierLine } from "./classifier.js"

/**
 * What the analog row's own observation measured: its class vote, occupied bandwidth (Hz, -20 dB)
 * and, when known, the FFT bin width of its track (Hz).
 */
export interface MeasuredLine {
	cls: ScannerClass | undefined
	obwHz: number
	binHz?: number | undefined
}

/**
 * An unmodulated carrier is no FM voice. A steady carrier (a clock harmonic) strong enough to
 * open an FM squelch yields an audio "transmission" whose analog row reads `heard` (voice, no
 * tone): that row made a bare carrier an `analog-fm` candidate. When the row's own observation
 * measured a carrier (its class vote is `carrier`: a carrier's shape) and its width is a carrier
 * line's (`carrierLine`: at most 4 bins of its FFT at -20 dB, inclusive, so a tone half a bin off
 * at 4 bins counts; FM voice is 7.5 kHz and up), a tone-less NFM `heard` row is carrier evidence
 * instead: `carrier-only`, no voice. The decision is this observation's measurement, never the
 * record's history: a record that was a quiet carrier before and now carries an FM over keeps the
 * voice. A CTCSS tone or DCS code is real evidence of an FM transmitter and stays; AM rows stay
 * (an AM voice carrier outside an AM range can measure as a carrier). Unknown or malformed
 * measurement leaves the row unchanged (the safe answer: the voice is kept).
 */
export function carrierAwareAnalog(
	row: ProofAnalogInput,
	measured: MeasuredLine | undefined,
): ProofAnalogInput {
	if (
		measured === undefined ||
		measured.cls !== "carrier" ||
		!carrierLine({ obwHz: measured.obwHz, binHz: measured.binHz }) ||
		row.outcome !== "heard" ||
		row.mode !== "nfm" ||
		row.tone.ctcssHz !== null ||
		row.tone.dcs !== null
	)
		return row
	return { ...row, outcome: "carrier-only", voice: false }
}
