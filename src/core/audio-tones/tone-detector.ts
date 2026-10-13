/**
 * CTCSS + DTMF over one live-demod transmission (WG2 req 7.1–7.4).
 *
 * PCM is s16le or f32le mono at the demodulator rate. It is decimated to
 * 8 kHz by block averaging before the banks in `ctcss.ts` and `dtmf.ts`.
 *
 * Anti-alias limitation: a length-N average is a sinc, not a low-pass. Its
 * first null sits at the 8 kHz output rate, so energy above 4 kHz aliases
 * in, only attenuated. A CTCSS tone is inside the passband. DTMF's highest
 * tone (1633 Hz) is also below 4 kHz; at 48 kHz (N = 6) the boxcar gain
 * there is about 0.935 (−0.6 dB), so the tone still clears the detector.
 * See `boxcarDecimationGain`.
 */
import type { AnalogTransmissionTone } from "@wavekit/api-types"
import { CtcssBank } from "./ctcss.js"
import { DtmfBank } from "./dtmf.js"

export const AUDIO_TONE_RATE_HZ = 8_000
const MIN_CTCSS_SECONDS = 0.75

export interface TonePcmFormat {
	rate: number
	format: "s16le" | "f32le"
}

/**
 * Magnitude of an N-point boxcar at `hz` before the keep-1-of-N downsample.
 * `N` is `inputRate / 8000`. Exact for an integer N; fractional rates use a
 * varying group length with the same average.
 */
export function boxcarDecimationGain(hz: number, inputRate: number): number {
	if (!(inputRate > AUDIO_TONE_RATE_HZ) || !(hz > 0)) return 1
	const factor = inputRate / AUDIO_TONE_RATE_HZ
	const theta = (Math.PI * hz) / inputRate
	const denom = factor * Math.sin(theta)
	if (denom === 0) return 1
	return Math.abs(Math.sin(factor * theta) / denom)
}

/**
 * One detector per open transmission. `push` is allocation-free after the
 * first call: banks, the decimator and the odd-byte hold are constructed
 * once and reused. `result` always returns both keys.
 */
export class ToneDetector {
	private readonly ctcss = new CtcssBank()
	private readonly dtmf = new DtmfBank()
	/** Assembles a sample split across pushes. f32le needs 4 bytes; at most 3 sit here. */
	private readonly pending = Buffer.alloc(4)
	private pendingLen = 0
	private format: TonePcmFormat["format"] | null = null
	private rate = 0
	private inputSamples = 0
	private decimFactor = 1
	private decimSum = 0
	private decimCount = 0
	private fractional = false
	private fracRatio = 1
	private fracFill = 0
	private fracSum = 0

	push(pcm: Buffer, format: TonePcmFormat): void {
		if (format.format !== "s16le" && format.format !== "f32le") return
		const width = format.format === "s16le" ? 2 : 4
		if (this.format !== format.format || this.rate !== format.rate) {
			this.pendingLen = 0
			this.format = format.format
			this.armRate(format.rate)
		}
		let offset = 0
		if (this.pendingLen > 0) {
			const need = width - this.pendingLen
			if (pcm.length < need) {
				pcm.copy(this.pending, this.pendingLen, 0, pcm.length)
				this.pendingLen += pcm.length
				return
			}
			pcm.copy(this.pending, this.pendingLen, 0, need)
			this.takeSample(readSample(this.pending, 0, format.format))
			this.pendingLen = 0
			offset = need
		}
		const usable = pcm.length - offset
		const whole = usable - (usable % width)
		const end = offset + whole
		for (let i = offset; i < end; i += width) {
			this.takeSample(readSample(pcm, i, format.format))
		}
		const tail = pcm.length - end
		if (tail <= 0) return
		pcm.copy(this.pending, 0, end, end + tail)
		this.pendingLen = tail
	}

	result(): AnalogTransmissionTone {
		const digits = this.dtmf.result()
		const ctcssHz =
			this.durationSeconds() < MIN_CTCSS_SECONDS ? null : this.ctcss.result()
		return { ctcssHz, dtmf: digits }
	}

	durationSeconds(): number {
		if (!(this.rate > 0)) return 0
		return this.inputSamples / this.rate
	}

	reset(): void {
		this.ctcss.reset()
		this.dtmf.reset()
		this.pending.fill(0)
		this.pendingLen = 0
		this.format = null
		this.rate = 0
		this.inputSamples = 0
		this.decimFactor = 1
		this.decimSum = 0
		this.decimCount = 0
		this.fractional = false
		this.fracRatio = 1
		this.fracFill = 0
		this.fracSum = 0
	}

	private armRate(rate: number): void {
		this.rate = rate
		this.decimSum = 0
		this.decimCount = 0
		this.fracFill = 0
		this.fracSum = 0
		if (!Number.isFinite(rate) || rate < AUDIO_TONE_RATE_HZ) {
			this.fractional = false
			this.decimFactor = 0
			return
		}
		const ratio = rate / AUDIO_TONE_RATE_HZ
		const nearest = Math.round(ratio)
		if (Math.abs(ratio - nearest) < 1e-6) {
			this.fractional = false
			this.decimFactor = nearest
			return
		}
		this.fractional = true
		this.fracRatio = ratio
		this.decimFactor = 0
	}

	private takeSample(sample: number): void {
		this.inputSamples += 1
		if (this.decimFactor === 0 && !this.fractional) return
		const value = Number.isFinite(sample) ? sample : 0
		if (!this.fractional) {
			if (this.decimFactor <= 1) {
				this.onDecimated(value)
				return
			}
			this.decimSum += value
			this.decimCount += 1
			if (this.decimCount < this.decimFactor) return
			this.onDecimated(this.decimSum / this.decimFactor)
			this.decimSum = 0
			this.decimCount = 0
			return
		}
		let left = 1
		while (left > 0) {
			const need = this.fracRatio - this.fracFill
			const take = left < need ? left : need
			this.fracSum += value * take
			this.fracFill += take
			left -= take
			if (this.fracFill < this.fracRatio - 1e-9) continue
			this.onDecimated(this.fracSum / this.fracRatio)
			this.fracSum = 0
			this.fracFill = 0
		}
	}

	private onDecimated(sample: number): void {
		const value = Number.isFinite(sample) ? sample : 0
		this.ctcss.pushSample(value)
		this.dtmf.pushSample(value)
	}
}

function readSample(
	pcm: Buffer,
	offset: number,
	format: TonePcmFormat["format"],
): number {
	if (format === "s16le") return pcm.readInt16LE(offset) / 32_768
	const sample = pcm.readFloatLE(offset)
	return Number.isFinite(sample) ? sample : 0
}
