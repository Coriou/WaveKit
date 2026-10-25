/**
 * AX.25 address validation shared by the packet decoders. An AX.25 address
 * is a callsign of 1 to 6 characters A-Z or 0-9 (stored left-aligned, padded
 * with spaces) and an SSID 0-15. Text or bytes that are not such an address
 * come from noise that happened to pass the frame check (a 16-bit FCS lets
 * about 1 in 65 536 random frames through), never from a station.
 */

/** Text form: CALL or CALL-SSID, SSID 0-15 without leading zeros. */
const CALLSIGN_TEXT = /^[A-Z0-9]{1,6}(?:-(?:[0-9]|1[0-5]))?$/

/** True when `text` is an AX.25 address in CALL[-SSID] form. Pure. */
export function isAx25CallsignText(text: string): boolean {
	return CALLSIGN_TEXT.test(text)
}

/** True for an AX.25 callsign character (A-Z, 0-9) as its ASCII code. */
export function isAx25CallsignChar(code: number): boolean {
	return (code >= 0x41 && code <= 0x5a) || (code >= 0x30 && code <= 0x39)
}

/**
 * A digipeater entry as text: an address with an optional trailing `*`
 * (has-been-repeated mark). Pure.
 */
export function isAx25PathEntryText(text: string): boolean {
	return isAx25CallsignText(text.endsWith("*") ? text.slice(0, -1) : text)
}
