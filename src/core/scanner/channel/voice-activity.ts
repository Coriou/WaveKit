/**
 * Does a recording file hold voice-like audio, or only a carrier? Fed the written 8 kHz audio
 * (already high-passed at 300 Hz) inside the recorder's activity window, frame for frame. An
 * unmodulated carrier or a spur quiets the FM discriminator, so its audio is near silence; a
 * CTCSS sub-tone sits under the gate's own 500 Hz high-pass; the hiss of a weakly received
 * carrier is flat after de-emphasis, while the demodulated audio of a voice transmission tilts
 * down (most energy below about 1.2 kHz). A window qualifies when it is both loud enough and
 * tilted; a file qualifies once one window does. CTCSS is never required.
 *
 * Measured through WidebandNfmChain on the synthetic test signal (500 ms windows): voice
 * windows at RMS 1100 to 6600 with tilt up to 6.7; a quieted carrier at RMS 11; a 250.3 Hz
 * CTCSS tone at 750 Hz deviation at RMS 235; a weak carrier's hiss at RMS 200 to 1000 and tilt
 * 0.7 to 1.0. Below the FM threshold (a carrier about 3 dB over the channel noise) the
 * discriminator's clicks tilt low (about 3) and pass; so does noise with no carrier at all,
 * which is why the recorder only feeds audio from inside a track's span.
 *
 * Cost per frame: four biquads (one 4th-order high-pass, one low and one high band) and three
 * squares, about 30 floating-point operations: 240 000 per second of audio per recording.
 */
import { ANALOG_AUDIO_RATE_HZ } from "./fm-audio.js"
import { BUTTERWORTH4_Q, Biquad } from "./wideband-nfm.js"

/** The gate's own high-pass: under it lie every CTCSS tone (67 to 254.1 Hz) and its skirt. */
export const VOICE_GATE_HIGH_PASS_HZ = 500
/** Low band (voice formant energy) below this, 2nd-order low-pass. */
export const VOICE_LOW_BAND_HZ = 1_200
/** High band (hiss) above this, 2nd-order high-pass. */
export const VOICE_HIGH_BAND_HZ = 1_800
/** One block: 100 ms = 800 frames at 8 kHz. */
export const VOICE_BLOCK_FRAMES = ANALOG_AUDIO_RATE_HZ / 10
/** A window: 5 blocks = 500 ms, about one or two syllables. */
export const VOICE_WINDOW_BLOCKS = 5
/**
 * Window RMS (s16) above which audio counts as modulated: −36 dBFS. The discriminator maps
 * 5 kHz deviation to full scale before a ×4 de-emphasis makeup, so 1 kHz of deviation at 1 kHz
 * gives about 0.2 · 4 · 0.21 ≈ 0.17 of full scale (5 500 s16); a quieted carrier stays near
 * zero, and a 250 Hz CTCSS tone at 750 Hz deviation leaves about 250 s16 after both high-passes.
 */
export const VOICE_MIN_RMS = 512
/**
 * Window low-band energy over high-band energy above which audio is voice-like: a weak
 * carrier's flat hiss measures 0.7 to 1.0 (700 Hz of low band against the 1800 to 3000 Hz
 * high band, with the filter skirts), voice windows of the synthetic signal up to 6.7.
 */
export const VOICE_MIN_TILT = 1.4

interface Block {
	total: number
	low: number
	high: number
}

export class VoiceActivityGate {
	private readonly hp = BUTTERWORTH4_Q.map(
		q => new Biquad("high", VOICE_GATE_HIGH_PASS_HZ, ANALOG_AUDIO_RATE_HZ, q),
	)
	private readonly low = new Biquad(
		"low",
		VOICE_LOW_BAND_HZ,
		ANALOG_AUDIO_RATE_HZ,
		Math.SQRT1_2,
	)
	private readonly high = new Biquad(
		"high",
		VOICE_HIGH_BAND_HZ,
		ANALOG_AUDIO_RATE_HZ,
		Math.SQRT1_2,
	)
	/** The last VOICE_WINDOW_BLOCKS completed blocks (fixed size: no growth). */
	private readonly blocks: Block[] = []
	private cur: Block = { total: 0, low: 0, high: 0 }
	private inBlock = 0
	private qualified = false

	/** True once any window was loud and voice-tilted. */
	get voiced(): boolean {
		return this.qualified
	}

	push(pcm: ArrayLike<number>): void {
		if (this.qualified) return
		for (let i = 0; i < pcm.length; i++) {
			let x = pcm[i]!
			for (const stage of this.hp) x = stage.step(x)
			const l = this.low.step(x)
			const h = this.high.step(x)
			this.cur.total += x * x
			this.cur.low += l * l
			this.cur.high += h * h
			if (++this.inBlock < VOICE_BLOCK_FRAMES) continue
			this.blocks.push(this.cur)
			if (this.blocks.length > VOICE_WINDOW_BLOCKS) this.blocks.shift()
			this.cur = { total: 0, low: 0, high: 0 }
			this.inBlock = 0
			if (this.blocks.length === VOICE_WINDOW_BLOCKS && this.windowVoiced()) {
				this.qualified = true
				return
			}
		}
	}

	private windowVoiced(): boolean {
		let total = 0
		let low = 0
		let high = 0
		for (const b of this.blocks) {
			total += b.total
			low += b.low
			high += b.high
		}
		const meanSquare = total / (VOICE_WINDOW_BLOCKS * VOICE_BLOCK_FRAMES)
		return (
			meanSquare >= VOICE_MIN_RMS * VOICE_MIN_RMS &&
			low >= VOICE_MIN_TILT * high
		)
	}
}
