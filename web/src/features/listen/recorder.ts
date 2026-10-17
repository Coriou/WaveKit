// Listen › Record audio: keeps what this browser plays (the stream's samples, before the volume) and
// writes it as a 16-bit mono WAV. The core has no manual recordings yet (CORE-GAPS, Recordings), so the
// file is saved by the browser rather than added to the Recordings drawer.

/** A recording stops on its own at this length: 16-bit samples held in memory. */
export const RECORD_MAX_S = 15 * 60

export class WavRecorder {
	private readonly chunks: Int16Array[] = []
	private count = 0
	private rate: number | null = null
	readonly startedAt: number

	constructor(startedAt = Date.now()) {
		this.startedAt = startedAt
	}

	/** Seconds recorded so far. */
	get seconds(): number {
		return this.rate ? this.count / this.rate : 0
	}

	get sampleRate(): number | null {
		return this.rate
	}

	/**
	 * Adds stream samples (−1…1). Returns false, keeping nothing, when the rate differs from the first
	 * chunk's (the stream was replaced: the recording ends there) or the length cap is reached.
	 */
	push(samples: Float32Array, rate: number): boolean {
		if (this.rate === null) this.rate = rate
		if (rate !== this.rate) return false
		const room = Math.max(0, Math.floor(RECORD_MAX_S * rate) - this.count)
		if (room === 0) return false
		const n = Math.min(room, samples.length)
		const out = new Int16Array(n)
		for (let i = 0; i < n; i++) {
			const v = Math.max(-1, Math.min(1, samples[i] ?? 0))
			out[i] = v < 0 ? Math.round(v * 0x8000) : Math.round(v * 0x7fff)
		}
		this.chunks.push(out)
		this.count += n
		return n === samples.length
	}

	/** The recording as a RIFF/WAVE file (PCM 16-bit mono). */
	toWav(): Blob {
		const rate = this.rate ?? 8000
		const header = new ArrayBuffer(44)
		const v = new DataView(header)
		const ascii = (at: number, s: string) => {
			for (let i = 0; i < s.length; i++) v.setUint8(at + i, s.charCodeAt(i))
		}
		const bytes = this.count * 2
		ascii(0, "RIFF")
		v.setUint32(4, 36 + bytes, true)
		ascii(8, "WAVE")
		ascii(12, "fmt ")
		v.setUint32(16, 16, true)
		v.setUint16(20, 1, true)
		v.setUint16(22, 1, true)
		v.setUint32(24, rate, true)
		v.setUint32(28, rate * 2, true)
		v.setUint16(32, 2, true)
		v.setUint16(34, 16, true)
		ascii(36, "data")
		v.setUint32(40, bytes, true)
		return new Blob(
			[header, ...this.chunks.map(c => c.buffer as ArrayBuffer)],
			{
				type: "audio/wav",
			},
		)
	}
}

/** "0:07", "12:30". */
export function recordClock(seconds: number): string {
	const s = Math.max(0, Math.floor(seconds))
	return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`
}

/** "WaveKit 161.150 MHz 2026-10-17 17-05-09.wav" (local time; no characters a file system refuses). */
export function recordFileName(hz: number | null, startedAt: number): string {
	const d = new Date(startedAt)
	const p = (n: number) => String(n).padStart(2, "0")
	const day = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
	const time = `${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`
	const where = hz === null ? "" : ` ${(hz / 1e6).toFixed(3)} MHz`
	return `WaveKit${where} ${day} ${time}.wav`
}
