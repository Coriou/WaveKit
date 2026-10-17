// The waveform strip of an open recording, computed here from the WAV the core serves (the core keeps
// no peaks yet, CORE-GAPS "Waveform peaks"). Reads the RIFF chunks itself: PCM 8, 16, 24 and 32 bit,
// 32-bit float, mono or interleaved, WAVE_FORMAT_EXTENSIBLE included. No AudioContext needed.

export interface WavInfo {
	sampleRate: number
	channels: number
	bitsPerSample: number
	float: boolean
	/** Byte offset and length of the `data` chunk (the length clamped to the buffer). */
	dataOffset: number
	dataBytes: number
	durationS: number
}

const FORMAT_PCM = 1
const FORMAT_FLOAT = 3
const FORMAT_EXTENSIBLE = 0xfffe

function tag(view: DataView, at: number): string {
	return String.fromCharCode(
		view.getUint8(at),
		view.getUint8(at + 1),
		view.getUint8(at + 2),
		view.getUint8(at + 3),
	)
}

/** The format and data chunk of a WAV file, or null when it is not one this reads. */
export function parseWav(buffer: ArrayBuffer): WavInfo | null {
	const view = new DataView(buffer)
	if (view.byteLength < 12) return null
	if (tag(view, 0) !== "RIFF" || tag(view, 8) !== "WAVE") return null
	let at = 12
	let fmt: Omit<WavInfo, "dataOffset" | "dataBytes" | "durationS"> | null = null
	while (at + 8 <= view.byteLength) {
		const id = tag(view, at)
		const size = view.getUint32(at + 4, true)
		const body = at + 8
		if (id === "fmt " && size >= 16 && body + 16 <= view.byteLength) {
			let format = view.getUint16(body, true)
			if (
				format === FORMAT_EXTENSIBLE &&
				size >= 40 &&
				body + 26 <= view.byteLength
			)
				format = view.getUint16(body + 24, true)
			const channels = view.getUint16(body + 2, true)
			const sampleRate = view.getUint32(body + 4, true)
			const bitsPerSample = view.getUint16(body + 14, true)
			const float = format === FORMAT_FLOAT
			if (format !== FORMAT_PCM && !float) return null
			if (float && bitsPerSample !== 32) return null
			if (![8, 16, 24, 32].includes(bitsPerSample)) return null
			if (channels < 1 || sampleRate < 1) return null
			fmt = { sampleRate, channels, bitsPerSample, float }
		} else if (id === "data" && fmt) {
			const dataBytes = Math.min(size, view.byteLength - body)
			const frame = (fmt.bitsPerSample / 8) * fmt.channels
			return {
				...fmt,
				dataOffset: body,
				dataBytes,
				durationS: Math.floor(dataBytes / frame) / fmt.sampleRate,
			}
		}
		at = body + size + (size % 2)
	}
	return null
}

function reader(view: DataView, info: WavInfo): (at: number) => number {
	if (info.float) return at => view.getFloat32(at, true)
	switch (info.bitsPerSample) {
		case 8:
			return at => (view.getUint8(at) - 128) / 128
		case 16:
			return at => view.getInt16(at, true) / 32768
		case 24:
			return at => {
				const v =
					view.getUint8(at) |
					(view.getUint8(at + 1) << 8) |
					(view.getInt8(at + 2) << 16)
				return v / 8388608
			}
		default:
			return at => view.getInt32(at, true) / 2147483648
	}
}

/**
 * `bars` loudness values in 0–1 (the peak of each slice, on a gentle curve so quiet speech still
 * shows). Reads at most ~`maxReads` samples in total, so a long file costs the same as a short one.
 */
export function wavPeaks(
	buffer: ArrayBuffer,
	bars: number,
	maxReads = 200_000,
): { info: WavInfo; peaks: number[] } | null {
	const info = parseWav(buffer)
	if (!info || bars < 1) return null
	const view = new DataView(buffer)
	const bytes = info.bitsPerSample / 8
	const frameBytes = bytes * info.channels
	const frames = Math.floor(info.dataBytes / frameBytes)
	const read = reader(view, info)
	const stride = Math.max(1, Math.floor(frames / maxReads))
	const peaks: number[] = []
	for (let b = 0; b < bars; b++) {
		const start = Math.floor((b * frames) / bars)
		const end = Math.floor(((b + 1) * frames) / bars)
		let peak = 0
		for (let f = start; f < end; f += stride) {
			const v = Math.abs(read(info.dataOffset + f * frameBytes))
			if (v > peak) peak = v
		}
		peaks.push(Math.min(1, peak ** 0.75))
	}
	return { info, peaks }
}
