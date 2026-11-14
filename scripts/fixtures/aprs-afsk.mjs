/**
 * Synthetic APRS frame (AX.25 UI, Bell 202 AFSK 1200 baud) for the decoder
 * chain tests. No side effects on import; every identifier is fictional.
 *
 * AX.25 v2.2 UI frame: destination, source and digipeater addresses (six
 * upper-case characters shifted left one bit, then an SSID byte 0b0RR SSID 0
 * with the reserved bits set and bit 0 marking the last address), control
 * 0x03, PID 0xF0, the information field and the FCS (CRC-16/X.25: poly
 * 0x1021 reflected, init 0xFFFF, final xor 0xFFFF, sent low byte first).
 * Bytes go on the line LSB first; after five 1 bits a 0 is stuffed, except in
 * the 0x7E flags. NRZI: a 0 bit changes the tone, a 1 bit keeps it.
 */
import { afskFrequency } from "./fsk-iq.mjs"

/** CRC-16/X.25 of `bytes`. */
export function ax25Fcs(bytes) {
	let crc = 0xffff
	for (const byte of bytes) {
		crc ^= byte
		for (let b = 0; b < 8; b++) crc = crc & 1 ? (crc >>> 1) ^ 0x8408 : crc >>> 1
	}
	return crc ^ 0xffff
}

/** "CALL-SSID" -> 7 address bytes. */
function address(text, last) {
	const [call, ssid = "0"] = text.split("-")
	const bytes = []
	const padded = call.toUpperCase().padEnd(6, " ")
	for (let i = 0; i < 6; i++) bytes.push(padded.charCodeAt(i) << 1)
	bytes.push(0x60 | ((Number(ssid) & 15) << 1) | (last ? 1 : 0))
	return bytes
}

/** Frame bytes (no flags) of a UI frame, FCS included. */
export function ax25UiFrame({ source, destination, path = [], info }) {
	const calls = [destination, source, ...path]
	const bytes = calls.flatMap((call, i) => address(call, i === calls.length - 1))
	bytes.push(0x03, 0xf0, ...Buffer.from(info, "latin1"))
	const fcs = ax25Fcs(bytes)
	bytes.push(fcs & 0xff, fcs >>> 8)
	return bytes
}

/** Line bits (after stuffing and NRZI) of `frames`, each between flags. */
export function ax25LineBits(frames, { preambleFlags = 40, tailFlags = 4 } = {}) {
	const raw = []
	const flag = () => {
		for (let b = 0; b < 8; b++) raw.push((0x7e >> b) & 1)
	}
	for (let i = 0; i < preambleFlags; i++) flag()
	for (const frame of frames) {
		let ones = 0
		for (const byte of frame)
			for (let b = 0; b < 8; b++) {
				const bit = (byte >> b) & 1
				raw.push(bit)
				ones = bit ? ones + 1 : 0
				if (ones === 5) {
					raw.push(0)
					ones = 0
				}
			}
		for (let i = 0; i < tailFlags; i++) flag()
	}
	const line = []
	let level = 1
	for (const bit of raw) {
		if (bit === 0) level ^= 1
		line.push(level)
	}
	return line
}

/** FM deviation (Hz, 48 kHz) of one APRS transmission holding `packet`. */
export function aprsFrequency(packet, options = {}) {
	return afskFrequency(ax25LineBits([ax25UiFrame(packet)]), options)
}
