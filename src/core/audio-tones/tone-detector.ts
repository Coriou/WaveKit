/**
 * CTCSS + DTMF + DCS over one live-demod transmission (WG2 req 7.1–7.4,
 * WG6 req 4).
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
 *
 * DCS (`dcs.ts`) rides the same 8 kHz stream. It is withheld until the
 * transmission has `DCS_MIN_AUDIO_SECONDS` of audio and is reset whenever the
 * PCM format or rate changes mid-transmission. It never touches the CTCSS or
 * DTMF banks.
 */
import { DCS_MIN_AUDIO_SECONDS } from "@wavekit/api-types"
import type { AnalogTransmissionTone } from "@wavekit/api-types"
import { CtcssBank } from "./ctcss.js"
import { DcsDecoder } from "./dcs.js"
import { DTMF_COLUMN_HZ, DTMF_ROW_HZ, DtmfBank } from "./dtmf.js"

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
 * Streaming decimator to `AUDIO_TONE_RATE_HZ` by block averaging (the tone detector's own
 * decimator, exported for the WG7 tone squelch gate). An integer ratio averages N samples; a
 * fractional ratio uses a varying group length with the same average; a rate below 8 kHz (or
 * not finite) yields nothing. `take` allocates nothing: it returns true when a decimated sample
 * is ready in `output`.
 */
export class PcmDecimator {
	/** The decimated sample produced by the last `take` that returned true. */
	output = 0
	private decimFactor = 1
	private decimSum = 0
	private decimCount = 0
	private fractional = false
	private fracRatio = 1
	private fracFill = 0
	private fracSum = 0

	/** Back to the constructed state (factor 1). */
	clear(): void {
		this.output = 0
		this.decimFactor = 1
		this.decimSum = 0
		this.decimCount = 0
		this.fractional = false
		this.fracRatio = 1
		this.fracFill = 0
		this.fracSum = 0
	}

	/** Set the input rate and drop any partial group. */
	arm(rate: number): void {
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

	/**
	 * One input sample (non-finite counts as 0). The ratio is at least 1, so one input
	 * completes at most one output.
	 */
	take(sample: number): boolean {
		if (this.decimFactor === 0 && !this.fractional) return false
		const value = Number.isFinite(sample) ? sample : 0
		if (!this.fractional) {
			if (this.decimFactor <= 1) {
				this.output = value
				return true
			}
			this.decimSum += value
			this.decimCount += 1
			if (this.decimCount < this.decimFactor) return false
			this.output = this.decimSum / this.decimFactor
			this.decimSum = 0
			this.decimCount = 0
			return true
		}
		let ready = false
		let left = 1
		while (left > 0) {
			const need = this.fracRatio - this.fracFill
			const take = left < need ? left : need
			this.fracSum += value * take
			this.fracFill += take
			left -= take
			if (this.fracFill < this.fracRatio - 1e-9) continue
			this.output = this.fracSum / this.fracRatio
			ready = true
			this.fracSum = 0
			this.fracFill = 0
		}
		return ready
	}
}

/**
 * One detector per open transmission. `push` is allocation-free after the
 * first call: banks, the decimator and the odd-byte hold are constructed
 * once and reused. `result` always returns all three keys.
 */
export class ToneDetector {
	private readonly ctcss = new CtcssBank()
	private readonly dtmf = new DtmfBank()
	private readonly dcs = new DcsDecoder()
	/** Assembles a sample split across pushes. f32le needs 4 bytes; at most 3 sit here. */
	private readonly pending = Buffer.alloc(4)
	private pendingLen = 0
	private format: TonePcmFormat["format"] | null = null
	private rate = 0
	private inputSamples = 0
	/** Audio seconds summed per sample at its own rate (DCS gate; CTCSS keeps its rule). */
	/** DCS audio time: closed rate segments plus samples of the current one (exact at boundaries). */
	private dcsSecondsDone = 0
	private segmentSamples = 0
	/**
	 * Set when unreadable audio arrives while a split sample is held: the held bytes would
	 * misframe every later sample, so DCS stays blind until the format is re-armed.
	 */
	private dcsBlind = false
	private readonly decimator = new PcmDecimator()

	push(pcm: Buffer, format: TonePcmFormat): void {
		if (format.format !== "s16le" && format.format !== "f32le") {
			// DCS evidence must not bridge audio it cannot read.
			this.dcs.reset()
			if (this.pendingLen > 0) this.dcsBlind = true
			return
		}
		const width = format.format === "s16le" ? 2 : 4
		if (this.format !== format.format || this.rate !== format.rate) {
			this.pendingLen = 0
			this.dcs.reset()
			this.dcsBlind = false
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
		const dcs =
			this.dcsSeconds() < DCS_MIN_AUDIO_SECONDS ? null : this.dcs.result()
		return { ctcssHz, dtmf: digits, dcs }
	}

	private dcsSeconds(): number {
		const current =
			this.rate > 0 && Number.isFinite(this.rate)
				? this.segmentSamples / this.rate
				: 0
		return this.dcsSecondsDone + current
	}

	durationSeconds(): number {
		if (!(this.rate > 0)) return 0
		return this.inputSamples / this.rate
	}

	reset(): void {
		this.ctcss.reset()
		this.dtmf.reset()
		this.dcs.reset()
		this.pending.fill(0)
		this.pendingLen = 0
		this.format = null
		this.rate = 0
		this.inputSamples = 0
		this.dcsSecondsDone = 0
		this.segmentSamples = 0
		this.dcsBlind = false
		this.decimator.clear()
	}

	private armRate(rate: number): void {
		this.dcsSecondsDone = this.dcsSeconds()
		this.segmentSamples = 0
		this.rate = rate
		this.dtmf.setPowerScale(
			powerScale(DTMF_ROW_HZ, rate),
			powerScale(DTMF_COLUMN_HZ, rate),
		)
		this.decimator.arm(rate)
	}

	private takeSample(sample: number): void {
		this.inputSamples += 1
		this.segmentSamples += 1
		if (this.decimator.take(sample)) this.onDecimated(this.decimator.output)
	}

	private onDecimated(sample: number): void {
		const value = Number.isFinite(sample) ? sample : 0
		this.ctcss.pushSample(value)
		this.dtmf.pushSample(value)
		if (!this.dcsBlind) this.dcs.pushSample(value)
	}
}

/** `1/g(f)²` so a column attenuated by the boxcar is not reported as extra twist. */
function powerScale(hzs: readonly number[], rate: number): Float64Array {
	const scale = new Float64Array(hzs.length)
	for (let i = 0; i < hzs.length; i++) {
		const gain = boxcarDecimationGain(hzs[i] ?? 0, rate)
		scale[i] = gain > 0 ? 1 / (gain * gain) : 1
	}
	return scale
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
