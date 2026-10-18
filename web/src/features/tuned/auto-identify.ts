// Identify on its own (Ben, 2026-10-18; Settings › Display › Identify on its own): when a transmission starts on
// the frequency the receiver sits on and nothing decodes it, the tuned card starts Identify by itself, once per
// visit. The core only identifies on request (POST /api/scanner/identify), so the card asks. Pure.

export interface AutoIdentifyInput {
	/** Settings › Identify on its own. */
	enabled: boolean
	readOnly: boolean
	/** The card shows the frequency the receiver is on (not a pinned card left behind). */
	onIt: boolean
	/** A sweep holds the receiver: the scan identifies its own hits. */
	heldByScan: boolean
	/** The squelch is open: a transmission is on the air now. */
	transmitting: boolean
	/** Decoders that listen on this frequency, running or not: what it is is already known. */
	decodersHere: number
	/** An identify is under way or shown (here or elsewhere). */
	identifyShown: boolean
	/** Identify already named this frequency this session. */
	known: boolean
	/** The frequency the card last identified on its own, until the receiver leaves it. */
	triedHz: number | null
	hz: number
}

/** True when the card should start Identify on its own now. */
export function shouldAutoIdentify(i: AutoIdentifyInput): boolean {
	return (
		i.enabled &&
		!i.readOnly &&
		i.onIt &&
		!i.heldByScan &&
		i.transmitting &&
		i.decodersHere === 0 &&
		!i.identifyShown &&
		!i.known &&
		i.triedHz !== i.hz
	)
}

/** How long the squelch stays open before the card asks: a click of noise does not start a job. */
export const AUTO_IDENTIFY_DELAY_MS = 600
