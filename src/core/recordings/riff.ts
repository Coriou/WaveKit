import { RECORDINGS_HEADER_READ_BYTES } from "@wavekit/api-types"

const KS_GUID_TAIL = [
	0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b,
	0x71,
]

function tag(b: Uint8Array, o: number): string {
	return String.fromCharCode(
		b[o] ?? 0,
		b[o + 1] ?? 0,
		b[o + 2] ?? 0,
		b[o + 3] ?? 0,
	)
}

/**
 * Duration of a plain PCM WAV from its first bytes (WG8 req 4.3, 4.6). Null for anything that
 * is not a well-formed PCM header inside the window. Never throws.
 */
export function parseRiffDurationMs(
	header: Uint8Array,
	fileSize: number,
): number | null {
	try {
		const b =
			header.length > RECORDINGS_HEADER_READ_BYTES
				? header.subarray(0, RECORDINGS_HEADER_READ_BYTES)
				: header
		const len = b.length
		if (len < 12) return null
		if (tag(b, 0) !== "RIFF" || tag(b, 8) !== "WAVE") return null
		const dv = new DataView(b.buffer, b.byteOffset, b.byteLength)
		let byteRate = 0
		let haveFmt = false
		let pos = 12
		for (let n = 0; n < 512 && pos + 8 <= len; n++) {
			const id = tag(b, pos)
			const size = dv.getUint32(pos + 4, true)
			const body = pos + 8
			if (id === "data") {
				if (!haveFmt) return null
				if (!Number.isInteger(fileSize) || fileSize < body) return null
				const avail = Math.min(size, fileSize - body)
				return Math.round((avail / byteRate) * 1000)
			}
			if (id === "fmt ") {
				if (haveFmt || size < 16 || body + 16 > len) return null
				const format = dv.getUint16(body, true)
				const channels = dv.getUint16(body + 2, true)
				const rate = dv.getUint32(body + 4, true)
				const br = dv.getUint32(body + 8, true)
				const align = dv.getUint16(body + 12, true)
				const bits = dv.getUint16(body + 14, true)
				if (format === 0xfffe) {
					if (size < 40 || body + size > len) return null
					if (dv.getUint16(body + 16, true) < 22) return null
					if (dv.getUint16(body + 24, true) !== 1) return null
					for (let i = 0; i < 14; i++) {
						if (b[body + 26 + i] !== KS_GUID_TAIL[i]) return null
					}
				} else if (format !== 1) return null
				if (channels < 1 || channels > 8) return null
				if (rate < 1 || rate > 384000) return null
				if (bits !== 8 && bits !== 16 && bits !== 24 && bits !== 32) return null
				const frame = (channels * bits) / 8
				if (br <= 0 || br !== rate * frame || align !== frame) return null
				byteRate = br
				haveFmt = true
			}
			const next = body + size + (size & 1)
			if (next > len) return null
			pos = next
		}
		return null
	} catch {
		return null
	}
}
