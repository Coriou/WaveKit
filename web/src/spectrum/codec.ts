/** Bin decoding: base64 into a caller-owned buffer, and the `u8-halfdb-127.5` byte ↔ dBFS mapping. */

const INVALID = 255
const LOOKUP = (() => {
	const table = new Uint8Array(128).fill(INVALID)
	const alphabet =
		"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
	for (let i = 0; i < alphabet.length; i++) table[alphabet.charCodeAt(i)] = i
	// URL-safe variants decode the same way.
	table["-".charCodeAt(0)] = 62
	table["_".charCodeAt(0)] = 63
	return table
})()

/** Bytes a base64 string decodes to (padding aware). */
export function decodedLength(src: string): number {
	let len = src.length
	while (len > 0 && src.charCodeAt(len - 1) === 61) len--
	return Math.floor((len * 3) / 4)
}

/**
 * Decodes base64 `src` into `out` from offset 0 without allocating. Returns the number of bytes
 * written, or -1 when `src` holds a character outside the alphabet or `out` is too small.
 */
export function decodeBase64Into(src: string, out: Uint8Array): number {
	let len = src.length
	while (len > 0 && src.charCodeAt(len - 1) === 61) len--
	if (len % 4 === 1) return -1
	const n = Math.floor((len * 3) / 4)
	if (n > out.length) return -1
	let o = 0
	let i = 0
	const full = len - (len % 4)
	for (; i < full; i += 4) {
		const a = sextet(src, i)
		const b = sextet(src, i + 1)
		const c = sextet(src, i + 2)
		const d = sextet(src, i + 3)
		if ((a | b | c | d) > 63) return -1
		const v = (a << 18) | (b << 12) | (c << 6) | d
		out[o++] = v >>> 16
		out[o++] = (v >>> 8) & 0xff
		out[o++] = v & 0xff
	}
	const rest = len - full
	if (rest >= 2) {
		const a = sextet(src, i)
		const b = sextet(src, i + 1)
		if ((a | b) > 63) return -1
		out[o++] = (a << 2) | (b >>> 4)
		if (rest === 3) {
			const c = sextet(src, i + 2)
			if (c > 63) return -1
			out[o++] = ((b & 0x0f) << 4) | (c >>> 2)
		}
	}
	return o
}

function sextet(src: string, i: number): number {
	const code = src.charCodeAt(i)
	return code < 128 ? (LOOKUP[code] ?? INVALID) : INVALID
}

/** `u8-halfdb-127.5`: byte v → dBFS. */
export function byteToDb(v: number): number {
	return v / 2 - 127.5
}

/** dBFS → nearest byte, clamped to 0–255. */
export function dbToByte(db: number): number {
	if (Number.isNaN(db)) return 0
	const v = Math.round((db + 127.5) * 2)
	return v < 0 ? 0 : v > 255 ? 255 : v
}

/**
 * Levels as a linear map of the normalized texture sample s (= v / 255) to the colour position
 * t = s · scale + offset, where t = 0 at `minDb` and 1 at `maxDb`.
 */
export function levelsToLinear(
	minDb: number,
	maxDb: number,
): { scale: number; offset: number } {
	const range = Math.max(maxDb - minDb, 0.5)
	// dB = s · 255 / 2 − 127.5
	return { scale: 127.5 / range, offset: (-127.5 - minDb) / range }
}
