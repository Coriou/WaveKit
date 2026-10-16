/**
 * Tone squelch gate for the live demodulator (WG7 req 3.2-3.6).
 *
 * A separate consumer of the demodulated PCM: it never feeds the transmission tracker's
 * `ToneDetector`, so transmission events and tone results are unchanged (req 3.3). PCM at the
 * demod rate (s16le or f32le, blocks may split a sample) is decimated to 8 kHz by the tone
 * detector's `PcmDecimator` and runs only the stage the configured tone needs:
 *
 * - CTCSS: the existing 50-tone `CtcssBank` (500 ms blocks, 250 ms hop). A block matches when
 *   its winner is the configured tone. `LIVE_AUDIO_TONE_SQUELCH_OPEN_COUNT` consecutive matching
 *   blocks open the gate, `LIVE_AUDIO_TONE_SQUELCH_CLOSE_COUNT` consecutive other blocks close
 *   it. First open at the second block: 750 ms of audio.
 * - DCS: the existing `DcsDecoder`. The gate opens when its current word chain reads the
 *   configured code or its twin (the same bit stream read with the other polarity, e.g.
 *   023N ↔ 047I) for `OPEN_COUNT` consecutive words, and closes once `CLOSE_COUNT` word periods
 *   (23 bits each) pass without a matching word.
 *
 * `reset()` (the squelch closed) closes the gate at once and clears every stage. Per block the
 * gate allocates nothing: stages, the decimator and the split-sample hold are built once.
 */
import {
	LIVE_AUDIO_TONE_SQUELCH_CLOSE_COUNT,
	LIVE_AUDIO_TONE_SQUELCH_OPEN_COUNT,
} from "@wavekit/api-types"
import type { LiveAudioToneSquelch } from "@wavekit/api-types"
import { WaveKitError } from "../../utils/errors.js"
import { CTCSS_HZ, CtcssBank } from "./ctcss.js"
import { DCS_WORD_BITS, DcsDecoder, dcsTwin, packDcs } from "./dcs.js"
import { PcmDecimator } from "./tone-detector.js"

export type ToneSquelchTone = Exclude<LiveAudioToneSquelch, { kind: "none" }>
export type ToneSquelchPcmFormat = "s16le" | "f32le"
export type ToneSquelchState = "waiting" | "open"

/**
 * The open/close decision over a sequence of per-block (CTCSS) observations: open after
 * `openCount` consecutive matches, close after `closeCount` consecutive misses. Pure state, no
 * allocation; exported for the property test.
 */
export class ToneGateCounter {
	private isOpen = false
	private run = 0

	constructor(
		private readonly openCount = LIVE_AUDIO_TONE_SQUELCH_OPEN_COUNT,
		private readonly closeCount = LIVE_AUDIO_TONE_SQUELCH_CLOSE_COUNT,
	) {}

	/** One analysis block: did it match the configured tone? Returns the gate state after it. */
	observe(match: boolean): boolean {
		if (this.isOpen === match) {
			this.run = 0
			return this.isOpen
		}
		this.run += 1
		if (this.run >= (this.isOpen ? this.closeCount : this.openCount)) {
			this.isOpen = match
			this.run = 0
		}
		return this.isOpen
	}

	open(): boolean {
		return this.isOpen
	}

	reset(): void {
		this.isOpen = false
		this.run = 0
	}
}

/** Zero a PCM block in place (s16le and f32le: 0 and +0.0 are all-zero bytes). Length kept. */
export function muteInPlace(pcm: Buffer): void {
	pcm.fill(0)
}

export class ToneSquelchGate {
	readonly tone: ToneSquelchTone
	private readonly rate: number
	private readonly decimator = new PcmDecimator()
	private readonly ctcss: CtcssBank | null
	private readonly dcs: DcsDecoder | null
	/** CTCSS: `CTCSS_HZ` index of the configured tone. */
	private readonly toneIndex: number
	/** DCS: packed readings that match (the code as configured and its twin). */
	private readonly dcsPacked: number
	private readonly dcsTwinPacked: number
	private readonly counter = new ToneGateCounter()
	/** Split-sample hold: f32le needs 4 bytes; at most 3 sit here. */
	private readonly pending = Buffer.alloc(4)
	private pendingLen = 0
	private format: ToneSquelchPcmFormat | null = null
	private lastBlock = 0
	private lastBit = 0
	private dcsOpen = false
	private lastMatchBit = 0
	private lastMatchHits = 0

	constructor(tone: ToneSquelchTone, rate: number) {
		if (!Number.isFinite(rate) || rate < 8_000)
			throw new WaveKitError(
				`Tone squelch needs a PCM rate of at least 8000 Hz, got ${String(rate)}`,
				"TONE_SQUELCH_RATE",
			)
		this.tone = tone
		this.rate = rate
		this.decimator.arm(rate)
		if (tone.kind === "ctcss") {
			const index = CTCSS_HZ.findIndex(
				hz => Math.round(hz * 10) === tone.frequencyTenthsHz,
			)
			if (index < 0)
				throw new WaveKitError(
					`Tone squelch CTCSS ${String(tone.frequencyTenthsHz)} tenths Hz is not a standard tone`,
					"TONE_SQUELCH_TONE",
				)
			this.toneIndex = index
			this.ctcss = new CtcssBank()
			this.dcs = null
			this.dcsPacked = -1
			this.dcsTwinPacked = -1
			return
		}
		const packed = packDcs({ code: tone.code, polarity: tone.polarity })
		if (packed < 0)
			throw new WaveKitError(
				`Tone squelch DCS code ${tone.code} is malformed`,
				"TONE_SQUELCH_TONE",
			)
		this.toneIndex = -1
		this.ctcss = null
		this.dcs = new DcsDecoder()
		this.dcsPacked = packed
		this.dcsTwinPacked = packDcs(
			dcsTwin({ code: tone.code, polarity: tone.polarity }),
		)
	}

	get state(): ToneSquelchState {
		return this.open() ? "open" : "waiting"
	}

	open(): boolean {
		return this.ctcss !== null ? this.counter.open() : this.dcsOpen
	}

	/** Feed one PCM block at the constructed rate. A format change drops the held bytes. */
	push(pcm: Buffer, format: ToneSquelchPcmFormat): void {
		if (format !== "s16le" && format !== "f32le") return
		if (format !== this.format) {
			this.format = format
			this.pendingLen = 0
		}
		const width = format === "s16le" ? 2 : 4
		let offset = 0
		if (this.pendingLen > 0) {
			const need = width - this.pendingLen
			if (pcm.length < need) {
				pcm.copy(this.pending, this.pendingLen, 0, pcm.length)
				this.pendingLen += pcm.length
				return
			}
			pcm.copy(this.pending, this.pendingLen, 0, need)
			this.takeSample(
				format === "s16le"
					? this.pending.readInt16LE(0) / 32_768
					: this.pending.readFloatLE(0),
			)
			this.pendingLen = 0
			offset = need
		}
		const usable = pcm.length - offset
		const end = offset + usable - (usable % width)
		if (format === "s16le") {
			for (let i = offset; i < end; i += 2)
				this.takeSample(pcm.readInt16LE(i) / 32_768)
		} else {
			for (let i = offset; i < end; i += 4) this.takeSample(pcm.readFloatLE(i))
		}
		if (end < pcm.length) {
			pcm.copy(this.pending, 0, end, pcm.length)
			this.pendingLen = pcm.length - end
		}
	}

	/** The squelch closed: close the gate at once and start the next transmission clean. */
	reset(): void {
		this.counter.reset()
		this.ctcss?.reset()
		this.dcs?.reset()
		this.decimator.arm(this.rate)
		this.pendingLen = 0
		this.format = null
		this.lastBlock = 0
		this.lastBit = 0
		this.dcsOpen = false
		this.lastMatchBit = 0
		this.lastMatchHits = 0
	}

	private takeSample(sample: number): void {
		if (!this.decimator.take(sample)) return
		const value = this.decimator.output
		const ctcss = this.ctcss
		if (ctcss !== null) {
			ctcss.pushSample(value)
			const blocks = ctcss.blockCount()
			if (blocks === this.lastBlock) return
			this.lastBlock = blocks
			this.counter.observe(ctcss.lastBlockToneIndex() === this.toneIndex)
			return
		}
		const dcs = this.dcs
		if (dcs === null) return
		dcs.pushSample(value)
		const bits = dcs.bitCount()
		if (bits === this.lastBit) return
		this.lastBit = bits
		const reading = dcs.wordReading()
		const hits = dcs.wordHits()
		const matches =
			hits > 0 && (reading === this.dcsPacked || reading === this.dcsTwinPacked)
		if (matches && hits !== this.lastMatchHits) this.lastMatchBit = bits
		this.lastMatchHits = matches ? hits : 0
		if (!this.dcsOpen) {
			if (matches && hits >= LIVE_AUDIO_TONE_SQUELCH_OPEN_COUNT)
				this.dcsOpen = true
			return
		}
		if (
			bits - this.lastMatchBit >=
			DCS_WORD_BITS * LIVE_AUDIO_TONE_SQUELCH_CLOSE_COUNT
		)
			this.dcsOpen = false
	}
}
