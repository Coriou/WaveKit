import type { ProofAnalogInput } from "../scanner-redesign-contract.js"
import type { ScannerClass } from "../types.js"

/**
 * An unmodulated carrier is no FM voice. A steady carrier (a clock harmonic) strong enough to
 * open an FM squelch yields an audio "transmission" whose analog row reads `heard` (voice, no
 * tone): that row made a bare carrier an `analog-fm` candidate. On a record whose spectral class
 * is `carrier` (the majority of its observations: at most 2 bins at -6 dB, or a steady line under
 * 4 kHz at -20 dB, which FM voice never is), a tone-less NFM `heard` row is carrier evidence
 * instead: `carrier-only`, no voice. A CTCSS tone or DCS code is real evidence of an FM
 * transmitter and stays; AM rows stay (an AM voice carrier outside an AM range can measure as a
 * carrier). Anything malformed is returned unchanged (the caller validated it already).
 */
export function carrierAwareAnalog(
	row: ProofAnalogInput,
	recordClass: ScannerClass | undefined,
): ProofAnalogInput {
	if (
		recordClass !== "carrier" ||
		row.outcome !== "heard" ||
		row.mode !== "nfm" ||
		row.tone.ctcssHz !== null ||
		row.tone.dcs !== null
	)
		return row
	return { ...row, outcome: "carrier-only", voice: false }
}
