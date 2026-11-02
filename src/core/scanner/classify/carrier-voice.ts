import type { ProofAnalogInput } from "../scanner-redesign-contract.js"
import type { ScannerClass } from "../types.js"
import { CARRIER_LINE_MAX_HZ } from "./classifier.js"

/** What the analog row's own observation measured: its class vote and occupied bandwidth (Hz). */
export interface MeasuredLine {
	cls: ScannerClass | undefined
	obwHz: number
}

/**
 * An unmodulated carrier is no FM voice. A steady carrier (a clock harmonic) strong enough to
 * open an FM squelch yields an audio "transmission" whose analog row reads `heard` (voice, no
 * tone): that row made a bare carrier an `analog-fm` candidate. When the row's own observation
 * measured a carrier (its class vote is `carrier`: at most 2 bins at -6 dB, or a steady line under
 * 4 kHz at -20 dB) and its width is under `CARRIER_LINE_MAX_HZ` (4 kHz; FM voice is 7.5 kHz and
 * up), a tone-less NFM `heard` row is carrier evidence instead: `carrier-only`, no voice. The
 * decision is this observation's measurement, never the record's history: a record that was a quiet
 * carrier before and now carries an FM over keeps the voice. A CTCSS tone or DCS code is real
 * evidence of an FM transmitter and stays; AM rows stay (an AM voice carrier outside an AM range
 * can measure as a carrier). Unknown or malformed measurement leaves the row unchanged (the safe
 * answer: the voice is kept).
 */
export function carrierAwareAnalog(
	row: ProofAnalogInput,
	measured: MeasuredLine | undefined,
): ProofAnalogInput {
	if (
		measured === undefined ||
		measured.cls !== "carrier" ||
		!Number.isFinite(measured.obwHz) ||
		!(measured.obwHz < CARRIER_LINE_MAX_HZ) ||
		row.outcome !== "heard" ||
		row.mode !== "nfm" ||
		row.tone.ctcssHz !== null ||
		row.tone.dcs !== null
	)
		return row
	return { ...row, outcome: "carrier-only", voice: false }
}
