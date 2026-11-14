/**
 * Does a recording file hold voice-like audio, or only a carrier? Fed the written 8 kHz audio
 * (already high-passed at 300 Hz) inside the recorder's activity window, frame for frame. An
 * unmodulated carrier or a spur quiets the FM discriminator, so its audio is near silence; a
 * CTCSS sub-tone sits under the gate's own 500 Hz high-pass; the hiss of a weakly received
 * carrier is flat after de-emphasis, while the demodulated audio of a voice transmission tilts
 * down (most energy below about 1.2 kHz). A window qualifies when it is both loud enough and
 * tilted; a file qualifies once VOICE_MIN_WINDOWS windows do (windows slide by one 100 ms block,
 * so three span at least 700 ms of audio: one stray window of discriminator noise or a data
 * burst's edge does not reserve a file). CTCSS is never required. Audio too short for one window
 * (a short over, trimmed at both ends) is judged once at its end on all of it, if it holds at
 * least VOICE_MIN_FINAL_FRAMES (`conclude()`); audio that ended before VOICE_MIN_WINDOWS windows
 * qualified does at its end on fewer (VOICE_MIN_WINDOWS, the end-of-over rule).
 *
 * Measured through WidebandNfmChain on the synthetic test signal (500 ms windows): voice
 * windows at RMS 1100 to 6600 with tilt up to 6.7; a quieted carrier at RMS 11; a 250.3 Hz
 * CTCSS tone at 750 Hz deviation at RMS 235; a weak carrier's hiss at RMS 200 to 1000 and tilt
 * 0.7 to 1.0. Below the FM threshold (a carrier about 3 dB over the channel noise) the
 * discriminator's clicks tilt low (about 3) and pass; so does noise with no carrier at all,
 * which is why the recorder only feeds audio from inside a track's span.
 *
 * Cost per frame: four biquads (one 4th-order high-pass, one low and one high band) and three
 * squares, about 30 floating-point operations: 240 000 per second of audio per recording;
 * measured 0.34 to 0.53 ms of a core per second of audio (docs/SCANNER.md, Analog voice
 * recordings).
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
 * The shortest audio judged at its end when no full window was heard: 200 ms = 1600 frames,
 * a syllable. With the recorder's 100 ms trims at both ends a transmission of 400 ms or more
 * can qualify (a 600 ms over gives 400 ms of audio); below this nothing is kept.
 */
export const VOICE_MIN_FINAL_FRAMES = 2 * VOICE_BLOCK_FRAMES
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
/**
 * Qualifying windows a file needs while its audio runs (VoiceActivityGate.push): 3. A 1.5 s over
 * gives 1.3 s of audio past the recorder's 100 ms trims, 13 blocks and so 13 − 5 + 1 = 9 sliding
 * windows, of which voice must fill 3. At the over's end (conclude) fewer do, any of:
 * - min(3, ⌈windows / 2⌉): a 1 s over (0.8 s of audio, 4 windows) needs 2, a 0.7 s one (1 window)
 *   that one;
 * - 2 when the over gave at most VOICE_SHORT_OVER_WINDOWS windows (a 1.5 s over, 9 windows): a
 *   short or weak word at the start or end of a 1.1 to 1.5 s over (6 to 9 windows, so 3 to 5 by
 *   the first rule) can pass only 2 windows;
 * - 2 consecutive windows at any length: a real word spans adjacent windows (they share 4 of
 *   their 5 blocks), one stray window of noise or a burst's edge passes alone.
 * Only one isolated voiced window in an over of 3 windows or more never qualifies.
 */
export const VOICE_MIN_WINDOWS = 3
/**
 * The longest over (in windows) whose end accepts any 2 voiced windows: 9, a 1.5 s over (1.3 s
 * of audio past the trims, 13 blocks, 13 − 5 + 1 = 9 windows).
 */
export const VOICE_SHORT_OVER_WINDOWS = 9

/**
 * The gate's and the meter's shared DSP: the filters and the last VOICE_WINDOW_BLOCKS completed
 * 100 ms blocks' energies (total, low band, high band) in a fixed ring, so nothing is allocated
 * per frame or per block (docs/PERFORMANCE.md: steady-state buffers are reused).
 */
class VoiceBlocks {
	private readonly hp0: Biquad
	private readonly hp1: Biquad
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
	/** Ring of 3 × VOICE_WINDOW_BLOCKS energies: block k at 3 · ((head + k) % blocks). */
	private readonly ring = new Float64Array(3 * VOICE_WINDOW_BLOCKS)
	private head = 0
	/** Completed blocks held (at most VOICE_WINDOW_BLOCKS). */
	count = 0
	private curTotal = 0
	private curLow = 0
	private curHigh = 0
	/** Frames in the current (partial) block. */
	inBlock = 0

	constructor() {
		const [q0, q1] = BUTTERWORTH4_Q
		this.hp0 = new Biquad(
			"high",
			VOICE_GATE_HIGH_PASS_HZ,
			ANALOG_AUDIO_RATE_HZ,
			q0,
		)
		this.hp1 = new Biquad(
			"high",
			VOICE_GATE_HIGH_PASS_HZ,
			ANALOG_AUDIO_RATE_HZ,
			q1,
		)
	}

	/** Filters one frame; true when it completed a block (then held in the ring). */
	step(sample: number): boolean {
		const x = this.hp1.step(this.hp0.step(sample))
		const l = this.low.step(x)
		const h = this.high.step(x)
		this.curTotal += x * x
		this.curLow += l * l
		this.curHigh += h * h
		if (++this.inBlock < VOICE_BLOCK_FRAMES) return false
		let slot: number
		if (this.count < VOICE_WINDOW_BLOCKS) {
			slot = (this.head + this.count) % VOICE_WINDOW_BLOCKS
			this.count++
		} else {
			slot = this.head
			this.head = (this.head + 1) % VOICE_WINDOW_BLOCKS
		}
		this.ring[3 * slot] = this.curTotal
		this.ring[3 * slot + 1] = this.curLow
		this.ring[3 * slot + 2] = this.curHigh
		this.curTotal = 0
		this.curLow = 0
		this.curHigh = 0
		this.inBlock = 0
		return true
	}

	/**
	 * The held blocks (and the partial one when `partial`) over `frames` frames are loud enough
	 * and voice-tilted.
	 */
	voiced(frames: number, partial: boolean): boolean {
		let total = 0
		let low = 0
		let high = 0
		for (let k = 0; k < this.count; k++) {
			const at = 3 * ((this.head + k) % VOICE_WINDOW_BLOCKS)
			total += this.ring[at]!
			low += this.ring[at + 1]!
			high += this.ring[at + 2]!
		}
		if (partial) {
			total += this.curTotal
			low += this.curLow
			high += this.curHigh
		}
		const meanSquare = total / frames
		return (
			meanSquare >= VOICE_MIN_RMS * VOICE_MIN_RMS &&
			low >= VOICE_MIN_TILT * high
		)
	}

	/** Forgets the blocks (the filters keep their state). */
	clear(): void {
		this.head = 0
		this.count = 0
		this.curTotal = 0
		this.curLow = 0
		this.curHigh = 0
		this.inBlock = 0
	}
}

const WINDOW_FRAMES = VOICE_WINDOW_BLOCKS * VOICE_BLOCK_FRAMES

export class VoiceActivityGate {
	private readonly dsp = new VoiceBlocks()
	private qualified = false
	/** Full windows judged, and how many of them were loud and voice-tilted. */
	private windows = 0
	private hits = 0
	/** The last judged window was voiced; two voiced in a row were seen. */
	private lastHit = false
	private pair = false
	private concluded = false

	/** True once VOICE_MIN_WINDOWS windows were loud and voice-tilted (or at the end, conclude). */
	get voiced(): boolean {
		return this.qualified
	}

	/**
	 * Feeds frames `start` to `end` (exclusive) of `pcm`; returns how many it consumed: all of
	 * them, or up to the frame that completed the VOICE_MIN_WINDOWS-th voiced window (the gate then
	 * latches and ignores the rest). 0 once voiced or concluded.
	 */
	push(pcm: ArrayLike<number>, start = 0, end = pcm.length): number {
		if (this.qualified || this.concluded) return 0
		const dsp = this.dsp
		for (let i = start; i < end; i++) {
			if (!dsp.step(pcm[i]!) || dsp.count < VOICE_WINDOW_BLOCKS) continue
			this.windows++
			const hit = dsp.voiced(WINDOW_FRAMES, false)
			if (hit && this.lastHit) this.pair = true
			this.lastHit = hit
			if (hit && ++this.hits >= VOICE_MIN_WINDOWS) {
				this.qualified = true
				return i + 1 - start
			}
		}
		return end - start
	}

	/**
	 * The audio ended: audio that never filled a window is judged on all of it (the completed
	 * blocks and the partial one) when it holds at least VOICE_MIN_FINAL_FRAMES; audio that filled
	 * windows without latching qualifies by the end-of-over rule (VOICE_MIN_WINDOWS): at least half
	 * of them (rounded up, at least one), or 2 in an over of at most VOICE_SHORT_OVER_WINDOWS
	 * windows, or 2 consecutive. Idempotent; later pushes are ignored.
	 */
	conclude(): boolean {
		if (this.qualified || this.concluded) return this.qualified
		this.concluded = true
		const dsp = this.dsp
		const frames = dsp.count * VOICE_BLOCK_FRAMES + dsp.inBlock
		if (this.windows === 0 && frames >= VOICE_MIN_FINAL_FRAMES)
			this.qualified = dsp.voiced(frames, true)
		else if (this.hits > 0)
			this.qualified =
				this.pair ||
				(this.hits >= 2 && this.windows <= VOICE_SHORT_OVER_WINDOWS) ||
				this.hits >= Math.min(VOICE_MIN_WINDOWS, Math.ceil(this.windows / 2))
		return this.qualified
	}
}

/**
 * Is voice on air now? The same filters and 500 ms windows as VoiceActivityGate, but it never
 * latches: every completed block ends a window (sliding by one 100 ms block) that is judged, and
 * `push` returns where the last voiced window of the pushed audio ended. The recorder feeds it
 * a session's in-track audio once the session is voiced (before that its file gate's own
 * qualifying window stands in, so the two never filter the same frames) and asks how long ago
 * voice was last heard (the sweep's per-transmission voice signal, WIDEBAND_VOICE_ON_AIR_MS).
 * `reset()` forgets the window across a break in the fed audio, so no window joins two
 * transmissions. Same cost per frame as the gate; no allocation after construction.
 */
export class VoiceOnAirMeter {
	private readonly dsp = new VoiceBlocks()

	/**
	 * Feeds frames `start` to `end` (exclusive) of `pcm`; returns the index in `pcm` just past the
	 * end of the last window that was voiced (start + 1 to end), or 0 when no window completed in
	 * them was voiced.
	 */
	push(pcm: ArrayLike<number>, start = 0, end = pcm.length): number {
		const dsp = this.dsp
		let voicedTo = 0
		for (let i = start; i < end; i++)
			if (
				dsp.step(pcm[i]!) &&
				dsp.count === VOICE_WINDOW_BLOCKS &&
				dsp.voiced(WINDOW_FRAMES, false)
			)
				voicedTo = i + 1
		return voicedTo
	}

	/** Forgets the window (the filters keep their state: a break in the audio, not a new chain). */
	reset(): void {
		this.dsp.clear()
	}
}
